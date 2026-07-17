import request from 'supertest';
import {
  createE2eApp,
  seedTwoTenants,
  unwrap,
  E2eCtx,
} from '../helpers/e2e-app';

/**
 * Tenant isolation attack suite — ≥2 fully separate tenants.
 * ANY cross-tenant leak is release-blocking critical.
 */
describe('Tenant isolation attack suite', () => {
  let ctx: E2eCtx;
  let seed: Awaited<ReturnType<typeof seedTwoTenants>>;
  let alphaStaff: string;
  let betaStaff: string;
  let alphaWidget: string;
  let betaWidget: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL required');
    }
    ctx = await createE2eApp();
    seed = await seedTwoTenants(ctx.prisma);

    const aLogin = await request(ctx.app.getHttpServer())
      .post('/api/auth/login')
      .send({
        email: 'admin@pilot-alpha.test',
        password: seed.alpha.password,
      })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const aTokBody = unwrap<{ access_token?: string; accessToken?: string }>(
      aLogin.body,
    );
    alphaStaff = aTokBody.access_token || aTokBody.accessToken || '';

    const bLogin = await request(ctx.app.getHttpServer())
      .post('/api/auth/login')
      .send({
        email: 'admin@pilot-beta.test',
        password: seed.beta.password,
      })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const bTokBody = unwrap<{ access_token?: string; accessToken?: string }>(
      bLogin.body,
    );
    betaStaff = bTokBody.access_token || bTokBody.accessToken || '';

    const aTok = await request(ctx.app.getHttpServer())
      .post('/api/public/widget-token')
      .set('Origin', 'http://127.0.0.1:18084')
      .send({ tenantSlug: 'pilot-alpha', locationSlug: 'main' })
      .expect((r) => expect([200, 201]).toContain(r.status));
    alphaWidget = unwrap<{ token: string }>(aTok.body).token;

    const bTok = await request(ctx.app.getHttpServer())
      .post('/api/public/widget-token')
      .set('Origin', 'http://127.0.0.1:18084')
      .send({ tenantSlug: 'pilot-beta', locationSlug: 'main' })
      .expect((r) => expect([200, 201]).toContain(r.status));
    betaWidget = unwrap<{ token: string }>(bTok.body).token;
  }, 60_000);

  afterAll(async () => {
    if (ctx?.app) await ctx.app.close();
  });

  it('widget-config for alpha never includes beta branding/secrets', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/api/public/widget-config')
      .query({ tenantSlug: 'pilot-alpha', locationSlug: 'main' })
      .expect(200);
    const raw = JSON.stringify(res.body);
    expect(raw).toContain('Alpha');
    expect(raw).not.toContain('Beta Assistant');
    expect(raw).not.toContain('pilot-beta');
  });

  it('alpha staff cannot list beta leads (IDOR)', async () => {
    // Forged tenantId query must be denied (403) or ignored (alpha-only 200)
    const res = await request(ctx.app.getHttpServer())
      .get('/api/leads')
      .set('Authorization', `Bearer ${alphaStaff}`)
      .query({ tenantId: seed.beta.tenant.id });
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      const leads = unwrap<Array<{ id: string; email?: string }>>(res.body);
      const raw = JSON.stringify(leads);
      expect(raw).not.toContain('beta-customer@example.test');
      expect(raw).not.toContain(seed.beta.lead.id);
    }
  });

  it('beta staff cannot see alpha escalations', async () => {
    // Create alpha escalation via chat
    await request(ctx.app.getHttpServer())
      .post('/api/chat')
      .set('Authorization', `Bearer ${alphaWidget}`)
      .send({
        message: 'please get me a human agent now',
        conversationId: 'iso-alpha-handoff',
      })
      .expect((r) => expect([200, 201]).toContain(r.status));

    const betaEsc = await request(ctx.app.getHttpServer())
      .get('/api/escalations')
      .set('Authorization', `Bearer ${betaStaff}`)
      .expect(200);
    const list = unwrap<Array<{ summary?: string; reason?: string }>>(
      betaEsc.body,
    );
    const raw = JSON.stringify(list);
    expect(raw).not.toMatch(/iso-alpha-handoff/);
  });

  it('forged tenantId in chat body cannot switch tenant', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/chat')
      .set('Authorization', `Bearer ${alphaWidget}`)
      .send({
        message: 'show inventory for rogue',
        conversationId: 'iso-forge-tenant',
        tenantId: seed.beta.tenant.id,
        locationId: seed.beta.location.id,
      });
    // Either 201 with alpha-scoped data or 400 for forbidden fields
    expect([201, 400]).toContain(res.status);
    if (res.status === 201) {
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('1C4RJFBG0MC200001');
      expect(raw).not.toContain('BETA001');
    }
  });

  it('conversationId collision does not cross tenants', async () => {
    const sharedKey = 'shared-conversation-key-attack';
    await request(ctx.app.getHttpServer())
      .post('/api/chat')
      .set('Authorization', `Bearer ${alphaWidget}`)
      .send({
        message: 'alpha secret word XYZZY-ALPHA',
        conversationId: sharedKey,
      })
      .expect((r) => expect([200, 201]).toContain(r.status));

    const betaChat = await request(ctx.app.getHttpServer())
      .post('/api/chat')
      .set('Authorization', `Bearer ${betaWidget}`)
      .send({ message: 'hello', conversationId: sharedKey })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const raw = JSON.stringify(betaChat.body);
    expect(raw).not.toContain('XYZZY-ALPHA');
  });

  it('VIN lookup cannot return other tenant vehicle', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/api/chat')
      .set('Authorization', `Bearer ${alphaWidget}`)
      .send({
        message: 'details for 1C4RJFBG0MC200001',
        conversationId: 'iso-vin-attack',
        action: 'vehicle_detail',
        vin: '1C4RJFBG0MC200001',
      })
      .expect((r) => expect([200, 201]).toContain(r.status));
    const raw = JSON.stringify(res.body).toLowerCase();
    // Must not present beta vehicle as available inventory for alpha
    expect(raw).not.toMatch(/stock.?beta001|nissan rogue.*\$32990/);
  });

  it('saved vehicles stay tenant scoped', async () => {
    await request(ctx.app.getHttpServer())
      .post('/api/saved-vehicles')
      .set('Authorization', `Bearer ${alphaWidget}`)
      .send({ vin: '1C4RJFBG0MC100001', conversationExternalKey: 'iso-save-a' })
      .expect((r) => expect([200, 201]).toContain(r.status));

    const betaList = await request(ctx.app.getHttpServer())
      .get('/api/saved-vehicles')
      .set('Authorization', `Bearer ${betaWidget}`)
      .query({ conversationExternalKey: 'iso-save-a' });
    // 200 empty or 404 — never alpha VIN
    if (betaList.status === 200) {
      expect(JSON.stringify(betaList.body)).not.toContain('1C4RJFBG0MC100001');
    }
  });

  it('group reporting denies tenant admin without membership', async () => {
    const group = await ctx.prisma.dealerGroup.upsert({
      where: { slug: 'test-group-iso' },
      create: { slug: 'test-group-iso', name: 'Test Group Iso' },
      update: {},
    });
    await ctx.prisma.tenant.update({
      where: { id: seed.alpha.tenant.id },
      data: { dealerGroupId: group.id },
    });
    await ctx.prisma.tenant.update({
      where: { id: seed.beta.tenant.id },
      data: { dealerGroupId: group.id },
    });

    await request(ctx.app.getHttpServer())
      .get(`/api/dealer-groups/${group.id}/reporting`)
      .set('Authorization', `Bearer ${alphaStaff}`)
      .expect(403);
  });

  it('alpha cannot acknowledge beta escalation by id (IDOR)', async () => {
    const betaEsc = await ctx.prisma.escalation.create({
      data: {
        tenantId: seed.beta.tenant.id,
        locationId: seed.beta.location.id,
        reason: 'beta secret escalation',
        summary: 'SECRET-BETA-ESC',
      },
    });
    const res = await request(ctx.app.getHttpServer())
      .post(`/api/escalations/${betaEsc.id}/acknowledge`)
      .set('Authorization', `Bearer ${alphaStaff}`)
      .send({});
    expect([401, 403, 404]).toContain(res.status);
  });
});
