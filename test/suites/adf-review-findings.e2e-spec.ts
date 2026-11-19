import { Prisma } from '@prisma/client';
import { createE2eApp, E2eCtx } from '../helpers/e2e-app';
import { OutboxProcessorService } from '../../src/integrations/core/outbox-processor.service';
import {
  ACCEPT_RECORD_PENDING,
  LeadDeliveryService,
} from '../../src/integrations/adf/lead-delivery.service';
import { LeadDeliveryRouteService } from '../../src/integrations/adf/lead-delivery-route.service';
import { SandboxSinkTransport } from '../../src/integrations/adf/transports/sandbox-sink.transport';
import { seedSandboxRoutes } from '../../src/integrations/adf/sandbox-routes.seed';
import { ConsentService } from '../../src/messaging/consent.service';

/**
 * Regression tests for the PR #55 review findings on ADF lead delivery (R1–R4, R9, R11, R14).
 * Real API module, Postgres, durable outbox, in-process sandbox sink and the loopback mock SMTP.
 * Two SIMULATED rooftops; every address is a reserved *.example.invalid mailbox and every
 * customer is synthetic (555-01xx phones).
 */
const SMTP_API = process.env.MOCK_SMTP_API_URL || 'http://127.0.0.1:18085';
const SMTP_PORT = process.env.MOCK_SMTP_PORT || '11025';
const ENV_KEYS = [
  'NODE_ENV',
  'OUTBOX_PROCESSOR_ENABLED',
  'ADF_SEND_ENABLED',
  'LEAD_DELIVERY_MODE',
  'ADF_SANDBOX_TRANSPORT',
  'ADF_SMTP_HOST',
  'ADF_SMTP_PORT',
  'ADF_SEND_DEADLINE_MS',
] as const;
const KEYS = ['one', 'two'] as const;
type Key = (typeof KEYS)[number];

describe('ADF lead delivery — review findings (R1–R4, R9, R11, R14)', () => {
  let ctx: E2eCtx;
  let deliveries: LeadDeliveryService;
  let routes: LeadDeliveryRouteService;
  let processor: OutboxProcessorService;
  let sink: SandboxSinkTransport;
  const prev: Record<string, string | undefined> = {};
  const ids = {} as Record<
    Key,
    { tenantId: string; locationId: string; routeId: string; address: string }
  >;
  let staffId = '';
  let seq = 0;
  const run = `${Date.now().toString(36)}`;
  const smtp = {
    clear: () => fetch(`${SMTP_API}/messages`, { method: 'DELETE' }),
    mode: (mode: string, count?: number, delayMs?: number) =>
      fetch(`${SMTP_API}/mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, count, delayMs }),
      }),
    messages: async () =>
      (
        (await (await fetch(`${SMTP_API}/messages`)).json()) as {
          messages: Array<{ from: string; to: string[]; raw: string }>;
        }
      ).messages,
  };

  /** A synthetic lead with a contact pair unique to this test run. */
  const newLead = async (
    k: Key,
    over: Prisma.LeadUncheckedCreateInput | object = {},
  ) => {
    seq += 1;
    return ctx.prisma.lead.create({
      data: {
        tenantId: ids[k].tenantId,
        locationId: ids[k].locationId,
        firstName: 'Synthetic',
        lastName: `Reviewer${seq}`,
        email: `adfr-${k}-${run}-${seq}@example.invalid`,
        phone: `+1312555${String(100 + ((seq * 7 + run.length) % 100)).padStart(4, '0')}`,
        source: 'widget',
        ...over,
      },
    });
  };
  const submit = async (k: Key, leadId: string) => {
    await deliveries.enqueueForLead(ids[k].tenantId, leadId);
    return ctx.prisma.leadDelivery.findFirst({ where: { leadId } });
  };
  const row = (id: string) =>
    ctx.prisma.leadDelivery.findUniqueOrThrow({ where: { id } });
  const outboxOf = async (deliveryId: string) =>
    ctx.prisma.outboxEvent.findUniqueOrThrow({
      where: { id: (await row(deliveryId)).outboxEventId as string },
    });
  /** Make the delivery's outbox event due now, then run the worker until it was attempted. */
  const attempt = async (deliveryId: string) => {
    const before = await outboxOf(deliveryId);
    await ctx.prisma.outboxEvent.update({
      where: { id: before.id },
      data: { nextAttemptAt: new Date(0) },
    });
    for (let i = 0; i < 20; i += 1) {
      await processor.processBatch(500, 'adfr-e2e');
      const now = await ctx.prisma.outboxEvent.findUniqueOrThrow({
        where: { id: before.id },
      });
      if (now.status !== 'PENDING' || now.attempts > before.attempts) break;
    }
    return row(deliveryId);
  };
  const sinkFor = (deliveryId: string) =>
    sink.messages().filter((m) => m.deliveryId === deliveryId);
  const history = async (deliveryId: string) =>
    (
      await ctx.prisma.leadDeliveryEvent.findMany({
        where: { deliveryId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((h) => `${h.toStatus}:${h.reasonCode}`);

  /** Never leave a due event behind for another suite's worker run (shared test database). */
  const retireOutbox = () =>
    ctx.prisma.outboxEvent.updateMany({
      where: {
        tenantId: { in: KEYS.map((k) => ids[k].tenantId) },
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      data: { status: 'DEAD', lastError: 'test_suite_cleanup' },
    });

  beforeAll(async () => {
    for (const k of ENV_KEYS) prev[k] = process.env[k];
    process.env.OUTBOX_PROCESSOR_ENABLED = 'false';
    process.env.ADF_SEND_ENABLED = 'true';
    process.env.LEAD_DELIVERY_MODE = 'sandbox';
    process.env.ADF_SANDBOX_TRANSPORT = 'sink';
    process.env.ADF_SMTP_HOST = '127.0.0.1';
    process.env.ADF_SMTP_PORT = SMTP_PORT;

    ctx = await createE2eApp();
    deliveries = ctx.app.get(LeadDeliveryService);
    routes = ctx.app.get(LeadDeliveryRouteService);
    processor = ctx.app.get(OutboxProcessorService);
    sink = ctx.app.get(SandboxSinkTransport);

    for (const k of KEYS) {
      const slug = `adfr-${k}`;
      const tenant = await ctx.prisma.tenant.upsert({
        where: { slug },
        create: {
          slug,
          name: `Review rooftop ${k} (simulated)`,
          featureFlags: { adfLeadDelivery: true },
        },
        update: { featureFlags: { adfLeadDelivery: true } },
      });
      const loc = await ctx.prisma.location.upsert({
        where: { tenantId_slug: { tenantId: tenant.id, slug: 'main' } },
        create: { tenantId: tenant.id, slug: 'main', name: `${slug} main` },
        update: {},
      });
      ids[k] = {
        tenantId: tenant.id,
        locationId: loc.id,
        routeId: '',
        address: '',
      };
    }
    const seeded = await seedSandboxRoutes(
      routes,
      KEYS.map((k) => ({
        tenantId: ids[k].tenantId,
        locationId: ids[k].locationId,
        slug: `adfr-${k}`,
      })),
      'cli:adfr-e2e',
    );
    for (const k of KEYS) {
      const s = seeded.find((x) => x.slug === `adfr-${k}`)!;
      ids[k].routeId = s.routeId;
      ids[k].address = s.address;
    }
    staffId = (
      await ctx.prisma.user.upsert({
        where: {
          tenantId_email: {
            tenantId: ids.one.tenantId,
            email: 'admin@adfr-one.test',
          },
        },
        create: {
          tenantId: ids.one.tenantId,
          email: 'admin@adfr-one.test',
          password: 'not-a-login',
          firstName: 'Adfr',
          lastName: 'Admin',
          role: 'ADMIN',
        },
        update: {},
      })
    ).id;
    await retireOutbox();
    // Synthetic 555-01xx numbers repeat between runs: start from an empty ledger.
    await ctx.prisma.consentRecord.deleteMany({
      where: { tenantId: { in: KEYS.map((k) => ids[k].tenantId) } },
    });
    await smtp.mode('none');
    await smtp.clear();
  });

  afterAll(async () => {
    await retireOutbox();
    await smtp.mode('none');
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await ctx.app.close();
  });

  beforeEach(() => {
    process.env.NODE_ENV = prev.NODE_ENV ?? 'test';
    process.env.ADF_SEND_ENABLED = 'true';
    process.env.LEAD_DELIVERY_MODE = 'sandbox';
    process.env.ADF_SANDBOX_TRANSPORT = 'sink';
    delete process.env.ADF_SEND_DEADLINE_MS;
    sink.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ───────────────────────────────────────── R1: consent comes from the ledger

  describe('R1 — the consent gate and the ADF consent summary follow the consent ledger', () => {
    const scope = (k: Key) => ({ tenantId: ids[k].tenantId, locationId: null });
    const ledger = (
      k: Key,
      channel: 'SMS' | 'EMAIL' | 'CALL',
      endpoint: string,
      granted: boolean,
      evidence: object = {},
    ) =>
      ctx.app.get(ConsentService).record({
        tenantId: ids[k].tenantId,
        channel,
        endpoint,
        purpose: 'CONVERSATIONAL',
        granted,
        source: granted ? 'WIDGET' : 'SMS_KEYWORD',
        evidence,
      });
    const consentLine = (deliveryId: string) =>
      /Consent: [^;\n<]*/.exec(sinkFor(deliveryId)[0].xml)?.[0];

    it('a customer opted out on every channel is BLOCKED no_consent_basis; nothing is sent; replay re-checks the ledger', async () => {
      const lead = await newLead('one', { consentToText: true });
      await ledger('one', 'EMAIL', lead.email!, false);
      await ledger('one', 'SMS', lead.phone!, false, { keyword: 'STOP' });
      await ledger('one', 'CALL', lead.phone!, false);
      const d = await attempt((await submit('one', lead.id))!.id);
      expect(d).toMatchObject({
        status: 'BLOCKED',
        blockedReason: 'no_consent_basis',
        attempts: 0,
      });
      expect(sinkFor(d.id)).toHaveLength(0);

      // Replay with the opt-outs still standing: blocked again, still nothing sent.
      await deliveries.replay(scope('one'), d.id, staffId);
      expect(await attempt(d.id)).toMatchObject({
        status: 'BLOCKED',
        blockedReason: 'no_consent_basis',
      });
      expect(sinkFor(d.id)).toHaveLength(0);

      // The customer opts back in to calls: the next replay goes out, truthfully summarised.
      await ledger('one', 'CALL', lead.phone!, true);
      await deliveries.replay(scope('one'), d.id, staffId);
      expect((await attempt(d.id)).status).toBe('ACCEPTED');
      expect(consentLine(d.id)).toBe('Consent: text=no, email=no, call=yes');
    });

    it('an explicit do-not-contact on the ledger blocks even when another channel has no opt-out', async () => {
      const lead = await newLead('one');
      await ledger('one', 'SMS', lead.phone!, false, { scope: 'ALL' });
      const d = await attempt((await submit('one', lead.id))!.id);
      expect(d).toMatchObject({
        status: 'BLOCKED',
        blockedReason: 'no_consent_basis',
      });
      expect(sinkFor(d.id)).toHaveLength(0);
    });

    it('a text-only STOP does not block the CRM hand-off but is never reported as consent to text', async () => {
      // Lead.consentToText is still true — the ledger STOP is newer and must win.
      const lead = await newLead('one', { consentToText: true });
      await ledger('one', 'SMS', lead.phone!, true);
      await ledger('one', 'SMS', lead.phone!, false, { keyword: 'STOP' });
      await ledger('one', 'EMAIL', lead.email!, true);
      const d = await attempt((await submit('one', lead.id))!.id);
      expect(d.status).toBe('ACCEPTED');
      expect(consentLine(d.id)).toBe(
        'Consent: text=no, email=yes, call=not recorded',
      );
      // …and the number is not labelled as a textable cellphone.
      expect(sinkFor(d.id)[0].xml).not.toContain('type="cellphone"');
    });

    it("the ledger is tenant-scoped: another rooftop's opt-out for the same contact does not apply", async () => {
      const lead = await newLead('two');
      for (const [c, e] of [
        ['EMAIL', lead.email!],
        ['SMS', lead.phone!],
        ['CALL', lead.phone!],
      ] as const)
        await ledger('one', c, e, false);
      const d = await attempt((await submit('two', lead.id))!.id);
      expect(d.status).toBe('ACCEPTED');
      expect(consentLine(d.id)).toBe(
        'Consent: text=not recorded, email=not recorded, call=not recorded',
      );
    });
  });

  // ───────────────────────────────────────── R2: no duplicate send after a DB error

  describe('R2 — a failure recording the acknowledgement never causes a second send', () => {
    it('ACCEPTED write fails ⇒ row stays SENT "accepted_record_pending" with the receipt; the retry finalises without sending', async () => {
      const lead = await newLead('one');
      const d = (await submit('one', lead.id))!;
      // The transport accepts, then every transaction (the ACCEPTED write) fails.
      const tx = jest
        .spyOn(ctx.prisma, '$transaction')
        .mockRejectedValue(new Error('simulated database outage'));
      const first = await attempt(d.id);
      // Retried a few times before giving up (other due events in a shared DB may add calls).
      expect(tx.mock.calls.length).toBeGreaterThanOrEqual(3);
      tx.mockRestore();

      expect(sinkFor(d.id)).toHaveLength(1);
      expect(first).toMatchObject({
        status: 'SENT',
        attempts: 1,
        lastErrorCode: ACCEPT_RECORD_PENDING,
        providerName: 'sandbox-sink',
        failedAt: null,
      });
      expect(first.providerMessageId).toMatch(/^sink-/);
      const ev = await outboxOf(d.id);
      expect(ev).toMatchObject({
        status: 'PENDING',
        lastError: ACCEPT_RECORD_PENDING,
      });

      const second = await attempt(d.id);
      expect(second).toMatchObject({
        status: 'ACCEPTED',
        attempts: 1,
        lastErrorCode: null,
        providerMessageId: first.providerMessageId,
      });
      expect(sinkFor(d.id)).toHaveLength(1); // exactly one hand-off, ever
      expect(await history(d.id)).toEqual([
        'QUEUED:enqueued',
        'SENT:transport_handoff',
        'ACCEPTED:transport_receipt',
      ]);
      expect((await outboxOf(d.id)).status).toBe('PUBLISHED');
    });

    it('a pending-accept row is never reclaimed as a stale SENT row, however old it is', async () => {
      const lead = await newLead('one');
      const d = (await submit('one', lead.id))!;
      const tx = jest
        .spyOn(ctx.prisma, '$transaction')
        .mockRejectedValue(new Error('simulated database outage'));
      await attempt(d.id);
      tx.mockRestore();
      // Age the row far past the stale-SENT window.
      await ctx.prisma
        .$executeRaw`UPDATE "LeadDelivery" SET "updatedAt" = NOW() - interval '1 day' WHERE "id" = ${d.id}`;
      const after = await attempt(d.id);
      expect(after).toMatchObject({ status: 'ACCEPTED', attempts: 1 });
      expect(sinkFor(d.id)).toHaveLength(1);
    });

    it('receipt cannot be stored at all (DB down) ⇒ remembered in-process; the next attempt finalises without sending', async () => {
      const lead = await newLead('two');
      const d = (await submit('two', lead.id))!;
      const tx = jest
        .spyOn(ctx.prisma, '$transaction')
        .mockRejectedValue(new Error('simulated database outage'));
      const realUpdateMany = ctx.prisma.leadDelivery.updateMany.bind(
        ctx.prisma.leadDelivery,
      );
      let calls = 0;
      const um = jest
        .spyOn(ctx.prisma.leadDelivery, 'updateMany')
        .mockImplementation(((args: Prisma.LeadDeliveryUpdateManyArgs) => {
          calls += 1;
          // 1st call = the QUEUED→SENT claim; everything after the send fails.
          if (calls === 1) return realUpdateMany(args);
          return Promise.reject(new Error('simulated database outage'));
        }) as never);
      const first = await attempt(d.id);
      tx.mockRestore();
      um.mockRestore();
      expect(sinkFor(d.id)).toHaveLength(1);
      expect(first).toMatchObject({ status: 'SENT', failedAt: null });

      const second = await attempt(d.id);
      expect(second).toMatchObject({ status: 'ACCEPTED', attempts: 1 });
      expect(second.providerMessageId).toMatch(/^sink-/);
      expect(sinkFor(d.id)).toHaveLength(1);
    });

    it('lost compare-and-set: row already ACCEPTED ⇒ no error; row already FAILED ⇒ the late receipt is recorded', async () => {
      const realSend = sink.send.bind(sink);
      // (a) another worker recorded the acknowledgement first.
      const a = (await submit('one', (await newLead('one')).id))!;
      jest.spyOn(sink, 'send').mockImplementationOnce(async (m) => {
        const r = await realSend(m);
        await ctx.prisma.leadDelivery.update({
          where: { id: a.id },
          data: {
            status: 'ACCEPTED',
            providerName: 'other-worker',
            providerMessageId: 'other-worker-1',
            acceptedAt: new Date(),
          },
        });
        return r;
      });
      const ra = await attempt(a.id);
      expect(ra).toMatchObject({
        status: 'ACCEPTED',
        providerName: 'other-worker',
      });
      expect(await outboxOf(a.id)).toMatchObject({
        status: 'PUBLISHED',
        lastError: 'accepted:already_recorded',
      });

      // (b) another attempt marked it FAILED while this one was being acknowledged.
      const b = (await submit('one', (await newLead('one')).id))!;
      jest.spyOn(sink, 'send').mockImplementationOnce(async (m) => {
        const r = await realSend(m);
        await ctx.prisma.leadDelivery.update({
          where: { id: b.id },
          data: { status: 'FAILED', lastErrorCode: 'smtp_error' },
        });
        return r;
      });
      const rb = await attempt(b.id);
      expect(rb).toMatchObject({
        status: 'ACCEPTED',
        providerName: 'sandbox-sink',
        lastErrorCode: null,
      });
      expect((await history(b.id)).pop()).toBe(
        'ACCEPTED:late_transport_receipt',
      );
      // Acknowledged ⇒ a further run never sends again.
      await ctx.prisma.outboxEvent.update({
        where: { id: rb.outboxEventId as string },
        data: { status: 'PENDING' },
      });
      await attempt(b.id);
      expect(sinkFor(b.id)).toHaveLength(1);
    });
  });
});
