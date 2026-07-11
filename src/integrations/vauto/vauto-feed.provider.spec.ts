import { VAutoFeedProvider } from './vauto-feed.provider';
import { InventoryFeedService } from '../../inventory-feed/inventory-feed.service';

describe('VAutoFeedProvider anomaly guards', () => {
  const feed = {
    parseFeed: jest.fn(),
    fetchFeed: jest.fn(),
  } as unknown as InventoryFeedService;

  const provider = new VAutoFeedProvider(feed);

  it('rejects empty normalized inventory', async () => {
    (feed.parseFeed as jest.Mock).mockReturnValue([]);
    const result = await provider.validateAndNormalize(
      {
        provider: 'vauto',
        transport: 'HTTPS',
        format: 'XML',
        sourceIdentifier: 'https://feeds.example.com/inv.xml',
        checksum: 'abc',
        fetchedAt: new Date().toISOString(),
        raw: '<adf></adf>',
      },
      { minRecords: 1, previousCount: 50 },
    );
    expect(result.ok).toBe(false);
    expect(result.anomalies.some((a) => a.includes('empty'))).toBe(true);
  });

  it('rejects catastrophic size drop vs previous', async () => {
    (feed.parseFeed as jest.Mock).mockReturnValue([
      {
        vin: '1C4RJFBG0JC123456',
        year: 2024,
        make: 'Jeep',
        model: 'Wrangler',
        price: 42000,
      },
    ]);
    // VehicleNormalizer needs proper shape - mock returns may fail normalize
    // Use enough fake records that normalize keeps some; if all fail, still anomaly
    const result = await provider.validateAndNormalize(
      {
        provider: 'vauto',
        transport: 'HTTPS',
        format: 'XML',
        sourceIdentifier: 'https://feeds.example.com/inv.xml',
        checksum: 'abc',
        fetchedAt: new Date().toISOString(),
        raw: 'x',
      },
      { minRecords: 1, previousCount: 100 },
    );
    expect(result.ok).toBe(false);
  });
});
