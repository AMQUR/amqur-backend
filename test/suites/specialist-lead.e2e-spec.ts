import request from 'supertest';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { seedDemoDealer, SIM_ORIGIN, DemoDealer } from '../helpers/demo-dealer';

type Body = {
  conversationId: string;
  reply: string;
  cards: Array<Record<string, unknown>>;
};

/**
 * A shopper asks for something only a person can give (out-the-door price, a callback, a
 * salesperson). The assistant collects first name, last name and a phone or email, creates
 * ONE lead with those fields (plus the registration ZIP for an out-the-door request), and only
 * then says a specialist will reach out.
 */
describe('specialist lead: natural contact collection', () => {
  let ctx: E2eCtx;
  let d: DemoDealer;
  const http = () => request(ctx.app.getHttpServer());
  let token: string;

  const chat = () => {
    let cid: string | undefined;
    const say = async (message: string, vin?: string) => {
      const r = await http()
        .post('/api/chat')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', SIM_ORIGIN)
        .send({ message, conversationId: cid, ...(vin ? { vin } : {}) });
      expect(r.status).toBe(201);
      const b = unwrap<Body>(r.body);
      cid = b.conversationId;
      return b;
    };
    const leads = async () => {
      const conv = await ctx.prisma.conversation.findFirst({
        where: { tenantId: d.tenantId, externalKey: cid },
        select: { id: true },
      });
      return conv
        ? ctx.prisma.lead.findMany({
            where: { tenantId: d.tenantId, conversationId: conv.id },
          })
        : [];
    };
    return { say, leads };
  };

  beforeAll(async () => {
    ctx = await createE2eApp();
    d = await seedDemoDealer(ctx.app, ctx.prisma, 'specialist-lead', {});
    const t = await http()
      .post('/api/public/widget-token')
      .set('Origin', SIM_ORIGIN)
      .send({ tenantSlug: d.slug, locationSlug: 'main' });
    token = unwrap<{ token: string }>(t.body).token;
  }, 60_000);
  afterAll(async () => ctx.app.close());

  it('callback: asks name, then last name, then phone or email; promises only after the lead exists', async () => {
    const c = chat();
    const r1 = await c.say('Can someone call me?');
    expect(r1.reply).toMatch(/first and last name/i);
    expect(r1.reply).not.toMatch(/will reach out/i);
    expect(await c.leads()).toHaveLength(0);

    const r2 = await c.say('Maria');
    expect(r2.reply).toMatch(/last name/i);

    const r3 = await c.say('Garcia');
    expect(r3.reply).toMatch(/phone number or email/i);
    expect(r3.reply).not.toMatch(/will reach out/i);
    expect(await c.leads()).toHaveLength(0);

    const r4 = await c.say('312-555-0142');
    expect(r4.reply).toMatch(
      /Thanks, Maria\. A specialist.* will reach out shortly by phone\./,
    );
    expect(r4.reply).not.toMatch(/confirmed|sent|booked/i);
    const leads = await c.leads();
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      firstName: 'Maria',
      lastName: 'Garcia',
      phone: '3125550142',
    });

    // Later turns never create a second lead or repeat the promise.
    const r5 = await c.say('thanks!');
    expect(r5.reply).not.toMatch(/will reach out shortly/i);
    expect(await c.leads()).toHaveLength(1);
  });

  it('name and email in one reply: still asks the last name once, then creates the lead', async () => {
    const c = chat();
    await c.say('I want to talk to a salesperson');
    const r = await c.say('Sam, sam.lee@example.com');
    expect(r.reply).toMatch(/last name/i);
    expect(await c.leads()).toHaveLength(0);
    const r2 = await c.say('Lee');
    expect(r2.reply).toMatch(/will reach out shortly by email/i);
    const leads = await c.leads();
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      firstName: 'Sam',
      lastName: 'Lee',
      email: 'sam.lee@example.com',
    });
  });

  it('a shopper who skips the last name is not asked twice and still gets a lead', async () => {
    const c = chat();
    await c.say('Can someone call me?');
    await c.say('Pat');
    const r = await c.say("I'd rather not say, my number is 312-555-0177");
    expect(r.reply).not.toMatch(/last name/i);
    expect(r.reply).toMatch(/will reach out shortly by phone/i);
    const leads = await c.leads();
    expect(leads).toHaveLength(1);
    expect(leads[0].lastName).toBeNull();
  });

  it('out-the-door price: the registration ZIP rides on the lead', async () => {
    const c = chat();
    const v = d.vehicles.find((x) => x.status === 'AVAILABLE') ?? d.vehicles[0];
    const log: string[] = [];
    const say = async (m: string, vin?: string) => {
      const b = await c.say(m, vin);
      log.push(`> ${m}\n${b.reply}`);
      return b;
    };
    await say(`Tell me about this ${v.model}`, v.vin);
    await say('What is the out the door price?');
    await say('60659');
    const r = await say('Alex Rivera');
    if (!/phone number or email/i.test(r.reply))
      throw new Error(log.join('\n---\n'));
    const done = await say('alex.rivera@example.com');
    expect(done.reply).toMatch(/will reach out shortly by email/i);
    const leads = await c.leads();
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      firstName: 'Alex',
      lastName: 'Rivera',
      email: 'alex.rivera@example.com',
      zipCode: '60659',
    });
  });

  it('ordinary questions never ask for contact details', async () => {
    const c = chat();
    const r = await c.say("what's the difference between AWD and 4WD?");
    expect(r.reply).not.toMatch(/first and last name|phone number or email/i);
    expect(await c.leads()).toHaveLength(0);
  });
});
