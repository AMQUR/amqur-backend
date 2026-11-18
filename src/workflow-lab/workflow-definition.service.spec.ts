import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { WorkflowDefinitionService } from './workflow-definition.service';
import type { PrismaService } from '../prisma/prisma.service';

const graph = {
  version: 1,
  nodes: [
    { id: 'start', type: 'start', next: 'end' },
    { id: 'end', type: 'end' },
  ],
};
const author = { tenantId: 't1', userId: 'author', boundLocationId: null };
const reviewer = { tenantId: 't1', userId: 'reviewer', boundLocationId: null };

function setup(def: Record<string, unknown> | null) {
  const tx = {
    workflowDefinition: {
      update: jest.fn().mockResolvedValue({ latestVersion: 3 }),
    },
    workflowVersion: {
      create: jest.fn().mockImplementation(async (a) => a.data),
    },
  };
  const prisma = {
    workflowDefinition: {
      findFirst: jest.fn().mockResolvedValue(def),
      update: jest
        .fn()
        .mockImplementation(async (a) => ({ ...def, ...a.data })),
      create: jest.fn().mockImplementation(async (a) => a.data),
      findMany: jest.fn().mockResolvedValue([]),
    },
    workflowVersion: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    location: { findFirst: jest.fn().mockResolvedValue({ id: 'loc' }) },
    $transaction: jest.fn().mockImplementation(async (fn) => fn(tx)),
  };
  return {
    svc: new WorkflowDefinitionService(prisma as unknown as PrismaService),
    prisma,
    tx,
  };
}

const inReview = {
  id: 'd1',
  tenantId: 't1',
  locationId: null,
  status: 'IN_REVIEW',
  draftGraph: graph,
  reviewRequestedByUserId: 'author',
};

describe('WorkflowDefinitionService', () => {
  it('scopes every load by tenant', async () => {
    const { svc, prisma } = setup(null);
    await expect(svc.get(author, 'd1')).rejects.toThrow(NotFoundException);
    expect(prisma.workflowDefinition.findFirst).toHaveBeenCalledWith({
      where: { id: 'd1', tenantId: 't1' },
    });
  });

  it('rejects invalid graphs on create', async () => {
    const { svc } = setup(null);
    await expect(
      svc.create(author, { name: 'x', graph: { version: 1, nodes: [] } }),
    ).rejects.toThrow(BadRequestException);
  });

  it('denies a rooftop that is not in the tenant, and cross-rooftop creation by a bound manager', async () => {
    const { svc, prisma } = setup(null);
    prisma.location.findFirst.mockResolvedValue(null);
    await expect(
      svc.create(author, { name: 'x', graph, locationId: 'other' }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      svc.create(
        { ...author, boundLocationId: 'a' },
        { name: 'x', graph, locationId: 'b' },
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('blocks a rooftop-bound manager from tenant-wide or other-rooftop workflows', async () => {
    const { svc } = setup({ ...inReview, locationId: 'b' });
    await expect(
      svc.get({ ...author, boundLocationId: 'a' }, 'd1'),
    ).rejects.toThrow(ForbiddenException);
    const tenantWide = setup({ ...inReview, locationId: null });
    await expect(
      tenantWide.svc.get({ ...author, boundLocationId: 'a' }, 'd1'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses self-approval and self-denial', async () => {
    const { svc, tx } = setup(inReview);
    await expect(svc.approveAndPublish(author, 'd1')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(svc.deny(author, 'd1')).rejects.toThrow(ForbiddenException);
    expect(tx.workflowVersion.create).not.toHaveBeenCalled();
  });

  it('publishes an immutable version when a different reviewer approves', async () => {
    const { svc, tx } = setup(inReview);
    const v = (await svc.approveAndPublish(reviewer, 'd1', 'ok')) as {
      version: number;
      publishedByUserId: string;
      requestedByUserId: string;
    };
    expect(v.version).toBe(3);
    expect(v.publishedByUserId).toBe('reviewer');
    expect(v.requestedByUserId).toBe('author');
    expect(tx.workflowVersion.create).toHaveBeenCalledTimes(1);
  });

  it('only publishes from IN_REVIEW (silence/draft is never approval)', async () => {
    const { svc, tx } = setup({ ...inReview, status: 'DRAFT' });
    await expect(svc.approveAndPublish(reviewer, 'd1')).rejects.toThrow(
      ConflictException,
    );
    expect(tx.workflowVersion.create).not.toHaveBeenCalled();
  });

  it('denial returns to DRAFT without publishing', async () => {
    const { svc, prisma, tx } = setup(inReview);
    await svc.deny(reviewer, 'd1');
    expect(prisma.workflowDefinition.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DRAFT' }),
      }),
    );
    expect(tx.workflowVersion.create).not.toHaveBeenCalled();
  });

  it('editing resets a pending review to DRAFT', async () => {
    const { svc, prisma } = setup(inReview);
    await svc.updateDraft(author, 'd1', { name: 'renamed' });
    expect(prisma.workflowDefinition.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DRAFT',
          reviewRequestedByUserId: null,
        }),
      }),
    );
  });

  it('rollback publishes a NEW version copying the old graph', async () => {
    const { svc, prisma, tx } = setup({ ...inReview, status: 'PUBLISHED' });
    prisma.workflowVersion.findFirst.mockResolvedValue({ version: 1, graph });
    const v = (await svc.rollback(author, 'd1', 1)) as {
      restoredFromVersion: number;
      version: number;
    };
    expect(v.restoredFromVersion).toBe(1);
    expect(v.version).toBe(3);
    expect(tx.workflowVersion.create).toHaveBeenCalledTimes(1);
    prisma.workflowVersion.findFirst.mockResolvedValue(null);
    await expect(svc.rollback(author, 'd1', 99)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('never exposes update/delete on versions', () => {
    const { svc } = setup(inReview);
    expect(
      Object.getOwnPropertyNames(WorkflowDefinitionService.prototype).filter(
        (n) => /deleteVersion|editVersion|updateVersion/.test(n),
      ),
    ).toEqual([]);
    expect(svc).toBeDefined();
  });
});
