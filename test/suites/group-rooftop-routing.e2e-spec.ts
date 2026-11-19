import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import {
  RIVAL_VEHICLES,
  seedDemoDealer,
  SIM_ORIGIN,
} from '../helpers/demo-dealer';
import {
  ensureSandboxSchedulerConnection,
  SeededGroup,
  seedGroupRooftops,
  SeedRooftopKey,
} from '../../scripts/lib/group-rooftops-seed';
import { LeadDeliveryRouteService } from '../../src/integrations/adf/lead-delivery-route.service';
import { seedSandboxRoutes } from '../../src/integrations/adf/sandbox-routes.seed';
import { SandboxSinkTransport } from '../../src/integrations/adf/transports/sandbox-sink.transport';
import { OutboxProcessorService } from '../../src/integrations/core/outbox-processor.service';
import { LEAD_FORM_CONSENT_VERSION } from '../../src/chat/sales-desk/consent-wording';
import {
  groupRoutingKey,
  signRooftopRef,
} from '../../src/group-routing/rooftop-ref';

/**
 * Group-site rooftop routing against the real API + Postgres. Five SYNTHETIC rooftops and a
 * group site are seeded under "grt-" slugs (never the demo/production slugs). Emails are
 * example.invalid, phones 555-01xx, VINs start with DEMO. ADF goes to the in-process sandbox
 * sink only; the outbox is driven by the test, so nothing depends on delivery timing.
 */
const PREFIX = 'grt-';
const PASSWORD = 'GroupRouting123!';
const EMAIL = 'pat.rivera@example.invalid';
const PHONE = '312-555-0142';
const KEYS: SeedRooftopKey[] = [
  'chevy',
  'nissan',
  'infiniti',
  'south',
  'north',
];
const N1 = 'DEMO00000000000N1';
const S1 = 'DEMO00000000000S1';
const ENV_KEYS = [
  'OUTBOX_PROCESSOR_ENABLED',
  'ADF_SEND_ENABLED',
  'LEAD_DELIVERY_MODE',
  'ADF_SANDBOX_TRANSPORT',
] as const;

type Vehicle = {
  vin: string;
  rooftopName?: string | null;
  rooftopRef?: string;
};
type Card = Record<string, unknown> & { kind: string };
type Chat = {
  reply: string;
  conversationId: string;
  vehicles?: Vehicle[];
  cards: Card[];
  quickReplies: string[];
  conversation: { language: string; pending: string };
  journey: Record<string, unknown>;
};

describe('group-site rooftop routing', () => {
  let ctx: E2eCtx;
  let seeded: SeededGroup;
  let sink: SandboxSinkTransport;
  let processor: OutboxProcessorService;
  const prev: Record<string, string | undefined> = {};
  const widget = {} as Record<SeedRooftopKey | 'group', string>;
  const staff = {} as Record<SeedRooftopKey | 'group', string>;
  const address = {} as Record<SeedRooftopKey, string>;
  let rivalTenantId: string;

  const http = () => request(ctx.app.getHttpServer());
  const tenantOf = (k: SeedRooftopKey | 'group') =>
    k === 'group' ? seeded.group.tenantId : seeded.rooftops[k].tenantId;
  const post = (k: SeedRooftopKey | 'group', body: object) =>
    http()
      .post('/api/chat')
      .set('Authorization', `Bearer ${widget[k]}`)
      .set('Origin', SIM_ORIGIN)
      .send(body);
  const chat = async (
    k: SeedRooftopKey | 'group',
    body: Record<string, unknown>,
  ): Promise<Chat> => {
    const r = await post(k, body);
    expect(r.status).toBe(201);
    return unwrap<Chat>(r.body);
  };
  /** A group conversation: keeps its id, so turns chain. */
  const visitor = (k: SeedRooftopKey | 'group' = 'group') => {
    let conversationId: string | undefined;
    return {
      say: async (
        message: string,
        extra: Record<string, unknown> = {},
      ): Promise<Chat> => {
        const r = await chat(k, { message, conversationId, ...extra });
        conversationId = r.conversationId;
        return r;
      },
      id: () => conversationId!,
    };
  };
  const card = <T = Card>(r: Chat, kind: string) =>
    r.cards.find((c) => c.kind === kind) as T | undefined;
  const vins = (r: Chat) => (r.vehicles ?? []).map((v) => v.vin).sort();
  const lead = (formId: string, over: Record<string, unknown> = {}) => ({
    formId,
    firstName: 'Pat',
    lastName: 'Rivera',
    email: EMAIL,
    phone: PHONE,
    preferredChannel: 'EMAIL',
    consents: [
      { channel: 'EMAIL', granted: true, version: LEAD_FORM_CONSENT_VERSION },
      { channel: 'CALL', granted: true, version: LEAD_FORM_CONSENT_VERSION },
    ],
    ...over,
  });
  /** Every customer-identifying table, per tenant. */
  const records = async (tenantId: string) => {
    const [
      leads,
      consents,
      appointments,
      receipts,
      deliveries,
      escalations,
      parts,
      finance,
    ] = await Promise.all([
      ctx.prisma.lead.count({ where: { tenantId } }),
      ctx.prisma.consentRecord.count({ where: { tenantId } }),
      ctx.prisma.appointment.count({ where: { tenantId } }),
      ctx.prisma.appointmentProviderReceipt.count({ where: { tenantId } }),
      ctx.prisma.leadDelivery.count({ where: { tenantId } }),
      ctx.prisma.escalation.count({ where: { tenantId } }),
      ctx.prisma.partsInquiry.count({ where: { tenantId } }),
      ctx.prisma.financeRequest.count({ where: { tenantId } }),
    ]);
    return {
      leads,
      consents,
      appointments,
      receipts,
      deliveries,
      escalations,
      parts,
      finance,
    };
  };
  const NONE = {
    leads: 0,
    consents: 0,
    appointments: 0,
    receipts: 0,
    deliveries: 0,
    escalations: 0,
    parts: 0,
    finance: 0,
  };
  const snapshot = async () => {
    const out: Record<string, Awaited<ReturnType<typeof records>>> = {};
    for (const k of [...KEYS, 'group'] as const)
      out[k] = await records(tenantOf(k));
    out.rival = await records(rivalTenantId);
    return out;
  };
  const wipe = async () => {
    const tenantIds = [...KEYS.map(tenantOf), tenantOf('group')];
    const where = { tenantId: { in: tenantIds } };
    await ctx.prisma.leadDelivery.deleteMany({ where });
    await ctx.prisma.appointment.deleteMany({ where });
    await ctx.prisma.consentRecord.deleteMany({ where });
    await ctx.prisma.escalation.deleteMany({ where });
    await ctx.prisma.partsInquiry.deleteMany({ where });
    await ctx.prisma.financeRequest.deleteMany({ where });
    await ctx.prisma.lead.deleteMany({ where });
    await ctx.prisma.conversation.deleteMany({ where });
    await ctx.prisma.auditLog.deleteMany({ where });
    sink.clear();
  };
  const groupConversation = (conversationId: string) =>
    ctx.prisma.conversation.findUniqueOrThrow({
      where: {
        tenantId_externalKey: {
          tenantId: tenantOf('group'),
          externalKey: conversationId,
        },
      },
      include: { messages: true },
    });
  /** Run the outbox until this delivery was attempted (deterministic; no timers). */
  const attempt = async (deliveryId: string) => {
    const d = await ctx.prisma.leadDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    const before = await ctx.prisma.outboxEvent.findUniqueOrThrow({
      where: { id: d.outboxEventId as string },
    });
    await ctx.prisma.outboxEvent.update({
      where: { id: before.id },
      data: { nextAttemptAt: new Date(0) },
    });
    for (let i = 0; i < 20; i += 1) {
      await processor.processBatch(500, 'group-routing-e2e');
      const now = await ctx.prisma.outboxEvent.findUniqueOrThrow({
        where: { id: before.id },
      });
      if (now.status !== 'PENDING' || now.attempts > before.attempts) break;
    }
    return ctx.prisma.leadDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
  };
  const setFlags = async (
    k: SeedRooftopKey | 'group',
    patch: Record<string, boolean>,
  ) => {
    const t = await ctx.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantOf(k) },
    });
    await ctx.prisma.tenant.update({
      where: { id: t.id },
      data: {
        featureFlags: {
          ...((t.featureFlags as Record<string, boolean>) ?? {}),
          ...patch,
        },
      },
    });
  };
  /** Group visitor → the chosen rooftop's lead form for a vehicle. */
  const toLeadForm = async (vin: string) => {
    const v = visitor();
    const list = await v.say('Show me 2026 Grand Cherokees');
    expect(list.vehicles ?? []).toHaveLength(0);
    const both = await v.say('Either');
    const picked = both.vehicles!.find((x) => x.vin === vin)!;
    const form = await v.say('', {
      action: 'test_drive',
      vin,
      rooftopRef: picked.rooftopRef,
    });
    return { v, form, picked, both };
  };

  beforeAll(async () => {
    for (const k of ENV_KEYS) prev[k] = process.env[k];
    process.env.OUTBOX_PROCESSOR_ENABLED = 'false';
    process.env.ADF_SEND_ENABLED = 'true';
    process.env.LEAD_DELIVERY_MODE = 'sandbox';
    process.env.ADF_SANDBOX_TRANSPORT = 'sink';

    ctx = await createE2eApp();
    sink = ctx.app.get(SandboxSinkTransport);
    processor = ctx.app.get(OutboxProcessorService);
    seeded = await seedGroupRooftops(ctx.prisma, {
      prefix: PREFIX,
      rooftopOrigins: [SIM_ORIGIN],
      groupOrigins: [SIM_ORIGIN],
    });
    const rival = await seedDemoDealer(ctx.app, ctx.prisma, `${PREFIX}rival`, {
      vehicles: RIVAL_VEHICLES,
      creditPreview: false,
      flags: { groupInventoryListed: true, groupSiteShopping: true },
    });
    rivalTenantId = rival.tenantId;
    const rooftops = Object.values(seeded.rooftops);
    for (const r of rooftops)
      await ensureSandboxSchedulerConnection(
        ctx.prisma,
        r.tenantId,
        r.locationId,
      );
    const routes = await seedSandboxRoutes(
      ctx.app.get(LeadDeliveryRouteService),
      rooftops.map((r) => ({
        tenantId: r.tenantId,
        locationId: r.locationId,
        slug: r.slug,
      })),
      'cli:group-routing-e2e',
    );
    for (const k of KEYS)
      address[k] = routes.find(
        (x) => x.slug === seeded.rooftops[k].slug,
      )!.address;
    await wipe();

    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const k of [...KEYS, 'group'] as const) {
      const slug = k === 'group' ? seeded.group.slug : seeded.rooftops[k].slug;
      const email = `admin@${slug}.test`;
      await ctx.prisma.user.upsert({
        where: { tenantId_email: { tenantId: tenantOf(k), email } },
        create: {
          tenantId: tenantOf(k),
          email,
          password: hash,
          firstName: 'Grt',
          lastName: k,
          role: Role.ADMIN,
        },
        update: { password: hash, isActive: true, role: Role.ADMIN },
      });
      const t = await http()
        .post('/api/public/widget-token')
        .set('Origin', SIM_ORIGIN)
        .send({ tenantSlug: slug, locationSlug: 'main' });
      widget[k] = unwrap<{ token: string }>(t.body).token;
      const login = await http()
        .post('/api/auth/login')
        .send({ email, password: PASSWORD });
      const lb = unwrap<{ access_token?: string; accessToken?: string }>(
        login.body,
      );
      staff[k] = lb.access_token || lb.accessToken || '';
      expect(widget[k]).toBeTruthy();
      expect(staff[k]).toBeTruthy();
    }
  });

  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await ctx.app.close();
  });

  // ───────────────────────────────────────── opt-in, fail-closed

  describe('opt-in and flags-off parity', () => {
    const strip = (r: Chat) => {
      const { conversationId: _c, ...rest } = r;
      void _c;
      return rest;
    };

    it('group flag off ⇒ the group tenant answers exactly like a tenant with no group at all', async () => {
      const turns = ['Show me 2026 Grand Cherokees', 'I need an oil change'];
      await setFlags('group', { groupSiteShopping: false });
      const flagOff: unknown[] = [];
      const a = visitor();
      for (const m of turns) flagOff.push(strip(await a.say(m)));
      await setFlags('group', { groupSiteShopping: true });
      // no group designation at all
      await ctx.prisma.dealerGroup.update({
        where: { id: seeded.dealerGroupId },
        data: { groupSiteTenantId: null },
      });
      const noGroup: unknown[] = [];
      const b = visitor();
      for (const m of turns) noGroup.push(strip(await b.say(m)));
      await ctx.prisma.dealerGroup.update({
        where: { id: seeded.dealerGroupId },
        data: { groupSiteTenantId: tenantOf('group') },
      });
      expect(flagOff).toEqual(noGroup);
      expect(JSON.stringify(flagOff)).not.toMatch(/rooftopRef|DEMO0/);
      const row = await groupConversation(a.id());
      expect(
        (row.state as Record<string, unknown>).groupRouting,
      ).toBeUndefined();
    });

    it('a rooftop never sees another rooftop’s inventory, whatever flags it carries', async () => {
      await setFlags('north', { groupSiteShopping: true });
      try {
        const n = visitor('north');
        const gc = await n.say('Show me Grand Cherokees');
        expect(vins(gc)).toEqual(['DEMO00000000000N1', 'DEMO00000000000N2']);
        expect(JSON.stringify(gc)).not.toContain('rooftopRef');
        const rogue = await n.say('Show me a new Rogue');
        expect(rogue.vehicles ?? []).toHaveLength(0);
        // a reference minted for another rooftop does nothing on a rooftop's own token
        const ref = signRooftopRef(
          groupRoutingKey(ctx.app.get(ConfigService).get('JWT_SECRET') ?? ''),
          {
            dealerGroupId: seeded.dealerGroupId,
            tenantId: tenantOf('south'),
            conversationKey: n.id(),
            nowMs: Date.now(),
          },
        );
        const probe = await n.say('', {
          action: 'vehicle_detail',
          vin: S1,
          rooftopRef: ref,
        });
        expect(JSON.stringify(probe)).not.toMatch(/South Side|rooftopRef/);
        expect(vins(probe)).not.toContain(S1);
      } finally {
        await setFlags('north', { groupSiteShopping: false });
      }
    });

    it('a rooftop that has not opted in is never searched', async () => {
      await setFlags('chevy', { groupInventoryListed: false });
      try {
        const r = await visitor().say('Show me a Silverado');
        expect(r.vehicles ?? []).toHaveLength(0);
      } finally {
        await setFlags('chevy', { groupInventoryListed: true });
      }
      const r = await visitor().say('Show me a Silverado');
      expect(vins(r)).toEqual(['DEMO00000000000C1', 'DEMO00000000000C2']);
    });

    it('crossStoreInventory stays reserved: setting it does not enable anything', async () => {
      await setFlags('group', {
        groupSiteShopping: false,
        crossStoreInventory: true,
      });
      try {
        const r = await visitor().say('Show me a Silverado');
        expect(r.vehicles ?? []).toHaveLength(0);
      } finally {
        await setFlags('group', {
          groupSiteShopping: true,
          crossStoreInventory: false,
        });
      }
    });
  });

  // ───────────────────────────────────────── search

  describe('group search across member rooftops', () => {
    const cases: Array<[string, SeedRooftopKey, string]> = [
      ['Show me a Silverado', 'chevy', 'Dial Chevy of Chicago'],
      ['Show me a Nissan Rogue', 'nissan', 'Dial Nissan of Chicago'],
      ['Show me a QX60', 'infiniti', 'INFINITI of Chicago'],
      ['Show me a Wrangler', 'north', 'Jeep of Chicago (North Side)'],
      [
        'Show me a Dodge Durango',
        'south',
        'Dial Chrysler Dodge Jeep Ram of Chicago (South Side)',
      ],
    ];
    it.each(cases)(
      '%s → only %s stock, named and referenced, without asking',
      async (message, key, name) => {
        const r = await visitor().say(message);
        expect(r.vehicles!.length).toBeGreaterThan(0);
        expect(r.reply).not.toMatch(/Which would you like to see/);
        for (const v of r.vehicles!) {
          expect(seeded.rooftops[key].vins).toContain(v.vin);
          expect(v.rooftopName).toBe(name);
          expect(v.rooftopRef).toMatch(/^rr1\.[0-9a-z]+\.[A-Za-z0-9_-]{22}$/);
          // opaque: no tenant id, location id or slug inside the reference
          expect(v.rooftopRef).not.toContain(tenantOf(key));
          expect(v.rooftopRef).not.toContain(seeded.rooftops[key].slug);
        }
        expect(JSON.stringify(r)).not.toContain(tenantOf(key));
      },
    );

    it('a broad search spans rooftops with the owning store on every card', async () => {
      const r = await visitor().say('show me trucks under 60000');
      const names = new Set(r.vehicles!.map((v) => v.rooftopName));
      expect(names.size).toBeGreaterThan(1);
      expect(r.vehicles!.every((v) => !!v.rooftopName && !!v.rooftopRef)).toBe(
        true,
      );
      expect(r.reply).toMatch(/separate stores — each card names the store/);
    });

    it('a non-member tenant’s vehicles never appear (same brand, opted-in flags on itself)', async () => {
      const r = await visitor().say('Show me a Nissan Rogue');
      for (const v of r.vehicles!) expect(v.vin).not.toMatch(/^RIVL/);
      expect(vins(r)).toEqual(['DEMO0000000000NR1', 'DEMO0000000000NR2']);
    });

    it('each rooftop’s own rules apply: sold units are suppressed; a stale rooftop is not searched', async () => {
      const nissan = tenantOf('nissan');
      await ctx.prisma.vehicle.updateMany({
        where: { tenantId: nissan, vin: 'DEMO0000000000NR2' },
        data: { status: 'SOLD' },
      });
      expect(vins(await visitor().say('Show me a Nissan Rogue'))).toEqual([
        'DEMO0000000000NR1',
      ]);
      await ctx.prisma.vehicle.updateMany({
        where: { tenantId: nissan },
        data: { status: 'AVAILABLE', freshnessState: 'STALE' },
      });
      try {
        // the rooftop's own search refuses stale inventory — so does the group's
        const own = await visitor('nissan').say('Show me a Nissan Rogue');
        expect(own.vehicles ?? []).toHaveLength(0);
        const viaGroup = await visitor().say('Show me a Nissan Rogue');
        expect(viaGroup.vehicles ?? []).toHaveLength(0);
      } finally {
        await ctx.prisma.vehicle.updateMany({
          where: { tenantId: nissan },
          data: { freshnessState: 'FRESH' },
        });
      }
    });
  });

  // ───────────────────────────────────────── Jeep North / South / either

  describe('Jeep disambiguation', () => {
    const NORTH = ['DEMO00000000000N1', 'DEMO00000000000N2'];
    const SOUTH = ['DEMO00000000000S1', 'DEMO00000000000S2'];

    it('EN: asks once, shows nothing yet; either → both stores, labelled; then a side can be changed', async () => {
      const v = visitor();
      const ask = await v.say('Show me 2026 Grand Cherokees');
      expect(ask.vehicles ?? []).toHaveLength(0);
      expect(ask.reply).toMatch(/Jeep of Chicago \(North Side\)/);
      expect(ask.reply).toMatch(
        /Dial Chrysler Dodge Jeep Ram of Chicago \(South Side\)/,
      );
      expect(ask.reply).toMatch(/North Side, South Side, or either\?/);
      expect(ask.quickReplies).toEqual(['North Side', 'South Side', 'Either']);
      expect(ask.reply).not.toMatch(/\bour Jeep store\b/i);

      const both = await v.say('Either');
      expect(vins(both)).toEqual([...NORTH, ...SOUTH].sort());
      for (const x of both.vehicles!)
        expect(x.rooftopName).toBe(
          NORTH.includes(x.vin)
            ? 'Jeep of Chicago (North Side)'
            : 'Dial Chrysler Dodge Jeep Ram of Chicago (South Side)',
        );
      // one reference per rooftop, never shared between the two Jeep stores
      const refs = new Map(
        both.vehicles!.map((x) => [x.rooftopName, x.rooftopRef]),
      );
      expect(new Set(refs.values()).size).toBe(2);

      const south = await v.say('Actually just the South Side ones');
      expect(vins(south)).toEqual(SOUTH);
      const north = await v.say('switch to north');
      expect(vins(north)).toEqual(NORTH);
      // remembered: a later search is not asked again and stays on the chosen side
      const again = await v.say('Show me Grand Cherokees');
      expect(again.reply).not.toMatch(/North Side, South Side, or either/);
      expect(vins(again)).toEqual(NORTH);
    });

    it('EN: a stated side shows only that rooftop', async () => {
      const v = visitor();
      await v.say('Show me 2026 Grand Cherokees');
      expect(vins(await v.say('North Side'))).toEqual(NORTH);
      const w = visitor();
      await w.say('Show me 2026 Grand Cherokees');
      expect(vins(await w.say('South Side'))).toEqual(SOUTH);
      // said up front: no question at all
      const x = visitor();
      const direct = await x.say(
        'Show me Grand Cherokees at the south side store',
      );
      expect(vins(direct)).toEqual(SOUTH);
    });

    it('ES: asks Norte / Sur / cualquiera and honours the answer', async () => {
      const v = visitor();
      const ask = await v.say('Muéstreme Grand Cherokee 2026', {
        language: 'es',
      });
      expect(ask.vehicles ?? []).toHaveLength(0);
      expect(ask.reply).toMatch(/Lado Norte, Lado Sur, o cualquiera\?/);
      expect(ask.quickReplies).toEqual([
        'Lado Norte',
        'Lado Sur',
        'Cualquiera',
      ]);
      expect(ask.conversation.language).toBe('es');
      const sur = await v.say('Lado Sur', { language: 'es' });
      expect(vins(sur)).toEqual(SOUTH);
      expect(sur.vehicles![0].rooftopName).toBe(
        'Dial Chrysler Dodge Jeep Ram of Chicago (Lado Sur)',
      );
      const w = visitor();
      await w.say('Muéstreme Grand Cherokee 2026', { language: 'es' });
      const all = await w.say('Cualquiera', { language: 'es' });
      expect(vins(all)).toEqual([...NORTH, ...SOUTH].sort());
      const x = visitor();
      await x.say('Muéstreme Grand Cherokee 2026', { language: 'es' });
      expect(vins(await x.say('norte', { language: 'es' }))).toEqual(NORTH);
    });

    it('asks only once: an ignored question is not repeated, results come labelled', async () => {
      const v = visitor();
      await v.say('Show me 2026 Grand Cherokees');
      const again = await v.say('Show me 2026 Grand Cherokees');
      expect(again.reply).not.toMatch(/North Side, South Side, or either/);
      expect(again.vehicles!.every((x) => !!x.rooftopName)).toBe(true);
      expect(again.vehicles!.length).toBe(4);
    });

    it('only one Jeep store has the model → no question', async () => {
      const r = await visitor().say('Show me a Wrangler');
      expect(vins(r)).toEqual(['DEMO00000000000N3']);
      expect(r.reply).not.toMatch(/Which would you like to see/);
    });

    it('“the Jeep store” is never resolved to one of them', async () => {
      const v = visitor();
      const r = await v.say('I want to visit the Jeep store');
      expect(r.reply).toMatch(/separate stores/);
      expect(r.quickReplies).toEqual([
        'Dial Chrysler Dodge Jeep Ram of Chicago (South Side)',
        'Jeep of Chicago (North Side)',
      ]);
    });
  });

  // ───────────────────────────────────────── ownership follows the vehicle

  describe('ownership follows the vehicle', () => {
    beforeAll(wipe);

    let north: Awaited<ReturnType<typeof toLeadForm>>;
    let northLeadId: string;
    let northDeliveryId: string;

    it('a North vehicle: form, picker, booking, receipt and delivery all belong to North — and only North', async () => {
      const before = await snapshot();
      for (const k of [...KEYS, 'group', 'rival'])
        expect(before[k]).toEqual(NONE);

      north = await toLeadForm(N1);
      const form = card<{
        id: string;
        rooftopName: string;
        vin: string;
        consent: { version: string };
      }>(north.form, 'lead_form')!;
      expect(form.rooftopName).toBe('Jeep of Chicago (North Side)');
      expect(form.vin).toBe(N1);
      expect(form.consent.version).toBe(LEAD_FORM_CONSENT_VERSION);
      // nothing exists yet: showing a form creates no record anywhere
      expect((await snapshot()).north).toEqual(NONE);

      const submitted = await north.v.say('', {
        action: 'lead_capture',
        lead: lead(form.id),
      });
      const picker = card<{
        id: string;
        rooftopName: string;
        mode: string;
        slots: Array<{ id: string; start: string }>;
      }>(submitted, 'appointment_picker')!;
      expect(picker.rooftopName).toBe('Jeep of Chicago (North Side)');
      expect(picker.mode).toBe('provider_slots');

      const booked = await north.v.say('', {
        action: 'appointment_select',
        appointment: { pickerId: picker.id, slotId: picker.slots[0].id },
      });
      const appt = card<{
        outcome: string;
        verified: boolean;
        providerRef: string;
        rooftopName: string;
        sandbox: boolean;
      }>(booked, 'appointment')!;
      expect(appt).toMatchObject({
        outcome: 'confirmed',
        verified: true,
        rooftopName: 'Jeep of Chicago (North Side)',
        sandbox: true,
      });
      expect(appt.providerRef).toMatch(/^SBX-/);

      const tenantId = tenantOf('north');
      const locationId = seeded.rooftops.north.locationId;
      const leads = await ctx.prisma.lead.findMany({ where: { tenantId } });
      expect(leads).toHaveLength(1);
      northLeadId = leads[0].id;
      expect(leads[0]).toMatchObject({
        tenantId,
        locationId,
        email: EMAIL,
        interestedVin: N1,
        source: 'group_site',
      });
      // the lead hangs off a NORTH conversation whose key is not a widget conversation id
      const ownerConv = await ctx.prisma.conversation.findUniqueOrThrow({
        where: { id: leads[0].conversationId! },
      });
      expect(ownerConv.tenantId).toBe(tenantId);
      expect(ownerConv.externalKey).toMatch(/^grp1\./);
      expect(ownerConv.externalKey).not.toBe(north.v.id());

      const consents = await ctx.prisma.consentRecord.findMany({
        where: { tenantId },
      });
      expect(consents.map((c) => c.channel).sort()).toEqual(['CALL', 'EMAIL']);
      for (const c of consents)
        expect(c).toMatchObject({
          tenantId,
          locationId,
          granted: true,
          source: 'WIDGET',
          wordingVersion: LEAD_FORM_CONSENT_VERSION,
          conversationExternalKey: ownerConv.externalKey,
        });

      const appts = await ctx.prisma.appointment.findMany({
        where: { tenantId },
        include: { providerReceipts: true },
      });
      expect(appts).toHaveLength(1);
      expect(appts[0]).toMatchObject({
        tenantId,
        locationId,
        status: 'CONFIRMED',
        vehicleVin: N1,
        conversationId: ownerConv.id,
        externalProviderId: appt.providerRef,
      });
      expect(appts[0].provenance).toMatchObject({ origin: 'group_site' });
      expect(appts[0].providerReceipts).toHaveLength(1);
      expect(appts[0].providerReceipts[0]).toMatchObject({
        tenantId,
        status: 'CONFIRMED',
        sandbox: true,
        providerRef: appt.providerRef,
      });

      const deliveries = await ctx.prisma.leadDelivery.findMany({
        where: { tenantId },
      });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        tenantId,
        locationId,
        leadId: northLeadId,
        department: 'SALES',
      });
      northDeliveryId = deliveries[0].id;

      // explicit absence: the group tenant and the other four rooftops hold nothing
      const after = await snapshot();
      for (const k of [
        'chevy',
        'nissan',
        'infiniti',
        'south',
        'group',
        'rival',
      ])
        expect(after[k]).toEqual(NONE);

      // the trail of what was created for the rooftop from the group site
      const audit = await ctx.prisma.auditLog.findMany({
        where: { tenantId, action: { startsWith: 'group_site.' } },
      });
      const actions = audit.map((a) => a.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'group_site.rooftop_conversation_opened',
          'group_site.lead_created',
          'group_site.consent_recorded',
          'group_site.appointment_created',
        ]),
      );
      expect(
        audit.find((a) => a.action === 'group_site.lead_created'),
      ).toMatchObject({
        resource: 'Lead',
        resourceId: northLeadId,
      });
      expect(JSON.stringify(audit)).not.toContain(EMAIL);
      expect(JSON.stringify(audit)).not.toContain('Rivera');
      expect(
        await ctx.prisma.auditLog.count({
          where: {
            tenantId: { in: [tenantOf('south'), tenantOf('group')] },
            action: {
              in: ['group_site.lead_created', 'group_site.appointment_created'],
            },
          },
        }),
      ).toBe(0);
    });

    it('the group conversation holds no contact detail and no link to the rooftop’s records', async () => {
      const row = await groupConversation(north.v.id());
      const dump = JSON.stringify(row);
      for (const secret of [EMAIL, PHONE, '3125550142', 'Rivera', northLeadId])
        expect(dump).not.toContain(secret);
      const state = row.state as Record<string, any>;
      expect(state.contact).toEqual({});
      expect(state.leadId).toBeUndefined();
      expect(state.appointment).toBeUndefined();
      expect(state.groupRouting.bound.tenantId).toBe(tenantOf('north'));
      expect(
        row.messages.some((m) =>
          /continued with Jeep of Chicago/.test(m.content),
        ),
      ).toBe(true);
    });

    it('the journey continues with the same rooftop: the appointment is still known', async () => {
      const r = await north.v.say('What time is my appointment?');
      expect(JSON.stringify(r.journey)).toMatch(/appointment/);
      expect(
        await ctx.prisma.appointment.count({
          where: { tenantId: tenantOf('group') },
        }),
      ).toBe(0);
      const cancel = await north.v.say('Please cancel my appointment');
      expect(cancel.reply.length).toBeGreaterThan(0);
      const a = await ctx.prisma.appointment.findFirstOrThrow({
        where: { tenantId: tenantOf('north') },
      });
      expect(['CANCELLED', 'CONFIRMED']).toContain(a.status);
      expect((await snapshot()).south).toEqual(NONE);
    });

    it('ADF: the North lead is delivered to North’s sandbox sink only', async () => {
      const d = await attempt(northDeliveryId);
      expect(d.status).toBe('ACCEPTED');
      expect(d.tenantId).toBe(tenantOf('north'));
      // whenever the outbox ran, this delivery produced exactly one message, to North
      const sent = sink.messages().filter((m) => m.deliveryId === d.id);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(address.north);
      expect(sent[0].tenantId).toBe(tenantOf('north'));
      expect(sent[0].xml).toContain('Jeep of Chicago');
      for (const k of ['south', 'chevy', 'nissan', 'infiniti'] as const) {
        // nothing at all has been addressed to the other four rooftops
        expect(sink.messages().filter((m) => m.to === address[k])).toHaveLength(
          0,
        );
        expect(sent[0].raw).not.toContain(address[k]);
        expect(sent[0].xml).not.toContain(seeded.rooftops[k].name);
      }
    });

    it('ADF: a South vehicle’s lead is delivered to South’s sandbox sink only', async () => {
      const s = await toLeadForm(S1);
      const form = card<{ id: string; rooftopName: string }>(
        s.form,
        'lead_form',
      )!;
      expect(form.rooftopName).toBe(
        'Dial Chrysler Dodge Jeep Ram of Chicago (South Side)',
      );
      const northBefore = await records(tenantOf('north'));
      await s.v.say('', {
        action: 'lead_capture',
        lead: lead(form.id, {
          firstName: 'Sam',
          lastName: 'Okafor',
          email: 'sam.okafor@example.invalid',
          phone: '312-555-0155',
        }),
      });
      const tenantId = tenantOf('south');
      const leads = await ctx.prisma.lead.findMany({ where: { tenantId } });
      expect(leads).toHaveLength(1);
      expect(leads[0]).toMatchObject({
        interestedVin: S1,
        source: 'group_site',
        locationId: seeded.rooftops.south.locationId,
      });
      const deliveries = await ctx.prisma.leadDelivery.findMany({
        where: { tenantId },
      });
      expect(deliveries).toHaveLength(1);
      const d = await attempt(deliveries[0].id);
      expect(d.status).toBe('ACCEPTED');
      const sent = sink.messages().filter((m) => m.deliveryId === d.id);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(address.south);
      expect(sent[0].xml).toContain('Dial Chrysler Dodge Jeep Ram of Chicago');
      for (const k of ['north', 'chevy', 'nissan', 'infiniti'] as const) {
        const toOther = sink.messages().filter((m) => m.to === address[k]);
        // North's sink holds only North's own lead; the other three hold nothing
        expect(
          toOther.every((m) => k === 'north' && !m.xml.includes(leads[0].id)),
        ).toBe(true);
        expect(sent[0].raw).not.toContain(address[k]);
      }
      // North gained nothing from the South request; the group still holds nothing
      expect(await records(tenantOf('north'))).toEqual(northBefore);
      expect(await records(tenantOf('group'))).toEqual(NONE);
      expect(
        await ctx.prisma.lead.count({
          where: {
            tenantId: tenantOf('north'),
            email: 'sam.okafor@example.invalid',
          },
        }),
      ).toBe(0);
    });

    it('typed references work on the mixed list: “the second one” is the second card, at its own store', async () => {
      const v = visitor();
      await v.say('Show me 2026 Grand Cherokees');
      const both = await v.say('Either');
      const second = both.vehicles![1];
      const third = both.vehicles![2];
      const a = await v.say('the second one');
      expect(vins(a)).toEqual([second.vin]);
      expect(a.vehicles![0].rooftopName).toBe(second.rooftopName);
      const b = await v.say('actually the third one');
      expect(vins(b)).toEqual([third.vin]);
      expect(b.vehicles![0].rooftopName).toBe(third.rooftopName);
    });

    it('no PII reaches the logs while a group-site lead is captured', async () => {
      const s = await toLeadForm('DEMO00000000000N2');
      const form = card<{ id: string }>(s.form, 'lead_form')!;
      const written: string[] = [];
      const capture = (chunk: unknown) => {
        written.push(String(chunk));
        return true;
      };
      const spies = [
        jest.spyOn(process.stdout, 'write').mockImplementation(capture),
        jest.spyOn(process.stderr, 'write').mockImplementation(capture),
        ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
          jest.spyOn(console, m).mockImplementation((...a: unknown[]) => {
            written.push(
              a.map((x) => JSON.stringify(x) ?? String(x)).join(' '),
            );
          }),
        ),
      ];
      try {
        await s.v.say('', {
          action: 'lead_capture',
          lead: lead(form.id, {
            email: 'log.probe@example.invalid',
            phone: '312-555-0163',
            lastName: 'Logprobe',
          }),
        });
        await s.v.say('my other number is 312-555-0164');
        await new Promise((x) => setTimeout(x, 300));
      } finally {
        spies.forEach((x) => x.mockRestore());
      }
      const logs = written.join('\n');
      expect(logs).toContain('/api/chat'); // the capture is real
      for (const secret of [
        'log.probe@example.invalid',
        '312-555-0163',
        '3125550163',
        '312-555-0164',
        'Logprobe',
      ])
        expect(logs).not.toContain(secret);
      expect(logs).not.toMatch(/555-01\d\d/);
    });
  });

  // ───────────────────────────────────────── switching rooftops

  describe('switching vehicles across rooftops', () => {
    beforeAll(wipe);

    it('contact and consent are never carried to the second rooftop; it must be given them again', async () => {
      const { v, form, both } = await toLeadForm(N1);
      await v.say('', {
        action: 'lead_capture',
        lead: lead(card<{ id: string }>(form, 'lead_form')!.id),
      });
      const north = await records(tenantOf('north'));
      expect(north.leads).toBe(1);
      expect(north.consents).toBe(2);
      const northFormId = card<{ id: string }>(form, 'lead_form')!.id;

      // the customer now picks a South vehicle
      const s1 = both.vehicles!.find((x) => x.vin === S1)!;
      const moved = await v.say('', {
        action: 'vehicle_detail',
        vin: S1,
        rooftopRef: s1.rooftopRef,
      });
      expect(moved.reply).toMatch(
        /at Dial Chrysler Dodge Jeep Ram of Chicago \(South Side\), a separate store/,
      );
      expect(moved.reply).toMatch(
        /stay with Jeep of Chicago \(North Side\) — I have not shared them/,
      );
      expect(vins(moved)).toEqual([S1]);
      // nothing was copied: South has no lead, no consent, no contact in its conversation
      expect(await records(tenantOf('south'))).toEqual(NONE);
      const southConv = await ctx.prisma.conversation.findFirstOrThrow({
        where: {
          tenantId: tenantOf('south'),
          externalKey: { startsWith: 'grp1.' },
        },
      });
      expect(JSON.stringify(southConv.state)).not.toContain(EMAIL);
      expect(JSON.stringify(southConv.state)).not.toContain('Rivera');
      expect((southConv.state as Record<string, any>).contact).toEqual({});

      // asking for a test drive at South gets South's OWN form, not a silent booking
      const ask = await v.say('Can I test drive it?');
      const southForm = card<{ id: string; rooftopName: string }>(
        ask,
        'lead_form',
      )!;
      expect(southForm.rooftopName).toBe(
        'Dial Chrysler Dodge Jeep Ram of Chicago (South Side)',
      );
      expect(southForm.id).not.toBe(northFormId);
      expect(await records(tenantOf('south'))).toEqual(NONE);

      // replaying the NORTH form at South stores nothing
      const replay = await v.say('', {
        action: 'lead_capture',
        lead: lead(northFormId),
      });
      expect(card(replay, 'lead_form')).toBeDefined();
      expect(await records(tenantOf('south'))).toEqual(NONE);

      // fresh confirmation: the customer submits South's form, ticking EMAIL only
      await v.say('', {
        action: 'lead_capture',
        lead: lead(southForm.id, {
          phone: undefined,
          consents: [
            {
              channel: 'EMAIL',
              granted: true,
              version: LEAD_FORM_CONSENT_VERSION,
            },
          ],
        }),
      });
      const southConsents = await ctx.prisma.consentRecord.findMany({
        where: { tenantId: tenantOf('south') },
      });
      expect(southConsents.map((c) => c.channel)).toEqual(['EMAIL']);
      expect(southConsents[0].locationId).toBe(
        seeded.rooftops.south.locationId,
      );
      const southLead = await ctx.prisma.lead.findFirstOrThrow({
        where: { tenantId: tenantOf('south') },
      });
      expect(southLead).toMatchObject({
        email: EMAIL,
        interestedVin: S1,
        phone: null,
      });
      // North is exactly as it was: still its own lead and its own two consents
      expect(await records(tenantOf('north'))).toEqual(north);
      const northLead = await ctx.prisma.lead.findFirstOrThrow({
        where: { tenantId: tenantOf('north') },
      });
      expect(northLead.interestedVin).toBe(N1);
      expect(await records(tenantOf('group'))).toEqual(NONE);
      // the notice is given once, not on every later turn
      const later = await v.say('What would the payment look like?');
      expect(later.reply).not.toMatch(/a separate store/);
    });

    it('“book me at the South store for this North VIN”: truthful, nothing moved or created', async () => {
      await wipe();
      for (const [message, language, expected] of [
        [
          `I saw VIN ${N1} at the North store, book me at the South store for it`,
          'en',
          /is at Jeep of Chicago \(North Side\), not at Dial Chrysler Dodge Jeep Ram of Chicago \(South Side\)/,
        ],
        [
          `Vi el VIN ${N1} en la agencia norte, agéndeme en la sur para verlo`,
          'es',
          /está en Jeep of Chicago \(Lado Norte\), no en Dial Chrysler Dodge Jeep Ram of Chicago \(Lado Sur\)/,
        ],
      ] as const) {
        const v = visitor();
        const r = await v.say(message, { language });
        expect(r.reply).toMatch(expected);
        expect(r.reply).not.toMatch(
          /we(?:'ll| will) (?:bring|transfer|move) it|(?:lo|la) (?:traemos|transferimos)/i,
        );
        expect(r.cards).toEqual([]);
        expect(r.quickReplies).toHaveLength(2);
        const after = await snapshot();
        for (const k of [...KEYS, 'group']) expect(after[k]).toEqual(NONE);
        // the vehicle did not move
        expect(
          await ctx.prisma.vehicle.count({
            where: { vin: N1, tenantId: tenantOf('north') },
          }),
        ).toBe(1);
        expect(
          await ctx.prisma.vehicle.count({
            where: { vin: N1, tenantId: tenantOf('south') },
          }),
        ).toBe(0);
        // offered: the owning store — taking it up lands in NORTH
        const next = await v.say(r.quickReplies[0], { language });
        expect(
          card<{ rooftopName: string }>(next, 'lead_form')?.rooftopName,
        ).toMatch(/^Jeep of Chicago/);
        expect((await snapshot()).south).toEqual(NONE);
      }
    });
  });

  // ───────────────────────────────────────── refusals

  describe('forged references and non-member vehicles', () => {
    beforeAll(wipe);
    const key = () =>
      groupRoutingKey(ctx.app.get(ConfigService).get('JWT_SECRET') ?? '');
    const untouched = async () => {
      const after = await snapshot();
      for (const k of [...KEYS, 'group', 'rival'])
        expect(after[k]).toEqual(NONE);
      expect(
        await ctx.prisma.conversation.count({
          where: {
            externalKey: { startsWith: 'grp1.' },
            tenantId: { in: KEYS.map(tenantOf) },
          },
        }),
      ).toBe(0);
    };

    it('a forged reference is refused and creates nothing', async () => {
      const v = visitor();
      await v.say('Show me 2026 Grand Cherokees');
      const both = await v.say('Either');
      const good = both.vehicles!.find((x) => x.vin === N1)!.rooftopRef!;
      const flipped = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
      for (const rooftopRef of [
        flipped,
        'rr1.zzzzzz.AAAAAAAAAAAAAAAAAAAAAA',
        tenantOf('north'),
        'north',
      ]) {
        const r = await v.say('', {
          action: 'test_drive',
          vin: N1,
          rooftopRef,
        });
        expect(r.reply).toMatch(/couldn’t verify which store/);
        expect(r.cards).toEqual([]);
      }
      await untouched();
    });

    it('an expired reference, another conversation’s reference and another group’s reference are refused', async () => {
      const v = visitor();
      await v.say('hello');
      const mint = (over: Record<string, unknown>) =>
        signRooftopRef(key(), {
          dealerGroupId: seeded.dealerGroupId,
          tenantId: tenantOf('north'),
          conversationKey: v.id(),
          nowMs: Date.now(),
          ...over,
        });
      // sanity: a correctly minted reference for THIS conversation is accepted
      const expired = mint({ nowMs: Date.now() - 3 * 24 * 3600 * 1000 });
      const otherConversation = mint({
        conversationKey: visitor().id() ?? 'cv1.other',
      });
      const otherGroup = mint({ dealerGroupId: 'another-dealer-group' });
      const nonMember = mint({ tenantId: rivalTenantId });
      for (const rooftopRef of [
        expired,
        otherConversation,
        otherGroup,
        nonMember,
      ]) {
        const r = await v.say('', {
          action: 'test_drive',
          vin: N1,
          rooftopRef,
        });
        expect(r.reply).toMatch(/couldn’t verify which store/);
      }
      await untouched();
      const ok = await v.say('', {
        action: 'test_drive',
        vin: N1,
        rooftopRef: mint({}),
      });
      expect(card(ok, 'lead_form')).toBeDefined();
    });

    it('a valid reference for one Jeep store cannot be used with the other store’s vehicle', async () => {
      await wipe();
      const v = visitor();
      await v.say('Show me 2026 Grand Cherokees');
      const both = await v.say('Either');
      const southRef = both.vehicles!.find((x) => x.vin === S1)!.rooftopRef!;
      const r = await v.say('', {
        action: 'test_drive',
        vin: N1,
        rooftopRef: southRef,
      });
      expect(r.reply).toMatch(/couldn’t verify which store/);
      await untouched();
    });

    it('a VIN held by a non-member tenant is refused and creates nothing', async () => {
      const v = visitor();
      for (const body of [
        { action: 'test_drive', vin: RIVAL_VEHICLES[0].vin },
        { action: 'vehicle_detail', vin: RIVAL_VEHICLES[1].vin },
      ]) {
        const r = await v.say('', body);
        expect(r.reply).toMatch(
          /couldn’t find that vehicle in the current inventory of our stores/,
        );
        expect(r.vehicles ?? []).toHaveLength(0);
        expect(JSON.stringify(r)).not.toContain('47777');
      }
      const typed = await v.say(
        `I want to test drive VIN ${RIVAL_VEHICLES[0].vin}`,
      );
      expect(typed.vehicles ?? []).toHaveLength(0);
      await untouched();
    });

    it('a structured submission with no rooftop stores nothing', async () => {
      const v = visitor();
      await v.say('hello');
      const r = await post('group', {
        action: 'lead_capture',
        conversationId: v.id(),
        lead: lead('lf_forgedform0001'),
      });
      expect(r.status).toBe(201);
      await untouched();
      const row = await groupConversation(v.id());
      expect(JSON.stringify(row)).not.toContain(EMAIL);
    });
  });

  // ───────────────────────────────────────── no rooftop yet; service and parts

  describe('no rooftop determined yet', () => {
    beforeEach(wipe);
    const STORES = [
      'Dial Chevy of Chicago',
      'Dial Chrysler Dodge Jeep Ram of Chicago (South Side)',
      'Dial Nissan of Chicago',
      'INFINITI of Chicago',
      'Jeep of Chicago (North Side)',
    ];

    it('general questions create nothing anywhere', async () => {
      const v = visitor();
      await v.say('Hi there');
      await v.say('Do you sell used cars?');
      const after = await snapshot();
      for (const k of [...KEYS, 'group']) expect(after[k]).toEqual(NONE);
    });

    it('a handoff with no store asks which store — no rooftop is guessed, nothing is created', async () => {
      const v = visitor();
      const r = await v.say('I want to talk to a person');
      expect(r.reply).toMatch(/Which store would you like\?/);
      expect(r.quickReplies).toEqual(STORES);
      expect(r.cards).toEqual([]);
      const after = await snapshot();
      for (const k of [...KEYS, 'group']) expect(after[k]).toEqual(NONE);
      // choosing the store hands the SAME request to that rooftop only
      const chosen = await v.say('Dial Nissan of Chicago');
      expect(card(chosen, 'handoff')).toBeDefined();
      const done = await snapshot();
      expect(done.nissan.escalations).toBe(1);
      for (const k of ['chevy', 'infiniti', 'south', 'north', 'group'])
        expect(done[k]).toEqual(NONE);
    });

    it('contact details typed before a store is chosen are not stored against the group', async () => {
      const v = visitor();
      const r = await v.say('My name is Ana Lopez, call me at 312-555-0177');
      expect(r.reply).toMatch(
        /haven’t saved or passed on those contact details/,
      );
      const after = await snapshot();
      for (const k of [...KEYS, 'group']) expect(after[k]).toEqual(NONE);
      const row = await groupConversation(v.id());
      const dump = JSON.stringify(row);
      expect(dump).not.toContain('312-555-0177');
      expect(dump).not.toContain('Lopez');
      const next = await v.say('INFINITI of Chicago');
      expect(next.reply).toMatch(/now with INFINITI of Chicago/);
      expect(await snapshot()).toEqual(after);
    });

    it('groupHandoffQueue on: a handoff with no store goes to the group’s own queue, never to a guessed rooftop', async () => {
      await setFlags('group', { groupHandoffQueue: true });
      try {
        const v = visitor();
        const r = await v.say('I want to talk to a person');
        expect(card(r, 'handoff')).toBeDefined();
        expect(r.reply).not.toMatch(/Which store would you like\?/);
        const done = await snapshot();
        expect(done.group.escalations).toBe(1);
        // an escalation only: no lead, consent, appointment or delivery in the group tenant
        expect({ ...done.group, escalations: 0 }).toEqual(NONE);
        for (const k of KEYS) expect(done[k]).toEqual(NONE);
      } finally {
        await setFlags('group', { groupHandoffQueue: false });
      }
    });

    it('the stream endpoint routes exactly like the plain one: asks which Jeep store, then shows both, labelled', async () => {
      const stream = async (body: Record<string, unknown>) => {
        const r = await http()
          .post('/api/chat/stream')
          .set('Authorization', `Bearer ${widget.group}`)
          .set('Origin', SIM_ORIGIN)
          .send(body);
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toContain('text/event-stream');
        const events = r.text
          .split('\n\n')
          .map((f) =>
            f
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim())
              .join('\n'),
          )
          .filter(Boolean)
          .map((d) => JSON.parse(d) as { type: string; response?: Chat });
        const types = events.map((e) => e.type);
        expect(types[0]).toBe('turn.started');
        expect(types[types.length - 1]).toBe('turn.completed');
        expect(types).not.toContain('turn.error');
        return events[events.length - 1].response as Chat;
      };
      const asked = await stream({ message: 'Show me 2026 Grand Cherokees' });
      expect(asked.vehicles ?? []).toHaveLength(0);
      expect(asked.reply).toMatch(/North Side/);
      expect(asked.reply).toMatch(/South Side/);
      const both = await stream({
        message: 'Either',
        conversationId: asked.conversationId,
      });
      const stores = new Set(
        (both.vehicles ?? []).map(
          (x) => (x as unknown as { rooftopName: string }).rooftopName,
        ),
      );
      expect(stores).toEqual(
        new Set([
          'Jeep of Chicago (North Side)',
          'Dial Chrysler Dodge Jeep Ram of Chicago (South Side)',
        ]),
      );
      // the same turns through the plain endpoint give the same vehicles
      const v = visitor();
      await v.say('Show me 2026 Grand Cherokees');
      expect(vins(await v.say('Either'))).toEqual(vins(both));
      const after = await snapshot();
      for (const k of [...KEYS, 'group']) expect(after[k]).toEqual(NONE);
    });

    it('service: asks which store; the two Jeep stores are never one counter', async () => {
      const v = visitor();
      const ask = await v.say('I need an oil change');
      expect(ask.reply).toMatch(/Which store would you like\?/);
      expect(ask.quickReplies).toEqual(STORES);
      const jeep = await v.say('the Jeep store');
      expect(jeep.reply).toMatch(/separate stores/);
      expect(jeep.quickReplies).toEqual([
        'Dial Chrysler Dodge Jeep Ram of Chicago (South Side)',
        'Jeep of Chicago (North Side)',
      ]);
      let after = await snapshot();
      for (const k of [...KEYS, 'group']) expect(after[k]).toEqual(NONE);
      const north = await v.say('North Side');
      expect(north.reply).toMatch(/oil change/i);
      // the service journey now runs in NORTH's tenant, and only there
      await v.say('It is a 2021 Jeep Compass');
      const opened = await ctx.prisma.conversation.findMany({
        where: {
          externalKey: { startsWith: 'grp1.' },
          tenantId: { in: KEYS.map(tenantOf) },
        },
      });
      expect(opened).toHaveLength(1);
      expect(opened[0].tenantId).toBe(tenantOf('north'));
      expect(opened[0].state).toMatchObject({
        department: 'service',
        groupOrigin: { v: 1 },
      });
      expect(JSON.stringify(opened[0].state)).toMatch(/oil change/i);
      after = await snapshot();
      for (const k of ['chevy', 'nissan', 'infiniti', 'south', 'group'])
        expect(after[k]).toEqual(NONE);
    });

    it('ES service and parts: asks which store; parts go to the chosen store only', async () => {
      const v = visitor();
      const ask = await v.say('Necesito un cambio de aceite', {
        language: 'es',
      });
      expect(ask.reply).toMatch(/¿Qué tienda prefiere\?/);
      expect(ask.quickReplies).toContain('Jeep of Chicago (Lado Norte)');

      const w = visitor();
      const parts = await w.say('I need brake pads for my truck');
      expect(parts.reply).toMatch(/Which store would you like\?/);
      const south = await w.say('Dial Jeep');
      expect(card(south, 'parts')).toBeDefined();
      const after = await snapshot();
      expect(after.south.parts).toBe(1);
      for (const k of ['chevy', 'nissan', 'infiniti', 'north', 'group'])
        expect(after[k]).toEqual(NONE);
    });
  });

  // ───────────────────────────────────────── access control

  describe('access control', () => {
    let leadId: string;
    let deliveryId: string;
    let appointmentId: string;
    let groupConversationId: string;
    let northConversationId: string;
    const get = (k: SeedRooftopKey | 'group', path: string, token = staff[k]) =>
      http().get(`/api${path}`).set('Authorization', `Bearer ${token}`);

    beforeAll(async () => {
      await wipe();
      const { v, form } = await toLeadForm(N1);
      const submitted = await v.say('', {
        action: 'lead_capture',
        lead: lead(card<{ id: string }>(form, 'lead_form')!.id),
      });
      const picker = card<{ id: string; slots: Array<{ id: string }> }>(
        submitted,
        'appointment_picker',
      )!;
      await v.say('', {
        action: 'appointment_select',
        appointment: { pickerId: picker.id, slotId: picker.slots[0].id },
      });
      const tenantId = tenantOf('north');
      const l = await ctx.prisma.lead.findFirstOrThrow({ where: { tenantId } });
      leadId = l.id;
      northConversationId = l.conversationId!;
      deliveryId = (
        await ctx.prisma.leadDelivery.findFirstOrThrow({ where: { tenantId } })
      ).id;
      appointmentId = (
        await ctx.prisma.appointment.findFirstOrThrow({ where: { tenantId } })
      ).id;
      groupConversationId = (await groupConversation(v.id())).id;
    });

    it('a group widget token cannot read any staff or ops endpoint', async () => {
      for (const path of [
        '/leads',
        '/appointments',
        '/ops/lead-deliveries',
        `/ops/lead-deliveries/${deliveryId}`,
        '/ops/inbox',
        `/ops/conversations/${northConversationId}`,
        '/ops/queues',
        '/ops/search?q=Rivera',
        '/ops/customers/profile?email=' + encodeURIComponent(EMAIL),
      ]) {
        const r = await get('group', path, widget.group);
        expect([401, 403]).toContain(r.status);
        expect(JSON.stringify(r.body)).not.toContain(EMAIL);
      }
    });

    it('a rooftop widget token cannot trigger group search or address the rooftop conversation opened from the group', async () => {
      const owner = await ctx.prisma.conversation.findUniqueOrThrow({
        where: { id: northConversationId },
      });
      // presenting the group-opened conversation's key gets a brand-new conversation instead
      const r = await chat('north', {
        message: 'What time is my appointment?',
        conversationId: owner.externalKey,
      });
      expect(r.conversationId).not.toBe(owner.externalKey);
      expect(r.conversationId).toMatch(/^cv1\./);
      expect(JSON.stringify(r)).not.toContain('SBX-');
      const chevy = await visitor('chevy').say('Show me Grand Cherokees');
      expect(chevy.vehicles ?? []).toHaveLength(0);
    });

    it('group-tenant staff cannot read the rooftop’s lead, appointment or delivery — directly or via the group conversation', async () => {
      const leads = await get('group', '/leads');
      expect(leads.status).toBe(200);
      expect(JSON.stringify(leads.body)).not.toContain(EMAIL);
      expect(JSON.stringify(leads.body)).not.toContain(leadId);
      const appts = await get('group', '/appointments');
      expect(JSON.stringify(appts.body)).not.toContain(appointmentId);
      const dels = await get('group', '/ops/lead-deliveries');
      expect(JSON.stringify(dels.body)).not.toContain(deliveryId);
      expect(
        (await get('group', `/ops/lead-deliveries/${deliveryId}`)).status,
      ).toBe(404);
      expect(
        (await get('group', `/ops/conversations/${northConversationId}`))
          .status,
      ).toBe(404);
      // its own (group) conversation is readable, and contains no customer record
      const own = await get(
        'group',
        `/ops/conversations/${groupConversationId}`,
      );
      expect(own.status).toBe(200);
      const dump = JSON.stringify(own.body);
      for (const secret of [
        EMAIL,
        PHONE,
        'Rivera',
        leadId,
        appointmentId,
        'SBX-',
      ])
        expect(dump).not.toContain(secret);
      for (const path of ['/ops/search?q=Rivera', '/ops/inbox']) {
        const r = await get('group', path);
        expect(JSON.stringify(r.body)).not.toContain(EMAIL);
        expect(JSON.stringify(r.body)).not.toContain(leadId);
      }
      // looking the customer up by email finds no lead in the group tenant
      const profile = await get(
        'group',
        '/ops/customers/profile?email=' + encodeURIComponent(EMAIL),
      );
      expect(
        unwrap<{ leads: unknown[]; timeline: unknown[] }>(profile.body),
      ).toMatchObject({ leads: [], timeline: [] });
      expect(JSON.stringify(profile.body)).not.toContain(leadId);
    });

    it('another rooftop’s staff cannot read North’s group-originated lead', async () => {
      for (const k of ['south', 'chevy'] as const) {
        const leads = await get(k, '/leads');
        expect(leads.status).toBe(200);
        expect(JSON.stringify(leads.body)).not.toContain(leadId);
        expect(JSON.stringify(leads.body)).not.toContain(EMAIL);
        expect(
          (await get(k, `/ops/lead-deliveries/${deliveryId}`)).status,
        ).toBe(404);
        expect(
          (await get(k, `/ops/conversations/${northConversationId}`)).status,
        ).toBe(404);
        expect(
          (await get(k, `/ops/conversations/${groupConversationId}`)).status,
        ).toBe(404);
        const appts = await get(k, '/appointments');
        expect(JSON.stringify(appts.body)).not.toContain(appointmentId);
      }
    });

    it('North staff see the lead in their own tenant, marked as from the group site — and nothing of the group conversation', async () => {
      const leads = await get('north', '/leads');
      expect(leads.status).toBe(200);
      const dump = JSON.stringify(leads.body);
      expect(dump).toContain(leadId);
      expect(dump).toContain('group_site');
      const conv = await get(
        'north',
        `/ops/conversations/${northConversationId}`,
      );
      expect(conv.status).toBe(200);
      // the rooftop conversation holds only the turns handled by this rooftop
      expect(JSON.stringify(conv.body)).not.toMatch(
        /North Side, South Side, or either/,
      );
      expect(
        (await get('north', `/ops/conversations/${groupConversationId}`))
          .status,
      ).toBe(404);
    });
  });
});
