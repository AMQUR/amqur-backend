import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { createE2eApp, E2eCtx, unwrap } from '../helpers/e2e-app';
import { seedDemoDealer, SIM_ORIGIN, DemoDealer } from '../helpers/demo-dealer';

describe('dealer spotlights', () => {
  let ctx: E2eCtx;
  let d: DemoDealer;
  let o: DemoDealer;
  const tok: Record<string, string> = {};
  const http = () => request(ctx.app.getHttpServer());
  const day = 86_400_000;
  const win = {
    startsAt: new Date(Date.now() - day).toISOString(),
    endsAt: new Date(Date.now() + 7 * day).toISOString(),
  };

  beforeAll(async () => {
    ctx = await createE2eApp();
    d = await seedDemoDealer(ctx.app, ctx.prisma, 'spot-motors', {
      creditPreview: false,
    });
    o = await seedDemoDealer(ctx.app, ctx.prisma, 'spot-other', {
      creditPreview: false,
    });
    await ctx.prisma.spotlight.deleteMany({
      where: { tenantId: { in: [d.tenantId, o.tenantId] } },
    });
    const hash = await bcrypt.hash('SpotTest123!', 10);
    for (const [email, tenantId, role] of [
      ['staff@spot.test', d.tenantId, Role.STAFF],
      ['mgr1@spot.test', d.tenantId, Role.MANAGER],
      ['mgr2@spot.test', d.tenantId, Role.MANAGER],
      ['mgr@spot-other.test', o.tenantId, Role.MANAGER],
    ] as Array<[string, string, Role]>) {
      await ctx.prisma.user.upsert({
        where: { tenantId_email: { tenantId, email } },
        create: {
          tenantId,
          email,
          password: hash,
          firstName: 'S',
          lastName: role,
          role,
        },
        update: { password: hash, role, isActive: true },
      });
      const r = await http()
        .post('/api/auth/login')
        .send({ email, password: 'SpotTest123!' });
      const b = unwrap<{ access_token?: string; accessToken?: string }>(r.body);
      tok[email] = b.access_token || b.accessToken || '';
    }
  }, 60_000);
  afterAll(async () => ctx.app.close());

  const create = (
    email: string,
    body: Record<string, unknown>,
    loc = d.locationId,
  ) =>
    http()
      .post(`/api/ops/locations/${loc}/spotlights`)
      .set('Authorization', `Bearer ${tok[email]}`)
      .send({ ...win, ...body });

  it('refuses manufactured urgency, off-site links, unsourced offers and unknown VINs', async () => {
    expect(
      (
        await create('staff@spot.test', {
          kind: 'ANNOUNCEMENT',
          title: 'Hurry — only 2 left!',
          body: 'x',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await create('staff@spot.test', {
          kind: 'EVENT',
          title: 'Open house',
          body: 'Join us',
          linkUrl: 'https://evil.test/x',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await create('staff@spot.test', {
          kind: 'OFFER',
          title: '0% APR',
          body: 'Great rates',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await create('staff@spot.test', {
          kind: 'VEHICLE',
          title: 'Featured',
          body: 'Nice',
          vehicleVin: 'NOTAREALVIN000000',
        })
      ).status,
    ).toBe(400);
  });

  it('two-person approval, store-scoped, verbatim and labeled; sold vehicles disappear', async () => {
    const vin = d.vehicles[3].vin;
    const c = await create('mgr1@spot.test', {
      kind: 'VEHICLE',
      title: 'Featured Wrangler',
      body: 'Stop by to see it.',
      vehicleVin: vin,
    });
    expect(c.status).toBe(201);
    const id = unwrap<{ id: string; status: string }>(c.body).id;
    const pub = async (slug: string) =>
      unwrap<Array<{ title: string; label: string }>>(
        (
          await http().get(
            `/api/public/spotlights?tenantSlug=${slug}&locationSlug=main`,
          )
        ).body,
      );
    expect(await pub(d.slug)).toHaveLength(0); // pending is never public
    // Creator cannot approve their own; staff cannot approve; other store cannot approve.
    expect(
      (
        await http()
          .post(`/api/ops/spotlights/${id}/decision`)
          .set('Authorization', `Bearer ${tok['mgr1@spot.test']}`)
          .send({ approve: true })
      ).status,
    ).toBe(403);
    expect(
      (
        await http()
          .post(`/api/ops/spotlights/${id}/decision`)
          .set('Authorization', `Bearer ${tok['staff@spot.test']}`)
          .send({ approve: true })
      ).status,
    ).toBe(403);
    expect([403, 404]).toContain(
      (
        await http()
          .post(`/api/ops/spotlights/${id}/decision`)
          .set('Authorization', `Bearer ${tok['mgr@spot-other.test']}`)
          .send({ approve: true })
      ).status,
    );
    expect(
      (
        await http()
          .post(`/api/ops/spotlights/${id}/decision`)
          .set('Authorization', `Bearer ${tok['mgr2@spot.test']}`)
          .send({ approve: true })
      ).status,
    ).toBe(201);
    const live = await pub(d.slug);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      title: 'Featured Wrangler',
      label: 'Dealership announcement',
    });
    expect(await pub(o.slug)).toHaveLength(0);
    // The vehicle sells → spotlight is withdrawn automatically.
    await ctx.prisma.vehicle.updateMany({
      where: { tenantId: d.tenantId, vin },
      data: { status: 'SOLD' },
    });
    expect(await pub(d.slug)).toHaveLength(0);
    await ctx.prisma.vehicle.updateMany({
      where: { tenantId: d.tenantId, vin },
      data: { status: 'AVAILABLE' },
    });
    const audits = await ctx.prisma.auditLog.count({
      where: {
        tenantId: d.tenantId,
        resourceId: id,
        action: 'spotlight.approved',
      },
    });
    expect(audits).toBe(1);
    void SIM_ORIGIN;
  });
});
