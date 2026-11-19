import request from 'supertest';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { DemoDealer, seedDemoDealer, SIM_ORIGIN } from '../helpers/demo-dealer';
import {
  consentWording,
  LEAD_FORM_CONSENT_VERSION,
} from '../../src/chat/sales-desk/consent-wording';
import { LEAD_FORM_TTL_MS } from '../../src/chat/sales-desk/lead-form';
import { SandboxSinkTransport } from '../../src/integrations/adf/transports/sandbox-sink.transport';
import { LeadDeliveryRouteService } from '../../src/integrations/adf/lead-delivery-route.service';
import { seedSandboxRoutes } from '../../src/integrations/adf/sandbox-routes.seed';
import { referenceNow } from '../../src/common/time/reference-now';
import { sandboxTakenSlotStart } from '../../src/appointments/sandbox-scheduling.adapter';
import { SchedulingProviderRegistry } from '../../src/appointments/scheduling-provider.registry';
import {
  APPOINTMENT_RECONCILE_TOPIC,
  AppointmentService,
} from '../../src/appointments/appointment.service';
import { OutboxProcessorService } from '../../src/integrations/core/outbox-processor.service';
import { ConversationComposerService } from '../../src/chat/compose/conversation-composer.service';
import { ChatService } from '../../src/chat/chat.service';

/**
 * Regression tests for the PR #55 review findings on the sales-desk cards and the sandbox
 * scheduler (R5–R7, R10, R12, R15). Real API, Postgres, the in-process SANDBOX scheduler.
 * Synthetic data only: example.invalid addresses and 555-01xx numbers.
 */
type Card = Record<string, unknown> & { kind: string };
type Chat = {
  reply: string;
  cards: Card[];
  journey: Record<string, unknown>;
  conversation: { pending: string; language: string };
  conversationId: string;
};
const EMAIL = 'robin.vale@example.invalid';
const PHONE = '(312) 555-0147';

describe('sales desk + sandbox scheduler — review findings (R5–R7, R10, R12, R15)', () => {
  let ctx: E2eCtx;
  let sbx: DemoDealer; // salesDeskCards + sandbox scheduler
  let plain: DemoDealer; // salesDeskCards, no scheduler (request-only)
  const tokens: Record<string, string> = {};
  const srv = () => request(ctx.app.getHttpServer());
  const tokenFor = async (d: DemoDealer) => {
    if (!tokens[d.slug]) {
      const r = await srv()
        .post('/api/public/widget-token')
        .set('Origin', SIM_ORIGIN)
        .send({ tenantSlug: d.slug, locationSlug: 'main' });
      tokens[d.slug] = unwrap<{ token: string }>(r.body).token;
    }
    return tokens[d.slug];
  };
  const chat = async (d: DemoDealer, body: object): Promise<Chat> => {
    const r = await srv()
      .post('/api/chat')
      .set('Authorization', `Bearer ${await tokenFor(d)}`)
      .set('Origin', SIM_ORIGIN)
      .send(body);
    if (r.status >= 300) throw new Error(`chat ${r.status}: ${r.text}`);
    return unwrap<Chat>(r.body);
  };
  const card = <T = Card>(c: Chat, kind: string) =>
    c.cards.find((x) => x.kind === kind) as T | undefined;
  const lead = (formId: string, over: Record<string, unknown> = {}) => ({
    formId,
    firstName: 'Robin',
    lastName: 'Vale',
    email: EMAIL,
    phone: PHONE,
    preferredChannel: 'EMAIL',
    consents: [
      { channel: 'EMAIL', granted: true, version: LEAD_FORM_CONSENT_VERSION },
      { channel: 'CALL', granted: true, version: LEAD_FORM_CONSENT_VERSION },
    ],
    ...over,
  });
  type Picker = {
    id: string;
    mode: string;
    sandbox?: boolean;
    slots: Array<{ id: string; start: string; expiresAt: string }>;
    days?: string[];
  };
  /** Sandbox journey up to a provider-slot picker (contact first, then real slots). */
  const toSlotPicker = async (d: DemoDealer, language = 'en') => {
    const a = await chat(d, {
      action: 'test_drive',
      vin: d.vehicles[0].vin,
      language,
    });
    const form = card<{ id: string }>(a, 'lead_form')!;
    const b = await chat(d, {
      action: 'lead_capture',
      conversationId: a.conversationId,
      language,
      lead: lead(form.id),
    });
    const picker = card<Picker>(b, 'appointment_picker')!;
    // The sandbox keeps ONE designated slot visible that it always rejects; never pick it here.
    const taken = sandboxTakenSlotStart(referenceNow());
    picker.slots = picker.slots.filter((x) => x.start !== taken);
    return { conversationId: a.conversationId, picker };
  };
  const select = (
    d: DemoDealer,
    conversationId: string,
    pickerId: string,
    slotId: string,
    language = 'en',
  ) =>
    chat(d, {
      action: 'appointment_select',
      conversationId,
      language,
      appointment: { pickerId, slotId },
    });
  const activeAppointments = (d: DemoDealer, conversationId: string) =>
    ctx.prisma.appointment.findMany({
      where: {
        tenantId: d.tenantId,
        conversation: { externalKey: conversationId },
        status: { in: ['REQUESTED', 'PENDING_CONFIRMATION', 'CONFIRMED'] },
      },
      include: { providerReceipts: true },
    });

  beforeAll(async () => {
    ctx = await createE2eApp();
    sbx = await seedDemoDealer(ctx.app, ctx.prisma, 'sdr-sandbox', {
      creditPreview: false,
      flags: { salesDeskCards: true, sandboxScheduler: true },
    });
    plain = await seedDemoDealer(ctx.app, ctx.prisma, 'sdr-cards', {
      creditPreview: false,
      flags: { salesDeskCards: true },
    });
    await ctx.prisma.integrationConnection.deleteMany({
      where: { tenantId: sbx.tenantId, capability: 'appointments' },
    });
    await ctx.prisma.integrationConnection.create({
      data: {
        tenantId: sbx.tenantId,
        locationId: sbx.locationId,
        provider: 'MOCK',
        capability: 'appointments',
        enabled: true,
        liveReady: true,
        config: { mode: 'sandbox' },
      },
    });
    // Earlier runs against the same disposable database must not hold today's slots.
    await ctx.prisma.appointment.deleteMany({
      where: { tenantId: sbx.tenantId },
    });
  }, 120_000);
  afterAll(async () => ctx.app.close());

  // ───────────────────────────────────────── R15: SSE heartbeat

  describe('R15 — POST /chat/stream sends a comment heartbeat while a turn is running', () => {
    it('a slow turn gets ": hb" comment frames between turn.started and the reply; events are unchanged', async () => {
      const svc = ctx.app.get(ChatService);
      const real = svc.chat.bind(svc);
      const spy = jest.spyOn(svc, 'chat').mockImplementation(async (...a) => {
        await new Promise((r) => setTimeout(r, 400)); // a slow model / tool call
        return real(...(a as Parameters<typeof real>));
      });
      const prev = process.env.CHAT_STREAM_HEARTBEAT_MS;
      process.env.CHAT_STREAM_HEARTBEAT_MS = '50';
      try {
        const r = await srv()
          .post('/api/chat/stream')
          .set('Authorization', `Bearer ${await tokenFor(plain)}`)
          .set('Origin', SIM_ORIGIN)
          .send({ message: 'hello' });
        expect(r.status).toBe(200);
        const frames = r.text.split('\n\n').filter(Boolean);
        const beats = frames.filter((f) => f === ': hb');
        expect(beats.length).toBeGreaterThanOrEqual(3);
        // Heartbeats sit between the first event and the reply — and stop with the turn.
        expect(frames[0]).toMatch(/^event: turn\.started/);
        expect(frames[1]).toBe(': hb');
        expect(frames[frames.length - 1]).toMatch(/^event: turn\.completed/);
        // A parser that only reads `data:` lines sees exactly the documented events.
        const events = frames
          .map((f) =>
            f
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim())
              .join('\n'),
          )
          .filter(Boolean)
          .map((d) => (JSON.parse(d) as { type: string }).type);
        expect(events[0]).toBe('turn.started');
        expect(events[events.length - 1]).toBe('turn.completed');
        expect(events).not.toContain('hb');
      } finally {
        spy.mockRestore();
        if (prev === undefined) delete process.env.CHAT_STREAM_HEARTBEAT_MS;
        else process.env.CHAT_STREAM_HEARTBEAT_MS = prev;
      }
    });

    it('a fast turn (default 15 s interval) carries no heartbeat at all', async () => {
      const r = await srv()
        .post('/api/chat/stream')
        .set('Authorization', `Bearer ${await tokenFor(plain)}`)
        .set('Origin', SIM_ORIGIN)
        .send({ message: 'hello' });
      expect(r.text).not.toContain(': hb');
    });
  });

  // ───────────────────────────────────────── R12: lead-form consent evidence

  describe('R12 — lead-form consent evidence is bound to the form that was shown', () => {
    const consentRows = (conversationId: string) =>
      ctx.prisma.consentRecord.findMany({
        where: {
          tenantId: sbx.tenantId,
          conversationExternalKey: conversationId,
        },
        orderBy: { createdAt: 'asc' },
      });

    it('wording + language come from the form as ISSUED (Spanish) even when the submit claims English; consent rows are linked to the lead', async () => {
      const a = await chat(sbx, {
        action: 'test_drive',
        vin: sbx.vehicles[0].vin,
        language: 'es',
      });
      const form = card<{
        id: string;
        consent: { text: Record<string, string> };
      }>(a, 'lead_form')!;
      expect(form.consent.text.EMAIL).toBe(
        consentWording(LEAD_FORM_CONSENT_VERSION, 'es', 'EMAIL'),
      );
      await chat(sbx, {
        action: 'lead_capture',
        conversationId: a.conversationId,
        language: 'en', // the client now claims English
        lead: lead(form.id, { email: 'r12.es@example.invalid' }),
      });
      const rows = await consentRows(a.conversationId);
      expect(rows.map((r) => r.channel).sort()).toEqual(['CALL', 'EMAIL']);
      for (const r of rows) {
        expect(r.wording).toBe(
          consentWording(
            LEAD_FORM_CONSENT_VERSION,
            'es',
            r.channel as 'EMAIL' | 'CALL',
          ),
        );
        expect(r.evidence).toMatchObject({
          capturedVia: 'lead_form',
          formId: form.id,
          language: 'es',
        });
        expect(
          Date.parse((r.evidence as { formIssuedAt: string }).formIssuedAt),
        ).not.toBeNaN();
      }
      // Back-filled: written before the lead existed, linked once it does.
      const conv = await ctx.prisma.conversation.findUniqueOrThrow({
        where: {
          tenantId_externalKey: {
            tenantId: sbx.tenantId,
            externalKey: a.conversationId,
          },
        },
      });
      const leadId = (conv.state as { leadId?: string }).leadId;
      expect(leadId).toBeTruthy();
      expect(rows.map((r) => r.leadId)).toEqual([leadId, leadId]);
    });

    it('an offered form expires: a late submission stores nothing and a fresh form is offered', async () => {
      const a = await chat(sbx, {
        action: 'test_drive',
        vin: sbx.vehicles[0].vin,
      });
      const form = card<{ id: string }>(a, 'lead_form')!;
      const lateEmail = `r12.late.${Date.now()}@example.invalid`;
      const pinned = process.env.CHAT_REFERENCE_NOW;
      process.env.CHAT_REFERENCE_NOW = new Date(
        referenceNow().getTime() + LEAD_FORM_TTL_MS + 60_000,
      ).toISOString();
      try {
        const late = await chat(sbx, {
          action: 'lead_capture',
          conversationId: a.conversationId,
          lead: lead(form.id, { email: lateEmail }),
        });
        expect(late.reply).toMatch(
          /form has expired, so I haven’t saved anything/,
        );
        expect(await consentRows(a.conversationId)).toHaveLength(0);
        expect(
          await ctx.prisma.lead.count({
            where: {
              tenantId: sbx.tenantId,
              email: lateEmail,
            },
          }),
        ).toBe(0);
        const fresh = card<{ id: string }>(late, 'lead_form')!;
        expect(fresh.id).not.toBe(form.id);
        // The fresh form works.
        const ok = await chat(sbx, {
          action: 'lead_capture',
          conversationId: a.conversationId,
          lead: lead(fresh.id, { email: lateEmail }),
        });
        expect(ok.reply).not.toMatch(/expired/);
        expect(await consentRows(a.conversationId)).toHaveLength(2);
      } finally {
        if (pinned === undefined) delete process.env.CHAT_REFERENCE_NOW;
        else process.env.CHAT_REFERENCE_NOW = pinned;
      }
    });

    it('email / call consent ticked on the form reach the ADF consent summary (via the ledger)', async () => {
      const keys = ['ADF_SEND_ENABLED', 'OUTBOX_PROCESSOR_ENABLED'] as const;
      const prev = keys.map((k) => process.env[k]);
      process.env.ADF_SEND_ENABLED = 'true';
      process.env.OUTBOX_PROCESSOR_ENABLED = 'false';
      const sink = ctx.app.get(SandboxSinkTransport);
      const flagsBefore = (
        await ctx.prisma.tenant.findUniqueOrThrow({
          where: { id: sbx.tenantId },
        })
      ).featureFlags as Record<string, boolean>;
      try {
        await ctx.prisma.tenant.update({
          where: { id: sbx.tenantId },
          data: { featureFlags: { ...flagsBefore, adfLeadDelivery: true } },
        });
        await seedSandboxRoutes(
          ctx.app.get(LeadDeliveryRouteService),
          [
            {
              tenantId: sbx.tenantId,
              locationId: sbx.locationId,
              slug: sbx.slug,
            },
          ],
          'cli:sdr-e2e',
        );
        const a = await chat(sbx, {
          action: 'test_drive',
          vin: sbx.vehicles[0].vin,
        });
        const form = card<{ id: string }>(a, 'lead_form')!;
        const email = `r12.adf.${Date.now()}@example.invalid`;
        await chat(sbx, {
          action: 'lead_capture',
          conversationId: a.conversationId,
          lead: lead(form.id, { email, phone: '(312) 555-0148' }),
        });
        const created = await ctx.prisma.lead.findFirstOrThrow({
          where: { tenantId: sbx.tenantId, email },
        });
        // Only the text flag exists on the lead row; email / call live on the ledger.
        expect(created.consentToText).toBe(false);
        const d = await ctx.prisma.leadDelivery.findFirstOrThrow({
          where: { leadId: created.id },
        });
        await ctx.prisma.outboxEvent.update({
          where: { id: d.outboxEventId as string },
          data: { nextAttemptAt: new Date(0) },
        });
        await ctx.app.get(OutboxProcessorService).processBatch(500, 'sdr-e2e');
        const sent = sink.messages().filter((m) => m.deliveryId === d.id);
        expect(sent).toHaveLength(1);
        expect(/Consent: [^;<]*/.exec(sent[0].xml)?.[0]).toBe(
          'Consent: text=not recorded, email=yes, call=yes',
        );
      } finally {
        keys.forEach((k, i) => {
          if (prev[i] === undefined) delete process.env[k];
          else process.env[k] = prev[i];
        });
        await ctx.prisma.tenant.update({
          where: { id: sbx.tenantId },
          data: { featureFlags: flagsBefore },
        });
      }
    });
  });

  // ───────────────────────────────────────── R10: staff-confirmed is not provider-confirmed

  describe('R10 — a staff-confirmed appointment is never worded or flagged as provider-confirmed', () => {
    it('same request replayed after staff confirmed it: "the dealership team confirmed it", verified:false, no providerRef', async () => {
      const typed = {
        message: `I'd like to come see the ${plain.vehicles[0].model} tomorrow at 11am`,
      };
      const first = await chat(plain, typed);
      const c1 = card<Record<string, unknown>>(first, 'appointment')!;
      expect(c1).toMatchObject({
        status: 'REQUESTED',
        outcome: 'requested',
        verified: false,
      });

      // Staff confirm by hand (phone / DMS): no scheduling provider, no receipt.
      await ctx.app.get(AppointmentService).staffTransition({
        tenantId: plain.tenantId,
        appointmentId: c1.id as string,
        to: 'CONFIRMED',
        actorId: 'staff-r10',
      });
      expect(
        await ctx.prisma.appointmentProviderReceipt.count({
          where: { appointmentId: c1.id as string },
        }),
      ).toBe(0);

      // The client retries the same turn as if the first answer had been lost (the stored
      // conversation state does not have the appointment yet).
      const where = {
        tenantId_externalKey: {
          tenantId: plain.tenantId,
          externalKey: first.conversationId,
        },
      };
      const conv = await ctx.prisma.conversation.findUniqueOrThrow({ where });
      const state = { ...(conv.state as Record<string, unknown>) };
      delete state.appointment;
      await ctx.prisma.conversation.update({
        where,
        data: { state: state as never },
      });
      const replay = await chat(plain, {
        ...typed,
        conversationId: first.conversationId,
      });
      const c2 = card<Record<string, unknown>>(replay, 'appointment')!;
      expect(c2).toMatchObject({
        id: c1.id,
        status: 'CONFIRMED',
        outcome: 'confirmed',
        verified: false,
      });
      expect(c2).not.toHaveProperty('providerRef');
      expect(c2).not.toHaveProperty('providerName');
      expect(c2).not.toHaveProperty('sandbox');
      expect(replay.reply).toMatch(/the dealership team confirmed it/);
      expect(replay.reply).not.toMatch(/scheduling system confirmed/);
      expect(
        await ctx.prisma.appointment.count({
          where: {
            tenantId: plain.tenantId,
            conversation: { externalKey: first.conversationId },
          },
        }),
      ).toBe(1);
    });
  });

  // ───────────────────────────────────────── R7: the sandbox label never gets lost

  describe('R7 — a sandbox confirmation keeps its demo label everywhere, and its wording is locked', () => {
    const state = async (conversationId: string) =>
      (
        await ctx.prisma.conversation.findUniqueOrThrow({
          where: {
            tenantId_externalKey: {
              tenantId: sbx.tenantId,
              externalKey: conversationId,
            },
          },
        })
      ).state as {
        appointment?: { status: string; sandbox?: boolean };
      };

    it('typed-time booking: the reply is not handed to the composer; state, card, journey, recap and model memory all carry the label', async () => {
      const composer = ctx.app.get(ConversationComposerService);
      // A composer that would happily drop the "demo booking" sentence.
      jest.spyOn(composer, 'isEnabled').mockReturnValue(true);
      const compose = jest.spyOn(composer, 'compose').mockResolvedValue({
        status: 'composed',
        text: 'You are all set for your test drive!',
        attempts: 1,
      });
      try {
        const j = await toSlotPicker(sbx); // contact known → the scheduler may be used
        compose.mockClear();
        // 10:00 AM store time tomorrow is a sandbox slot (15:00 UTC), typed — not tapped.
        const r = await chat(sbx, {
          conversationId: j.conversationId,
          message: 'Can I come for the test drive tomorrow at 10am?',
        });
        const a = card<Record<string, unknown>>(r, 'appointment')!;
        expect(a).toMatchObject({
          status: 'CONFIRMED',
          outcome: 'confirmed',
          sandbox: true,
        });
        expect(compose).not.toHaveBeenCalled(); // locked: fixed wording only
        expect(r.reply).toMatch(/sandbox scheduler confirmed/i);
        expect(r.reply).toMatch(/demo booking, not a real appointment/);
        expect((await state(j.conversationId)).appointment).toMatchObject({
          status: 'CONFIRMED',
          sandbox: true,
        });
        expect(r.journey.appointment).toMatchObject({
          status: 'CONFIRMED',
          sandbox: true,
        });
        // The receipt and the card agree (one derivation).
        const receipt =
          await ctx.prisma.appointmentProviderReceipt.findFirstOrThrow({
            where: { appointmentId: a.id as string, status: 'CONFIRMED' },
          });
        expect(receipt.sandbox).toBe(true);

        // A later turn that mentions the appointment: recap + the model's memory line.
        compose.mockReset();
        compose.mockResolvedValue({
          status: 'fallback',
          reasons: ['no_model'],
          attempts: 0,
        });
        const v = sbx.vehicles[0];
        const back = await chat(sbx, {
          conversationId: j.conversationId,
          message: `ok let's go back to the ${v.model}`,
        });
        expect(back.reply).toMatch(
          /demo booking on the sandbox scheduler, not a real appointment/,
        );
        expect(back.reply).not.toMatch(/is confirmed/);
        expect(compose).toHaveBeenCalled();
        const memory = JSON.stringify(compose.mock.calls[0][0].memory);
        expect(memory).toMatch(
          /SANDBOX DEMO booking \(not a real appointment\)/,
        );
        expect(memory).not.toMatch(/confirmed appointment/);
        expect(back.journey.appointment).toMatchObject({ sandbox: true });
      } finally {
        jest.restoreAllMocks();
      }
    });

    it('the "you already have…" answer for a sandbox booking says it is a demo booking', async () => {
      const j = await toSlotPicker(sbx);
      await select(sbx, j.conversationId, j.picker.id, j.picker.slots[5].id);
      const second = await select(
        sbx,
        j.conversationId,
        j.picker.id,
        j.picker.slots[6].id,
      );
      expect(second.reply).toMatch(
        /You already have a test drive booked for .* on the sandbox scheduler \(a demo booking, not a real appointment\)/,
      );
    });
  });

  // ───────────────────────────────────────── R6: no orphan provider booking

  describe('R6 — a late provider success after a timeout is compensated through the outbox', () => {
    it('timeout ⇒ REQUESTED + UNKNOWN receipt + reconcile job; retry books nothing new; the job reconciles to exactly one CONFIRMED appointment', async () => {
      const registry = ctx.app.get(SchedulingProviderRegistry);
      const processor = ctx.app.get(OutboxProcessorService);
      const adapter = registry.adapterFor('MOCK')!;
      const j = await toSlotPicker(sbx);
      const slot = j.picker.slots[4];

      // The scheduler answers after 700 ms; AMQUR gives up after 150 ms.
      const realCreate = adapter.create!.bind(adapter);
      const create = jest
        .spyOn(adapter, 'create')
        .mockImplementation(async (c, req) => {
          await new Promise((r) => setTimeout(r, 700));
          return realCreate(c, req);
        });
      const realContext = registry.context.bind(registry);
      jest
        .spyOn(registry, 'context')
        .mockImplementation((...a: Parameters<typeof realContext>) => ({
          ...realContext(...a),
          timeoutMs: 150,
        }));
      const prevOutbox = process.env.OUTBOX_PROCESSOR_ENABLED;
      process.env.OUTBOX_PROCESSOR_ENABLED = 'false'; // drive the worker by hand
      try {
        const first = await select(sbx, j.conversationId, j.picker.id, slot.id);
        const c1 = card<Record<string, unknown>>(first, 'appointment')!;
        expect(c1).toMatchObject({
          status: 'REQUESTED',
          outcome: 'requested',
          verified: false,
        });
        expect(c1).not.toHaveProperty('providerRef');
        expect(first.reply).not.toMatch(/confirmed/i);

        const row = () =>
          ctx.prisma.appointment.findUniqueOrThrow({
            where: { id: c1.id as string },
            include: { providerReceipts: { orderBy: { receivedAt: 'asc' } } },
          });
        const before = await row();
        expect(before).toMatchObject({
          status: 'REQUESTED',
          providerStatus: 'UNKNOWN:provider_timeout',
        });
        expect(before.providerReceipts.map((r) => r.status)).toEqual([
          'UNKNOWN',
        ]);
        const job = await ctx.prisma.outboxEvent.findFirstOrThrow({
          where: {
            tenantId: sbx.tenantId,
            topic: APPOINTMENT_RECONCILE_TOPIC,
            idempotencyKey: `${APPOINTMENT_RECONCILE_TOPIC}:${before.idempotencyKey}`,
          },
        });
        expect(job.status).toBe('PENDING');
        // The job payload is references only — no customer data.
        expect(JSON.stringify(job.payload)).not.toMatch(/Robin|Vale|555|@/);

        // The late success lands at the provider.
        await new Promise((r) => setTimeout(r, 800));
        // Retry of the same selection: no second provider call, no second appointment.
        await select(sbx, j.conversationId, j.picker.id, slot.id);
        expect(create).toHaveBeenCalledTimes(1);
        expect(await activeAppointments(sbx, j.conversationId)).toHaveLength(1);

        // The compensation job runs on the normal outbox worker.
        await ctx.prisma.outboxEvent.update({
          where: { id: job.id },
          data: { nextAttemptAt: new Date(0) },
        });
        await processor.processBatch(500, 'sdr-e2e');
        expect(
          await ctx.prisma.outboxEvent.findUniqueOrThrow({
            where: { id: job.id },
          }),
        ).toMatchObject({
          status: 'PUBLISHED',
          lastError: 'reconciled_confirmed',
        });
        const after = await row();
        expect(after).toMatchObject({
          status: 'CONFIRMED',
          provider: 'MOCK',
          availabilityVerified: true,
        });
        expect(after.scheduledAt!.toISOString()).toBe(slot.start);
        expect(after.providerReceipts.map((r) => r.status)).toEqual([
          'UNKNOWN',
          'CONFIRMED',
        ]);
        expect(after.providerReceipts[1]).toMatchObject({
          providerRef: after.externalProviderId,
          sandbox: true,
        });
        expect(await activeAppointments(sbx, j.conversationId)).toHaveLength(1);
        expect(create).toHaveBeenCalledTimes(1);
      } finally {
        if (prevOutbox === undefined)
          delete process.env.OUTBOX_PROCESSOR_ENABLED;
        else process.env.OUTBOX_PROCESSOR_ENABLED = prevOutbox;
        jest.restoreAllMocks();
      }
    });
  });

  // ───────────────────────────────────────── R5: no double booking from a remembered card

  describe('R5 — a remembered picker cannot book a second appointment', () => {
    it('slot A confirmed, then slot B tapped on the same card ⇒ B is NOT booked; the answer says what exists and offers a change', async () => {
      const j = await toSlotPicker(sbx);
      const [slotA, slotB] = [j.picker.slots[0], j.picker.slots[2]];
      const first = await select(sbx, j.conversationId, j.picker.id, slotA.id);
      const a = card<Record<string, string>>(first, 'appointment')!;
      expect(a).toMatchObject({ status: 'CONFIRMED', outcome: 'confirmed' });

      const second = await select(sbx, j.conversationId, j.picker.id, slotB.id);
      expect(card(second, 'appointment')).toBeUndefined();
      expect(second.reply).toMatch(/You already have a test drive booked for/);
      expect(second.reply).toMatch(/nothing new was booked/);
      expect(second.reply).toMatch(/Do you want to change it\?/);
      expect(second.reply).not.toMatch(/confirmed a/i);
      // The change flow is offered as a request-only picker — never fresh bookable slots.
      const again = card<Picker>(second, 'appointment_picker');
      if (again) expect(again.mode).toBe('request_only');

      const rows = await activeAppointments(sbx, j.conversationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: a.id, status: 'CONFIRMED' });
      expect(rows[0].scheduledAt!.toISOString()).toBe(slotA.start);
      expect(
        await ctx.prisma.appointmentProviderReceipt.count({
          where: {
            tenantId: sbx.tenantId,
            status: 'CONFIRMED',
            appointment: { conversation: { externalKey: j.conversationId } },
          },
        }),
      ).toBe(1);
      // Slot B was never held: another customer is still offered it.
      const next = await toSlotPicker(sbx);
      expect(next.picker.slots.map((s) => s.start)).toContain(slotB.start);
      expect(next.picker.slots.map((s) => s.start)).not.toContain(slotA.start);

      // Tapping the booked slot again is still an idempotent replay of the same booking.
      const replay = await select(sbx, j.conversationId, j.picker.id, slotA.id);
      expect(card<Record<string, string>>(replay, 'appointment')).toMatchObject(
        {
          id: a.id,
          outcome: 'confirmed',
        },
      );
      expect(await activeAppointments(sbx, j.conversationId)).toHaveLength(1);
    });

    it('once staff cancel the booking the spent card is refused plainly and a fresh picker is offered', async () => {
      const j = await toSlotPicker(sbx);
      const first = await select(
        sbx,
        j.conversationId,
        j.picker.id,
        j.picker.slots[1].id,
      );
      const a = card<Record<string, string>>(first, 'appointment')!;
      await ctx.prisma.appointment.update({
        where: { id: a.id },
        data: { status: 'CANCELLED', canceledAt: new Date() },
      });
      const r = await select(
        sbx,
        j.conversationId,
        j.picker.id,
        j.picker.slots[3].id,
      );
      expect(card(r, 'appointment')).toBeUndefined();
      expect(r.reply).not.toMatch(/You already have/);
      expect(r.reply).toMatch(/nothing new was booked/);
      expect(card<Picker>(r, 'appointment_picker')).toBeDefined();
      expect(await activeAppointments(sbx, j.conversationId)).toHaveLength(0);
    });
  });
});
