import { randomUUID } from 'crypto';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { DemoDealer, seedDemoDealer, SIM_ORIGIN } from '../helpers/demo-dealer';
import { LEAD_FORM_CONSENT_VERSION } from '../../src/chat/sales-desk/consent-wording';
import { CrmSyncService } from '../../src/integrations/crm/crm-sync.service';
import { OutboxProcessorService } from '../../src/integrations/core/outbox-processor.service';
import { LeadDeliveryService } from '../../src/integrations/adf/lead-delivery.service';
import { LeadDeliveryRouteService } from '../../src/integrations/adf/lead-delivery-route.service';
import {
  LEAD_APPOINTMENT_UPDATE_TOPIC,
  LeadAppointmentUpdateService,
  UPDATES_NOT_SUPPORTED,
} from '../../src/integrations/adf/lead-appointment-update.service';
import { SandboxSinkTransport } from '../../src/integrations/adf/transports/sandbox-sink.transport';
import { seedSandboxRoutes } from '../../src/integrations/adf/sandbox-routes.seed';
import { validateAdfXml } from '../../src/integrations/adf/adf-validator';
import { AppointmentService } from '../../src/appointments/appointment.service';
import { SchedulingProviderRegistry } from '../../src/appointments/scheduling-provider.registry';
import type {
  SchedulingContext,
  SchedulingOutcome,
  ServiceSchedulingProviderAdapter,
} from '../../src/appointments/scheduling-provider';
import { ConsentService } from '../../src/messaging/consent.service';

/**
 * R8 — "lead first, appointment as a separate update" (PROPOSED policy).
 *
 * Runs against the real application, Postgres, the durable outbox, the in-process sandbox sink
 * and the loopback mock SMTP server. Nothing here is a real CRM, a real dealership scheduler or
 * a real customer: every address is a reserved *.example.invalid mailbox, every phone number a
 * 555-01xx number, and the "scheduling providers" are in-test stand-ins. What passes here is a
 * LOCAL SANDBOX verification of the policy — not a verification of any receiving system.
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
] as const;

/** `on`: destination accepts updates · `off`: default (no capability) · `sbx`: demo scheduler. */
const KEYS = ['on', 'off', 'sbx', 'other'] as const;
type Key = (typeof KEYS)[number];
/** Provider keys of the in-test schedulers (any IntegrationProvider value no adapter uses). */
const REAL_MODE_PROVIDER = 'GENERIC_WEBHOOK';
const DEMO_PROVIDER = 'GOOGLE_CALENDAR';

type Behaviour = 'confirmed' | 'pending' | 'failed' | 'late_success';

/**
 * In-test scheduling provider. `sandbox: true` makes every receipt a sandbox receipt, exactly
 * like the product's own demo scheduler. It books nothing anywhere.
 */
class TestScheduler implements ServiceSchedulingProviderAdapter {
  readonly displayName = 'R8 test scheduler';
  next: Behaviour = 'confirmed';
  private readonly bookings = new Map<
    string,
    Extract<SchedulingOutcome, { kind: 'confirmed' }>
  >();

  constructor(
    readonly providerId: string,
    readonly sandbox: boolean,
  ) {}

  capabilities() {
    return {
      availabilityRead: false,
      create: true,
      update: false,
      cancel: true,
      serviceTypes: false,
      transportationOptions: false,
    };
  }

  create(
    ctx: SchedulingContext,
    req: { startUtc: string },
  ): Promise<SchedulingOutcome> {
    const key = `${ctx.tenantId}:${ctx.idempotencyKey}`;
    const booked = (): Extract<SchedulingOutcome, { kind: 'confirmed' }> => {
      const existing = this.bookings.get(key);
      if (existing) return existing;
      const b = {
        kind: 'confirmed' as const,
        externalId: `R8-${randomUUID()}`,
        providerStatus: 'BOOKED',
        scheduledAtUtc: req.startUtc,
      };
      this.bookings.set(key, b);
      return b;
    };
    if (this.next === 'confirmed') return Promise.resolve(booked());
    if (this.next === 'pending')
      return Promise.resolve({ kind: 'pending', providerStatus: 'PENDING' });
    if (this.next === 'failed')
      return Promise.resolve({
        kind: 'failed',
        errorCode: 'provider_error',
        retryable: true,
      });
    // The provider booked, but its answer never arrived.
    booked();
    return Promise.reject(new Error('response lost'));
  }

  findByIdempotencyKey(ctx: SchedulingContext) {
    return Promise.resolve(
      this.bookings.get(`${ctx.tenantId}:${ctx.idempotencyKey}`) ?? null,
    );
  }

  cancelByIdempotencyKey(ctx: SchedulingContext) {
    return Promise.resolve({
      cancelled: this.bookings.delete(`${ctx.tenantId}:${ctx.idempotencyKey}`),
    });
  }

  cancel(): Promise<SchedulingOutcome> {
    return Promise.resolve({ kind: 'unavailable', reason: 'cancelled' });
  }
}

describe('R8 — lead first, appointment as a separate update (proposed policy, local sandbox)', () => {
  let ctx: E2eCtx;
  let crm: CrmSyncService;
  let deliveries: LeadDeliveryService;
  let routes: LeadDeliveryRouteService;
  let updates: LeadAppointmentUpdateService;
  let appointments: AppointmentService;
  let processor: OutboxProcessorService;
  let sink: SandboxSinkTransport;
  const realScheduler = new TestScheduler(REAL_MODE_PROVIDER, false);
  const demoScheduler = new TestScheduler(DEMO_PROVIDER, true);
  const prev: Record<string, string | undefined> = {};
  const ids = {} as Record<
    Key,
    { tenantId: string; locationId: string; routeId: string; address: string }
  >;
  let seq = 0;

  const smtp = {
    clear: () => fetch(`${SMTP_API}/messages`, { method: 'DELETE' }),
    mode: (mode: string) =>
      fetch(`${SMTP_API}/mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
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
        lastName: `R8Shopper${seq}`,
        email: `r8-e2e-${k}-${seq}-${Date.now()}@example.invalid`,
        phone: `312-555-01${String(seq % 100).padStart(2, '0')}`,
        source: 'widget',
        ...over,
      },
    });
  };
  /** A lead change, exactly as the chat orchestrator reports it. */
  const leadChanged = (k: Key, leadId: string) =>
    crm.onLeadChanged(
      ids[k].tenantId,
      ids[k].locationId,
      leadId,
      'lead.created',
    );
  const deliveryOf = (leadId: string) =>
    ctx.prisma.leadDelivery.findFirstOrThrow({ where: { leadId } });
  const deliveriesOf = (leadId: string) =>
    ctx.prisma.leadDelivery.findMany({ where: { leadId } });
  const updatesOf = (leadId: string) =>
    ctx.prisma.leadAppointmentUpdate.findMany({
      where: { leadId },
      orderBy: { createdAt: 'asc' },
    });
  const statesOf = async (leadId: string, appointmentId?: string) =>
    (await updatesOf(leadId))
      .filter((u) => !appointmentId || u.appointmentId === appointmentId)
      .map((u) => `${u.state}:${u.status}`);
  const sinkFor = (id: string) =>
    sink.messages().filter((m) => m.deliveryId === id);
  /** Tenants seeded by a nested block (the chat-driven dealer). */
  const extraTenantIds: string[] = [];
  const tenantIds = () => [
    ...KEYS.map((k) => ids[k].tenantId),
    ...extraTenantIds,
  ];
  /** Run the outbox worker until none of this suite's events is due any more. */
  const drain = async () => {
    for (let i = 0; i < 12; i += 1) {
      const due = await ctx.prisma.outboxEvent.updateMany({
        where: {
          tenantId: { in: tenantIds() },
          status: 'PENDING',
          nextAttemptAt: { lt: new Date('2100-01-01T00:00:00Z') },
        },
        data: { nextAttemptAt: new Date(0) },
      });
      if (due.count === 0) break;
      await processor.processBatch(500, 'r8-e2e');
    }
  };
  /** Never leave a due event behind for another suite's worker run (shared test database). */
  const retireOutbox = () =>
    ctx.prisma.outboxEvent.updateMany({
      where: {
        tenantId: { in: tenantIds() },
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      data: { status: 'DEAD', lastError: 'test_suite_cleanup' },
    });
  /** A lead whose own delivery has been accepted by the sandbox sink. */
  const acceptedLead = async (
    k: Key,
    over: Prisma.LeadUncheckedCreateInput | object = {},
  ) => {
    const lead = await newLead(k, over);
    await leadChanged(k, lead.id);
    await drain();
    const delivery = await deliveryOf(lead.id);
    expect(delivery.status).toBe('ACCEPTED');
    return { lead, delivery };
  };
  let dayOffset = 2;
  /** A fresh future slot per call, so no two requests collide on an idempotency key. */
  const when = () => {
    dayOffset += 1;
    const d = new Date(Date.now() + dayOffset * 86_400_000);
    return {
      date: {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
      },
      time: 15 * 60,
      phrase: 'synthetic request',
    };
  };
  const book = async (
    k: Key,
    leadId: string | null,
    behaviour: Behaviour | 'no_scheduler' = 'confirmed',
  ) => {
    const scheduler = k === 'sbx' ? demoScheduler : realScheduler;
    if (behaviour !== 'no_scheduler') scheduler.next = behaviour;
    await ctx.prisma.integrationConnection.updateMany({
      where: { tenantId: ids[k].tenantId, capability: 'appointments' },
      data: { enabled: behaviour !== 'no_scheduler' },
    });
    const res = await appointments.request({
      tenantId: ids[k].tenantId,
      locationId: ids[k].locationId,
      leadId,
      type: 'TEST_DRIVE',
      when: when(),
      customer: { name: 'Synthetic Shopper' },
      idempotencyKey: `r8-e2e:${randomUUID()}`,
      source: 'api',
    });
    if (res.status !== 'saved') throw new Error(`not saved: ${res.status}`);
    return res.appointment;
  };
  const setCapability = (k: Key, mode: 'NONE' | 'ADF_FOLLOW_UP') =>
    routes.setAppointmentUpdates(
      ids[k].tenantId,
      ids[k].routeId,
      { mode, evidence: 'SANDBOX ONLY - test stand-in, no real CRM' },
      'cli:r8-e2e',
    );

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
    updates = ctx.app.get(LeadAppointmentUpdateService);
    appointments = ctx.app.get(AppointmentService);
    processor = ctx.app.get(OutboxProcessorService);
    sink = ctx.app.get(SandboxSinkTransport);
    const registry = ctx.app.get(SchedulingProviderRegistry);
    registry.register(REAL_MODE_PROVIDER, realScheduler);
    registry.register(DEMO_PROVIDER, demoScheduler);

    for (const k of KEYS) {
      const slug = `r8-${k}`;
      const tenant = await ctx.prisma.tenant.upsert({
        where: { slug },
        create: {
          slug,
          name: `R8 rooftop ${k} (simulated)`,
          featureFlags: { adfLeadDelivery: true },
        },
        update: { featureFlags: { adfLeadDelivery: true } },
      });
      const loc = await ctx.prisma.location.upsert({
        where: { tenantId_slug: { tenantId: tenant.id, slug: 'main' } },
        create: { tenantId: tenant.id, slug: 'main', name: `R8 ${k} main` },
        update: {},
      });
      ids[k] = {
        tenantId: tenant.id,
        locationId: loc.id,
        routeId: '',
        address: '',
      };
      // One scheduler per rooftop: a real-mode stand-in, or (sbx) a demo / sandbox one.
      await ctx.prisma.integrationConnection.deleteMany({
        where: { tenantId: tenant.id, capability: 'appointments' },
      });
      await ctx.prisma.integrationConnection.create({
        data: {
          tenantId: tenant.id,
          locationId: loc.id,
          provider: k === 'sbx' ? DEMO_PROVIDER : REAL_MODE_PROVIDER,
          capability: 'appointments',
          enabled: true,
          liveReady: true,
          config: { mode: k === 'sbx' ? 'sandbox' : 'production' },
        },
      });
    }
    const seeded = await seedSandboxRoutes(
      routes,
      KEYS.map((k) => ({
        tenantId: ids[k].tenantId,
        locationId: ids[k].locationId,
        slug: `r8-${k}`,
      })),
      'cli:r8-e2e',
    );
    for (const k of KEYS) {
      const s = seeded.find((x) => x.slug === `r8-${k}`)!;
      ids[k].routeId = s.routeId;
      ids[k].address = s.address;
    }
    // The capability is switched on explicitly, per route. `off` keeps the default.
    await setCapability('on', 'ADF_FOLLOW_UP');
    await setCapability('sbx', 'ADF_FOLLOW_UP');
    await setCapability('other', 'ADF_FOLLOW_UP');
    await setCapability('off', 'NONE');
    await retireOutbox();
    // Synthetic 555-01xx numbers repeat between runs: start from an empty ledger.
    await ctx.prisma.consentRecord.deleteMany({
      where: { tenantId: { in: tenantIds() } },
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
    await retireOutbox();
    process.env.NODE_ENV = prev.NODE_ENV ?? 'test';
    process.env.ADF_SEND_ENABLED = 'true';
    process.env.LEAD_DELIVERY_MODE = 'sandbox';
    process.env.ADF_SANDBOX_TRANSPORT = 'sink';
    sink.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ───────────────────────────────────────── the lead does not wait for an appointment

  describe('the lead is delivered on its own', () => {
    it('a lead with no appointment is delivered at once and makes no appointment claim', async () => {
      const lead = await newLead('on');
      await leadChanged('on', lead.id);
      await drain();
      const d = await deliveryOf(lead.id);
      expect(d.status).toBe('ACCEPTED');
      const [msg] = sinkFor(d.id);
      expect(msg.xml).toContain('<prospect status="new">');
      expect(msg.xml).toContain(`>amqur-lead-${lead.id}</id>`);
      expect(msg.xml).toContain('Appointment: none requested');
      expect(msg.xml).not.toMatch(/CONFIRMED|SCHEDULED|DEMO BOOKING/);
      expect(await updatesOf(lead.id)).toEqual([]);
    });

    it('an appointment that is ALREADY provider-confirmed when the lead is sent is still not claimed by the lead; it follows as its own update, after the lead', async () => {
      const lead = await newLead('on');
      // Booked (and provider-confirmed) before the lead has any delivery row: nothing recorded.
      const appt = await book('on', lead.id);
      expect(appt.status).toBe('CONFIRMED');
      expect(await updatesOf(lead.id)).toEqual([]);

      await leadChanged('on', lead.id);
      const d = await deliveryOf(lead.id);
      expect(await statesOf(lead.id)).toEqual(['CONFIRMED:QUEUED']);
      await drain();

      const all = sink.messages().filter((m) => m.to === ids.on.address);
      const [leadMsg] = sinkFor(d.id);
      const [u] = await updatesOf(lead.id);
      const [updateMsg] = sinkFor(u.id);
      // Before R8 this lead document said "Appointment: CONFIRMED by dealership (…)".
      expect(leadMsg.xml).not.toMatch(/CONFIRMED by/);
      expect(leadMsg.xml).toContain(
        'booking status is NOT stated in this lead, see the appointment record',
      );
      expect(leadMsg.xml).toContain('<prospect status="new">');
      expect(u.status).toBe('ACCEPTED');
      expect(all.indexOf(leadMsg)).toBeLessThan(all.indexOf(updateMsg));
    });
  });

  // ───────────────────────────────────────── one update, same lead, idempotent

  describe('a provider-confirmed appointment that arrives later', () => {
    it('produces exactly ONE update, linked to the same lead, to the same route; replays, retries and duplicate events add nothing', async () => {
      const { lead, delivery } = await acceptedLead('on');
      const appt = await book('on', lead.id);
      const receipt =
        await ctx.prisma.appointmentProviderReceipt.findFirstOrThrow({
          where: { appointmentId: appt.id, status: 'CONFIRMED' },
        });
      expect(receipt.sandbox).toBe(false);
      await drain();

      const [u, ...more] = await updatesOf(lead.id);
      expect(more).toEqual([]);
      expect(u).toMatchObject({
        state: 'CONFIRMED',
        status: 'ACCEPTED',
        leadId: lead.id,
        leadDeliveryId: delivery.id,
        leadRef: `amqur-lead-${lead.id}`,
        appointmentId: appt.id,
        receiptId: receipt.id,
        sandboxReceipt: false,
        deliveryMode: 'sandbox',
        routeId: delivery.routeId,
        destinationFingerprint: delivery.destinationFingerprint,
        attempts: 1,
      });
      const [msg, ...extra] = sinkFor(u.id);
      expect(extra).toEqual([]);
      expect(msg.to).toBe(ids.on.address);
      // Same lead identity as the original document; clearly a follow-up, not a new lead.
      const original = sinkFor(delivery.id)[0].xml;
      const idLine = `<id sequence="1" source="AMQUR">amqur-lead-${lead.id}</id>`;
      expect(original).toContain(idLine);
      expect(msg.xml).toContain(idLine);
      expect(msg.xml).toContain('<prospect status="resend">');
      expect(msg.xml).toContain(
        `APPOINTMENT UPDATE for existing lead amqur-lead-${lead.id} - follow-up to a lead already sent, NOT a new lead`,
      );
      expect(msg.xml).toContain(`Appointment reference: amqur-appt-${appt.id}`);
      expect(
        validateAdfXml(msg.xml, { prospectStatus: 'resend' }),
      ).toMatchObject({
        ok: true,
        summary: { leadRef: `amqur-lead-${lead.id}`, prospectStatus: 'resend' },
      });
      // A sandbox hand-off never words even a real-mode receipt as a confirmation.
      expect(msg.xml).toContain('Appointment: DEMO BOOKING ONLY');
      expect(msg.xml).not.toMatch(/CONFIRMED by/);

      // Duplicate / replayed events, sequential and concurrent.
      for (let i = 0; i < 3; i += 1)
        expect(await updates.syncAppointment(ids.on.tenantId, appt.id)).toEqual(
          { status: 'exists', updateId: u.id },
        );
      expect(
        new Set(
          (
            await Promise.all(
              Array.from({ length: 6 }, () =>
                updates.syncAppointment(ids.on.tenantId, appt.id),
              ),
            )
          ).map((r) => JSON.stringify(r)),
        ).size,
      ).toBe(1);
      // The lead changes again (as it does on every chat turn).
      await leadChanged('on', lead.id);
      await leadChanged('on', lead.id);
      // The provider's own reconcile job is replayed.
      expect(
        await appointments.reconcileProviderBooking({
          tenantId: ids.on.tenantId,
          appointmentId: appt.id,
          provider: REAL_MODE_PROVIDER,
          connectionId: 'replayed',
          mode: 'production',
          bookingIdempotencyKey: appt.idempotencyKey as string,
        }),
      ).toBe('already_confirmed');
      // The update's own outbox event is delivered again (at-least-once).
      await ctx.prisma.outboxEvent.update({
        where: { id: u.outboxEventId as string },
        data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(0) },
      });
      await drain();
      expect(
        await ctx.prisma.outboxEvent.findUniqueOrThrow({
          where: { id: u.outboxEventId as string },
        }),
      ).toMatchObject({ status: 'PUBLISHED', lastError: 'already_accepted' });

      expect(await statesOf(lead.id)).toEqual(['CONFIRMED:ACCEPTED']);
      expect(sinkFor(u.id)).toHaveLength(1);
      // …and never a second lead delivery, nor a second send of the lead.
      expect(await deliveriesOf(lead.id)).toHaveLength(1);
      expect(sinkFor(delivery.id)).toHaveLength(1);
      expect((await deliveryOf(lead.id)).status).toBe('ACCEPTED');
      expect(
        await ctx.prisma.outboxEvent.count({
          where: {
            tenantId: ids.on.tenantId,
            topic: LEAD_APPOINTMENT_UPDATE_TOPIC,
            payload: { path: ['updateId'], equals: u.id },
          },
        }),
      ).toBe(1);
    });

    it('requested first, confirmed by the provider later: one update per state, each worded as what it is', async () => {
      const { lead, delivery } = await acceptedLead('on');
      // The provider books but its answer is lost: the appointment is only a request.
      const appt = await book('on', lead.id, 'late_success');
      expect(appt.status).toBe('REQUESTED');
      // The product's own reconcile job for the lost answer is held back for a moment.
      const job = await ctx.prisma.outboxEvent.findFirstOrThrow({
        where: {
          tenantId: ids.on.tenantId,
          topic: 'appointment.provider.reconcile',
          payload: { path: ['appointmentId'], equals: appt.id },
        },
      });
      await ctx.prisma.outboxEvent.update({
        where: { id: job.id },
        data: { nextAttemptAt: new Date('2100-06-01T00:00:00Z') },
      });
      await drain();
      expect(await statesOf(lead.id)).toEqual(['REQUESTED:ACCEPTED']);
      const [requested] = await updatesOf(lead.id);
      expect(sinkFor(requested.id)[0].xml).toContain(
        'Appointment: REQUESTED by customer - not confirmed, dealership must confirm',
      );
      expect(sinkFor(requested.id)[0].xml).not.toMatch(
        /CONFIRMED|DEMO BOOKING/,
      );

      // The reconcile job runs: the provider did book ⇒ CONFIRMED receipt ⇒ one more update.
      await ctx.prisma.outboxEvent.update({
        where: { id: job.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await drain();
      expect(
        await ctx.prisma.appointment.findUniqueOrThrow({
          where: { id: appt.id },
        }),
      ).toMatchObject({ status: 'CONFIRMED' });
      // The same job delivered again (at-least-once) changes nothing.
      const payload = job.payload as Record<string, string>;
      expect(
        await appointments.reconcileProviderBooking({
          tenantId: ids.on.tenantId,
          appointmentId: appt.id,
          provider: REAL_MODE_PROVIDER,
          connectionId: payload.connectionId,
          mode: 'production',
          bookingIdempotencyKey: payload.bookingIdempotencyKey,
        }),
      ).toBe('already_confirmed');
      await drain();
      expect(await statesOf(lead.id)).toEqual([
        'REQUESTED:ACCEPTED',
        'CONFIRMED:ACCEPTED',
      ]);
      const confirmed = (await updatesOf(lead.id))[1];
      expect(confirmed.receiptId).toBeTruthy();
      expect(sinkFor(confirmed.id)).toHaveLength(1);
      expect(sinkFor(requested.id)).toHaveLength(1);
      expect(await deliveriesOf(lead.id)).toHaveLength(1);
      expect(sinkFor(delivery.id)).toHaveLength(1);
    });

    it('goes out over the loopback mock SMTP as a second message to the same mailbox, with its own stable Message-ID', async () => {
      process.env.ADF_SANDBOX_TRANSPORT = 'smtp';
      await smtp.clear();
      const lead = await newLead('on');
      await leadChanged('on', lead.id);
      await drain();
      await book('on', lead.id);
      await drain();
      const d = await deliveryOf(lead.id);
      const [u] = await updatesOf(lead.id);
      expect(d.status).toBe('ACCEPTED');
      expect(u.status).toBe('ACCEPTED');
      const mine = (await smtp.messages()).filter((m) =>
        m.raw.includes(`amqur-lead-${lead.id}`),
      );
      expect(mine).toHaveLength(2);
      for (const m of mine) expect(m.to).toEqual([ids.on.address]);
      expect(mine[0].raw).toMatch(
        new RegExp(`Subject: New lead amqur-lead-${lead.id}`),
      );
      expect(mine[1].raw).toMatch(
        new RegExp(
          `Subject: Appointment update for lead amqur-lead-${lead.id}`,
        ),
      );
      expect(mine[0].raw).toContain(`<lead-delivery.${d.id}@`);
      expect(mine[1].raw).toContain(`<lead-appointment-update.${u.id}@`);
      expect(sink.messages()).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────── capability off (the default)

  describe('a destination that has not declared the capability (default)', () => {
    it('gets NO update: nothing queued, nothing sent, the lead is not duplicated, and the record says so', async () => {
      const route = await ctx.prisma.leadDeliveryRoute.findUniqueOrThrow({
        where: { id: ids.off.routeId },
      });
      expect(route.appointmentUpdates).toBe('NONE');
      const { lead, delivery } = await acceptedLead('off');
      const outboxBefore = await ctx.prisma.outboxEvent.count({
        where: { tenantId: ids.off.tenantId },
      });
      const appt = await book('off', lead.id);
      expect(appt.status).toBe('CONFIRMED');
      await appointments.cancel({
        tenantId: ids.off.tenantId,
        appointmentId: appt.id,
        source: 'api',
      });
      await leadChanged('off', lead.id);
      await drain();

      const rows = await updatesOf(lead.id);
      expect(rows.map((u) => `${u.state}:${u.status}:${u.reason}`)).toEqual([
        `CONFIRMED:NOT_SENT:${UPDATES_NOT_SUPPORTED}`,
        `CANCELLED:NOT_SENT:${UPDATES_NOT_SUPPORTED}`,
      ]);
      for (const u of rows)
        expect(u).toMatchObject({
          outboxEventId: null,
          attempts: 0,
          sentAt: null,
          deliveryMode: null,
        });
      expect(
        await ctx.prisma.outboxEvent.count({
          where: {
            tenantId: ids.off.tenantId,
            topic: LEAD_APPOINTMENT_UPDATE_TOPIC,
          },
        }),
      ).toBe(0);
      // Whatever the appointment itself queued (as before R8), no lead-delivery job was added:
      // neither an update nor a second lead delivery.
      const added = await ctx.prisma.outboxEvent.findMany({
        where: { tenantId: ids.off.tenantId },
        orderBy: { createdAt: 'asc' },
        skip: outboxBefore,
        select: { topic: true },
      });
      expect(added.length).toBeGreaterThan(0);
      expect(added.filter((e) => e.topic.startsWith('lead.delivery'))).toEqual(
        [],
      );
      // One lead delivery, sent once, untouched.
      expect(await deliveriesOf(lead.id)).toHaveLength(1);
      expect(sink.messages().filter((m) => m.to === ids.off.address)).toEqual(
        sinkFor(delivery.id),
      );
      expect(sinkFor(delivery.id)).toHaveLength(1);

      // The operator's view of the lead delivery states the truth.
      const view = await deliveries.get(
        { tenantId: ids.off.tenantId, locationId: null },
        delivery.id,
      );
      expect(view.status).toBe('ACCEPTED');
      expect(view.appointmentUpdates).toMatchObject([
        {
          state: 'CONFIRMED',
          status: 'NOT_SENT',
          reason: UPDATES_NOT_SUPPORTED,
        },
        {
          state: 'CANCELLED',
          status: 'NOT_SENT',
          reason: UPDATES_NOT_SUPPORTED,
        },
      ]);
      const notes = view.events.filter(
        (e) => e.reasonCode === 'appointment_update_not_sent',
      );
      expect(notes).toHaveLength(2);
      for (const n of notes) {
        expect(n).toMatchObject({
          fromStatus: 'ACCEPTED',
          toStatus: 'ACCEPTED',
        });
        expect(n.evidence).toMatchObject({
          kind: 'appointment_update',
          sent: false,
          reason: UPDATES_NOT_SUPPORTED,
        });
      }
    });

    it('switching the capability on later does not send what was recorded as not sent', async () => {
      const { lead } = await acceptedLead('off');
      const appt = await book('off', lead.id);
      expect(await statesOf(lead.id)).toEqual(['CONFIRMED:NOT_SENT']);
      await setCapability('off', 'ADF_FOLLOW_UP');
      try {
        expect(
          (await updates.syncAppointment(ids.off.tenantId, appt.id)).status,
        ).toBe('exists');
        await leadChanged('off', lead.id);
        await drain();
        expect(await statesOf(lead.id)).toEqual(['CONFIRMED:NOT_SENT']);
        expect(
          sink.messages().filter((m) => m.to === ids.off.address),
        ).toHaveLength(1);
      } finally {
        await setCapability('off', 'NONE');
      }
    });

    it('the capability is explicit: default NONE, evidence required, audited, cleared when the mailbox changes', async () => {
      await expect(
        routes.setAppointmentUpdates(
          ids.off.tenantId,
          ids.off.routeId,
          { mode: 'ADF_FOLLOW_UP' },
          'cli:r8-e2e',
        ),
      ).rejects.toThrow(/Evidence/);
      // Another tenant cannot set it on this route.
      await expect(
        routes.setAppointmentUpdates(
          ids.other.tenantId,
          ids.off.routeId,
          { mode: 'ADF_FOLLOW_UP', evidence: 'not my route' },
          'cli:r8-e2e',
        ),
      ).rejects.toThrow(/not found/i);
      expect(
        await ctx.prisma.auditLog.count({
          where: {
            tenantId: ids.on.tenantId,
            action: 'lead_delivery_route.appointment_updates_set',
            resourceId: ids.on.routeId,
          },
        }),
      ).toBeGreaterThanOrEqual(1);
      // Rotating the address clears the capability together with the verification.
      const rotated = await routes.configure(
        ids.other.tenantId,
        {
          locationId: ids.other.locationId,
          department: 'SALES',
          address: 'adf-sales-r8-other-rotated@leads.example.invalid',
          environment: 'SANDBOX',
        },
        'cli:r8-e2e',
      );
      expect(rotated).toMatchObject({
        verified: false,
        appointmentUpdates: 'NONE',
      });
      // Put the fixture back for the other tests.
      const [back] = await seedSandboxRoutes(
        routes,
        [
          {
            tenantId: ids.other.tenantId,
            locationId: ids.other.locationId,
            slug: 'r8-other',
          },
        ],
        'cli:r8-e2e',
      );
      ids.other.routeId = back.routeId;
      await setCapability('other', 'ADF_FOLLOW_UP');
    });
  });

  // ───────────────────────────────────────── cancel / reschedule / failed

  describe('cancel, reschedule and failure', () => {
    it('a cancellation produces at most one CANCELLED update; a confirmation that was overtaken by it is never sent', async () => {
      const { lead } = await acceptedLead('on');
      const appt = await book('on', lead.id);
      // Cancelled before the worker ran: the queued "confirmed" update is no longer true.
      await appointments.cancel({
        tenantId: ids.on.tenantId,
        appointmentId: appt.id,
        source: 'api',
      });
      await drain();
      const rows = await updatesOf(lead.id);
      expect(rows.map((u) => `${u.state}:${u.status}:${u.reason}`)).toEqual([
        'CONFIRMED:BLOCKED:superseded_by_later_state',
        'CANCELLED:ACCEPTED:null',
      ]);
      expect(sinkFor(rows[0].id)).toHaveLength(0);
      const [msg] = sinkFor(rows[1].id);
      expect(msg.xml).toContain(
        'Appointment: CANCELLED - this appointment is no longer expected',
      );
      expect(msg.xml).not.toMatch(/CONFIRMED|DEMO BOOKING ONLY/);

      // Duplicates: the same event again, the provider-side release job, another lead change.
      expect(
        (await updates.syncAppointment(ids.on.tenantId, appt.id)).status,
      ).toBe('exists');
      await appointments.cancelProviderBooking({
        tenantId: ids.on.tenantId,
        appointmentId: appt.id,
      });
      await expect(
        appointments.cancel({
          tenantId: ids.on.tenantId,
          appointmentId: appt.id,
          source: 'api',
        }),
      ).rejects.toThrow(/Cannot cancel/);
      await leadChanged('on', lead.id);
      await drain();
      expect(await statesOf(lead.id)).toEqual([
        'CONFIRMED:BLOCKED',
        'CANCELLED:ACCEPTED',
      ]);
      expect(sinkFor(rows[1].id)).toHaveLength(1);
      expect(await deliveriesOf(lead.id)).toHaveLength(1);
    });

    it('a reschedule produces at most one RESCHEDULED update for the old appointment; the new one is its own (requested) appointment', async () => {
      const { lead } = await acceptedLead('on');
      const old = await book('on', lead.id, 'no_scheduler');
      await drain();
      expect(await statesOf(lead.id, old.id)).toEqual(['REQUESTED:ACCEPTED']);
      const res = await appointments.reschedule({
        tenantId: ids.on.tenantId,
        appointmentId: old.id,
        when: when(),
        source: 'api',
      });
      if (res.status !== 'saved') throw new Error('reschedule not saved');
      const next = res.appointment;
      await drain();
      expect(await statesOf(lead.id, old.id)).toEqual([
        'REQUESTED:ACCEPTED',
        'RESCHEDULED:ACCEPTED',
      ]);
      expect(await statesOf(lead.id, next.id)).toEqual(['REQUESTED:ACCEPTED']);
      const rescheduled = (await updatesOf(lead.id)).find(
        (u) => u.state === 'RESCHEDULED',
      )!;
      const [msg] = sinkFor(rescheduled.id);
      expect(msg.xml).toContain(
        'Appointment: RESCHEDULED - the previous time no longer applies',
      );
      expect(msg.xml).toContain(`Appointment reference: amqur-appt-${old.id}`);
      expect(msg.xml).not.toMatch(/CONFIRMED|CANCELLED/);

      // Duplicates add nothing.
      for (const id of [old.id, next.id])
        expect(
          (await updates.syncAppointment(ids.on.tenantId, id)).status,
        ).toBe('exists');
      await leadChanged('on', lead.id);
      await drain();
      expect(await updatesOf(lead.id)).toHaveLength(3);
      expect(sinkFor(rescheduled.id)).toHaveLength(1);
      expect(await deliveriesOf(lead.id)).toHaveLength(1);
    });

    it('a failed provider attempt is reported as FAILED — never as requested-and-fine, never as confirmed', async () => {
      const { lead } = await acceptedLead('on');
      const appt = await book('on', lead.id, 'failed');
      expect(appt.status).toBe('REQUESTED');
      await drain();
      expect(await statesOf(lead.id)).toEqual(['FAILED:ACCEPTED']);
      const [u] = await updatesOf(lead.id);
      expect(sinkFor(u.id)[0].xml).toContain(
        'Appointment: FAILED to book with the scheduling provider - nothing is booked, dealership must contact the customer',
      );
      expect(sinkFor(u.id)[0].xml).not.toMatch(/CONFIRMED|DEMO BOOKING ONLY/);
    });
  });

  // ───────────────────────────────────────── confirmation needs a provider receipt

  describe('no "confirmed" without a valid provider receipt', () => {
    it('a staff confirmation (no receipt) is SCHEDULED, never CONFIRMED', async () => {
      const { lead } = await acceptedLead('on');
      const appt = await book('on', lead.id, 'no_scheduler');
      await drain();
      await appointments.staffTransition({
        tenantId: ids.on.tenantId,
        appointmentId: appt.id,
        to: 'CONFIRMED',
        actorId: 'staff-synthetic',
      });
      expect(
        await ctx.prisma.appointmentProviderReceipt.count({
          where: { appointmentId: appt.id },
        }),
      ).toBe(0);
      await drain();
      expect(await statesOf(lead.id)).toEqual([
        'REQUESTED:ACCEPTED',
        'SCHEDULED:ACCEPTED',
      ]);
      const scheduled = (await updatesOf(lead.id))[1];
      expect(scheduled.receiptId).toBeNull();
      const xml = sinkFor(scheduled.id)[0].xml;
      expect(xml).toContain(
        'Appointment: SCHEDULED by dealership staff - no scheduling-provider receipt',
      );
      expect(xml).not.toMatch(/CONFIRMED|DEMO BOOKING ONLY/);
    });

    it('a pending provider answer is not a confirmation; and a forged "confirmed" update row is refused at send time', async () => {
      const { lead, delivery } = await acceptedLead('on');
      const appt = await book('on', lead.id, 'pending');
      expect(appt.status).toBe('PENDING_CONFIRMATION');
      await drain();
      expect(await statesOf(lead.id)).toEqual(['REQUESTED:ACCEPTED']);

      // Someone flips the appointment to CONFIRMED and queues a "confirmed" update by hand.
      await ctx.prisma.appointment.update({
        where: { id: appt.id },
        data: {
          status: 'CONFIRMED',
          availabilityVerified: true,
          externalProviderId: 'FORGED-1',
        },
      });
      const forged = await ctx.prisma.leadAppointmentUpdate.create({
        data: {
          tenantId: ids.on.tenantId,
          locationId: ids.on.locationId,
          leadId: lead.id,
          leadDeliveryId: delivery.id,
          appointmentId: appt.id,
          state: 'CONFIRMED',
          status: 'QUEUED',
          leadRef: `amqur-lead-${lead.id}`,
          idempotencyKey: `forged:${randomUUID()}`,
          correlationId: randomUUID(),
        },
      });
      const ev = await ctx.prisma.outboxEvent.create({
        data: {
          tenantId: ids.on.tenantId,
          topic: LEAD_APPOINTMENT_UPDATE_TOPIC,
          payload: { updateId: forged.id },
        },
      });
      await ctx.prisma.leadAppointmentUpdate.update({
        where: { id: forged.id },
        data: { outboxEventId: ev.id },
      });
      await drain();
      expect(
        await ctx.prisma.leadAppointmentUpdate.findUniqueOrThrow({
          where: { id: forged.id },
        }),
      ).toMatchObject({
        status: 'BLOCKED',
        reason: 'no_provider_receipt',
        attempts: 0,
        sentAt: null,
      });
      expect(sinkFor(forged.id)).toHaveLength(0);
      // The honest derivation of that appointment is SCHEDULED, not CONFIRMED.
      await updates.syncAppointment(ids.on.tenantId, appt.id);
      expect(
        (await updatesOf(lead.id))
          .filter((u) => u.id !== forged.id)
          .map((u) => u.state),
      ).toEqual(['REQUESTED', 'SCHEDULED']);
    });
  });

  // ───────────────────────────────────────── sandbox receipts

  describe('a sandbox (demo) scheduler receipt', () => {
    it('is recorded as sandbox and worded as a demo booking — never as a real confirmation', async () => {
      const { lead } = await acceptedLead('sbx');
      const appt = await book('sbx', lead.id);
      expect(appt.status).toBe('CONFIRMED');
      expect(
        await ctx.prisma.appointmentProviderReceipt.findFirstOrThrow({
          where: { appointmentId: appt.id, status: 'CONFIRMED' },
        }),
      ).toMatchObject({ sandbox: true });
      await drain();
      const [u] = await updatesOf(lead.id);
      expect(u).toMatchObject({
        state: 'CONFIRMED',
        status: 'ACCEPTED',
        sandboxReceipt: true,
        deliveryMode: 'sandbox',
      });
      const xml = sinkFor(u.id)[0].xml;
      expect(xml).toContain(
        'Appointment: DEMO BOOKING ONLY - sandbox, not a real appointment, nothing is booked with the dealership',
      );
      expect(xml).not.toMatch(/CONFIRMED by/);
      expect(xml).not.toMatch(/Appointment: CONFIRMED/);
    });

    it('never reaches a live environment: with production + live mode nothing about it is sent', async () => {
      const { lead } = await acceptedLead('sbx');
      // The booking is made while the demo scheduler exists (outside production).
      const appt = await book('sbx', lead.id);
      const [u] = await updatesOf(lead.id);
      expect(u).toMatchObject({ state: 'CONFIRMED', status: 'QUEUED' });
      await smtp.clear();
      sink.clear();
      process.env.NODE_ENV = 'production';
      process.env.LEAD_DELIVERY_MODE = 'live';
      try {
        await drain();
      } finally {
        process.env.NODE_ENV = 'test';
        process.env.LEAD_DELIVERY_MODE = 'sandbox';
      }
      // The lead was only ever acknowledged by the sandbox: the update is held, nothing sent.
      expect(
        await ctx.prisma.leadAppointmentUpdate.findUniqueOrThrow({
          where: { id: u.id },
        }),
      ).toMatchObject({
        status: 'WAITING_FOR_LEAD',
        reason: 'lead_acknowledged_in_sandbox_only',
        attempts: 0,
        sentAt: null,
      });
      expect(sink.messages()).toHaveLength(0);
      expect(await smtp.messages()).toHaveLength(0);
      expect(appt.id).toBe(u.appointmentId);
    });
  });

  // ───────────────────────────────────────── consent at send time

  describe('consent is checked again when the update is sent', () => {
    it('a customer who opted out after the lead was delivered gets no update sent about them', async () => {
      const { lead, delivery } = await acceptedLead('on');
      await book('on', lead.id);
      const [u] = await updatesOf(lead.id);
      expect(u.status).toBe('QUEUED');
      const consent = ctx.app.get(ConsentService);
      for (const [channel, endpoint] of [
        ['EMAIL', lead.email],
        ['SMS', lead.phone],
        ['CALL', lead.phone],
      ] as const)
        await consent.record({
          tenantId: ids.on.tenantId,
          channel,
          endpoint: endpoint as string,
          purpose: 'CONVERSATIONAL',
          granted: false,
          source: 'SMS_KEYWORD',
          evidence: {},
        });
      await drain();
      expect(
        await ctx.prisma.leadAppointmentUpdate.findUniqueOrThrow({
          where: { id: u.id },
        }),
      ).toMatchObject({
        status: 'BLOCKED',
        reason: 'no_consent_basis',
        attempts: 0,
        sentAt: null,
      });
      expect(sinkFor(u.id)).toHaveLength(0);
      // The lead delivery itself is untouched; its history says what happened to the update.
      const view = await deliveries.get(
        { tenantId: ids.on.tenantId, locationId: null },
        delivery.id,
      );
      expect(view.status).toBe('ACCEPTED');
      expect(view.events.map((e) => e.reasonCode)).toEqual(
        expect.arrayContaining([
          'appointment_update_queued',
          'appointment_update_blocked',
        ]),
      );
      expect(sinkFor(delivery.id)).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────── queue / skip rule

  describe('queue rule — never before the original lead delivery was accepted', () => {
    it('an update that becomes due before the lead was sent is HELD, then released when the lead is accepted — lead first, update second', async () => {
      const lead = await newLead('on');
      await leadChanged('on', lead.id);
      const d = await deliveryOf(lead.id);
      expect(d.status).toBe('QUEUED');
      // The lead's own job is not due yet; the appointment update's job is.
      await ctx.prisma.outboxEvent.update({
        where: { id: d.outboxEventId as string },
        data: { nextAttemptAt: new Date('2100-06-01T00:00:00Z') },
      });
      await book('on', lead.id);
      await drain();
      const [held] = await updatesOf(lead.id);
      expect(held).toMatchObject({
        status: 'WAITING_FOR_LEAD',
        reason: 'lead_queued',
        attempts: 0,
        sentAt: null,
      });
      expect(sinkFor(held.id)).toHaveLength(0);
      expect(
        sink.messages().filter((m) => m.to === ids.on.address),
      ).toHaveLength(0);
      // A sweep changes nothing while the lead is still not accepted.
      expect(await updates.releaseWaiting({ tenantId: ids.on.tenantId })).toBe(
        0,
      );

      // Now the lead goes out. Its acceptance releases the held update.
      await ctx.prisma.outboxEvent.update({
        where: { id: d.outboxEventId as string },
        data: { nextAttemptAt: new Date(0) },
      });
      await drain();
      expect((await deliveryOf(lead.id)).status).toBe('ACCEPTED');
      expect(await statesOf(lead.id)).toEqual(['CONFIRMED:ACCEPTED']);
      const mine = sink.messages().filter((m) => m.to === ids.on.address);
      expect(mine.map((m) => m.deliveryId)).toEqual([d.id, held.id]);
      expect(await deliveriesOf(lead.id)).toHaveLength(1);
    });

    it('a lead whose delivery is never accepted never gets an update sent', async () => {
      // Opted out before anything is sent: the lead delivery is BLOCKED.
      const lead = await newLead('on', { optOutAt: new Date() });
      await leadChanged('on', lead.id);
      await drain();
      const d = await deliveryOf(lead.id);
      expect(d).toMatchObject({
        status: 'BLOCKED',
        blockedReason: 'no_consent_basis',
      });
      const appt = await book('on', lead.id);
      await appointments.cancel({
        tenantId: ids.on.tenantId,
        appointmentId: appt.id,
        source: 'api',
      });
      await drain();
      expect(
        (await updatesOf(lead.id)).map(
          (u) => `${u.state}:${u.status}:${u.reason}`,
        ),
      ).toEqual([
        'CONFIRMED:WAITING_FOR_LEAD:lead_blocked',
        'CANCELLED:WAITING_FOR_LEAD:lead_blocked',
      ]);
      expect(await updates.releaseWaiting({ tenantId: ids.on.tenantId })).toBe(
        0,
      );
      await drain();
      expect(
        sink.messages().filter((m) => m.to === ids.on.address),
      ).toHaveLength(0);
      expect(await deliveriesOf(lead.id)).toHaveLength(1);
    });

    it('a lead the CRM rejected gets no update (it could only become a new lead)', async () => {
      const { lead, delivery } = await acceptedLead('on');
      await ctx.prisma.leadDelivery.update({
        where: { id: delivery.id },
        data: { status: 'CRM_REJECTED', crmRejectedAt: new Date() },
      });
      await book('on', lead.id);
      await drain();
      const [u] = await updatesOf(lead.id);
      expect(u).toMatchObject({
        status: 'BLOCKED',
        reason: 'lead_rejected_by_crm',
        sentAt: null,
      });
      expect(sinkFor(u.id)).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────── tenant / route boundaries

  describe('cross-tenant and route mismatches are refused', () => {
    it("an appointment pointing at ANOTHER tenant's lead records nothing in either tenant", async () => {
      const { lead: foreign, delivery } = await acceptedLead('other');
      const appt = await book('on', foreign.id);
      expect(appt).toMatchObject({
        tenantId: ids.on.tenantId,
        leadId: foreign.id,
      });
      expect(await updates.syncAppointment(ids.on.tenantId, appt.id)).toEqual({
        status: 'skipped',
        reason: 'lead_not_in_tenant',
      });
      // Asking with the lead's tenant does not find the other tenant's appointment either.
      expect(
        await updates.syncAppointment(ids.other.tenantId, appt.id),
      ).toEqual({ status: 'skipped', reason: 'appointment_not_found' });
      expect(await updates.syncLead(ids.other.tenantId, foreign.id)).toBe(0);
      await leadChanged('other', foreign.id);
      await drain();
      expect(await updatesOf(foreign.id)).toEqual([]);
      expect(
        await ctx.prisma.leadAppointmentUpdate.count({
          where: { appointmentId: appt.id },
        }),
      ).toBe(0);
      expect(sinkFor(delivery.id)).toHaveLength(1);
      expect(
        sink.messages().filter((m) => m.to === ids.other.address),
      ).toHaveLength(1);
    });

    it("an update row pointing at another tenant's lead delivery is blocked, not sent", async () => {
      const { lead } = await acceptedLead('on');
      const { delivery: foreignDelivery } = await acceptedLead('other');
      const appt = await book('on', lead.id);
      const [u] = await updatesOf(lead.id);
      await ctx.prisma.leadAppointmentUpdate.update({
        where: { id: u.id },
        data: { leadDeliveryId: foreignDelivery.id },
      });
      await drain();
      expect(
        await ctx.prisma.leadAppointmentUpdate.findUniqueOrThrow({
          where: { id: u.id },
        }),
      ).toMatchObject({
        status: 'BLOCKED',
        reason: 'lead_appointment_mismatch',
        sentAt: null,
      });
      expect(sinkFor(u.id)).toHaveLength(0);
      expect(appt.leadId).toBe(lead.id);
      // Nothing was written into the other tenant's delivery history.
      expect(
        await ctx.prisma.leadDeliveryEvent.count({
          where: {
            deliveryId: foreignDelivery.id,
            reasonCode: { startsWith: 'appointment_update' },
          },
        }),
      ).toBe(0);
    });

    it("the send-time guard refuses another tenant's route; nothing reaches that tenant's mailbox", async () => {
      const { lead } = await acceptedLead('on');
      await book('on', lead.id);
      const [u] = await updatesOf(lead.id);
      const foreignRoute = await ctx.prisma.leadDeliveryRoute.findUniqueOrThrow(
        {
          where: { id: ids.other.routeId },
        },
      );
      jest.spyOn(routes, 'findForLead').mockResolvedValue(foreignRoute);
      await drain();
      jest.restoreAllMocks();
      expect(
        await ctx.prisma.leadAppointmentUpdate.findUniqueOrThrow({
          where: { id: u.id },
        }),
      ).toMatchObject({
        status: 'BLOCKED',
        reason: 'route_tenant_mismatch',
        sentAt: null,
      });
      expect(
        sink.messages().filter((m) => m.to === ids.other.address),
      ).toHaveLength(0);
    });

    it('a route whose mailbox changed after the lead was delivered does not receive the update', async () => {
      const { lead, delivery } = await acceptedLead('on');
      await book('on', lead.id);
      const [u] = await updatesOf(lead.id);
      const route = await ctx.prisma.leadDeliveryRoute.findUniqueOrThrow({
        where: { id: ids.on.routeId },
      });
      jest.spyOn(routes, 'findForLead').mockResolvedValue({
        ...route,
        destinationFingerprint: 'another-mailbox-fingerprint',
      });
      await drain();
      jest.restoreAllMocks();
      expect(
        await ctx.prisma.leadAppointmentUpdate.findUniqueOrThrow({
          where: { id: u.id },
        }),
      ).toMatchObject({
        status: 'BLOCKED',
        reason: 'route_changed_since_lead',
      });
      expect(sinkFor(u.id)).toHaveLength(0);
      expect(sinkFor(delivery.id)).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────── switches off ⇒ exactly as before

  describe('with the switches off nothing new happens', () => {
    it('ADF_SEND_ENABLED=false: no delivery row, no update row, no update job', async () => {
      process.env.ADF_SEND_ENABLED = 'false';
      const lead = await newLead('on');
      await leadChanged('on', lead.id);
      const appt = await book('on', lead.id);
      await appointments.cancel({
        tenantId: ids.on.tenantId,
        appointmentId: appt.id,
        source: 'api',
      });
      await leadChanged('on', lead.id);
      expect(await updates.syncAppointment(ids.on.tenantId, appt.id)).toEqual({
        status: 'skipped',
        reason: 'send_disabled',
      });
      expect(await deliveriesOf(lead.id)).toEqual([]);
      expect(await updatesOf(lead.id)).toEqual([]);
    });

    it('rooftop flag off: no delivery row, no update row', async () => {
      await ctx.prisma.tenant.update({
        where: { id: ids.off.tenantId },
        data: { featureFlags: { adfLeadDelivery: false } },
      });
      try {
        const lead = await newLead('off');
        await leadChanged('off', lead.id);
        const appt = await book('off', lead.id);
        await leadChanged('off', lead.id);
        expect(
          await updates.syncAppointment(ids.off.tenantId, appt.id),
        ).toEqual({ status: 'skipped', reason: 'flag_off' });
        expect(await deliveriesOf(lead.id)).toEqual([]);
        expect(await updatesOf(lead.id)).toEqual([]);
      } finally {
        await ctx.prisma.tenant.update({
          where: { id: ids.off.tenantId },
          data: { featureFlags: { adfLeadDelivery: true } },
        });
      }
    });

    it('an appointment with no lead records nothing', async () => {
      const appt = await book('on', null);
      expect(await updates.syncAppointment(ids.on.tenantId, appt.id)).toEqual({
        status: 'skipped',
        reason: 'no_lead',
      });
      expect(
        await ctx.prisma.leadAppointmentUpdate.count({
          where: { appointmentId: appt.id },
        }),
      ).toBe(0);
    });
  });
  // ───────────────────────────────────────── through the real chat orchestrator

  describe('through the real chat orchestrator (widget chat, demo scheduler)', () => {
    type Card = Record<string, unknown> & { kind: string };
    type Chat = { cards: Card[]; conversationId: string };
    let dealer: DemoDealer;
    let token = '';
    let address = '';
    const chat = async (body: object): Promise<Chat> => {
      const r = await request(ctx.app.getHttpServer())
        .post('/api/chat')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', SIM_ORIGIN)
        .send(body);
      if (r.status >= 300) throw new Error(`chat ${r.status}: ${r.text}`);
      return unwrap<Chat>(r.body);
    };
    const card = <T>(c: Chat, kind: string) =>
      c.cards.find((x) => x.kind === kind) as T | undefined;

    beforeAll(async () => {
      dealer = await seedDemoDealer(ctx.app, ctx.prisma, 'r8-chat', {
        creditPreview: false,
        flags: {
          salesDeskCards: true,
          sandboxScheduler: true,
          adfLeadDelivery: true,
        },
      });
      await ctx.prisma.integrationConnection.deleteMany({
        where: { tenantId: dealer.tenantId, capability: 'appointments' },
      });
      await ctx.prisma.integrationConnection.create({
        data: {
          tenantId: dealer.tenantId,
          locationId: dealer.locationId,
          provider: 'MOCK',
          capability: 'appointments',
          enabled: true,
          liveReady: true,
          config: { mode: 'sandbox' },
        },
      });
      // Earlier runs against the same disposable database must not hold the demo slots.
      await ctx.prisma.appointment.deleteMany({
        where: { tenantId: dealer.tenantId },
      });
      await ctx.prisma.consentRecord.deleteMany({
        where: { tenantId: dealer.tenantId },
      });
      const [route] = await seedSandboxRoutes(
        routes,
        [
          {
            tenantId: dealer.tenantId,
            locationId: dealer.locationId,
            slug: dealer.slug,
          },
        ],
        'cli:r8-e2e',
      );
      address = route.address;
      await routes.setAppointmentUpdates(
        dealer.tenantId,
        route.routeId,
        {
          mode: 'ADF_FOLLOW_UP',
          evidence: 'SANDBOX ONLY - test stand-in, no real CRM',
        },
        'cli:r8-e2e',
      );
      extraTenantIds.push(dealer.tenantId);
      const r = await request(ctx.app.getHttpServer())
        .post('/api/public/widget-token')
        .set('Origin', SIM_ORIGIN)
        .send({ tenantSlug: dealer.slug, locationSlug: 'main' });
      token = unwrap<{ token: string }>(r.body).token;
    }, 120_000);

    it('the lead is queued as soon as contact + consent are in — before any appointment exists; the demo booking made afterwards follows as ONE update for the same lead', async () => {
      const email = `r8-chat-${Date.now()}@example.invalid`;
      const a = await chat({
        action: 'test_drive',
        vin: dealer.vehicles[0].vin,
        language: 'en',
      });
      const form = card<{ id: string }>(a, 'lead_form')!;
      const b = await chat({
        action: 'lead_capture',
        conversationId: a.conversationId,
        language: 'en',
        lead: {
          formId: form.id,
          firstName: 'Synthetic',
          lastName: 'Shopper',
          email,
          phone: '(312) 555-0177',
          preferredChannel: 'EMAIL',
          consents: [
            {
              channel: 'EMAIL',
              granted: true,
              version: LEAD_FORM_CONSENT_VERSION,
            },
            {
              channel: 'CALL',
              granted: true,
              version: LEAD_FORM_CONSENT_VERSION,
            },
          ],
        },
      });
      const picker = card<{ id: string; slots: Array<{ id: string }> }>(
        b,
        'appointment_picker',
      )!;

      // Contact + consent are in. No appointment exists — and the lead is already queued.
      const lead = await ctx.prisma.lead.findFirstOrThrow({
        where: { tenantId: dealer.tenantId, email },
      });
      expect(
        await ctx.prisma.appointment.count({
          where: { tenantId: dealer.tenantId },
        }),
      ).toBe(0);
      const queued = await deliveryOf(lead.id);
      expect(queued.status).toBe('QUEUED');
      await drain();
      const d = await deliveryOf(lead.id);
      expect(d.status).toBe('ACCEPTED');
      const [leadMsg] = sinkFor(d.id);
      expect(leadMsg.to).toBe(address);
      expect(leadMsg.xml).toContain('Appointment: none requested');
      expect(leadMsg.xml).not.toMatch(/CONFIRMED|DEMO BOOKING/);
      expect(await updatesOf(lead.id)).toEqual([]);

      // The customer now picks a slot; the demo scheduler "confirms" it.
      const c = await chat({
        action: 'appointment_select',
        conversationId: a.conversationId,
        appointment: { pickerId: picker.id, slotId: picker.slots[0].id },
      });
      const appt = card<{ id: string; status: string; sandbox: boolean }>(
        c,
        'appointment',
      )!;
      expect(appt).toMatchObject({ status: 'CONFIRMED', sandbox: true });
      await drain();

      const rows = await updatesOf(lead.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: 'CONFIRMED',
        status: 'ACCEPTED',
        appointmentId: appt.id,
        leadDeliveryId: d.id,
        leadRef: `amqur-lead-${lead.id}`,
        sandboxReceipt: true,
      });
      const [updateMsg] = sinkFor(rows[0].id);
      expect(updateMsg.to).toBe(address);
      expect(updateMsg.xml).toContain(`>amqur-lead-${lead.id}</id>`);
      expect(updateMsg.xml).toContain('<prospect status="resend">');
      expect(updateMsg.xml).toContain('Appointment: DEMO BOOKING ONLY');
      expect(updateMsg.xml).not.toMatch(/CONFIRMED by/);
      // One lead delivery, sent once; one update, sent once.
      expect(await deliveriesOf(lead.id)).toHaveLength(1);
      expect(sinkFor(d.id)).toHaveLength(1);
      expect(sinkFor(rows[0].id)).toHaveLength(1);
      expect(sink.messages().filter((m) => m.to === address)).toHaveLength(2);
    });
  });
});
