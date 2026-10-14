import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import {
  createE2eApp,
  E2eCtx,
  seedTwoTenants,
  unwrap,
} from '../helpers/e2e-app';

/**
 * Command Center operations over HTTP: human takeover lifecycle, staff reply delivery to the
 * widget, knowledge publish gating, tenant/location isolation, settings validation.
 */
describe('staff operations (HTTP, Postgres)', () => {
  let ctx: E2eCtx;
  let seed: Awaited<ReturnType<typeof seedTwoTenants>>;
  let alphaAdmin: string;
  let alphaStaff: string;
  let betaAdmin: string;
  let widget: string;
  const ORIGIN = 'http://127.0.0.1:18084';

  async function login(email: string, password: string) {
    const r = await request(ctx.app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password });
    const b = unwrap<{ access_token?: string; accessToken?: string }>(r.body);
    return b.access_token || b.accessToken || '';
  }
  const api = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await createE2eApp();
    seed = await seedTwoTenants(ctx.prisma);
    await ctx.prisma.tenant.update({
      where: { id: seed.alpha.tenant.id },
      data: {
        featureFlags: {
          chat: true,
          inventory: true,
          handoff: true,
          leadCapture: true,
          knowledge: true,
        },
      },
    });
    const pw = await bcrypt.hash('StaffPass123!', 10);
    await ctx.prisma.user.upsert({
      where: {
        tenantId_email: {
          tenantId: seed.alpha.tenant.id,
          email: 'staff@pilot-alpha.test',
        },
      },
      create: {
        tenantId: seed.alpha.tenant.id,
        locationId: seed.alpha.location.id,
        email: 'staff@pilot-alpha.test',
        password: pw,
        firstName: 'Riley',
        lastName: 'Staff',
        role: Role.STAFF,
      },
      update: { password: pw, isActive: true },
    });
    alphaAdmin = await login('admin@pilot-alpha.test', seed.alpha.password);
    betaAdmin = await login('admin@pilot-beta.test', seed.beta.password);
    alphaStaff = await login('staff@pilot-alpha.test', 'StaffPass123!');
    const tok = await api()
      .post('/api/public/widget-token')
      .set('Origin', ORIGIN)
      .send({ tenantSlug: 'pilot-alpha', locationSlug: 'main' });
    widget = unwrap<{ token: string }>(tok.body).token;
  });

  afterAll(async () => ctx.app.close());

  it('takeover pauses AI, staff reply reaches the widget, release resumes AI', async () => {
    const first = await api()
      .post('/api/chat')
      .set('Authorization', `Bearer ${widget}`)
      .send({ message: 'Can I talk to a person?' });
    const convKey = unwrap<{ conversationId: string }>(
      first.body,
    ).conversationId;
    const conv = await ctx.prisma.conversation.findUniqueOrThrow({
      where: {
        tenantId_externalKey: {
          tenantId: seed.alpha.tenant.id,
          externalKey: convKey,
        },
      },
    });

    const inbox = unwrap<{
      items: Array<{ id: string; priority: { rank: number } }>;
    }>(
      (
        await api()
          .get('/api/ops/inbox?handoff=open')
          .set('Authorization', `Bearer ${alphaStaff}`)
      ).body,
    );
    const item = inbox.items.find((i) => i.id === conv.id);
    expect(item?.priority.rank).toBe(1);

    // reply before takeover is refused (no racing / ownerless replies)
    expect(
      (
        await api()
          .post(`/api/ops/conversations/${conv.id}/reply`)
          .set('Authorization', `Bearer ${alphaStaff}`)
          .send({ text: 'hi' })
      ).status,
    ).toBe(409);

    expect(
      (
        await api()
          .post(`/api/ops/conversations/${conv.id}/takeover`)
          .set('Authorization', `Bearer ${alphaStaff}`)
      ).status,
    ).toBeLessThan(300);
    const since = new Date(Date.now() - 1000).toISOString();
    expect(
      (
        await api()
          .post(`/api/ops/conversations/${conv.id}/reply`)
          .set('Authorization', `Bearer ${alphaStaff}`)
          .send({ text: 'Hi, this is Riley — happy to help.' })
      ).status,
    ).toBeLessThan(300);
    // internal note never reaches the widget
    await api()
      .post(`/api/ops/conversations/${conv.id}/notes`)
      .set('Authorization', `Bearer ${alphaStaff}`)
      .send({ text: 'customer seems price sensitive' });

    const paused = unwrap<{ type: string; reply: string }>(
      (
        await api()
          .post('/api/chat')
          .set('Authorization', `Bearer ${widget}`)
          .send({ message: 'great thanks', conversationId: convKey })
      ).body,
    );
    expect(paused.type).toBe('staff_handling');

    const live = unwrap<{
      aiPaused: boolean;
      messages: Array<{
        kind: string;
        text: string;
        displayName: string | null;
      }>;
    }>(
      (
        await api()
          .get(
            `/api/chat/live?conversationId=${encodeURIComponent(convKey)}&after=${encodeURIComponent(since)}`,
          )
          .set('Authorization', `Bearer ${widget}`)
      ).body,
    );
    expect(live.aiPaused).toBe(true);
    expect(
      live.messages.some(
        (m) =>
          m.kind === 'staff' &&
          m.text.includes('Riley') &&
          m.displayName === 'Riley',
      ),
    ).toBe(true);
    expect(JSON.stringify(live.messages)).not.toContain('price sensitive');

    // another tenant cannot see or act on it
    expect(
      (
        await api()
          .get(`/api/ops/conversations/${conv.id}`)
          .set('Authorization', `Bearer ${betaAdmin}`)
      ).status,
    ).toBe(404);
    expect(
      (
        await api()
          .post(`/api/ops/conversations/${conv.id}/release`)
          .set('Authorization', `Bearer ${betaAdmin}`)
      ).status,
    ).toBe(404);
    // widget token cannot use staff APIs
    expect(
      (
        await api()
          .get('/api/ops/inbox')
          .set('Authorization', `Bearer ${widget}`)
      ).status,
    ).toBe(403);

    expect(
      (
        await api()
          .post(`/api/ops/conversations/${conv.id}/release`)
          .set('Authorization', `Bearer ${alphaStaff}`)
      ).status,
    ).toBeLessThan(300);
    const resumed = unwrap<{ type?: string; reply: string }>(
      (
        await api()
          .post('/api/chat')
          .set('Authorization', `Bearer ${widget}`)
          .send({ message: 'what time do you close', conversationId: convKey })
      ).body,
    );
    expect(resumed.type).not.toBe('staff_handling');
    expect(resumed.reply.length).toBeGreaterThan(0);

    const detail = unwrap<{ summary: { text: string }; messages: unknown[] }>(
      (
        await api()
          .get(`/api/ops/conversations/${conv.id}`)
          .set('Authorization', `Bearer ${alphaStaff}`)
      ).body,
    );
    expect(detail.messages.length).toBeGreaterThan(3);
    expect(typeof detail.summary.text).toBe('string');
  });

  it('knowledge must be approved by a manager and published before customers can retrieve it', async () => {
    const created = unwrap<{ id: string; status: string }>(
      (
        await api()
          .post('/api/knowledge/documents')
          .set('Authorization', `Bearer ${alphaStaff}`)
          .send({
            title: 'Loaner policy',
            content:
              'Complimentary loaner vehicles are available for service visits over three hours with an appointment.',
            visibility: 'CUSTOMER',
          })
      ).body,
    );
    expect(created.status).toBe('DRAFT');
    const preview = async () =>
      unwrap<unknown[]>(
        (
          await api()
            .get('/api/knowledge/preview?q=loaner%20vehicles')
            .set('Authorization', `Bearer ${alphaStaff}`)
        ).body,
      );
    expect(await preview()).toHaveLength(0);
    // staff cannot approve
    expect(
      (
        await api()
          .post(`/api/knowledge/documents/${created.id}/transition`)
          .set('Authorization', `Bearer ${alphaStaff}`)
          .send({ to: 'APPROVED' })
      ).status,
    ).toBe(409);
    // cannot publish an unapproved draft
    expect(
      (
        await api()
          .post(`/api/knowledge/documents/${created.id}/transition`)
          .set('Authorization', `Bearer ${alphaAdmin}`)
          .send({ to: 'PUBLISHED' })
      ).status,
    ).toBe(409);
    expect(
      (
        await api()
          .post(`/api/knowledge/documents/${created.id}/transition`)
          .set('Authorization', `Bearer ${alphaAdmin}`)
          .send({ to: 'APPROVED' })
      ).status,
    ).toBeLessThan(300);
    expect(await preview()).toHaveLength(0); // approved ≠ published
    expect(
      (
        await api()
          .post(`/api/knowledge/documents/${created.id}/transition`)
          .set('Authorization', `Bearer ${alphaAdmin}`)
          .send({ to: 'PUBLISHED' })
      ).status,
    ).toBeLessThan(300);
    expect((await preview()).length).toBeGreaterThan(0);
    // editing published content sends it back to DRAFT (never serves unreviewed text)
    const edited = unwrap<{ status: string; version: number }>(
      (
        await api()
          .patch(`/api/knowledge/documents/${created.id}`)
          .set('Authorization', `Bearer ${alphaStaff}`)
          .send({
            content: 'Loaner vehicles may be available; ask your advisor.',
          })
      ).body,
    );
    expect(edited.status).toBe('DRAFT');
    expect(edited.version).toBe(2);
    expect(await preview()).toHaveLength(0);
    // STAFF/INTERNAL visibility never reaches the widget even if published
    const internal = unwrap<{ id: string }>(
      (
        await api()
          .post('/api/knowledge/documents')
          .set('Authorization', `Bearer ${alphaAdmin}`)
          .send({
            title: 'Internal margin guide',
            content:
              'Internal staff only margin guidance for loaner vehicles pricing.',
            visibility: 'INTERNAL',
          })
      ).body,
    );
    await api()
      .post(`/api/knowledge/documents/${internal.id}/transition`)
      .set('Authorization', `Bearer ${alphaAdmin}`)
      .send({ to: 'APPROVED' });
    await api()
      .post(`/api/knowledge/documents/${internal.id}/transition`)
      .set('Authorization', `Bearer ${alphaAdmin}`)
      .send({ to: 'PUBLISHED' });
    expect(JSON.stringify(await preview())).not.toContain('margin');
  });

  it('location settings: validated, re-verification required after hours change, staff cannot edit', async () => {
    const id = seed.alpha.location.id;
    expect(
      (
        await api()
          .patch(`/api/ops/locations/${id}/settings`)
          .set('Authorization', `Bearer ${alphaStaff}`)
          .send({ verifyHours: true })
      ).status,
    ).toBe(403);
    const bad = await api()
      .patch(`/api/ops/locations/${id}/settings`)
      .set('Authorization', `Bearer ${alphaAdmin}`)
      .send({
        creditApplication: {
          enabled: true,
          url: 'http://evil.test',
          allowedHosts: ['evil.test'],
          lastVerifiedAt: '2026-10-01',
        },
      });
    expect(bad.status).toBe(400);
    const r1 = unwrap<{
      storeHoursVerifiedAt: string | null;
      effective: { hours: { verified: boolean } };
    }>(
      (
        await api()
          .patch(`/api/ops/locations/${id}/settings`)
          .set('Authorization', `Bearer ${alphaAdmin}`)
          .send({ storeHours: { mon: { open: '09:00', close: '18:00' } } })
      ).body,
    );
    expect(r1.storeHoursVerifiedAt).toBeNull();
    expect(r1.effective.hours.verified).toBe(false);
    const r2 = unwrap<{ effective: { hours: { verified: boolean } } }>(
      (
        await api()
          .patch(`/api/ops/locations/${id}/settings`)
          .set('Authorization', `Bearer ${alphaAdmin}`)
          .send({ verifyHours: true })
      ).body,
    );
    expect(r2.effective.hours.verified).toBe(true);
    expect(
      (
        await api()
          .get(`/api/ops/locations/${id}/settings`)
          .set('Authorization', `Bearer ${betaAdmin}`)
      ).status,
    ).toBe(404);
  });

  it('overview, queues, integrations and search are tenant-scoped', async () => {
    for (const path of [
      '/api/ops/overview',
      '/api/ops/queues',
      '/api/ops/integrations',
    ]) {
      const r = await api()
        .get(path)
        .set('Authorization', `Bearer ${alphaAdmin}`);
      expect(r.status).toBe(200);
    }
    const integ = unwrap<{
      tekion: { status: string; writebackGate: { open: boolean } };
    }>(
      (
        await api()
          .get('/api/ops/integrations')
          .set('Authorization', `Bearer ${alphaAdmin}`)
      ).body,
    );
    expect(integ.tekion.status).toBe('awaiting_vendor_credentials');
    expect(integ.tekion.writebackGate.open).toBe(false);
    const found = unwrap<{ vehicles: Array<{ vin: string }> }>(
      (
        await api()
          .get('/api/ops/search?q=1C4RJFBG0MC100001')
          .set('Authorization', `Bearer ${alphaAdmin}`)
      ).body,
    );
    expect(found.vehicles.map((v) => v.vin)).toContain('1C4RJFBG0MC100001');
    const notFound = unwrap<{ vehicles: unknown[] }>(
      (
        await api()
          .get('/api/ops/search?q=1C4RJFBG0MC100001')
          .set('Authorization', `Bearer ${betaAdmin}`)
      ).body,
    );
    expect(notFound.vehicles).toHaveLength(0);
  });
});
