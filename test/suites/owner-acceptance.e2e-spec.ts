import request from 'supertest';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { seedDemoDealer, SIM_ORIGIN, DemoDealer } from '../helpers/demo-dealer';

type Body = {
  conversationId: string;
  reply: string;
  type?: string;
  cards: Array<Record<string, unknown>>;
  vehicles?: Array<{ vin: string }>;
  journey: Record<string, Record<string, unknown> | null>;
  conversation: { pending: string };
};

/**
 * Aqueel's owner acceptance test (2026-10-14): his real messages, the 17-turn replay and
 * unseen owner-style follow-ups. Asserts intent outcomes, visible replies and persisted
 * records. Deterministic mode (no model in CI) — the model can only add to this.
 */
describe('owner acceptance — real owner conversation', () => {
  let ctx: E2eCtx;
  let d: DemoDealer;
  const http = () => request(ctx.app.getHttpServer());
  const NAME = 'Dial Concierge';

  const session = async () => {
    const t = await http()
      .post('/api/public/widget-token')
      .set('Origin', SIM_ORIGIN)
      .send({ tenantSlug: d.slug, locationSlug: 'main' });
    const token = unwrap<{ token: string }>(t.body).token;
    let cid: string | undefined;
    return {
      get cid() {
        return cid;
      },
      say: async (message: string) => {
        const r = await http()
          .post('/api/chat')
          .set('Authorization', `Bearer ${token}`)
          .set('Origin', SIM_ORIGIN)
          .send({ message, conversationId: cid });
        expect(r.status).toBe(201);
        const b = unwrap<Body>(r.body);
        cid = b.conversationId;
        return b;
      },
    };
  };

  beforeAll(async () => {
    ctx = await createE2eApp();
    d = await seedDemoDealer(ctx.app, ctx.prisma, 'owner-accept');
    await ctx.prisma.tenant.update({
      where: { id: d.tenantId },
      data: { publicConfig: { assistantDisplayName: NAME } },
    });
  }, 60_000);
  afterAll(async () => ctx.app.close());

  const gc = () => d.vehicles.find((v) => v.model === 'Grand Cherokee')!;
  const noFallback = (r: Body) =>
    expect(r.reply).not.toMatch(
      /not something I have in the dealership|didn't quite (?:catch|follow)/i,
    );

  it('17-turn replay: identity, interest, price, lot age, manager, money, visit, service, resume, purchase', async () => {
    const s = await session();
    const r1 = await s.say('ello');
    noFallback(r1);

    const r2 = await s.say('Why are you texting me?');
    expect(r2.reply).toMatch(/not texting you|website/i);
    expect(r2.reply).not.toMatch(/sent you a text|texted you/i);

    const r3 = await s.say('Well I never contacted you.');
    expect(r3.reply).toMatch(/you didn.t reach out|haven.t sent/i);
    expect(r3.reply).not.toMatch(/\$|test drive|payment/i);

    const r4 = await s.say('What is your name?');
    expect(r4.reply).toContain(NAME);

    const r5 = await s.say("I'm looking for a ride.");
    noFallback(r5);

    const r6 = await s.say('Show me your Grand Cherokees.');
    expect(r6.vehicles?.[0].vin).toBe(gc().vin);
    expect(r6.reply).toMatch(/in transit/i);

    const r7 = await s.say("Yes, I'm interested in that one.");
    expect(r7.journey.selectedVehicle?.vin).toBe(gc().vin);
    expect(r7.cards.some((c) => c.kind === 'appointment')).toBe(false);

    const r8 = await s.say('How much is it?');
    expect(r8.reply).toContain('$49,870');
    expect(r8.reply).toMatch(/demo figure/i);
    expect(r8.reply).not.toMatch(/\$[\d,]+ (?:a|per) month|out-the-door total is/i);

    const r9 = await s.say('How long has it been on your lot?');
    expect(r9.reply).toMatch(/isn.t on the lot yet|in transit/i);
    expect(r9.reply).not.toMatch(/\b\d+ days\b/);

    const r10 = await s.say('Who is your manager?');
    expect(r10.reply).toMatch(/won.t guess|don.t have the managers/i);
    expect(r10.cards.some((c) => c.kind === 'handoff')).toBe(false);

    const r11 = await s.say(
      'What would my monthly payment be with five grand down?',
    );
    expect(r11.cards.some((c) => c.kind === 'payment')).toBe(true);
    expect(r11.reply).toContain('$5,000 down');

    const r12 = await s.say("What's the out-the-door price?");
    const otd = r12.cards.find((c) => c.kind === 'otd_quote');
    expect(otd?.status).toBe('requested');
    expect(r12.conversation.pending).toBe('otd_zip');

    const r13 = await s.say('Can you send me the credit app?');
    expect(r13.cards.some((c) => c.kind === 'credit_application')).toBe(true);
    expect(r13.reply).not.toMatch(/test drive/i); // vehicle is in transit

    const r14 = await s.say('Can I come tomorrow?');
    expect(r14.reply).toMatch(/in transit/i);

    const r15 = await s.say('Actually, I need an oil change for my Cherokee.');
    expect(r15.journey.selectedVehicle?.vin).toBe(gc().vin);

    const r16 = await s.say("Let's go back to the Jeep I wanted.");
    expect(r16.reply).toMatch(/^Back to the .*Grand Cherokee/);

    const r17 = await s.say('How do I get started buying it?');
    expect(r17.reply).toMatch(/in transit/i);
    expect(r17.reply).toMatch(/finance or pay cash/i);

    // Nothing was booked by a stray "yes"; only REQUESTED rows exist.
    const conv = await ctx.prisma.conversation.findFirstOrThrow({
      where: { tenantId: d.tenantId, externalKey: s.cid },
    });
    const appts = await ctx.prisma.appointment.findMany({
      where: { tenantId: d.tenantId, conversationId: conv.id },
    });
    expect(appts.every((a) => a.status === 'REQUESTED')).toBe(true);
    expect(appts.some((a) => a.type === 'TEST_DRIVE')).toBe(false);
  });

  it('a "yes" after a payment estimate never books a visit', async () => {
    const s = await session();
    await s.say('Grand Cherokee');
    const p = await s.say('payment with 3k down');
    expect(p.cards.some((c) => c.kind === 'payment')).toBe(true);
    const y = await s.say('yes');
    expect(y.cards.some((c) => c.kind === 'appointment')).toBe(false);
    expect(y.reply).toMatch(/down payment or term/i);
  });

  it('an either/or question answered "yes" asks which', async () => {
    const s = await session();
    await s.say('do you have wranglers');
    await s.say('the earl one');
    const r = await s.say('how much');
    expect(r.reply).toMatch(/\$51,995/);
    const y = await s.say('yes');
    expect(y.reply).toMatch(/which one/i);
    expect(y.cards).toHaveLength(0);
  });

  it('"yes" with several cars on screen asks which one; "how much" lists their prices', async () => {
    const s = await session();
    await s.say('do you have wranglers');
    const y = await s.say('yes');
    expect(y.conversation.pending).toBe('vehicle_choice');
    const h = await s.say('how much');
    expect(h.reply).toMatch(/\$51,995/);
    expect(h.reply).toMatch(/\$41,890/);
  });

  it('a bare "yes" with no question pending does nothing consequential', async () => {
    const s = await session();
    const y = await s.say('yes');
    expect(y.cards).toHaveLength(0);
  });

  it('short follow-ups: hold on / why / what about tomorrow / cash', async () => {
    const s = await session();
    await s.say('Grand Cherokee');
    await s.say("What's the out-the-door price?");
    const why = await s.say('why');
    expect(why.reply).toMatch(/ZIP decides|sales tax/i);
    const hold = await s.say('hold on');
    expect(hold.reply).toMatch(/take your time/i);
    const s2 = await session();
    await s2.say('show me trucks');
    await s2.say('that one');
    const cash = await s2.say('cash');
    expect(cash.cards.some((c) => c.kind === 'otd_quote')).toBe(true);
    const s3 = await session();
    await s3.say('do you have wranglers');
    const tm = await s3.say('what about tomorrow');
    expect(tm.conversation.pending).toBe('appointment_time');
  });

  it('two sessions for the same store never share journey state', async () => {
    const a = await session();
    await a.say('Grand Cherokee');
    await a.say('payment with 5k down');
    const b = await session();
    const r = await b.say('hi');
    expect(b.cid).not.toBe(a.cid);
    expect(r.journey.selectedVehicle ?? null).toBeNull();
    expect(r.journey.payment ?? null).toBeNull();
  });
});
