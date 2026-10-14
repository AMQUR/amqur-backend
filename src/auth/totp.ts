import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** RFC 4648 base32 (no padding) + RFC 6238 TOTP (SHA-1, 6 digits, 30s) — standard authenticator apps. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code =
    ((h[off] & 0x7f) << 24) |
    (h[off + 1] << 16) |
    (h[off + 2] << 8) |
    h[off + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totp(secretB32: string, at = Date.now(), step = 30): string {
  return hotp(base32Decode(secretB32), Math.floor(at / 1000 / step));
}

/** Accepts ±1 step for clock drift. Returns the matched counter (for replay protection) or null. */
export function verifyTotp(
  secretB32: string,
  code: string,
  at = Date.now(),
  step = 30,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const now = Math.floor(at / 1000 / step);
  for (const c of [now - 1, now, now + 1]) {
    const want = Buffer.from(hotp(key, c));
    if (timingSafeEqual(want, Buffer.from(code))) return c;
  }
  return null;
}

export function otpauthUri(params: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  return `otpauth://totp/${label}?secret=${params.secret}&issuer=${encodeURIComponent(params.issuer)}&algorithm=SHA1&digits=6&period=30`;
}
