/** Revenue attribution is intentionally not calculated: disparate event-date cohorts are not linked. */
export type DiPeriod = { id: string; label: string; start: string; end: string };
export type DiAds = { date: string; store: string; platform: string; business_line: string; spend_usd: number; impressions: number; clicks: number; reported_conversions: number };
export type DiCrm = { date: string; store: string; business_line: string; leads: number; appointments: number | null; shows: number | null; sold: number | null };
export type DiDms = { date: string; store: string; business_line: string; retail_candidates: number };
export type DiCoverage = { rows: number; start: string | null; end: string | null; description: string };
export type DiSnapshot = {
  schema: string; name: string; as_of: string; status: string; synthetic: boolean;
  freshness: { age_days: number; stale: boolean };
  stores: { key: string; name: string }[];
  periods: DiPeriod[];
  comparison: { earlier: string; later: string };
  coverage: Record<'ads'|'crm'|'dms',DiCoverage>;
  totals: { provisional_retail_candidates: number; crm_purchase_lead_records: number; connected_google_spend_usd: number; unallocated_group_google_spend_usd: number };
  flags: string[]; notes: string[];
  ads: DiAds[]; crm: DiCrm[]; dms: DiDms[];
  action_register: { store: string; priority: string; confidence: string; issue: string; evidence: string; recommended_action: string; approval_status: 'Needs Review'; implemented: 'No' }[];
};

function matches(row: {date:string;store:string;business_line:string}, period: DiPeriod, store: string, line: string) {
  return row.date>=period.start && row.date<=period.end && (store==='all'||row.store===store) && (line==='all'||row.business_line===line);
}
export function hasWholePeriod(coverage: DiCoverage, period: DiPeriod): boolean {
  return !!coverage.start && !!coverage.end && coverage.start<=period.start && coverage.end>=period.end;
}
export function selectedStats(snapshot: DiSnapshot, period: DiPeriod, store: string, line: string) {
  const crmRows = snapshot.crm.filter(x=>matches(x,period,store,line));
  const dmsRows = snapshot.dms.filter(x=>matches(x,period,store,line));
  const adsRows = snapshot.ads.filter(x=>matches(x,period,store,'all'));
  // Advertising is unclassified by stock type; never allocate it to 'new' or 'used'.
  const eligibleAds = line === 'all' ? adsRows.filter(x=>x.store!=='group') : [];
  const groupAds = line === 'all' && store==='all' ? adsRows.filter(x=>x.store==='group') : [];
  return {
    crmLeads: crmRows.length ? crmRows.reduce((n,x)=>n+x.leads,0) : null,
    retailCandidates: dmsRows.length ? dmsRows.reduce((n,x)=>n+x.retail_candidates,0) : null,
    rooftopSpend: eligibleAds.length ? eligibleAds.reduce((n,x)=>n+x.spend_usd,0) : null,
    groupSpend: groupAds.length ? groupAds.reduce((n,x)=>n+x.spend_usd,0) : null,
    sourceCoverage: {
      crm:hasWholePeriod(snapshot.coverage.crm,period),
      dms:hasWholePeriod(snapshot.coverage.dms,period),
      ads:hasWholePeriod(snapshot.coverage.ads,period),
    },
  };
}
export function completedMonthCandidates(snapshot: DiSnapshot, store: string, month: string, line='all') {
  return snapshot.dms.filter(x=>x.date.startsWith(month) && (store==='all'||x.store===store) && (line==='all'||x.business_line===line)).reduce((n,x)=>n+x.retail_candidates,0);
}