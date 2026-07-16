import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EscalationStatus, EscalationUrgency, Prisma } from '@prisma/client';
import axios from 'axios';
import { OutboxService } from '../integrations/core/outbox.service';

@Injectable()
export class EscalationsService {
  private readonly logger = new Logger(EscalationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  list(tenantId: string, locationId?: string) {
    return this.prisma.escalation.findMany({
      where: {
        tenantId,
        ...(locationId ? { locationId } : {}),
        status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        conversationId: true,
        reason: true,
        urgency: true,
        status: true,
        summary: true,
        metadata: true,
        notifiedAt: true,
        resolvedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async create(params: {
    tenantId: string;
    locationId?: string | null;
    externalKey: string;
    reason: string;
    urgency?: EscalationUrgency;
    summary?: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    const conv = await this.prisma.conversation.findUnique({
      where: {
        tenantId_externalKey: {
          tenantId: params.tenantId,
          externalKey: params.externalKey,
        },
      },
      select: { id: true },
    });

    // Duplicate prevention: one open logical handoff per conversation.
    if (conv?.id) {
      const existing = await this.prisma.escalation.findFirst({
        where: {
          tenantId: params.tenantId,
          conversationId: conv.id,
          status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        return {
          escalation: existing,
          notified: Boolean(existing.notifiedAt),
          queued: false,
          deduped: true,
        };
      }
    }

    const escalation = await this.prisma.escalation.create({
      data: {
        tenantId: params.tenantId,
        locationId: params.locationId ?? null,
        conversationId: conv?.id ?? null,
        reason: params.reason,
        urgency: params.urgency ?? EscalationUrgency.NORMAL,
        summary: params.summary,
        metadata: params.metadata,
      },
    });

    let notified = false;
    let queued = false;
    const webhook = process.env.CRM_WEBHOOK_URL?.trim();
    const notifyPayload = {
      event: 'HUMAN_HANDOFF',
      tenantId: params.tenantId,
      locationId: params.locationId,
      conversationId: params.externalKey,
      escalationId: escalation.id,
      reason: params.reason,
      urgency: escalation.urgency,
      summary: params.summary,
      timestamp: new Date().toISOString(),
    };

    if (webhook) {
      try {
        await axios.post(webhook, notifyPayload, { timeout: 8_000 });
        notified = true;
        await this.prisma.escalation.update({
          where: { id: escalation.id },
          data: { notifiedAt: new Date() },
        });
      } catch (err: unknown) {
        const code =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code?: string }).code)
            : 'ERR';
        const status =
          err && typeof err === 'object' && 'response' in err
            ? String(
                (err as { response?: { status?: number } }).response?.status ??
                  '',
              )
            : '';
        this.logger.warn(
          `Escalation CRM notify failed code=${code} http=${status || 'n/a'} — enqueueing outbox`,
        );
        try {
          await this.outbox.enqueue({
            tenantId: params.tenantId,
            topic: 'escalation.notify',
            idempotencyKey: `escalation-notify:${escalation.id}`,
            payload: notifyPayload,
          });
          queued = true;
        } catch (enqueueErr: unknown) {
          this.logger.error(
            `Escalation outbox enqueue failed: ${enqueueErr instanceof Error ? enqueueErr.message : 'unknown'}`,
          );
        }
      }
    } else {
      // No webhook configured — durable record only; do not claim notification.
      this.logger.warn(
        'CRM_WEBHOOK_URL unset — escalation persisted without outbound notify',
      );
    }

    await this.auditSafe({
      tenantId: params.tenantId,
      action: 'escalation.create',
      resourceId: escalation.id,
      metadata: {
        locationId: params.locationId ?? null,
        reason: params.reason,
        notified,
        queued,
      },
    });

    return { escalation, notified, queued, deduped: false };
  }

  async acknowledge(params: {
    tenantId: string;
    escalationId: string;
    actorUserId: string;
    locationId?: string | null;
  }) {
    const esc = await this.requireScoped(params);
    if (esc.status === 'RESOLVED' || esc.status === 'DISMISSED') {
      throw new ForbiddenException('Escalation already closed');
    }
    const updated = await this.prisma.escalation.update({
      where: { id: esc.id },
      data: {
        status: EscalationStatus.ACKNOWLEDGED,
        metadata: this.mergeMeta(esc.metadata, {
          acknowledgedBy: params.actorUserId,
          acknowledgedAt: new Date().toISOString(),
        }),
      },
    });
    await this.auditSafe({
      tenantId: params.tenantId,
      userId: params.actorUserId,
      action: 'escalation.acknowledge',
      resourceId: esc.id,
    });
    return updated;
  }

  async claim(params: {
    tenantId: string;
    escalationId: string;
    actorUserId: string;
    locationId?: string | null;
  }) {
    const esc = await this.requireScoped(params);
    if (esc.status === 'RESOLVED' || esc.status === 'DISMISSED') {
      throw new ForbiddenException('Escalation already closed');
    }
    const updated = await this.prisma.escalation.update({
      where: { id: esc.id },
      data: {
        status: EscalationStatus.IN_PROGRESS,
        metadata: this.mergeMeta(esc.metadata, {
          claimedBy: params.actorUserId,
          claimedAt: new Date().toISOString(),
        }),
      },
    });
    await this.auditSafe({
      tenantId: params.tenantId,
      userId: params.actorUserId,
      action: 'escalation.claim',
      resourceId: esc.id,
    });
    return updated;
  }

  async resolve(params: {
    tenantId: string;
    escalationId: string;
    actorUserId: string;
    note?: string;
    locationId?: string | null;
  }) {
    const esc = await this.requireScoped(params);
    const updated = await this.prisma.escalation.update({
      where: { id: esc.id },
      data: {
        status: EscalationStatus.RESOLVED,
        resolvedAt: new Date(),
        metadata: this.mergeMeta(esc.metadata, {
          resolvedBy: params.actorUserId,
          resolveNote: params.note?.slice(0, 500) ?? null,
        }),
      },
    });
    await this.auditSafe({
      tenantId: params.tenantId,
      userId: params.actorUserId,
      action: 'escalation.resolve',
      resourceId: esc.id,
    });
    return updated;
  }

  async addNote(params: {
    tenantId: string;
    escalationId: string;
    actorUserId: string;
    note: string;
    locationId?: string | null;
  }) {
    const esc = await this.requireScoped(params);
    const notes = Array.isArray(
      (esc.metadata as { notes?: unknown } | null)?.notes,
    )
      ? ([...(esc.metadata as { notes: unknown[] }).notes] as unknown[])
      : [];
    notes.push({
      by: params.actorUserId,
      at: new Date().toISOString(),
      text: params.note.slice(0, 500),
    });
    const updated = await this.prisma.escalation.update({
      where: { id: esc.id },
      data: {
        metadata: this.mergeMeta(esc.metadata, { notes }),
      },
    });
    await this.auditSafe({
      tenantId: params.tenantId,
      userId: params.actorUserId,
      action: 'escalation.note',
      resourceId: esc.id,
    });
    return updated;
  }

  private async requireScoped(params: {
    tenantId: string;
    escalationId: string;
    locationId?: string | null;
  }) {
    const esc = await this.prisma.escalation.findFirst({
      where: {
        id: params.escalationId,
        tenantId: params.tenantId,
        ...(params.locationId ? { locationId: params.locationId } : {}),
      },
    });
    if (!esc) throw new NotFoundException('Escalation not found');
    return esc;
  }

  private mergeMeta(
    current: Prisma.JsonValue | null,
    patch: Record<string, unknown>,
  ): Prisma.InputJsonValue {
    const base =
      current && typeof current === 'object' && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {};
    return { ...base, ...patch } as Prisma.InputJsonValue;
  }

  private async auditSafe(data: {
    tenantId: string;
    userId?: string;
    action: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }) {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId: data.tenantId,
          userId: data.userId,
          action: data.action,
          resource: 'Escalation',
          resourceId: data.resourceId,
          metadata: data.metadata as never,
        },
      });
    } catch {
      // Audit must not block handoff ops.
    }
  }
}
