import request from 'supertest';
import { Logger } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Prisma, Role } from '@prisma/client';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { CrmSyncService } from '../../src/integrations/crm/crm-sync.service';
import { OutboxProcessorService } from '../../src/integrations/core/outbox-processor.service';
import {
  LEAD_DELIVERY_TOPIC,
  LeadDeliveryService,
} from '../../src/integrations/adf/lead-delivery.service';
import { LeadDeliveryRouteService } from '../../src/integrations/adf/lead-delivery-route.service';
import { SandboxSinkTransport } from '../../src/integrations/adf/transports/sandbox-sink.transport';
import {
  sandboxAddressFor,
  seedSandboxRoutes,
} from '../../src/integrations/adf/sandbox-routes.seed';
import { validateAdfXml } from '../../src/integrations/adf/adf-validator';
import { MetricsService } from '../../src/observability/metrics.service';

/**
 * Per-rooftop ADF/XML lead delivery against the real API, Postgres, the durable outbox, the
 * in-process sandbox sink and the loopback mock SMTP server (test-infra/mocks/mock-smtp.mjs).
 * Five SIMULATED rooftops mirror the Dial Auto Group stores as separate tenants under "adf-"
 * slugs. Every address is a reserved *.example.invalid mailbox; every customer is synthetic.
 */
const STORES = {
  chevy: 'Dial Chevy of Chicago (simulated)',
  nissan: 'Dial Nissan of Chicago (simulated)',
  infiniti: 'INFINITI of Chicago (simulated)',
  south: 'Dial Chrysler Dodge Jeep Ram of Chicago (simulated South)',
  north: 'Jeep of Chicago (simulated North)',
} as const;
type Key = keyof typeof STORES;
const KEYS = Object.keys(STORES) as Key[];
const PASSWORD = 'AdfTestPass123!';
// Overridable so an isolated stack never shares the (stateful) default mock SMTP.
const SMTP_API = process.env.MOCK_SMTP_API_URL || 'http://127.0.0.1:18085';
const SMTP_PORT = process.env.MOCK_SMTP_PORT || '11025';
const ENV_KEYS = [
  'OUTBOX_PROCESSOR_ENABLED',
  'ADF_SEND_ENABLED',
  'LEAD_DELIVERY_MODE',
  'ADF_SANDBOX_TRANSPORT',
  'ADF_SMTP_HOST',
  'ADF_SMTP_PORT',
] as const;

const decodeQuotedPrintable = (s: string) =>
  Buffer.from(
    s
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_m, h: string) =>
        String.fromCharCode(parseInt(h, 16)),
      ),
    'latin1',
  ).toString('utf8');

describe('ADF lead delivery (five rooftops, outbox, sandbox sink, mock SMTP)', () => {
  let ctx: E2eCtx;
  let crm: CrmSyncService;
  let deliveries: LeadDeliveryService;
  let routes: LeadDeliveryRouteService;
  let processor: OutboxProcessorService;
  let sink: SandboxSinkTransport;
  const prev: Record<string, string | undefined> = {};
  const ids = {} as Record<
    Key,
    {
      tenantId: string;
      locationId: string;
      staff: string;
      routeId: string;
      address: string;
    }
  >;
  let seq = 0;
  const http = () => request(ctx.app.getHttpServer());
  const smtp = {
    clear: () => fetch(`${SMTP_API}/messages`, { method: 'DELETE' }),
    mode: (mode: string, count?: number) =>
      fetch(`${SMTP_API}/mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, count }),
      }),
    messages: async () =>
      (
        (await (await fetch(`${SMTP_API}/messages`)).json()) as {
          messages: Array<{ from: string; to: string[]; raw: string }>;
        }
      ).messages,
  };

  /** A synthetic lead on the given rooftop (never real contact data). */
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
        lastName: `Shopper${seq}`,
        email: `adf-e2e-${k}-${seq}-${Date.now()}@example.invalid`,
        phone: `312-555-01${String(seq % 100).padStart(2, '0')}`,
        source: 'widget',
        ...over,
      },
    });
  };
  const submit = async (k: Key, leadId: string) => {
    await crm.onLeadChanged(
      ids[k].tenantId,
      ids[k].locationId,
      leadId,
      'lead.created',
    );
    return ctx.prisma.leadDelivery.findFirst({ where: { leadId } });
  };
  const row = (id: string) =>
    ctx.prisma.leadDelivery.findUniqueOrThrow({ where: { id } });
  /** Make the delivery's outbox event due now, then run the worker until it was attempted. */
  const attempt = async (deliveryId: string) => {
    const d = await row(deliveryId);
    const before = await ctx.prisma.outboxEvent.findUniqueOrThrow({
      where: { id: d.outboxEventId as string },
    });
    await ctx.prisma.outboxEvent.update({
      where: { id: before.id },
      data: { nextAttemptAt: new Date(0) },
    });
    for (let i = 0; i < 20; i += 1) {
      await processor.processBatch(500, 'adf-e2e');
      const now = await ctx.prisma.outboxEvent.findUniqueOrThrow({
        where: { id: before.id },
      });
      if (now.status !== 'PENDING' || now.attempts > before.attempts) break;
    }
    return row(deliveryId);
  };
  const login = async (email: string) => {
    const r = await http()
      .post('/api/auth/login')
      .send({ email, password: PASSWORD });
    const b = unwrap<{ access_token?: string; accessToken?: string }>(r.body);
    return b.access_token || b.accessToken || '';
  };
  const get = (k: Key, path: string) =>
    http()
      .get(`/api/ops/${path}`)
      .set('Authorization', `Bearer ${ids[k].staff}`);
  const post = (k: Key, path: string, body: object = {}) =>
    http()
      .post(`/api/ops/${path}`)
      .set('Authorization', `Bearer ${ids[k].staff}`)
      .send(body);

  beforeAll(async () => {
    for (const k of ENV_KEYS) prev[k] = process.env[k];
    // Drive the outbox deterministically; sending is ON for this suite, sandbox only.
    process.env.OUTBOX_PROCESSOR_ENABLED = 'false';
    process.env.ADF_SEND_ENABLED = 'true';
    process.env.LEAD_DELIVERY_MODE = 'sandbox';
    process.env.ADF_SANDBOX_TRANSPORT = 'sink';
    process.env.ADF_SMTP_HOST = '127.0.0.1';
    process.env.ADF_SMTP_PORT = SMTP_PORT;

    ctx = await createE2eApp();
    crm = ctx.app.get(CrmSyncService);
    deliveries = ctx.app.get(LeadDeliveryService);
    routes = ctx.app.get(LeadDeliveryRouteService);
    processor = ctx.app.get(OutboxProcessorService);
    sink = ctx.app.get(SandboxSinkTransport);

    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const k of KEYS) {
      const slug = `adf-${k}`;
      const tenant = await ctx.prisma.tenant.upsert({
        where: { slug },
        create: {
          slug,
          name: STORES[k],
          featureFlags: { adfLeadDelivery: true },
        },
        update: { name: STORES[k], featureFlags: { adfLeadDelivery: true } },
      });
      const loc = await ctx.prisma.location.upsert({
        where: { tenantId_slug: { tenantId: tenant.id, slug: 'main' } },
        create: {
          tenantId: tenant.id,
          slug: 'main',
          name: `${STORES[k]} main`,
        },
        update: {},
      });
      await ctx.prisma.user.upsert({
        where: {
          tenantId_email: { tenantId: tenant.id, email: `admin@${slug}.test` },
        },
        create: {
          tenantId: tenant.id,
          email: `admin@${slug}.test`,
          password: hash,
          firstName: 'Adf',
          lastName: k,
          role: Role.ADMIN,
        },
        update: { password: hash, isActive: true, role: Role.ADMIN },
      });
      ids[k] = {
        tenantId: tenant.id,
        locationId: loc.id,
        staff: await login(`admin@${slug}.test`),
        routeId: '',
        address: '',
      };
    }
    const seeded = await seedSandboxRoutes(
      routes,
      KEYS.map((k) => ({
        tenantId: ids[k].tenantId,
        locationId: ids[k].locationId,
        slug: `adf-${k}`,
      })),
      'cli:adf-e2e',
    );
    for (const k of KEYS) {
      const s = seeded.find((x) => x.slug === `adf-${k}`)!;
      ids[k].routeId = s.routeId;
      ids[k].address = s.address;
    }
    await smtp.mode('none');
    await smtp.clear();
  });

  afterAll(async () => {
    await smtp.mode('none');
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await ctx.app.close();
  });

  beforeEach(() => {
    process.env.ADF_SEND_ENABLED = 'true';
    process.env.ADF_SANDBOX_TRANSPORT = 'sink';
    sink.clear();
  });

  // ───────────────────────────────────────── routing

  it('five-rooftop matrix: every lead lands only in its own rooftop sink (0 wrong-store)', async () => {
    const made = {} as Record<Key, { leadId: string; deliveryId: string }>;
    for (const k of KEYS) {
      const lead = await newLead(k);
      const d = await submit(k, lead.id);
      expect(d?.status).toBe('QUEUED');
      made[k] = { leadId: lead.id, deliveryId: d!.id };
    }
    for (const k of KEYS) await attempt(made[k].deliveryId);

    let wrongStore = 0;
    for (const k of KEYS) {
      const d = await row(made[k].deliveryId);
      expect(d.status).toBe('ACCEPTED');
      expect(d.tenantId).toBe(ids[k].tenantId);
      expect(d.routeId).toBe(ids[k].routeId);
      expect(d.providerName).toBe('sandbox-sink');
      const mine = sink.messages().filter((m) => m.deliveryId === d.id);
      expect(mine).toHaveLength(1);
      expect(mine[0].to).toBe(ids[k].address);
      expect(mine[0].to).toBe(sandboxAddressFor(`adf-${k}`));
      const parsed = validateAdfXml(mine[0].xml);
      expect(parsed).toMatchObject({
        ok: true,
        summary: {
          vendorName: STORES[k],
          leadRef: `amqur-lead-${made[k].leadId}`,
        },
      });
      for (const other of KEYS.filter((o) => o !== k)) {
        if (mine[0].to === ids[other].address) wrongStore += 1;
        if (mine[0].xml.includes(STORES[other])) wrongStore += 1;
        if (mine[0].raw.includes(ids[other].address)) wrongStore += 1;
        // And nothing addressed to this rooftop carries another rooftop's lead.
        wrongStore += sink
          .messages()
          .filter(
            (m) =>
              m.to === ids[k].address &&
              m.xml.includes(`amqur-lead-${made[other].leadId}`),
          ).length;
      }
    }
    expect(wrongStore).toBe(0);
    // Count only this test's five deliveries. The worker drains every pending event in the
    // shared test database, so a delivery queued by another suite can legitimately land in the
    // sink during this test (seen in CI: 6 messages). None of those may carry one of our leads.
    const ourIds = new Set(KEYS.map((k) => made[k].deliveryId));
    const ours = sink.messages().filter((m) => ourIds.has(m.deliveryId));
    expect(ours).toHaveLength(5);
    expect(new Set(ours.map((m) => m.to)).size).toBe(5);
    for (const m of sink.messages().filter((x) => !ourIds.has(x.deliveryId)))
      for (const k of KEYS)
        expect(m.xml).not.toContain(`amqur-lead-${made[k].leadId}`);
    // No CC / BCC / extra recipient anywhere.
    for (const m of sink.messages()) expect(m.raw).not.toMatch(/^(cc|bcc):/im);
  });

  it('CDJR South and Jeep North are never conflated (explicit negatives, both directions)', async () => {
    const jeep = {
      interestedVin: undefined,
      firstName: 'Synthetic',
      lastName: 'JeepShopper',
    };
    const southLead = await newLead('south', jeep);
    const northLead = await newLead('north', jeep);
    const s = await submit('south', southLead.id);
    const n = await submit('north', northLead.id);
    await attempt(s!.id);
    await attempt(n!.id);
    const sm = sink.messages().find((m) => m.deliveryId === s!.id)!;
    const nm = sink.messages().find((m) => m.deliveryId === n!.id)!;

    expect(sm.to).toBe(ids.south.address);
    expect(sm.to).not.toBe(ids.north.address);
    expect(sm.xml).toContain(`<vendorname>${STORES.south}</vendorname>`);
    expect(sm.xml).not.toContain(STORES.north);
    expect(sm.xml).not.toContain(`amqur-lead-${northLead.id}`);
    expect(sm.tenantId).toBe(ids.south.tenantId);

    expect(nm.to).toBe(ids.north.address);
    expect(nm.to).not.toBe(ids.south.address);
    expect(nm.xml).toContain(`<vendorname>${STORES.north}</vendorname>`);
    expect(nm.xml).not.toContain(STORES.south);
    expect(nm.xml).not.toContain(`amqur-lead-${southLead.id}`);
    expect(nm.tenantId).toBe(ids.north.tenantId);

    expect((await row(s!.id)).routeId).toBe(ids.south.routeId);
    expect((await row(n!.id)).routeId).toBe(ids.north.routeId);
    // The lookup is keyed by the lead's own tenant: asking for South with North's location
    // (or the reverse) finds nothing rather than "the other Jeep store".
    expect(
      await routes.findForLead(
        ids.south.tenantId,
        ids.north.locationId,
        'SALES',
      ),
    ).toBeNull();
    expect(
      await routes.findForLead(
        ids.north.tenantId,
        ids.south.locationId,
        'SALES',
      ),
    ).toBeNull();
    // Even a caller passing the wrong tenant cannot move a lead to the other store.
    expect(
      await deliveries.enqueueForLead(ids.north.tenantId, southLead.id),
    ).toEqual({ status: 'skipped', reason: 'lead_not_found' });
  });

  it('cross-rooftop links are structurally impossible in the database', async () => {
    const lead = await newLead('south');
    const d = (await submit('south', lead.id))!;
    // Composite FK (routeId, tenantId): a South delivery cannot reference North's route.
    await expect(
      ctx.prisma.leadDelivery.update({
        where: { id: d.id },
        data: { routeId: ids.north.routeId },
      }),
    ).rejects.toThrow();
    // CHECK: only a verified PRODUCTION route can be production-enabled.
    await expect(
      ctx.prisma.leadDeliveryRoute.update({
        where: { id: ids.south.routeId },
        data: { productionEnabled: true },
      }),
    ).rejects.toThrow();
    await expect(
      routes.setProductionEnabled(
        ids.south.tenantId,
        ids.south.routeId,
        true,
        'cli:adf-e2e',
      ),
    ).rejects.toThrow('SANDBOX route can never be production-enabled');
    // CHECK: "verified" cannot be set without who/when/evidence.
    await expect(
      ctx.prisma.leadDeliveryRoute.update({
        where: { id: ids.south.routeId },
        data: { verified: true, verificationEvidence: null },
      }),
    ).rejects.toThrow();
    // A SANDBOX route cannot be pointed at a real-looking domain, nor at a recipient list.
    await expect(
      routes.configure(
        ids.south.tenantId,
        {
          locationId: ids.south.locationId,
          department: 'PARTS',
          address: 'leads@not-reserved-dealer.net',
        },
        'cli:adf-e2e',
      ),
    ).rejects.toThrow('reserved test domain');
    await expect(
      routes.configure(
        ids.south.tenantId,
        {
          locationId: ids.south.locationId,
          department: 'PARTS',
          address: 'a@x.example.invalid, b@y.example.invalid',
        },
        'cli:adf-e2e',
      ),
    ).rejects.toThrow('exactly one plain mailbox');
    // Another tenant's location is not accepted either.
    await expect(
      routes.configure(
        ids.south.tenantId,
        {
          locationId: ids.north.locationId,
          department: 'PARTS',
          address: 'x@leads.example.invalid',
        },
        'cli:adf-e2e',
      ),
    ).rejects.toThrow('Location not found');
    await attempt(d.id);
  });

  // ───────────────────────────────────────── gates

  it('unverified / disabled / unknown route ⇒ BLOCKED with a reason, nothing sent, lead kept', async () => {
    await smtp.clear();
    const unverify = {
      verified: false,
      verifiedAt: null,
      verifiedBy: null,
      verificationEvidence: null,
    };
    const original = await ctx.prisma.leadDeliveryRoute.findUniqueOrThrow({
      where: { id: ids.nissan.routeId },
    });
    await ctx.prisma.leadDeliveryRoute.update({
      where: { id: ids.nissan.routeId },
      data: unverify,
    });
    const lead1 = await newLead('nissan');
    const d1 = await attempt((await submit('nissan', lead1.id))!.id);
    expect(d1).toMatchObject({
      status: 'BLOCKED',
      blockedReason: 'route_unverified',
      attempts: 0,
      sentAt: null,
      acceptedAt: null,
      providerMessageId: null,
    });

    await ctx.prisma.leadDeliveryRoute.update({
      where: { id: ids.nissan.routeId },
      data: {
        verified: true,
        verifiedAt: original.verifiedAt,
        verifiedBy: original.verifiedBy,
        verificationEvidence: original.verificationEvidence,
        enabled: false,
      },
    });
    const lead2 = await newLead('nissan');
    const d2 = await attempt((await submit('nissan', lead2.id))!.id);
    expect(d2).toMatchObject({
      status: 'BLOCKED',
      blockedReason: 'route_disabled',
    });
    await ctx.prisma.leadDeliveryRoute.update({
      where: { id: ids.nissan.routeId },
      data: { enabled: true },
    });

    // No SERVICE route exists for this rooftop: no default / catch-all is used.
    const lead3 = await newLead('nissan', { source: 'widget_service' });
    const d3 = await attempt((await submit('nissan', lead3.id))!.id);
    expect(d3).toMatchObject({
      status: 'BLOCKED',
      blockedReason: 'no_route',
      department: 'SERVICE',
      routeId: null,
    });

    expect(sink.messages()).toHaveLength(0);
    expect(await smtp.messages()).toHaveLength(0);
    // The lead itself is untouched and the block is operator-visible with its reason.
    expect(
      await ctx.prisma.lead.count({
        where: { id: { in: [lead1.id, lead2.id, lead3.id] } },
      }),
    ).toBe(3);
    const listed = unwrap<Array<{ id: string; blockedReason: string }>>(
      (await get('nissan', 'lead-deliveries?status=BLOCKED')).body,
    );
    expect(listed.map((x) => x.id)).toEqual(
      expect.arrayContaining([d1.id, d2.id, d3.id]),
    );
    const detail = unwrap<{
      events: Array<{ toStatus: string; reasonCode: string }>;
    }>((await get('nissan', `lead-deliveries/${d1.id}`)).body);
    expect(detail.events.map((e) => [e.toStatus, e.reasonCode])).toEqual([
      ['QUEUED', 'enqueued'],
      ['BLOCKED', 'route_unverified'],
    ]);
  });

  it('ADF_SEND_ENABLED=false ⇒ nothing is handed to any transport', async () => {
    await smtp.clear();
    for (const transport of ['sink', 'smtp']) {
      process.env.ADF_SANDBOX_TRANSPORT = transport;
      // Queued while sending was on, switched off before the worker ran: blocked, not sent.
      process.env.ADF_SEND_ENABLED = 'true';
      const lead = await newLead('infiniti');
      const queued = (await submit('infiniti', lead.id))!;
      process.env.ADF_SEND_ENABLED = 'false';
      const d = await attempt(queued.id);
      expect(d).toMatchObject({
        status: 'BLOCKED',
        blockedReason: 'send_disabled',
        attempts: 0,
        sentAt: null,
      });
      // (R11) A lead that arrives while the master switch is off creates no row at all.
      const later = await newLead('infiniti');
      expect(await submit('infiniti', later.id)).toBeNull();
    }
    expect(sink.messages()).toHaveLength(0);
    expect(await smtp.messages()).toHaveLength(0);
  });

  it('rooftop flag off ⇒ no delivery row; opted-out or contactless lead is not sent', async () => {
    await ctx.prisma.tenant.update({
      where: { id: ids.infiniti.tenantId },
      data: { featureFlags: { adfLeadDelivery: false } },
    });
    const off = await newLead('infiniti');
    expect(await submit('infiniti', off.id)).toBeNull();
    await ctx.prisma.tenant.update({
      where: { id: ids.infiniti.tenantId },
      data: { featureFlags: { adfLeadDelivery: true } },
    });

    const noContact = await newLead('infiniti', { email: null, phone: null });
    expect(await submit('infiniti', noContact.id)).toBeNull();

    const optedOut = await newLead('infiniti', { optOutAt: new Date() });
    const d = await attempt((await submit('infiniti', optedOut.id))!.id);
    expect(d).toMatchObject({
      status: 'BLOCKED',
      blockedReason: 'no_consent_basis',
    });
    expect(sink.messages()).toHaveLength(0);
  });

  // ───────────────────────────────────────── idempotency

  it('double-submit, retry and re-processing ⇒ exactly one row and one accepted send', async () => {
    const lead = await newLead('chevy');
    await Promise.all([
      crm.onLeadChanged(
        ids.chevy.tenantId,
        ids.chevy.locationId,
        lead.id,
        'lead.created',
      ),
      crm.onLeadChanged(
        ids.chevy.tenantId,
        ids.chevy.locationId,
        lead.id,
        'lead.created',
      ),
      crm.onLeadChanged(
        ids.chevy.tenantId,
        ids.chevy.locationId,
        lead.id,
        'lead.updated',
      ),
      deliveries.enqueueForLead(ids.chevy.tenantId, lead.id),
      deliveries.enqueueForLead(ids.chevy.tenantId, lead.id),
    ]);
    const rows = await ctx.prisma.leadDelivery.findMany({
      where: { leadId: lead.id },
    });
    expect(rows).toHaveLength(1);
    expect(
      await ctx.prisma.outboxEvent.count({
        where: {
          tenantId: ids.chevy.tenantId,
          topic: LEAD_DELIVERY_TOPIC,
          idempotencyKey: rows[0].idempotencyKey,
        },
      }),
    ).toBe(1);
    expect((await attempt(rows[0].id)).status).toBe('ACCEPTED');
    // A later lead update and a forced re-run of the same outbox event must not send again.
    expect(
      await deliveries.enqueueForLead(ids.chevy.tenantId, lead.id),
    ).toEqual({
      status: 'exists',
      deliveryId: rows[0].id,
    });
    await ctx.prisma.outboxEvent.update({
      where: { id: rows[0].outboxEventId as string },
      data: { status: 'PENDING', nextAttemptAt: new Date(0) },
    });
    const again = await attempt(rows[0].id);
    expect(again.status).toBe('ACCEPTED');
    expect(again.attempts).toBe(1);
    expect(
      sink.messages().filter((m) => m.deliveryId === rows[0].id),
    ).toHaveLength(1);
    expect(
      await ctx.prisma.leadDelivery.count({ where: { leadId: lead.id } }),
    ).toBe(1);
    const ev = await ctx.prisma.outboxEvent.findUniqueOrThrow({
      where: { id: rows[0].outboxEventId as string },
    });
    expect(ev).toMatchObject({
      status: 'PUBLISHED',
      lastError: 'already_acknowledged',
    });
  });

  it('the existing JSON CRM webhook path is unchanged alongside ADF', async () => {
    const lead = await newLead('chevy');
    await submit('chevy', lead.id);
    const hook = await ctx.prisma.outboxEvent.findFirst({
      where: {
        tenantId: ids.chevy.tenantId,
        topic: 'crm.webhook',
        idempotencyKey: `crm-webhook:lead:${lead.id}`,
      },
    });
    expect(hook).not.toBeNull();
    expect((hook!.payload as { event: string }).event).toBe('LEAD_CREATED');
    const d = await ctx.prisma.leadDelivery.findFirstOrThrow({
      where: { leadId: lead.id },
    });
    expect((await attempt(d.id)).status).toBe('ACCEPTED');
  });

  // ───────────────────────────────────────── SMTP

  it('SMTP transport end to end: real RFC 5322 mail to the loopback mock; ACCEPTED is not DELIVERED or CRM_MATCHED', async () => {
    await smtp.clear();
    process.env.ADF_SANDBOX_TRANSPORT = 'smtp';
    const lead = await newLead('chevy', {
      firstName: 'Zo\u00eb',
      lastName: "O'Brien & Sons <test>",
    });
    const d = await attempt((await submit('chevy', lead.id))!.id);
    expect(d.status).toBe('ACCEPTED');
    expect(d.providerName).toBe('smtp');
    expect(d.providerMessageId).toBe(
      `<lead-delivery.${d.id}@amqur.example.invalid>`,
    );
    expect(d.providerRawStatus).toMatch(/^250 /);
    expect(d.acceptedAt).not.toBeNull();
    // SMTP 250 proves hand-off only.
    expect(d.status).not.toBe('DELIVERED');
    expect(d.status).not.toBe('CRM_MATCHED');
    expect(d.deliveredAt).toBeNull();
    expect(d.crmParsedAt).toBeNull();
    expect(d.crmMatchedAt).toBeNull();
    expect(d.crmRecordRef).toBeNull();

    const mail = await smtp.messages();
    expect(mail).toHaveLength(1);
    expect(mail[0].from).toBe('adf-sandbox@amqur.example.invalid');
    expect(mail[0].to).toEqual([ids.chevy.address]);
    const [head, ...rest] = mail[0].raw.split('\r\n\r\n');
    for (const h of [
      `Message-ID: <lead-delivery.${d.id}@amqur.example.invalid>`,
      'From: adf-sandbox@amqur.example.invalid',
      `To: ${ids.chevy.address}`,
      `Subject: New lead amqur-lead-${lead.id}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
    ])
      expect(head).toContain(h);
    expect(head).toMatch(
      /^Date: \w{3}, \d{1,2} \w{3} \d{4} \d\d:\d\d:\d\d \+0000$/m,
    );
    expect(head).not.toMatch(/^(cc|bcc):/im);
    const body = /quoted-printable/i.test(head)
      ? decodeQuotedPrintable(rest.join('\r\n\r\n'))
      : rest.join('\r\n\r\n');
    const parsed = validateAdfXml(body.replace(/\r\n/g, '\n').trimEnd() + '\n');
    expect(parsed).toMatchObject({
      ok: true,
      summary: {
        leadRef: `amqur-lead-${lead.id}`,
        vendorName: STORES.chevy,
        firstName: 'Zo\u00eb',
        lastName: "O'Brien & Sons <test>",
        email: lead.email,
      },
    });
    // The operator API reports the same honest state.
    const viaApi = unwrap<{ status: string; deliveredAt: string | null }>(
      (await get('chevy', `lead-deliveries/${d.id}`)).body,
    );
    expect(viaApi).toMatchObject({ status: 'ACCEPTED', deliveredAt: null });
  });

  it('a sandbox SMTP send to a non-reserved recipient or a non-loopback host is BLOCKED', async () => {
    await smtp.clear();
    process.env.ADF_SANDBOX_TRANSPORT = 'smtp';
    process.env.ADF_SMTP_HOST = 'smtp.not-loopback.example.invalid';
    const lead = await newLead('chevy');
    const d = await attempt((await submit('chevy', lead.id))!.id);
    expect(d).toMatchObject({
      status: 'BLOCKED',
      blockedReason: 'smtp_host_not_loopback',
      attempts: 0,
    });
    process.env.ADF_SMTP_HOST = '127.0.0.1';
    expect(await smtp.messages()).toHaveLength(0);
  });

  it('transport failure ⇒ retry ⇒ success: still exactly one accepted send', async () => {
    await smtp.clear();
    process.env.ADF_SANDBOX_TRANSPORT = 'smtp';
    await smtp.mode('tempfail', 2);
    const lead = await newLead('south');
    const first = await attempt((await submit('south', lead.id))!.id);
    expect(first).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastErrorCode: 'smtp_deferred_451',
      acceptedAt: null,
    });
    const ev1 = await ctx.prisma.outboxEvent.findUniqueOrThrow({
      where: { id: first.outboxEventId as string },
    });
    expect(ev1).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'smtp_deferred_451',
    });
    expect(ev1.nextAttemptAt.getTime()).toBeGreaterThan(Date.now()); // backoff

    const second = await attempt(first.id);
    expect(second).toMatchObject({ status: 'FAILED', attempts: 2 });
    const third = await attempt(first.id);
    expect(third).toMatchObject({
      status: 'ACCEPTED',
      attempts: 3,
      providerName: 'smtp',
      lastErrorCode: null,
    });
    const mail = await smtp.messages();
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toEqual([ids.south.address]);
    const history = await ctx.prisma.leadDeliveryEvent.findMany({
      where: { deliveryId: first.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((h) => h.toStatus)).toEqual([
      'QUEUED',
      'SENT',
      'FAILED',
      'SENT',
      'FAILED',
      'SENT',
      'ACCEPTED',
    ]);
    // One more run after success is a no-op.
    await ctx.prisma.outboxEvent.update({
      where: { id: first.outboxEventId as string },
      data: { status: 'PENDING' },
    });
    await attempt(first.id);
    expect(await smtp.messages()).toHaveLength(1);
    await smtp.mode('none');
  });

  it('permanent SMTP rejection ⇒ DEAD (no retry); replay after the fix ⇒ ACCEPTED once', async () => {
    await smtp.clear();
    process.env.ADF_SANDBOX_TRANSPORT = 'smtp';
    await smtp.mode('reject', 1);
    const lead = await newLead('north');
    const d = await attempt((await submit('north', lead.id))!.id);
    expect(d).toMatchObject({
      status: 'DEAD',
      attempts: 1,
      lastErrorCode: 'smtp_rejected_550',
    });
    const ev = await ctx.prisma.outboxEvent.findUniqueOrThrow({
      where: { id: d.outboxEventId as string },
    });
    expect(ev).toMatchObject({
      status: 'DEAD',
      lastError: 'smtp_rejected_550',
    });
    expect(await smtp.messages()).toHaveLength(0);

    const replayed = await post('north', `lead-deliveries/${d.id}/replay`);
    expect(replayed.status).toBeLessThan(300);
    expect(unwrap<{ status: string }>(replayed.body).status).toBe('QUEUED');
    const after = await attempt(d.id);
    expect(after).toMatchObject({
      status: 'ACCEPTED',
      attempts: 2,
      replayCount: 1,
    });
    expect(await smtp.messages()).toHaveLength(1);
  });

  it('poison payload ⇒ DEAD, never sent; operator replay is audited and works after the fix', async () => {
    // A rooftop with no usable name cannot produce a valid <vendor>: the document is invalid.
    await ctx.prisma.tenant.update({
      where: { id: ids.infiniti.tenantId },
      data: { name: ' \u0001 ' },
    });
    const lead = await newLead('infiniti');
    const d = await attempt((await submit('infiniti', lead.id))!.id);
    expect(d).toMatchObject({
      status: 'DEAD',
      lastErrorCode: 'adf_missing_vendor',
      attempts: 0,
      sentAt: null,
    });
    expect(sink.messages()).toHaveLength(0);
    const ev = await ctx.prisma.outboxEvent.findUniqueOrThrow({
      where: { id: d.outboxEventId as string },
    });
    expect(ev).toMatchObject({
      status: 'DEAD',
      lastError: 'adf_missing_vendor',
    });
    // Visible in the existing dead-letter view.
    const dead = unwrap<Array<{ id: string; topic: string }>>(
      (await get('infiniti', 'outbox/dead')).body,
    );
    expect(dead.find((x) => x.id === ev.id)?.topic).toBe(LEAD_DELIVERY_TOPIC);

    await ctx.prisma.tenant.update({
      where: { id: ids.infiniti.tenantId },
      data: { name: STORES.infiniti },
    });
    const replay = await post('infiniti', `lead-deliveries/${d.id}/replay`);
    expect(replay.status).toBeLessThan(300);
    const after = await attempt(d.id);
    expect(after).toMatchObject({ status: 'ACCEPTED', replayCount: 1 });
    expect(sink.messages().filter((m) => m.deliveryId === d.id)).toHaveLength(
      1,
    );
    const audit = await ctx.prisma.auditLog.findFirst({
      where: {
        tenantId: ids.infiniti.tenantId,
        action: 'lead_delivery.replay',
        resourceId: d.id,
      },
    });
    expect(audit?.userId).toBeTruthy();
    expect(audit?.metadata).toMatchObject({ fromStatus: 'DEAD' });
    // An acknowledged delivery can never be replayed (no second send).
    expect(
      (await post('infiniti', `lead-deliveries/${d.id}/replay`)).status,
    ).toBe(409);
    expect(sink.messages().filter((m) => m.deliveryId === d.id)).toHaveLength(
      1,
    );
  });

  // ───────────────────────────────────────── reconciliation

  it('reconciliation: PARSED → MATCHED needs a CRM record ref; parser rejection is its own failed state', async () => {
    const a = await attempt(
      (await submit('chevy', (await newLead('chevy')).id))!.id,
    );
    const b = await attempt(
      (await submit('chevy', (await newLead('chevy')).id))!.id,
    );
    const queued = (await submit('chevy', (await newLead('chevy')).id))!;
    expect(a.status).toBe('ACCEPTED');

    // No skipping: a delivery that was never acknowledged cannot be marked matched.
    expect(
      (
        await post('chevy', `lead-deliveries/${queued.id}/reconcile`, {
          result: 'CRM_MATCHED',
          crmRecordRef: 'CRM-0001',
        })
      ).status,
    ).toBe(409);
    expect((await row(queued.id)).status).toBe('QUEUED');

    // MATCHED without a record reference is refused.
    expect(
      (
        await post('chevy', `lead-deliveries/${a.id}/reconcile`, {
          result: 'CRM_MATCHED',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post('chevy', `lead-deliveries/${a.id}/reconcile`, {
          result: 'CRM_MATCHED',
          crmRecordRef: 'someone@example.invalid',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post('chevy', `lead-deliveries/${a.id}/reconcile`, {
          result: 'DELIVERED',
        })
      ).status,
    ).toBe(400);
    expect((await row(a.id)).status).toBe('ACCEPTED');

    const parsed = await post('chevy', `lead-deliveries/${a.id}/reconcile`, {
      result: 'CRM_PARSED',
    });
    expect(parsed.status).toBeLessThan(300);
    expect(unwrap<{ status: string }>(parsed.body).status).toBe('CRM_PARSED');
    const matched = await post('chevy', `lead-deliveries/${a.id}/reconcile`, {
      result: 'CRM_MATCHED',
      crmRecordRef: 'CRM-OPP-000123',
      note: 'matched in sandbox import',
    });
    expect(
      unwrap<{ status: string; crmRecordRef: string }>(matched.body),
    ).toMatchObject({
      status: 'CRM_MATCHED',
      crmRecordRef: 'CRM-OPP-000123',
    });
    const am = await row(a.id);
    expect(am.crmParsedAt).not.toBeNull();
    expect(am.crmMatchedAt).not.toBeNull();
    expect(am.deliveredAt).toBeNull(); // never claimed: no provider delivery callback exists
    // A late "parsed" after matched changes nothing.
    await post('chevy', `lead-deliveries/${a.id}/reconcile`, {
      result: 'CRM_PARSED',
    });
    expect((await row(a.id)).status).toBe('CRM_MATCHED');

    const rejected = await post('chevy', `lead-deliveries/${b.id}/reconcile`, {
      result: 'CRM_REJECTED',
      note: 'parser rejected: body variant',
    });
    expect(unwrap<{ status: string }>(rejected.body).status).toBe(
      'CRM_REJECTED',
    );
    const br = await row(b.id);
    expect(br).toMatchObject({
      status: 'CRM_REJECTED',
      crmRecordRef: null,
      crmMatchedAt: null,
    });
    expect(br.crmRejectedAt).not.toBeNull();
    // Rejected is terminal: it cannot be flipped to matched.
    expect(
      (
        await post('chevy', `lead-deliveries/${b.id}/reconcile`, {
          result: 'CRM_MATCHED',
          crmRecordRef: 'CRM-OPP-000124',
        })
      ).status,
    ).toBe(409);
    const unmatched = unwrap<Array<{ id: string }>>(
      (await get('chevy', 'lead-deliveries?status=CRM_REJECTED')).body,
    );
    expect(unmatched.map((x) => x.id)).toContain(b.id);
    expect(
      unwrap<Array<{ id: string }>>(
        (await get('chevy', 'lead-deliveries?status=CRM_MATCHED')).body,
      ).map((x) => x.id),
    ).not.toContain(b.id);

    const audits = await ctx.prisma.auditLog.findMany({
      where: {
        tenantId: ids.chevy.tenantId,
        action: 'lead_delivery.reconciled',
        resourceId: { in: [a.id, b.id] },
      },
    });
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(audits.every((x) => x.userId)).toBe(true);
    expect((await get('chevy', 'lead-deliveries?status=NOPE')).status).toBe(
      400,
    );
    await attempt(queued.id);
  });

  // ───────────────────────────────────────── access control + privacy

  it('staff from another tenant get 404/403; widget and anonymous callers are refused', async () => {
    const d = await attempt(
      (await submit('south', (await newLead('south')).id))!.id,
    );
    expect((await get('south', `lead-deliveries/${d.id}`)).status).toBe(200);
    // North staff cannot see or act on South's delivery.
    expect((await get('north', `lead-deliveries/${d.id}`)).status).toBe(404);
    expect((await post('north', `lead-deliveries/${d.id}/replay`)).status).toBe(
      404,
    );
    expect(
      (
        await post('north', `lead-deliveries/${d.id}/reconcile`, {
          result: 'CRM_MATCHED',
          crmRecordRef: 'CRM-X',
        })
      ).status,
    ).toBe(404);
    expect((await row(d.id)).status).toBe('ACCEPTED');
    expect(
      (await get('north', `lead-deliveries?tenantId=${ids.south.tenantId}`))
        .status,
    ).toBe(403);
    expect(
      (
        await get(
          'north',
          `lead-deliveries/${d.id}?tenantId=${ids.south.tenantId}`,
        )
      ).status,
    ).toBe(403);
    const northList = unwrap<Array<{ id: string; tenantId: string }>>(
      (await get('north', 'lead-deliveries')).body,
    );
    expect(northList.every((x) => x.tenantId === ids.north.tenantId)).toBe(
      true,
    );
    expect(northList.map((x) => x.id)).not.toContain(d.id);
    const northRoutes = unwrap<Array<{ id: string }>>(
      (await get('north', 'lead-delivery-routes')).body,
    );
    expect(northRoutes.map((r) => r.id)).toEqual([ids.north.routeId]);

    // Rooftop scope inside one tenant: staff bound to another location see nothing.
    const annex = await ctx.prisma.location.upsert({
      where: { tenantId_slug: { tenantId: ids.south.tenantId, slug: 'annex' } },
      create: {
        tenantId: ids.south.tenantId,
        slug: 'annex',
        name: 'Annex (simulated)',
      },
      update: {},
    });
    await ctx.prisma.user.upsert({
      where: {
        tenantId_email: {
          tenantId: ids.south.tenantId,
          email: 'annex@adf-south.test',
        },
      },
      create: {
        tenantId: ids.south.tenantId,
        locationId: annex.id,
        email: 'annex@adf-south.test',
        password: await bcrypt.hash(PASSWORD, 10),
        firstName: 'Annex',
        lastName: 'Manager',
        role: Role.MANAGER,
      },
      update: { locationId: annex.id, role: Role.MANAGER, isActive: true },
    });
    const annexToken = await login('annex@adf-south.test');
    const asAnnex = (path: string) =>
      http()
        .get(`/api/ops/${path}`)
        .set('Authorization', `Bearer ${annexToken}`);
    expect((await asAnnex(`lead-deliveries/${d.id}`)).status).toBe(404);
    expect(unwrap<unknown[]>((await asAnnex('lead-deliveries')).body)).toEqual(
      [],
    );
    expect(
      (await asAnnex(`lead-deliveries?locationId=${ids.south.locationId}`))
        .status,
    ).toBe(403);
    // A manager cannot replay (admin only).
    expect(
      (
        await http()
          .post(`/api/ops/lead-deliveries/${d.id}/replay`)
          .set('Authorization', `Bearer ${annexToken}`)
      ).status,
    ).toBe(403);

    expect((await http().get(`/api/ops/lead-deliveries/${d.id}`)).status).toBe(
      401,
    );
    await ctx.prisma.tenant.update({
      where: { id: ids.south.tenantId },
      data: { allowedOrigins: 'http://127.0.0.1:18084' },
    });
    const wt = await http()
      .post('/api/public/widget-token')
      .set('Origin', 'http://127.0.0.1:18084')
      .send({ tenantSlug: 'adf-south', locationSlug: 'main' });
    const widget = unwrap<{ token?: string }>(wt.body).token;
    expect(widget).toBeTruthy();
    for (const path of [
      'lead-deliveries',
      `lead-deliveries/${d.id}`,
      'lead-delivery-routes',
    ])
      expect(
        (
          await http()
            .get(`/api/ops/${path}`)
            .set('Authorization', `Bearer ${widget}`)
        ).status,
      ).toBe(403);
  });

  it('destination addresses and customer contact data never leave the server', async () => {
    const lead = await newLead('south');
    const d = await attempt((await submit('south', lead.id))!.id);
    const secrets = [
      ids.south.address,
      'leads.example.invalid',
      lead.email as string,
      lead.phone as string,
    ];
    const bodies = [
      (await get('south', 'lead-deliveries')).body,
      (await get('south', `lead-deliveries/${d.id}`)).body,
      (await get('south', 'lead-delivery-routes')).body,
      (
        await http()
          .get(
            '/api/public/widget-config?tenantSlug=adf-south&locationSlug=main',
          )
          .set('Origin', 'http://127.0.0.1:18084')
      ).body,
      (
        await http()
          .get(
            '/api/public/store-status?tenantSlug=adf-south&locationSlug=main',
          )
          .set('Origin', 'http://127.0.0.1:18084')
      ).body,
    ].map((b) => JSON.stringify(b));
    for (const body of bodies) {
      for (const s of secrets) expect(body).not.toContain(s);
      expect(body).not.toMatch(
        /destinationCiphertext|destinationIv|destinationAuthTag/,
      );
      expect(body).not.toContain('destinationFingerprint');
    }
    expect(bodies[2]).toContain('"destinationMasked":"a***@l***.invalid"');
    expect(bodies[4]).not.toContain('destinationMasked');
    // At rest: the route stores ciphertext + keyed fingerprint, never the address.
    const storedRoute = JSON.stringify(
      await ctx.prisma.leadDeliveryRoute.findUniqueOrThrow({
        where: { id: ids.south.routeId },
      }),
    );
    expect(storedRoute).not.toContain(ids.south.address);
    const storedDelivery = JSON.stringify(await row(d.id));
    for (const s of secrets) expect(storedDelivery).not.toContain(s);
    expect(
      routes.revealDestination(
        await ctx.prisma.leadDeliveryRoute.findUniqueOrThrow({
          where: { id: ids.south.routeId },
        }),
      ),
    ).toBe(ids.south.address);
  });

  it('no email, phone, name or destination appears in logs, outbox rows, history or metrics', async () => {
    const captured: string[] = [];
    const grab = (chunk: unknown) => {
      captured.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    };
    // The Nest testing module mutes log/warn, so capture at the Logger facade: this is every
    // line the app WOULD write in production, at every level.
    const spies = [
      ...(['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) =>
        jest
          .spyOn(Logger.prototype, m)
          .mockImplementation((...a: unknown[]) => {
            captured.push(a.map(String).join(' '));
          }),
      ),
      jest.spyOn(process.stdout, 'write').mockImplementation(grab as never),
      jest.spyOn(process.stderr, 'write').mockImplementation(grab as never),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
        jest.spyOn(console, m).mockImplementation((...a: unknown[]) => {
          captured.push(a.map(String).join(' '));
        }),
      ),
    ];
    const pii: string[] = [];
    const made: string[] = [];
    try {
      await smtp.clear();
      const run = async (k: Key, over: object = {}) => {
        const lead = await newLead(k, {
          firstName: 'Zebediah',
          lastName: `Quillfeather${seq}`,
          ...over,
        });
        pii.push(
          lead.email as string,
          lead.phone as string,
          (lead.phone as string).replace(/\D/g, ''),
          lead.lastName as string,
          'Zebediah',
          ids[k].address,
        );
        const d = (await submit(k, lead.id))!;
        made.push(d.id);
        return d.id;
      };
      // success via sink, success via SMTP, a retryable failure, a permanent failure, a block.
      await attempt(await run('chevy'));
      process.env.ADF_SANDBOX_TRANSPORT = 'smtp';
      await attempt(await run('nissan'));
      await smtp.mode('tempfail', 1);
      const flaky = await run('south');
      await attempt(flaky);
      await attempt(flaky);
      await smtp.mode('reject', 1);
      await attempt(await run('north'));
      await smtp.mode('none');
      const blocked = await run('infiniti');
      process.env.ADF_SEND_ENABLED = 'false';
      await attempt(blocked);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const logs = captured.join('\n');
    expect(logs).toContain('ACCEPTED'); // the run really was logged
    expect(logs).toContain('BLOCKED');
    for (const p of pii) expect(logs).not.toContain(p);
    expect(logs).not.toMatch(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]*example\.invalid/,
    );
    expect(logs).not.toMatch(/555-01\d\d/);

    const rows = await ctx.prisma.leadDelivery.findMany({
      where: { id: { in: made } },
      include: { events: true },
    });
    expect(rows.map((r) => r.status).sort()).toEqual(
      ['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'BLOCKED', 'DEAD'].sort(),
    );
    const events = await ctx.prisma.outboxEvent.findMany({
      where: { id: { in: rows.map((r) => r.outboxEventId as string) } },
    });
    expect(events).toHaveLength(5);
    for (const e of events)
      expect(Object.keys(e.payload as object)).toEqual(['deliveryId']);
    const stored =
      JSON.stringify(rows) +
      JSON.stringify(events) +
      JSON.stringify(ctx.app.get(MetricsService).snapshot());
    for (const p of pii) expect(stored).not.toContain(p);
    // The only '@' left are masked displays (a***@l***.invalid) and our own Message-IDs.
    expect(stored).not.toMatch(
      /[A-Za-z0-9._%+-]+@(?!amqur\.example\.invalid>)[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/,
    );
  });

  it('funnel: sandbox acknowledgements never count as mail accepted or CRM received; counts stay inside the tenant', async () => {
    type Funnel = {
      stages: Array<{ stage: string; count: number }>;
      notProven: { mailAcceptedSandboxOnly: number };
      needsAttention: { acceptedNotConfirmedInCrm: number };
    };
    const lead = await newLead('south');
    const d = await submit('south', lead.id);
    await attempt(d!.id);
    expect((await row(d!.id)).status).toBe('ACCEPTED');

    const res = await get('south', 'funnel?days=7');
    expect(res.status).toBe(200);
    const f = unwrap<Funnel>(res.body);
    const count = (name: string) =>
      f.stages.find((x) => x.stage === name)!.count;
    expect(f.stages.map((x) => x.stage)).toEqual([
      'LEAD_CREATED',
      'LEAD_QUEUED',
      'MAIL_ACCEPTED',
      'CRM_RECEIVED',
      'CRM_MATCHED',
      'APPOINTMENT_REQUESTED',
      'APPOINTMENT_CONFIRMED',
    ]);
    expect(count('LEAD_CREATED')).toBeGreaterThan(0);
    expect(count('LEAD_QUEUED')).toBeGreaterThan(0);
    // Every route in this suite is a SANDBOX route to a reserved test address.
    expect(count('MAIL_ACCEPTED')).toBe(0);
    expect(count('CRM_RECEIVED')).toBe(0);
    expect(count('CRM_MATCHED')).toBe(0);
    expect(f.notProven.mailAcceptedSandboxOnly).toBeGreaterThan(0);
    // No customer data, ids or addresses in the payload: counts and fixed text only.
    expect(JSON.stringify(f)).not.toMatch(/@|example\.invalid|555-01/);

    // Another tenant's numbers are not reachable, and are not mixed in.
    expect(
      (await get('north', `funnel?tenantId=${ids.south.tenantId}`)).status,
    ).toBe(403);
    const southLeads = await ctx.prisma.lead.count({
      where: { tenantId: ids.south.tenantId },
    });
    expect(count('LEAD_CREATED')).toBe(southLeads);
    expect((await http().get('/api/ops/funnel')).status).toBeGreaterThanOrEqual(
      401,
    );
  });
});
