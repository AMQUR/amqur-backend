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
import { actionChecksum } from '../../src/tool-registry/tool-catalog';

/**
 * HTTP-level security suite for the tool registry and approval inbox.
 * Real JWT guards, real Postgres. All providers are mocks; nothing leaves the process.
 */
const PASSWORD = 'TestPass123!';
type Action = {
  id: string;
  status: string;
  checksum: string;
  outboxEventId: string | null;
  locationId: string | null;
};

describe('Tool registry HTTP security', () => {
  let ctx: E2eCtx;
  const tok: Record<string, string> = {};
  let alphaId = '';
  let alphaLocId = '';
  let alphaLoc2Id = '';

  const api = () => request(ctx.app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${tok[who]}` });

  async function login(email: string): Promise<string> {
    const r = await api()
      .post('/api/auth/login')
      .send({ email, password: PASSWORD })
      .expect((x) => expect([200, 201]).toContain(x.status));
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
        firstName: 'T',
        lastName: 'R',
        role,
      },
      update: { password, role, locationId },
    });
  }

  /** Direct insert: POST /actions is throttled (20/min) and race tests need many rows. */
  async function seedAction(over: {
    toolName?: string;
    input?: Record<string, string>;
    locationId?: string | null;
    requestedBy?: string;
    expiresAt?: Date;
    consentRef?: string | null;
  }) {
    const requester = await ctx.prisma.user.findFirstOrThrow({
      where: { email: over.requestedBy ?? 'rev1@pilot-alpha.test' },
    });
    const toolName = over.toolName ?? 'crm.note.add';
    const input = over.input ?? { leadId: 'lead-1', note: 'seeded' };
    const locationId = over.locationId === undefined ? null : over.locationId;
    const consentRef = over.consentRef ?? null;
    return ctx.prisma.toolActionRequest.create({
      data: {
        tenantId: alphaId,
        locationId,
        toolName,
        toolVersion: 1,
        input,
        consentRef,
        checksum: actionChecksum({
          toolName,
          toolVersion: 1,
          locationId,
          input,
          consentRef,
        }),
        expiresAt: over.expiresAt ?? new Date(Date.now() + 3_600_000),
        requestedByUserId: requester.id,
      },
    });
  }

  const decide = (who: string, id: string, body: Record<string, unknown>) =>
    api()
      .post(`/api/ops/tools/actions/${id}/decision`)
      .set(auth(who))
      .send(body);

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
    await ctx.prisma.toolActionRequest.deleteMany({
      where: { tenantId: alphaId },
    });
    alphaLocId = (
      await ctx.prisma.location.findFirstOrThrow({
        where: { tenantId: alphaId, slug: 'main' },
      })
    ).id;
    alphaLoc2Id = (
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
    await mkUser(alphaId, alphaLocId, 'mgr1@pilot-alpha.test', Role.MANAGER);
    await mkUser(alphaId, alphaLoc2Id, 'mgr2@pilot-alpha.test', Role.MANAGER);
    await mkUser(alphaId, alphaLocId, 'staff@pilot-alpha.test', Role.STAFF);
    await mkUser(alphaId, null, 'rev1@pilot-alpha.test', Role.ADMIN);
    await mkUser(alphaId, null, 'rev2@pilot-alpha.test', Role.ADMIN);
    for (const [k, e] of Object.entries({
      admin: 'admin@pilot-alpha.test',
      mgr1: 'mgr1@pilot-alpha.test',
      mgr2: 'mgr2@pilot-alpha.test',
      staff: 'staff@pilot-alpha.test',
      rev1: 'rev1@pilot-alpha.test',
      rev2: 'rev2@pilot-alpha.test',
      beta: 'admin@pilot-beta.test',
    }))
      tok[k] = await login(e);
    const w = await api()
      .post('/api/public/widget-token')
      .set('Origin', 'http://127.0.0.1:18084')
      .send({ tenantSlug: 'pilot-alpha', locationSlug: 'main' });
    tok.widget = unwrap<{ token: string }>(w.body).token;
  }, 120_000);

  afterAll(async () => {
    delete process.env.TOOL_REGISTRY_ENABLED;
    delete process.env.TOOL_DISPATCH_ENABLED;
    await ctx.app.close();
  });

  it('rejects unauthenticated, widget-token and STAFF callers', async () => {
    await api().get('/api/ops/tools/catalog').expect(401);
    await api().get('/api/ops/tools/actions').expect(401);
    await api().get('/api/ops/tools/catalog').set(auth('widget')).expect(403);
    await api().get('/api/ops/tools/actions').set(auth('staff')).expect(403);
    await api()
      .post('/api/ops/tools/actions')
      .set(auth('staff'))
      .send({ tool: 'crm.note.add', input: { leadId: 'l', note: 'n' } })
      .expect(403);
  });

  it('serves the catalog read-only and fails closed when the flag is off', async () => {
    const c = unwrap<{ providerMode: string; tools: { name: string }[] }>(
      (await api().get('/api/ops/tools/catalog').set(auth('admin')).expect(200))
        .body,
    );
    expect(c.providerMode).toBe('MOCK');
    expect(c.tools.map((t) => t.name)).toContain('message.send');
    process.env.TOOL_REGISTRY_ENABLED = 'false';
    await api()
      .post('/api/ops/tools/actions')
      .set(auth('admin'))
      .send({ tool: 'crm.note.add', input: { leadId: 'l', note: 'n' } })
      .expect(403);
    const row = await seedAction({});
    await decide('rev2', row.id, {
      decision: 'DENY',
    }).expect(403);
    process.env.TOOL_REGISTRY_ENABLED = 'true';
    const still = await ctx.prisma.toolActionRequest.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(still.status).toBe('PENDING_APPROVAL');
  });

  it('validates input, tools and consent', async () => {
    const post = (b: Record<string, unknown>) =>
      api().post('/api/ops/tools/actions').set(auth('admin')).send(b);
    await post({ tool: 'nope', input: {} }).expect(404);
    await post({ tool: 'crm.note.add', input: { leadId: 'l' } }).expect(400);
    await post({
      tool: 'crm.note.add',
      input: { leadId: 'l', note: 'n', extra: 'x' },
    }).expect(400);
    await post({
      tool: 'message.send',
      input: { leadId: 'l', channel: 'SMS', body: 'hello' },
    }).expect(400);
  });

  it('proposes PENDING_APPROVAL, masks PII, idempotent replay, conflict on changed input', async () => {
    const body = {
      tool: 'crm.note.add',
      input: { leadId: 'lead-9', note: 'call 555-123-4567 re: a@b.com' },
      idempotencyKey: 'e2e-key-0001',
    };
    const a = unwrap<Action & { input: { note: string } }>(
      (
        await api()
          .post('/api/ops/tools/actions')
          .set(auth('mgr1'))
          .send(body)
          .expect(201)
      ).body,
    );
    expect(a.status).toBe('PENDING_APPROVAL');
    expect(a.input.note).not.toMatch(/555|a@b\.com/);
    expect(a.locationId).toBe(alphaLocId);
    const again = unwrap<Action>(
      (
        await api()
          .post('/api/ops/tools/actions')
          .set(auth('mgr1'))
          .send(body)
          .expect(201)
      ).body,
    );
    expect(again.id).toBe(a.id);
    await api()
      .post('/api/ops/tools/actions')
      .set(auth('mgr1'))
      .send({ ...body, input: { leadId: 'lead-9', note: 'different' } })
      .expect(409);
    expect(
      await ctx.prisma.toolActionRequest.count({
        where: { tenantId: alphaId, idempotencyKey: 'e2e-key-0001' },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.auditLog.count({
        where: { resourceId: a.id, action: 'tool.action.proposed' },
      }),
    ).toBe(1);
  });

  it('isolates tenants and rooftops', async () => {
    const row = await seedAction({ locationId: alphaLocId });
    await api()
      .get(`/api/ops/tools/actions/${row.id}`)
      .set(auth('beta'))
      .expect(404);
    await decide('beta', row.id, { decision: 'DENY' }).expect(404);
    await api()
      .post(`/api/ops/tools/actions/${row.id}/cancel`)
      .set(auth('beta'))
      .expect(404);
    await api()
      .get(`/api/ops/tools/actions/${row.id}`)
      .set(auth('mgr2'))
      .expect(403);
    await decide('mgr2', row.id, { decision: 'DENY' }).expect(403);
    await api()
      .post('/api/ops/tools/actions')
      .set(auth('mgr1'))
      .send({
        tool: 'crm.note.add',
        input: { leadId: 'l', note: 'n' },
        locationId: alphaLoc2Id,
      })
      .expect(403);
    const list = unwrap<Action[]>(
      (await api().get('/api/ops/tools/actions').set(auth('mgr2')).expect(200))
        .body,
    );
    expect(list.every((x) => x.locationId === alphaLoc2Id)).toBe(true);
    const betaList = unwrap<Action[]>(
      (await api().get('/api/ops/tools/actions').set(auth('beta')).expect(200))
        .body,
    );
    expect(betaList.find((x) => x.id === row.id)).toBeUndefined();
    const still = await ctx.prisma.toolActionRequest.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(still.status).toBe('PENDING_APPROVAL');
  });

  it('enforces separation of duties, checksum binding and role policy', async () => {
    const row = await seedAction({});
    // requester rev1 cannot decide own request
    await decide('rev1', row.id, {
      decision: 'APPROVE',
      reviewedChecksum: row.checksum,
    }).expect(403);
    await decide('rev2', row.id, { decision: 'APPROVE' }).expect(409);
    await decide('rev2', row.id, {
      decision: 'APPROVE',
      reviewedChecksum: 'stale',
    }).expect(409);
    // HIGH-risk tool: MANAGER may not approve even in-rooftop
    const hi = await seedAction({
      toolName: 'message.send',
      input: { leadId: 'l', channel: 'SMS', body: 'hello' },
      consentRef: 'consent-1',
      locationId: alphaLocId,
    });
    await decide('mgr1', hi.id, {
      decision: 'APPROVE',
      reviewedChecksum: hi.checksum,
    }).expect(403);
    const rows = await ctx.prisma.toolActionRequest.findMany({
      where: { id: { in: [row.id, hi.id] } },
    });
    expect(rows.every((r) => r.status === 'PENDING_APPROVAL')).toBe(true);
  });

  it('approves without dispatch while the dispatch flag is off', async () => {
    const row = await seedAction({});
    const r = unwrap<Action>(
      (
        await decide('rev2', row.id, {
          decision: 'APPROVE',
          reviewedChecksum: row.checksum,
        }).expect(201)
      ).body,
    );
    expect(r.status).toBe('APPROVED');
    expect(r.outboxEventId).toBeNull();
    expect(
      await ctx.prisma.outboxEvent.count({
        where: { tenantId: alphaId, idempotencyKey: `tool-action:${row.id}` },
      }),
    ).toBe(0);
  });

  it('dispatch on: approve enqueues one outbox event; mock executor runs it once', async () => {
    process.env.TOOL_DISPATCH_ENABLED = 'true';
    const row = await seedAction({});
    const r = unwrap<Action>(
      (
        await decide('rev2', row.id, {
          decision: 'APPROVE',
          reviewedChecksum: row.checksum,
        }).expect(201)
      ).body,
    );
    expect(r.outboxEventId).toBeTruthy();
    // second decision is rejected and does not enqueue again
    await decide('admin', row.id, { decision: 'DENY' }).expect(409);
    const proc = ctx.app.get(OutboxProcessorService);
    await proc.processBatch(200);
    await proc.processBatch(200);
    const done = await ctx.prisma.toolActionRequest.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(done.status).toBe('EXECUTED');
    expect(done.result).toMatchObject({ mock: true });
    expect(
      await ctx.prisma.outboxEvent.count({
        where: { tenantId: alphaId, idempotencyKey: `tool-action:${row.id}` },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.auditLog.count({
        where: { resourceId: row.id, action: 'tool.action.executed.mock' },
      }),
    ).toBe(1);
    delete process.env.TOOL_DISPATCH_ENABLED;
  });

  it('denied, cancelled and expired actions never execute or enqueue', async () => {
    process.env.TOOL_DISPATCH_ENABLED = 'true';
    const denied = await seedAction({});
    await decide('rev2', denied.id, { decision: 'DENY' }).expect(201);
    const cancelled = await seedAction({});
    await api()
      .post(`/api/ops/tools/actions/${cancelled.id}/cancel`)
      .set(auth('rev2'))
      .expect(201);
    const expired = await seedAction({
      expiresAt: new Date(Date.now() - 1000),
    });
    await decide('rev2', expired.id, {
      decision: 'APPROVE',
      reviewedChecksum: expired.checksum,
    }).expect(409);
    await ctx.app.get(OutboxProcessorService).processBatch(200);
    const rows = await ctx.prisma.toolActionRequest.findMany({
      where: { id: { in: [denied.id, cancelled.id, expired.id] } },
    });
    expect(rows.map((r) => r.status).sort()).toEqual([
      'CANCELLED',
      'DENIED',
      'EXPIRED',
    ]);
    expect(
      await ctx.prisma.outboxEvent.count({
        where: {
          tenantId: alphaId,
          idempotencyKey: {
            in: [denied.id, cancelled.id, expired.id].map(
              (i) => `tool-action:${i}`,
            ),
          },
        },
      }),
    ).toBe(0);
    delete process.env.TOOL_DISPATCH_ENABLED;
  });

  it('concurrent approve/deny/cancel: exactly one decision wins, at most one outbox event', async () => {
    process.env.TOOL_DISPATCH_ENABLED = 'true';
    const row = await seedAction({});
    const results = await Promise.all([
      decide('rev2', row.id, {
        decision: 'APPROVE',
        reviewedChecksum: row.checksum,
      }),
      decide('admin', row.id, { decision: 'DENY' }),
      api()
        .post(`/api/ops/tools/actions/${row.id}/cancel`)
        .set(auth('rev1'))
        .send(),
    ]);
    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBe(1);
    const final = await ctx.prisma.toolActionRequest.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(['APPROVED', 'DENIED', 'CANCELLED']).toContain(final.status);
    const events = await ctx.prisma.outboxEvent.count({
      where: { tenantId: alphaId, idempotencyKey: `tool-action:${row.id}` },
    });
    expect(events).toBe(final.status === 'APPROVED' ? 1 : 0);
    delete process.env.TOOL_DISPATCH_ENABLED;
  });
});
