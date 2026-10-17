import { InventoryEngine, vehicleHasFeature } from './inventory.engine';
import { PrismaService } from '../../prisma/prisma.service';

describe('InventoryEngine.searchVehicles', () => {
  const findMany = jest.fn();
  const engine = new InventoryEngine({
    vehicle: { findMany },
  } as unknown as PrismaService);

  beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([]);
  });

  const lastWhere = (): { AND: Record<string, unknown>[] } => {
    expect(findMany).toHaveBeenCalled();
    return findMany.mock.calls.at(-1)![0].where;
  };

  it('applies maxPrice as price lte', async () => {
    await engine.searchVehicles({ tenantId: 't1', maxPrice: 40000 });
    const { AND } = lastWhere();
    expect(AND).toEqual(
      expect.arrayContaining([{ price: { lte: 40000 } }]),
    );
  });

  it('applies color and model filters together', async () => {
    await engine.searchVehicles({
      tenantId: 't1',
      model: 'Grand Cherokee',
      color: 'red',
      maxPrice: 50000,
    });
    const { AND } = lastWhere();
    expect(AND).toEqual(
      expect.arrayContaining([
        {
          model: { contains: 'Grand Cherokee', mode: 'insensitive' },
        },
        { color: { contains: 'red', mode: 'insensitive' } },
        { price: { lte: 50000 } },
      ]),
    );
  });

  it('applies body type SUV with case-insensitive contains', async () => {
    await engine.searchVehicles({ tenantId: 't1', bodyType: 'SUV' });
    const { AND } = lastWhere();
    expect(AND).toEqual(
      expect.arrayContaining([
        { bodyType: { contains: 'SUV', mode: 'insensitive' } },
      ]),
    );
  });

  it('fail-closed: empty DB result yields no vehicles (no fabricated VINs)', async () => {
    findMany.mockResolvedValue([]);
    const rows = await engine.searchVehicles({
      tenantId: 't1',
      make: 'Jeep',
      model: 'Wrangler',
      color: 'purple',
      maxPrice: 1,
    });
    expect(rows).toEqual([]);
  });

  it('returns only rows from the database (maps VINs faithfully)', async () => {
    findMany.mockResolvedValue([
      {
        id: 'v1',
        vin: '1C4RJFBG0MC100001',
        stock: 'S1',
        year: 2025,
        make: 'Jeep',
        model: 'Wrangler',
        trim: null,
        price: 41890,
        msrp: null,
        mileage: 12,
        color: 'Red',
        drivetrain: '4WD',
        bodyType: 'SUV',
        transmission: null,
        fuelType: null,
        photos: [],
        features: [],
        condition: 'new',
        status: 'AVAILABLE',
        locationId: 'loc1',
        lastSeenAt: new Date(),
        source: 'feed',
        freshnessState: 'FRESH',
        createdAt: new Date(),
      },
    ]);
    const rows = await engine.searchVehicles({ tenantId: 't1', model: 'Wrangler' });
    expect(rows).toHaveLength(1);
    expect(rows[0].vin).toBe('1C4RJFBG0MC100001');
  });
});

describe('InventoryEngine.getVehiclesByVin', () => {
  const findMany = jest.fn();
  const engine = new InventoryEngine({
    vehicle: { findMany },
  } as unknown as PrismaService);

  beforeEach(() => {
    findMany.mockReset();
  });

  it('omits VINs not in inventory instead of inventing placeholders', async () => {
    findMany.mockResolvedValue([
      {
        id: 'v1',
        vin: '1C4RJFBG0MC100001',
        stock: 'S1',
        year: 2025,
        make: 'Jeep',
        model: 'Wrangler',
        trim: null,
        price: 41890,
        msrp: null,
        mileage: 12,
        color: 'Red',
        drivetrain: '4WD',
        bodyType: 'SUV',
        transmission: null,
        fuelType: null,
        photos: [],
        features: null,
        condition: 'new',
        status: 'AVAILABLE',
        locationId: 'loc1',
        lastSeenAt: new Date(),
        source: 'feed',
        freshnessState: 'FRESH',
        createdAt: new Date(),
      },
    ]);
    const rows = await engine.getVehiclesByVin('t1', [
      '1C4RJFBG0MC100001',
      '1C4RJFBG0MC999999',
    ]);
    expect(rows.map((v) => v.vin)).toEqual(['1C4RJFBG0MC100001']);
  });
});

describe('vehicleHasFeature', () => {
  it('returns null when feature list is unknown', () => {
    expect(vehicleHasFeature(undefined, 'heated seats')).toBeNull();
    expect(vehicleHasFeature([], 'heated seats')).toBeNull();
  });
});

describe('InventoryEngine.browseForStaff', () => {
  const findMany = jest.fn();
  const findFirst = jest.fn();
  const engine = new InventoryEngine({
    vehicle: { findMany, findFirst },
  } as unknown as PrismaService);

  const dbRow = {
    id: 'v1',
    vin: '1C4RJFBG0MC100001',
    stock: 'S1',
    year: 2025,
    make: 'Jeep',
    model: 'Wrangler',
    trim: null,
    price: 41890,
    msrp: null,
    mileage: 12,
    color: 'Red',
    drivetrain: '4WD',
    bodyType: 'SUV',
    transmission: null,
    fuelType: null,
    photos: [],
    features: [],
    condition: 'new',
    status: 'SOLD',
    locationId: 'loc1',
    lastSeenAt: new Date('2026-01-02T12:00:00.000Z'),
    source: 'feed',
    freshnessState: 'FRESH',
    createdAt: new Date(),
  };

  beforeEach(() => {
    findMany.mockReset();
    findFirst.mockReset();
    findMany.mockResolvedValue([]);
    findFirst.mockResolvedValue(null);
  });

  it('looks up a single VIN and does not run a broad search', async () => {
    findFirst.mockResolvedValue(dbRow);
    const rows = await engine.browseForStaff({
      tenantId: 't1',
      vin: '1c4rjfbg0mc100001',
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 't1',
          vin: '1C4RJFBG0MC100001',
        }),
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('SOLD');
  });

  it('returns empty when VIN is not in inventory (no placeholder vehicle)', async () => {
    findFirst.mockResolvedValue(null);
    const rows = await engine.browseForStaff({ tenantId: 't1', vin: 'MISSING' });
    expect(rows).toEqual([]);
  });

  it('looks up stock before listing when stock is provided', async () => {
    findFirst.mockResolvedValue(dbRow);
    const rows = await engine.browseForStaff({
      tenantId: 't1',
      stock: 's1',
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          stock: { equals: 's1', mode: 'insensitive' },
        }),
      }),
    );
    expect(rows[0].stock).toBe('S1');
  });

  it('scopes browse to rooftop plus tenant-wide rows', async () => {
    findMany.mockResolvedValue([dbRow]);
    await engine.browseForStaff({
      tenantId: 't1',
      locationId: 'loc1',
      make: 'Jeep',
    });
    const { where } = findMany.mock.calls[0][0];
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { tenantId: 't1' },
        { OR: [{ locationId: 'loc1' }, { locationId: null }] },
        { make: { contains: 'Jeep', mode: 'insensitive' } },
      ]),
    );
  });

  it('list browse uses only the requested tenantId (wrong tenant → empty)', async () => {
    findMany.mockResolvedValue([]);
    const rows = await engine.browseForStaff({
      tenantId: 'tenant-b',
      make: 'Jeep',
    });
    expect(rows).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
    const { where } = findMany.mock.calls[0][0];
    expect(where.AND).toEqual(
      expect.arrayContaining([{ tenantId: 'tenant-b' }]),
    );
  });

  it('VIN lookup is tenant-scoped (other tenant’s VIN → empty)', async () => {
    findFirst.mockResolvedValue(null);
    const rows = await engine.browseForStaff({
      tenantId: 'tenant-b',
      vin: '1C4RJFBG0MC100001',
    });
    expect(rows).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-b',
          vin: '1C4RJFBG0MC100001',
        }),
      }),
    );
  });

  it('applies free-text q across make, model, trim, vin, and stock', async () => {
    await engine.browseForStaff({ tenantId: 't1', q: 'wrangler' });
    const { where } = findMany.mock.calls[0][0];
    expect(where.AND).toEqual(
      expect.arrayContaining([
        {
          OR: [
            { make: { contains: 'wrangler', mode: 'insensitive' } },
            { model: { contains: 'wrangler', mode: 'insensitive' } },
            { trim: { contains: 'wrangler', mode: 'insensitive' } },
            { vin: { contains: 'WRANGLER' } },
            { stock: { contains: 'wrangler', mode: 'insensitive' } },
          ],
        },
      ]),
    );
  });
});
