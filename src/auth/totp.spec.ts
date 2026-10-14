import { base32Decode, base32Encode, hotp, verifyTotp, totp } from './totp';

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  // RFC 4226 Appendix D: secret "12345678901234567890"
  const key = Buffer.from('12345678901234567890');
  it('matches RFC 4226 HOTP test vectors', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expected.forEach((code, i) => expect(hotp(key, i)).toBe(code));
  });
  it('matches RFC 6238 TOTP vector (T=59s → 94287082 truncated to 6 digits)', () => {
    expect(totp(base32Encode(key), 59_000)).toBe('287082');
  });
  it('base32 round-trips', () => {
    expect(base32Decode(base32Encode(key)).equals(key)).toBe(true);
  });
  it('accepts ±1 step drift only and rejects malformed codes', () => {
    const s = base32Encode(key);
    const t = 1_000_000_000_000;
    expect(verifyTotp(s, totp(s, t - 30_000), t)).not.toBeNull();
    expect(verifyTotp(s, totp(s, t - 90_000), t)).toBeNull();
    expect(verifyTotp(s, '12345', t)).toBeNull();
  });
});
