import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { seedDemoDealer, SIM_ORIGIN } from '../helpers/demo-dealer';
import type { DemoVehicle } from '../../scripts/lib/local-demo-data';
import { CreditDestinationAdminService } from '../../src/finance/credit-destination-admin.service';
import { FeatureFlagsService } from '../../src/feature-flags/feature-flags.service';
import { CrmSyncService } from '../../src/integrations/crm/crm-sync.service';

/**
 * Five-rooftop negative matrix against the real API + Postgres. Stores mirror the Dial Auto
 * Group rooftops (separate tenants), seeded with SIMULATED data under "iso-" slugs so the
 * production slugs are never touched. Overlaps are deliberate: both CDJR stores carry
 * Wranglers, one VIN exists at two stores with different prices, and the same customer phone
 * talks to two stores.
 */
const v = (
  vin: string,
  make: string,
  model: string,
  price: number,
  trim = 'Base',
): DemoVehicle => ({
  vin,
  stock: vin.slice(-4),
  year: 2025,
  make,
  model,
  trim,
  bodyType: 'SUV',
  drivetrain: '4WD',
  fuelType: 'Gasoline',
  color: 'Black',
  price,
  mileage: 10,
  condition: 'new',
  features: [],
});
const SHARED_VIN = 'ISOSHAREDOOOOO001';
const STORES = {
  chevy: [v('ISOCHEVYOOOOOO001', 'Chevrolet', 'Tahoe', 61000)],
  nissan: [v('ISONISSANOOOOO001', 'Nissan', 'Rogue', 33000)],
  infiniti: [v('ISOINFINITIOOO01', 'INFINITI', 'QX60', 52000)],
  south: [
    v('ISOSOUTHOOOOOO001', 'Jeep', 'Wrangler', 44000, 'Sport'),
    v(SHARED_VIN, 'Jeep', 'Compass', 30000),
  ],
  north: [
    v('ISONORTHOOOOOO001', 'Jeep', 'Wrangler', 49000, 'Rubicon'),
    v(SHARED_VIN, 'Jeep', 'Compass', 31500),
  ],
};
type Key = keyof typeof STORES;
const PASSWORD = 'IsoTestPass123!';

describe('five-rooftop isolation matrix', () => {
  let ctx: E2eCtx;
  const ids = {} as Record<
    Key,
    { tenantId: string; locationId: string; widget: string; staff: string }
  >;
  const http = () => request(ctx.app.getHttpServer());
  const chat = async (k: Key, message: string, conversationId?: string) => {
    const r = await http()
      .post('/api/chat')
      .set('Authorization', `Bearer ${ids[k].widget}`)
      .set('Origin', SIM_ORIGIN)
      .send({ message, conversationId });
    expect(r.status).toBeLessThan(300);
    return unwrap<{
      reply: string;
      conversationId: string;
      vehicles?: Array<{ vin: string; price: number }>;
      cards: Array<Record<string, unknown> & { kind: string }>;
    }>(r.body);
  };

  beforeAll(async () => {
    ctx = await createE2eApp();
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const k of Object.keys(STORES) as Key[]) {
      const d = await seedDemoDealer(ctx.app, ctx.prisma, `iso-${k}`, {
        vehicles: STORES[k],
        creditPreview: false,
      });
      await ctx.prisma.user.upsert({
        where: {
          tenantId_email: {
            tenantId: d.tenantId,
            email: `admin@iso-${k}.test`,
          },
        },
        create: {
          tenantId: d.tenantId,
          email: `admin@iso-${k}.test`,
          password: hash,
          firstName: 'Iso',
          lastName: k,
          role: Role.ADMIN,
        },
        update: { password: hash, isActive: true, role: Role.ADMIN },
      });
      // Each store gets its OWN authorized credit destination.
      const admin = ctx.app.get(CreditDestinationAdminService);
      await admin.configure(d.tenantId, d.locationId, 'cli:iso-suite', {
        url: `https://apply.iso-${k}.test/credit`,
        linkType: 'DEALER_REUSABLE',
      });
      await admin.authorize(d.tenantId, d.locationId, 'cli:iso-suite', {
        linkType: 'DEALER_REUSABLE',
        evidenceRef: `ISO-${k}-written-approval`,
      });
      const t = await http()
        .post('/api/public/widget-token')
        .set('Origin', SIM_ORIGIN)
        .send({ tenantSlug: `iso-${k}`, locationSlug: 'main' });
      const login = await http()
        .post('/api/auth/login')
        .send({ email: `admin@iso-${k}.test`, password: PASSWORD });
      const lb = unwrap<{ access_token?: string; accessToken?: string }>(
        login.body,
      );
      ids[k] = {
        tenantId: d.tenantId,
        locationId: d.locationId,
        widget: unwrap<{ token: string }>(t.body).token,
        staff: lb.access_token || lb.accessToken || '',
      };
    }
    // Store-specific hours: South closes at 6 PM on weekdays, North at 9 PM.
    const wk = (close: string) =>
      Object.fromEntries(
        ['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [
          d,
          { open: '09:00', close },
        ]),
      );
    await ctx.prisma.location.update({
      where: { id: ids.south.locationId },
      data: { storeHours: { ...wk('18:00'), sat: null, sun: null } },
    });
    await ctx.prisma.location.update({
      where: { id: ids.north.locationId },
      data: { storeHours: { ...wk('21:00'), sat: null, sun: null } },
    });
  }, 120_000);
  afterAll(async () => ctx.app.close());

  it('every store sees only its own inventory, even for overlapping models', async () => {
    const own = (k: Key) => new Set(STORES[k].map((x) => x.vin));
    for (const k of ['south', 'north'] as Key[]) {
      const d = await chat(k, 'Show me Wranglers');
      expect(d.vehicles?.length).toBe(1);
      for (const x of d.vehicles ?? []) expect(own(k).has(x.vin)).toBe(true);
    }
    for (const [k, q] of [
      ['chevy', 'Do you have a Tahoe?'],
      ['nissan', 'any Rogues?'],
      ['infiniti', 'show me the QX60'],
    ] as Array<[Key, string]>) {
      const d = await chat(k, q);
      expect(d.vehicles?.length).toBe(1);
      expect(own(k).has(d.vehicles![0].vin)).toBe(true);
    }
    // Chevy never sees Jeep stock.
    const c = await chat('chevy', 'Show me Wranglers');
    expect(c.vehicles ?? []).toHaveLength(0);
  });

  it('the same VIN at two stores carries each store’s own price', async () => {
    const s = await chat('south', 'Show me the Compass');
    const n = await chat('north', 'Show me the Compass');
    expect(s.vehicles?.[0]).toMatchObject({ vin: SHARED_VIN, price: 30000 });
    expect(n.vehicles?.[0]).toMatchObject({ vin: SHARED_VIN, price: 31500 });
  });

  it('a North conversation id is useless to the South widget', async () => {
    const n = await chat('north', 'I like the Rubicon. My name is Pat North.');
    const s = await chat(
      'south',
      'what was my name and which car did I pick?',
      n.conversationId,
    );
    expect(s.conversationId).not.toBe(n.conversationId);
    expect(s.reply).not.toMatch(/Pat|Rubicon/);
  });

  it('credit links resolve only to the issuing store’s destination', async () => {
    const n = await chat('north', 'Send me the application.');
    const s = await chat('south', 'Send me the application.');
    const nUrl = String(
      n.cards.find((c) => c.kind === 'credit_application')!.url,
    );
    const sUrl = String(
      s.cards.find((c) => c.kind === 'credit_application')!.url,
    );
    expect((await http().get(`/api${nUrl}`)).headers.location).toBe(
      'https://apply.iso-north.test/credit',
    );
    expect((await http().get(`/api${sUrl}`)).headers.location).toBe(
      'https://apply.iso-south.test/credit',
    );
    // Splicing North's payload onto South's signature (or vice versa) fails verification.
    const [nBody] = nUrl.split('/').pop()!.split('.');
    const [, sSig] = sUrl.split('/').pop()!.split('.');
    expect(
      (await http().get(`/api/public/credit-link/${nBody}.${sSig}`)).status,
    ).toBe(404);
    // Disabling North never affects South.
    await http()
      .post(
        `/api/ops/locations/${ids.north.locationId}/credit-application/disable`,
      )
      .set('Authorization', `Bearer ${ids.north.staff}`)
      .expect(201);
    expect((await http().get(`/api${nUrl}`)).status).toBe(404);
    expect((await http().get(`/api${sUrl}`)).status).toBe(302);
  });

  it('a store admin cannot read or change another store’s configuration', async () => {
    const north = ids.north.staff;
    const s = await http()
      .get(`/api/ops/locations/${ids.south.locationId}/settings`)
      .set('Authorization', `Bearer ${north}`);
    expect([403, 404]).toContain(s.status);
    const c = await http()
      .get(`/api/ops/locations/${ids.south.locationId}/credit-application`)
      .set('Authorization', `Bearer ${north}`);
    expect([403, 404]).toContain(c.status);
    const w = await http()
      .put(
        `/api/ops/locations/${ids.south.locationId}/credit-application/destination`,
      )
      .set('Authorization', `Bearer ${north}`)
      .send({ url: 'https://evil.test/steal?token=x' });
    expect([400, 403, 404]).toContain(w.status);
    const after = await ctx.prisma.integrationConnection.findMany({
      where: { locationId: ids.south.locationId },
    });
    expect(JSON.stringify(after)).not.toMatch(/evil\.test/);
  });

  it('queues, search and integrations are scoped to the caller’s store', async () => {
    await chat('south', 'What’s the out-the-door price on the Compass?');
    const q = await http()
      .get(`/api/ops/queues?locationId=${ids.south.locationId}`)
      .set('Authorization', `Bearer ${ids.north.staff}`);
    const body = unwrap<{ quotes: Array<{ tenantId: string }> }>(q.body);
    if (q.status < 300)
      for (const row of body.quotes ?? [])
        expect(row.tenantId).toBe(ids.north.tenantId);
    else expect([403, 404]).toContain(q.status);
    const i = await http()
      .get('/api/ops/integrations')
      .set('Authorization', `Bearer ${ids.north.staff}`);
    expect(JSON.stringify(i.body)).not.toContain(ids.south.locationId);
  });

  it('the same customer phone at two stores stays two separate customers', async () => {
    const phone = '312-555-0177';
    for (const k of ['south', 'north'] as Key[]) {
      const a = await chat(k, 'I need an oil change Saturday at 10am');
      await chat(k, `Jordan Same ${k}, ${phone}`, a.conversationId);
    }
    const r = await http()
      .get(`/api/ops/search?q=${encodeURIComponent(phone)}`)
      .set('Authorization', `Bearer ${ids.north.staff}`);
    const body = unwrap<{
      leads: Array<{ lastName: string | null }>;
      appointments: Array<{ tenantId?: string }>;
    }>(r.body);
    expect(JSON.stringify(body)).not.toMatch(/Same south|South/);
    const southRows = await ctx.prisma.appointment.count({
      where: {
        tenantId: ids.south.tenantId,
        customerPhone: { contains: '5550177' },
      },
    });
    const northRows = await ctx.prisma.appointment.count({
      where: {
        tenantId: ids.north.tenantId,
        customerPhone: { contains: '5550177' },
      },
    });
    expect(southRows).toBeGreaterThan(0);
    expect(northRows).toBeGreaterThan(0);
  });

  it('store hours never bleed across stores', async () => {
    const s = unwrap<{ summary: string }>(
      (
        await http().get(
          '/api/public/store-status?tenantSlug=iso-south&locationSlug=main',
        )
      ).body,
    );
    const n = unwrap<{ summary: string }>(
      (
        await http().get(
          '/api/public/store-status?tenantSlug=iso-north&locationSlug=main',
        )
      ).body,
    );
    expect(s.summary).toMatch(/6 PM/);
    expect(n.summary).toMatch(/9 PM/);
  });

  it('only platform super-admins see the group readiness scorecard', async () => {
    const r = await http()
      .get('/api/ops/group/readiness')
      .set('Authorization', `Bearer ${ids.north.staff}`);
    expect(r.status).toBe(403);
  });

  it('a widget token for one store cannot mint conversations for another', async () => {
    const r = await http()
      .post('/api/chat')
      .set('Authorization', `Bearer ${ids.chevy.widget}`)
      .set('Origin', SIM_ORIGIN)
      .send({
        message: 'Show me the QX60',
        tenantId: ids.infiniti.tenantId,
        locationId: ids.infiniti.locationId,
      });
    // Extra body fields are rejected or ignored — never honored.
    if (r.status < 300)
      expect(
        unwrap<{ vehicles?: unknown[] }>(r.body).vehicles ?? [],
      ).toHaveLength(0);
    else expect(r.status).toBe(400);
  });

  it('an authorized Tekion credit destination never turns on Tekion CRM/DMS integration', async () => {
    // Even if someone switches the tenant flag on, only a live CRM/DMS connection may honor it.
    const t = await ctx.prisma.tenant.findUnique({
      where: { id: ids.south.tenantId },
    });
    await ctx.prisma.tenant.update({
      where: { id: ids.south.tenantId },
      data: {
        featureFlags: {
          ...(t!.featureFlags as object),
          tekionIntegration: true,
        },
      },
    });
    const flags = await ctx.app
      .get(FeatureFlagsService)
      .resolve(ids.south.tenantId, ids.south.locationId);
    expect(flags.tekionIntegration).toBe(false);
    const gate = await ctx.app
      .get(CrmSyncService)
      .tekionGate(ids.south.tenantId, ids.south.locationId);
    expect(gate.open).toBe(false);
  });

  it('emergency kill switch stops one store instantly, leaves others running, and is audited', async () => {
    const since = new Date();
    const off = await http()
      .post(`/api/ops/locations/${ids.nissan.locationId}/ai-control`)
      .set('Authorization', `Bearer ${ids.nissan.staff}`)
      .send({ chat: false, reason: 'incident drill' });
    expect(off.status).toBe(201);
    const blocked = await chat('nissan', 'any Rogues?');
    expect(blocked.vehicles ?? []).toHaveLength(0);
    expect(blocked.reply).toMatch(/not available|call/i);
    // Another store keeps working; another store's admin cannot flip Nissan's switch.
    expect((await chat('chevy', 'Do you have a Tahoe?')).vehicles?.length).toBe(
      1,
    );
    const foreign = await http()
      .post(`/api/ops/locations/${ids.nissan.locationId}/ai-control`)
      .set('Authorization', `Bearer ${ids.chevy.staff}`)
      .send({ chat: true, reason: 'should be denied' });
    expect([403, 404]).toContain(foreign.status);
    await http()
      .post(`/api/ops/locations/${ids.nissan.locationId}/ai-control`)
      .set('Authorization', `Bearer ${ids.nissan.staff}`)
      .send({
        chat: true,
        llmDisabled: true,
        reason: 'restore, deterministic only',
      })
      .expect(201);
    expect((await chat('nissan', 'any Rogues?')).vehicles?.length).toBe(1);
    const audits = await ctx.prisma.auditLog.count({
      where: {
        tenantId: ids.nissan.tenantId,
        action: 'ai.control.changed',
        createdAt: { gte: since },
      },
    });
    expect(audits).toBe(2);
  });
});
