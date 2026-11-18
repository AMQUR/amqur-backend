import { KnowledgeEmbeddingService } from './knowledge-embedding.service';
import type { EmbeddingProvider } from './embedding.provider';

function provider(over: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    providerId: 'fake',
    modelId: 'm-v1',
    isAvailable: () => true,
    embed: jest.fn(async (texts: string[]) =>
      texts.map(() => ({ model: 'm-v1', dimensions: 2, vector: [1, 0] })),
    ),
    ...over,
  };
}

describe('KnowledgeEmbeddingService', () => {
  const prisma = {
    knowledgeChunk: { findMany: jest.fn(), update: jest.fn() },
  };
  beforeEach(() => jest.resetAllMocks());

  it('is a no-op when provider unavailable (fail closed)', async () => {
    const p = provider({ isAvailable: () => false });
    const svc = new KnowledgeEmbeddingService(prisma as never, p);
    expect(await svc.embedPending('t1')).toEqual({
      embedded: 0,
      skipped: 'provider_disabled',
    });
    expect(prisma.knowledgeChunk.findMany).not.toHaveBeenCalled();
  });

  it("selects only this tenant's chunks missing or on a stale model", async () => {
    prisma.knowledgeChunk.findMany.mockResolvedValue([]);
    const svc = new KnowledgeEmbeddingService(prisma as never, provider());
    await svc.embedPending('tenant-a');
    const arg = prisma.knowledgeChunk.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe('tenant-a');
    expect(JSON.stringify(arg.where.OR)).toContain('m-v1');
  });

  it('embeds pending chunks and stamps model (idempotent re-run finds none)', async () => {
    prisma.knowledgeChunk.findMany
      .mockResolvedValueOnce([
        { id: 'c1', content: 'a' },
        { id: 'c2', content: 'b' },
      ])
      .mockResolvedValue([]);
    prisma.knowledgeChunk.update.mockResolvedValue({});
    const p = provider();
    const svc = new KnowledgeEmbeddingService(prisma as never, p);
    expect((await svc.embedPending('t1')).embedded).toBe(2);
    expect(prisma.knowledgeChunk.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c1' },
        data: expect.objectContaining({
          embedding: [1, 0],
          embeddingModel: 'm-v1',
        }),
      }),
    );
    expect((await svc.embedPending('t1')).embedded).toBe(0);
  });

  it('does not write when provider returns wrong count or throws', async () => {
    prisma.knowledgeChunk.findMany.mockResolvedValue([
      { id: 'c1', content: 'a' },
    ]);
    const bad = provider({ embed: jest.fn(async () => []) });
    const svc = new KnowledgeEmbeddingService(prisma as never, bad);
    expect((await svc.embedPending('t1')).embedded).toBe(0);
    const boom = provider({
      embed: jest.fn(async () => {
        throw new Error('x');
      }),
    });
    const svc2 = new KnowledgeEmbeddingService(prisma as never, boom);
    expect((await svc2.embedPending('t1')).embedded).toBe(0);
    expect(prisma.knowledgeChunk.update).not.toHaveBeenCalled();
  });
});
