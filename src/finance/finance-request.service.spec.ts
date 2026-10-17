import { NotFoundException } from '@nestjs/common';
import { FinanceRequestService } from './finance-request.service';

describe('FinanceRequestService.updateStaff', () => {
  const prisma = {
    financeRequest: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  let svc: FinanceRequestService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new FinanceRequestService(prisma as never);
    prisma.financeRequest.findFirst.mockResolvedValue({
      id: 'fr-1',
      tenantId: 'tenant-1',
      status: 'REQUESTED',
    });
    prisma.financeRequest.update.mockResolvedValue({
      id: 'fr-1',
      status: 'PENDING_STAFF',
      notes: 'Called customer',
    });
  });

  it('updates status and writes audit log', async () => {
    const row = await svc.updateStaff(
      'tenant-1',
      'loc-1',
      'fr-1',
      'user-1',
      { status: 'PENDING_STAFF' },
    );
    expect(row.status).toBe('PENDING_STAFF');
    expect(prisma.financeRequest.update).toHaveBeenCalledWith({
      where: { id: 'fr-1' },
      data: { status: 'PENDING_STAFF' },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'finance_request.update',
          resourceId: 'fr-1',
        }),
      }),
    );
  });

  it('throws when finance request is out of scope', async () => {
    prisma.financeRequest.findFirst.mockResolvedValue(null);
    await expect(
      svc.updateStaff('tenant-1', 'loc-1', 'fr-missing', 'user-1', {
        notes: 'x',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
