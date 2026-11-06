import {
  offerDisclosure,
  selectVerifiedCurrentOffers,
} from './verified-current-offers';

describe('selectVerifiedCurrentOffers', () => {
  it('returns approved OFFER rows with disclaimer appended', () => {
    const lines = selectVerifiedCurrentOffers([
      {
        id: '1',
        kind: 'OFFER',
        title: '$500 rebate',
        body: 'Select new Jeeps.',
        disclaimer: 'Must take delivery by month end.',
        source: 'OEM program',
        endsAt: '2026-11-30T00:00:00.000Z',
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toContain('$500 rebate');
    expect(lines[0].line).toContain('Must take delivery by month end.');
  });

  it('never treats ANNOUNCEMENT as a current special', () => {
    expect(
      selectVerifiedCurrentOffers([
        {
          kind: 'ANNOUNCEMENT',
          title: 'Holiday hours',
          body: 'We are open Saturday.',
          disclaimer: 'n/a',
        },
      ]),
    ).toEqual([]);
  });

  it('rejects OFFER rows missing a disclaimer', () => {
    expect(
      selectVerifiedCurrentOffers([
        {
          kind: 'OFFER',
          title: 'Mystery deal',
          body: 'Save big',
          disclaimer: '',
        },
      ]),
    ).toEqual([]);
  });

  it('returns empty for missing offers', () => {
    expect(selectVerifiedCurrentOffers([])).toEqual([]);
  });

  it('ignores EVENT / VEHICLE kinds even if keyword-like', () => {
    expect(
      selectVerifiedCurrentOffers([
        {
          kind: 'EVENT',
          title: 'Special weekend sale event',
          body: 'Come in for deals',
          disclaimer: 'Details inside',
        },
        {
          kind: 'VEHICLE',
          title: 'Featured Wrangler special',
          body: 'On the lot',
          disclaimer: 'While supplies last wording blocked upstream',
        },
      ]),
    ).toEqual([]);
  });

  it('exposes a customer-facing disclosure', () => {
    expect(offerDisclosure().toLowerCase()).toMatch(/location-specific/);
    expect(offerDisclosure().toLowerCase()).toMatch(/confirm/);
  });
});
