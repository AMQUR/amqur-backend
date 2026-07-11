import { inventoryFreshnessDisclaimer } from './inventory-freshness';

describe('inventoryFreshnessDisclaimer', () => {
  it('warns when lastSeenAt is missing', () => {
    const d = inventoryFreshnessDisclaimer([{ lastSeenAt: null }]);
    expect(d).toMatch(/behind|re-check|feed/i);
  });

  it('is calm when fresh', () => {
    const d = inventoryFreshnessDisclaimer([
      { lastSeenAt: new Date().toISOString() },
    ]);
    expect(d).toMatch(/inventory records/i);
  });
});
