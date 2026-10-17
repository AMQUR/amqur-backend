import { SoldDealService } from './sold-deal.service';

describe('SoldDealService', () => {
  const prisma = {
    integrationConnection: { findFirst: jest.fn() },
    lead: { findFirst: jest.fn(), update: jest.fn() },
    message: { findMany: jest.fn() },
    auditLog: { create: jest.fn() },
    customerSurvey: {
      create: jest.fn().mockResolvedValue({ id: 'survey-1' }),
    },
  };
  const analytics = { trackEvent: jest.fn().mockResolvedValue(null) };
  const campaigns = { onEvent: jest.fn().mockResolvedValue(undefined) };

  const svc = new SoldDealService(
    prisma as never,
    analytics as never,
    campaigns as never,
  );

  const actor = { id: 'user-1', role: 'MANAGER' };
  const baseInput = {
    locationId: 'loc-1',
    source: 'staff' as const,
    dmsDealId: 'DMS-DEAL-99',
  };

  beforeEach(() => {
    jest.resetAllMocks();
    campaigns.onEvent.mockResolvedValue(undefined);
    analytics.trackEvent.mockResolvedValue(null);
    prisma.customerSurvey.create.mockResolvedValue({ id: 'survey-1' });
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

  it('includes campaignId on sold analytics only when persisted on a prior USER message', async () => {
    prisma.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1' });
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      status: 'QUALIFIED',
      notes: null,
      conversationId: 'conv-1',
    });
    prisma.lead.update.mockResolvedValue({});
    prisma.message.findMany.mockResolvedValue([
      { metadata: { campaignId: 'camp-9', channel: 'SMS' } },
    ]);
    prisma.auditLog.create.mockResolvedValue({});

    const result = await svc.recordSoldDeal('tenant-1', actor, {
      ...baseInput,
      leadId: 'lead-1',
    });

    expect(result).toEqual({
      accepted: true,
      dmsDealId: 'DMS-DEAL-99',
      leadId: 'lead-1',
    });
    expect(analytics.trackEvent).toHaveBeenCalledWith(
      'tenant-1',
      'loc-1',
      'deal.sold_recorded',
      expect.objectContaining({ campaignId: 'camp-9', leadId: 'lead-1' }),
    );
    expect(campaigns.onEvent).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      trigger: 'deal.sold_recorded',
      subjectId: 'lead-1',
    });
    expect(prisma.customerSurvey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        leadId: 'lead-1',
        kind: 'SALES',
        status: 'DRAFT',
        channel: 'IN_PERSON',
      }),
    });
  });

  it('omits campaignId when conversation has no campaign metadata', async () => {
    prisma.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1' });
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      status: 'CONTACTED',
      notes: null,
      conversationId: 'conv-1',
    });
    prisma.lead.update.mockResolvedValue({});
    prisma.message.findMany.mockResolvedValue([
      { metadata: { channel: 'SMS' } },
    ]);
    prisma.auditLog.create.mockResolvedValue({});

    await svc.recordSoldDeal('tenant-1', actor, {
      ...baseInput,
      leadId: 'lead-1',
    });

    const props = analytics.trackEvent.mock.calls[0][3] as Record<
      string,
      unknown
    >;
    expect(props.campaignId).toBeUndefined();
  });
});
