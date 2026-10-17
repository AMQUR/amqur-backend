import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LeadsService } from './leads.service';

describe('LeadsService.assignManual', () => {
  const prisma = {
    lead: {
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
    conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    user: { findFirst: jest.fn() },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const flags = {} as never;

  let svc: LeadsService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new LeadsService(prisma as never, flags);
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      locationId: 'loc-1',
      assignedUserId: null,
      conversationId: 'conv-1',
    });
    prisma.user.findFirst.mockResolvedValue({ id: 'staff-1' });
    prisma.lead.update.mockImplementation(({ where, data }) =>
      Promise.resolve({
        id: where.id,
        assignedUserId: data.assignedUserId,
        location: null,
        conversation: null,
      }),
    );
  });

  it('rejects unknown lead', async () => {
    prisma.lead.findFirst.mockResolvedValue(null);
    await expect(
      svc.assignManual('tenant-1', 'loc-1', 'missing', 'actor-1', 'staff-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects assignee outside rooftop scope', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(
      svc.assignManual('tenant-1', null, 'lead-1', 'actor-1', 'staff-9'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  it('assigns and writes audit log', async () => {
    await svc.assignManual('tenant-1', null, 'lead-1', 'actor-1', 'staff-1');
    expect(prisma.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { assignedUserId: 'staff-1' },
      }),
    );
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { assignedUserId: 'staff-1' },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'lead.assign',
        resourceId: 'lead-1',
        metadata: expect.objectContaining({
          fromUserId: null,
          toUserId: 'staff-1',
        }),
      }),
    });
  });

  it('skips update and audit when assignee unchanged', async () => {
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      locationId: 'loc-1',
      assignedUserId: 'staff-1',
      conversationId: null,
    });
    prisma.lead.findUniqueOrThrow.mockResolvedValue({
      id: 'lead-1',
      assignedUserId: 'staff-1',
    });
    const row = await svc.assignManual(
      'tenant-1',
      null,
      'lead-1',
      'actor-1',
      'staff-1',
    );
    expect(row.assignedUserId).toBe('staff-1');
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('allows unassign with null', async () => {
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      locationId: 'loc-1',
      assignedUserId: 'staff-1',
      conversationId: null,
    });
    await svc.assignManual('tenant-1', null, 'lead-1', 'actor-1', null);
    expect(prisma.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { assignedUserId: null },
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({ toUserId: null }),
      }),
    });
  });
});
