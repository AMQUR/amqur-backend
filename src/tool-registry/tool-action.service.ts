import { ToolConsentService } from './tool-consent.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ToolActionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxService } from '../integrations/core/outbox.service';
import {
  actionChecksum,
  findTool,
  TOOL_CATALOG,
  ToolInputError,
  validateToolInput,
  type ToolRole,
} from './tool-catalog';

export const TOOL_ACTION_TOPIC = 'tool.action.mock';
const APPROVAL_TTL_MS = 24 * 3_600_000;
const MAX_PENDING_PER_TENANT = 100;

export type ToolActor = {
  tenantId: string;
  userId: string;
  role: string;
  /** Rooftop the actor is bound to (MANAGER); null for tenant-wide admins. */
  boundLocationId: string | null;
};

/** Both flags default OFF. Read at call time so they can be flipped without a rebuild. */
export const toolRegistryEnabled = () =>
  process.env.TOOL_REGISTRY_ENABLED === 'true';
export const toolDispatchEnabled = () =>
  process.env.TOOL_DISPATCH_ENABLED === 'true';

@Injectable()
export class ToolActionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly consent: ToolConsentService,
  ) {}

  catalog() {
    return {
      enabled: toolRegistryEnabled(),
      dispatchEnabled: toolDispatchEnabled(),
      providerMode: 'MOCK',
      tools: TOOL_CATALOG.map((t) => ({
        name: t.name,
        version: t.version,
        description: t.description,
        access: t.access,
        risk: t.risk,
        requiresCustomerConsent: t.requiresCustomerConsent,
        proposerRoles: t.proposerRoles,
        approverRoles: t.approverRoles,
        fields: t.fields,
      })),
    };
  }

  private assertEnabled() {
    if (!toolRegistryEnabled())
      throw new ForbiddenException('Tool actions are disabled');
  }

  private assertLocation(actor: ToolActor, locationId: string | null) {
    if (actor.boundLocationId && locationId !== actor.boundLocationId)
      throw new ForbiddenException('Location access denied');
  }

  private async load(actor: ToolActor, id: string) {
    const row = await this.prisma.toolActionRequest.findFirst({
      where: { id, tenantId: actor.tenantId },
    });
    if (!row) throw new NotFoundException('Action not found');
    this.assertLocation(actor, row.locationId);
    return row;
  }

  async propose(
    actor: ToolActor,
    dto: {
      tool: string;
      input: unknown;
      locationId?: string;
      consentRef?: string;
      idempotencyKey?: string;
    },
  ) {
    this.assertEnabled();
    const tool = findTool(dto.tool);
    if (!tool) throw new NotFoundException('Unknown tool');
    if (!tool.proposerRoles.includes(actor.role as ToolRole))
      throw new ForbiddenException('Role may not propose this tool');
    const locationId = actor.boundLocationId ?? dto.locationId ?? null;
    if (
      actor.boundLocationId &&
      dto.locationId &&
      dto.locationId !== locationId
    )
      throw new ForbiddenException('Location access denied');
    if (locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: locationId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!loc) throw new ForbiddenException('Location access denied');
    }
    let input: Record<string, string>;
    try {
      input = validateToolInput(tool, dto.input);
    } catch (e) {
      if (e instanceof ToolInputError) throw new BadRequestException(e.message);
      throw e;
    }
    const consentRef = dto.consentRef?.trim() || null;
    if (tool.requiresCustomerConsent && !consentRef)
      throw new BadRequestException('Customer consent reference is required');
    const verdict = await this.consent.verify(tool, {
      tenantId: actor.tenantId,
      locationId,
      input,
      consentRef,
    });
    if (!verdict.ok)
      throw new BadRequestException(
        `Customer consent is not valid: ${verdict.reason}`,
      );
    const checksum = actionChecksum({
      toolName: tool.name,
      toolVersion: tool.version,
      locationId,
      input,
      consentRef,
    });
    if (dto.idempotencyKey) {
      const existing = await this.findByKey(actor.tenantId, dto.idempotencyKey);
      if (existing) return this.replay(actor, existing, checksum);
    }
    const pending = await this.prisma.toolActionRequest.count({
      where: {
        tenantId: actor.tenantId,
        status: ToolActionStatus.PENDING_APPROVAL,
      },
    });
    if (pending >= MAX_PENDING_PER_TENANT)
      throw new HttpException(
        'Too many pending actions',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.toolActionRequest.create({
          data: {
            tenantId: actor.tenantId,
            locationId,
            toolName: tool.name,
            toolVersion: tool.version,
            input: input as Prisma.InputJsonValue,
            checksum,
            consentRef,
            idempotencyKey: dto.idempotencyKey ?? null,
            expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
            requestedByUserId: actor.userId,
          },
        });
        await this.audit(tx, actor, 'tool.action.proposed', row.id, {
          tool: tool.name,
          risk: tool.risk,
        });
        return row;
      });
    } catch (e) {
      if (
        dto.idempotencyKey &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const winner = await this.findByKey(actor.tenantId, dto.idempotencyKey);
        if (winner) return this.replay(actor, winner, checksum);
      }
      throw e;
    }
  }

  private findByKey(tenantId: string, key: string) {
    return this.prisma.toolActionRequest.findUnique({
      where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } },
    });
  }

  /** Same key + same content returns the original; same key + different content is a conflict. */
  private replay<T extends { checksum: string; locationId: string | null }>(
    actor: ToolActor,
    existing: T,
    checksum: string,
  ): T {
    this.assertLocation(actor, existing.locationId);
    if (existing.checksum !== checksum)
      throw new ConflictException(
        'Idempotency key reused with different input',
      );
    return existing;
  }

  async list(actor: ToolActor, status?: ToolActionStatus) {
    return this.prisma.toolActionRequest.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(actor.boundLocationId ? { locationId: actor.boundLocationId } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  get(actor: ToolActor, id: string) {
    return this.load(actor, id);
  }

  async decide(
    actor: ToolActor,
    id: string,
    decision: 'APPROVE' | 'DENY',
    opts: { reviewedChecksum?: string; note?: string } = {},
  ) {
    this.assertEnabled();
    const row = await this.load(actor, id);
    const tool = findTool(row.toolName);
    if (!tool) throw new ConflictException('Tool no longer exists');
    if (!tool.approverRoles.includes(actor.role as ToolRole))
      throw new ForbiddenException('Role may not decide this tool');
    if (row.status !== ToolActionStatus.PENDING_APPROVAL)
      throw new ConflictException('Action is not awaiting approval');
    if (row.requestedByUserId === actor.userId)
      throw new ForbiddenException('Reviewer must differ from the requester');
    const now = new Date();
    if (row.expiresAt.getTime() <= now.getTime()) {
      await this.prisma.toolActionRequest.updateMany({
        where: {
          id: row.id,
          tenantId: actor.tenantId,
          status: ToolActionStatus.PENDING_APPROVAL,
          expiresAt: { lte: now },
        },
        data: { status: ToolActionStatus.EXPIRED },
      });
      throw new ConflictException('Approval window expired');
    }
    const approved = decision === 'APPROVE';
    if (approved) {
      // Recompute from stored fields so a tampered row cannot ride a stale checksum.
      const current = actionChecksum({
        toolName: row.toolName,
        toolVersion: row.toolVersion,
        locationId: row.locationId,
        input: row.input,
        consentRef: row.consentRef,
      });
      if (current !== row.checksum || opts.reviewedChecksum !== current)
        throw new ConflictException('Action differs from what was reviewed');
      const verdict = await this.consent.verify(tool, {
        tenantId: actor.tenantId,
        locationId: row.locationId,
        input: row.input as Record<string, unknown>,
        consentRef: row.consentRef,
      });
      if (!verdict.ok)
        throw new ConflictException(
          `Customer consent is no longer valid: ${verdict.reason}`,
        );
    }
    const dispatch = approved && toolDispatchEnabled();
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.toolActionRequest.updateMany({
        where: {
          id: row.id,
          tenantId: actor.tenantId,
          status: ToolActionStatus.PENDING_APPROVAL,
          expiresAt: { gt: now },
        },
        data: {
          status: approved
            ? ToolActionStatus.APPROVED
            : ToolActionStatus.DENIED,
          decidedByUserId: actor.userId,
          decidedAt: now,
          decisionNote: opts.note?.slice(0, 300) ?? null,
        },
      });
      if (claimed.count !== 1)
        throw new ConflictException('Action changed during decision');
      if (dispatch) {
        const evt = await this.outbox.enqueue({
          tenantId: actor.tenantId,
          topic: TOOL_ACTION_TOPIC,
          payload: { actionId: row.id },
          idempotencyKey: `tool-action:${row.id}`,
          tx,
        });
        await tx.toolActionRequest.update({
          where: { id: row.id },
          data: { outboxEventId: evt.id },
        });
      }
      await this.audit(
        tx,
        actor,
        approved ? 'tool.action.approved' : 'tool.action.denied',
        row.id,
        { tool: row.toolName, dispatched: dispatch },
      );
    });
    return this.load(actor, row.id);
  }

  /** Any staff actor in the same tenant/rooftop may withdraw a pending action (never approval). */
  async cancel(actor: ToolActor, id: string) {
    const row = await this.load(actor, id);
    const claimed = await this.prisma.toolActionRequest.updateMany({
      where: {
        id: row.id,
        tenantId: actor.tenantId,
        status: ToolActionStatus.PENDING_APPROVAL,
      },
      data: { status: ToolActionStatus.CANCELLED },
    });
    if (claimed.count !== 1)
      throw new ConflictException('Action is not awaiting approval');
    await this.audit(this.prisma, actor, 'tool.action.cancelled', row.id, {
      tool: row.toolName,
    });
    return this.load(actor, row.id);
  }

  private audit(
    db: Prisma.TransactionClient | PrismaService,
    actor: ToolActor,
    action: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ) {
    return db.auditLog.create({
      data: {
        tenantId: actor.tenantId,
        userId: actor.userId,
        action,
        resource: 'ToolActionRequest',
        resourceId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}
