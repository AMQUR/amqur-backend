import { PrismaClient } from '@prisma/client';
import { KnowledgeVectorStore } from './knowledge-vector-store';

/**
 * Real-database test. Runs only when TEST_PGVECTOR_URL points at a DISPOSABLE Postgres that
 * has the pgvector extension and all migrations applied. Never point at production.
 */
const url = process.env.TEST_PGVECTOR_URL;
const d = url ? describe : describe.skip;

function unit(i: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[i] = 1;
  return v;
}

d('KnowledgeVectorStore (pgvector, real DB)', () => {
  const prisma = new PrismaClient({ datasourceUrl: url });
  const store = new KnowledgeVectorStore(prisma as never);
  const suffix = Date.now().toString(36);
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    process.env.KNOWLEDGE_PGVECTOR_ENABLED = 'true';
    for (const key of ['a', 'b']) {
      const t = await prisma.tenant.create({
        data: { slug: `vec-${key}-${suffix}`, name: `Vec ${key}` },
      });
      ids[`tenant${key}`] = t.id;
    }
    const mk = async (
      key: string,
      tenantKey: string,
      status: 'PUBLISHED' | 'DRAFT',
      axis: number,
    ) => {
      const doc = await prisma.knowledgeDocument.create({
        data: {
          tenantId: ids[tenantKey],
          title: key,
          content: key,
          contentChecksum: key + suffix,
          status,
          visibility: 'CUSTOMER',
        },
      });
      const chunk = await prisma.knowledgeChunk.create({
        data: {
          tenantId: ids[tenantKey],
          documentId: doc.id,
          chunkIndex: 0,
          content: key,
          embeddingModel: 'm',
        },
      });
      ids[key] = chunk.id;
      await store.store(chunk.id, ids[tenantKey], unit(axis));
    };
    await mk('a-pub-near', 'tenanta', 'PUBLISHED', 0);
    await mk('a-pub-far', 'tenanta', 'PUBLISHED', 5);
    await mk('a-draft', 'tenanta', 'DRAFT', 0);
    await mk('b-pub', 'tenantb', 'PUBLISHED', 0);
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({
      where: { id: { in: [ids.tenanta, ids.tenantb] } },
    });
    await prisma.$disconnect();
  });

  const run = (tenantKey: string) =>
    store.nearest({
      tenantId: ids[tenantKey],
      vector: unit(0),
      statuses: ['PUBLISHED'],
      customerOnly: true,
      limit: 10,
    });

  it('detects the column and ranks nearest first', async () => {
    expect(await store.isEnabled()).toBe(true);
    const r = await run('tenanta');
    expect(r?.[0]).toBe(ids['a-pub-near']);
  });

  it("never returns drafts or other tenants' chunks", async () => {
    const a = (await run('tenanta')) ?? [];
    expect(a).not.toContain(ids['a-draft']);
    expect(a).not.toContain(ids['b-pub']);
    const b = (await run('tenantb')) ?? [];
    expect(b).toEqual([ids['b-pub']]);
  });
});
