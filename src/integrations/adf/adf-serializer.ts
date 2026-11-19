import {
  ADF_DEFAULT_MAX_BYTES,
  ADF_VERSION,
  AdfAppointmentFacts,
  AdfCommentFacts,
  AdfLeadDto,
  AdfVehicle,
} from './adf.types';

/** Thrown when a lead cannot be turned into a safe ADF document. `code` is PII-free. */
export class AdfSerializationError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const MAX = {
  ref: 128,
  name: 100,
  email: 254,
  phone: 32,
  short: 60,
  stock: 40,
  vendor: 120,
  commentField: 200,
  comments: 2000,
} as const;

const INTERESTS = new Set(['buy', 'lease', 'sell', 'trade-in', 'test-drive']);
/** Hard ceiling on vehicles in one prospect (interest vehicle + trade-ins). */
export const ADF_MAX_VEHICLES = 5;

/** True for code points XML 1.0 allows AND that are safe to hand to a CRM parser. */
function isSafeCodePoint(cp: number): boolean {
  if (cp === 0x9 || cp === 0xa || cp === 0xd) return true;
  if (cp < 0x20) return false; // C0 controls (incl. NUL) are illegal in XML 1.0
  if (cp >= 0x7f && cp <= 0x9f) return false; // DEL + C1 controls
  if (cp >= 0xd800 && cp <= 0xdfff) return false; // lone surrogates
  if (cp === 0xfffe || cp === 0xffff) return false; // non-characters
  if ((cp & 0xfffe) === 0xfffe) return false; // plane non-characters
  if (cp >= 0xfdd0 && cp <= 0xfdef) return false; // non-characters
  if (cp >= 0x202a && cp <= 0x202e) return false; // bidi embedding/override
  if (cp >= 0x2066 && cp <= 0x2069) return false; // bidi isolates
  if (cp === 0x200b || cp === 0x2060 || cp === 0xfeff) return false; // zero-width / BOM
  if (cp === 0x2028 || cp === 0x2029) return false; // line/paragraph separators
  return cp <= 0x10ffff;
}

/**
 * Normalise (NFC), drop every unsafe code point, collapse whitespace to single spaces, trim and
 * cap the length in code points. Returns '' when nothing usable is left.
 */
export function sanitizeAdfText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  let s = String(value);
  // toWellFormed-equivalent: iterating by code point yields lone surrogates as themselves,
  // which isSafeCodePoint drops.
  s = s.normalize('NFC');
  let out = '';
  let count = 0;
  let lastWasSpace = true;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (!isSafeCodePoint(cp)) continue;
    const isSpace = cp === 0x9 || cp === 0xa || cp === 0xd || cp === 0x20;
    if (isSpace) {
      if (lastWasSpace) continue;
      out += ' ';
      lastWasSpace = true;
    } else {
      out += ch;
      lastWasSpace = false;
    }
    count += 1;
    if (count >= maxLength) break;
  }
  return out.trim();
}

/** Hand-escape for both text nodes and attribute values. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const EMAIL_RE =
  /^[^\s@<>"'(),;:\\[\]]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

export function sanitizeEmail(value: unknown): string {
  const s = sanitizeAdfText(value, MAX.email).toLowerCase();
  return EMAIL_RE.test(s) ? s : '';
}

export function sanitizePhone(value: unknown): string {
  const s = sanitizeAdfText(value, 64).replace(/[^0-9+()\-. x]/gi, '');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  return s.trim().slice(0, MAX.phone);
}

function sanitizeVin(value: unknown): string {
  const s = sanitizeAdfText(value, 32).toUpperCase();
  return /^[A-Z0-9]{11,17}$/.test(s) ? s : '';
}

function sanitizeYear(value: unknown): string {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isInteger(n) && n >= 1900 && n <= 2100 ? String(n) : '';
}

function el(indent: string, name: string, text: string, attrs = ''): string {
  return `${indent}<${name}${attrs}>${escapeXml(text)}</${name}>`;
}

function vehicleXml(v: AdfVehicle): string[] {
  if (!INTERESTS.has(v.interest))
    throw new AdfSerializationError('adf_bad_vehicle_interest');
  const status = v.status === 'new' || v.status === 'used' ? v.status : '';
  const body: string[] = [];
  const year = sanitizeYear(v.year);
  const make = sanitizeAdfText(v.make, MAX.short);
  const model = sanitizeAdfText(v.model, MAX.short);
  const trim = sanitizeAdfText(v.trim, MAX.short);
  const vin = sanitizeVin(v.vin);
  const stock = sanitizeAdfText(v.stock, MAX.stock);
  if (year) body.push(el('      ', 'year', year));
  if (make) body.push(el('      ', 'make', make));
  if (model) body.push(el('      ', 'model', model));
  if (trim) body.push(el('      ', 'trim', trim));
  if (vin) body.push(el('      ', 'vin', vin));
  if (stock) body.push(el('      ', 'stock', stock));
  // A vehicle with no known fact is not a vehicle: omit it rather than emit an empty shell.
  if (body.length === 0) return [];
  const attrs =
    ` interest="${escapeXml(v.interest)}"` +
    (status ? ` status="${escapeXml(status)}"` : '');
  return [`    <vehicle${attrs}>`, ...body, '    </vehicle>'];
}

const yn = (v: boolean | null): string =>
  v === true ? 'yes' : v === false ? 'no' : 'not recorded';

/** A REQUESTED appointment is never worded as confirmed. */
export function describeAppointment(
  a: AdfAppointmentFacts | null | undefined,
): string {
  if (!a) return 'none requested';
  const type = sanitizeAdfText(a.type, 40);
  const when = sanitizeAdfText(a.when, 80);
  const detail = [type, when].filter(Boolean).join(' ');
  const suffix = detail ? ` (${detail})` : '';
  if (a.status === 'CONFIRMED' && a.availabilityVerified === true)
    return `CONFIRMED by dealership${suffix}`;
  if (
    a.status === 'REQUESTED' ||
    a.status === 'PENDING_CONFIRMATION' ||
    a.status === 'CONFIRMED' ||
    a.status === 'RESCHEDULED'
  )
    return `REQUESTED by customer - NOT confirmed, dealership must confirm${suffix}`;
  if (a.status === 'CANCELLED') return `cancelled${suffix}`;
  if (a.status === 'COMPLETED') return `completed${suffix}`;
  return `no-show${suffix}`;
}

/** Short structured note — never the chat transcript. */
export function buildAdfComments(c: AdfCommentFacts): string {
  const parts: string[] = [`Department: ${c.department}`];
  const action = sanitizeAdfText(c.requestedAction, MAX.commentField);
  if (action) parts.push(`Requested action: ${action}`);
  const pref = sanitizeAdfText(c.preferredContact, 40);
  if (pref) parts.push(`Preferred contact: ${pref}`);
  parts.push(`Appointment: ${describeAppointment(c.appointment)}`);
  parts.push(
    `Consent: text=${yn(c.consent.text)}, email=${yn(c.consent.email)}, call=${yn(c.consent.call)}`,
  );
  const source = sanitizeAdfText(c.source, 60);
  if (source) parts.push(`Source: ${source}`);
  const utm = [
    ['utm_source', sanitizeAdfText(c.utmSource, 80)],
    ['utm_medium', sanitizeAdfText(c.utmMedium, 80)],
    ['utm_campaign', sanitizeAdfText(c.utmCampaign, 80)],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`);
  if (utm.length) parts.push(`Attribution: ${utm.join(', ')}`);
  return sanitizeAdfText(parts.join('; '), MAX.comments);
}

/** The exact text values the serializer writes — used by the validator's round-trip check. */
export function normalizedAdfFields(dto: AdfLeadDto) {
  return {
    leadRef: sanitizeAdfText(dto.leadRef, MAX.ref),
    idSource: sanitizeAdfText(dto.idSource, MAX.short),
    vendorName: sanitizeAdfText(dto.vendorName, MAX.vendor),
    providerName: sanitizeAdfText(dto.providerName, MAX.short),
    firstName: sanitizeAdfText(dto.customer.firstName, MAX.name),
    lastName: sanitizeAdfText(dto.customer.lastName, MAX.name),
    email: sanitizeEmail(dto.customer.email),
    phone: sanitizePhone(dto.customer.phone),
    comments: buildAdfComments(dto.comments),
  };
}

/**
 * Pure, deterministic ADF 1.0 serializer: the same DTO always yields the same bytes. Every text
 * node and attribute is hand-escaped; no DTD, entity declaration, CDATA or comment is ever
 * produced.
 */
export function serializeAdf(
  dto: AdfLeadDto,
  opts: { maxBytes?: number } = {},
): string {
  const maxBytes = opts.maxBytes ?? ADF_DEFAULT_MAX_BYTES;
  const f = normalizedAdfFields(dto);
  if (!f.leadRef) throw new AdfSerializationError('adf_missing_lead_ref');
  if (!f.idSource) throw new AdfSerializationError('adf_missing_id_source');
  if (!f.vendorName) throw new AdfSerializationError('adf_missing_vendor');
  if (!f.providerName) throw new AdfSerializationError('adf_missing_provider');
  const date = new Date(dto.requestDate);
  if (typeof dto.requestDate !== 'string' || Number.isNaN(date.getTime()))
    throw new AdfSerializationError('adf_bad_request_date');
  if (!Array.isArray(dto.vehicles))
    throw new AdfSerializationError('adf_bad_vehicles');
  if (dto.vehicles.length > ADF_MAX_VEHICLES)
    throw new AdfSerializationError('adf_too_many_vehicles');

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<?adf version="${ADF_VERSION}"?>`,
    '<adf>',
    '  <prospect status="new">',
    el(
      '    ',
      'id',
      f.leadRef,
      ` sequence="1" source="${escapeXml(f.idSource)}"`,
    ),
    el('    ', 'requestdate', date.toISOString()),
  ];
  for (const v of dto.vehicles) lines.push(...vehicleXml(v));
  lines.push('    <customer>', '      <contact>');
  if (f.firstName)
    lines.push(el('        ', 'name', f.firstName, ' part="first"'));
  if (f.lastName)
    lines.push(el('        ', 'name', f.lastName, ' part="last"'));
  if (f.email) lines.push(el('        ', 'email', f.email));
  if (f.phone) {
    const type = dto.customer.phoneType === 'cellphone' ? 'cellphone' : 'voice';
    lines.push(el('        ', 'phone', f.phone, ` type="${type}"`));
  }
  lines.push('      </contact>');
  lines.push(el('      ', 'comments', f.comments));
  lines.push(
    '    </customer>',
    '    <vendor>',
    el('      ', 'vendorname', f.vendorName),
    '    </vendor>',
    '    <provider>',
    el('      ', 'name', f.providerName),
    '    </provider>',
    '  </prospect>',
    '</adf>',
    '',
  );
  const xml = lines.join('\n');
  if (Buffer.byteLength(xml, 'utf8') > maxBytes)
    throw new AdfSerializationError('adf_too_large');
  return xml;
}
