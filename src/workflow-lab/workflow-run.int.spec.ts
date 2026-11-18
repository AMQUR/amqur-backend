import { PrismaClient } from '@prisma/client';
import { WorkflowDefinitionService } from './workflow-definition.service';
import { WorkflowRunService } from './workflow-run.service';

/** Real-DB test; runs only with TEST_DB_URL pointing at a DISPOSABLE migrated Postgres. */
const url = process.env.TEST_DB_URL;
const d = url ? describe : describe.skip;
const graph = {
  version: 1,
  nodes: [
    { id: 'start', type: 'start', next: 'kb' },
    { id: 'kb', type: 'knowledge_search', next: 'br', limit: 3 },
    {
      id: 'br',
      type: 'branch_on_verified_sources',
      whenFound: 'done',
      whenMissing: 'rev',
    },
    { id: 'done', type: 'end' },
    { id: 'rev', type: 'human_review', reason: 'specialist' },
  ],
};

d('WorkflowRunService (real DB)', () => {
  const prisma = new PrismaClient({ datasourceUrl: url });
  const defs = new WorkflowDefinitionService(prisma as never);
  const search = jest.fn().mockResolvedValue([]);
  const runs = new WorkflowRunService(prisma as never, { search } as never);
  const sfx = Date.now().toString(36);
  let tA = '';
  let tB = '';
  let defId = '';
  const author = () => ({
    tenantId: tA,
    userId: 'author',
    boundLocationId: null,
  });
  const reviewer = () => ({
    tenantId: tA,
    userId: 'reviewer',
    boundLocationId: null,
  });

  beforeAll(async () => {
    tA = (
      await prisma.tenant.create({ data: { slug: `wr-a-${sfx}`, name: 'A' } })
    ).id;
    tB = (
      await prisma.tenant.create({ data: { slug: `wr-b-${sfx}`, name: 'B' } })
    ).id;
    const def = await defs.create(author(), { name: 'wf', graph });
    defId = def.id;
    await defs.requestReview(author(), defId);
    const seen = (await defs.get(reviewer(), defId)).draftChecksum;
    await defs.approveAndPublish(reviewer(), defId, seen);
  });
  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [tA, tB] } } });
    await prisma.$disconnect();
  });

  it('suspends, is idempotent, rejects self-decision, honours one approval, isolates tenants', async () => {
    const run = await runs.start(author(), {
      definitionId: defId,
      query: 'call me 555-123-4567 re warranty',
      idempotencyKey: 'idem-key-001',
    });
    expect(run.status).toBe('SUSPENDED');
    expect(run.queryRedacted).not.toMatch(/555/);
    expect(run.steps.map((s) => s.nodeId)).toEqual([
      'start',
      'kb',
      'br',
      'rev',
    ]);

    const again = await runs.start(author(), {
      definitionId: defId,
      query: 'x',
      idempotencyKey: 'idem-key-001',
    });
    expect(again.id).toBe(run.id);
    expect(search).toHaveBeenCalledTimes(1);

    await expect(runs.decide(author(), run.id, 'APPROVE')).rejects.toThrow();
    const done = await runs.decide(reviewer(), run.id, 'APPROVE');
    expect(done.status).toBe('COMPLETED');
    expect(done.outcome).toBe('human_approved');
    await expect(runs.decide(reviewer(), run.id, 'APPROVE')).rejects.toThrow();

    const other = { tenantId: tB, userId: 'x', boundLocationId: null };
    await expect(runs.get(other, run.id)).rejects.toThrow();
    await expect(
      runs.start(other, { definitionId: defId, query: 'x' }),
    ).rejects.toThrow();
  });

  it('expired suspended runs can never be approved', async () => {
    const run = await runs.start(author(), {
      definitionId: defId,
      query: 'later',
    });
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { suspendedExpiresAt: new Date(Date.now() - 1000) },
    });
    await expect(runs.decide(reviewer(), run.id, 'APPROVE')).rejects.toThrow();
    const after = await runs.get(author(), run.id);
    expect(after.status).toBe('CANCELLED');
    expect(after.outcome).toBe('expired');
  });
});
