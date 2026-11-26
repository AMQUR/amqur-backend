import { createE2eApp, E2eCtx } from '../helpers/e2e-app';
import { OutboxProcessorService } from '../../src/integrations/core/outbox-processor.service';
import { OUTBOX_MAX_ATTEMPTS } from '../../src/integrations/core/outbox.service';
import {
  ACCEPT_RECORD_PENDING,
  LEAD_DELIVERY_TOPIC,
  LeadDeliveryService,
  OUTBOX_ABANDONED_CODE,
  OUTBOX_DEAD_SWEEP_CODE,
} from '../../src/integrations/adf/lead-delivery.service';
import { LeadDeliveryRouteService } from '../../src/integrations/adf/lead-delivery-route.service';
import { SandboxSinkTransport } from '../../src/integrations/adf/transports/sandbox-sink.transport';
import { seedSandboxRoutes } from '../../src/integrations/adf/sandbox-routes.seed';

/**
 * Security review H2 — an outbox event dead-lettered on the "abandoned after repeated lease
 * expiry" path never ran its handler, so the LeadDelivery row stayed QUEUED/SENT forever
 * (not replayable, never finalised, invisible as a failure). Real ADF topic, real outbox,
 * in-process sandbox sink. Synthetic data only (example.invalid, 555-01xx).
 */
const ENV_KEYS = [
  'OUTBOX_PROCESSOR_ENABLED',
  'ADF_SEND_ENABLED',
  'LEAD_DELIVERY_MODE',
  'ADF_SANDBOX_TRANSPORT',
] as const;
const SLUG = 'sfh2-rooftop';

describe('H2 a lead delivery never strands behind an abandoned (DEAD) outbox event', () => {
  let ctx: E2eCtx;
  let deliveries: LeadDeliveryService;
  let processor: OutboxProcessorService;
  let sink: SandboxSinkTransport;
  const prev: Record<string, string | undefined> = {};
  let tenantId = '';
  let locationId = '';
  let staffId = '';
  let routeId = '';
  let seq = 0;
  const run = Date.now().toString(36);
  const scope = () => ({ tenantId, locationId: null });

  const newDelivery = async () => {
    seq += 1;
    const lead = await ctx.prisma.lead.create({
      data: {
        tenantId,
        locationId,
        firstName: 'Synthetic',
        lastName: `Stranded${seq}`,
        email: `sfh2-${run}-${seq}@example.invalid`,
        phone: `+1312555${String(100 + (seq % 100)).padStart(4, '0')}`,
        source: 'widget',
      },
    });
    await deliveries.enqueueForLead(tenantId, lead.id);
    return ctx.prisma.leadDelivery.findFirstOrThrow({
      where: { leadId: lead.id },
    });
  };
  const row = (id: string) =>
    ctx.prisma.leadDelivery.findUniqueOrThrow({ where: { id } });
  const outboxOf = async (deliveryId: string) =>
    ctx.prisma.outboxEvent.findUniqueOrThrow({
      where: { id: (await row(deliveryId)).outboxEventId as string },
    });
  const history = async (deliveryId: string) =>
    (
      await ctx.prisma.leadDeliveryEvent.findMany({
        where: { deliveryId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((h) => `${h.toStatus}:${h.reasonCode}`);
  const sinkFor = (deliveryId: string) =>
    sink.messages().filter((m) => m.deliveryId === deliveryId);
  const park = () =>
    ctx.prisma.outboxEvent.updateMany({
      where: {
        tenant: { slug: SLUG },
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      data: { status: 'DEAD', lastError: 'test_suite_cleanup' },
    });
  /**
   * The event's worker died mid-handler on every attempt: one more lapsed lease takes it to the
   * attempt limit, so the next claim dead-letters it WITHOUT running the handler.
   */
  const abandonOnNextClaim = async (deliveryId: string) => {
    const ev = await outboxOf(deliveryId);
    await ctx.prisma.$executeRawUnsafe(
      `UPDATE "OutboxEvent"
          SET "status" = 'PROCESSING', "attempts" = $2, "claimedBy" = 'dead-worker',
              "claimedAt" = NOW() - interval '10 minutes',
              "handlerStartedAt" = NOW() - interval '10 minutes',
              "leaseExpiresAt" = NOW() - interval '5 minutes'
        WHERE "id" = $1`,
      ev.id,
      OUTBOX_MAX_ATTEMPTS - 1,
    );
    await processor.processBatch(500, 'sfh2-e2e');
    return row(deliveryId);
  };
  const runWorker = async (deliveryId: string) => {
    const ev = await outboxOf(deliveryId);
    await ctx.prisma.outboxEvent.update({
      where: { id: ev.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await processor.processBatch(500, 'sfh2-e2e');
    return row(deliveryId);
  };
  /** A worker that crashed right after the hand-off: SENT, no outcome. */
  const crashedSent = (deliveryId: string) =>
    ctx.prisma.$executeRawUnsafe(
      `UPDATE "LeadDelivery" SET "status" = 'SENT', "sentAt" = NOW(), "attempts" = 1, "updatedAt" = NOW() - interval '10 minutes' WHERE "id" = $1`,
      deliveryId,
    );
  /** The transport accepted; only the ACCEPTED record is outstanding (receipt stored on the row). */
  const acceptedUnrecorded = (deliveryId: string) =>
    ctx.prisma.$executeRawUnsafe(
      `UPDATE "LeadDelivery"
          SET "status" = 'SENT', "sentAt" = NOW(), "attempts" = 1,
              "providerName" = 'sandbox-sink', "providerMessageId" = $2,
              "providerRawStatus" = 'accepted', "acceptedAt" = NOW(),
              "lastErrorCode" = $3, "lastErrorAt" = NOW(), "routeId" = $4
        WHERE "id" = $1`,
      deliveryId,
      `sink-stored-${deliveryId}`,
      ACCEPT_RECORD_PENDING,
      routeId,
    );

  beforeAll(async () => {
    for (const k of ENV_KEYS) prev[k] = process.env[k];
    process.env.OUTBOX_PROCESSOR_ENABLED = 'false';
    process.env.ADF_SEND_ENABLED = 'true';
    process.env.LEAD_DELIVERY_MODE = 'sandbox';
    process.env.ADF_SANDBOX_TRANSPORT = 'sink';
    ctx = await createE2eApp();
    deliveries = ctx.app.get(LeadDeliveryService);
    processor = ctx.app.get(OutboxProcessorService);
    sink = ctx.app.get(SandboxSinkTransport);
    const tenant = await ctx.prisma.tenant.upsert({
      where: { slug: SLUG },
      create: {
        slug: SLUG,
        name: 'H2 rooftop (simulated)',
        featureFlags: { adfLeadDelivery: true },
      },
      update: { featureFlags: { adfLeadDelivery: true } },
    });
    tenantId = tenant.id;
    locationId = (
      await ctx.prisma.location.upsert({
        where: { tenantId_slug: { tenantId, slug: 'main' } },
        create: { tenantId, slug: 'main', name: 'sfh2 main' },
        update: {},
      })
    ).id;
    const seeded = await seedSandboxRoutes(
      ctx.app.get(LeadDeliveryRouteService),
      [{ tenantId, locationId, slug: SLUG }],
      'cli:sfh2-e2e',
    );
    routeId = seeded[0].routeId;
    staffId = (
      await ctx.prisma.user.upsert({
        where: {
          tenantId_email: { tenantId, email: 'admin@sfh2-rooftop.test' },
        },
        create: {
          tenantId,
          email: 'admin@sfh2-rooftop.test',
          password: 'not-a-login',
          firstName: 'Sfh2',
          lastName: 'Admin',
          role: 'ADMIN',
        },
        update: {},
      })
    ).id;
    await ctx.prisma.consentRecord.deleteMany({ where: { tenantId } });
    await park();
  });
  beforeEach(async () => {
    await park();
    // Parking a due event strands its delivery by construction; settle those leftovers so each
    // test counts only the rows it creates.
    await deliveries.sweepBehindDeadOutbox({ tenantId });
    sink.clear();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await park();
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await ctx.app.close();
  });

  it('QUEUED row behind an abandoned event → DEAD, operator-visible and replayable (was: QUEUED forever, replay 409)', async () => {
    const d = await newDelivery();
    const after = await abandonOnNextClaim(d.id);
    expect(await outboxOf(d.id)).toMatchObject({
      status: 'DEAD',
      attempts: OUTBOX_MAX_ATTEMPTS,
      lastError: 'abandoned_after_repeated_lease_expiry',
    });
    expect(after).toMatchObject({
      status: 'DEAD',
      lastErrorCode: OUTBOX_ABANDONED_CODE,
    });
    expect(after.deadAt).not.toBeNull();
    expect(await history(d.id)).toEqual([
      'QUEUED:enqueued',
      `DEAD:${OUTBOX_ABANDONED_CODE}`,
    ]);
    expect(sinkFor(d.id)).toHaveLength(0);

    // replay is now possible and delivers exactly once
    await deliveries.replay(scope(), d.id, staffId);
    expect((await runWorker(d.id)).status).toBe('ACCEPTED');
    expect(sinkFor(d.id)).toHaveLength(1);
  });

  it('SENT row with no outcome (crashed hand-off) behind an abandoned event → DEAD and replayable', async () => {
    const d = await newDelivery();
    await crashedSent(d.id);
    const after = await abandonOnNextClaim(d.id);
    expect(after).toMatchObject({
      status: 'DEAD',
      lastErrorCode: OUTBOX_ABANDONED_CODE,
    });
    await deliveries.replay(scope(), d.id, staffId);
    expect((await row(d.id)).status).toBe('QUEUED');
  });

  it('accepted-but-unrecorded row is FINALISED to ACCEPTED from its stored receipt — never dead-lettered, never re-sent', async () => {
    const d = await newDelivery();
    await acceptedUnrecorded(d.id);
    const after = await abandonOnNextClaim(d.id);
    expect((await outboxOf(d.id)).status).toBe('DEAD');
    expect(after).toMatchObject({
      status: 'ACCEPTED',
      providerName: 'sandbox-sink',
      providerMessageId: `sink-stored-${d.id}`,
      lastErrorCode: null,
      deadAt: null,
    });
    expect(await history(d.id)).toEqual([
      'QUEUED:enqueued',
      'ACCEPTED:transport_receipt',
    ]);
    // nothing was handed to a transport by the abandon path
    expect(sinkFor(d.id)).toHaveLength(0);
  });

  it('a throwing abandon hook cannot loop: the event stays DEAD, the batch goes on, and the sweep settles the row', async () => {
    const d = await newDelivery();
    const other = await newDelivery();
    const hook = jest
      .spyOn(deliveries, 'settleBehindDeadOutbox')
      .mockRejectedValueOnce(new Error('simulated hook failure'));
    const ev = await outboxOf(d.id);
    await ctx.prisma.outboxEvent.update({
      where: { id: (await outboxOf(other.id)).id },
      data: { nextAttemptAt: new Date(0) },
    });
    await expect(abandonOnNextClaim(d.id)).resolves.toMatchObject({
      status: 'QUEUED',
    });
    expect(hook).toHaveBeenCalledTimes(1);
    // the other event in the same batch was still processed
    expect((await row(other.id)).status).toBe('ACCEPTED');
    // further worker runs never touch the dead event again
    await processor.processBatch(500, 'sfh2-e2e');
    await processor.processBatch(500, 'sfh2-e2e');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(
      await ctx.prisma.outboxEvent.findUniqueOrThrow({ where: { id: ev.id } }),
    ).toMatchObject({ status: 'DEAD', attempts: OUTBOX_MAX_ATTEMPTS });

    // defensive sweep: a delivery can never sit in QUEUED behind a DEAD event
    expect(await deliveries.sweepBehindDeadOutbox({ tenantId })).toBe(1);
    expect(await row(d.id)).toMatchObject({
      status: 'DEAD',
      lastErrorCode: OUTBOX_DEAD_SWEEP_CODE,
    });
    expect(await deliveries.sweepBehindDeadOutbox({ tenantId })).toBe(0);
  });

  it('sweep: QUEUED/SENT/FAILED behind a DEAD event are settled; accepted-unrecorded is finalised; settled rows are left alone', async () => {
    const done = await newDelivery();
    expect((await runWorker(done.id)).status).toBe('ACCEPTED');
    const queued = await newDelivery();
    const sent = await newDelivery();
    const pendingAccept = await newDelivery();
    const live = await newDelivery(); // QUEUED with a live (PENDING) event: not stranded
    await crashedSent(sent.id);
    await acceptedUnrecorded(pendingAccept.id);
    for (const d of [queued, sent, pendingAccept])
      await ctx.prisma.outboxEvent.update({
        where: { id: (await outboxOf(d.id)).id },
        data: { status: 'DEAD', lastError: 'simulated' },
      });
    sink.clear();

    expect(await deliveries.sweepBehindDeadOutbox({ tenantId })).toBe(3);
    expect((await row(queued.id)).status).toBe('DEAD');
    expect((await row(sent.id)).status).toBe('DEAD');
    expect(await row(pendingAccept.id)).toMatchObject({
      status: 'ACCEPTED',
      providerMessageId: `sink-stored-${pendingAccept.id}`,
    });
    expect((await row(done.id)).status).toBe('ACCEPTED');
    expect((await row(live.id)).status).toBe('QUEUED');
    expect(sink.messages()).toHaveLength(0); // the sweep never sends
    expect(
      await ctx.prisma.leadDelivery.count({
        where: {
          tenantId,
          status: { in: ['QUEUED', 'SENT', 'FAILED'] },
          id: { in: [queued.id, sent.id, pendingAccept.id] },
        },
      }),
    ).toBe(0);
  });

  it('the abandon hook is registered for the real ADF topic', () => {
    expect(processor.hasHandler(LEAD_DELIVERY_TOPIC)).toBe(true);
    expect(
      (
        processor as unknown as { abandonHandlers: Map<string, unknown> }
      ).abandonHandlers.has(LEAD_DELIVERY_TOPIC),
    ).toBe(true);
  });
});
