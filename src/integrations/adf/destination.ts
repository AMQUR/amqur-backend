import { createHash, createHmac } from 'crypto';

/** Thrown for a value that must never reach a mail header / envelope. */
export class UnsafeHeaderValueError extends Error {
  constructor(public readonly field: string) {
    super(`unsafe_header_value:${field}`);
  }
}

/** Reject CR/LF (and other control characters) in any header-bound value. */
export function assertHeaderSafe(field: string, value: string): string {
  // eslint-disable-next-line no-control-regex
  const unsafe = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/;
  if (typeof value !== 'string' || unsafe.test(value))
    throw new UnsafeHeaderValueError(field);
  return value;
}

const ADDRESS_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/**
 * Normalize ONE bare mailbox (no display name, no list, no comments). Returns null when the
 * value is not a single plain address — a route can never hold "a@x, b@y" or a CC list.
 */
export function normalizeDestination(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (s.length > 254 || !ADDRESS_RE.test(s)) return null;
  return s;
}

export function destinationDomain(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/** `leads@dialexample.net` → `l***@d***.net` */
export function maskDestination(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return '***';
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local[0]}***@${domain[0]}***${tld}`;
}

/**
 * Keyed, non-reversible fingerprint of a destination (HMAC-SHA256). Keyed so a low-entropy
 * mailbox name cannot be recovered by brute force from a row alone.
 */
export function fingerprintDestination(
  address: string,
  keyMaterial: string,
): string {
  const key = createHash('sha256')
    .update(`adf-destination-fingerprint:${keyMaterial}`)
    .digest();
  return createHmac('sha256', key).update(address).digest('hex');
}

const RESERVED_TLDS = ['invalid', 'test', 'example', 'localhost'];
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

/** RFC 2606 / RFC 6761 reserved names — mail to these can never reach a real mailbox. */
export function isReservedTestDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace(/\.$/, '');
  if (RESERVED_TLDS.some((t) => d === t || d.endsWith(`.${t}`))) return true;
  return RESERVED_DOMAINS.some((r) => d === r || d.endsWith(`.${r}`));
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === 'localhost';
}
