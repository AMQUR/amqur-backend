import { createE2eApp, E2eCtx, seedTwoTenants } from '../helpers/e2e-app';
import { OutboxService } from '../../src/integrations/core/outbox.service';
import { OutboxProcessorService } from '../../src/integrations/core/outbox-processor.service';
import { AppointmentService } from '../../src/appointments/appointment.service';

/**
 * Real-Postgres verification of multi-worker outbox safety and appointment lifecycle.
 * Requires the disposable test stack (npm run test:infra:up) — never production.
 */
describe('production domains (Postgres)', () => {
  let ctx: E2eCtx;
  let seed: Awaited<ReturnType<typeof seedTwoTenants>>;

  const prevOutbox = process.env.OUTBOX_PROCESSOR_ENABLED;

  beforeAll(async () => {
    // Deterministic worker control: the app's scheduled tick must not race these tests.
    process.env.OUTBOX_PROCESSOR_ENABLED = 'false';
    ctx = await createE2eApp();
    seed = await seedTwoTenants(ctx.prisma);
  });

  afterAll(async () => {
    process.env.OUTBOX_PROCESSOR_ENABLED = prevOutbox;
    await ctx.app.close();
  });

  describe('outbox multi-worker claiming', () => {
    beforeEach(async () => {
      await ctx.prisma.outboxEvent.deleteMany({
        where: { topic: { startsWith: 'test.' } },
      });
    });

    it('concurrent workers never claim the same event', async () => {
      const tenantId = seed.alpha.tenant.id;
      await ctx.prisma.outboxEvent.createMany({
        data: Array.from({ length: 60 }, (_, i) => ({
          tenantId,
          topic: 'test.concurrency',
          payload: { i },
          idempotencyKey: `test-conc-${Date.now()}-${i}`,
        })),
      });
      const outbox = ctx.app.get(OutboxService);
      const results = await Promise.all(
        ['w1', 'w2', 'w3', 'w4', 'w5'].map((w) => outbox.claimPending(15, w)),
      );
      const rows = results.flat();
      const ids = rows.map((r) => r.id);
      // No event may be handed to two workers.
      expect(new Set(ids).size).toBe(ids.length);
      // The DB lease owner equals the worker that received it (the app's own scheduled
      // worker may legitimately win some rows too — those simply aren't in `rows`).
      const owners = new Map(
        results.flatMap((rs, i) => rs.map((r) => [r.id, `w${i + 1}`] as const)),
      );
      const ours = rows.filter((r) => r.topic === 'test.concurrency');
      expect(ours.length).toBeGreaterThan(0);
      const db = await ctx.prisma.outboxEvent.findMany({
        where: { id: { in: ours.map((r) => r.id) } },
      });
      for (const r of db) {
        if (r.status === 'PROCESSING')
          expect(r.claimedBy).toBe(owners.get(r.id));
      }
      const sample = db[0];
      expect(sample?.claimedBy).toMatch(/^w[1-5]$/);
      expect(sample?.leaseExpiresAt).toBeTruthy();
    });

    it('a crashed worker’s expired lease is reclaimed by another worker; stale holder cannot complete it', async () => {
      const outbox = ctx.app.get(OutboxService);
      const ev = await outbox.enqueue({
        tenantId: seed.alpha.tenant.id,
        topic: 'test.lease',
        payload: {},
        idempotencyKey: `test-lease-${Date.now()}`,
      });
      const first = await outbox.claimPending(500, 'dead-worker', -1000); // lease already expired
      expect(first.map((r) => r.id)).toContain(ev.id);
      const second = await outbox.claimPending(500, 'live-worker');
      expect(second.map((r) => r.id)).toContain(ev.id);
      const stale = await outbox.markPublished(ev.id, 'dead-worker');
      expect(stale.count).toBe(0);
      const ok = await outbox.markPublished(ev.id, 'live-worker');
      expect(ok.count).toBe(1);
    });

    it('unknown topics are dead-lettered, not silently published', async () => {
      const outbox = ctx.app.get(OutboxService);
      const proc = ctx.app.get(OutboxProcessorService);
      const ev = await outbox.enqueue({
        tenantId: seed.alpha.tenant.id,
        topic: 'test.no-handler',
        payload: {},
        idempotencyKey: `test-nohandler-${Date.now()}`,
      });
      // Any worker (this one or the app's scheduled tick) may process it — assert the outcome.
      let row = await ctx.prisma.outboxEvent.findUnique({
        where: { id: ev.id },
      });
      for (let i = 0; i < 20 && row?.status !== 'DEAD'; i += 1) {
        await proc.processBatch(500, 'unit-worker');
        await new Promise((r) => setTimeout(r, 100));
        row = await ctx.prisma.outboxEvent.findUnique({ where: { id: ev.id } });
      }
      expect(row?.status).toBe('DEAD');
      expect(row?.lastError).toContain('no_handler_for_topic');
    });

    it('idempotent enqueue returns the same row under concurrency', async () => {
      const outbox = ctx.app.get(OutboxService);
      const key = `test-idem-${Date.now()}`;
      const rows = await Promise.all(
        Array.from({ length: 6 }, () =>
          outbox.enqueue({
            tenantId: seed.alpha.tenant.id,
            topic: 'test.idem',
            payload: {},
            idempotencyKey: key,
          }),
        ),
      );
      expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    });
  });

  describe('appointment lifecycle', () => {
    const now = new Date('2026-10-13T15:00:00Z'); // Tue 10:00 CDT

    beforeAll(async () => {
      await ctx.prisma.location.update({
        where: { id: seed.alpha.location.id },
        data: {
          timezone: 'America/Chicago',
          storeHours: {
            mon: { open: '09:00', close: '19:00' },
            tue: { open: '09:00', close: '19:00' },
            wed: { open: '09:00', close: '19:00' },
            thu: { open: '09:00', close: '19:00' },
            fri: { open: '09:00', close: '19:00' },
            sat: { open: '09:00', close: '18:00' },
            sun: null,
          },
          holidayHours: [{ date: '2026-12-25', closed: true }],
          storeHoursVerifiedAt: new Date('2026-10-01T00:00:00Z'),
        },
      });
    });

    it('persists a REQUESTED appointment (never confirmed without a provider) with dealership-tz instant', async () => {
      const svc = ctx.app.get(AppointmentService);
      const res = await svc.request({
        tenantId: seed.alpha.tenant.id,
        locationId: seed.alpha.location.id,
        type: 'TEST_DRIVE',
        when: {
          date: { year: 2026, month: 10, day: 17 },
          time: 15 * 60,
          phrase: 'Saturday at 3',
        },
        vin: '1C4RJFBG0MC100001',
        source: 'chat',
        now,
        idempotencyKey: `test-appt-${Date.now()}`,
      });
      expect(res.status).toBe('saved');
      if (res.status !== 'saved') return;
      expect(res.outcome).toBe('requested');
      expect(res.appointment.status).toBe('REQUESTED');
      expect(res.appointment.availabilityVerified).toBe(false);
      expect(res.appointment.provider).toBe('NONE');
      expect(res.appointment.requestedAt?.toISOString()).toBe(
        '2026-10-17T20:00:00.000Z',
      );
      const ob = await ctx.prisma.outboxEvent.findFirst({
        where: {
          topic: 'appointment.requested',
          payload: { path: ['appointmentId'], equals: res.appointment.id },
        },
      });
      expect(ob).toBeTruthy();
    });

    it('rejects a closed day with real alternatives and persists nothing', async () => {
      const svc = ctx.app.get(AppointmentService);
      const before = await ctx.prisma.appointment.count({
        where: { tenantId: seed.alpha.tenant.id },
      });
      const res = await svc.request({
        tenantId: seed.alpha.tenant.id,
        locationId: seed.alpha.location.id,
        type: 'SERVICE',
        when: {
          date: { year: 2026, month: 12, day: 25 },
          time: 600,
          phrase: 'christmas 10am',
        },
        source: 'chat',
        now,
      });
      expect(res.status).toBe('rejected');
      if (res.status === 'rejected') {
        expect(res.code).toBe('closed_day');
        expect(res.alternatives[0].date).toBe('2026-12-26');
      }
      expect(
        await ctx.prisma.appointment.count({
          where: { tenantId: seed.alpha.tenant.id },
        }),
      ).toBe(before);
    });

    it('reschedule links rows and cancel is terminal', async () => {
      const svc = ctx.app.get(AppointmentService);
      const first = await svc.request({
        tenantId: seed.alpha.tenant.id,
        locationId: seed.alpha.location.id,
        type: 'SERVICE',
        when: {
          date: { year: 2026, month: 10, day: 16 },
          partOfDay: 'morning',
          phrase: 'Friday morning',
        },
        source: 'chat',
        now,
        idempotencyKey: `test-resched-${Date.now()}`,
      });
      expect(first.status).toBe('saved');
      if (first.status !== 'saved') return;
      const moved = await svc.reschedule({
        tenantId: seed.alpha.tenant.id,
        appointmentId: first.appointment.id,
        when: {
          date: { year: 2026, month: 10, day: 17 },
          partOfDay: 'morning',
          phrase: 'Saturday',
        },
        source: 'chat',
        now,
      });
      expect(moved.status).toBe('saved');
      if (moved.status !== 'saved') return;
      const old = await ctx.prisma.appointment.findUnique({
        where: { id: first.appointment.id },
      });
      expect(old?.status).toBe('RESCHEDULED');
      const next = await ctx.prisma.appointment.findUnique({
        where: { id: moved.appointment.id },
      });
      expect(next?.rescheduledFromId).toBe(first.appointment.id);
      const canceled = await svc.cancel({
        tenantId: seed.alpha.tenant.id,
        appointmentId: moved.appointment.id,
        source: 'chat',
      });
      expect(canceled.status).toBe('CANCELLED');
      await expect(
        svc.cancel({
          tenantId: seed.alpha.tenant.id,
          appointmentId: moved.appointment.id,
          source: 'chat',
        }),
      ).rejects.toThrow();
    });

    it('cannot read or mutate another tenant’s appointment', async () => {
      const svc = ctx.app.get(AppointmentService);
      const a = await svc.request({
        tenantId: seed.alpha.tenant.id,
        locationId: seed.alpha.location.id,
        type: 'SALES',
        when: {
          date: { year: 2026, month: 10, day: 19 },
          time: 600,
          phrase: 'monday 10',
        },
        source: 'chat',
        now,
        idempotencyKey: `test-iso-${Date.now()}`,
      });
      if (a.status !== 'saved') throw new Error('expected saved');
      await expect(
        svc.cancel({
          tenantId: seed.beta.tenant.id,
          appointmentId: a.appointment.id,
          source: 'api',
        }),
      ).rejects.toThrow('Appointment not found');
      const betaList = await svc.list(seed.beta.tenant.id, {});
      expect(betaList.find((x) => x.id === a.appointment.id)).toBeUndefined();
    });
  });
});
