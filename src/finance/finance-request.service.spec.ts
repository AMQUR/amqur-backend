import { NotFoundException } from '@nestjs/common';
import { FinanceRequestService } from './finance-request.service';

describe('FinanceRequestService.notifyFinanceAdvisor (via upsertForConversation)', () => {
  const prisma = {
    financeRequest: {
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    escalation: {
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'esc-1' }),
    },
    analyticsEvent: {
      create: jest.fn().mockResolvedValue({}),
    },
  };

  const svc = new FinanceRequestService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.escalation.findFirst.mockResolvedValue(null);
    prisma.analyticsEvent.create.mockResolvedValue({});
  });

  it('queues FINANCE_ADVISOR escalation on new finance request', async () => {
    prisma.financeRequest.findUnique.mockResolvedValue(null);
    prisma.financeRequest.create.mockResolvedValue({
      id: 'fr-new',
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      conversationId: 'conv-1',
      vehicleVin: 'DEMOGW25S2OOOOO01',
      handoffState: 'NONE',
      aprProvided: null,
    });

    await svc.upsertForConversation({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      conversationId: 'conv-1',
      vehicleVin: 'DEMOGW25S2OOOOO01',
    });

    expect(prisma.escalation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        reason: 'FINANCE_ADVISOR',
        metadata: expect.objectContaining({
          financeRequestId: 'fr-new',
          aprProvided: false,
        }),
      }),
    });
    expect(prisma.analyticsEvent.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        locationId: 'loc-1',
        eventType: 'finance.advisor_queued',
        properties: { financeRequestId: 'fr-new' },
      },
    });
  });

  it('does not duplicate FINANCE_ADVISOR when one is already open', async () => {
    prisma.financeRequest.findUnique.mockResolvedValue(null);
    prisma.escalation.findFirst.mockResolvedValue({ id: 'esc-open' });
    prisma.financeRequest.create.mockResolvedValue({
      id: 'fr-new',
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      conversationId: 'conv-1',
      vehicleVin: null,
      handoffState: 'NONE',
      aprProvided: null,
    });

    await svc.upsertForConversation({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      conversationId: 'conv-1',
    });

    expect(prisma.escalation.create).not.toHaveBeenCalled();
  });
});

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
    const row = await svc.updateStaff('tenant-1', 'loc-1', 'fr-1', 'user-1', {
      status: 'PENDING_STAFF',
    });
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
