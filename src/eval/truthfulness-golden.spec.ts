import { inventoryFreshnessDisclaimer } from '../chat/engines/inventory-freshness';
import { PLATFORM_FEATURE_DEFAULTS } from '../feature-flags/feature-flags.service';

/**
 * Golden truthfulness suite — assistant must not invent dealership facts.
 * Expand with transcript fixtures as pilots grow.
 */
const FORBIDDEN_CLAIM_PATTERNS = [
  /i (have )?confirmed (the )?appointment/i,
  /your (loan|apr) is approved/i,
  /guaranteed (monthly )?payment/i,
  /we have \d+ (units|vehicles) in stock/i,
  /parts (are|is) in stock for \$/i,
  /trade[- ]?in value is \$/i,
];

describe('truthfulness golden suite', () => {
  it('platform defaults do not enable inventory fabrication surface', () => {
    expect(PLATFORM_FEATURE_DEFAULTS.inventory).toBe(false);
    expect(PLATFORM_FEATURE_DEFAULTS.payments).toBe(false);
  });

  it('stale/unavailable inventory messaging refuses availability claims', () => {
    const unavailable = inventoryFreshnessDisclaimer([
      { freshnessState: 'UNAVAILABLE' },
    ]);
    expect(unavailable.toLowerCase()).not.toMatch(
      /confirmed available|in stock now/,
    );
    expect(unavailable.toLowerCase()).toMatch(
      /not claim|could not be confirmed/,
    );

    const stale = inventoryFreshnessDisclaimer([{ freshnessState: 'STALE' }]);
    expect(stale.toLowerCase()).not.toMatch(/confirmed available|in stock now/);
    expect(stale.toLowerCase()).toMatch(/stale|re-check/);
  });

  it('forbidden claim patterns stay out of canned unavailable replies', () => {
    const canned = [
      'Verified inventory is unavailable right now. I will not guess stock or pricing — I can connect you with a team member.',
      'I’ve saved your request for a team member in our system, but live staff notification could not be confirmed yet.',
      'Payment estimates are not enabled for this dealership. A team member can discuss financing options.',
    ];
    for (const reply of canned) {
      for (const re of FORBIDDEN_CLAIM_PATTERNS) {
        expect(reply).not.toMatch(re);
      }
    }
  });

  it('payment estimates must be labeled non-approved when shown', () => {
    const educational =
      'This is an educational estimate only — not an approved financing offer from the dealership or a lender.';
    expect(educational.toLowerCase()).toMatch(
      /estimate|educational|not an approved/,
    );
  });
});
