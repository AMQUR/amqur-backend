import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import { VehicleNormalizer } from '../../inventory-feed/normalizer/vehicle.normalizer';
import { VAutoSftpIngestionService } from './vauto-sftp-ingestion.service';
import { FixtureSftpTransport } from './sftp/fixture-sftp-transport';

const FIXTURE_ROOT = path.join(
  __dirname,
  '../../../fixtures/vauto/dial-difference-sftp',
);

describe('VAutoSftpIngestionService', () => {
  const parseFeed = jest.fn();
  const upsertVehicles = jest.fn();
  const updateVehicleLifecycle = jest.fn();
  const importCreate = jest.fn();
  const importUpdate = jest.fn();
  const importFindFirst = jest.fn();
  const vehicleCount = jest.fn();
  const tenantFindFirst = jest.fn();
  const locationFindFirst = jest.fn();

  const configMap: Record<string, string> = {
    AMQUR_VAUTO_SFTP_ENABLED: 'true',
    AMQUR_VAUTO_PUBLISH_PRICES: 'false',
    AMQUR_VAUTO_PUBLISH_PHOTOS: 'false',
  };

  const service = new VAutoSftpIngestionService(
    {
      tenant: { findFirst: tenantFindFirst },
      location: { findFirst: locationFindFirst },
      vehicle: { count: vehicleCount },
      inventoryImportRun: {
        create: importCreate,
        update: importUpdate,
        findFirst: importFindFirst,
      },
    } as never,
    {
      get: (k: string) => configMap[k],
    } as unknown as ConfigService,
    { parseFeed } as never,
    {
      upsertVehicles,
      updateVehicleLifecycle,
    } as never,
    { increment: jest.fn() } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    importCreate.mockResolvedValue({
      id: 'run-1',
      startedAt: new Date('2026-11-20T12:00:00Z'),
    });
    importUpdate.mockResolvedValue({});
    importFindFirst.mockResolvedValue(null);
    vehicleCount.mockResolvedValue(0);
    parseFeed.mockReturnValue([
      {
        vin: '1C4HJXDG0FW000001',
        year: 2025,
        make: 'Jeep',
        model: 'Wrangler',
      },
    ]);
    // VehicleNormalizer.normalize is used — return shape that normalizer accepts via parseFeed records
  });

  it('is disabled by default flag', () => {
    const off = new VAutoSftpIngestionService(
      {} as never,
      { get: () => 'false' } as unknown as ConfigService,
      {} as never,
      {} as never,
      { increment: jest.fn() } as never,
    );
    expect(off.isEnabled()).toBe(false);
  });

  it('detects XML/JSON/CSV formats without guessing unsupported bodies', () => {
    expect(service.detectFormat('inv.xml', Buffer.from('<adf></adf>'))).toBe(
      'XML',
    );
    expect(
      service.detectFormat('inv.json', Buffer.from('{"vehicles":[]}')),
    ).toBe('JSON');
    expect(
      service.detectFormat('inv.csv', Buffer.from('vin,year,make\n')),
    ).toBe('CSV');
    expect(service.detectFormat('inv.bin', Buffer.from([0, 1, 2]))).toBeNull();
  });

  it('ingests jeep_north/new via fixture transport and scopes lifecycle', async () => {
    tenantFindFirst.mockResolvedValue({
      id: 'tenant-jeep',
      slug: 'jeep-of-chicago',
    });
    locationFindFirst.mockResolvedValue({
      id: 'loc-jeep',
      inventoryMinRecords: 1,
    });
    jest.spyOn(VehicleNormalizer, 'normalize').mockReturnValue({
      vin: '1C4HJXDG0FW000001',
      year: 2025,
      make: 'Jeep',
      model: 'Wrangler',
      price: 44995,
      photos: ['https://cdn.example/x.jpg'],
    } as never);

    const transport = new FixtureSftpTransport(FIXTURE_ROOT);
    const source = service.source('jeep_north/new')!;
    const result = await service.runOneSource(source, transport);

    expect(result.status).toBe('SUCCEEDED');
    expect(upsertVehicles).toHaveBeenCalledWith(
      'tenant-jeep',
      'loc-jeep',
      expect.arrayContaining([
        expect.objectContaining({
          vin: '1C4HJXDG0FW000001',
          condition: 'new',
        }),
      ]),
      expect.objectContaining({
        feedSourceKey: 'jeep_north/new',
        publishPrices: false,
        publishPhotos: false,
      }),
    );
    expect(updateVehicleLifecycle).toHaveBeenCalledWith(
      'loc-jeep',
      expect.objectContaining({ feedSourceKey: 'jeep_north/new' }),
    );
    await transport.dispose();
  });

  it('skips unmapped tenants without writing inventory', async () => {
    tenantFindFirst.mockResolvedValue(null);
    const transport = new FixtureSftpTransport(FIXTURE_ROOT);
    const result = await service.runOneSource(
      service.source('cdjr_south/used')!,
      transport,
    );
    expect(result.status).toBe('SKIPPED_UNMAPPED_TENANT');
    expect(upsertVehicles).not.toHaveBeenCalled();
    await transport.dispose();
  });

  it('rejects size-drop anomalies and preserves last-known-good inventory', async () => {
    tenantFindFirst.mockResolvedValue({
      id: 'tenant-jeep',
      slug: 'jeep-of-chicago',
    });
    locationFindFirst.mockResolvedValue({
      id: 'loc-jeep',
      inventoryMinRecords: 1,
    });
    vehicleCount.mockResolvedValue(50);
    parseFeed.mockReturnValue([
      {
        vin: '1C4HJXDG0FW000001',
        year: 2025,
        make: 'Jeep',
        model: 'Wrangler',
      },
    ]);
    jest.spyOn(VehicleNormalizer, 'normalize').mockReturnValue({
      vin: '1C4HJXDG0FW000001',
      year: 2025,
      make: 'Jeep',
      model: 'Wrangler',
    } as never);

    const transport = new FixtureSftpTransport(FIXTURE_ROOT);
    const result = await service.runOneSource(
      service.source('jeep_north/new')!,
      transport,
    );

    expect(result.status).toBe('REJECTED_ANOMALY');
    expect(result.preservedInventory).toBe(true);
    expect(
      result.anomalies?.some((a) => a.startsWith('size_drop_anomaly')),
    ).toBe(true);
    expect(upsertVehicles).not.toHaveBeenCalled();
    expect(updateVehicleLifecycle).not.toHaveBeenCalled();
    expect(importUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'REJECTED_ANOMALY',
        }),
      }),
    );
    await transport.dispose();
  });
});
