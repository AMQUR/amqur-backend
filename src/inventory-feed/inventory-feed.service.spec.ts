import { Test, TestingModule } from '@nestjs/testing';
import { InventoryFeedService } from './inventory-feed.service';

describe('InventoryFeedService', () => {
  let service: InventoryFeedService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [InventoryFeedService],
    }).compile();

    service = module.get<InventoryFeedService>(InventoryFeedService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

describe('InventoryFeedService CSV hardening', () => {
  const svc = new InventoryFeedService();
  it('parses a normal CSV feed', () => {
    const rows = svc.parseFeed('CSV', 'vin,price\n1C4HJXDG0RW100001,41995\n');
    expect(rows).toEqual([{ vin: '1C4HJXDG0RW100001', price: '41995' }]);
  });
  it('a malicious __proto__ column cannot pollute Object.prototype', () => {
    const rows = svc.parseFeed(
      'CSV',
      '__proto__,constructor,vin\npolluted,bad,X\n',
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
    expect(Object.keys(rows[0])).toEqual(['vin']);
  });
});
