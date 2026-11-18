import { createHash } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, WorkflowDefinitionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { parseWorkflowGraph, WorkflowValidationError } from './workflow-graph';

export type WorkflowActor = {
  tenantId: string;
  userId: string;
  /** Rooftop the actor is bound to (STAFF/MANAGER); null for tenant-wide admins. */
  boundLocationId: string | null;
};

function validate(graph: unknown) {
  try {
    return parseWorkflowGraph(graph);
  } catch (error: unknown) {
    if (error instanceof WorkflowValidationError)
      throw new BadRequestException(error.message);
    throw error;
  }
}

function checksum(graph: unknown): string {
  return createHash('sha256').update(JSON.stringify(graph)).digest('hex');
}

/**
 * Draft -> review -> publish lifecycle with IMMUTABLE versions. The author of a review request
 * cannot approve it (separation of duties); denial/silence never publishes; rollback creates a
 * new version rather than editing history. Nothing here executes a workflow.
 */
@Injectable()
export class WorkflowDefinitionService {
  constructor(private readonly prisma: PrismaService) {}

  private async load(actor: WorkflowActor, id: string) {
    const def = await this.prisma.workflowDefinition.findFirst({
      where: { id, tenantId: actor.tenantId },
    });
    if (!def) throw new NotFoundException('Workflow not found');
    if (actor.boundLocationId && def.locationId !== actor.boundLocationId)
      throw new ForbiddenException('Location access denied');
    return def;
  }

  async create(
    actor: WorkflowActor,
    input: { name: string; graph: unknown; locationId?: string | null },
  ) {
    const graph = validate(input.graph);
    const locationId = actor.boundLocationId ?? input.locationId ?? null;
    if (
      actor.boundLocationId &&
      input.locationId &&
      input.locationId !== actor.boundLocationId
    )
      throw new ForbiddenException('Location access denied');
    if (locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: locationId, tenantId: actor.tenantId },
        select: { id: true },
      });
      if (!loc) throw new ForbiddenException('Location access denied');
    }
    return this.prisma.workflowDefinition.create({
      data: {
        tenantId: actor.tenantId,
        locationId,
        name: input.name,
        draftGraph: graph as unknown as Prisma.InputJsonValue,
        createdByUserId: actor.userId,
      },
    });
  }

  async list(actor: WorkflowActor) {
    return this.prisma.workflowDefinition.findMany({
      where: {
        tenantId: actor.tenantId,
        archivedAt: null,
        ...(actor.boundLocationId ? { locationId: actor.boundLocationId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
  }

  async get(actor: WorkflowActor, id: string) {
    return this.load(actor, id);
  }

  async versions(actor: WorkflowActor, id: string) {
    await this.load(actor, id);
    return this.prisma.workflowVersion.findMany({
      where: { definitionId: id, tenantId: actor.tenantId },
      orderBy: { version: 'desc' },
      take: 100,
    });
  }

  async updateDraft(
    actor: WorkflowActor,
    id: string,
    input: { name?: string; graph?: unknown },
  ) {
    const def = await this.load(actor, id);
    if (def.status === WorkflowDefinitionStatus.ARCHIVED)
      throw new ConflictException('Archived workflows cannot be edited');
    const data: Prisma.WorkflowDefinitionUpdateInput = {
      // Any edit invalidates a pending review: a reviewer approves exactly what they saw.
      status: WorkflowDefinitionStatus.DRAFT,
      reviewRequestedByUserId: null,
      reviewRequestedAt: null,
    };
    if (input.name !== undefined) data.name = input.name;
    if (input.graph !== undefined)
      data.draftGraph = validate(
        input.graph,
      ) as unknown as Prisma.InputJsonValue;
    return this.prisma.workflowDefinition.update({
      where: { id: def.id },
      data,
    });
  }

  async requestReview(actor: WorkflowActor, id: string) {
    const def = await this.load(actor, id);
    if (def.status !== WorkflowDefinitionStatus.DRAFT)
      throw new ConflictException('Only drafts can be submitted for review');
    validate(def.draftGraph);
    return this.prisma.workflowDefinition.update({
      where: { id: def.id },
      data: {
        status: WorkflowDefinitionStatus.IN_REVIEW,
        reviewRequestedByUserId: actor.userId,
        reviewRequestedAt: new Date(),
      },
    });
  }

  /** Approver must differ from the requester; the draft graph is re-validated at publish time. */
  async approveAndPublish(actor: WorkflowActor, id: string, note?: string) {
    const def = await this.load(actor, id);
    if (def.status !== WorkflowDefinitionStatus.IN_REVIEW)
      throw new ConflictException('Workflow is not awaiting review');
    if (def.reviewRequestedByUserId === actor.userId)
      throw new ForbiddenException('Reviewer must differ from the requester');
    const graph = validate(def.draftGraph);
    return this.publishVersion(actor, def.id, graph, {
      requestedByUserId: def.reviewRequestedByUserId,
      note,
    });
  }

  /** Denial returns the workflow to DRAFT; nothing is published. */
  async deny(actor: WorkflowActor, id: string) {
    const def = await this.load(actor, id);
    if (def.status !== WorkflowDefinitionStatus.IN_REVIEW)
      throw new ConflictException('Workflow is not awaiting review');
    if (def.reviewRequestedByUserId === actor.userId)
      throw new ForbiddenException('Reviewer must differ from the requester');
    return this.prisma.workflowDefinition.update({
      where: { id: def.id },
      data: {
        status: WorkflowDefinitionStatus.DRAFT,
        reviewRequestedByUserId: null,
        reviewRequestedAt: null,
      },
    });
  }

  /** Publishes a NEW version whose graph copies an earlier one. History is never rewritten. */
  async rollback(actor: WorkflowActor, id: string, toVersion: number) {
    const def = await this.load(actor, id);
    const old = await this.prisma.workflowVersion.findFirst({
      where: {
        definitionId: def.id,
        tenantId: actor.tenantId,
        version: toVersion,
      },
    });
    if (!old) throw new NotFoundException('Version not found');
    const graph = validate(old.graph);
    return this.publishVersion(actor, def.id, graph, {
      restoredFromVersion: old.version,
      note: `Rollback to v${old.version}`,
    });
  }

  private publishVersion(
    actor: WorkflowActor,
    definitionId: string,
    graph: unknown,
    extra: {
      requestedByUserId?: string | null;
      restoredFromVersion?: number;
      note?: string;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Atomic version bump: concurrent publishers cannot reuse a number.
      const bumped = await tx.workflowDefinition.update({
        where: { id: definitionId },
        data: {
          latestVersion: { increment: 1 },
          status: WorkflowDefinitionStatus.PUBLISHED,
          reviewRequestedByUserId: null,
          reviewRequestedAt: null,
        },
      });
      return tx.workflowVersion.create({
        data: {
          tenantId: actor.tenantId,
          definitionId,
          version: bumped.latestVersion,
          graph: graph as Prisma.InputJsonValue,
          graphChecksum: checksum(graph),
          publishedByUserId: actor.userId,
          requestedByUserId: extra.requestedByUserId ?? null,
          restoredFromVersion: extra.restoredFromVersion ?? null,
          note: extra.note ?? null,
        },
      });
    });
  }
}
