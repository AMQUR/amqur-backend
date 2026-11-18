import { BadRequestException } from '@nestjs/common';
import { WorkflowPreviewService } from './workflow-preview.service';
import type { KnowledgeRetrievalService } from '../knowledge/knowledge-retrieval.service';

const graph = {
  version: 1,
  nodes: [
    { id: 'start', type: 'start', next: 'knowledge' },
    { id: 'knowledge', type: 'knowledge_search', next: 'branch' },
    {
      id: 'branch',
      type: 'branch_on_verified_sources',
      whenFound: 'done',
      whenMissing: 'review',
    },
    { id: 'done', type: 'end' },
    {
      id: 'review',
      type: 'human_review',
      reason: 'Ask a dealership specialist',
    },
  ],
};

function setup(
  results: Array<{ documentId: string; title: string; score: number }>,
) {
  const search = jest.fn().mockResolvedValue(results);
  const service = new WorkflowPreviewService(
    { search } as unknown as KnowledgeRetrievalService,
  );
  return { service, search };
}

describe('WorkflowPreviewService', () => {
  const context = {
    tenantId: 'tenant-a',
    locationId: 'store-a',
    query: 'Warranty policy',
  };

  it('uses published customer knowledge with JWT-derived tenant/location scope', async () => {
    const { service, search } = setup([
      { documentId: 'doc-1', title: 'Published warranty', score: 0.9 },
    ]);
    const res = await service.preview(graph, context);
    expect(search).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      locationId: 'store-a',
      query: context.query,
      limit: 3,
      forWidget: true,
    });
    expect(res.status).toBe('complete');
    expect(res.verifiedSourceCount).toBe(1);
    expect(res.trace.map((item) => item.nodeId)).toEqual([
      'start',
      'knowledge',
      'branch',
      'done',
    ]);
  });

  it('halts for a human if no verified sources are found', async () => {
    const { service } = setup([]);
    const res = await service.preview(graph, context);
    expect(res.status).toBe('blocked_pending_review');
    expect(res.reviewReason).toBe('Ask a dealership specialist');
    expect(res.trace.at(-1)?.status).toBe('blocked_pending_review');
  });

  it('rejects invalid graphs and empty tenant contexts', async () => {
    const { service } = setup([]);
    await expect(
      service.preview({ version: 1, nodes: [] }, context),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.preview(graph, { ...context, tenantId: '' }),
    ).rejects.toThrow(BadRequestException);
  });
});
