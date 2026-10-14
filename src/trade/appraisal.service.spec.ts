import { customerVisibleValue } from './appraisal.service';

const row = (
  o: Partial<Parameters<typeof customerVisibleValue>[0][number]>,
) => ({
  kind: 'DEALER_APPRAISAL',
  status: 'ACTIVE',
  displayPermitted: true,
  amount: 20000,
  amountLow: null,
  amountHigh: null,
  expiresAt: null,
  createdAt: new Date('2026-10-14T10:00:00Z'),
  ...o,
});

describe('customer-visible trade value', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  it('nothing without a permitted, active, unexpired value', () => {
    expect(customerVisibleValue([], now)).toBeNull();
    expect(
      customerVisibleValue([row({ displayPermitted: false })], now),
    ).toBeNull();
    expect(
      customerVisibleValue([row({ status: 'SUPERSEDED' })], now),
    ).toBeNull();
    expect(
      customerVisibleValue(
        [
          row({
            kind: 'FINAL_OFFER',
            expiresAt: new Date('2026-10-13T00:00:00Z'),
          }),
        ],
        now,
      ),
    ).toBeNull();
    expect(customerVisibleValue([row({ amount: null })], now)).toBeNull();
  });
  it('final offer outranks appraisal outranks estimate', () => {
    const v = customerVisibleValue(
      [
        row({
          kind: 'MARKET_ESTIMATE',
          amount: null,
          amountLow: 18000,
          amountHigh: 21000,
        }),
        row({
          kind: 'FINAL_OFFER',
          amount: 19500,
          expiresAt: new Date('2026-10-20T00:00:00Z'),
        }),
        row({ kind: 'DEALER_APPRAISAL', amount: 19000 }),
      ],
      now,
    );
    expect(v).toMatchObject({ kind: 'FINAL_OFFER', amount: 19500 });
  });
});
