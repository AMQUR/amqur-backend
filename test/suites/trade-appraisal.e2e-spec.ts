import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { seedDemoDealer, SIM_ORIGIN, DemoDealer } from '../helpers/demo-dealer';

/**
 * Trade-in appraisal lifecycle over HTTP + Postgres: no value until a human (or licensed
 * provider) records one; staff cannot release values; only managers issue expiring offers;
 * other stores cannot touch the trade.
 */
describe('trade-in appraisal lifecycle', () => {
  let ctx: E2eCtx;
  let d: DemoDealer;
  let other: DemoDealer;
  let widget: string;
  const tok: Record<string, string> = {};
  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await createE2eApp();
    d = await seedDemoDealer(ctx.app, ctx.prisma, 'trade-motors', {
      creditPreview: false,
    });
    other = await seedDemoDealer(ctx.app, ctx.prisma, 'trade-other', {
      creditPreview: false,
    });
    const hash = await bcrypt.hash('TradeTest123!', 10);
    const users: Array<[string, string, Role]> = [
      ['staff@trade-motors.test', d.tenantId, Role.STAFF],
      ['manager@trade-motors.test', d.tenantId, Role.MANAGER],
      ['manager@trade-other.test', other.tenantId, Role.MANAGER],
    ];
    for (const [email, tenantId, role] of users) {
      await ctx.prisma.user.upsert({
        where: { tenantId_email: { tenantId, email } },
        create: {
          tenantId,
          email,
          password: hash,
          firstName: 'T',
          lastName: role,
          role,
        },
        update: { password: hash, role, isActive: true },
      });
      const r = await http()
        .post('/api/auth/login')
        .send({ email, password: 'TradeTest123!' });
      const b = unwrap<{ access_token?: string; accessToken?: string }>(r.body);
      tok[email] = b.access_token || b.accessToken || '';
    }
    const w = await http()
      .post('/api/public/widget-token')
      .set('Origin', SIM_ORIGIN)
      .send({ tenantSlug: d.slug, locationSlug: 'main' });
    widget = unwrap<{ token: string }>(w.body).token;
  }, 60_000);
  afterAll(async () => ctx.app.close());

  const chat = async (message: string, conversationId?: string) =>
    unwrap<{
      reply: string;
      conversationId: string;
      cards: Array<Record<string, unknown> & { kind: string }>;
    }>(
      (
        await http()
          .post('/api/chat')
          .set('Authorization', `Bearer ${widget}`)
          .set('Origin', SIM_ORIGIN)
          .send({ message, conversationId })
      ).body,
    );

  it('no value is shown until the dealership records one; staff cannot release it; managers issue expiring offers', async () => {
    const a = await chat(
      'I want to trade in my 2019 Jeep Cherokee with 48k miles',
    );
    const card = a.cards.find((c) => c.kind === 'trade')!;
    expect(card.appraisalVerified).toBe(false);
    expect(a.reply).not.toMatch(/\$\d/);
    const tradeId = String(card.id);
    expect(
      (await ctx.prisma.tradeRequest.findUnique({ where: { id: tradeId } }))
        ?.status,
    ).toBe('APPRAISAL_PENDING');

    // Staff appraisal is recorded but cannot be released to the customer by a non-manager.
    const s = await http()
      .post(`/api/ops/trades/${tradeId}/appraisals`)
      .set('Authorization', `Bearer ${tok['staff@trade-motors.test']}`)
      .send({ amount: 18500, showToCustomer: true });
    expect(s.status).toBe(201);
    expect(unwrap<{ displayPermitted: boolean }>(s.body).displayPermitted).toBe(
      false,
    );
    const b = await chat('what is my trade worth?', a.conversationId);
    expect(b.reply).not.toMatch(/18,500/);

    // Staff cannot issue offers.
    expect(
      (
        await http()
          .post(`/api/ops/trades/${tradeId}/offer`)
          .set('Authorization', `Bearer ${tok['staff@trade-motors.test']}`)
          .send({ amount: 19000, validDays: 7 })
      ).status,
    ).toBe(403);
    // Another store's manager cannot touch this trade.
    expect([403, 404]).toContain(
      (
        await http()
          .post(`/api/ops/trades/${tradeId}/offer`)
          .set('Authorization', `Bearer ${tok['manager@trade-other.test']}`)
          .send({ amount: 99999, validDays: 7 })
      ).status,
    );

    // Manager offer → customer sees it, labeled with expiry and separated from financing.
    const o = await http()
      .post(`/api/ops/trades/${tradeId}/offer`)
      .set('Authorization', `Bearer ${tok['manager@trade-motors.test']}`)
      .send({ amount: 19250, validDays: 7 });
    expect(o.status).toBe(201);
    const c = await chat("what's my trade-in worth now?", a.conversationId);
    expect(c.reply).toMatch(/\$19,250/);
    expect(c.reply).toMatch(/valid through/);
    expect(c.reply).toMatch(/separate from any financing/);
    const tc = c.cards.find((x) => x.kind === 'trade')!;
    expect(tc.appraisalVerified).toBe(true);
    expect((tc.value as { kind: string }).kind).toBe('FINAL_OFFER');

    // Expired offers disappear.
    await ctx.prisma.tradeAppraisal.updateMany({
      where: { tradeRequestId: tradeId, kind: 'FINAL_OFFER' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const e = await chat("what's the trade offer again?", a.conversationId);
    expect(e.reply).not.toMatch(/\$19,250/);

    const audit = await ctx.prisma.auditLog.count({
      where: {
        tenantId: d.tenantId,
        resourceId: tradeId,
        action: { in: ['trade.appraisal.recorded', 'trade.offer.issued'] },
      },
    });
    expect(audit).toBe(2);
  });

  it('provider status reports every candidate as not licensed (fails closed)', async () => {
    const r = await http()
      .get('/api/ops/appraisal-providers')
      .set('Authorization', `Bearer ${tok['manager@trade-motors.test']}`);
    const rows = unwrap<
      Array<{ id: string; status: string; registered: boolean }>
    >(r.body);
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(
      rows.every((x) => x.status === 'NOT_LICENSED' && !x.registered),
    ).toBe(true);
  });
});
