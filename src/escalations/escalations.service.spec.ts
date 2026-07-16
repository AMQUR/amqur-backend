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
