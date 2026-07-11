import { Test, TestingModule } from '@nestjs/testing';
import { InventoryService } from './inventory.service';
import { PrismaService } from '../prisma/prisma.service';

describe('InventoryService', () => {
  let service: InventoryService;
  const upsert = jest.fn();

  beforeEach(async () => {
    upsert.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        {
          provide: PrismaService,
          useValue: {
            vehicle: { upsert, updateMany: jest.fn() },
          },
        },
      ],
    }).compile();

    service = module.get(InventoryService);
  });

  it('upserts by tenantId+vin composite key', async () => {
    upsert.mockResolvedValue({ id: 'v1' });
    await service.upsertVehicles('tenant-a', 'loc-1', [
      {
        vin: '1hgcm82633a004352',
        year: 2024,
        make: 'Honda',
        model: 'Accord',
        stock: 'S1',
      },
    ]);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_vin: {
            tenantId: 'tenant-a',
            vin: '1HGCM82633A004352',
          },
        },
      }),
    );
  });
});
