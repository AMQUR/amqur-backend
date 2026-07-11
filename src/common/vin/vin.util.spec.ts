import {
  isValidVinFormat,
  isValidVinCheckDigit,
  normalizeVin,
  extractVinCandidates,
} from './vin.util';

describe('VIN utilities', () => {
  it('normalizes and validates format', () => {
    expect(normalizeVin(' 1hgcm82633a004352 ')).toBe('1HGCM82633A004352');
    expect(isValidVinFormat('1HGCM82633A004352')).toBe(true);
    expect(isValidVinFormat('1HGCM82633A00435')).toBe(false);
    expect(isValidVinFormat('1HGCM82633I004352')).toBe(false); // I illegal
  });

  it('validates ISO 3779 check digit', () => {
    // Well-known valid VIN
    expect(isValidVinCheckDigit('1HGCM82633A004352')).toBe(true);
    expect(isValidVinCheckDigit('1HGCM82633A004353')).toBe(false);
  });

  it('extracts VIN candidates from free text', () => {
    const text = 'Looking at VIN 1HGCM82633A004352 please';
    expect(extractVinCandidates(text)).toEqual(['1HGCM82633A004352']);
  });
});
