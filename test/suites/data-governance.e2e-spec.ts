import request from 'supertest';
import {
  createE2eApp,
  E2eCtx,
  seedTwoTenants,
  unwrap,
} from '../helpers/e2e-app';
import { RetentionService } from '../../src/observability/retention.service';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

describe('data governance (uploads, retention, privacy)', () => {
  let ctx: E2eCtx;
  let seed: Awaited<ReturnType<typeof seedTwoTenants>>;
  let admin: string;
  let betaAdmin: string;
  const api = () => request(ctx.app.getHttpServer());
  const login = async (email: string, password: string) =>
    unwrap<{ access_token: string }>(
      (await api().post('/api/auth/login').send({ email, password })).body,
    ).access_token;

  beforeAll(async () => {
    ctx = await createE2eApp();
    seed = await seedTwoTenants(ctx.prisma);
    await ctx.prisma.tenant.update({
      where: { id: seed.alpha.tenant.id },
      data: {
        featureFlags: {
          chat: true,
          handoff: true,
          leadCapture: true,
          uploads: true,
        },
      },
    });
    admin = await login('admin@pilot-alpha.test', seed.alpha.password);
    betaAdmin = await login('admin@pilot-beta.test', seed.beta.password);
  });
  afterAll(async () => ctx.app.close());

  it('uploads: content-verified, renamed by verified type, signed attachment download, tenant-scoped', async () => {
    const bad = await api()
      .post('/api/uploads/file')
      .set('Authorization', `Bearer ${admin}`)
      .field('purpose', 'TRADE_PHOTO')
      .attach('file', Buffer.from('<script>alert(1)</script>'), {
        filename: 'x.png',
        contentType: 'image/png',
      });
    expect(bad.status).toBe(400);
    const ok = await api()
      .post('/api/uploads/file')
      .set('Authorization', `Bearer ${admin}`)
      .field('purpose', 'TRADE_PHOTO')
      .attach('file', PNG, {
        filename: '../../evil name.png',
        contentType: 'image/png',
      });
    expect(ok.status).toBe(201);
    const row = unwrap<{
      id: string;
      storageKey: string;
      originalName: string;
      downloadPath: string;
      scannedStatus: string;
    }>(ok.body);
    expect(row.storageKey).toMatch(
      new RegExp(`^${seed.alpha.tenant.id}/[0-9a-f]{32}\\.png$`),
    );
    expect(row.originalName).not.toContain('/');
    const dl = await api().get(`/api${row.downloadPath}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    // unscanned → quarantined semantics (never served as trusted inline content)
    expect(dl.headers['content-type']).toContain('application/octet-stream');
    expect(dl.headers['x-amqur-scan-status']).toBe(row.scannedStatus);
    // tampered/expired links fail; other tenant cannot mint a link that works for this file
    expect(
      (await api().get(`/api${row.downloadPath.replace(/s=[^&]+/, 's=AAAA')}`))
        .status,
    ).toBe(403);
    const betaLink = unwrap<{ downloadPath: string }>(
      (
        await api()
          .get(`/api/uploads/${row.id}/link`)
          .set('Authorization', `Bearer ${betaAdmin}`)
      ).body,
    );
    expect((await api().get(`/api${betaLink.downloadPath}`)).status).toBe(404);
  });

  it('retention hard-deletes stale conversations, keeps audit, honors legal hold', async () => {
    const tenantId = seed.alpha.tenant.id;
    const old = await ctx.prisma.conversation.create({
      data: {
        tenantId,
        externalKey: `ret-${Date.now()}`,
        lastActivityAt: new Date('2020-01-01'),
        messages: { create: [{ role: 'USER', content: 'old message' }] },
      },
    });
    await ctx.prisma.tenant.update({
      where: { id: tenantId },
      data: { legalHold: true },
    });
    const svc = ctx.app.get(RetentionService);
    const held = await svc.enforceRetention();
    expect(held.find((r) => r.tenant === 'pilot-alpha')?.skipped).toBe(
      'legal_hold',
    );
    expect(
      await ctx.prisma.conversation.findUnique({ where: { id: old.id } }),
    ).not.toBeNull();
    await ctx.prisma.tenant.update({
      where: { id: tenantId },
      data: { legalHold: false },
    });
    const auditBefore = await ctx.prisma.auditLog.count({
      where: { tenantId },
    });
    const res = await svc.enforceRetention();
    expect(
      res.find((r) => r.tenant === 'pilot-alpha')!.conversationsDeleted,
    ).toBeGreaterThanOrEqual(1);
    expect(
      await ctx.prisma.conversation.findUnique({ where: { id: old.id } }),
    ).toBeNull();
    expect(
      await ctx.prisma.auditLog.count({ where: { tenantId } }),
    ).toBeGreaterThan(auditBefore);
  });

  it('privacy export + deletion are exact-match, tenant-scoped and audited', async () => {
    const tenantId = seed.alpha.tenant.id;
    const conv = await ctx.prisma.conversation.create({
      data: {
        tenantId,
        externalKey: `priv-${Date.now()}`,
        messages: {
          create: [
            { role: 'USER', content: 'I am Pat, pat.privacy@example.com' },
          ],
        },
      },
    });
    await ctx.prisma.lead.create({
      data: {
        tenantId,
        conversationId: conv.id,
        firstName: 'Pat',
        email: 'pat.privacy@example.com',
        phone: '3125550177',
      },
    });
    await ctx.prisma.consentRecord.create({
      data: {
        tenantId,
        channel: 'EMAIL',
        endpoint: 'pat.privacy@example.com',
        purpose: 'CONVERSATIONAL',
        granted: true,
        source: 'WIDGET',
      },
    });
    const exp = unwrap<{ leads: unknown[]; conversations: unknown[] }>(
      (
        await api()
          .post('/api/privacy/export')
          .set('Authorization', `Bearer ${admin}`)
          .send({ email: 'PAT.privacy@example.com' })
      ).body,
    );
    expect(exp.leads).toHaveLength(1);
    // fuzzy/partial matches are not returned
    expect(
      unwrap<{ leads: unknown[] }>(
        (
          await api()
            .post('/api/privacy/export')
            .set('Authorization', `Bearer ${admin}`)
            .send({ email: 'pat@example.com' })
        ).body,
      ).leads,
    ).toHaveLength(0);
    // other tenant sees nothing
    expect(
      unwrap<{ leads: unknown[] }>(
        (
          await api()
            .post('/api/privacy/export')
            .set('Authorization', `Bearer ${betaAdmin}`)
            .send({ email: 'pat.privacy@example.com' })
        ).body,
      ).leads,
    ).toHaveLength(0);
    await api()
      .post('/api/privacy/delete')
      .set('Authorization', `Bearer ${admin}`)
      .send({ email: 'pat.privacy@example.com' })
      .expect(201);
    const msgs = await ctx.prisma.message.findMany({
      where: { conversationId: conv.id },
    });
    expect(msgs.every((m) => !m.content.includes('pat.privacy'))).toBe(true);
    const lead = await ctx.prisma.lead.findFirst({
      where: { conversationId: conv.id },
    });
    expect(lead?.email).toBeNull();
    const consent = await ctx.prisma.consentRecord.findFirst({
      where: {
        tenantId,
        channel: 'EMAIL',
        endpoint: { startsWith: 'redacted:' },
      },
    });
    expect(consent).not.toBeNull(); // consent history retained, pseudonymized
  });
});
