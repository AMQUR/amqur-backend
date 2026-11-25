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

/**
 * Field-level protection for customer data held by the CRM Workforce.
 *
 *   - phone, email, last name and message text are sealed with AES-256-GCM before they reach
 *     the database; a database dump or a stray SELECT shows no contact data;
 *   - lookups and duplicate detection use a keyed HMAC of the normalized endpoint, so "is this
 *     number suppressed?" never needs the number in a WHERE clause or an index;
 *   - without a key the vault fails closed: nothing can be stored or read.
 *
 * Key: CRM_WORKFORCE_DATA_KEY (≥32 chars), else the platform's INTEGRATION_ENCRYPTION_KEY.
 * Separate sub-keys are derived for sealing and for hashing. Rotating the key requires a
 * re-seal job (not built yet); `v1.` prefixes every sealed value so one can be added.
 */
@Injectable()
export class CrmWfVaultService {
  private keys(): { enc: Buffer; mac: Buffer } {
    const raw =
      process.env.CRM_WORKFORCE_DATA_KEY ||
      process.env.INTEGRATION_ENCRYPTION_KEY ||
      '';
    if (raw.length < 32) throw new CrmWfVaultKeyError();
    const d = (label: string) =>
      createHash('sha256').update(`crmwf:${label}:${raw}`).digest();
    return { enc: d('seal'), mac: d('hash') };
  }

  isReady(): boolean {
    try {
      this.keys();
      return true;
    } catch {
      return false;
    }
  }

  seal(plain: string | null | undefined): string | null {
    if (plain === null || plain === undefined || plain === '') return null;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.keys().enc, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
  }

  open(sealed: string | null | undefined): string | null {
    if (!sealed) return null;
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || ct === undefined) return null;
    const d = createDecipheriv(
      'aes-256-gcm',
      this.keys().enc,
      Buffer.from(iv, 'base64url'),
    );
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      d.update(Buffer.from(ct, 'base64url')),
      d.final(),
    ]).toString('utf8');
  }

  /** Keyed hash of a NORMALIZED endpoint. Same value for a phone whether SMS or CALL. */
  hash(normalized: string): string {
    return createHmac('sha256', this.keys().mac)
      .update(normalized)
      .digest('hex');
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
    return { ...this.lead(lead as CrmWfLead), messages: this.messages(messages) };
  }
}

/** Is this contact a reserved test value that cannot belong to a real person? */
export function isReservedTestContact(c: {
  phone?: string | null;
  email?: string | null;
}): boolean {
  const digits = (c.phone ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
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

/** Remove contact details and long free text from anything headed for the audit log. */
export function auditSafe<T>(value: T): T {
  const scrub = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string')
      return v
        .replace(/[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}/gi, '[email]')
        .replace(/\+?\d[\d\s().-]{8,}\d/g, '[phone]')
        .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted]')
        .slice(0, 300);
    if (Array.isArray(v)) return depth > 4 ? [] : v.slice(0, 50).map((x) => scrub(x, depth + 1));
    if (v && typeof v === 'object') {
      if (depth > 4) return {};
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          /^(phone|email|lastName|body|endpoint|csv)$/i.test(k) ? '[omitted]' : scrub(x, depth + 1),
        ]),
      );
    }
    return v;
  };
  return scrub(value, 0) as T;
}
