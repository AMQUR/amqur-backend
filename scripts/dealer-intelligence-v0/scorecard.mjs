import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const KINDS = {
  ads: ['date', 'store', 'platform', 'business_line', 'spend_usd', 'impressions', 'clicks', 'reported_conversions'],
  crm: ['date', 'store', 'business_line', 'leads', 'appointments', 'shows', 'sold'],
  web: ['date', 'store', 'sessions', 'vdps', 'form_submissions'],
  calls: ['date', 'store', 'inbound_calls', 'missed_calls'],
};
const COUNTS = new Set(['impressions', 'clicks', 'leads', 'appointments', 'shows', 'sold', 'sessions', 'vdps', 'form_submissions', 'inbound_calls', 'missed_calls']);
const METRICS = {
  ads: ['spend_usd', 'impressions', 'clicks', 'reported_conversions'],
  crm: ['leads', 'appointments', 'shows', 'sold'],
  web: ['sessions', 'vdps', 'form_submissions'],
  calls: ['inbound_calls', 'missed_calls'],
};
const PLATFORMS = new Set(['google_ads', 'meta_ads', 'microsoft_ads']);
const LINES = new Set(['new', 'used', 'service', 'parts', 'other', 'unclassified']);

export function parseCsv(text) {
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  const rows = [];
  let row = [], field = '', quoted = false, afterQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; afterQuote = true; }
      else field += c;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(field); field = ''; afterQuote = false;
      if (c !== ',') {
        if (row.some(x => x.trim() !== '')) rows.push(row);
        row = [];
        if (c === '\r' && text[i + 1] === '\n') i++;
      }
    } else if (c === '"' && field === '' && !afterQuote) { quoted = true; }
    else if (afterQuote || c === '"') { throw new Error('Malformed CSV: unexpected characters after quote'); }
    else field += c;
  }
  if (quoted) throw new Error('Malformed CSV: unclosed quote');
  if (field.length || row.length) { row.push(field); if (row.some(x => x.trim() !== '')) rows.push(row); }
  return rows;
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function parseInput(kind, text, allowedStores) {
  if (!KINDS[kind]) throw new Error(`Unsupported source: ${kind}`);
  const rows = parseCsv(text);
  if (!rows.length) throw new Error(`${kind}.csv is empty`);
  const header = rows.shift().map(x => x.trim());
  const expected = KINDS[kind];
  if (new Set(header).size !== header.length || header.length !== expected.length || !expected.every(h => header.includes(h))) {
    throw new Error(`${kind}.csv headers must be exactly ${expected.join(', ')}; extra columns (including personal data) are prohibited`);
  }
  const seen = new Set();
  return rows.map((values, index) => {
    if (values.length !== header.length) throw new Error(`${kind}.csv row ${index + 2}: incorrect field count`);
    const row = Object.fromEntries(header.map((h, i) => [h, values[i].trim()]));
    if (!validDate(row.date)) throw new Error(`${kind}.csv row ${index + 2}: invalid date`);
    if (!allowedStores.includes(row.store)) throw new Error(`${kind}.csv row ${index + 2}: unknown store`);
    if (kind === 'ads' && !PLATFORMS.has(row.platform)) throw new Error(`${kind}.csv row ${index + 2}: unknown platform`);
    if (['ads', 'crm'].includes(kind) && !LINES.has(row.business_line)) throw new Error(`${kind}.csv row ${index + 2}: unknown business line`);
    const key = kind === 'ads' ? [row.date, row.store, row.platform, row.business_line] :
      kind === 'crm' ? [row.date, row.store, row.business_line] : [row.date, row.store];
    const uniqueKey = key.join('|');
    if (seen.has(uniqueKey)) throw new Error(`${kind}.csv row ${index + 2}: duplicate aggregate key`);
    seen.add(uniqueKey);
    for (const metric of METRICS[kind]) {
      if (row[metric] === '') { row[metric] = null; continue; }
      if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(row[metric])) throw new Error(`${kind}.csv row ${index + 2}: invalid ${metric}`);
      const number = Number(row[metric]);
      if (!Number.isFinite(number) || (COUNTS.has(metric) && !Number.isSafeInteger(number))) {
        throw new Error(`${kind}.csv row ${index + 2}: invalid ${metric}`);
      }
      row[metric] = number;
    }
    if (kind === 'calls' && row.inbound_calls !== null && row.missed_calls !== null && row.missed_calls > row.inbound_calls) {
      throw new Error(`calls.csv row ${index + 2}: missed calls exceed inbound calls`);
    }
    return row;
  });
}

export function sevenDays(asOf) {
  if (!validDate(asOf)) throw new Error(`Invalid as-of date: ${asOf}`);
  return Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${asOf}T00:00:00Z`) - (6 - i) * 86400000).toISOString().slice(0, 10));
}

function total(rows, metric) {
  const observed = rows.map(x => x[metric]).filter(x => x !== null && x !== undefined);
  return observed.length ? Math.round(observed.reduce((a, b) => a + b, 0) * 10000) / 10000 : null;
}
function money(v) { return v === null ? 'N/A' : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function qty(v) { return v === null ? 'N/A' : v.toLocaleString('en-US', { maximumFractionDigits: 2 }); }
function coverage(rows) { return new Set(rows.map(x => x.date)).size; }
function datesTodayChicago() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = key => parts.find(x => x.type === key).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function createReport({ registry, datasets, asOf, synthetic = false }) {
  const days = sevenDays(asOf);
  const allow = new Set(days);
  const sources = Object.fromEntries(Object.keys(KINDS).map(kind => [kind, (datasets[kind] || []).filter(x => allow.has(x.date))]));
  const stores = registry.rooftops.map(r => ({ id: r.key, name: r.displayName }));
  if (stores.length !== 5 || new Set(stores.map(s => s.id)).size !== 5) throw new Error('Expected five unique Dial rooftop identities');
  const storeSummary = stores.map(store => {
    const r = Object.fromEntries(Object.keys(KINDS).map(kind => [kind, sources[kind].filter(x => x.store === store.id)]));
    return {
      ...store,
      coverage_days: Object.fromEntries(Object.keys(KINDS).map(kind => [kind, coverage(r[kind])])),
      metrics: {
        ad_spend_connected_usd: total(r.ads, 'spend_usd'),
        google_ads_spend_usd: total(r.ads.filter(x => x.platform === 'google_ads'), 'spend_usd'),
        reported_platform_conversions: total(r.ads, 'reported_conversions'),
        crm_leads: total(r.crm, 'leads'),
        appointments: total(r.crm, 'appointments'),
        shows: total(r.crm, 'shows'),
        crm_sold_statuses: total(r.crm, 'sold'),
        website_sessions: total(r.web, 'sessions'),
        vehicle_detail_views: total(r.web, 'vdps'),
        website_form_events: total(r.web, 'form_submissions'),
        inbound_calls: total(r.calls, 'inbound_calls'),
        missed_calls: total(r.calls, 'missed_calls'),
      },
    };
  });
  const centralAds = sources.ads.filter(x => x.store === 'group');
  const allAdsSpend = total(sources.ads, 'spend_usd');
  const actions = storeSummary.filter(s => s.metrics.ad_spend_connected_usd !== null && s.metrics.crm_leads === null).map(s => ({
    date: asOf, store: s.name, channel: 'Cross-channel', business_line: 'All', asset: 'CRM attribution / funnel reporting',
    issue: 'Paid media spend is visible but CRM outcomes have not been supplied',
    evidence: `${money(s.metrics.ad_spend_connected_usd)} connected-platform spend in ${days[0]} to ${asOf}; CRM export absent`,
    recommended_action: 'Obtain a store-level, PII-free Tekion lead/appointment/show/sold export and validate source-to-CRM definitions',
    expected_impact: 'Enables cost-per-qualified-lead and sales-funnel measurement; financial outcome unknown',
    priority: 'Critical', confidence: 'High', approval_status: 'Needs Review', approved_by: '', date_approved: '',
    implemented: 'No', date_implemented: '', result_notes: '',
  }));
  const quality = Object.keys(KINDS).map(kind => ({
    source: kind,
    window: `${days[0]} to ${asOf}`,
    observed_store_days: coverage(sources[kind]),
    rows: sources[kind].length,
    status: sources[kind].length ? 'Usable with limits' : 'Unreliable',
    issue: sources[kind].length ? 'Not reconciled to original system; missing rooftop/daily coverage may remain' : 'No records within the reporting window',
  }));
  const out = {
    product: 'AMQUR Dealer Intelligence v0', account: 'Dial Auto Group', fee_usd: 0,
    period_start: days[0], period_end: asOf, synthetic,
    data_status: synthetic ? 'SYNTHETIC DEMO - NOT REAL DEALERSHIP DATA' : 'Provided aggregate records; source and CRM reconciliation outstanding',
    mode: 'read-only; no customer data; no writes; no ad or CRM mutations',
    data_quality: quality,
    group: {
      connected_platform_ad_spend_usd: allAdsSpend,
      central_campaign_spend_usd: total(centralAds, 'spend_usd'),
      rooftop_spend_usd: total(sources.ads.filter(x => x.store !== 'group'), 'spend_usd'),
      notes: 'Central account spend is included in group total but never allocated to a rooftop. Meta and Microsoft are excluded until ingested. Platform conversions are not leads or sold vehicles.',
    },
    stores: storeSummary,
    action_register: actions,
  };
  const prefix = synthetic ? '**SYNTHETIC DEMO - NOT REAL DEALERSHIP RESULTS**\n\n' : '';
  const lines = [
    '# AMQUR | Dial Auto Group | Dealer Intelligence', '', prefix.trim(),
    `**Window:** ${days[0]} to ${asOf} (America/Chicago) | **Engagement:** Free flagship | **Mode:** Read-only`, '',
    '## Executive summary', '',
    `Connected-platform paid-media spend (six accounts where available): **${money(allAdsSpend)}**.`,
    `Central/group campaigns (not allocated to a store): **${money(out.group.central_campaign_spend_usd)}**.`,
    '**Important:** This is not all-channel spend unless Google, Meta, and Microsoft are all supplied. Google Ads conversion counts do not equal verified CRM leads or sales.', '',
    '## Five-store scorecard', '',
    '| Store | Connected ad spend | Platform conversions | CRM leads | Appointments | Sold status | Ads / CRM / Web / Calls days |',
    '|---|---:|---:|---:|---:|---:|---|',
  ];
  for (const s of storeSummary) {
    const m = s.metrics, c = s.coverage_days;
    lines.push(`| ${s.name} | ${money(m.ad_spend_connected_usd)} | ${qty(m.reported_platform_conversions)} | ${qty(m.crm_leads)} | ${qty(m.appointments)} | ${qty(m.crm_sold_statuses)} | ${c.ads}/7 / ${c.crm}/7 / ${c.web}/7 / ${c.calls}/7 |`);
  }
  lines.push('', '## Data quality', '', '| Data source | Status | Days represented | Caveat |', '|---|---|---:|---|');
  for (const q of quality) lines.push(`| ${q.source} | ${q.status} | ${q.observed_store_days}/7 | ${q.issue} |`);
  lines.push('', '## Approval-ready actions', '', `**${actions.length} actions awaiting review.** No action has been approved, implemented, or measured.`, '');
  for (const [i, a] of actions.entries()) lines.push(`${i + 1}. **${a.store}:** ${a.issue}. Evidence: ${a.evidence}. Next: ${a.recommended_action}. Status: ${a.approval_status}.`);
  lines.push('', '## Interpretation guardrails', '',
    '- Treat platform conversions as platform-reported events, not CRM leads, appointments or sales.',
    '- No cost-per-sold, attributed ROI, or incremental revenue claim without Tekion/DMS reconciliation.',
    '- Empty data is **unknown**, not zero. Differences in lead cohorts and reporting dates can invalidate funnel rates.',
    '- Group-level campaigns are not assigned to individual stores without verified attribution.',
    '- Never send customer messages or change ads, website, inventory or CRM without a specifically approved action.', '',
    `Generated by AMQUR Dealer Intelligence v0. ${out.data_status}.`);
  return { json: out, markdown: lines.filter(x => x !== undefined).join('\n') + '\n' };
}

export async function buildFromDirectory({ dataDir, asOf = datesTodayChicago(), outDir, registryPath = path.join(ROOT, 'config/rooftops/registry.json') }) {
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const allowedStores = [...registry.rooftops.map(r => r.key), 'group'];
  const datasets = {};
  for (const kind of Object.keys(KINDS)) {
    const file = path.join(dataDir, `${kind}.csv`);
    datasets[kind] = existsSync(file) ? parseInput(kind, await readFile(file, 'utf8'), allowedStores) : [];
  }
  const report = createReport({ registry, datasets, asOf, synthetic: existsSync(path.join(dataDir, '.synthetic')) });
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report.json, null, 2) + '\n', { mode: 0o600 });
  await writeFile(path.join(outDir, 'report.md'), report.markdown, { mode: 0o600 });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const dataDir = opt('--data'), outDir = opt('--out'), asOf = opt('--as-of');
  if (!dataDir || !outDir || (args.includes('--as-of') && !asOf)) {
    process.stderr.write('Usage: node scorecard.mjs --data <private-aggregate-csv-dir> --out <private-report-dir> [--as-of YYYY-MM-DD]\n');
    process.exitCode = 2;
  } else {
    buildFromDirectory({ dataDir, outDir, asOf }).then(r => {
      process.stdout.write(`Report created: ${path.join(outDir, 'report.md')} (${r.json.synthetic ? 'SYNTHETIC' : 'NON-RECONCILED AGGREGATES'})\n`);
    }).catch(e => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
  }
}
