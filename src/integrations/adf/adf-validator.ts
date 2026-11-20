import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ADF_DEFAULT_MAX_BYTES, ADF_VERSION, AdfLeadDto } from './adf.types';
import { normalizedAdfFields } from './adf-serializer';

export type AdfParsedSummary = {
  /** `<prospect status>`: `new` for a lead, `resend` for an R8 appointment update. */
  prospectStatus: 'new' | 'resend';
  leadRef: string;
  idSource: string;
  requestDate: string;
  vendorName: string;
  providerName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  comments: string | null;
  vehicleCount: number;
};

export type AdfValidationResult =
  | { ok: true; summary: AdfParsedSummary }
  | { ok: false; code: string };

const ILLEGAL_XML_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;
const PROLOG = `<?xml version="1.0" encoding="UTF-8"?>\n<?adf version="${ADF_VERSION}"?>\n<adf>`;

const asArray = <T>(v: T | T[] | undefined | null): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
const text = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && '#text' in (v as object)) {
    const t = (v as Record<string, unknown>)['#text'];
    return typeof t === 'string' ? t : null;
  }
  return null;
};

/**
 * Hardened re-parse of a produced ADF document. Rejects (before parsing) anything over the size
 * cap and any DTD / entity declaration / CDATA / illegal control character, so no entity
 * expansion or external reference can ever be evaluated; then checks well-formedness and the
 * required ADF structure. A document that fails here is never sent.
 *
 * `prospectStatus` is the ONE status the caller expects (default `new`). An appointment update
 * must ask for `resend` explicitly; a lead document that came out as `resend`, or an update
 * that came out as `new`, fails.
 */
export function validateAdfXml(
  xml: unknown,
  opts: { maxBytes?: number; prospectStatus?: 'new' | 'resend' } = {},
): AdfValidationResult {
  if (typeof xml !== 'string' || xml.length === 0)
    return { ok: false, code: 'adf_empty' };
  const maxBytes = opts.maxBytes ?? ADF_DEFAULT_MAX_BYTES;
  if (Buffer.byteLength(xml, 'utf8') > maxBytes)
    return { ok: false, code: 'adf_too_large' };
  if (/<!DOCTYPE/i.test(xml)) return { ok: false, code: 'adf_dtd_forbidden' };
  if (/<!ENTITY/i.test(xml)) return { ok: false, code: 'adf_entity_forbidden' };
  if (xml.includes('<![CDATA['))
    return { ok: false, code: 'adf_cdata_forbidden' };
  if (ILLEGAL_XML_CHARS.test(xml))
    return { ok: false, code: 'adf_illegal_character' };
  if (!xml.startsWith(PROLOG)) return { ok: false, code: 'adf_bad_prolog' };
  // Only the five predefined entities may appear (plus numeric refs are not produced at all).
  const refs = xml.match(/&[^;\s]{0,32};?/g) ?? [];
  if (refs.some((r) => !/^&(amp|lt|gt|quot|apos);$/.test(r)))
    return { ok: false, code: 'adf_unexpected_entity' };

  if (XMLValidator.validate(xml) !== true)
    return { ok: false, code: 'adf_not_well_formed' };

  let doc: Record<string, any>;
  try {
    doc = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: true,
      processEntities: true,
      htmlEntities: false,
      ignoreDeclaration: true,
      ignorePiTags: true,
    }).parse(xml) as Record<string, any>;
  } catch {
    return { ok: false, code: 'adf_parse_failed' };
  }

  const prospects = asArray(doc?.adf?.prospect);
  if (prospects.length !== 1) return { ok: false, code: 'adf_prospect_count' };
  const p = prospects[0] as Record<string, any>;
  const prospectStatus = opts.prospectStatus === 'resend' ? 'resend' : 'new';
  if (p['@_status'] !== prospectStatus)
    return { ok: false, code: 'adf_prospect_status' };

  const ids = asArray(p.id);
  const leadRef = ids.length === 1 ? text(ids[0]) : null;
  const idSource = ids.length === 1 ? ids[0]?.['@_source'] : null;
  if (!leadRef || typeof idSource !== 'string' || !idSource)
    return { ok: false, code: 'adf_missing_id' };
  if (ids[0]?.['@_sequence'] !== '1')
    return { ok: false, code: 'adf_bad_id_sequence' };

  const requestDate = text(p.requestdate);
  if (!requestDate || Number.isNaN(new Date(requestDate).getTime()))
    return { ok: false, code: 'adf_bad_requestdate' };

  const vehicles = asArray(p.vehicle) as Array<Record<string, any>>;
  for (const v of vehicles) {
    if (
      !['buy', 'lease', 'sell', 'trade-in', 'test-drive'].includes(
        v?.['@_interest'],
      )
    )
      return { ok: false, code: 'adf_bad_vehicle_interest' };
    const st = v?.['@_status'];
    if (st !== undefined && st !== 'new' && st !== 'used')
      return { ok: false, code: 'adf_bad_vehicle_status' };
  }

  const customers = asArray(p.customer);
  if (customers.length !== 1)
    return { ok: false, code: 'adf_missing_customer' };
  const customer = customers[0] as Record<string, any>;
  if (typeof customer !== 'object' || !('contact' in customer))
    return { ok: false, code: 'adf_missing_contact' };
  const contact =
    customer.contact && typeof customer.contact === 'object'
      ? (customer.contact as Record<string, any>)
      : {};
  const names = asArray(contact.name) as Array<Record<string, any> | string>;
  const namePart = (part: string): string | null => {
    const n = names.find(
      (x) => typeof x === 'object' && x?.['@_part'] === part,
    );
    return n ? text(n) : null;
  };

  const vendorName = text(asArray(p.vendor)[0]?.vendorname);
  if (!vendorName) return { ok: false, code: 'adf_missing_vendor' };

  return {
    ok: true,
    summary: {
      prospectStatus,
      leadRef,
      idSource,
      requestDate,
      vendorName,
      providerName: text(asArray(p.provider)[0]?.name),
      firstName: namePart('first'),
      lastName: namePart('last'),
      email: text(asArray(contact.email)[0]),
      phone: text(asArray(contact.phone)[0]),
      comments: text(customer.comments),
      vehicleCount: vehicles.length,
    },
  };
}

/**
 * Round-trip guard: what the hardened parser reads back must equal exactly what the serializer
 * meant to write. Catches any escaping defect (text bleeding into markup) before a send.
 */
export function validateAdfRoundTrip(
  dto: AdfLeadDto,
  xml: string,
  opts: { maxBytes?: number } = {},
): AdfValidationResult {
  // The expected status comes from the DTO itself, never from the produced XML.
  const res = validateAdfXml(xml, {
    ...opts,
    prospectStatus: dto.prospectStatus === 'resend' ? 'resend' : 'new',
  });
  if (!res.ok) return res;
  const want = normalizedAdfFields(dto);
  const got = res.summary;
  const same = (a: string, b: string | null) => (a || null) === (b || null);
  if (
    !same(want.leadRef, got.leadRef) ||
    !same(want.idSource, got.idSource) ||
    !same(want.vendorName, got.vendorName) ||
    !same(want.providerName, got.providerName) ||
    !same(want.firstName, got.firstName) ||
    !same(want.lastName, got.lastName) ||
    !same(want.email, got.email) ||
    !same(want.phone, got.phone) ||
    !same(want.comments, got.comments)
  )
    return { ok: false, code: 'adf_round_trip_mismatch' };
  return res;
}
