import { SoldDealService } from './sold-deal.service';

describe('SoldDealService', () => {
  const prisma = {
    integrationConnection: { findFirst: jest.fn() },
    lead: { findFirst: jest.fn(), update: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const analytics = { trackEvent: jest.fn().mockResolvedValue(null) };

  const svc = new SoldDealService(prisma as never, analytics as never);

  const actor = { id: 'user-1', role: 'MANAGER' };
  const baseInput = {
    locationId: 'loc-1',
    source: 'staff' as const,
    dmsDealId: 'DMS-DEAL-99',
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns dms_not_connected when no live DMS integration exists', async () => {
    prisma.integrationConnection.findFirst.mockResolvedValue(null);

    const result = await svc.recordSoldDeal('tenant-1', actor, baseInput);

    expect(result).toEqual({ accepted: false, reason: 'dms_not_connected' });
    expect(prisma.integrationConnection.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        capability: 'dms',
        enabled: true,
        liveReady: true,
        OR: [{ locationId: 'loc-1' }, { locationId: null }],
      },
      select: { id: true },
    });
    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(analytics.trackEvent).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
