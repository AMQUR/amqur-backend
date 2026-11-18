import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import {
  createE2eApp,
  seedTwoTenants,
  unwrap,
  E2eCtx,
} from '../helpers/e2e-app';
import { OutboxProcessorService } from '../../src/integrations/core/outbox-processor.service';

/**
 * HTTP-level suite for consent linkage: consentRef must be a real, current ConsentRecord for the
 * same tenant, lead, rooftop and channel, re-verified at propose, approve and execute.
 */
const PASSWORD = 'TestPass123!';
type Action = {
  id: string;
  status: string;
  checksum: string;
  failureReason?: string | null;
};

describe('Tool consent linkage HTTP behaviour', () => {
  let ctx: E2eCtx;
  const tok: Record<string, string> = {};
  let alphaId = '';
  let betaId = '';
  let locA = '';
  let locB = '';

  const api = () => request(ctx.app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${tok[who]}` });
  async function login(email: string): Promise<string> {
    const r = await api()
      .post('/api/auth/login')
      .send({ email, password: PASSWORD });
    const b = unwrap<{ access_token?: string; accessToken?: string }>(r.body);
    return b.access_token || b.accessToken || '';
  }
  async function mkUser(
    tenantId: string,
    locationId: string | null,
    email: string,
    role: Role,
  ) {
    const password = await bcrypt.hash(PASSWORD, 10);
    await ctx.prisma.user.upsert({
      where: { tenantId_email: { tenantId, email } },
      create: {
        tenantId,
        locationId,
        email,
        password,
        firstName: 'C',
        lastName: 'N',
        role,
      },
      update: { password, role, locationId },
    });
  }
  const grant = (o: Record<string, unknown> = {}) =>
    ctx.prisma.consentRecord.create({
      data: {
        tenantId: alphaId,
        locationId: null,
        leadId: 'lead-c1',
        channel: 'SMS',
        endpoint: '+15551230001',
        purpose: 'CONVERSATIONAL',
        granted: true,
        source: 'STAFF',
        ...o,
      } as never,
    });
  const propose = (
    who: string,
    consentRef: string | undefined,
    input: Record<string, string> = {
      leadId: 'lead-c1',
      channel: 'SMS',
      body: 'Hello',
    },
    extra: Record<string, unknown> = {},
  ) =>
    api()
      .post('/api/ops/tools/actions')
      .set(auth(who))
      .send({
        tool: 'message.send',
        input,
        ...(consentRef ? { consentRef } : {}),
        ...extra,
      });
  const decide = (
    who: string,
    id: string,
    checksum: string,
    decision = 'APPROVE',
  ) =>
    api()
      .post(`/api/ops/tools/actions/${id}/decision`)
      .set(auth(who))
      .send({ decision, reviewedChecksum: checksum });

  beforeAll(async () => {
    process.env.TOOL_REGISTRY_ENABLED = 'true';
    delete process.env.TOOL_DISPATCH_ENABLED;
    ctx = await createE2eApp();
    const seed = await seedTwoTenants(ctx.prisma);
    alphaId =
      seed.alpha.tenant?.id ??
      (
        await ctx.prisma.tenant.findUniqueOrThrow({
          where: { slug: 'pilot-alpha' },
        })
      ).id;
    betaId = (
      await ctx.prisma.tenant.findUniqueOrThrow({
        where: { slug: 'pilot-beta' },
      })
    ).id;
    await ctx.prisma.toolActionRequest.deleteMany({
      where: { tenantId: alphaId },
    });
    await ctx.prisma.consentRecord.deleteMany({
      where: {
        tenantId: { in: [alphaId, betaId] },
        leadId: { startsWith: 'lead-c' },
      },
    });
    locA = (
      await ctx.prisma.location.findFirstOrThrow({
        where: { tenantId: alphaId, slug: 'main' },
      })
    ).id;
    locB = (
      await ctx.prisma.location.upsert({
        where: { tenantId_slug: { tenantId: alphaId, slug: 'second' } },
        create: {
          tenantId: alphaId,
          name: 'Second',
          slug: 'second',
          timezone: 'America/Chicago',
        },
        update: {},
      })
    ).id;
    await mkUser(alphaId, locA, 'cmgr@pilot-alpha.test', Role.MANAGER);
    await mkUser(alphaId, null, 'cprop@pilot-alpha.test', Role.ADMIN);
    await mkUser(alphaId, null, 'crev@pilot-alpha.test', Role.ADMIN);
    tok.mgr = await login('cmgr@pilot-alpha.test');
    tok.prop = await login('cprop@pilot-alpha.test');
    tok.rev = await login('crev@pilot-alpha.test');
  }, 120_000);

  afterAll(async () => {
    delete process.env.TOOL_REGISTRY_ENABLED;
    delete process.env.TOOL_DISPATCH_ENABLED;
    if (ctx?.app) await ctx.app.close();
  });

  it('rejects missing, unknown, other-tenant, revoked, opt-out, wrong-lead and wrong-channel consent', async () => {
    await propose('prop', undefined).expect(400);
    await propose('prop', 'does-not-exist').expect(400);
    const foreign = await ctx.prisma.consentRecord.create({
      data: {
        tenantId: betaId,
        leadId: 'lead-c1',
        channel: 'SMS',
        endpoint: '+15551239999',
        purpose: 'CONVERSATIONAL',
        granted: true,
        source: 'STAFF',
      },
    });
    const r = await propose('prop', foreign.id).expect(400);
    expect(JSON.stringify(r.body)).toContain('consent_not_found');
    expect(JSON.stringify(r.body)).not.toContain('555123');
    const revoked = await grant({
      endpoint: '+15551230002',
      revokedAt: new Date(),
    });
    await propose('prop', revoked.id).expect(400);
    const optOut = await grant({ endpoint: '+15551230003', granted: false });
    await propose('prop', optOut.id).expect(400);
    const other = await grant({ endpoint: '+15551230004', leadId: 'lead-c2' });
    await propose('prop', other.id).expect(400);
    const email = await grant({ endpoint: 'c@example.com', channel: 'EMAIL' });
    await propose('prop', email.id).expect(400);
    expect(
      await ctx.prisma.toolActionRequest.count({
        where: { tenantId: alphaId },
      }),
    ).toBe(0);
  });

  it("rooftop isolation: a rooftop-bound manager cannot use another rooftop's consent", async () => {
    const onB = await grant({ endpoint: '+15551230005', locationId: locB });
    await propose('mgr', onB.id).expect(400);
    const onA = await grant({ endpoint: '+15551230006', locationId: locA });
    const ok = await propose('mgr', onA.id).expect(201);
    expect(unwrap<Action>(ok.body).status).toBe('PENDING_APPROVAL');
  });

  it('valid consent proposes; a later opt-out blocks approval but still allows denial', async () => {
    const rec = await grant({ endpoint: '+15551230007' });
    const a = unwrap<Action>((await propose('prop', rec.id).expect(201)).body);
    await grant({
      endpoint: '+15551230007',
      granted: false,
      purpose: 'CONVERSATIONAL',
    });
    const blocked = await decide('rev', a.id, a.checksum).expect(409);
    expect(JSON.stringify(blocked.body)).toContain('consent_opted_out');
    expect(
      (
        await ctx.prisma.toolActionRequest.findUniqueOrThrow({
          where: { id: a.id },
        })
      ).status,
    ).toBe('PENDING_APPROVAL');
    await decide('rev', a.id, a.checksum, 'DENY').expect(201);
  });

  it('consent revoked after approval fails closed at execution: FAILED, audited, never executed', async () => {
    process.env.TOOL_DISPATCH_ENABLED = 'true';
    const rec = await grant({ endpoint: '+15551230008' });
    const a = unwrap<Action>((await propose('prop', rec.id).expect(201)).body);
    await decide('rev', a.id, a.checksum).expect(201);
    // Opt-out lands between approval and the outbox worker picking the event up.
    await grant({ endpoint: '+15551230008', granted: false });
    await ctx.app.get(OutboxProcessorService).processBatch(200);
    const row = await ctx.prisma.toolActionRequest.findUniqueOrThrow({
      where: { id: a.id },
    });
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toBe('consent_opted_out');
    expect(row.result).toBeNull();
    expect(
      await ctx.prisma.auditLog.count({
        where: {
          tenantId: alphaId,
          resourceId: a.id,
          action: 'tool.action.blocked.consent',
        },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.auditLog.count({
        where: {
          tenantId: alphaId,
          resourceId: a.id,
          action: 'tool.action.executed.mock',
        },
      }),
    ).toBe(0);
    delete process.env.TOOL_DISPATCH_ENABLED;
  });

  it('with consent still valid, execution proceeds (mock) exactly once', async () => {
    process.env.TOOL_DISPATCH_ENABLED = 'true';
    const rec = await grant({ endpoint: '+15551230009' });
    const a = unwrap<Action>((await propose('prop', rec.id).expect(201)).body);
    await decide('rev', a.id, a.checksum).expect(201);
    const proc = ctx.app.get(OutboxProcessorService);
    await proc.processBatch(200);
    await proc.processBatch(200);
    expect(
      (
        await ctx.prisma.toolActionRequest.findUniqueOrThrow({
          where: { id: a.id },
        })
      ).status,
    ).toBe('EXECUTED');
    expect(
      await ctx.prisma.auditLog.count({
        where: {
          tenantId: alphaId,
          resourceId: a.id,
          action: 'tool.action.executed.mock',
        },
      }),
    ).toBe(1);
    delete process.env.TOOL_DISPATCH_ENABLED;
  });
});
