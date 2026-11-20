import { priceIncludesDealerFees, verifiedVdpUrl } from './vehicle-enrichment';

describe('priceIncludesDealerFees', () => {
  const p = (over: object) =>
    ({
      mode: 'DEALER_CONFIGURED',
      docFee: null,
      docFeeIncludedInPrice: false,
      otherFees: [],
      ...over,
    }) as never;

  it('is null unless a dealer-configured policy states it', () => {
    expect(priceIncludesDealerFees(null)).toBeNull();
    expect(
      priceIncludesDealerFees(
        p({ mode: 'ILLUSTRATIVE', docFeeIncludedInPrice: true }),
      ),
    ).toBeNull();
    expect(priceIncludesDealerFees(p({}))).toBeNull();
  });

  it('is true only when the doc fee is in the price and no other dealer fee exists', () => {
    expect(priceIncludesDealerFees(p({ docFeeIncludedInPrice: true }))).toBe(
      true,
    );
    expect(
      priceIncludesDealerFees(
        p({
          docFeeIncludedInPrice: true,
          otherFees: [{ label: 'Prep', amount: 199 }],
        }),
      ),
    ).toBe(false);
  });

  it('is false when a dealer fee is added on top', () => {
    expect(priceIncludesDealerFees(p({ docFee: 358 }))).toBe(false);
  });
});

describe('verifiedVdpUrl', () => {
  const site = 'https://www.fixture-motors.example';
  it('returns an https URL from the feed record on the rooftop’s own host', () => {
    expect(
      verifiedVdpUrl(
        { vdpUrl: 'https://www.fixture-motors.example/inventory/abc' },
        site,
      ),
    ).toBe('https://www.fixture-motors.example/inventory/abc');
    expect(
      verifiedVdpUrl(
        { detail_url: 'https://inventory.fixture-motors.example/v/1' },
        site,
      ),
    ).toBe('https://inventory.fixture-motors.example/v/1');
  });

  it.each([
    [{ vdpUrl: 'http://www.fixture-motors.example/inventory/abc' }, site],
    [{ vdpUrl: 'https://evil.example/inventory/abc' }, site],
    [{ vdpUrl: 'https://fixture-motors.example.evil.example/x' }, site],
    [{ vdpUrl: 'https://user:pw@www.fixture-motors.example/x' }, site],
    [{ vdpUrl: 'javascript:alert(1)' }, site],
    [{ vdpUrl: 'https://www.fixture-motors.example/x' }, null],
    [
      { vdpUrl: 'https://www.fixture-motors.example/x' },
      'http://www.fixture-motors.example',
    ],
    [{ note: 'no url in the feed record' }, site],
    [null, site],
    [['https://www.fixture-motors.example/x'], site],
  ])('is null for %j', (raw, s) => {
    expect(verifiedVdpUrl(raw, s)).toBeNull();
  });
});
