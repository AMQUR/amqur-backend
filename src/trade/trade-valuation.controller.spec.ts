import { BadRequestException } from '@nestjs/common';
import { TradeValuationController } from './trade-valuation.controller';
import { TradeService } from './trade.service';

describe('TradeValuationController', () => {
  const trades = {
    getValuationIntegrationStatus: jest.fn(),
    getValuation: jest.fn(),
  };
  const ctrl = new TradeValuationController(trades as unknown as TradeService);

  const user = {
    sub: 'u1',
    role: 'MANAGER',
    tenantId: 'tenant-1',
    locationId: 'loc-1',
  } as never;

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('valuationStatus without vehicle fields returns integration gate only', async () => {
    trades.getValuationIntegrationStatus.mockResolvedValue({
      status: 'blocked',
      reason: 'not_connected',
      verified: false,
    });

    await expect(ctrl.valuationStatus(user, {})).resolves.toEqual({
      status: 'blocked',
      reason: 'not_connected',
      verified: false,
    });

    expect(trades.getValuationIntegrationStatus).toHaveBeenCalledWith(
      'tenant-1',
      'loc-1',
    );
    expect(trades.getValuation).not.toHaveBeenCalled();
  });

  it('valuationStatus with VIN delegates to getValuation', async () => {
    trades.getValuation.mockResolvedValue({
      status: 'blocked',
      reason: 'not_configured',
      verified: false,
    });

    await expect(
      ctrl.valuationStatus(user, {
        locationId: 'loc-1',
        vin: '1HGCM82633A004352',
      }),
    ).resolves.toEqual({
      status: 'blocked',
      reason: 'not_configured',
      verified: false,
    });

    expect(trades.getValuation).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', locationId: 'loc-1' }),
      expect.objectContaining({ vin: '1HGCM82633A004352' }),
    );
  });

  it('requestValuation rejects missing vehicle identity', () => {
    expect(() => ctrl.requestValuation(user, { make: 'Honda' })).toThrow(
      BadRequestException,
    );
  });
});
