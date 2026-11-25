import { Injectable } from '@nestjs/common';
import { CrmWfLead, CrmWfMessage } from '@prisma/client';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'crypto';
import { normalizeEndpoint } from '../messaging/consent.service';

/** A mirror row with its contact fields opened for use in memory. Never persisted or logged. */
export type LeadView = Omit<
  CrmWfLead,
  'lastNameEnc' | 'phoneEnc' | 'emailEnc'
> & { lastName: string | null; phone: string | null; email: string | null };
export type MsgView = Omit<CrmWfMessage, 'bodyEnc'> & { body: string };

export class CrmWfVaultKeyError extends Error {
  constructor() {
    super('crm_workforce_data_key_missing');
  }
}

/** Short public identifier of a sealing key, stored with each value so the right key opens it. */
const kidOf = (raw: string) =>
  createHash('sha256').update(`crmwf:kid:${raw}`).digest('hex').slice(0, 8);
const derive = (label: string, raw: string) =>
  createHash('sha256').update(`crmwf:${label}:${raw}`).digest();
type SealKey = { kid: string; enc: Buffer };

/**
 * Field-level protection for customer data held by the CRM Workforce.
 *
 *   - phone, email, last name and message text are sealed with AES-256-GCM before they reach
 *     the database; a database dump or a stray SELECT shows no contact data;
 *   - lookups and duplicate detection use a keyed HMAC of the normalized endpoint, so "is this
 *     number suppressed?" never needs the number in a WHERE clause or an index;
 *   - without a key the vault fails closed: nothing can be stored or read.
 *
 * Keys
 *   CRM_WORKFORCE_DATA_KEY            current sealing key (≥32 chars); falls back to the
 *                                     platform's INTEGRATION_ENCRYPTION_KEY
 *   CRM_WORKFORCE_DATA_KEY_PREVIOUS   retired sealing keys, comma-separated; open only
 *   CRM_WORKFORCE_HASH_KEY            key for lookup hashes; defaults to the sealing key
 *
 * Rotation re-seals values under the new key (CrmWfKeyRotationService) and never changes the
 * lookup hashes: an erased customer's opt-out survives only as a hash, so changing the hash key
 * would silently forget it. Before rotating, pin CRM_WORKFORCE_HASH_KEY to the key the hashes
 * were made with. New values are written as `v2.<kid>.…`; older `v1.…` values carry no key id
 * and are opened by trying the current key, then each previous key.
 */
@Injectable()
export class CrmWfVaultService {
  private current(): string {
    const raw =
      process.env.CRM_WORKFORCE_DATA_KEY ||
      process.env.INTEGRATION_ENCRYPTION_KEY ||
      '';
    if (raw.length < 32) throw new CrmWfVaultKeyError();
    return raw;
  }

  /** Current key first, then retired keys usable only for opening. */
  private sealKeys(): SealKey[] {
    const raws = [
      this.current(),
      ...(process.env.CRM_WORKFORCE_DATA_KEY_PREVIOUS ?? '')
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k.length >= 32),
    ];
    const seen = new Set<string>();
    return raws
      .map((r) => ({ kid: kidOf(r), enc: derive('seal', r) }))
      .filter((k) => !seen.has(k.kid) && !!seen.add(k.kid));
  }

  private macKey(): Buffer {
    const h = process.env.CRM_WORKFORCE_HASH_KEY;
    if (h !== undefined && h !== '' && h.length < 32)
      throw new CrmWfVaultKeyError();
    return derive('hash', h || this.current());
  }

  isReady(): boolean {
    try {
      this.sealKeys();
      this.macKey();
      return true;
    } catch {
      return false;
    }
  }

  /** Id of the key new values are sealed with (safe to show; reveals nothing about the key). */
  currentKeyId(): string {
    return this.sealKeys()[0].kid;
  }

  /** Which key a stored value was sealed with: a key id, 'v1' (no id recorded) or null. */
  keyIdOf(sealed: string | null | undefined): string | null {
    if (!sealed) return null;
    const parts = sealed.split('.');
    if (parts[0] === 'v2') return parts[1] ?? null;
    if (parts[0] === 'v1') return 'v1';
    return null;
  }

  /** True when the value is already sealed with the current key and needs no re-seal. */
  isCurrent(sealed: string | null | undefined): boolean {
    return !sealed || this.keyIdOf(sealed) === this.currentKeyId();
  }

  seal(plain: string | null | undefined): string | null {
    if (plain === null || plain === undefined || plain === '') return null;
    const k = this.sealKeys()[0];
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', k.enc, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `v2.${k.kid}.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
  }

  open(sealed: string | null | undefined): string | null {
    if (!sealed) return null;
    const parts = sealed.split('.');
    let candidates: SealKey[];
    let iv: string, tag: string, ct: string;
    if (parts[0] === 'v2' && parts.length === 5) {
      [, , iv, tag, ct] = parts;
      const k = this.sealKeys().find((x) => x.kid === parts[1]);
      // Sealed with a key that is no longer configured: fail loudly, never return garbage.
      if (!k) throw new CrmWfVaultKeyError();
      candidates = [k];
    } else if (parts[0] === 'v1' && parts.length === 4) {
      [, iv, tag, ct] = parts;
      candidates = this.sealKeys();
    } else return null;
    for (const k of candidates) {
      try {
        const d = createDecipheriv(
          'aes-256-gcm',
          k.enc,
          Buffer.from(iv, 'base64url'),
        );
        d.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([
          d.update(Buffer.from(ct, 'base64url')),
          d.final(),
        ]).toString('utf8');
      } catch {
        /* wrong key for a v1 value: try the next one */
      }
    }
    throw new CrmWfVaultKeyError();
  }

  /** Keyed hash of a NORMALIZED endpoint. Same value for a phone whether SMS or CALL. */
  hash(normalized: string): string {
    return createHmac('sha256', this.macKey()).update(normalized).digest('hex');
  }

  /** Normalize + hash a raw phone / email. Null when the value is not a usable endpoint. */
  endpoint(
    channel: 'SMS' | 'EMAIL',
    raw: string | null | undefined,
  ): { normalized: string; hash: string; hint: string } | null {
    if (!raw) return null;
    const normalized = normalizeEndpoint(channel, raw);
    if (!normalized) return null;
    return {
      normalized,
      hash: this.hash(normalized),
      hint:
        channel === 'EMAIL'
          ? normalized.replace(/^(.).*(@.*)$/, '$1…$2')
          : `…${normalized.slice(-4)}`,
    };
  }

  /** Columns to write for a lead's contact data. */
  sealContact(c: {
    lastName?: string | null;
    phone?: string | null;
    email?: string | null;
  }) {
    const sms = this.endpoint('SMS', c.phone);
    const email = this.endpoint('EMAIL', c.email);
    return {
      lastNameEnc: this.seal(c.lastName),
      // The normalized form is what is sealed: one canonical value per endpoint.
      phoneEnc: this.seal(sms?.normalized ?? null),
      emailEnc: this.seal(email?.normalized ?? null),
      phoneHash: sms?.hash ?? null,
      emailHash: email?.hash ?? null,
      phoneLast4: sms ? sms.normalized.slice(-4) : null,
    };
  }

  lead<T extends CrmWfLead>(row: T): LeadView & Omit<T, keyof CrmWfLead> {
    const { lastNameEnc, phoneEnc, emailEnc, ...rest } = row;
    return {
      ...rest,
      lastName: this.open(lastNameEnc),
      phone: this.open(phoneEnc),
      email: this.open(emailEnc),
    } as unknown as LeadView & Omit<T, keyof CrmWfLead>;
  }

  message(row: CrmWfMessage): MsgView {
    const { bodyEnc, ...rest } = row;
    return { ...rest, body: this.open(bodyEnc) ?? '' };
  }

  messages(rows: CrmWfMessage[]): MsgView[] {
    return rows.map((r) => this.message(r));
  }

  /** Open a lead loaded with its messages. */
  withMessages(
    row: CrmWfLead & { messages: CrmWfMessage[] },
  ): LeadView & { messages: MsgView[] } {
    const { messages, ...lead } = row;
    return {
      ...this.lead(lead as CrmWfLead),
      messages: this.messages(messages),
    };
  }
}

/** Source id prefix of a message an employee typed in (not read from the CRM). */
export const STAFF_ENTERED_PREFIX = 'staff:';

/** Is this contact a reserved test value that cannot belong to a real person? */
export function isReservedTestContact(c: {
  phone?: string | null;
  email?: string | null;
}): boolean {
  const digits = (c.phone ?? '')
    .replace(/\D/g, '')
    .replace(/^1(?=\d{10}$)/, '');
  // NANP fictional range: NXX-555-0100 … 0199.
  const phoneOk = !c.phone || /^\d{3}55501\d{2}$/.test(digits);
  const emailOk =
    !c.email ||
    /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|[a-z0-9-]+\.(?:invalid|test|example))$/i.test(
      c.email.trim(),
    ) ||
    /\.(invalid|test|example)$/i.test(c.email.trim());
  return phoneOk && emailOk;
}

/**
 * Is a whole uploaded file made only of reserved test contacts?
 * Decided from EVERY cell, not from the mapped columns — a real phone number or email in an
 * unmapped or mis-mapped column makes the file real. A row with no contact at all is also
 * treated as real: names and messages without a test contact cannot be shown to be synthetic.
 */
export function fileIsSynthetic(
  rawFile: string,
  records: Array<{ phone?: string | null; email?: string | null }>,
): boolean {
  if (!records.length) return true;
  if (!records.every((r) => (r.phone || r.email) && isReservedTestContact(r)))
    return false;
  for (const m of rawFile.match(/[^\s,;"'<>()]+@[^\s,;"'<>()]+\.[a-z]{2,}/gi) ??
    [])
    if (!isReservedTestContact({ email: m })) return false;
  // Anything shaped like a North American phone number, wherever it sits in the file.
  for (const m of rawFile.match(
    /(?<![\d.:T-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\d:])/g,
  ) ?? []) {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 10) continue;
    if (!isReservedTestContact({ phone: m })) return false;
  }
  return true;
}

/** Remove contact details and long free text from anything headed for the audit log. */
export function auditSafe<T>(value: T): T {
  const scrub = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string')
      return v
        .replace(/[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}/gi, '[email]')
        .replace(/\+?\d[\d\s().-]{8,}\d/g, '[phone]')
        .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted]')
        .slice(0, 300);
    if (Array.isArray(v))
      return depth > 4 ? [] : v.slice(0, 50).map((x) => scrub(x, depth + 1));
    if (v && typeof v === 'object') {
      if (depth > 4) return {};
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          /^(phone|email|lastName|body|endpoint|csv)$/i.test(k)
            ? '[omitted]'
            : scrub(x, depth + 1),
        ]),
      );
    }
    return v;
  };
  return scrub(value, 0) as T;
}
