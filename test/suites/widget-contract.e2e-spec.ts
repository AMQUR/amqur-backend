import request from 'supertest';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { seedDemoDealer, SIM_ORIGIN, DemoDealer } from '../helpers/demo-dealer';

/**
 * Backend ↔ widget contract. Every request the widget (amqur-widget src/connect.ts and
 * src/widget/api/chat.api.ts) sends, with the exact body fields it sends — the API runs with
 * forbidNonWhitelisted, so an unknown field would 400 every customer message — and every
 * response field the widget reads. Change this file only together with the widget.
 */
describe('widget API contract', () => {
  let ctx: E2eCtx;
  let d: DemoDealer;
  let token: string;
  const http = () => request(ctx.app.getHttpServer());
  const auth = (r: request.Test) =>
    r.set('Authorization', `Bearer ${token}`).set('Origin', SIM_ORIGIN);

  beforeAll(async () => {
    ctx = await createE2eApp();
    d = await seedDemoDealer(ctx.app, ctx.prisma, 'widget-contract', {
      flags: { savedVehicles: true },
    });
  }, 60_000);
  afterAll(async () => ctx.app.close());

  it('GET /public/widget-config → tenant.slug, location.slug, branding, features', async () => {
    const r = await http()
      .get(`/api/public/widget-config?tenantSlug=${d.slug}&locationSlug=main`)
      .set('Origin', SIM_ORIGIN);
    expect(r.status).toBe(200);
    const b = unwrap<Record<string, Record<string, unknown>>>(r.body);
    expect(typeof b.tenant.slug).toBe('string');
    expect(typeof b.location.slug).toBe('string');
    expect(b.branding).toEqual(expect.any(Object));
    expect(b.features).toEqual(expect.any(Object));
  });

  it('POST /public/widget-token {tenantSlug, locationSlug} → token', async () => {
    const r = await http()
      .post('/api/public/widget-token')
      .set('Origin', SIM_ORIGIN)
      .send({ tenantSlug: d.slug, locationSlug: 'main' });
    expect(r.status).toBeLessThan(300);
    token = unwrap<{ token: string }>(r.body).token;
    expect(typeof token).toBe('string');
  });

  let conversationId: string;
  it('POST /chat with every field the widget sends → the fields the widget reads', async () => {
    const r = await auth(http().post('/api/chat')).send({
      message: 'Do you have any SUVs?',
      action: undefined,
      vin: undefined,
      language: 'en',
      pageContext: {
        pageType: 'inventory_search',
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'fall',
        referrerClass: 'search',
      },
    });
    expect(r.status).toBe(201);
    const b = unwrap<Record<string, unknown>>(r.body);
    conversationId = b.conversationId as string;
    expect(typeof conversationId).toBe('string');
    expect(typeof b.reply).toBe('string');
    for (const k of ['segments', 'cards', 'quickReplies'])
      expect(Array.isArray(b[k])).toBe(true);
    expect(b.journey).toEqual(expect.any(Object));
    expect(b.conversation).toMatchObject({
      language: expect.any(String),
      handoffState: expect.any(String),
      aiPaused: expect.any(Boolean),
    });
    expect(b.delivery).toMatchObject({
      urgent: expect.any(Boolean),
      minTypingMs: expect.any(Number),
      maxTypingMs: expect.any(Number),
    });
  });

  it('POST /chat action + vin (vehicle detail / VDP welcome) is accepted', async () => {
    const vin = d.vehicles[0].vin;
    const r = await auth(http().post('/api/chat')).send({
      message: '',
      action: 'vehicle_detail',
      vin,
      conversationId,
      language: 'en',
      pageContext: { pageType: 'vdp', vin, stockNumber: d.vehicles[0].stock },
    });
    expect(r.status).toBe(201);
  });

  it('GET /chat/live → aiPaused, handoffState, messages[]', async () => {
    const r = await auth(
      http().get(`/api/chat/live?conversationId=${conversationId}`),
    );
    expect(r.status).toBe(200);
    expect(unwrap<object>(r.body)).toMatchObject({
      aiPaused: expect.any(Boolean),
      handoffState: expect.any(String),
      messages: expect.any(Array),
    });
  });

  it('saved vehicles: POST / GET (array of {vin}) / DELETE', async () => {
    // Fixture VINs deliberately contain "O" (impossible in a real VIN) and are rejected by the
    // VIN validator, so this check uses a valid-format but obviously synthetic VIN.
    const vin = 'ZZZTEST0000000001';
    const src = await ctx.prisma.vehicle.findFirstOrThrow({
      where: { tenantId: d.tenantId },
    });
    const rest: Record<string, unknown> = { ...src };
    for (const k of ['id', 'createdAt', 'updatedAt']) delete rest[k];
    await ctx.prisma.vehicle.upsert({
      where: { tenantId_vin: { tenantId: d.tenantId, vin } },
      create: { ...(rest as object), vin, stock: 'ZZZ1' } as never,
      update: {},
    });
    const add = await auth(http().post('/api/saved-vehicles')).send({
      conversationId,
      vin,
    });
    expect(add.status).toBeLessThan(300);
    expect(unwrap<{ ok?: boolean }>(add.body).ok).not.toBe(false);
    const list = await auth(
      http().get(`/api/saved-vehicles?conversationId=${conversationId}`),
    );
    expect(list.status).toBe(200);
    expect(
      unwrap<Array<{ vin: string }>>(list.body).map((x) => x.vin),
    ).toContain(vin);
    const del = await auth(http().delete('/api/saved-vehicles')).send({
      conversationId,
      vin,
    });
    expect(del.status).toBeLessThan(300);
  });

  it('GET /public/store-status → known flag', async () => {
    const r = await http().get(
      `/api/public/store-status?tenantSlug=${d.slug}&locationSlug=main&lang=en`,
    );
    expect(r.status).toBe(200);
    expect(typeof unwrap<{ known: boolean }>(r.body).known).toBe('boolean');
  });

  it('GET /public/spotlights → array', async () => {
    const r = await http().get(
      `/api/public/spotlights?tenantSlug=${d.slug}&locationSlug=main`,
    );
    expect(r.status).toBe(200);
    expect(Array.isArray(unwrap<unknown[]>(r.body))).toBe(true);
  });
});
