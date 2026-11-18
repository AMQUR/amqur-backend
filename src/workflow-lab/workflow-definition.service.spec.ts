import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { WorkflowDefinitionService } from './workflow-definition.service';
import type { PrismaService } from '../prisma/prisma.service';

const graph = {
  version: 1,
  nodes: [
    { id: 'start', type: 'start', next: 'end' },
    { id: 'end', type: 'end' },
  ],
};
const sum = (g: unknown) =>
  createHash('sha256').update(JSON.stringify(g)).digest('hex');
const author = { tenantId: 't1', userId: 'author', boundLocationId: null };
const reviewer = { tenantId: 't1', userId: 'reviewer', boundLocationId: null };

function setup(def: Record<string, unknown> | null) {
  const tx = {
    workflowDefinition: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ latestVersion: 3 }),
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
  createdByUserId: 'author',
  lastEditedByUserId: 'author',
  draftContributorUserIds: ['author'],
  pendingRestoreFromVersion: null,
  updatedAt: new Date(0),
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

  it('refuses self-approval, self-denial and approval by the last editor', async () => {
    const { svc, tx } = setup(inReview);
    const c = sum(graph);
    await expect(svc.approveAndPublish(author, 'd1', c)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(svc.deny(author, 'd1')).rejects.toThrow(ForbiddenException);
    const edited = setup({ ...inReview, lastEditedByUserId: 'reviewer' });
    await expect(
      edited.svc.approveAndPublish(reviewer, 'd1', c),
    ).rejects.toThrow(ForbiddenException);
    await expect(edited.svc.deny(reviewer, 'd1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(tx.workflowVersion.create).not.toHaveBeenCalled();
  });

  it('blocks anyone who contributed to the draft since the last publish, not just the last editor', async () => {
    const c = sum(graph);
    const multi = setup({
      ...inReview,
      lastEditedByUserId: 'late-editor',
      draftContributorUserIds: ['author', 'early-editor', 'late-editor'],
    });
    const early = {
      tenantId: 't1',
      userId: 'early-editor',
      boundLocationId: null,
    };
    await expect(multi.svc.approveAndPublish(early, 'd1', c)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(multi.svc.deny(early, 'd1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(multi.tx.workflowVersion.create).not.toHaveBeenCalled();
  });

  it('fails closed on unknown history: the creator is still blocked when contributors are empty', async () => {
    const legacy = setup({
      ...inReview,
      createdByUserId: 'creator',
      reviewRequestedByUserId: 'someone',
      lastEditedByUserId: null,
      draftContributorUserIds: [],
    });
    const creator = {
      tenantId: 't1',
      userId: 'creator',
      boundLocationId: null,
    };
    await expect(
      legacy.svc.approveAndPublish(creator, 'd1', sum(graph)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('atomically appends each editor as a contributor and clears contributors on publish', async () => {
    const { svc, prisma, tx } = setup({
      ...inReview,
      draftContributorUserIds: ['author'],
    });
    const e2 = { tenantId: 't1', userId: 'e2', boundLocationId: null };
    await svc.updateDraft(e2, 'd1', { name: 'n' });
    expect(prisma.workflowDefinition.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          draftContributorUserIds: { push: 'e2' },
        }),
      }),
    );
    await setup(inReview).svc.approveAndPublish(reviewer, 'd1', sum(graph));
    const t = setup(inReview);
    await t.svc.approveAndPublish(reviewer, 'd1', sum(graph));
    expect(t.tx.workflowDefinition.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ draftContributorUserIds: [] }),
      }),
    );
    expect(tx.workflowVersion.create).not.toHaveBeenCalled();
  });

  it('publishes an immutable version when an independent reviewer approves the exact draft', async () => {
    const { svc, tx } = setup(inReview);
    const v = (await svc.approveAndPublish(
      reviewer,
      'd1',
      sum(graph),
      'ok',
    )) as unknown as {
      version: number;
      publishedByUserId: string;
      requestedByUserId: string;
    };
    expect(v.version).toBe(3);
    expect(v.publishedByUserId).toBe('reviewer');
    expect(v.requestedByUserId).toBe('author');
    expect(tx.workflowVersion.create).toHaveBeenCalledTimes(1);
  });

  it('rejects approval of a draft that differs from what the reviewer saw', async () => {
    const { svc, tx } = setup(inReview);
    await expect(
      svc.approveAndPublish(reviewer, 'd1', sum({ other: 1 })),
    ).rejects.toThrow(ConflictException);
    expect(tx.workflowVersion.create).not.toHaveBeenCalled();
  });

  it('rejects when the draft changes between read and publish (conditional claim)', async () => {
    const { svc, tx } = setup(inReview);
    tx.workflowDefinition.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      svc.approveAndPublish(reviewer, 'd1', sum(graph)),
    ).rejects.toThrow(ConflictException);
    expect(tx.workflowVersion.create).not.toHaveBeenCalled();
    expect(tx.workflowDefinition.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'IN_REVIEW',
          updatedAt: new Date(0),
          tenantId: 't1',
        }),
      }),
    );
  });

  it('only publishes from IN_REVIEW (silence/draft is never approval)', async () => {
    const { svc, tx } = setup({ ...inReview, status: 'DRAFT' });
    await expect(
      svc.approveAndPublish(reviewer, 'd1', sum(graph)),
    ).rejects.toThrow(ConflictException);
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

  it('editing resets review and records the editor', async () => {
    const { svc, prisma } = setup(inReview);
    await svc.updateDraft(author, 'd1', { name: 'renamed' });
    expect(prisma.workflowDefinition.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DRAFT',
          reviewRequestedByUserId: null,
          lastEditedByUserId: 'author',
        }),
      }),
    );
  });

  it('rollback only opens a review request; it never publishes directly', async () => {
    const { svc, prisma, tx } = setup({ ...inReview, status: 'PUBLISHED' });
    prisma.workflowVersion.findFirst.mockResolvedValue({ version: 1, graph });
    await svc.rollback(author, 'd1', 1);
    expect(tx.workflowVersion.create).not.toHaveBeenCalled();
    expect(prisma.workflowDefinition.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'IN_REVIEW',
          pendingRestoreFromVersion: 1,
          reviewRequestedByUserId: 'author',
        }),
      }),
    );
    prisma.workflowVersion.findFirst.mockResolvedValue(null);
    await expect(svc.rollback(author, 'd1', 99)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('approved rollback publishes a new version tagged with the restored version', async () => {
    const { svc, tx } = setup({ ...inReview, pendingRestoreFromVersion: 1 });
    const v = (await svc.approveAndPublish(
      reviewer,
      'd1',
      sum(graph),
    )) as unknown as {
      restoredFromVersion: number;
    };
    expect(v.restoredFromVersion).toBe(1);
    expect(tx.workflowVersion.create).toHaveBeenCalledTimes(1);
  });

  it('refuses rollback of archived workflows', async () => {
    const { svc } = setup({ ...inReview, status: 'ARCHIVED' });
    await expect(svc.rollback(author, 'd1', 1)).rejects.toThrow(
      ConflictException,
    );
  });

  it('never exposes update/delete on versions', () => {
    expect(
      Object.getOwnPropertyNames(WorkflowDefinitionService.prototype).filter(
        (n) => /deleteVersion|editVersion|updateVersion/.test(n),
      ),
    ).toEqual([]);
  });
});
