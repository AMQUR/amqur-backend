import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import {
  createE2eApp,
  seedTwoTenants,
  unwrap,
  E2eCtx,
} from '../helpers/e2e-app';

/**
 * HTTP-level security suite for Workflow Lab (definitions, runs, preview).
 * Real JWT guards, real Postgres. Any cross-tenant / cross-rooftop leak is release-blocking.
 */
const PASSWORD = 'TestPass123!';
const graph = {
  version: 1,
  nodes: [
    { id: 'start', type: 'start', next: 'kb' },
    { id: 'kb', type: 'knowledge_search', next: 'br', limit: 3 },
    {
      id: 'br',
      type: 'branch_on_verified_sources',
      whenFound: 'done',
      whenMissing: 'rev',
    },
    { id: 'done', type: 'end' },
    { id: 'rev', type: 'human_review', reason: 'specialist' },
  ],
};

describe('Workflow Lab HTTP security', () => {
  let ctx: E2eCtx;
  const tok: Record<string, string> = {};
  let alphaLoc2Id = '';
  let alphaLocId = '';
  let defId = '';

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
        firstName: 'W',
        lastName: 'L',
        role,
      },
      update: { password, role, locationId },
    });
  }

  async function startRun(who: string, definitionId = defId, key?: string) {
    return api()
      .post('/api/ops/workflow-lab/runs')
      .set(auth(who))
      .send({
        definitionId,
        query: 'warranty question',
        ...(key ? { idempotencyKey: key } : {}),
      });
  }

  /** Suspended run inserted directly: POST /runs is throttled (10/min), concurrency tests need many. */
  async function seedSuspended(): Promise<{ id: string }> {
    const starter = await ctx.prisma.user.findFirstOrThrow({
      where: { email: 'admin@pilot-alpha.test' },
    });
    const run = await ctx.prisma.workflowRun.create({
      data: {
        tenantId: starter.tenantId,
        locationId: alphaLocId,
        definitionId: defId,
        version: 1,
        status: 'SUSPENDED',
        outcome: 'blocked_pending_review',
        currentNodeId: 'rev',
        queryRedacted: 'seeded',
        queryLength: 6,
        startedByUserId: starter.id,
        suspendedAt: new Date(),
        suspendedExpiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { id: run.id };
  }

  beforeAll(async () => {
    ctx = await createE2eApp();
    const seed = await seedTwoTenants(ctx.prisma);
    const alphaId =
      seed.alpha.tenant?.id ??
      (
        await ctx.prisma.tenant.findUniqueOrThrow({
          where: { slug: 'pilot-alpha' },
        })
      ).id;
    // Deterministic reruns: the per-tenant hourly run quota counts persisted runs.
    await ctx.prisma.workflowRun.deleteMany({ where: { tenantId: alphaId } });
    const alphaLoc = await ctx.prisma.location.findFirstOrThrow({
      where: { tenantId: alphaId, slug: 'main' },
    });
    alphaLocId = alphaLoc.id;
    const loc2 = await ctx.prisma.location.upsert({
      where: { tenantId_slug: { tenantId: alphaId, slug: 'second' } },
      create: {
        tenantId: alphaId,
        name: 'Second',
        slug: 'second',
        timezone: 'America/Chicago',
      },
      update: {},
    });
    alphaLoc2Id = loc2.id;
    await mkUser(alphaId, alphaLocId, 'mgr1@pilot-alpha.test', Role.MANAGER);
    await mkUser(alphaId, alphaLoc2Id, 'mgr2@pilot-alpha.test', Role.MANAGER);
    await mkUser(alphaId, alphaLocId, 'staff@pilot-alpha.test', Role.STAFF);
    await mkUser(alphaId, null, 'rev1@pilot-alpha.test', Role.ADMIN);
    await mkUser(alphaId, null, 'rev2@pilot-alpha.test', Role.ADMIN);
    tok.admin = await login('admin@pilot-alpha.test');
    tok.mgr1 = await login('mgr1@pilot-alpha.test');
    tok.mgr2 = await login('mgr2@pilot-alpha.test');
    tok.staff = await login('staff@pilot-alpha.test');
    tok.rev1 = await login('rev1@pilot-alpha.test');
    tok.rev2 = await login('rev2@pilot-alpha.test');
    tok.beta = await login('admin@pilot-beta.test');
    const w = await api()
      .post('/api/public/widget-token')
      .set('Origin', 'http://127.0.0.1:18084')
      .send({ tenantSlug: 'pilot-alpha', locationSlug: 'main' });
    tok.widget = unwrap<{ token: string }>(w.body).token;

    // Rooftop-bound definition created by mgr1 (alphaLoc), published by independent rev1.
    const created = await api()
      .post('/api/ops/workflow-lab/definitions')
      .set(auth('mgr1'))
      .send({ name: 'e2e wf', graph })
      .expect(201);
    defId = unwrap<{ id: string }>(created.body).id;
    await api()
      .post(`/api/ops/workflow-lab/definitions/${defId}/request-review`)
      .set(auth('mgr1'))
      .expect(201);
    const got = await api()
      .get(`/api/ops/workflow-lab/definitions/${defId}`)
      .set(auth('rev1'))
      .expect(200);
    const sum = unwrap<{ draftChecksum: string }>(got.body).draftChecksum;
    await api()
      .post(`/api/ops/workflow-lab/definitions/${defId}/approve`)
      .set(auth('rev1'))
      .send({ reviewedChecksum: sum })
      .expect(201);
  }, 120_000);

  afterAll(async () => {
    if (ctx?.app) await ctx.app.close();
  });

  const endpoints: Array<[string, string]> = [
    ['get', '/api/ops/workflow-lab/definitions'],
    ['post', '/api/ops/workflow-lab/definitions'],
    ['get', '/api/ops/workflow-lab/runs'],
    ['post', '/api/ops/workflow-lab/runs'],
    ['post', '/api/ops/workflow-lab/preview'],
  ];

  it.each(endpoints)('%s %s: unauthenticated -> 401', async (method, url) => {
    const r = await (
      api() as unknown as Record<string, (u: string) => request.Test>
    )
      [method](url)
      .send({});
    expect(r.status).toBe(401);
  });

  it.each(endpoints)(
    '%s %s: widget JWT and STAFF -> 403',
    async (method, url) => {
      for (const who of ['widget', 'staff']) {
        const r = await (
          api() as unknown as Record<string, (u: string) => request.Test>
        )
          [method](url)
          .set(auth(who))
          .send({});
        expect(r.status).toBe(403);
      }
    },
  );

  it('cross-tenant: another tenant cannot read, run, decide or version alpha workflows', async () => {
    await api()
      .get(`/api/ops/workflow-lab/definitions/${defId}`)
      .set(auth('beta'))
      .expect(404);
    await api()
      .get(`/api/ops/workflow-lab/definitions/${defId}/versions`)
      .set(auth('beta'))
      .expect(404);
    await startRun('beta').then((r) => expect(r.status).toBe(404));
    const run = unwrap<{ id: string }>((await startRun('admin')).body);
    await api()
      .get(`/api/ops/workflow-lab/runs/${run.id}`)
      .set(auth('beta'))
      .expect(404);
    await api()
      .post(`/api/ops/workflow-lab/runs/${run.id}/decision`)
      .set(auth('beta'))
      .send({ decision: 'APPROVE' })
      .expect(404);
    await api()
      .post(`/api/ops/workflow-lab/runs/${run.id}/cancel`)
      .set(auth('beta'))
      .expect(404);
    const betaList = unwrap<unknown[]>(
      (
        await api()
          .get('/api/ops/workflow-lab/runs')
          .set(auth('beta'))
          .expect(200)
      ).body,
    );
    expect(betaList).toEqual([]);
  });

  it('cross-rooftop: a manager bound to another rooftop is denied everywhere', async () => {
    await api()
      .get(`/api/ops/workflow-lab/definitions/${defId}`)
      .set(auth('mgr2'))
      .expect(403);
    await startRun('mgr2').then((r) => expect(r.status).toBe(403));
    const run = unwrap<{ id: string }>((await startRun('mgr1')).body);
    await api()
      .get(`/api/ops/workflow-lab/runs/${run.id}`)
      .set(auth('mgr2'))
      .expect(403);
    await api()
      .post(`/api/ops/workflow-lab/runs/${run.id}/decision`)
      .set(auth('mgr2'))
      .send({ decision: 'APPROVE' })
      .expect(403);
    await api()
      .post(`/api/ops/workflow-lab/runs/${run.id}/cancel`)
      .set(auth('mgr2'))
      .expect(403);
    const mine = unwrap<Array<{ locationId: string }>>(
      (
        await api()
          .get('/api/ops/workflow-lab/runs')
          .set(auth('mgr2'))
          .expect(200)
      ).body,
    );
    expect(mine.every((r) => r.locationId === alphaLoc2Id)).toBe(true);
    // preview for a rooftop outside the caller's binding / tenant
    await api()
      .post('/api/ops/workflow-lab/preview')
      .set(auth('mgr2'))
      .send({ graph, query: 'x', locationId: alphaLocId })
      .expect(403);
  });

  it('tenant/rooftop are taken from the JWT: a body locationId from another tenant is rejected', async () => {
    const betaLoc = await ctx.prisma.location.findFirstOrThrow({
      where: { tenant: { slug: 'pilot-beta' } },
    });
    await api()
      .post('/api/ops/workflow-lab/preview')
      .set(auth('rev1'))
      .send({ graph, query: 'x', locationId: betaLoc.id })
      .expect(403);
    await api()
      .post('/api/ops/workflow-lab/definitions')
      .set(auth('rev1'))
      .send({ name: 'x', graph, locationId: betaLoc.id })
      .expect(403);
  });

  it('run lifecycle over HTTP: suspend, starter cannot decide, independent approval, no repeat', async () => {
    const started = await startRun('admin');
    expect(started.status).toBe(201);
    const run = unwrap<{ id: string; status: string }>(started.body);
    expect(run.status).toBe('SUSPENDED');
    await api()
      .post(`/api/ops/workflow-lab/runs/${run.id}/decision`)
      .set(auth('admin'))
      .send({ decision: 'APPROVE' })
      .expect(403);
    const ok = await api()
      .post(`/api/ops/workflow-lab/runs/${run.id}/decision`)
      .set(auth('rev1'))
      .send({ decision: 'APPROVE' })
      .expect(201);
    expect(unwrap<{ outcome: string }>(ok.body).outcome).toBe('human_approved');
    await api()
      .post(`/api/ops/workflow-lab/runs/${run.id}/decision`)
      .set(auth('rev2'))
      .send({ decision: 'APPROVE' })
      .expect(409);
    await api()
      .post(`/api/ops/workflow-lab/runs/${run.id}/cancel`)
      .set(auth('admin'))
      .expect(409);
  });

  it('concurrency: approve vs cancel yields exactly one terminal state, consistent with the winner', async () => {
    for (let i = 0; i < 5; i += 1) {
      const run = await seedSuspended();
      const [a, c] = await Promise.all([
        api()
          .post(`/api/ops/workflow-lab/runs/${run.id}/decision`)
          .set(auth('rev1'))
          .send({ decision: 'APPROVE' }),
        api()
          .post(`/api/ops/workflow-lab/runs/${run.id}/cancel`)
          .set(auth('admin')),
      ]);
      expect([a.status, c.status].filter((s) => s === 201)).toHaveLength(1);
      const final = await ctx.prisma.workflowRun.findUniqueOrThrow({
        where: { id: run.id },
        include: { steps: true },
      });
      if (a.status === 201) {
        expect(final.status).toBe('COMPLETED');
        expect(final.outcome).toBe('human_approved');
        expect(final.decidedByUserId).toBeTruthy();
        expect(final.steps.some((s) => s.nodeType === 'human_decision')).toBe(
          true,
        );
      } else {
        expect(final.status).toBe('CANCELLED');
        expect(final.outcome).toBe('cancelled');
        expect(final.decidedByUserId).toBeNull();
        expect(final.steps.some((s) => s.nodeType === 'human_decision')).toBe(
          false,
        );
      }
    }
  });

  it('concurrency: two reviewers approving at once -> exactly one success, one 409', async () => {
    const run = await seedSuspended();
    const [x, y] = await Promise.all([
      api()
        .post(`/api/ops/workflow-lab/runs/${run.id}/decision`)
        .set(auth('rev1'))
        .send({ decision: 'APPROVE' }),
      api()
        .post(`/api/ops/workflow-lab/runs/${run.id}/decision`)
        .set(auth('rev2'))
        .send({ decision: 'DENY' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    const steps = await ctx.prisma.workflowStepRun.count({
      where: { runId: run.id, nodeType: 'human_decision' },
    });
    expect(steps).toBe(1);
  });

  it('expired review windows can never be approved over HTTP', async () => {
    const run = await seedSuspended();
    await ctx.prisma.workflowRun.update({
      where: { id: run.id },
      data: { suspendedExpiresAt: new Date(Date.now() - 1000) },
    });
    await api()
      .post(`/api/ops/workflow-lab/runs/${run.id}/decision`)
      .set(auth('rev1'))
      .send({ decision: 'APPROVE' })
      .expect(409);
    const final = await ctx.prisma.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(final.status).toBe('CANCELLED');
    expect(final.outcome).toBe('expired');
  });

  it('idempotency over HTTP returns the same run', async () => {
    const key = `idem-${Date.now()}-abcdef`;
    const a = unwrap<{ id: string }>(
      (await startRun('admin', defId, key)).body,
    );
    const b = unwrap<{ id: string }>(
      (await startRun('admin', defId, key)).body,
    );
    expect(b.id).toBe(a.id);
  });

  it('read-only guarantee: no leads, escalations or vehicles are created by runs', async () => {
    const before = await Promise.all([
      ctx.prisma.lead.count(),
      ctx.prisma.escalation.count(),
      ctx.prisma.vehicle.count(),
    ]);
    await startRun('admin');
    const after = await Promise.all([
      ctx.prisma.lead.count(),
      ctx.prisma.escalation.count(),
      ctx.prisma.vehicle.count(),
    ]);
    expect(after).toEqual(before);
  });
});
