import { parse } from 'csv-parse/sync';
import { CrmLeadRecord, CrmMessageRecord } from './crm-adapter';
import { Department } from '../crm-workforce.types';

/**
 * Permitted dealership data export → lead records (read-only).
 *
 * A manager exports leads from the CRM using the CRM's own export feature and uploads the CSV.
 * Records are `verified: true` because they come from the authoritative CRM, with `asOf` set to
 * the export time the uploader states — never "now".
 *
 * Columns are matched by header name (case/space-insensitive). Columns that could carry
 * sensitive data are refused outright, so an over-broad export cannot bring it in.
 */
const FORBIDDEN =
  /(ssn|social|license|licence|dob|birth|credit|score|income|bank|routing|account ?number|employer)/i;

const ALIASES: Record<string, string[]> = {
  sourceRecordId: ['lead id', 'leadid', 'id', 'opportunity id', 'record id'],
  firstName: ['first name', 'firstname', 'first'],
  lastName: ['last name', 'lastname', 'last'],
  phone: ['phone', 'mobile', 'cell', 'phone number', 'mobile phone'],
  email: ['email', 'email address'],
  language: ['language', 'preferred language'],
  leadSource: ['source', 'lead source'],
  crmStatus: ['status', 'lead status', 'pipeline status'],
  assignedTo: ['assigned to', 'salesperson', 'owner', 'assigned', 'bdc rep'],
  department: ['department', 'lead type', 'type'],
  year: ['year', 'vehicle year'],
  make: ['make', 'vehicle make'],
  model: ['model', 'vehicle model'],
  vin: ['vin'],
  stock: ['stock', 'stock number', 'stock #'],
  createdInCrmAt: ['created', 'created date', 'lead date', 'created at'],
  lastInboundAt: ['last inbound', 'last customer contact', 'last response'],
  lastOutboundAt: ['last outbound', 'last contacted', 'last attempt'],
  lastInboundText: ['last inbound message', 'last customer message'],
  nextFollowUpAt: [
    'next follow up',
    'next task',
    'next activity',
    'follow up date',
  ],
  appointmentState: ['appointment status', 'appt status'],
  appointmentAt: ['appointment date', 'appt date', 'appointment'],
  visitedAt: ['visit date', 'showroom visit', 'visited'],
  doNotContact: ['do not contact', 'dnc', 'opt out', 'do not text'],
};

const norm = (s: string) =>
  s
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

export type ImportResult = {
  records: CrmLeadRecord[];
  rejectedRows: Array<{ row: number; reason: string }>;
  ignoredColumns: string[];
};

export class ExportImportError extends Error {}

export function parseCrmExport(
  csv: string,
  opts: { exportedAt: Date; now?: Date },
): ImportResult {
  if (csv.length > 5_000_000) throw new ExportImportError('file_too_large');
  let rows: Record<string, string>[];
  try {
    rows = parse(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    }) as Record<string, string>[];
  } catch {
    throw new ExportImportError('not_valid_csv');
  }
  if (rows.length === 0)
    return { records: [], rejectedRows: [], ignoredColumns: [] };
  if (rows.length > 20_000) throw new ExportImportError('too_many_rows');

  const headers = Object.keys(rows[0]);
  const forbidden = headers.filter((h) => FORBIDDEN.test(h));
  if (forbidden.length)
    throw new ExportImportError(
      `sensitive_columns_not_accepted:${forbidden.map(norm).join('|')}`,
    );

  const col: Record<string, string | undefined> = {};
  for (const [field, names] of Object.entries(ALIASES))
    col[field] = headers.find((h) => names.includes(norm(h)));
  if (!col.sourceRecordId)
    throw new ExportImportError('missing_lead_id_column');
  const used = new Set(Object.values(col).filter(Boolean));
  const ignoredColumns = headers.filter((h) => !used.has(h));

  const now = opts.now ?? new Date();
  const asOf = opts.exportedAt.toISOString();
  const records: CrmLeadRecord[] = [];
  const rejectedRows: ImportResult['rejectedRows'] = [];
  const seen = new Set<string>();

  rows.forEach((r, idx) => {
    const get = (f: string) =>
      col[f] ? (r[col[f] as string] ?? '').trim() : '';
    const id = get('sourceRecordId');
    if (!id)
      return rejectedRows.push({ row: idx + 2, reason: 'missing_lead_id' });
    if (seen.has(id))
      return rejectedRows.push({ row: idx + 2, reason: 'duplicate_lead_id' });
    seen.add(id);

    const lastIn = date(get('lastInboundAt'));
    const lastOut = date(get('lastOutboundAt'));
    const messages: CrmMessageRecord[] = [];
    if (lastOut)
      messages.push({
        sourceRecordId: `${id}:out:${lastOut}`,
        direction: 'OUTBOUND',
        channel: 'CALL',
        authorType: 'STAFF',
        body: '[outbound contact recorded in CRM export]',
        occurredAt: lastOut,
      });
    if (lastIn)
      messages.push({
        sourceRecordId: `${id}:in:${lastIn}`,
        direction: 'INBOUND',
        channel: 'SMS',
        authorType: 'CUSTOMER',
        body:
          get('lastInboundText') ||
          '[customer contact recorded in CRM export — text not included]',
        occurredAt: lastIn,
      });

    const next = date(get('nextFollowUpAt'));
    const dnc = get('doNotContact');
    records.push({
      sourceRecordId: id,
      asOf,
      verified: true,
      synthetic: false,
      department: department(get('department')),
      firstName: get('firstName') || null,
      lastName: get('lastName') || null,
      phone: get('phone') || null,
      email: get('email') || null,
      language: get('language')
        ? get('language').slice(0, 5).toLowerCase()
        : null,
      leadSource: get('leadSource') || null,
      crmStatus: get('crmStatus') || null,
      assignedTo: get('assignedTo') || null,
      vehicleInterest:
        get('make') || get('model') || get('vin')
          ? {
              year: Number(get('year')) || undefined,
              make: get('make') || undefined,
              model: get('model') || undefined,
              vin: get('vin') || undefined,
              stock: get('stock') || undefined,
            }
          : null,
      createdInCrmAt: date(get('createdInCrmAt')),
      hasFutureFollowUp: !!next && new Date(next).getTime() > now.getTime(),
      appointmentState: apptState(get('appointmentState')),
      appointmentAt: date(get('appointmentAt')),
      visitedAt: date(get('visitedAt')),
      doNotContact: col.doNotContact ? /^(y|yes|true|1|x)$/i.test(dnc) : null,
      humanActiveUntil: null,
      messages,
    });
  });
  return { records, rejectedRows, ignoredColumns };
}

function date(s: string): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function department(s: string): Department {
  const v = s.toLowerCase();
  if (v.includes('service')) return 'SERVICE';
  if (v.includes('part')) return 'PARTS';
  return 'SALES';
}
function apptState(s: string): CrmLeadRecord['appointmentState'] {
  const v = s.toLowerCase();
  if (!v) return 'NONE';
  if (/(miss|no.?show)/.test(v)) return 'MISSED';
  if (/(show|arriv|complet)/.test(v)) return 'SHOWN';
  if (/cancel/.test(v)) return 'CANCELLED';
  if (/(sched|confirm|set|book)/.test(v)) return 'SCHEDULED';
  if (/(propos|request|pending)/.test(v)) return 'PROPOSED';
  return 'NONE';
}
