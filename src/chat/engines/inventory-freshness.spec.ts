import { inventoryFreshnessDisclaimer } from './inventory-freshness';

describe('inventoryFreshnessDisclaimer', () => {
  it('UNAVAILABLE refuses availability claims', () => {
    const t = inventoryFreshnessDisclaimer([{ freshnessState: 'UNAVAILABLE' }]);
    expect(t.toLowerCase()).toMatch(/will not claim|could not be confirmed/);
  });

  it('STALE warns without confirming stock', () => {
    const t = inventoryFreshnessDisclaimer([{ freshnessState: 'STALE' }]);
    expect(t.toLowerCase()).toMatch(/stale/);
    expect(t.toLowerCase()).not.toMatch(/confirmed available/);
  });

  it('DEGRADED / missing lastSeenAt warn', () => {
    const t = inventoryFreshnessDisclaimer([{ freshnessState: 'DEGRADED' }]);
    expect(t.toLowerCase()).toMatch(/re-check|behind/);
  });

  it('fresh with recent lastSeenAt affirms verified records', () => {
    const t = inventoryFreshnessDisclaimer([
      {
        freshnessState: 'FRESH',
        lastSeenAt: new Date().toISOString(),
      },
    ]);
    expect(t.toLowerCase()).toMatch(/inventory records|not ai guesses/);
  });
});
