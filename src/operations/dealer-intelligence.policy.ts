/**
 * AMQUR / Dial Auto Group: strict projection for a PRIVATE, read-only analytics snapshot.
 * This module deliberately has no NestJS imports, external dependencies, or database access.
 * Inputs are the aggregate-report.json produced by the existing validated local builders.
 * It never promotes provisional deal candidates to delivered/sold vehicle counts.
 */

const STORE_NAMES: Record<string, string> = {
  chevy: 'Dial Chevy of Chicago',
  nissan: 'Dial Nissan of Chicago',
  infiniti: 'INFINITI of Chicago',
  'cdjr-south': 'Dial Chrysler Dodge Jeep Ram of Chicago (South)',
  'jeep-north': 'Jeep of Chicago (North CDJR)',
};
const STORES = Object.keys(STORE_NAMES);
const LINES = ['new', 'used', 'service', 'parts', 'other', 'unclassified'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /\b(?:\+?1[ -.])?\(?\d{3}\)?[ -.]\d{3}[ -.]\d{4}\b/;
const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/i;
const SECRET_RE =
  /\b(?:Bearer\s+[a-zA-Z0-9._-]{8,}|(?:api[_-]?key|client[_-]?secret|password)\s*[:=])/i;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  return value as Record<string, unknown>;
}
function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const diff = Object.keys(value).filter((key) => !allowed.includes(key));
  if (diff.length)
    throw new Error(
      `Invalid ${label}: unexpected fields (personal data prohibited)`,
    );
}
function list(value: unknown, label: string, max = 30000): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`Invalid ${label} array`);
  return value;
}
function text(value: unknown, label: string, max = 200): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    value.includes('\u0000') ||
    EMAIL_RE.test(value) ||
    PHONE_RE.test(value) ||
    VIN_RE.test(value) ||
    SECRET_RE.test(value)
  ) {
    throw new Error(`Invalid ${label}: expected privacy-safe text`);
  }
  return value;
}
function isoDate(value: unknown, label: string): string {
  const s = text(value, label, 10);
  const parsed = new Date(`${s}T00:00:00Z`);
  if (
    !DATE_RE.test(s) ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== s
  ) {
    throw new Error(`Invalid ${label} date`);
  }
  return s;
}
function count(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label} count`);
  }
  return value;
}
function amount(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1e12
  ) {
    throw new Error(`Invalid ${label} amount`);
  }
  return value;
}
function optionalCount(value: unknown, label: string): number | null {
  return value === null ? null : count(value, label);
}
function key(
  value: unknown,
  label: string,
  allowed: readonly string[],
): string {
  const s = text(value, label, 100);
  if (!allowed.includes(s)) throw new Error(`Unknown ${label}`);
  return s;
}
function noDuplicates(
  rows: Array<Record<string, unknown>>,
  properties: string[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const r of rows) {
    const token = properties.map((p) => String(r[p])).join('|');
    if (seen.has(token)) throw new Error(`Duplicate ${label} aggregate`);
    seen.add(token);
  }
}
export type SnapshotData = ReturnType<typeof projectDealerIntelligenceSnapshot>;

/** Validate and whitelist every field before a super-admin can retrieve a snapshot. */
export function projectDealerIntelligenceSnapshot(raw: unknown) {
  const input = object(raw, 'snapshot');
  exactKeys(
    input,
    [
      'schema',
      'name',
      'as_of',
      'status',
      'synthetic',
      'privacy',
      'engagement',
      'stores',
      'comparison',
      'periods',
      'coverage',
      'totals',
      'flags',
      'ads',
      'crm',
      'dms',
      'action_register',
      'notes',
    ],
    'snapshot',
  );
  if (
    input.schema !== 'amqur.dealer-intelligence.private-preview.v1' ||
    input.synthetic !== false ||
    input.name !== 'Dial Auto Group' ||
    input.privacy !== 'aggregate-only; no customer personal information'
  ) {
    throw new Error(
      'Unapproved snapshot schema, ownership, or synthetic input',
    );
  }
  const asOf = isoDate(input.as_of, 'as-of');
  const stores = list(input.stores, 'stores', 5).map((s) => {
    const item = object(s, 'store');
    exactKeys(item, ['key', 'name'], 'store');
    const storeKey = key(item.key, 'store', STORES);
    if (item.name !== STORE_NAMES[storeKey])
      throw new Error('Store identity mismatch');
    return { key: storeKey, name: STORE_NAMES[storeKey] };
  });
  if (stores.length !== 5 || new Set(stores.map((s) => s.key)).size !== 5)
    throw new Error('Expected five unique Dial rooftops');

  const ads = list(input.ads, 'ads').map((row) => {
    const r = object(row, 'ads row');
    exactKeys(
      r,
      [
        'date',
        'store',
        'platform',
        'business_line',
        'spend_usd',
        'impressions',
        'clicks',
        'reported_conversions',
      ],
      'ads row',
    );
    return {
      date: isoDate(r.date, 'ads date'),
      store: key(r.store, 'ads store', [...STORES, 'group']),
      platform: key(r.platform, 'ads platform', ['google_ads']),
      business_line: key(r.business_line, 'ads line', LINES),
      spend_usd: amount(r.spend_usd, 'ads spend'),
      impressions: count(r.impressions, 'ads impressions'),
      clicks: count(r.clicks, 'ads clicks'),
      reported_conversions: amount(
        r.reported_conversions,
        'ads platform conversions',
      ),
    };
  });
  noDuplicates(ads, ['date', 'store', 'platform', 'business_line'], 'ads');

  const crm = list(input.crm, 'crm').map((row) => {
    const r = object(row, 'crm row');
    exactKeys(
      r,
      [
        'date',
        'store',
        'business_line',
        'leads',
        'appointments',
        'shows',
        'sold',
      ],
      'crm row',
    );
    return {
      date: isoDate(r.date, 'crm date'),
      store: key(r.store, 'crm store', STORES),
      business_line: key(r.business_line, 'crm line', LINES),
      leads: count(r.leads, 'crm lead'),
      appointments: optionalCount(r.appointments, 'crm appointments'),
      shows: optionalCount(r.shows, 'crm shows'),
      sold: optionalCount(r.sold, 'crm sold'),
    };
  });
  noDuplicates(crm, ['date', 'store', 'business_line'], 'crm');

  const dms = list(input.dms, 'dms').map((row) => {
    const r = object(row, 'dms row');
    exactKeys(
      r,
      ['date', 'store', 'business_line', 'retail_candidates'],
      'dms row',
    );
    return {
      date: isoDate(r.date, 'dms date'),
      store: key(r.store, 'dms store', STORES),
      business_line: key(r.business_line, 'dms line', ['new', 'used']),
      retail_candidates: count(
        r.retail_candidates,
        'provisional deal candidates',
      ),
    };
  });
  noDuplicates(dms, ['date', 'store', 'business_line'], 'dms');
  if (crm.length === 0 || dms.length === 0)
    throw new Error('CRM and DMS source data are required');
  if ([...ads, ...crm, ...dms].some((row) => row.date > asOf))
    throw new Error('Snapshot includes observations after declared cutoff');

  const periods = list(input.periods, 'periods', 12).map((row) => {
    const r = object(row, 'period');
    exactKeys(r, ['id', 'label', 'start', 'end'], 'period');
    const start = isoDate(r.start, 'period start'),
      end = isoDate(r.end, 'period end');
    if (start > end || end > asOf) throw new Error('Invalid period bounds');
    return {
      id: key(r.id, 'period', [
        'last7',
        'prev',
        'prev2',
        'prev3',
        'mtd',
        'overlap',
      ]),
      label: text(r.label, 'period label', 80),
      start,
      end,
    };
  });
  if (
    new Set(periods.map((x) => x.id)).size !== periods.length ||
    !periods.some((x) => x.id === 'last7')
  ) {
    throw new Error('Missing or duplicate period');
  }
  const comparison = object(input.comparison, 'comparison');
  exactKeys(comparison, ['earlier', 'later'], 'comparison');
  const months = [
    text(comparison.earlier, 'earlier month', 7),
    text(comparison.later, 'later month', 7),
  ];
  if (!months.every((x) => /^\d{4}-\d{2}$/.test(x)) || months[0] >= months[1])
    throw new Error('Invalid month comparison');

  const coverage = object(input.coverage, 'coverage');
  exactKeys(coverage, ['ads', 'crm', 'dms'], 'coverage');
  const cleanedCoverage: Record<
    string,
    {
      rows: number;
      start: string | null;
      end: string | null;
      description: string;
    }
  > = {};
  for (const [source, rows] of [
    ['ads', ads],
    ['crm', crm],
    ['dms', dms],
  ] as const) {
    const c = object(coverage[source], `${source} coverage`);
    exactKeys(c, ['rows', 'start', 'end', 'description'], `${source} coverage`);
    const sorted = rows.map((r) => r.date).sort();
    const min = sorted[0] ?? null,
      max = sorted.at(-1) ?? null;
    if (c.rows !== rows.length || c.start !== min || c.end !== max)
      throw new Error(`${source} coverage does not match rows`);
    cleanedCoverage[source] = {
      rows: count(c.rows, `${source} rows`),
      start: min,
      end: max,
      description: text(c.description, `${source} description`, 230),
    };
  }
  const totals = object(input.totals, 'totals');
  exactKeys(
    totals,
    [
      'provisional_retail_candidates',
      'crm_purchase_lead_records',
      'connected_google_spend_usd',
      'unallocated_group_google_spend_usd',
    ],
    'totals',
  );
  const derivedRetail = dms.reduce((a, b) => a + b.retail_candidates, 0);
  const derivedLeads = crm.reduce((a, b) => a + b.leads, 0);
  const derivedSpend = ads.reduce((a, b) => a + b.spend_usd, 0);
  const derivedCentral = ads
    .filter((x) => x.store === 'group')
    .reduce((a, b) => a + b.spend_usd, 0);
  if (
    totals.provisional_retail_candidates !== derivedRetail ||
    totals.crm_purchase_lead_records !== derivedLeads ||
    Math.abs(
      amount(totals.connected_google_spend_usd, 'total Google spend') -
        derivedSpend,
    ) > 0.011 ||
    Math.abs(
      amount(totals.unallocated_group_google_spend_usd, 'group Google spend') -
        derivedCentral,
    ) > 0.011
  ) {
    throw new Error('Snapshot KPIs do not reconcile to source aggregates');
  }
  const actions = list(input.action_register, 'action register', 100).map(
    (row) => {
      const r = object(row, 'action');
      exactKeys(
        r,
        [
          'date',
          'store',
          'channel',
          'business_line',
          'asset',
          'expected_impact',
          'approved_by',
          'date_approved',
          'implemented',
          'date_implemented',
          'result_notes',
          'approval_status',
          'priority',
          'confidence',
          'issue',
          'evidence',
          'recommended_action',
        ],
        'action',
      );
      if (
        r.approval_status !== 'Needs Review' ||
        r.implemented !== 'No' ||
        r.approved_by !== '' ||
        r.date_approved !== '' ||
        r.date_implemented !== ''
      ) {
        throw new Error(
          'Source actions must remain unapproved and unimplemented',
        );
      }
      return {
        store: text(r.store, 'action store', 100),
        priority: key(r.priority, 'priority', [
          'Critical',
          'High',
          'Medium',
          'Low',
        ]),
        confidence: key(r.confidence, 'confidence', ['High', 'Medium', 'Low']),
        issue: text(r.issue, 'issue', 450),
        evidence: text(r.evidence, 'evidence', 1000),
        recommended_action: text(r.recommended_action, 'recommendation', 1000),
        approval_status: 'Needs Review' as const,
        implemented: 'No' as const,
      };
    },
  );
  const flags = list(input.flags, 'flags', 30).map((x) =>
    text(x, 'quality flag', 300),
  );
  const notes = list(input.notes, 'notes', 30).map((x) =>
    text(x, 'report note', 300),
  );
  const current = {
    schema: 'amqur.dealer-intelligence.private-preview.v1' as const,
    name: 'Dial Auto Group' as const,
    as_of: asOf,
    status: text(input.status, 'report status', 90),
    synthetic: false as const,
    privacy: 'aggregate-only; no customer personal information' as const,
    engagement: text(input.engagement, 'engagement', 100),
    stores,
    comparison: { earlier: months[0], later: months[1] },
    periods,
    coverage: cleanedCoverage,
    totals: {
      provisional_retail_candidates: derivedRetail,
      crm_purchase_lead_records: derivedLeads,
      connected_google_spend_usd: Math.round(derivedSpend * 100) / 100,
      unallocated_group_google_spend_usd:
        Math.round(derivedCentral * 100) / 100,
    },
    flags,
    notes,
    ads,
    crm,
    dms,
    action_register: actions,
  };
  return current;
}
