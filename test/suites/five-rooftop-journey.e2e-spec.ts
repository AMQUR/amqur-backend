import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { SIM_ORIGIN } from '../helpers/demo-dealer';
import {
  ensureSandboxSchedulerConnection,
  SEED_ROOFTOPS,
  SeededGroup,
  seedGroupRooftops,
  SeedRooftopKey,
} from '../../scripts/lib/group-rooftops-seed';
import { LeadDeliveryRouteService } from '../../src/integrations/adf/lead-delivery-route.service';
import { seedSandboxRoutes } from '../../src/integrations/adf/sandbox-routes.seed';
import { SandboxSinkTransport } from '../../src/integrations/adf/transports/sandbox-sink.transport';
import { OutboxProcessorService } from '../../src/integrations/core/outbox-processor.service';
import { AppointmentService } from '../../src/appointments/appointment.service';

/**
 * The full customer journey, run independently in EACH of the five rooftops on its own site
 * (its own tenant, its own widget token): discovery, sales lead with consent, appointment
 * with a provider receipt, ADF destination, cancellation, service, parts, human takeover and
 * the staff queue, and error recovery. After every store's run, the other four hold nothing.
 * Synthetic "frj-" tenants, DEMO VINs, example.invalid / 555-01xx contacts, sandbox sink and
 * the labelled demo scheduler only.
 */
const PREFIX = 'frj-';
const PASSWORD = 'RooftopJourney123!';
const KEYS: SeedRooftopKey[] = [
  'chevy',
  'nissan',
  'infiniti',
  'south',
  'north',
];
const ENV_KEYS = [
  'OUTBOX_PROCESSOR_ENABLED',
  'ADF_SEND_ENABLED',
  'LEAD_DELIVERY_MODE',
  'ADF_SANDBOX_TRANSPORT',
] as const;

type Card = { kind: string; [k: string]: unknown };
type Chat = {
  type?: string;
  reply: string;
  conversationId: string;
  vehicles?: Array<{ vin: string; rooftopName?: string | null }>;
  cards: Card[];
  quickReplies: string[];
  conversation: { language: string; aiPaused?: boolean };
};

describe('five rooftops: the full journey in each store, independently', () => {
  let ctx: E2eCtx;
  let seeded: SeededGroup;
  let sink: SandboxSinkTransport;
  const prev: Record<string, string | undefined> = {};
  const widget = {} as Record<SeedRooftopKey, string>;
  const staff = {} as Record<SeedRooftopKey, string>;
  const address = {} as Record<SeedRooftopKey, string>;

  const http = () => request(ctx.app.getHttpServer());
  const tenantOf = (k: SeedRooftopKey) => seeded.rooftops[k].tenantId;
  const visitor = (k: SeedRooftopKey, language = 'en') => {
    let conversationId: string | undefined;
    return {
      say: async (message: string, extra: Record<string, unknown> = {}) => {
        const r = await http()
          .post('/api/chat')
          .set('Authorization', `Bearer ${widget[k]}`)
          .set('Origin', SIM_ORIGIN)
          .send({ message, conversationId, language, ...extra });
        expect(r.status).toBe(201);
        const c = unwrap<Chat>(r.body);
        conversationId = c.conversationId;
        return c;
      },
      id: () => conversationId!,
    };
  };
  const card = <T = Card>(r: Chat, kind: string) =>
    r.cards.find((c) => c.kind === kind) as T | undefined;
  const ops = (k: SeedRooftopKey, method: 'get' | 'post', path: string) =>
    http()
      [method](`/api/ops/${path}`)
      .set('Authorization', `Bearer ${staff[k]}`);
  const counts = async (k: SeedRooftopKey) => {
    const tenantId = tenantOf(k);
    const [leads, consents, appointments, receipts, deliveries, escalations] =
      await Promise.all([
        ctx.prisma.lead.count({ where: { tenantId } }),
        ctx.prisma.consentRecord.count({ where: { tenantId } }),
        ctx.prisma.appointment.count({ where: { tenantId } }),
        ctx.prisma.appointmentProviderReceipt.count({ where: { tenantId } }),
        ctx.prisma.leadDelivery.count({ where: { tenantId } }),
        ctx.prisma.escalation.count({ where: { tenantId } }),
      ]);
    return { leads, consents, appointments, receipts, deliveries, escalations };
  };
  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(KEYS.map(async (k) => [k, await counts(k)] as const)),
    ) as Record<SeedRooftopKey, Awaited<ReturnType<typeof counts>>>;

  beforeAll(async () => {
    for (const k of ENV_KEYS) prev[k] = process.env[k];
    process.env.OUTBOX_PROCESSOR_ENABLED = 'false';
    process.env.ADF_SEND_ENABLED = 'true';
    process.env.LEAD_DELIVERY_MODE = 'sandbox';
    process.env.ADF_SANDBOX_TRANSPORT = 'sink';
    ctx = await createE2eApp();
    sink = ctx.app.get(SandboxSinkTransport);
    seeded = await seedGroupRooftops(ctx.prisma, {
      prefix: PREFIX,
      rooftopOrigins: [SIM_ORIGIN],
      groupOrigins: [SIM_ORIGIN],
    });
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
      'cli:five-rooftop-journey-e2e',
    );
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const k of KEYS) {
      const { slug, tenantId } = seeded.rooftops[k];
      address[k] = routes.find((x) => x.slug === slug)!.address;
      const email = `admin@${slug}.test`;
      await ctx.prisma.user.upsert({
        where: { tenantId_email: { tenantId, email } },
        create: {
          tenantId,
          email,
          password: hash,
          firstName: 'Riley',
          lastName: k,
          role: Role.ADMIN,
        },
        update: { password: hash, isActive: true, role: Role.ADMIN },
      });
      widget[k] = unwrap<{ token: string }>(
        (
          await http()
            .post('/api/public/widget-token')
            .set('Origin', SIM_ORIGIN)
            .send({ tenantSlug: slug, locationSlug: 'main' })
        ).body,
      ).token;
      const lb = unwrap<{ access_token?: string; accessToken?: string }>(
        (
          await http()
            .post('/api/auth/login')
            .send({ email, password: PASSWORD })
        ).body,
      );
      staff[k] = lb.access_token || lb.accessToken || '';
    }
    // start from nothing in all five
    for (const k of KEYS) {
      const tenantId = tenantOf(k);
      await ctx.prisma.leadDelivery.deleteMany({ where: { tenantId } });
      await ctx.prisma.appointment.deleteMany({ where: { tenantId } });
      await ctx.prisma.consentRecord.deleteMany({ where: { tenantId } });
      await ctx.prisma.escalation.deleteMany({ where: { tenantId } });
      await ctx.prisma.lead.deleteMany({ where: { tenantId } });
      await ctx.prisma.outboxEvent.deleteMany({ where: { tenantId } });
    }
  });

  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await ctx.app.close();
  });

  describe.each(KEYS)('%s', (k) => {
    const mine = () => SEED_ROOFTOPS[k];
    const ownVins = () => mine().vehicles.map((v) => v.vin);
    const others = KEYS.filter((o) => o !== k);
    let before: Awaited<ReturnType<typeof snapshot>>;
    let appointmentId: string;

    beforeAll(async () => {
      before = await snapshot();
    });

    it('discovery shows only this store’s vehicles, named as this store (EN and ES)', async () => {
      const r = await visitor(k).say('What vehicles do you have in stock?');
      expect((r.vehicles ?? []).length).toBeGreaterThan(0);
      for (const x of r.vehicles!) expect(ownVins()).toContain(x.vin);
      const es = await visitor(k, 'es').say('¿Qué vehículos tienen?');
      expect(es.conversation.language).toBe('es');
      expect((es.vehicles ?? []).length).toBeGreaterThan(0);
      for (const x of es.vehicles!) expect(ownVins()).toContain(x.vin);
    });

    it('sales: consented lead, booking with a provider receipt, and the ADF goes to this store’s destination only', async () => {
      const v = visitor(k);
      const vin = ownVins()[0];
      const offered = await v.say('', { action: 'test_drive', vin });
      const form = card<{
        id: string;
        rooftopName: string;
        vin: string;
        consent: { version: string };
      }>(offered, 'lead_form')!;
      expect(form.rooftopName).toBe(mine().name);
      expect(form.vin).toBe(vin);
      // showing a form stores nothing
      expect(await counts(k)).toEqual(before[k]);

      const submitted = await v.say('', {
        action: 'lead_capture',
        lead: {
          formId: form.id,
          firstName: 'Pat',
          lastName: 'Rivera',
          email: `pat.${k}@example.invalid`,
          phone: '312-555-0142',
          preferredChannel: 'EMAIL',
          consents: [
            { channel: 'EMAIL', granted: true, version: form.consent.version },
            { channel: 'CALL', granted: false, version: form.consent.version },
          ],
        },
      });
      // consent is recorded for exactly what was ticked
      const consents = await ctx.prisma.consentRecord.findMany({
        where: { tenantId: tenantOf(k) },
      });
      expect(consents.filter((c) => c.granted).map((c) => c.channel)).toEqual([
        'EMAIL',
      ]);
      const picker = card<{
        id: string;
        mode: string;
        rooftopName: string;
        slots: Array<{ id: string }>;
      }>(submitted, 'appointment_picker')!;
      expect(picker.mode).toBe('provider_slots');
      expect(picker.rooftopName).toBe(mine().name);

      const booked = await v.say('', {
        action: 'appointment_select',
        appointment: { pickerId: picker.id, slotId: picker.slots[0].id },
      });
      const appt = card<{
        id: string;
        status: string;
        outcome: string;
        verified: boolean;
        providerRef: string;
        sandbox: boolean;
        rooftopName: string;
      }>(booked, 'appointment')!;
      expect(appt).toMatchObject({
        status: 'CONFIRMED',
        outcome: 'confirmed',
        verified: true,
        sandbox: true,
        rooftopName: mine().name,
      });
      expect(appt.providerRef).toMatch(/^SBX-/);
      // confirmed wording only together with the receipt, and labelled as a demo booking
      expect(booked.reply).toMatch(/demo booking/);
      appointmentId = appt.id;
      const receipts = await ctx.prisma.appointmentProviderReceipt.findMany({
        where: { tenantId: tenantOf(k), appointmentId },
      });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        status: 'CONFIRMED',
        sandbox: true,
        providerRef: appt.providerRef,
      });

      await ctx.app.get(OutboxProcessorService).processBatch(500, 'frj-e2e');
      const deliveries = await ctx.prisma.leadDelivery.findMany({
        where: { tenantId: tenantOf(k) },
      });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].status).toBe('ACCEPTED');
      const sent = sink
        .messages()
        .filter((m) => m.deliveryId === deliveries[0].id);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(address[k]);
      for (const o of others) {
        expect(sent[0].to).not.toBe(address[o]);
        expect(sent[0].xml).not.toContain(SEED_ROOFTOPS[o].name);
      }
      expect(sent[0].xml).toContain(mine().name);
    });

    it('cancellation: the appointment is cancelled and the booking is released at the scheduler', async () => {
      await ctx.app.get(AppointmentService).cancel({
        tenantId: tenantOf(k),
        appointmentId,
        source: 'staff',
        reason: 'e2e',
      });
      await ctx.app.get(OutboxProcessorService).processBatch(500, 'frj-e2e');
      const receipts = await ctx.prisma.appointmentProviderReceipt.findMany({
        where: { appointmentId },
        orderBy: { receivedAt: 'asc' },
      });
      expect(receipts.map((r) => r.status)).toEqual(['CONFIRMED', 'CANCELLED']);
      expect(
        (
          await ctx.prisma.appointment.findUniqueOrThrow({
            where: { id: appointmentId },
          })
        ).status,
      ).toBe('CANCELLED');
    });

    it('service and parts: a request is taken, nothing is diagnosed, quoted or booked (EN and ES)', async () => {
      const appts = (await counts(k)).appointments;
      const s = await visitor(k).say('I need an oil change next week');
      expect(s.reply).toMatch(
        /What vehicle are we scheduling the oil change for\?/,
      );
      expect(card(s, 'appointment')).toBeUndefined();
      const es = await visitor(k, 'es').say('Necesito un cambio de aceite');
      expect(es.conversation.language).toBe('es');
      expect(es.reply).toMatch(/cambio de aceite/);
      const p = await visitor(k).say(
        'Do you have front brake pads for a 2019 model?',
      );
      expect(card(p, 'parts')).toBeDefined();
      expect(p.reply).toMatch(/VIN/);
      // no price, no availability claim, no order
      expect(p.reply).not.toMatch(
        /\$\s?\d|in stock|we have (?:it|them)|ordered/i,
      );
      expect((await counts(k)).appointments).toBe(appts);
    });

    it('human takeover: request → this store’s queue → staff take over → AI silent → release → AI resumes', async () => {
      const v = visitor(k);
      await v.say('Hi');
      const h = await v.say('I want to talk to a person');
      expect(card(h, 'handoff')).toBeDefined();
      expect((await counts(k)).escalations).toBe(before[k].escalations + 1);
      const conv = await ctx.prisma.conversation.findFirstOrThrow({
        where: { tenantId: tenantOf(k), externalKey: v.id() },
      });
      const inbox = unwrap<{ items: Array<{ id: string }> }>(
        (await ops(k, 'get', 'inbox')).body,
      );
      expect(inbox.items.map((i) => i.id)).toContain(conv.id);
      // no other store can see or act on it
      for (const o of others) {
        expect((await ops(o, 'get', `conversations/${conv.id}`)).status).toBe(
          404,
        );
        expect(
          (await ops(o, 'post', `conversations/${conv.id}/takeover`)).status,
        ).toBe(404);
        const theirs = unwrap<{ items: Array<{ id: string }> }>(
          (await ops(o, 'get', 'inbox')).body,
        );
        expect(theirs.items.map((i) => i.id)).not.toContain(conv.id);
      }
      expect(
        (await ops(k, 'post', `conversations/${conv.id}/takeover`)).status,
      ).toBeLessThan(300);
      const paused = await v.say('What vehicles do you have in stock?');
      expect(paused.type).toBe('staff_handling');
      expect(paused.vehicles ?? []).toHaveLength(0);
      expect(
        (await ops(k, 'post', `conversations/${conv.id}/release`)).status,
      ).toBeLessThan(300);
      const resumed = await v.say('What vehicles do you have in stock?');
      expect(resumed.type).not.toBe('staff_handling');
      expect((resumed.vehicles ?? []).length).toBeGreaterThan(0);
    });

    it('error recovery: a forged slot or form is refused and stores nothing', async () => {
      const start = await counts(k);
      const post = (body: object) =>
        http()
          .post('/api/chat')
          .set('Authorization', `Bearer ${widget[k]}`)
          .set('Origin', SIM_ORIGIN)
          .send(body);
      const a = await post({
        message: '',
        action: 'appointment_select',
        appointment: { pickerId: 'pk_forged', slotId: 'sl_forged' },
      });
      const b = await post({
        message: '',
        action: 'lead_capture',
        lead: {
          formId: 'lf_forged',
          firstName: 'X',
          lastName: 'Y',
          email: 'x@example.invalid',
          preferredChannel: 'EMAIL',
          consents: [],
        },
      });
      for (const r of [a, b]) {
        expect([201, 400]).toContain(r.status);
        const text = JSON.stringify(r.body);
        expect(text).not.toMatch(/confirmed|SBX-/i);
        expect(text).not.toMatch(/prisma|stack|at \w+ \(/i);
      }
      expect(await counts(k)).toEqual(start);
      // and a real turn still works afterwards
      const ok = await visitor(k).say('What vehicles do you have in stock?');
      expect((ok.vehicles ?? []).length).toBeGreaterThan(0);
    });

    it('the other four stores hold nothing new', async () => {
      const after = await snapshot();
      for (const o of others) expect(after[o]).toEqual(before[o]);
    });
  });
});
