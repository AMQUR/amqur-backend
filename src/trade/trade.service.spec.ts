import { TRADE_VALUATION_CAPABILITY, TradeService } from './trade.service';

describe('TradeService.notifyTradeAdvisor (via createRequest)', () => {
  const prisma = {
    tradeRequest: {
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
  const svc = new TradeService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.escalation.findFirst.mockResolvedValue(null);
    prisma.analyticsEvent.create.mockResolvedValue({});
  });

  it('queues TRADE_ADVISOR escalation on new trade request', async () => {
    prisma.tradeRequest.create.mockResolvedValue({
      id: 'tr-new',
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      conversationId: 'conv-1',
      vin: '1HGCM82633A004352',
      year: 2020,
      make: 'Honda',
      model: 'Accord',
      appraisalVerified: false,
    });

    await svc.createRequest({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      conversationId: 'conv-1',
      vin: '1HGCM82633A004352',
      year: 2020,
      make: 'Honda',
      model: 'Accord',
    });

    expect(prisma.escalation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        conversationId: 'conv-1',
        reason: 'TRADE_ADVISOR',
        metadata: expect.objectContaining({
          tradeRequestId: 'tr-new',
          appraisalVerified: false,
        }),
      }),
    });
    expect(prisma.analyticsEvent.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        locationId: 'loc-1',
        eventType: 'trade.advisor_queued',
        properties: { tradeRequestId: 'tr-new' },
      },
    });
  });

  it('does not duplicate TRADE_ADVISOR when one is already open', async () => {
    prisma.escalation.findFirst.mockResolvedValue({ id: 'esc-open' });
    prisma.tradeRequest.create.mockResolvedValue({
      id: 'tr-new',
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      conversationId: 'conv-1',
      vin: null,
      year: null,
      make: null,
      model: null,
      appraisalVerified: false,
    });

    await svc.createRequest({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      conversationId: 'conv-1',
    });

    expect(prisma.escalation.create).not.toHaveBeenCalled();
  });

  it('skips escalation when trade request has no conversation', async () => {
    prisma.tradeRequest.create.mockResolvedValue({
      id: 'tr-new',
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      conversationId: null,
      vin: null,
      year: null,
      make: null,
      model: null,
      appraisalVerified: false,
    });

    await svc.createRequest({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
    });

    expect(prisma.escalation.findFirst).not.toHaveBeenCalled();
    expect(prisma.escalation.create).not.toHaveBeenCalled();
  });
});

describe('TradeService.getValuation (fail-closed)', () => {
  const prisma = {
    integrationConnection: { findFirst: jest.fn() },
  };
  const svc = new TradeService(prisma as never);

  const ctx = {
    tenantId: 'tenant-1',
    locationId: 'loc-1',
    mode: 'sandbox' as const,
    timeoutMs: 10_000,
  };

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.integrationConnection.findFirst.mockResolvedValue(null);
  });

  it('returns blocked without any dollar amount when no valuation provider is connected', async () => {
    const result = await svc.getValuation(ctx, {
      vin: '1HGCM82633A004352',
      year: 2020,
      make: 'Honda',
      model: 'Accord',
    });

    expect(result).toEqual({
      status: 'blocked',
      reason: 'not_connected',
      verified: false,
    });
    expect(result).not.toHaveProperty('amount');
    expect(result).not.toHaveProperty('amountLow');
    expect(result).not.toHaveProperty('amountHigh');
    expect(result).not.toHaveProperty('appraisalValue');
    expect(prisma.integrationConnection.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        capability: TRADE_VALUATION_CAPABILITY,
        enabled: true,
        liveReady: true,
        OR: [{ locationId: 'loc-1' }, { locationId: null }],
      },
      select: { id: true },
    });
  });

  it('integration status mirrors gate without vehicle input', async () => {
    await expect(
      svc.getValuationIntegrationStatus('tenant-1', 'loc-1'),
    ).resolves.toEqual({
      status: 'blocked',
      reason: 'not_connected',
      verified: false,
    });
  });

  it('returns not_configured without dollar fields when adapter is not live', async () => {
    prisma.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1' });

    const result = await svc.getValuation(ctx, { vin: '1HGCM82633A004352' });

    expect(result).toEqual({
      status: 'blocked',
      reason: 'not_configured',
      verified: false,
    });
    expect(result).not.toHaveProperty('amount');
  });
});
