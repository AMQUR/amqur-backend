import {
  isPlausibleStock,
  isPlausibleVin,
  rawRecordsHaveVinHeader,
  shouldRejectFeedValidation,
  validateNormalizedFeedVehicles,
} from './feed-record-validation';

describe('feed-record-validation', () => {
  it('accepts plausible VIN / stock shapes', () => {
    expect(isPlausibleVin('1C4HJXDG0FW000001')).toBe(true);
    expect(isPlausibleVin('SHORT')).toBe(false);
    expect(isPlausibleVin('1C4HJXDG0FI000001')).toBe(false); // I illegal
    expect(isPlausibleStock('JN-NEW-1')).toBe(true);
    expect(isPlausibleStock('bad stock!!')).toBe(false);
  });

  it('detects VIN header aliases on raw CSV-like rows', () => {
    expect(rawRecordsHaveVinHeader([{ VIN: 'x', Year: '2024' }])).toBe(true);
    expect(rawRecordsHaveVinHeader([{ stock: '1', make: 'Jeep' }])).toBe(false);
  });

  it('dedupes VINs and counts invalids', () => {
    const r = validateNormalizedFeedVehicles([
      { vin: '1C4HJXDG0FW000001', stock: 'A1' },
      { vin: '1C4HJXDG0FW000001', stock: 'A2' },
      { vin: 'BAD', stock: 'B1' },
      { vin: '1C4RJFBG0FW000002', stock: 'bad stock!!' },
    ]);
    expect(r.accepted.map((v) => v.vin)).toEqual(['1C4HJXDG0FW000001']);
    expect(r.duplicateVinCount).toBe(1);
    expect(r.invalidVinCount).toBe(1);
    expect(r.invalidStockCount).toBe(1);
    expect(shouldRejectFeedValidation(r)).toEqual(['duplicate_vin_in_feed:1']);
  });

  it('hard-rejects missing VIN header when required', () => {
    const r = validateNormalizedFeedVehicles([]);
    expect(
      shouldRejectFeedValidation(r, {
        requireVinHeader: true,
        hasVinHeader: false,
      }),
    ).toContain('schema_missing_vin_header');
  });
});
