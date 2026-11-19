import { Prisma } from '@prisma/client';
import { createE2eApp, E2eCtx } from '../helpers/e2e-app';
import { OutboxProcessorService } from '../../src/integrations/core/outbox-processor.service';
import { OUTBOX_MAX_ATTEMPTS } from '../../src/integrations/core/outbox.service';
import {
  ACCEPT_RECORD_PENDING,
  LeadDeliveryService,
  SEND_DISPATCHED,
  stableLeadDeliveryMessageId,
} from '../../src/integrations/adf/lead-delivery.service';
import { LeadDeliveryRouteService } from '../../src/integrations/adf/lead-delivery-route.service';
import { SandboxSinkTransport } from '../../src/integrations/adf/transports/sandbox-sink.transport';
import { seedSandboxRoutes } from '../../src/integrations/adf/sandbox-routes.seed';
import { ConsentService } from '../../src/messaging/consent.service';
import { SmtpLeadTransport } from '../../src/integrations/adf/transports/smtp.transport';

/**
 * Regression tests for the PR #55 review findings on ADF lead delivery (R1–R4, R9, R11, R14, R15).
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

describe('ADF lead delivery — review findings (R1–R4, R9, R11, R14, R15)', () => {
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
  let staffTwo = '';
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
        tenant: { slug: { startsWith: 'adfr-' } },
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
    staffTwo = (
      await ctx.prisma.user.upsert({
        where: {
          tenantId_email: {
            tenantId: ids.two.tenantId,
            email: 'admin@adfr-two.test',
          },
        },
        create: {
          tenantId: ids.two.tenantId,
          email: 'admin@adfr-two.test',
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

  beforeEach(async () => {
    // Each test drives only its own deliveries through the worker.
    await retireOutbox();
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
      evidence: Record<string, unknown> = {},
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

  // ───────────────────────────────────────── R3: sandbox never stands in for live

  describe('R3 — production refuses the sandbox transports; a sandbox receipt never counts as live', () => {
    it('NODE_ENV=production + switch on + mode not live ⇒ BLOCKED sandbox_in_production, nothing in the sink or the mock SMTP', async () => {
      await smtp.clear();
      const mine = { tenantId: ids.one.tenantId };
      const made: string[] = [];
      for (const transport of ['sink', 'smtp']) {
        const d = (await submit('one', (await newLead('one')).id))!;
        made.push(d.id);
        process.env.NODE_ENV = 'production';
        delete process.env.LEAD_DELIVERY_MODE; // unset ⇒ not live
        process.env.ADF_SANDBOX_TRANSPORT = transport;
        const blocked = await attempt(d.id);
        process.env.NODE_ENV = 'test';
        expect(blocked).toMatchObject({
          status: 'BLOCKED',
          blockedReason: 'sandbox_in_production',
          attempts: 0,
          sentAt: null,
          acceptedAt: null,
          deliveryMode: null,
        });
      }
      expect(sink.messages()).toHaveLength(0);
      expect(await smtp.messages()).toHaveLength(0);

      // Re-evaluable: while the environment still refuses, the sweep leaves the rows alone…
      process.env.NODE_ENV = 'production';
      expect(await deliveries.reevaluateBlocked(mine)).toBe(0);
      process.env.NODE_ENV = 'test';
      // …and once it no longer does, they are queued again without an operator.
      process.env.ADF_SANDBOX_TRANSPORT = 'sink';
      // (≥: a re-used local database may hold rows from an earlier aborted run.)
      expect(await deliveries.reevaluateBlocked(mine)).toBeGreaterThanOrEqual(
        2,
      );
      for (const id of made) expect((await row(id)).status).toBe('QUEUED');
      for (const id of made) {
        const d = await row(id);
        expect(d.status === 'QUEUED' ? await attempt(id) : d).toMatchObject({
          status: 'ACCEPTED',
          deliveryMode: 'sandbox',
        });
        expect(await history(id)).toEqual([
          'QUEUED:enqueued',
          'BLOCKED:sandbox_in_production',
          'QUEUED:gate_reevaluation',
          'SENT:transport_handoff',
          'ACCEPTED:transport_receipt',
        ]);
      }
    });

    it('the transports themselves refuse a sandbox hand-off in production (defence in depth)', async () => {
      const msg = {
        deliveryId: 'd-r3',
        tenantId: ids.one.tenantId,
        routeId: ids.one.routeId,
        correlationId: 'c-r3',
        messageId: '<lead-delivery.d-r3@amqur.example.invalid>',
        from: 'adf-sandbox@amqur.example.invalid',
        to: ids.one.address,
        subject: 'New lead amqur-lead-r3',
        xml: '<adf/>',
        format: 'XML_BODY' as const,
        date: new Date(),
      };
      await smtp.clear();
      process.env.NODE_ENV = 'production';
      try {
        await expect(sink.send(msg)).rejects.toMatchObject({
          code: 'sandbox_in_production',
          retryable: false,
        });
        await expect(
          ctx.app.get(SmtpLeadTransport).send(msg, { live: false }),
        ).rejects.toMatchObject({ code: 'sandbox_in_production' });
      } finally {
        process.env.NODE_ENV = 'test';
      }
      expect(sink.messages()).toHaveLength(0);
      expect(await smtp.messages()).toHaveLength(0);
    });

    it('a sandbox-ACCEPTED row is not "acknowledged" once the environment is live: it is re-queued and faces the live gates', async () => {
      const lead = await newLead('two');
      const d = await attempt((await submit('two', lead.id))!.id);
      expect(d).toMatchObject({ status: 'ACCEPTED', deliveryMode: 'sandbox' });
      expect(sinkFor(d.id)).toHaveLength(1);
      // The operator ledger says which mode acknowledged it.
      expect(
        await deliveries.get(
          { tenantId: ids.two.tenantId, locationId: null },
          d.id,
        ),
      ).toMatchObject({ status: 'ACCEPTED', deliveryMode: 'sandbox' });

      await smtp.clear();
      process.env.NODE_ENV = 'production';
      process.env.LEAD_DELIVERY_MODE = 'live';
      try {
        // Next lead change in the live environment: the sandbox receipt does not suppress it.
        expect(
          await deliveries.enqueueForLead(ids.two.tenantId, lead.id),
        ).toEqual({ status: 'exists', deliveryId: d.id });
        const queued = await row(d.id);
        expect(queued).toMatchObject({
          status: 'QUEUED',
          providerMessageId: null,
          acceptedAt: null,
        });
        // The live gates now apply: this rooftop only has a SANDBOX route, so nothing is sent.
        expect(await attempt(d.id)).toMatchObject({
          status: 'BLOCKED',
          blockedReason: 'route_not_production_environment',
        });
      } finally {
        process.env.NODE_ENV = 'test';
        process.env.LEAD_DELIVERY_MODE = 'sandbox';
      }
      expect(sinkFor(d.id)).toHaveLength(1); // only the original sandbox record
      expect(await smtp.messages()).toHaveLength(0);

      // An operator replay does the same for a sandbox-acknowledged row, and is audited.
      const other = await attempt(
        (await submit('two', (await newLead('two')).id))!.id,
      );
      expect(other.status).toBe('ACCEPTED');
      const scope = { tenantId: ids.two.tenantId, locationId: null };
      // Not live: an acknowledged row is simply not replayable.
      await expect(
        deliveries.replay(scope, other.id, staffTwo),
      ).rejects.toMatchObject({ message: 'not_replayable:ACCEPTED' });
      process.env.NODE_ENV = 'production';
      process.env.LEAD_DELIVERY_MODE = 'live';
      try {
        expect(
          await deliveries.replay(scope, other.id, staffTwo),
        ).toMatchObject({ status: 'QUEUED' });
      } finally {
        process.env.NODE_ENV = 'test';
        process.env.LEAD_DELIVERY_MODE = 'sandbox';
      }
      expect(
        await ctx.prisma.auditLog.findFirst({
          where: {
            tenantId: ids.two.tenantId,
            action: 'lead_delivery.replay',
            resourceId: other.id,
          },
        }),
      ).toMatchObject({
        userId: staffTwo,
        metadata: { fromStatus: 'ACCEPTED', sandboxAckSuperseded: true },
      });
      expect(await history(d.id)).toEqual([
        'QUEUED:enqueued',
        'SENT:transport_handoff',
        'ACCEPTED:transport_receipt',
        'QUEUED:sandbox_ack_superseded',
        'BLOCKED:route_not_production_environment',
      ]);
    });
  });

  // ───────────────────────────────────────── R4: no stuck rows

  describe('R4 — a delivery row never gets stuck behind a dead outbox event', () => {
    /** Simulate a worker that crashed right after the hand-off: SENT, no outcome. */
    const crashedSent = async (deliveryId: string, age: string) => {
      await ctx.prisma.$executeRawUnsafe(
        `UPDATE "LeadDelivery" SET "status" = 'SENT', "sentAt" = NOW(), "attempts" = 1, "updatedAt" = NOW() - interval '${age}' WHERE "id" = $1`,
        deliveryId,
      );
    };
    const setFlag = (k: Key, on: boolean) =>
      ctx.prisma.tenant.update({
        where: { id: ids[k].tenantId },
        data: { featureFlags: { adfLeadDelivery: on } },
      });

    it('a STALE SENT row whose gate has since closed becomes BLOCKED (was: threw on every retry, stayed SENT)', async () => {
      const d = (await submit('two', (await newLead('two')).id))!;
      await crashedSent(d.id, '10 minutes');
      await setFlag('two', false);
      try {
        const after = await attempt(d.id);
        expect(after).toMatchObject({
          status: 'BLOCKED',
          blockedReason: 'flag_off',
        });
        expect(await outboxOf(d.id)).toMatchObject({
          status: 'PUBLISHED',
          lastError: 'blocked:flag_off',
        });
      } finally {
        await setFlag('two', true);
      }
      expect(sinkFor(d.id)).toHaveLength(0);
      // Terminal and replayable.
      await deliveries.replay(
        { tenantId: ids.two.tenantId, locationId: null },
        d.id,
        staffTwo,
      );
      expect((await attempt(d.id)).status).toBe('ACCEPTED');
    });

    it('a FRESH SENT row (another worker mid-send) is left alone when the gate closes', async () => {
      const d = (await submit('two', (await newLead('two')).id))!;
      await crashedSent(d.id, '1 second');
      await setFlag('two', false);
      try {
        expect((await attempt(d.id)).status).toBe('SENT');
        expect(await outboxOf(d.id)).toMatchObject({
          status: 'PENDING',
          lastError: 'delivery_in_flight',
        });
      } finally {
        await setFlag('two', true);
      }
    });

    it('whatever throws, the FINAL outbox attempt leaves the row DEAD (replayable), with a PII-free code', async () => {
      const lead = await newLead('two');
      const d = (await submit('two', lead.id))!;
      await ctx.prisma.outboxEvent.update({
        where: { id: d.outboxEventId as string },
        data: { attempts: OUTBOX_MAX_ATTEMPTS - 1 },
      });
      // An unexpected failure nowhere near the transport, with an address in its message.
      jest
        .spyOn(routes, 'findForLead')
        .mockRejectedValueOnce(new Error(`lookup failed for ${lead.email}`));
      const dead = await attempt(d.id);
      expect(dead).toMatchObject({
        status: 'DEAD',
        lastErrorCode: 'handler_error',
        attempts: 0,
      });
      expect((await outboxOf(d.id)).status).toBe('DEAD');
      expect(await history(d.id)).toEqual([
        'QUEUED:enqueued',
        'DEAD:handler_error',
      ]);
      expect(sinkFor(d.id)).toHaveLength(0);

      await deliveries.replay(
        { tenantId: ids.two.tenantId, locationId: null },
        d.id,
        staffTwo,
      );
      expect((await attempt(d.id)).status).toBe('ACCEPTED');
      expect(sinkFor(d.id)).toHaveLength(1);
    });

    it('a non-final unexpected failure keeps the row retryable (not dead-lettered early)', async () => {
      const d = (await submit('two', (await newLead('two')).id))!;
      jest
        .spyOn(routes, 'findForLead')
        .mockRejectedValueOnce(new Error('transient'));
      expect((await attempt(d.id)).status).toBe('QUEUED');
      expect((await outboxOf(d.id)).status).toBe('PENDING');
      expect((await attempt(d.id)).status).toBe('ACCEPTED');
    });
  });

  // ───────────────────────────────────────── R9: one hard send deadline

  describe('R9 — one hard overall send deadline, well inside the stale-SENT window', () => {
    it('a slow SMTP server is cut off at the deadline (retryable); the retry is the only accepted send', async () => {
      await smtp.clear();
      process.env.ADF_SANDBOX_TRANSPORT = 'smtp';
      process.env.ADF_SEND_DEADLINE_MS = '400';
      // The mock holds its reply to DATA for 2.5 s — far inside nodemailer's per-phase timeouts.
      await smtp.mode('slow', 1, 2500);
      const d = (await submit('one', (await newLead('one')).id))!;
      const started = Date.now();
      const first = await attempt(d.id);
      const took = Date.now() - started;
      expect(first).toMatchObject({
        status: 'FAILED',
        attempts: 1,
        lastErrorCode: 'send_deadline_exceeded',
        acceptedAt: null,
      });
      expect(took).toBeLessThan(2000); // cut off at the deadline, not when the server answered
      // The connection was aborted, so the slow server never accepts the abandoned message.
      await new Promise((r) => setTimeout(r, 2600));
      expect(await smtp.messages()).toHaveLength(0);

      const second = await attempt(d.id);
      expect(second).toMatchObject({ status: 'ACCEPTED', attempts: 2 });
      const mail = await smtp.messages();
      expect(mail).toHaveLength(1);
      expect(mail[0].to).toEqual([ids.one.address]);
    });

    it('a dropped connection is a retryable failure, not a hang', async () => {
      await smtp.clear();
      process.env.ADF_SANDBOX_TRANSPORT = 'smtp';
      await smtp.mode('drop', 1);
      const d = (await submit('one', (await newLead('one')).id))!;
      const first = await attempt(d.id);
      expect(first.status).toBe('FAILED');
      expect((await attempt(d.id)).status).toBe('ACCEPTED');
      expect(await smtp.messages()).toHaveLength(1);
    });

    it('while a send is inside its deadline a second worker cannot reclaim the row', async () => {
      await smtp.clear();
      process.env.ADF_SANDBOX_TRANSPORT = 'smtp';
      process.env.ADF_SEND_DEADLINE_MS = '5000';
      await smtp.mode('slow', 1, 1200);
      const d = (await submit('one', (await newLead('one')).id))!;
      const ev = await outboxOf(d.id);
      const meta = { id: ev.id, tenantId: ev.tenantId, attempts: 1 };
      const inFlight = deliveries.process(d.id, meta);
      await new Promise((r) => setTimeout(r, 300));
      expect((await row(d.id)).status).toBe('SENT');
      await expect(deliveries.process(d.id, meta)).rejects.toThrow(
        'delivery_in_flight',
      );
      await expect(inFlight).resolves.toMatchObject({ note: 'accepted:smtp' });
      expect(await row(d.id)).toMatchObject({
        status: 'ACCEPTED',
        attempts: 1,
      });
      expect(await smtp.messages()).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────── R11: no permanent send_disabled rows

  describe('R11 — enabling the rooftop flag before ADF_SEND_ENABLED leaves no permanently blocked rows', () => {
    it('master switch off ⇒ no delivery row and no outbox event (like flag off); once on, the next lead change queues and sends', async () => {
      const lead = await newLead('two');
      process.env.ADF_SEND_ENABLED = 'false';
      expect(
        await deliveries.enqueueForLead(ids.two.tenantId, lead.id),
      ).toEqual({ status: 'skipped', reason: 'send_disabled' });
      expect(
        await ctx.prisma.leadDelivery.count({ where: { leadId: lead.id } }),
      ).toBe(0);
      expect(
        await ctx.prisma.outboxEvent.count({
          where: {
            tenantId: ids.two.tenantId,
            idempotencyKey: { contains: lead.id },
          },
        }),
      ).toBe(0);

      process.env.ADF_SEND_ENABLED = 'true';
      const d = (await submit('two', lead.id))!;
      expect(d.status).toBe('QUEUED');
      expect((await attempt(d.id)).status).toBe('ACCEPTED');
      expect(sinkFor(d.id)).toHaveLength(1);
    });

    it('a row queued before the switch was turned off is BLOCKED send_disabled, and is re-queued automatically when it is turned back on', async () => {
      const mine = { tenantId: ids.two.tenantId };
      const d = (await submit('two', (await newLead('two')).id))!;
      process.env.ADF_SEND_ENABLED = 'false';
      expect(await attempt(d.id)).toMatchObject({
        status: 'BLOCKED',
        blockedReason: 'send_disabled',
      });
      // Still off: the sweep does nothing.
      expect(await deliveries.reevaluateBlocked(mine)).toBe(0);
      expect((await row(d.id)).status).toBe('BLOCKED');

      process.env.ADF_SEND_ENABLED = 'true';
      expect(await deliveries.reevaluateBlocked(mine)).toBeGreaterThanOrEqual(
        1,
      );
      const queued = await row(d.id);
      expect(queued).toMatchObject({ status: 'QUEUED', blockedReason: null });
      expect((await attempt(d.id)).status).toBe('ACCEPTED');
      expect(await history(d.id)).toEqual([
        'QUEUED:enqueued',
        'BLOCKED:send_disabled',
        'QUEUED:gate_reevaluation',
        'SENT:transport_handoff',
        'ACCEPTED:transport_receipt',
      ]);
      expect(sinkFor(d.id)).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────── R14: verification and routing are bound

  describe("R14 — verification is bound to the reviewed destination; routing uses the delivery row's rooftop", () => {
    const ADDR_A = 'adf-sales-r14-a@leads.example.invalid';
    const ADDR_B = 'adf-sales-r14-b@leads.example.invalid';
    let r14: { tenantId: string; locationId: string; otherLocationId: string };

    beforeAll(async () => {
      const tenant = await ctx.prisma.tenant.upsert({
        where: { slug: 'adfr-r14' },
        create: {
          slug: 'adfr-r14',
          name: 'Review rooftop r14 (simulated)',
          featureFlags: { adfLeadDelivery: true },
        },
        update: { featureFlags: { adfLeadDelivery: true } },
      });
      const loc = (slug: string) =>
        ctx.prisma.location.upsert({
          where: { tenantId_slug: { tenantId: tenant.id, slug } },
          create: { tenantId: tenant.id, slug, name: `adfr-r14 ${slug}` },
          update: {},
        });
      r14 = {
        tenantId: tenant.id,
        locationId: (await loc('main')).id,
        otherLocationId: (await loc('second')).id,
      };
    });

    const configure = (address: string, locationId = r14.locationId) =>
      routes.configure(
        r14.tenantId,
        { locationId, department: 'SALES', address, environment: 'SANDBOX' },
        'cli:r14',
      );
    const stored = (id: string) =>
      ctx.prisma.leadDeliveryRoute.findUniqueOrThrow({ where: { id } });

    it('an address rotated between the review and the write is NOT marked verified', async () => {
      const route = await configure(ADDR_A);
      expect((await stored(route.id)).verified).toBe(false);
      // The reviewer read the route (address A)…
      const realFind = ctx.prisma.leadDeliveryRoute.findFirst.bind(
        ctx.prisma.leadDeliveryRoute,
      );
      jest
        .spyOn(ctx.prisma.leadDeliveryRoute, 'findFirst')
        .mockImplementationOnce((async (args: never) => {
          const seen = await realFind(args);
          // …and before the verify write lands, someone rotates the destination to B.
          await configure(ADDR_B);
          return seen;
        }) as never);
      await expect(
        routes.verify(
          r14.tenantId,
          route.id,
          { evidence: 'CRM admin confirmed address A in writing' },
          'cli:r14',
        ),
      ).rejects.toMatchObject({ message: 'route_destination_changed' });
      const after = await stored(route.id);
      expect(after).toMatchObject({
        verified: false,
        verifiedAt: null,
        verificationEvidence: null,
      });
      expect(routes.revealDestination(after)).toBe(ADDR_B);
    });

    it('verifying with the reviewed address: refused when the route now points elsewhere, accepted when it matches', async () => {
      const route = await configure(ADDR_B);
      await expect(
        routes.verify(
          r14.tenantId,
          route.id,
          { evidence: 'CRM admin confirmed address A', address: ADDR_A },
          'cli:r14',
        ),
      ).rejects.toMatchObject({ message: 'route_destination_changed' });
      expect((await stored(route.id)).verified).toBe(false);
      const ok = await routes.verify(
        r14.tenantId,
        route.id,
        { evidence: 'CRM admin confirmed address B', address: ADDR_B },
        'cli:r14',
      );
      expect(ok.verified).toBe(true);
    });

    it('a lead moved to another rooftop after it was queued is not sent anywhere on the old delivery row', async () => {
      const main = await configure(ADDR_B);
      await routes.verify(
        r14.tenantId,
        main.id,
        { evidence: 'sandbox reserved address', address: ADDR_B },
        'cli:r14',
      );
      const second = await configure(ADDR_A, r14.otherLocationId);
      await routes.verify(
        r14.tenantId,
        second.id,
        { evidence: 'sandbox reserved address', address: ADDR_A },
        'cli:r14',
      );
      seq += 1;
      const lead = await ctx.prisma.lead.create({
        data: {
          tenantId: r14.tenantId,
          locationId: r14.locationId,
          firstName: 'Synthetic',
          lastName: `Mover${seq}`,
          email: `adfr-r14-${run}-${seq}@example.invalid`,
          source: 'widget',
        },
      });
      await deliveries.enqueueForLead(r14.tenantId, lead.id);
      const d = await ctx.prisma.leadDelivery.findFirstOrThrow({
        where: { leadId: lead.id },
      });
      expect(d.locationId).toBe(r14.locationId);
      // The lead is re-assigned to the second rooftop before the worker runs.
      await ctx.prisma.lead.update({
        where: { id: lead.id },
        data: { locationId: r14.otherLocationId },
      });
      const after = await attempt(d.id);
      expect(after).toMatchObject({
        status: 'BLOCKED',
        blockedReason: 'lead_location_changed',
        routeId: null,
      });
      // Before the fix the row was routed by the lead's CURRENT location and went to the
      // second rooftop's inbox under the first rooftop's delivery row.
      expect(sinkFor(d.id)).toHaveLength(0);
      expect(sink.messages().filter((m) => m.to === ADDR_A)).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────── R15: index for the appointment-by-lead lookup

  describe('R15 — the appointment-by-lead lookup is indexed', () => {
    it('Appointment has an index on (tenantId, leadId, createdAt) and the schema is in sync with the migrations', async () => {
      const rows = await ctx.prisma.$queryRaw<
        Array<{ indexname: string; indexdef: string }>
      >`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'Appointment'`;
      const idx = rows.find(
        (r) => r.indexname === 'Appointment_tenantId_leadId_createdAt_idx',
      );
      expect(idx?.indexdef).toMatch(/\("tenantId", "leadId", "createdAt"\)/);
      // …and the new column from R3 is there too (additive migrations applied).
      const cols = await ctx.prisma.$queryRaw<
        Array<{ column_name: string; is_nullable: string }>
      >`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'LeadDelivery' AND column_name = 'deliveryMode'`;
      expect(cols).toEqual([
        { column_name: 'deliveryMode', is_nullable: 'YES' },
      ]);
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

  // ───────────────────────────────────────── durable Message-ID + operator assert

  describe('durable Message-ID is persisted before transport; operator may assert ACCEPTED without resend', () => {
    it('writes the stable Message-ID and send_dispatched on the SENT claim before the transport runs', async () => {
      const lead = await newLead('one');
      const d = (await submit('one', lead.id))!;
      const from =
        process.env.ADF_FROM_ADDRESS || 'adf-sandbox@amqur.example.invalid';
      let sawPrePersist = false;
      const realSend = sink.send.bind(sink);
      jest.spyOn(sink, 'send').mockImplementationOnce(async (m) => {
        const row = await ctx.prisma.leadDelivery.findUniqueOrThrow({
          where: { id: d.id },
        });
        expect(row.status).toBe('SENT');
        expect(row.lastErrorCode).toBe(SEND_DISPATCHED);
        expect(row.providerMessageId).toBe(
          stableLeadDeliveryMessageId(d.id, from),
        );
        expect(m.messageId).toBe(row.providerMessageId);
        sawPrePersist = true;
        return realSend(m);
      });
      const after = await attempt(d.id);
      expect(sawPrePersist).toBe(true);
      expect(after).toMatchObject({ status: 'ACCEPTED' });
      // Sandbox receipt overwrites providerMessageId with the sink id; Message-ID in MIME stayed stable.
      expect(sinkFor(d.id)[0]?.messageId).toMatch(
        new RegExp(`^<lead-delivery\\.${d.id}@`),
      );
    });

    it('assertAccepted moves SENT→ACCEPTED with the durable Message-ID and never calls the transport', async () => {
      const lead = await newLead('one');
      const d = (await submit('one', lead.id))!;
      const from =
        process.env.ADF_FROM_ADDRESS || 'adf-sandbox@amqur.example.invalid';
      const messageId = stableLeadDeliveryMessageId(d.id, from);
      // Leave the row in SENT+send_dispatched with a full hand-off claim (routeId required by
      // the ACCEPTED receipt check) without calling the transport.
      jest.spyOn(sink, 'send').mockImplementationOnce(async () => {
        throw new Error('transport_must_not_run_for_assert_setup');
      });
      // Force the SENT claim by running attempt until the transport throws, then restore.
      try {
        await attempt(d.id);
      } catch {
        /* expected — transport mocked to throw before accept */
      }
      jest.restoreAllMocks();
      const mid = await ctx.prisma.leadDelivery.findUniqueOrThrow({
        where: { id: d.id },
      });
      // If the mock threw inside send, the handler may have marked FAILED. Re-arm as the
      // ambiguous SENT window the operator is meant to resolve.
      await ctx.prisma.leadDelivery.update({
        where: { id: d.id },
        data: {
          status: 'SENT',
          sentAt: mid.sentAt ?? new Date(),
          attempts: Math.max(mid.attempts, 1),
          routeId: mid.routeId ?? ids.one.routeId,
          deliveryMode: mid.deliveryMode ?? 'sandbox',
          providerMessageId: messageId,
          providerName: null,
          providerRawStatus: null,
          acceptedAt: null,
          lastErrorCode: SEND_DISPATCHED,
          lastErrorAt: new Date(),
          failedAt: null,
        },
      });
      const send = jest.spyOn(sink, 'send');
      await expect(
        deliveries.assertAccepted(
          { tenantId: ids.one.tenantId, locationId: null },
          d.id,
          {
            note: 'Verified Message-ID in the sandbox mailbox capture',
            evidenceKind: 'mailbox_message_id',
            evidenceReference: '<other@amqur.example.invalid>',
          },
          staffId,
        ),
      ).rejects.toThrow(/evidenceReference/);
      expect(send).not.toHaveBeenCalled();
      const out = await deliveries.assertAccepted(
        { tenantId: ids.one.tenantId, locationId: null },
        d.id,
        {
          note: 'Verified Message-ID in the sandbox mailbox capture',
          evidenceKind: 'mailbox_message_id',
          evidenceReference: messageId,
        },
        staffId,
      );
      expect(out).toMatchObject({
        status: 'ACCEPTED',
        providerMessageId: messageId,
        providerName: 'operator-asserted',
        lastErrorCode: null,
      });
      expect(send).not.toHaveBeenCalled();
      expect(await history(d.id)).toEqual(
        expect.arrayContaining(['ACCEPTED:operator_accept_assertion']),
      );
      const audit = await ctx.prisma.auditLog.findFirst({
        where: {
          action: 'lead_delivery.accept_asserted',
          resourceId: d.id,
        },
      });
      expect(audit?.userId).toBe(staffId);
    });
  });
});
