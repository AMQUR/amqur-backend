import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  Prisma,
  WorkflowDefinitionStatus,
  WorkflowRunStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeRetrievalService } from '../knowledge/knowledge-retrieval.service';
import {
  ToolActionService,
  toolRegistryEnabled,
} from '../tool-registry/tool-action.service';
import type { WorkflowActor } from './workflow-definition.service';
import {
  parseWorkflowGraph,
  WorkflowValidationError,
  type WorkflowGraph,
  type WorkflowNode,
} from './workflow-graph';

const MAX_RUNS_PER_HOUR = 60;
const REVIEW_TTL_MS = 24 * 3_600_000;
const MAX_QUERY = 300;

type Reference = { documentId: string; title: string; score: number };

/** Masks emails, phone-like numbers, VIN-like strings and long digit runs before persistence. */
export function redactQuery(query: string): string {
  return query
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b[A-HJ-NPR-Z0-9]{17}\b/gi, '[vin]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
    .replace(/\d{6,}/g, '[number]');
}

/**
 * Persisted SIMULATION runs of PUBLISHED workflow versions. Each node is recorded as a step.
 * A human_review node suspends the run until an independent authorized decision; denial,
 * silence, expiry and cancellation are never treated as approval. Nothing here calls tools,
 * writes to CRM, or contacts customers.
 */
@Injectable()
export class WorkflowRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeRetrievalService,
    @Optional() private readonly tools?: ToolActionService,
  ) {}

  private assertLocation(actor: WorkflowActor, locationId: string | null) {
    if (actor.boundLocationId && locationId !== actor.boundLocationId)
      throw new ForbiddenException('Location access denied');
  }

  private async loadRun(actor: WorkflowActor, id: string) {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id, tenantId: actor.tenantId },
      include: { steps: { orderBy: { seq: 'asc' } } },
    });
    if (!run) throw new NotFoundException('Run not found');
    this.assertLocation(actor, run.locationId);
    return run;
  }

  async start(
    actor: WorkflowActor,
    input: { definitionId: string; query: string; idempotencyKey?: string },
  ) {
    const query = input.query.trim();
    if (!query || query.length > MAX_QUERY)
      throw new BadRequestException(
        `Query must be between 1 and ${MAX_QUERY} characters`,
      );
    const def = await this.prisma.workflowDefinition.findFirst({
      where: { id: input.definitionId, tenantId: actor.tenantId },
    });
    if (!def) throw new NotFoundException('Workflow not found');
    this.assertLocation(actor, def.locationId);
    if (def.status === WorkflowDefinitionStatus.ARCHIVED || def.archivedAt)
      throw new ConflictException('Archived workflows cannot be run');

    if (input.idempotencyKey) {
      const existing = await this.prisma.workflowRun.findFirst({
        where: {
          tenantId: actor.tenantId,
          definitionId: def.id,
          idempotencyKey: input.idempotencyKey,
        },
        include: { steps: { orderBy: { seq: 'asc' } } },
      });
      if (existing) return existing;
    }

    const recent = await this.prisma.workflowRun.count({
      where: {
        tenantId: actor.tenantId,
        createdAt: { gte: new Date(Date.now() - 3_600_000) },
      },
    });
    if (recent >= MAX_RUNS_PER_HOUR)
      throw new HttpException(
        'Workflow run quota exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );

    // Only PUBLISHED, immutable versions run; the mutable draft never does.
    const version = await this.prisma.workflowVersion.findFirst({
      where: { definitionId: def.id, tenantId: actor.tenantId },
      orderBy: { version: 'desc' },
    });
    if (!version)
      throw new ConflictException('Workflow has no published version');
    let graph: WorkflowGraph;
    try {
      graph = parseWorkflowGraph(version.graph);
    } catch (e: unknown) {
      if (e instanceof WorkflowValidationError)
        throw new ConflictException('Published graph failed validation');
      throw e;
    }

    let run;
    try {
      run = await this.prisma.workflowRun.create({
        data: {
          tenantId: actor.tenantId,
          locationId: def.locationId,
          definitionId: def.id,
          version: version.version,
          status: WorkflowRunStatus.RUNNING,
          queryRedacted: redactQuery(query),
          queryLength: query.length,
          idempotencyKey: input.idempotencyKey ?? null,
          startedByUserId: actor.userId,
        },
      });
    } catch (e: unknown) {
      if (
        input.idempotencyKey &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const raced = await this.prisma.workflowRun.findFirst({
          where: {
            tenantId: actor.tenantId,
            definitionId: def.id,
            idempotencyKey: input.idempotencyKey,
          },
          include: { steps: { orderBy: { seq: 'asc' } } },
        });
        if (raced) return raced;
      }
      throw e;
    }
    await this.execute(run.id, actor, def.locationId, graph, query);
    return this.loadRun(actor, run.id);
  }

  private async stillRunning(runId: string, tenantId: string) {
    const r = await this.prisma.workflowRun.findFirst({
      where: { id: runId, tenantId },
      select: { status: true },
    });
    return r?.status === WorkflowRunStatus.RUNNING;
  }

  /** State change that only applies while the run is still RUNNING (no overwriting a cancel). */
  private async transition(
    runId: string,
    tenantId: string,
    data: Prisma.WorkflowRunUpdateManyMutationInput & {
      currentNodeId?: string;
    },
  ): Promise<boolean> {
    const r = await this.prisma.workflowRun.updateMany({
      where: { id: runId, tenantId, status: WorkflowRunStatus.RUNNING },
      data,
    });
    return r.count === 1;
  }

  private async execute(
    runId: string,
    actor: WorkflowActor,
    locationId: string | null,
    graph: WorkflowGraph,
    query: string,
  ) {
    const tenantId = actor.tenantId;
    const nodes = new Map<string, WorkflowNode>(
      graph.nodes.map((n): [string, WorkflowNode] => [n.id, n]),
    );
    let node: WorkflowNode | undefined = graph.nodes.find(
      (n) => n.type === 'start',
    );
    let references: Reference[] = [];
    let seq = 0;
    for (let i = 0; i <= graph.nodes.length && node; i += 1) {
      // A cancel (or any other transition) that landed meanwhile stops execution.
      if (!(await this.stillRunning(runId, tenantId))) return;
      const started = Date.now();
      let next: string | null = null;
      let status = 'completed';
      let output: Prisma.InputJsonValue | undefined;
      try {
        switch (node.type) {
          case 'start':
            next = node.next;
            break;
          case 'knowledge_search': {
            const results = await this.knowledge.search({
              tenantId,
              locationId,
              query,
              forWidget: true,
              limit: node.limit,
            });
            references = results.map((r) => ({
              documentId: r.documentId,
              title: r.title,
              score: r.score,
            }));
            output = { resultCount: references.length };
            next = node.next;
            break;
          }
          case 'branch_on_verified_sources':
            next = references.length > 0 ? node.whenFound : node.whenMissing;
            output = { verifiedSourceCount: references.length, next };
            break;
          case 'tool_action': {
            // Proposal only: lands in the staff approval inbox; the run never waits for or
            // performs the action. A disabled registry skips the node and creates nothing.
            next = node.next;
            if (!toolRegistryEnabled() || !this.tools) {
              status = 'skipped';
              output = { reason: 'tool_registry_disabled' };
              break;
            }
            if (!actor.role) throw new Error('missing_role');
            const proposed = await this.tools.propose(
              {
                tenantId,
                userId: actor.userId,
                role: actor.role,
                boundLocationId: actor.boundLocationId,
              },
              {
                tool: node.tool,
                input: node.fields,
                locationId: locationId ?? undefined,
                idempotencyKey: `wfrun-${runId}-${node.id}`,
              },
            );
            output = { actionId: proposed.id, actionStatus: proposed.status };
            break;
          }
          case 'human_review':
            status = 'suspended';
            break;
          case 'end':
            break;
        }
      } catch {
        await this.prisma.workflowStepRun.create({
          data: {
            tenantId,
            runId,
            seq: seq++,
            nodeId: node.id,
            nodeType: node.type,
            status: 'failed',
            durationMs: Date.now() - started,
          },
        });
        await this.transition(runId, tenantId, {
          status: WorkflowRunStatus.FAILED,
          outcome: 'failed',
          failureReason: 'step_error',
          currentNodeId: node.id,
          references: references as unknown as Prisma.InputJsonValue,
        });
        return;
      }
      await this.prisma.workflowStepRun.create({
        data: {
          tenantId,
          runId,
          seq: seq++,
          nodeId: node.id,
          nodeType: node.type,
          status,
          durationMs: Date.now() - started,
          output,
        },
      });
      if (node.type === 'human_review') {
        const now = new Date();
        await this.transition(runId, tenantId, {
          status: WorkflowRunStatus.SUSPENDED,
          outcome: 'blocked_pending_review',
          currentNodeId: node.id,
          suspendedAt: now,
          suspendedExpiresAt: new Date(now.getTime() + REVIEW_TTL_MS),
          references: references as unknown as Prisma.InputJsonValue,
        });
        return;
      }
      if (node.type === 'end') {
        await this.transition(runId, tenantId, {
          status: WorkflowRunStatus.COMPLETED,
          outcome: 'completed',
          currentNodeId: node.id,
          references: references as unknown as Prisma.InputJsonValue,
        });
        return;
      }
      node = next ? nodes.get(next) : undefined;
    }
    await this.transition(runId, tenantId, {
      status: WorkflowRunStatus.FAILED,
      outcome: 'failed',
      failureReason: 'step_budget_exceeded',
    });
  }

  /** Approve or deny a suspended run. Only an independent actor, only before expiry. */
  async decide(
    actor: WorkflowActor,
    runId: string,
    decision: 'APPROVE' | 'DENY',
  ) {
    const run = await this.loadRun(actor, runId);
    if (run.status !== WorkflowRunStatus.SUSPENDED)
      throw new ConflictException('Run is not awaiting review');
    if (run.startedByUserId === actor.userId)
      throw new ForbiddenException('Reviewer must differ from the run starter');
    const decisionAt = new Date();
    if (
      !run.suspendedExpiresAt ||
      run.suspendedExpiresAt.getTime() <= decisionAt.getTime()
    ) {
      // Missing or elapsed deadline fails closed; claim expiry without
      // overwriting a concurrent decision or cancellation.
      await this.prisma.workflowRun.updateMany({
        where: {
          id: run.id,
          tenantId: actor.tenantId,
          status: WorkflowRunStatus.SUSPENDED,
          OR: [
            { suspendedExpiresAt: null },
            { suspendedExpiresAt: { lte: decisionAt } },
          ],
        },
        data: { status: WorkflowRunStatus.CANCELLED, outcome: 'expired' },
      });
      throw new ConflictException('Review window expired');
    }
    const approved = decision === 'APPROVE';
    // Commit the decision and its immutable step record together: a failed
    // audit insert must never leave a run in a terminal approved state.
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.workflowRun.updateMany({
        where: {
          id: run.id,
          tenantId: actor.tenantId,
          status: WorkflowRunStatus.SUSPENDED,
          // Deadline must still be valid at the time the DB claims this decision.
          suspendedExpiresAt: { gt: decisionAt },
        },
        data: {
          status: approved
            ? WorkflowRunStatus.COMPLETED
            : WorkflowRunStatus.CANCELLED,
          outcome: approved ? 'human_approved' : 'human_denied',
          decidedByUserId: actor.userId,
          decidedAt: decisionAt,
        },
      });
      if (claimed.count !== 1)
        throw new ConflictException('Run changed during decision');
      await tx.workflowStepRun.create({
        data: {
          tenantId: actor.tenantId,
          runId: run.id,
          seq: run.steps.length,
          nodeId: run.currentNodeId ?? 'human_review',
          nodeType: 'human_decision',
          status: approved ? 'approved' : 'denied',
          durationMs: 0,
        },
      });
    });
    return this.loadRun(actor, run.id);
  }

  async cancel(actor: WorkflowActor, runId: string) {
    const run = await this.loadRun(actor, runId);
    const claimed = await this.prisma.workflowRun.updateMany({
      where: {
        id: run.id,
        tenantId: actor.tenantId,
        status: {
          in: [WorkflowRunStatus.RUNNING, WorkflowRunStatus.SUSPENDED],
        },
      },
      data: { status: WorkflowRunStatus.CANCELLED, outcome: 'cancelled' },
    });
    if (claimed.count !== 1)
      throw new ConflictException('Run can no longer be cancelled');
    return this.loadRun(actor, run.id);
  }

  get(actor: WorkflowActor, runId: string) {
    return this.loadRun(actor, runId);
  }

  list(actor: WorkflowActor, definitionId?: string) {
    return this.prisma.workflowRun.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(definitionId ? { definitionId } : {}),
        ...(actor.boundLocationId ? { locationId: actor.boundLocationId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
