import request from 'supertest';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { DemoDealer, seedDemoDealer, SIM_ORIGIN } from '../helpers/demo-dealer';
import { LEAD_FORM_CONSENT_VERSION } from '../../src/chat/sales-desk/consent-wording';

/**
 * Regression tests for the PR #55 review findings on the sales-desk cards and the sandbox
 * scheduler (R5, R7, R10, R12). Real API, Postgres, the in-process SANDBOX scheduler.
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

describe('sales desk + sandbox scheduler — review findings (R5, R7, R10, R12)', () => {
  let ctx: E2eCtx;
  let sbx: DemoDealer; // salesDeskCards + sandbox scheduler
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
    return {
      conversationId: a.conversationId,
      picker: card<Picker>(b, 'appointment_picker')!,
    };
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
