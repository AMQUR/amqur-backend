import { TRADE_VALUATION_CAPABILITY, TradeService } from './trade.service';

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
