import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { seedDemoDealer, SIM_ORIGIN, DemoDealer } from '../helpers/demo-dealer';

describe('greeting experiments', () => {
  let ctx: E2eCtx;
  let d: DemoDealer;
  const tok: Record<string, string> = {};
  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await createE2eApp();
    d = await seedDemoDealer(ctx.app, ctx.prisma, 'exp-motors', {
      creditPreview: false,
    });
    await ctx.prisma.experiment.deleteMany({ where: { tenantId: d.tenantId } });
    const hash = await bcrypt.hash('ExpTest123!', 10);
    for (const email of ['m1@exp.test', 'm2@exp.test']) {
      await ctx.prisma.user.upsert({
        where: { tenantId_email: { tenantId: d.tenantId, email } },
        create: {
          tenantId: d.tenantId,
          email,
          password: hash,
          firstName: 'E',
          lastName: 'M',
          role: Role.MANAGER,
        },
        update: { password: hash, role: Role.MANAGER, isActive: true },
      });
      const r = await http()
        .post('/api/auth/login')
        .send({ email, password: 'ExpTest123!' });
      const b = unwrap<{ access_token?: string; accessToken?: string }>(r.body);
      tok[email] = b.access_token || b.accessToken || '';
    }
  }, 60_000);
  afterAll(async () => ctx.app.close());

  it('copy rules, two-person start, stable exposure, results from real counts', async () => {
    const auth = (e: string) => ({ Authorization: `Bearer ${tok[e]}` });
    const bad = await http()
      .post('/api/ops/experiments')
      .set(auth('m1@exp.test'))
      .send({
        key: 'greet-bad',
        variants: [
          { key: 'control', weight: 1, text: 'Hi!' },
          { key: 'promo', weight: 1, text: 'Save $3,000 today, hurry!' },
        ],
      });
    expect(bad.status).toBe(400);
    const c = await http()
      .post('/api/ops/experiments')
      .set(auth('m1@exp.test'))
      .send({
        key: `greet-tone-${Date.now()}`,
        variants: [
          {
            key: 'control',
            weight: 1,
            text: 'Hey there! How’s your day going?',
          },
          {
            key: 'helpful',
            weight: 1,
            text: 'Hi! I can help with vehicles, service or parts — what’s on your mind?',
          },
        ],
      });
    expect(c.status).toBe(201);
    const id = unwrap<{ id: string }>(c.body).id;
    expect(
      (
        await http()
          .post(`/api/ops/experiments/${id}/start`)
          .set(auth('m1@exp.test'))
      ).status,
    ).toBe(403);
    expect(
      (
        await http()
          .post(`/api/ops/experiments/${id}/start`)
          .set(auth('m2@exp.test'))
      ).status,
    ).toBe(201);

    const w = unwrap<{ token: string }>(
      (
        await http()
          .post('/api/public/widget-token')
          .set('Origin', SIM_ORIGIN)
          .send({ tenantSlug: d.slug, locationSlug: 'main' })
      ).body,
    ).token;
    const seen = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const r = unwrap<{ reply: string; conversationId: string }>(
        (
          await http()
            .post('/api/chat')
            .set('Authorization', `Bearer ${w}`)
            .set('Origin', SIM_ORIGIN)
            .send({ message: 'Hi' })
        ).body,
      );
      seen.add(r.reply);
      // Same conversation greets again → no second exposure.
      await http()
        .post('/api/chat')
        .set('Authorization', `Bearer ${w}`)
        .set('Origin', SIM_ORIGIN)
        .send({ message: 'hello', conversationId: r.conversationId });
    }
    expect(
      [...seen].every((x) =>
        /How’s your day going|I can help with vehicles, service or parts/.test(
          x,
        ),
      ),
    ).toBe(true);

    const res = unwrap<{
      arms: Array<{
        variant: string;
        exposures: number;
        conversations: number;
      }>;
      leadComparison: Array<{ sufficient: boolean }>;
    }>(
      (
        await http()
          .get(`/api/ops/experiments/${id}/results`)
          .set(auth('m1@exp.test'))
      ).body,
    );
    const total = res.arms.reduce((a, x) => a + x.exposures, 0);
    expect(total).toBe(12); // exactly one exposure per conversation
    expect(res.leadComparison[0].sufficient).toBe(false); // never a "winner" on 12 conversations
    expect(
      (
        await http()
          .post(`/api/ops/experiments/${id}/stop`)
          .set(auth('m1@exp.test'))
      ).status,
    ).toBe(201);
  });
});
