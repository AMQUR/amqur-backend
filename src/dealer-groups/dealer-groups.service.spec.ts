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

  it('comparison returns persisted rates and null denominators', async () => {
    prisma.dealerGroupMembership.findUnique.mockResolvedValue({
      role: 'GROUP_VIEWER',
    });
    prisma.tenant.findMany.mockResolvedValue([
      { id: 't1', slug: 'north', name: 'North' },
    ]);
    prisma.conversation.count.mockResolvedValue(4);
    prisma.lead.count.mockImplementation(
      ({ where }: { where: { stage?: string } }) =>
        Promise.resolve(where?.stage === 'HOT' ? 1 : 2),
    );
    prisma.appointment.count.mockImplementation(
      ({ where }: { where: { status?: string } }) =>
        Promise.resolve(where?.status === 'CONFIRMED' ? 1 : 3),
    );
    prisma.escalation.count.mockImplementation(
      ({ where }: { where: { notifiedAt?: unknown; status?: unknown } }) => {
        if (where.status) return Promise.resolve(2);
        if (where.notifiedAt) return Promise.resolve(1);
        return Promise.resolve(5);
      },
    );
    prisma.priceQuoteRequest.count.mockResolvedValue(0);
    prisma.tradeRequest.count.mockResolvedValue(0);
    prisma.tradeAppraisal.count.mockResolvedValue(0);
    prisma.financeRequest.count.mockImplementation(
      ({ where }: { where: { creditLinkState?: unknown } }) => {
        const state = where.creditLinkState;
        if (state && typeof state === 'object' && 'in' in state)
          return Promise.resolve(1);
        if (state && typeof state === 'object' && 'not' in state)
          return Promise.resolve(0);
        return Promise.resolve(2);
      },
    );
    prisma.partsInquiry.count.mockResolvedValue(0);
    prisma.analyticsEvent.findMany.mockResolvedValue([
      { properties: { label: 'good_reply' } },
      { properties: { label: 'too_long' } },
    ]);
    prisma.vehicle.count.mockImplementation(
      ({ where }: { where: { source?: string; freshnessState?: unknown } }) => {
        if (where.source === 'synthetic_demo') return Promise.resolve(0);
        if (where.freshnessState) return Promise.resolve(1);
        return Promise.resolve(10);
      },
    );

    const out = await svc.comparison({
      dealerGroupId: 'group-a',
      actorUserId: 'viewer',
      isSuperAdmin: false,
      days: 7,
    });

    expect(out.stores).toHaveLength(1);
    expect(out.stores[0].rates).toEqual({
      leadPerConversation: 0.5,
      appointmentConfirmation: 0.3333,
      handoffDelivery: 0.2,
      creditClickThrough: null,
      replyFeedbackGoodRate: 0.5,
    });
    expect(out.stores[0].counts.openHandoffs).toBe(2);
  });

  it('comparison returns empty stores when group has no tenants', async () => {
    prisma.dealerGroupMembership.findUnique.mockResolvedValue({
      role: 'GROUP_VIEWER',
    });
    prisma.tenant.findMany.mockResolvedValue([]);

    const out = await svc.comparison({
      dealerGroupId: 'group-empty',
      actorUserId: 'viewer',
      isSuperAdmin: false,
      days: 30,
    });

    expect(out.stores).toEqual([]);
    expect(out.windowDays).toBe(30);
  });
});
