import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EscalationsService } from './escalations.service';

describe('EscalationsService handoff queue', () => {
  const prisma: any = {
    conversation: { findUnique: jest.fn() },
    escalation: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (fn: (tx: typeof prisma) => unknown) => fn(prisma)),
  };

  const outbox = {
    enqueue: jest.fn().mockResolvedValue({ id: 'outbox-1' }),
  };

  let svc: EscalationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CRM_WEBHOOK_URL;
    svc = new EscalationsService(prisma, outbox as never);
  });

  it('appends a customer report onto the open escalation without a second notify', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ id: 'conv1' });
    prisma.escalation.findFirst.mockResolvedValue({
      id: 'esc-existing',
      notifiedAt: null,
      status: 'OPEN',
      urgency: 'HIGH',
      reason: 'Customer reported a complaint (unverified)',
      summary: '[customer-reported, unverified] dissatisfaction — "mean"',
      metadata: { timeline: [] },
    });
    prisma.escalation.update.mockResolvedValue({
      id: 'esc-existing',
      urgency: 'CRITICAL',
      summary: 'updated',
    });
    const result = await svc.appendCustomerReport({
      tenantId: 't1',
      locationId: 'loc1',
      externalKey: 'ext-1',
      reason: 'Customer reported immediate danger (unverified)',
      urgency: 'CRITICAL' as never,
      line: '[customer-reported, unverified] danger — "they tried to hit me"',
      metadata: { reportedNames: ['Steve'] },
    });
    expect(result.deduped).toBe(true);
    expect(result.notified).toBe(false);
    expect(result.channelConfigured).toBe(false);
    expect(prisma.escalation.create).not.toHaveBeenCalled();
    expect(prisma.escalation.update).toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'escalation.append' }),
      }),
    );
  });

  it('parallel handoff requests create only one open escalation', async () => {
    const OPEN = ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] as const;
    const store: Array<{
      id: string;
      conversationId: string;
      status: string;
      notifiedAt: null;
      urgency: string;
    }> = [];
    let seq = 0;
    let chain = Promise.resolve();

    prisma.conversation.findUnique.mockResolvedValue({ id: 'conv1' });
    prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => {
      chain = chain.then(() => fn(prisma));
      return chain;
    });
    prisma.escalation.findFirst.mockImplementation(
      async ({ where }: { where: { conversationId?: string; status?: { in: string[] } } }) => {
        const statuses = where.status?.in ?? [...OPEN];
        return (
          store.find(
            (e) =>
              e.conversationId === where.conversationId &&
              statuses.includes(e.status),
          ) ?? null
        );
      },
    );
    prisma.escalation.create.mockImplementation(
      async ({ data }: { data: { conversationId: string } }) => {
        const esc = {
          id: `esc-${++seq}`,
          conversationId: data.conversationId,
          status: 'OPEN',
          notifiedAt: null,
          urgency: 'NORMAL',
        };
        store.push(esc);
        return esc;
      },
    );

    const params = {
      tenantId: 't1',
      locationId: 'loc1',
      externalKey: 'ext-1',
      reason: 'staff_handoff',
    };
    const [first, second] = await Promise.all([
      svc.create(params),
      svc.create(params),
    ]);

    expect(store).toHaveLength(1);
    expect(prisma.escalation.create).toHaveBeenCalledTimes(1);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.escalation.id).toBe(first.escalation.id);
  });

  it('dedupes open handoff for same conversation', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ id: 'conv1' });
    prisma.escalation.findFirst.mockResolvedValue({
      id: 'esc-existing',
      notifiedAt: null,
      status: 'OPEN',
    });
    const result = await svc.create({
      tenantId: 't1',
      locationId: 'loc1',
      externalKey: 'ext-1',
      reason: 'test',
    });
    expect(result.deduped).toBe(true);
    expect(prisma.escalation.create).not.toHaveBeenCalled();
  });

  it('creates escalation when no open duplicate', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ id: 'conv1' });
    prisma.escalation.findFirst.mockResolvedValue(null);
    prisma.escalation.create.mockResolvedValue({
      id: 'esc-new',
      urgency: 'NORMAL',
      notifiedAt: null,
    });
    const result = await svc.create({
      tenantId: 't1',
      locationId: 'loc1',
      externalKey: 'ext-1',
      reason: 'need_human',
      summary: 'synthetic',
    });
    expect(result.deduped).toBe(false);
    expect(result.escalation.id).toBe('esc-new');
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('acknowledge transitions to ACKNOWLEDGED with audit', async () => {
    prisma.escalation.findFirst.mockResolvedValue({
      id: 'esc1',
      tenantId: 't1',
      status: 'OPEN',
      metadata: {},
    });
    prisma.escalation.update.mockResolvedValue({
      id: 'esc1',
      status: 'ACKNOWLEDGED',
    });
    const updated = await svc.acknowledge({
      tenantId: 't1',
      escalationId: 'esc1',
      actorUserId: 'user1',
    });
    expect(updated.status).toBe('ACKNOWLEDGED');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'escalation.acknowledge' }),
      }),
    );
  });

  it('claim transitions to IN_PROGRESS with audit', async () => {
    prisma.escalation.findFirst.mockResolvedValue({
      id: 'esc1',
      tenantId: 't1',
      status: 'OPEN',
      metadata: {},
    });
    prisma.escalation.update.mockResolvedValue({
      id: 'esc1',
      status: 'IN_PROGRESS',
    });
    const updated = await svc.claim({
      tenantId: 't1',
      escalationId: 'esc1',
      actorUserId: 'user1',
    });
    expect(updated.status).toBe('IN_PROGRESS');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'escalation.claim' }),
      }),
    );
  });

  it('resolve closes escalation', async () => {
    prisma.escalation.findFirst.mockResolvedValue({
      id: 'esc1',
      tenantId: 't1',
      status: 'IN_PROGRESS',
      metadata: {},
    });
    prisma.escalation.update.mockResolvedValue({
      id: 'esc1',
      status: 'RESOLVED',
    });
    const updated = await svc.resolve({
      tenantId: 't1',
      escalationId: 'esc1',
      actorUserId: 'user1',
      note: 'done',
    });
    expect(updated.status).toBe('RESOLVED');
  });

  it('rejects cross-tenant escalation access', async () => {
    prisma.escalation.findFirst.mockResolvedValue(null);
    await expect(
      svc.acknowledge({
        tenantId: 'other',
        escalationId: 'esc1',
        actorUserId: 'user1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects claim on resolved escalation', async () => {
    prisma.escalation.findFirst.mockResolvedValue({
      id: 'esc1',
      tenantId: 't1',
      status: 'RESOLVED',
      metadata: {},
    });
    await expect(
      svc.claim({
        tenantId: 't1',
        escalationId: 'esc1',
        actorUserId: 'user1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
