import { ForbiddenException } from '@nestjs/common';
import { DealerGroupsService } from './dealer-groups.service';

describe('DealerGroupsService tenant isolation', () => {
  const prisma = {
    dealerGroupMembership: { findUnique: jest.fn() },
    tenant: { findMany: jest.fn() },
    lead: { count: jest.fn() },
    appointment: { count: jest.fn() },
    escalation: { count: jest.fn() },
    analyticsEvent: { findMany: jest.fn() },
    conversation: { count: jest.fn() },
    priceQuoteRequest: { count: jest.fn() },
    tradeRequest: { count: jest.fn() },
    tradeAppraisal: { count: jest.fn() },
    financeRequest: { count: jest.fn() },
    partsInquiry: { count: jest.fn() },
    vehicle: { count: jest.fn() },
    dealerGroup: { findUnique: jest.fn() },
  };
  const svc = new DealerGroupsService(prisma as never);

  beforeEach(() => jest.resetAllMocks());

  it('rooftopMetrics denies cross-group access without membership', async () => {
    prisma.dealerGroupMembership.findUnique.mockResolvedValue(null);
    await expect(
      svc.rooftopMetrics({
        dealerGroupId: 'group-a',
        actorUserId: 'staff-other-group',
        isSuperAdmin: false,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
  });

  it('comparison denies cross-group access without membership', async () => {
    prisma.dealerGroupMembership.findUnique.mockResolvedValue(null);
    await expect(
      svc.comparison({
        dealerGroupId: 'group-a',
        actorUserId: 'staff-other-group',
        isSuperAdmin: false,
        days: 7,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
  });
});
