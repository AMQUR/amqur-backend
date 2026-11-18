import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { redactQuery, WorkflowRunService } from './workflow-run.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { KnowledgeRetrievalService } from '../knowledge/knowledge-retrieval.service';

const reviewGraph = {
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
    { id: 'rev', type: 'human_review', reason: 'ask a specialist' },
  ],
};
const starter = { tenantId: 't1', userId: 'starter', boundLocationId: null };
const other = { tenantId: 't1', userId: 'reviewer', boundLocationId: null };
const def = {
  id: 'd1',
  tenantId: 't1',
  locationId: 'loc-a',
  status: 'PUBLISHED',
  archivedAt: null,
};

function setup(
  opts: {
    results?: unknown[];
    graph?: unknown;
    run?: Record<string, unknown> | null;
  } = {},
) {
  const search = jest.fn().mockResolvedValue(opts.results ?? []);
  const prisma = {
    workflowDefinition: { findFirst: jest.fn().mockResolvedValue(def) },
    workflowVersion: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ version: 2, graph: opts.graph ?? reviewGraph }),
    },
    workflowRun: {
      findFirst: jest.fn().mockResolvedValue(opts.run ?? null),
      count: jest.fn().mockResolvedValue(0),
      create: jest
        .fn()
        .mockImplementation(async (a) => ({ id: 'r1', ...a.data })),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    workflowStepRun: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma),
  );
  const svc = new WorkflowRunService(
    prisma as unknown as PrismaService,
    { search } as unknown as KnowledgeRetrievalService,
  );
  return { svc, prisma, search };
}

describe('redactQuery', () => {
  it('masks emails, phones, VINs and long digit runs', () => {
    const out = redactQuery(
      'mail a@b.com call +1 (555) 123-4567 vin 1HGCM82633A004352 acct 12345678',
    );
    expect(out).not.toMatch(/a@b\.com|555|1HGCM|12345678/);
    expect(out).toContain('[email]');
    expect(out).toContain('[vin]');
  });
});

describe('WorkflowRunService.start', () => {
  it('runs only published versions, scoped to tenant/rooftop, and stores only a redacted query', async () => {
    const { svc, prisma, search } = setup({
      results: [
        { documentId: 'x', title: 'T', score: 0.9, content: 'SECRET BODY' },
      ],
    });
    prisma.workflowRun.findFirst.mockResolvedValue({
      id: 'r1',
      steps: [],
      locationId: 'loc-a',
      status: 'RUNNING',
    });
    await svc.start(starter, {
      definitionId: 'd1',
      query: 'warranty for jane@x.com',
    });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        locationId: 'loc-a',
        forWidget: true,
      }),
    );
    const created = prisma.workflowRun.create.mock.calls[0][0].data;
    expect(created.queryRedacted).toBe('warranty for [email]');
    expect(created.mode ?? 'SIMULATION').toBe('SIMULATION');
    expect(
      JSON.stringify(prisma.workflowStepRun.create.mock.calls),
    ).not.toContain('SECRET BODY');
    expect(prisma.workflowVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { definitionId: 'd1', tenantId: 't1' },
      }),
    );
  });

  it('suspends at human_review when no verified sources, and does not complete', async () => {
    const { svc, prisma } = setup({ results: [] });
    prisma.workflowRun.findFirst.mockResolvedValue({
      id: 'r1',
      steps: [],
      locationId: 'loc-a',
      status: 'RUNNING',
    });
    await svc.start(starter, { definitionId: 'd1', query: 'unknown topic' });
    const finalUpdate = prisma.workflowRun.updateMany.mock.calls.at(-1)[0].data;
    expect(finalUpdate.status).toBe('SUSPENDED');
    expect(finalUpdate.outcome).toBe('blocked_pending_review');
    expect(finalUpdate.suspendedExpiresAt).toBeInstanceOf(Date);
  });

  it('marks the run FAILED (not completed) when knowledge search throws', async () => {
    const { svc, prisma, search } = setup();
    search.mockRejectedValue(new Error('db down'));
    prisma.workflowRun.findFirst.mockResolvedValue({
      id: 'r1',
      steps: [],
      locationId: 'loc-a',
      status: 'RUNNING',
    });
    await svc.start(starter, { definitionId: 'd1', query: 'x' });
    expect(prisma.workflowRun.updateMany.mock.calls.at(-1)[0].data).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        failureReason: 'step_error',
      }),
    );
  });

  it('is idempotent: an existing run for the key is returned without a new run or search', async () => {
    const { svc, prisma, search } = setup({ run: { id: 'old', steps: [] } });
    const r = await svc.start(starter, {
      definitionId: 'd1',
      query: 'x',
      idempotencyKey: 'key-12345',
    });
    expect(r).toEqual({ id: 'old', steps: [] });
    expect(prisma.workflowRun.create).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('enforces quota, query bounds, unpublished and rooftop rules', async () => {
    const q = setup();
    q.prisma.workflowRun.count.mockResolvedValue(60);
    await expect(
      q.svc.start(starter, { definitionId: 'd1', query: 'x' }),
    ).rejects.toThrow(HttpException);
    const bounds = setup();
    await expect(
      bounds.svc.start(starter, { definitionId: 'd1', query: ' ' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      bounds.svc.start(starter, { definitionId: 'd1', query: 'x'.repeat(301) }),
    ).rejects.toThrow(BadRequestException);
    const none = setup();
    none.prisma.workflowVersion.findFirst.mockResolvedValue(null);
    await expect(
      none.svc.start(starter, { definitionId: 'd1', query: 'x' }),
    ).rejects.toThrow(ConflictException);
    const wrongRooftop = setup();
    await expect(
      wrongRooftop.svc.start(
        { ...starter, boundLocationId: 'loc-b' },
        { definitionId: 'd1', query: 'x' },
      ),
    ).rejects.toThrow(ForbiddenException);
    const missing = setup();
    missing.prisma.workflowDefinition.findFirst.mockResolvedValue(null);
    await expect(
      missing.svc.start(starter, { definitionId: 'zz', query: 'x' }),
    ).rejects.toThrow(NotFoundException);
    expect(missing.prisma.workflowDefinition.findFirst).toHaveBeenCalledWith({
      where: { id: 'zz', tenantId: 't1' },
    });
  });
});

const suspended = {
  id: 'r1',
  tenantId: 't1',
  locationId: 'loc-a',
  status: 'SUSPENDED',
  startedByUserId: 'starter',
  currentNodeId: 'rev',
  steps: [{}, {}],
  suspendedExpiresAt: new Date(Date.now() + 3_600_000),
};

describe('WorkflowRunService execution state machine', () => {
  const running = {
    id: 'r1',
    steps: [],
    locationId: 'loc-a',
    status: 'RUNNING',
  };

  it('refuses to run an archived workflow', async () => {
    const { svc, prisma } = setup();
    prisma.workflowDefinition.findFirst.mockResolvedValue({
      ...def,
      status: 'ARCHIVED',
    });
    await expect(
      svc.start(starter, { definitionId: 'd1', query: 'x' }),
    ).rejects.toThrow(ConflictException);
    const soft = setup();
    soft.prisma.workflowDefinition.findFirst.mockResolvedValue({
      ...def,
      archivedAt: new Date(),
    });
    await expect(
      soft.svc.start(starter, { definitionId: 'd1', query: 'x' }),
    ).rejects.toThrow(ConflictException);
    expect(prisma.workflowRun.create).not.toHaveBeenCalled();
  });

  it('every execute() transition is conditional on the run still being RUNNING', async () => {
    const { svc, prisma } = setup({ results: [] });
    prisma.workflowRun.findFirst.mockResolvedValue(running);
    await svc.start(starter, { definitionId: 'd1', query: 'x' });
    expect(prisma.workflowRun.update).not.toHaveBeenCalled();
    for (const call of prisma.workflowRun.updateMany.mock.calls)
      expect(call[0].where).toEqual({
        id: 'r1',
        tenantId: 't1',
        status: 'RUNNING',
      });
  });

  it('stops without recording steps or transitions if the run was cancelled mid-flight', async () => {
    const { svc, prisma } = setup();
    prisma.workflowRun.findFirst.mockResolvedValue({
      ...running,
      status: 'CANCELLED',
    });
    await svc.start(starter, { definitionId: 'd1', query: 'x' });
    expect(prisma.workflowStepRun.create).not.toHaveBeenCalled();
    expect(prisma.workflowRun.updateMany).not.toHaveBeenCalled();
  });

  it('a cancel landing before the final transition is not overwritten', async () => {
    const { svc, prisma } = setup({ results: [] });
    prisma.workflowRun.findFirst.mockResolvedValue(running);
    prisma.workflowRun.updateMany.mockResolvedValue({ count: 0 });
    await svc.start(starter, { definitionId: 'd1', query: 'x' });
    expect(prisma.workflowRun.update).not.toHaveBeenCalled();
    expect(prisma.workflowRun.updateMany).toHaveBeenCalled();
  });
});

describe('WorkflowRunService.decide', () => {
  it('refuses the starter, non-suspended runs and wrong rooftops', async () => {
    const a = setup({ run: suspended });
    await expect(a.svc.decide(starter, 'r1', 'APPROVE')).rejects.toThrow(
      ForbiddenException,
    );
    const b = setup({ run: { ...suspended, status: 'COMPLETED' } });
    await expect(b.svc.decide(other, 'r1', 'APPROVE')).rejects.toThrow(
      ConflictException,
    );
    const c = setup({ run: suspended });
    await expect(
      c.svc.decide({ ...other, boundLocationId: 'loc-b' }, 'r1', 'APPROVE'),
    ).rejects.toThrow(ForbiddenException);
    expect(a.prisma.workflowRun.updateMany).not.toHaveBeenCalled();
  });

  it('approval and denial are recorded by an independent reviewer via a conditional claim', async () => {
    const ok = setup({ run: suspended });
    await ok.svc.decide(other, 'r1', 'APPROVE');
    expect(ok.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(ok.prisma.workflowRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'r1',
          tenantId: 't1',
          status: 'SUSPENDED',
          suspendedExpiresAt: { gt: expect.any(Date) },
        },
        data: expect.objectContaining({
          outcome: 'human_approved',
          decidedByUserId: 'reviewer',
        }),
      }),
    );
    const no = setup({ run: suspended });
    await no.svc.decide(other, 'r1', 'DENY');
    expect(no.prisma.workflowRun.updateMany.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ status: 'CANCELLED', outcome: 'human_denied' }),
    );
  });

  it('expiry is never approval', async () => {
    const { svc, prisma } = setup({
      run: { ...suspended, suspendedExpiresAt: new Date(Date.now() - 1000) },
    });
    await expect(svc.decide(other, 'r1', 'APPROVE')).rejects.toThrow(
      ConflictException,
    );
    expect(prisma.workflowRun.updateMany.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ status: 'CANCELLED', outcome: 'expired' }),
    );
  });

  it('rejects a missing deadline and expires the suspended run safely', async () => {
    const { svc, prisma } = setup({
      run: { ...suspended, suspendedExpiresAt: null },
    });
    await expect(svc.decide(other, 'r1', 'APPROVE')).rejects.toThrow(
      ConflictException,
    );
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 't1',
          status: 'SUSPENDED',
          OR: [
            { suspendedExpiresAt: null },
            { suspendedExpiresAt: { lte: expect.any(Date) } },
          ],
        }),
        data: { status: 'CANCELLED', outcome: 'expired' },
      }),
    );
  });

  it('a lost race (count 0) is a conflict, not a silent success', async () => {
    const { svc, prisma } = setup({ run: suspended });
    prisma.workflowRun.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.decide(other, 'r1', 'APPROVE')).rejects.toThrow(
      ConflictException,
    );
    expect(prisma.workflowStepRun.create).not.toHaveBeenCalled();
  });
});

describe('WorkflowRunService.cancel/get/list', () => {
  it('scopes by tenant and rooftop and only cancels active runs', async () => {
    const { svc, prisma } = setup({ run: suspended });
    await svc.cancel(starter, 'r1');
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 't1',
          status: { in: ['RUNNING', 'SUSPENDED'] },
        }),
      }),
    );
    prisma.workflowRun.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.cancel(starter, 'r1')).rejects.toThrow(ConflictException);
    await svc.list({ ...starter, boundLocationId: 'loc-a' });
    expect(prisma.workflowRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 't1', locationId: 'loc-a' },
      }),
    );
  });
});
