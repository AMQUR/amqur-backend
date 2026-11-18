import { PrismaClient } from '@prisma/client';
import { WorkflowDefinitionService } from './workflow-definition.service';

/** Real-DB test; runs only with TEST_DB_URL pointing at a DISPOSABLE migrated Postgres. */
const url = process.env.TEST_DB_URL;
const d = url ? describe : describe.skip;
const graph = {
  version: 1,
  nodes: [
    { id: 'start', type: 'start', next: 'end' },
    { id: 'end', type: 'end' },
  ],
};

d('WorkflowDefinitionService (real DB)', () => {
  const prisma = new PrismaClient({ datasourceUrl: url });
  const svc = new WorkflowDefinitionService(prisma as never);
  const sfx = Date.now().toString(36);
  let tA = '';
  let tB = '';

  beforeAll(async () => {
    tA = (
      await prisma.tenant.create({ data: { slug: `wf-a-${sfx}`, name: 'A' } })
    ).id;
    tB = (
      await prisma.tenant.create({ data: { slug: `wf-b-${sfx}`, name: 'B' } })
    ).id;
  });
  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [tA, tB] } } });
    await prisma.$disconnect();
  });

  it('publishes sequential immutable versions, rollback adds v3, other tenant is denied', async () => {
    const author = { tenantId: tA, userId: 'author', boundLocationId: null };
    const reviewer = {
      tenantId: tA,
      userId: 'reviewer',
      boundLocationId: null,
    };
    const def = await svc.create(author, { name: 'wf', graph });
    await svc.requestReview(author, def.id);
    await expect(svc.approveAndPublish(author, def.id)).rejects.toThrow();
    const v1 = await svc.approveAndPublish(reviewer, def.id);
    await svc.updateDraft(author, def.id, { name: 'wf2' });
    await svc.requestReview(author, def.id);
    const v2 = await svc.approveAndPublish(reviewer, def.id);
    const v3 = await svc.rollback(reviewer, def.id, 1);
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    expect(v3.restoredFromVersion).toBe(1);
    expect(v3.graphChecksum).toBe(v1.graphChecksum);
    const other = { tenantId: tB, userId: 'x', boundLocationId: null };
    await expect(svc.get(other, def.id)).rejects.toThrow();
    await expect(svc.versions(other, def.id)).rejects.toThrow();
    await expect(
      prisma.workflowVersion.create({
        data: {
          tenantId: tA,
          definitionId: def.id,
          version: 2,
          graph,
          graphChecksum: 'x',
          publishedByUserId: 'x',
        },
      }),
    ).rejects.toThrow();
  });
});
