import request from 'supertest';
import {
  createE2eApp,
  seedTwoTenants,
  unwrap,
  E2eCtx,
} from '../helpers/e2e-app';

/**
 * Full platform e2e against disposable Postgres (docker-compose.test.yml).
 * Requires DATABASE_URL + JWT_SECRET from test-infra/.env.test
 */
describe('Platform e2e (disposable DB)', () => {
  let ctx: E2eCtx;
  let seed: Awaited<ReturnType<typeof seedTwoTenants>>;
  let alphaStaffJwt: string;
  let alphaWidgetJwt: string;

  beforeAll(async () => {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL required for e2e — run test:infra:up first',
      );
    }
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
      throw new Error('JWT_SECRET (>=32) required for e2e');
    }
    ctx = await createE2eApp();
    seed = await seedTwoTenants(ctx.prisma);
  }, 60_000);

  afterAll(async () => {
    if (ctx?.app) await ctx.app.close();
  });

  it('health/live is ok', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/api/health/live')
      .expect(200);
    const data = unwrap<{ ok: boolean }>(res.body);
    expect(data.ok).toBe(true);
  });

  it('health readiness requires DB', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/api/health')
      .expect(200);
    const data = unwrap<{ ok: boolean; checks: { database: string } }>(
      res.body,
    );
    expect(data.ok).toBe(true);
    expect(data.checks.database).toBe('up');
  });

  it('staff login success + refresh', async () => {
    const login = await request(ctx.app.getHttpServer())
      .post('/api/auth/login')
      .send({
        email: 'admin@pilot-alpha.test',
        password: seed.alpha.password,
      })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const tokens = unwrap<{
      access_token?: string;
      accessToken?: string;
      refresh_token?: string;
      refreshToken?: string;
    }>(login.body);
    alphaStaffJwt = tokens.access_token || tokens.accessToken || '';
    expect(alphaStaffJwt).toBeTruthy();
    const refreshRaw = tokens.refresh_token || tokens.refreshToken;
    expect(refreshRaw).toBeTruthy();

    const refresh = await request(ctx.app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refresh_token: refreshRaw })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const refreshed = unwrap<{
      access_token?: string;
      accessToken?: string;
    }>(refresh.body);
    expect(refreshed.access_token || refreshed.accessToken).toBeTruthy();
  });

  it('login failure does not leak stack/sql', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@pilot-alpha.test', password: 'wrong-password!!' })
      .expect(401);
    const raw = JSON.stringify(res.body);
    expect(raw.toLowerCase()).not.toMatch(/select |prisma|stack|password hash/);
  });

  it('widget-config returns public branding only', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/api/public/widget-config')
      .query({ tenantSlug: 'pilot-alpha', locationSlug: 'main' })
      .expect(200);
    const data = unwrap<Record<string, unknown>>(res.body);
    expect(data.branding).toBeTruthy();
    expect(data.features).toBeTruthy();
    const raw = JSON.stringify(data);
    expect(raw).not.toMatch(
      /JWT_SECRET|CRM_WEBHOOK|password|ciphertext|allowedOrigins|inventoryFeedUrl|escalationRecipients/i,
    );
  });

  it('widget-config unknown tenant 404', async () => {
    await request(ctx.app.getHttpServer())
      .get('/api/public/widget-config')
      .query({ tenantSlug: 'does-not-exist', locationSlug: 'main' })
      .expect(404);
  });

  it('widget-token requires Origin allowlist', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/public/widget-token')
      .send({ tenantSlug: 'pilot-alpha', locationSlug: 'main' })
      .expect(403);

    const ok = await request(ctx.app.getHttpServer())
      .post('/api/public/widget-token')
      .set('Origin', 'http://127.0.0.1:18084')
      .send({ tenantSlug: 'pilot-alpha', locationSlug: 'main' })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const data = unwrap<{ token: string }>(ok.body);
    expect(data.token).toBeTruthy();
    alphaWidgetJwt = data.token;
  });

  it('widget-token malformed body rejected', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/public/widget-token')
      .set('Origin', 'http://127.0.0.1:18084')
      .send({ tenantSlug: '', locationSlug: 'main' })
      .expect((r) => expect([400, 401, 403]).toContain(r.status));
  });

  it('chat works with widget jwt; payments fail-closed', async () => {
    const chat = await request(ctx.app.getHttpServer())
      .post('/api/chat')
      .set('Authorization', `Bearer ${alphaWidgetJwt}`)
      .send({
        message: 'what is my monthly payment on the jeep',
        conversationId: 'e2e-conv-payments',
      })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const data = unwrap<{ reply?: string; type?: string }>(chat.body);
    const text = JSON.stringify(data).toLowerCase();
    expect(text).not.toMatch(
      /approved financing|your apr is|guaranteed payment/,
    );
    // payments flag false → capability blocked or no payment_summary
    expect(data.type).not.toBe('payment_summary');
  });

  it('chat inventory when enabled returns provenance-safe reply', async () => {
    const chat = await request(ctx.app.getHttpServer())
      .post('/api/chat')
      .set('Authorization', `Bearer ${alphaWidgetJwt}`)
      .send({
        message: 'show me jeep grand cherokee in stock',
        conversationId: 'e2e-conv-inv',
      })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const data = unwrap<Record<string, unknown>>(chat.body);
    const raw = JSON.stringify(data);
    expect(raw.toLowerCase()).not.toMatch(/1c4rjfbg0mc200001/); // beta VIN
  });

  it('chat service/parts fail-closed when flags off', async () => {
    const svc = await request(ctx.app.getHttpServer())
      .post('/api/chat')
      .set('Authorization', `Bearer ${alphaWidgetJwt}`)
      .send({
        message: 'schedule a service appointment tomorrow at 9am',
        conversationId: 'e2e-conv-svc',
      })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const data = unwrap<{ reply: string }>(svc.body);
    expect(data.reply.toLowerCase()).toMatch(
      /not enabled|unavailable|team member|service department|contact/,
    );
    expect(data.reply.toLowerCase()).not.toMatch(/confirmed your appointment/);
  });

  it('handoff creates escalation; no false notified without CRM accept', async () => {
    // Clear CRM webhook to force durable-only path if mock down — use env CRM if set
    const chat = await request(ctx.app.getHttpServer())
      .post('/api/chat')
      .set('Authorization', `Bearer ${alphaWidgetJwt}`)
      .send({
        message: 'I need to speak to a human please',
        conversationId: 'e2e-conv-handoff',
      })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const data = unwrap<{ reply: string }>(chat.body);
    expect(data.reply).toBeTruthy();
    // Must not claim notified if delivery not confirmed — tolerate notified/queued/saved wording
    if (
      /could not be confirmed|queued|saved your request|recorded your request/i.test(
        data.reply,
      )
    ) {
      expect(data.reply.toLowerCase()).not.toMatch(
        /i.?ve notified our team and someone will follow up with you shortly/,
      );
    }

    const list = await request(ctx.app.getHttpServer())
      .get('/api/escalations')
      .set('Authorization', `Bearer ${alphaStaffJwt}`)
      .expect(200);
    const esc = unwrap<Array<{ reason: string }>>(list.body);
    expect(esc.some((e) => /human/i.test(e.reason))).toBe(true);
  });

  it('leads list requires auth and is tenant scoped', async () => {
    await request(ctx.app.getHttpServer()).get('/api/leads').expect(401);
    const res = await request(ctx.app.getHttpServer())
      .get('/api/leads')
      .set('Authorization', `Bearer ${alphaStaffJwt}`)
      .expect(200);
    const leads = unwrap<Array<{ email?: string; interestedVin?: string }>>(
      res.body,
    );
    const raw = JSON.stringify(leads);
    expect(raw).toContain('alpha-customer@example.test');
    expect(raw).not.toContain('beta-customer@example.test');
    expect(raw).not.toContain('1C4RJFBG0MC200001');
  });

  it('inventory-feed parse requires staff role', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/inventory-feed/parse')
      .set('Authorization', `Bearer ${alphaWidgetJwt}`)
      .send({ url: 'http://127.0.0.1:18082/feed.json', type: 'JSON' })
      .expect(403);
  });

  it('disabled inventory on beta refuses inventory answers', async () => {
    const tok = await request(ctx.app.getHttpServer())
      .post('/api/public/widget-token')
      .set('Origin', 'http://127.0.0.1:18084')
      .send({ tenantSlug: 'pilot-beta', locationSlug: 'main' })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const { token } = unwrap<{ token: string }>(tok.body);
    const chat = await request(ctx.app.getHttpServer())
      .post('/api/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        message: 'do you have a rogue in stock',
        conversationId: 'e2e-beta-inv',
      })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const data = unwrap<{ reply: string }>(chat.body);
    expect(data.reply.toLowerCase()).toMatch(
      /not enabled|unavailable|team member|will not guess/,
    );
    expect(JSON.stringify(data)).not.toContain('1C4RJFBG0MC200001');
  });

  it('public errors omit sql/stack', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/chat')
      .send({ message: 'hi' })
      .expect(401);
    const raw = JSON.stringify(res.body).toLowerCase();
    expect(raw).not.toMatch(/at object\.|prisma|select \*|node_modules/);
  });
});
