import request from 'supertest';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { OutboxProcessorService } from '../../src/integrations/core/outbox-processor.service';
import { LeadDeliveryService } from '../../src/integrations/adf/lead-delivery.service';
import { LeadDeliveryRouteService } from '../../src/integrations/adf/lead-delivery-route.service';
import { SandboxSinkTransport } from '../../src/integrations/adf/transports/sandbox-sink.transport';
import { seedSandboxRoutes } from '../../src/integrations/adf/sandbox-routes.seed';
import { LeadFunnelService } from '../../src/operations/funnel/lead-funnel.service';
import { GroupOverviewService } from '../../src/dealer-groups/overview/group-overview.service';
import {
  capabilityMatrix,
  CapabilityEvidence,
} from '../../src/dealer-groups/overview/capability-matrix';

/**
 * Security review M4 — environment tiering.
 *  (a) a sandbox transport never takes a PRODUCTION-environment route;
 *  (b) "real / live" in the funnel and the capability matrix requires deliveryMode = 'live';
 *  (c) the deployment tier (not NODE_ENV alone) decides the sandbox refusals: hosted staging
 *      (NODE_ENV=production + DEPLOYMENT_TIER=staging) may use the sandbox for SANDBOX routes.
 * Real API module + Postgres + outbox + in-process sink. Synthetic data only; the
 * PRODUCTION-environment route in this suite still points at a reserved example.invalid mailbox.
 */
const ENV_KEYS = [
  'NODE_ENV',
  'DEPLOYMENT_TIER',
  'OUTBOX_PROCESSOR_ENABLED',
  'ADF_SEND_ENABLED',
  'LEAD_DELIVERY_MODE',
  'ADF_SANDBOX_TRANSPORT',
  'ADF_SANDBOX_SINK_DIR',
] as const;
const SLUG = 'sfm4-tier';

describe('M4 deployment tier, sandbox refusals and the "real delivery" predicate', () => {
  let ctx: E2eCtx;
  let deliveries: LeadDeliveryService;
  let processor: OutboxProcessorService;
  let sink: SandboxSinkTransport;
  let funnels: LeadFunnelService;
  let overview: GroupOverviewService;
  const prev: Record<string, string | undefined> = {};
  let tenantId = '';
  let locationId = '';
  let routeId = '';
  let staffId = '';
  let seq = 0;
  const run = Date.now().toString(36);
  const scope = () => ({ tenantId, locationId: null });

  const tier = (
    env: { NODE_ENV: string; DEPLOYMENT_TIER?: string },
    fn: () => Promise<void>,
  ) => {
    const before = {
      n: process.env.NODE_ENV,
      t: process.env.DEPLOYMENT_TIER,
    };
    process.env.NODE_ENV = env.NODE_ENV;
    if (env.DEPLOYMENT_TIER) process.env.DEPLOYMENT_TIER = env.DEPLOYMENT_TIER;
    else delete process.env.DEPLOYMENT_TIER;
    return fn().finally(() => {
      process.env.NODE_ENV = before.n;
      if (before.t === undefined) delete process.env.DEPLOYMENT_TIER;
      else process.env.DEPLOYMENT_TIER = before.t;
    });
  };
  /** Create a synthetic lead, queue its delivery and run the worker once. */
  const deliver = async () => {
    seq += 1;
    const lead = await ctx.prisma.lead.create({
      data: {
        tenantId,
        locationId,
        firstName: 'Synthetic',
        lastName: `Tier${seq}`,
        email: `sfm4-${run}-${seq}@example.invalid`,
        phone: `+1312555${String(100 + (seq % 100)).padStart(4, '0')}`,
        source: 'widget',
      },
    });
    await deliveries.enqueueForLead(tenantId, lead.id);
    const d = await ctx.prisma.leadDelivery.findFirstOrThrow({
      where: { leadId: lead.id },
    });
    await ctx.prisma.outboxEvent.update({
      where: { id: d.outboxEventId as string },
      data: { nextAttemptAt: new Date(0) },
    });
    await processor.processBatch(500, 'sfm4-e2e');
    return ctx.prisma.leadDelivery.findUniqueOrThrow({ where: { id: d.id } });
  };
  const sinkFor = (deliveryId: string) =>
    sink.messages().filter((m) => m.deliveryId === deliveryId);
  const stage = async (name: string) =>
    (await funnels.funnel(scope(), 7)).stages.find((s) => s.stage === name)!
      .count;
  const evidence = async (): Promise<CapabilityEvidence> => {
    const t = await ctx.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { id: true, allowedOrigins: true, featureFlags: true },
    });
    return (
      overview as unknown as {
        evidence(x: typeof t): Promise<CapabilityEvidence>;
      }
    ).evidence(t);
  };
  const park = () =>
    ctx.prisma.outboxEvent.updateMany({
      where: { tenantId, status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: 'DEAD', lastError: 'test_suite_cleanup' },
    });

  beforeAll(async () => {
    for (const k of ENV_KEYS) prev[k] = process.env[k];
    process.env.OUTBOX_PROCESSOR_ENABLED = 'false';
    process.env.ADF_SEND_ENABLED = 'true';
    process.env.LEAD_DELIVERY_MODE = 'sandbox';
    process.env.ADF_SANDBOX_TRANSPORT = 'sink';
    delete process.env.ADF_SANDBOX_SINK_DIR;
    delete process.env.DEPLOYMENT_TIER;
    ctx = await createE2eApp();
    deliveries = ctx.app.get(LeadDeliveryService);
    processor = ctx.app.get(OutboxProcessorService);
    sink = ctx.app.get(SandboxSinkTransport);
    funnels = ctx.app.get(LeadFunnelService);
    overview = ctx.app.get(GroupOverviewService);
    const tenant = await ctx.prisma.tenant.upsert({
      where: { slug: SLUG },
      create: {
        slug: SLUG,
        name: 'M4 rooftop (simulated)',
        featureFlags: { adfLeadDelivery: true },
      },
      update: { featureFlags: { adfLeadDelivery: true } },
    });
    tenantId = tenant.id;
    locationId = (
      await ctx.prisma.location.upsert({
        where: { tenantId_slug: { tenantId, slug: 'main' } },
        create: { tenantId, slug: 'main', name: 'sfm4 main' },
        update: {},
      })
    ).id;
    // Clean slate (counts below are exact).
    await ctx.prisma.leadDelivery.deleteMany({ where: { tenantId } });
    await ctx.prisma.lead.deleteMany({ where: { tenantId } });
    await ctx.prisma.leadDeliveryRoute.deleteMany({ where: { tenantId } });
    await ctx.prisma.consentRecord.deleteMany({ where: { tenantId } });
    const seeded = await seedSandboxRoutes(
      ctx.app.get(LeadDeliveryRouteService),
      [{ tenantId, locationId, slug: SLUG }],
      'cli:sfm4-e2e',
    );
    routeId = seeded[0].routeId;
    staffId = (
      await ctx.prisma.user.upsert({
        where: { tenantId_email: { tenantId, email: 'admin@sfm4-tier.test' } },
        create: {
          tenantId,
          email: 'admin@sfm4-tier.test',
          password: 'not-a-login',
          firstName: 'Sfm4',
          lastName: 'Admin',
          role: 'ADMIN',
        },
        update: {},
      })
    ).id;
    await park();
  });
  beforeEach(async () => {
    await park();
    sink.clear();
  });
  afterAll(async () => {
    await park();
    await deliveries.sweepBehindDeadOutbox({ tenantId });
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await ctx.app.close();
  });

  it('GET /api/version exposes the resolved deployment tier (read-only)', async () => {
    const r = await request(ctx.app.getHttpServer()).get('/api/version');
    expect(r.status).toBe(200);
    expect(unwrap<{ deploymentTier: string }>(r.body).deploymentTier).toBe(
      'test',
    );
  });

  describe('SANDBOX route', () => {
    it('test tier: delivered by the sink as before (deliveryMode = sandbox)', async () => {
      const d = await deliver();
      expect(d).toMatchObject({ status: 'ACCEPTED', deliveryMode: 'sandbox' });
      expect(sinkFor(d.id)).toHaveLength(1);
    });

    it('production tier (NODE_ENV=production, tier unset or production): refused, unchanged', async () => {
      for (const DEPLOYMENT_TIER of [undefined, 'production'])
        await tier({ NODE_ENV: 'production', DEPLOYMENT_TIER }, async () => {
          const d = await deliver();
          expect(d).toMatchObject({
            status: 'BLOCKED',
            blockedReason: 'sandbox_in_production',
          });
          expect(sinkFor(d.id)).toHaveLength(0);
        });
    });

    it('hosted staging (NODE_ENV=production + DEPLOYMENT_TIER=staging): sandbox sink allowed; metadata only, never live', async () => {
      await tier(
        { NODE_ENV: 'production', DEPLOYMENT_TIER: 'staging' },
        async () => {
          process.env.LEAD_DELIVERY_MODE = 'live'; // even if someone asks for live
          try {
            const d = await deliver();
            expect(d).toMatchObject({
              status: 'ACCEPTED',
              deliveryMode: 'sandbox',
              providerName: 'sandbox-sink',
            });
            const [rec] = sinkFor(d.id);
            expect(rec.to).toMatch(/example\.invalid$/);
            // no customer data is held by a hosted deployment's sink
            expect(rec.xml).toBe('');
            expect(rec.raw).toBe('');
          } finally {
            process.env.LEAD_DELIVERY_MODE = 'sandbox';
          }
        },
      );
    });

    it('an invalid tier combination fails closed at runtime (treated as production)', async () => {
      await tier(
        { NODE_ENV: 'production', DEPLOYMENT_TIER: 'development' },
        async () => {
          const d = await deliver();
          expect(d).toMatchObject({
            status: 'BLOCKED',
            blockedReason: 'sandbox_in_production',
          });
          expect(sinkFor(d.id)).toHaveLength(0);
        },
      );
    });
  });

  describe('PRODUCTION-environment route outside the production tier', () => {
    let historicId = '';

    beforeAll(async () => {
      // One delivery acknowledged by the SANDBOX sink and (wrongly) reconciled as CRM-matched…
      await park();
      const d = await deliver();
      expect(d).toMatchObject({ status: 'ACCEPTED', deliveryMode: 'sandbox' });
      await deliveries.reconcile(
        scope(),
        d.id,
        { result: 'CRM_MATCHED', crmRecordRef: 'CRM-SYNTH-1' },
        staffId,
      );
      historicId = d.id;
      // …then the route becomes a PRODUCTION-environment, production-enabled route. This is the
      // state the finding describes: PRODUCTION route, hand-off made by a sandbox transport.
      await ctx.prisma.leadDeliveryRoute.update({
        where: { id: routeId },
        data: { environment: 'PRODUCTION', productionEnabled: true },
      });
    });

    it('(a) test tier: refused outright with a distinct reason; nothing written to the sink', async () => {
      const d = await deliver();
      expect(d).toMatchObject({
        status: 'BLOCKED',
        blockedReason: 'production_route_in_sandbox',
        attempts: 0,
        deliveryMode: null,
      });
      expect(sinkFor(d.id)).toHaveLength(0);
      expect(sink.messages()).toHaveLength(0);
    });

    it('(a) hosted staging: refused the same way, sink untouched, no file written', async () => {
      const dir = `${process.cwd()}/.tmp-sfm4-sink-${process.pid}`;
      process.env.ADF_SANDBOX_SINK_DIR = dir;
      try {
        await tier(
          { NODE_ENV: 'production', DEPLOYMENT_TIER: 'staging' },
          async () => {
            const d = await deliver();
            expect(d).toMatchObject({
              status: 'BLOCKED',
              blockedReason: 'production_route_in_sandbox',
            });
            expect(sink.messages()).toHaveLength(0);
          },
        );
        expect((require('fs') as typeof import('fs')).existsSync(dir)).toBe(
          false,
        );
      } finally {
        delete process.env.ADF_SANDBOX_SINK_DIR;
      }
    });

    it('(b) funnel: a sandbox acknowledgement on a PRODUCTION route is never "mail accepted" / "CRM matched"', async () => {
      expect(await stage('MAIL_ACCEPTED')).toBe(0);
      expect(await stage('CRM_RECEIVED')).toBe(0);
      expect(await stage('CRM_MATCHED')).toBe(0);
      const f = await funnels.funnel(scope(), 7);
      expect(f.notProven.mailAcceptedSandboxOnly).toBeGreaterThanOrEqual(1);
    });

    it('(b) capability matrix: it is never LIVE VERIFIED evidence', async () => {
      const e = await evidence();
      expect(e.deliveries).toMatchObject({
        acceptedOnProductionRoute: 0,
        crmMatchedOnProductionRoute: 0,
      });
      expect(e.deliveries.acceptedOnSandboxRoute).toBeGreaterThanOrEqual(1);
      const m = capabilityMatrix(e);
      expect(JSON.stringify(m)).not.toContain('LIVE VERIFIED');
    });

    it('(b) control: the same row sent by the LIVE transport does count', async () => {
      await ctx.prisma.leadDelivery.update({
        where: { id: historicId },
        data: { deliveryMode: 'live' },
      });
      try {
        expect(await stage('MAIL_ACCEPTED')).toBe(1);
        expect(await stage('CRM_MATCHED')).toBe(1);
        const e = await evidence();
        expect(e.deliveries).toMatchObject({
          acceptedOnProductionRoute: 1,
          crmMatchedOnProductionRoute: 1,
        });
        expect(JSON.stringify(capabilityMatrix(e))).toContain('LIVE VERIFIED');
      } finally {
        await ctx.prisma.leadDelivery.update({
          where: { id: historicId },
          data: { deliveryMode: 'sandbox' },
        });
      }
    });
  });
});
