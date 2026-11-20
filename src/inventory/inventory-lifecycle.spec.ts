import { InventoryFreshnessState, VehicleStatus } from '@prisma/client';
import { InventoryService } from './inventory.service';

describe('InventoryService lifecycle (missing ≠ sold)', () => {
  const updateMany = jest.fn();
  const upsert = jest.fn();
  const service = new InventoryService({
    vehicle: { updateMany, upsert },
  } as never);

  beforeEach(() => {
    updateMany.mockReset().mockResolvedValue({ count: 1 });
    upsert.mockReset().mockResolvedValue({});
  });

  it('marks absent stock MISSING then REMOVED_FROM_LISTING — never SOLD', async () => {
    const started = new Date('2026-11-20T12:00:00.000Z');
    await service.updateVehicleLifecycle('loc-1', {
      feedSourceKey: 'jeep_north/new',
      snapshotStartedAt: started,
      removedAfterDays: 14,
    });

    expect(updateMany).toHaveBeenCalledTimes(2);
    const missingCall = updateMany.mock.calls[0][0];
    expect(missingCall.where.feedSourceKey).toBe('jeep_north/new');
    expect(missingCall.data.status).toBe(VehicleStatus.MISSING);
    expect(missingCall.data.status).not.toBe(VehicleStatus.SOLD);

    const removedCall = updateMany.mock.calls[1][0];
    expect(removedCall.data.status).toBe(VehicleStatus.REMOVED_FROM_LISTING);
    expect(removedCall.data.freshnessState).toBe(InventoryFreshnessState.STALE);
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain(
      `"${VehicleStatus.SOLD}"`,
    );
  });

  it('scopes lifecycle to one feed source so New cannot wipe Used', async () => {
    await service.updateVehicleLifecycle('loc-1', {
      feedSourceKey: 'chevy/new',
      snapshotStartedAt: new Date(),
    });
    expect(updateMany.mock.calls[0][0].where.feedSourceKey).toBe('chevy/new');
  });

  it('requires explicit evidence to mark SOLD', async () => {
    await expect(
      service.markExplicitlySold({
        tenantId: 't1',
        vin: '1C4HJXDG0FW000001',
        evidence: '  ',
      }),
    ).rejects.toThrow(/sold_evidence_required/);

    await service.markExplicitlySold({
      tenantId: 't1',
      vin: '1c4hjxdg0fw000001',
      evidence: 'vendor_status=SOLD',
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 't1', vin: '1C4HJXDG0FW000001' },
        data: expect.objectContaining({
          status: VehicleStatus.SOLD,
          explicitSoldEvidence: 'vendor_status=SOLD',
        }),
      }),
    );
  });

  it('strips prices and photos when publish flags are off', async () => {
    await service.upsertVehicles(
      't1',
      'loc-1',
      [
        {
          vin: '1C4HJXDG0FW000001',
          year: 2025,
          make: 'Jeep',
          model: 'Wrangler',
          price: 44995,
          photos: ['https://cdn.example/a.jpg'],
          condition: 'new',
        },
      ],
      {
        feedSourceKey: 'jeep_north/new',
        publishPrices: false,
        publishPhotos: false,
      },
    );
    const data = upsert.mock.calls[0][0].create;
    expect(data.price).toBeNull();
    expect(data.photos).toEqual([]);
    expect(data.feedSourceKey).toBe('jeep_north/new');
    expect(data.condition).toBe('new');
  });
});
