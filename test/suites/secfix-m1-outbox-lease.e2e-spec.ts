import { createE2eApp, E2eCtx } from '../helpers/e2e-app';
import { OutboxProcessorService } from '../../src/integrations/core/outbox-processor.service';
import { OutboxService } from '../../src/integrations/core/outbox.service';
import { MetricsService } from '../../src/observability/metrics.service';

/**
 * Security review M1 — a lease that expires under a live but slow worker must not charge an
 * attempt to rows whose handler never started, and no row may be handled twice.
 * Real Postgres + the real claim SQL; two workers = two processor instances with distinct ids.
 */
const TOPIC = 'secfix.m1.slow-batch';
const SLUG = 'sfm1-outbox';

describe('M1 outbox lease under a slow batch (two workers)', () => {
  let ctx: E2eCtx;
  let outbox: OutboxService;
  let workerA: OutboxProcessorService;
  let workerB: OutboxProcessorService;
  let tenantId = '';
  const prevEnabled = process.env.OUTBOX_PROCESSOR_ENABLED;

  /** Park every other due event so each test drives only its own rows (shared test database). */
  const park = () =>
    ctx.prisma.outboxEvent.updateMany({
      where: { status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: 'DEAD', lastError: 'test_suite_cleanup' },
    });
  const enqueue = async (n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const ev = await outbox.enqueue({
        tenantId,
        topic: TOPIC,
        payload: { n: i },
      });
      // deterministic claim order
      await ctx.prisma.outboxEvent.update({
        where: { id: ev.id },
        data: {
          createdAt: new Date(Date.now() - (n - i) * 1000),
          nextAttemptAt: new Date(0),
        },
      });
      ids.push(ev.id);
    }
    return ids;
  };
  const rows = (ids: string[]) =>
    ctx.prisma.outboxEvent.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: 'asc' },
    });
  /** "Time passes": the lease taken at claim time lapses for these rows. */
  const lapse = (ids: string[]) =>
    ctx.prisma.$executeRawUnsafe(
      `UPDATE "OutboxEvent" SET "leaseExpiresAt" = NOW() - interval '1 second' WHERE "id" = ANY($1::text[])`,
      ids,
    );

  beforeAll(async () => {
    process.env.OUTBOX_PROCESSOR_ENABLED = 'false';
    ctx = await createE2eApp();
    outbox = ctx.app.get(OutboxService);
    const metrics = ctx.app.get(MetricsService);
    // Two independent workers sharing one database, as two replicas would.
    workerA = new OutboxProcessorService(outbox, ctx.prisma, metrics);
    workerB = new OutboxProcessorService(outbox, ctx.prisma, metrics);
    tenantId = (
      await ctx.prisma.tenant.upsert({
        where: { slug: SLUG },
        create: { slug: SLUG, name: 'M1 outbox (simulated)' },
        update: {},
      })
    ).id;
  });
  beforeEach(async () => {
    await park();
  });
  afterAll(async () => {
    await park();
    if (prevEnabled === undefined) delete process.env.OUTBOX_PROCESSOR_ENABLED;
    else process.env.OUTBOX_PROCESSOR_ENABLED = prevEnabled;
    await ctx.app.close();
  });

  it('slow batch: unstarted rows reclaimed by another replica are not charged an attempt and are handled exactly once', async () => {
    const ids = await enqueue(4);
    const handled: Record<string, string[]> = {};
    const note = (id: string, worker: string) =>
      (handled[id] = [...(handled[id] ?? []), worker]);

    workerB.registerHandler(TOPIC, (_p, m) => {
      note(m.id, 'B');
      return Promise.resolve();
    });
    let firstId = '';
    workerA.registerHandler(TOPIC, async (_p, m) => {
      note(m.id, 'A');
      if (firstId) return;
      firstId = m.id;
      // Worker A is slow on its first row: the batch lease lapses for the rows it has not
      // started, and replica B's tick reclaims and handles them meanwhile.
      await lapse(ids.filter((x) => x !== firstId));
      await workerB.processBatch(50, 'm1-worker-B');
    });

    await workerA.processBatch(50, 'm1-worker-A');

    // no row handled twice; A only ever ran the row it actually started
    expect(handled).toEqual(
      Object.fromEntries(ids.map((x) => [x, [x === firstId ? 'A' : 'B']])),
    );
    const after = await rows(ids);
    expect(after.map((r) => r.status)).toEqual([
      'PUBLISHED',
      'PUBLISHED',
      'PUBLISHED',
      'PUBLISHED',
    ]);
    // no unstarted row was charged for the lapsed lease
    expect(after.map((r) => r.attempts)).toEqual([0, 0, 0, 0]);
    expect(
      after
        .filter((r) => r.id !== firstId)
        .every((r) => r.claimedBy === 'm1-worker-B'),
    ).toBe(true);
  });

  it('a stale worker does not fail, retry or dead-letter a row it no longer owns', async () => {
    const pair = await enqueue(2);
    const calls: string[] = [];
    workerB.registerHandler(TOPIC, () => {
      calls.push('B');
      return Promise.resolve();
    });
    let firstId = '';
    workerA.registerHandler(TOPIC, async (_p, m) => {
      calls.push(firstId ? 'A:second' : 'A:first');
      if (firstId) throw new Error('would_have_failed_the_row');
      firstId = m.id;
      await lapse(pair.filter((x) => x !== firstId));
      await workerB.processBatch(50, 'm1-worker-B');
    });
    await workerA.processBatch(50, 'm1-worker-A');
    expect(calls).toEqual(['A:first', 'B']);
    const second = (await rows(pair)).find((r) => r.id !== firstId)!;
    expect(second).toMatchObject({
      status: 'PUBLISHED',
      attempts: 0,
      lastError: null,
    });
  });

  it('each row gets a fresh lease when its own handler starts (not the lease taken for the whole batch)', async () => {
    const ids = await enqueue(2);
    const leaseAtStart: number[] = [];
    workerA.registerHandler(TOPIC, async (_p, m) => {
      const [r] = await ctx.prisma.$queryRawUnsafe<
        Array<{ remaining: number; started: boolean }>
      >(
        `SELECT EXTRACT(EPOCH FROM ("leaseExpiresAt" - NOW()))::float AS remaining, "handlerStartedAt" IS NOT NULL AS started FROM "OutboxEvent" WHERE "id" = $1`,
        m.id,
      );
      expect(r.started).toBe(true);
      leaseAtStart.push(r.remaining);
      // burn most of the ORIGINAL batch lease for the row that has not started yet
      if (leaseAtStart.length === 1)
        await ctx.prisma.$executeRawUnsafe(
          `UPDATE "OutboxEvent" SET "leaseExpiresAt" = NOW() + interval '2 seconds' WHERE "id" = $1`,
          ids.find((x) => x !== m.id),
        );
    });
    await workerA.processBatch(50, 'm1-worker-A');
    expect(leaseAtStart).toHaveLength(2);
    expect(leaseAtStart[1]).toBeGreaterThan(100); // renewed to the full 120 s
  });

  it('an abandoned claim still counts when the handler HAD started (crashing event reaches the limit)', async () => {
    const [started, waiting] = await enqueue(2);
    const claimed = await outbox.claimPending(50, 'm1-crashy');
    expect(claimed.map((r) => r.id).sort()).toEqual([started, waiting].sort());
    expect(await outbox.beginHandling(started, 'm1-crashy')).toBe(true);
    // …the worker dies here: `started` was mid-handler, `waiting` had not begun.
    await lapse([started, waiting]);
    // a worker whose lease lapsed can no longer begin a row
    expect(await outbox.beginHandling(waiting, 'm1-crashy')).toBe(false);

    const reclaimed = await outbox.claimPending(50, 'm1-rescuer');
    const byId = Object.fromEntries(reclaimed.map((r) => [r.id, r]));
    expect(byId[started].attempts).toBe(1);
    expect(byId[waiting].attempts).toBe(0);
    expect(byId[started].handlerStartedAt).toBeNull();
    // only the current owner may begin
    expect(await outbox.beginHandling(started, 'm1-crashy')).toBe(false);
    expect(await outbox.beginHandling(started, 'm1-rescuer')).toBe(true);
  });
});
