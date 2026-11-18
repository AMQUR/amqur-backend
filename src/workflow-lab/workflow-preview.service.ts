import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeRetrievalService } from '../knowledge/knowledge-retrieval.service';
import {
  parseWorkflowGraph,
  WorkflowValidationError,
  type WorkflowNode,
} from './workflow-graph';

export type WorkflowPreviewContext = {
  tenantId: string;
  locationId?: string | null;
  query: string;
};

type TraceItem = {
  nodeId: string;
  type: WorkflowNode['type'];
  status: 'completed' | 'blocked_pending_review' | 'would_propose';
  durationMs: number;
};

/**
 * Strictly read-only staff preview. Knowledge search is customer-published only:
 * preview cannot accidentally surface draft/internal dealership data.
 */
@Injectable()
export class WorkflowPreviewService {
  constructor(
    private readonly knowledge: KnowledgeRetrievalService,
    private readonly prisma: PrismaService,
  ) {}

  async preview(graphInput: unknown, context: WorkflowPreviewContext) {
    let graph;
    try {
      graph = parseWorkflowGraph(graphInput);
    } catch (error: unknown) {
      if (error instanceof WorkflowValidationError)
        throw new BadRequestException(error.message);
      throw error;
    }
    const query = context.query.trim();
    if (!query || query.length > 300)
      throw new BadRequestException(
        'Query must be between 1 and 300 characters',
      );
    if (!context.tenantId)
      throw new BadRequestException('Tenant context is required');

    // A rooftop id must belong to the JWT tenant (read-only lookup); never trust the request.
    if (context.locationId) {
      const location = await this.prisma.location.findFirst({
        where: { id: context.locationId, tenantId: context.tenantId },
        select: { id: true },
      });
      if (!location) throw new ForbiddenException('Location access denied');
    }

    const nodes = new Map<string, WorkflowNode>(
      graph.nodes.map((node): [string, WorkflowNode] => [node.id, node]),
    );
    const start = graph.nodes.find((node) => node.type === 'start')!;
    let id: string = start.id;
    let references: Array<{
      documentId: string;
      title: string;
      score: number;
    }> = [];
    const trace: TraceItem[] = [];
    for (let step = 0; step < graph.nodes.length; step += 1) {
      const node = nodes.get(id)!;
      const started = Date.now();
      let next: string | null = null;
      let status: TraceItem['status'] = 'completed';
      switch (node.type) {
        case 'start':
          next = node.next;
          break;
        case 'knowledge_search': {
          const results = await this.knowledge.search({
            tenantId: context.tenantId,
            locationId: context.locationId,
            query,
            forWidget: true,
            limit: node.limit,
          });
          references = results.map((result) => ({
            documentId: result.documentId,
            title: result.title,
            score: result.score,
          }));
          next = node.next;
          break;
        }
        case 'branch_on_verified_sources':
          next = references.length > 0 ? node.whenFound : node.whenMissing;
          break;
        case 'tool_action':
          // Preview never proposes anything; it only shows that a proposal would be made.
          status = 'would_propose';
          next = node.next;
          break;
        case 'human_review':
          status = 'blocked_pending_review';
          break;
        case 'end':
          break;
      }
      trace.push({
        nodeId: node.id,
        type: node.type,
        status,
        durationMs: Date.now() - started,
      });
      if (node.type === 'human_review') {
        return {
          mode: 'preview' as const,
          status: 'blocked_pending_review' as const,
          verifiedSourceCount: references.length,
          references,
          reviewReason: node.reason,
          trace,
        };
      }
      if (node.type === 'end') {
        return {
          mode: 'preview' as const,
          status: 'complete' as const,
          verifiedSourceCount: references.length,
          references,
          trace,
        };
      }
      id = next!;
    }
    // A validated acyclic graph must terminate within N nodes.
    throw new BadRequestException(
      'Workflow failed to terminate within its step budget',
    );
  }
}
