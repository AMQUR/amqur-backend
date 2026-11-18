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
 * HTTP-level suite for the workflow `tool_action` node: it may only PROPOSE into the approval
 * inbox, as the run starter, and never executes anything. Real JWT guards, real Postgres.
 */
const PASSWORD = 'TestPass123!';
const toolGraph = (
  tool = 'crm.note.add',
  fields: object = { leadId: 'lead-1', note: 'Follow up' },
) => ({
  version: 1,
  nodes: [
    { id: 'start', type: 'start', next: 'tool' },
    { id: 'tool', type: 'tool_action', tool, fields, next: 'done' },
    { id: 'done', type: 'end' },
  ],
});
type Run = {
  id: string;
  status: string;
  outcome: string;
  steps: Array<{
    nodeId: string;
    status: string;
    output?: { actionId?: string; reason?: string };
  }>;
};

describe('Workflow tool_action node HTTP behaviour', () => {
  let ctx: E2eCtx;
  const tok: Record<string, string> = {};
  let alphaId = '';
  let alphaLocId = '';
  let defId = '';

  const api = () => request(ctx.app.getHttpServer());
  const auth = (who: string) => ({ Authorization: `Bearer ${tok[who]}` });

  async function login(email: string): Promise<string> {
    const r = await api()
      .post('/api/auth/login')
      .send({ email, password: PASSWORD });
    const b = unwrap<{ access_token?: string; accessToken?: string }>(r.body);
    return b.access_token || b.accessToken || '';
  }
  async function mkUser(locationId: string | null, email: string, role: Role) {
    const password = await bcrypt.hash(PASSWORD, 10);
    await ctx.prisma.user.upsert({
      where: { tenantId_email: { tenantId: alphaId, email } },
      create: {
        tenantId: alphaId,
        locationId,
        email,
        password,
        firstName: 'T',
        lastName: 'N',
        role,
      },
      update: { password, role, locationId },
    });
  }
  const startRun = (who: string, key?: string) =>
    api()
      .post('/api/ops/workflow-lab/runs')
      .set(auth(who))
      .send({
        definitionId: defId,
        query: 'hello',
        ...(key ? { idempotencyKey: key } : {}),
      });

  beforeAll(async () => {
    ctx = await createE2eApp();
    const seed = await seedTwoTenants(ctx.prisma);
    alphaId =
      seed.alpha.tenant?.id ??
      (
        await ctx.prisma.tenant.findUniqueOrThrow({
          where: { slug: 'pilot-alpha' },
        })
      ).id;
    await ctx.prisma.workflowRun.deleteMany({ where: { tenantId: alphaId } });
    await ctx.prisma.toolActionRequest.deleteMany({
      where: { tenantId: alphaId },
    });
    alphaLocId = (
      await ctx.prisma.location.findFirstOrThrow({
        where: { tenantId: alphaId, slug: 'main' },
      })
    ).id;
    await mkUser(alphaLocId, 'wtn-mgr@pilot-alpha.test', Role.MANAGER);
    await mkUser(null, 'wtn-rev@pilot-alpha.test', Role.ADMIN);
    tok.mgr = await login('wtn-mgr@pilot-alpha.test');
    tok.rev = await login('wtn-rev@pilot-alpha.test');
    tok.beta = await login('admin@pilot-beta.test');

    const created = await api()
      .post('/api/ops/workflow-lab/definitions')
      .set(auth('mgr'))
      .send({ name: 'tool node wf', graph: toolGraph() })
      .expect(201);
    defId = unwrap<{ id: string }>(created.body).id;
    await api()
      .post(`/api/ops/workflow-lab/definitions/${defId}/request-review`)
      .set(auth('mgr'))
      .expect(201);
    const got = await api()
      .get(`/api/ops/workflow-lab/definitions/${defId}`)
      .set(auth('rev'))
      .expect(200);
    await api()
      .post(`/api/ops/workflow-lab/definitions/${defId}/approve`)
      .set(auth('rev'))
      .send({
        reviewedChecksum: unwrap<{ draftChecksum: string }>(got.body)
          .draftChecksum,
      })
      .expect(201);
  }, 120_000);

  afterAll(async () => {
    delete process.env.TOOL_REGISTRY_ENABLED;
    delete process.env.TOOL_DISPATCH_ENABLED;
    if (ctx?.app) await ctx.app.close();
  });

  it('rejects workflows that use unknown or consent-required tools at authoring time', async () => {
    for (const bad of [
      toolGraph('shell.exec'),
      toolGraph('message.send', { leadId: 'l', channel: 'SMS', body: 'hi' }),
      toolGraph('crm.note.add', { leadId: 'l' }),
    ]) {
      await api()
        .post('/api/ops/workflow-lab/definitions')
        .set(auth('mgr'))
        .send({ name: 'bad', graph: bad })
        .expect(400);
    }
  });

  it('registry OFF: run completes, node is skipped, and no action exists', async () => {
    delete process.env.TOOL_REGISTRY_ENABLED;
    const r = unwrap<Run>((await startRun('mgr').expect(201)).body);
    expect(r.status).toBe('COMPLETED');
    const step = r.steps.find((s) => s.nodeId === 'tool')!;
    expect(step.status).toBe('skipped');
    expect(step.output?.reason).toBe('tool_registry_disabled');
    expect(
      await ctx.prisma.toolActionRequest.count({
        where: { tenantId: alphaId },
      }),
    ).toBe(0);
  });

  it('registry ON: run proposes one pending action as the starter, scoped to tenant and rooftop, and executes nothing', async () => {
    process.env.TOOL_REGISTRY_ENABLED = 'true';
    delete process.env.TOOL_DISPATCH_ENABLED;
    const r = unwrap<Run>(
      (await startRun('mgr', 'wtn-key-0001').expect(201)).body,
    );
    expect(r.status).toBe('COMPLETED');
    const actionId = r.steps.find((s) => s.nodeId === 'tool')!.output!
      .actionId!;
    const mgr = await ctx.prisma.user.findFirstOrThrow({
      where: { email: 'wtn-mgr@pilot-alpha.test' },
    });
    const row = await ctx.prisma.toolActionRequest.findUniqueOrThrow({
      where: { id: actionId },
    });
    expect(row).toMatchObject({
      tenantId: alphaId,
      locationId: alphaLocId,
      toolName: 'crm.note.add',
      status: 'PENDING_APPROVAL',
      requestedByUserId: mgr.id,
      outboxEventId: null,
    });
    // Idempotent run replay does not create a second action.
    await startRun('mgr', 'wtn-key-0001').expect(201);
    expect(
      await ctx.prisma.toolActionRequest.count({
        where: { tenantId: alphaId },
      }),
    ).toBe(1);
    // Other tenant cannot see it.
    const beta = unwrap<unknown[]>(
      (await api().get('/api/ops/tools/actions').set(auth('beta')).expect(200))
        .body,
    );
    expect(JSON.stringify(beta)).not.toContain(actionId);
  });

  it('separation of duties still holds: the starter cannot approve; an independent reviewer can, and dispatch stays off', async () => {
    const row = await ctx.prisma.toolActionRequest.findFirstOrThrow({
      where: { tenantId: alphaId },
    });
    const decide = (who: string) =>
      api()
        .post(`/api/ops/tools/actions/${row.id}/decision`)
        .set(auth(who))
        .send({ decision: 'APPROVE', reviewedChecksum: row.checksum });
    expect((await decide('mgr')).status).toBe(403);
    expect((await decide('rev')).status).toBe(201);
    const after = await ctx.prisma.toolActionRequest.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.status).toBe('APPROVED');
    expect(after.outboxEventId).toBeNull();
  });
});
