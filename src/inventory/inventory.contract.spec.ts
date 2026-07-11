/**
 * InventoryVehicle type shape used by upsert — stock must be accepted.
 */
import type { InventoryVehicle } from '../chat/types/vehicle.types';

describe('InventoryVehicle contract', () => {
  it('supports stock and status for tenant-scoped upserts', () => {
    const v: InventoryVehicle = {
      vin: '1HGCM82633A004352',
      stock: 'ABC123',
      year: 2024,
      make: 'Honda',
      model: 'Accord',
      status: 'AVAILABLE',
      locationId: 'loc_1',
    };
    expect(v.stock).toBe('ABC123');
    expect(v.vin).toHaveLength(17);
  });
});
