import request from 'supertest';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { seedDemoDealer, SIM_ORIGIN, DemoDealer } from '../helpers/demo-dealer';

type Body = {
  conversationId: string;
  reply: string;
  type?: string;
  cards: Array<Record<string, unknown>>;
  vehicles?: Array<{ vin: string; status?: string }>;
  journey: Record<string, Record<string, unknown> | null>;
};

/**
 * The owner's real transcript (2026-10-14) and the demo-rescue scenarios, end to end through
 * the API with database assertions. Deterministic mode (no model in CI).
 */
describe('owner demo rescue — transcript and scenarios', () => {
  let ctx: E2eCtx;
  let d: DemoDealer;
  const http = () => request(ctx.app.getHttpServer());
  let token: string;
  let cid: string | undefined;
  const say = async (message: string) => {
    const r = await http()
      .post('/api/chat')
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', SIM_ORIGIN)
      .send({ message, conversationId: cid });
    expect(r.status).toBe(201);
    const b = unwrap<Body>(r.body);
    cid = b.conversationId;
    return b;
  };
  const conversation = async () =>
    ctx.prisma.conversation.findFirstOrThrow({
      where: { tenantId: d.tenantId, externalKey: cid },
      select: { id: true },
    });

  beforeAll(async () => {
    ctx = await createE2eApp();
    d = await seedDemoDealer(ctx.app, ctx.prisma, 'owner-rescue', {
      creditPreview: true,
    });
    const t = await http()
      .post('/api/public/widget-token')
      .set('Origin', SIM_ORIGIN)
      .send({ tenantSlug: d.slug, locationSlug: 'main' });
    token = unwrap<{ token: string }>(t.body).token;
  }, 60_000);
  afterAll(async () => ctx.app.close());

  const gc = () => d.vehicles.find((v) => v.model === 'Grand Cherokee')!;

  it('search names an in-transit unit as in transit, never "in stock"', async () => {
    const r = await say('Show me some Grand Cherokees');
    expect(r.vehicles?.[0].vin).toBe(gc().vin);
    expect(r.reply).toMatch(/in transit/i);
    expect(r.reply).not.toMatch(/in stock right now/i);
  });

  it('"How to buy it now?" starts a purchase on the exact vehicle and asks finance or cash', async () => {
    const r = await say('How to buy it now?');
    expect(r.reply).not.toMatch(/not something I have in the dealership/i);
    expect(r.reply).toMatch(/in transit/i);
    expect(r.reply).toContain(gc().stock);
    expect(r.reply).toMatch(/finance or pay cash/i);
    expect(r.reply).not.toMatch(/test drive (?:today|now)/i);
    const esc = await ctx.prisma.escalation.findFirstOrThrow({
      where: {
        tenantId: d.tenantId,
        conversationId: (await conversation()).id,
      },
    });
    expect(esc.reason).toBe('Purchase-ready customer');
    expect(esc.summary).toContain(gc().vin);
    expect(esc.summary).toContain('IN_TRANSIT');
  });

  it('OTD states the advertised price, names the missing inputs and saves a quote request', async () => {
    const r = await say('Out the door price');
    expect(r.reply).toMatch(/advertised price/i);
    expect(r.reply).toMatch(
      /sales tax|documentation fee|title and registration/i,
    );
    expect(r.reply).not.toMatch(/sent the request/i);
    const card = r.cards.find((c) => c.kind === 'otd_quote');
    expect(card?.status).toBe('requested');
    expect(card?.total).toBeNull();
    const q = await ctx.prisma.priceQuoteRequest.findFirst({
      where: { tenantId: d.tenantId, vehicleVin: gc().vin },
    });
    expect(q).toBeTruthy();
  });

  it('"What if I put five grand down?" recalculates with $5,000 down on the same vehicle', async () => {
    const r = await say('What if I put five grand down?');
    const card = r.cards.find((c) => c.kind === 'payment') as
      | { downPayment?: number; vin?: string }
      | undefined;
    expect(card).toBeTruthy();
    expect(r.reply).toContain('$5,000 down');
    expect(r.reply).toMatch(/estimate, not a financing offer/i);
  });

  it('"What if I come tomorrow at 5?" is a visit request (not a payment, not a test drive)', async () => {
    const r = await say('What if I come tomorrow at 5?');
    expect(r.cards.some((c) => c.kind === 'payment')).toBe(false);
    expect(r.reply).toMatch(/in transit/i);
    const appt = r.cards.find((c) => c.kind === 'appointment');
    expect(appt?.status).toBe('REQUESTED');
    const rows = await ctx.prisma.appointment.findMany({
      where: {
        tenantId: d.tenantId,
        conversationId: (await conversation()).id,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('SALES');
    expect(rows[0].status).toBe('REQUESTED');
  });

  it('service request keeps its date across turns and does not overwrite the shopping vehicle', async () => {
    await say('I need an oil change Friday');
    await say('2019 Jeep Cherokee');
    const r = await say('morning');
    expect(r.reply).toMatch(/requested a service visit/i);
    expect(r.journey.selectedVehicle?.vin).toBe(gc().vin);
    const svc = await ctx.prisma.appointment.findFirstOrThrow({
      where: {
        tenantId: d.tenantId,
        conversationId: (await conversation()).id,
        type: 'SERVICE',
      },
    });
    expect(svc.status).toBe('REQUESTED');
    expect(svc.requestedTime).toBe('morning');
  });

  it('credit app in a non-production preview is labeled PREVIEW, never "shared"', async () => {
    const r = await say('Can you send the credit app?');
    const card = r.cards.find((c) => c.kind === 'credit_application') as
      | { preview?: boolean; url?: string }
      | undefined;
    expect(card?.preview).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/tekioncloud|token=/i);
    expect(r.journey.creditApplication?.state).toBe('PREVIEW');
  });

  it('callback: name + phone in one reply attach to the lead and every open request', async () => {
    await say('Can someone call me?');
    const r = await say('Mike Jones 312-555-0188');
    expect(r.reply).not.toMatch(/who should the team ask for/i);
    const conv = await conversation();
    const lead = await ctx.prisma.lead.findFirstOrThrow({
      where: { tenantId: d.tenantId, conversationId: conv.id },
    });
    expect(lead.firstName).toBe('Mike');
    expect(lead.lastName).toBe('Jones');
    expect(lead.phone).toBe('3125550188');
    const appts = await ctx.prisma.appointment.findMany({
      where: { tenantId: d.tenantId, conversationId: conv.id },
    });
    expect(appts.every((a) => a.customerPhone === '3125550188')).toBe(true);
  });

  it('"let\'s go back to the Jeep" restores the selection and recaps it', async () => {
    const r = await say("Actually, let's go back to the Jeep");
    expect(r.reply).toMatch(/^Back to the .*Grand Cherokee/);
    expect(r.reply).toMatch(/\$5,000 down/);
    expect(r.vehicles?.[0].vin).toBe(gc().vin);
  });

  it('general automotive questions are answered, not deflected', async () => {
    const r = await say("what's the difference between AWD and 4WD?");
    expect(r.reply).toMatch(/all-wheel drive/i);
    expect(r.reply).not.toMatch(/not something I have/i);
  });

  it('"Actually I changed my mind" never becomes a Charger search', async () => {
    const r = await say('Actually I changed my mind.');
    expect(r.reply).not.toMatch(/Charger/);
    expect(r.reply).toMatch(/no problem/i);
  });
});
