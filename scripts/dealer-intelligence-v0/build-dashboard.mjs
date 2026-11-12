/**
 * AMQUR Dealer Intelligence: private, read-only static dashboard builder.
 * Strictly accepts approved PII-free aggregate schemas. Not a CRM/DMS API client.
 * Does NOT deploy, message customers, modify campaigns, or confirm delivered sales.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseCsv, parseInput } from './scorecard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.resolve(HERE, '../../config/rooftops/registry.json');
const DMS_HEADERS = ['sold_date', 'store', 'business_line', 'retail_candidates', 'status', 'source'];
const DMS_STATUS = 'PROVISIONAL_NOT_POSTED';
const DMS_SOURCE = 'Tekion Deal List';
const RANGE_START = '2026-08-01';
const MAX_ROWS = 100000;
const PROVENANCE = {
  ads: 'Connected Google Ads / Supermetrics daily account aggregates; platform conversions are not CRM leads or sales',
  crm: 'Tekion lead-list aggregates: eligible purchase leads only; duplicates/bad/service filtered; not necessarily unique people',
  dms: 'Tekion Deals report provisional retail candidates; booked/closed retail-like deals are not posted/delivered units',
};
const ALLOWED_PLATFORMS = ['google_ads', 'meta_ads', 'microsoft_ads'];
function validISO(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function daysBetween(start,end) {
  if (!validISO(start) || !validISO(end) || start > end) throw new Error('Invalid date range');
  const result = [];
  for (let ms = Date.parse(start+'T00:00:00Z'); ms <= Date.parse(end+'T00:00:00Z'); ms += 86400000) {
    result.push(new Date(ms).toISOString().slice(0,10));
  }
  return result;
}
function parseNumber(s, field) {
  if (!/^(0|[1-9]\d*)$/.test(s)) throw new Error(`Invalid DMS ${field}; must be nonnegative integer`);
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new Error(`Unsafe DMS ${field}`);
  return n;
}
export function parseDms(text, stores) {
  const rows = parseCsv(text);
  if (!rows.length || rows.length > MAX_ROWS) throw new Error('Invalid DMS row count');
  const head = rows.shift().map(x=>x.trim());
  if (head.length!==DMS_HEADERS.length || head.some((x,i)=>x!==DMS_HEADERS[i])) {
    throw new Error('DMS must have exact PII-free schema: '+DMS_HEADERS.join(','));
  }
  const keys = new Set(), out=[];
  for (const [i, cols] of rows.entries()) {
    if (cols.length!==head.length) throw new Error(`DMS row ${i+2}: invalid column count`);
    const [date,store,line,count,status,source] = cols.map(x=>x.trim());
    if (!validISO(date) || !stores.has(store) || !['new','used'].includes(line) || status!==DMS_STATUS || source!==DMS_SOURCE) {
      throw new Error(`DMS row ${i+2}: invalid date, store, stock type or provisional source`);
    }
    const key = `${date}/${store}/${line}`;
    if (keys.has(key)) throw new Error(`DMS row ${i+2}: duplicate aggregate key`);
    keys.add(key);
    out.push({date,store,business_line:line,retail_candidates:parseNumber(count,'retail_candidates')});
  }
  return out;
}
function aggregate(rows,field,filter=()=>true) {
  const a=rows.filter(filter).map(r=>r[field]).filter(x=>x!==null && x!==undefined);
  return a.length ? a.reduce((sum,x)=>sum+x,0) : null;
}
function isoAddDays(date,offset) { return new Date(Date.parse(date+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10); }
function monthFloor(date) { return date.slice(0,7)+'-01'; }
function prevMonth(month) { return monthFloor(isoAddDays(monthFloor(month),-1)).slice(0,7); }
function monthEnd(month) { const next = new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),1)); return new Date(next.getTime()-86400000).toISOString().slice(0,10); }
function monthLabel(month) { return new Intl.DateTimeFormat('en-US',{month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(month+'-01T00:00:00Z')); }
function monthly(rows,store,line,month) {
  return aggregate(rows,'retail_candidates',r => (store==='all'||r.store===store) && (line==='all'||r.business_line===line) && r.date.startsWith(month)) ?? 0;
}
function sumMoney(n) {return n===null?null:Math.round(n*100)/100;}
function baseActions(dms,stores,asOf,comparison) {
  const earlier=comparison.earlier, later=comparison.later;
  const nissanSep=monthly(dms,'nissan','all',earlier);
  const nissanOct=monthly(dms,'nissan','all',later);
  const nissanNewSep=monthly(dms,'nissan','new',earlier);
  const nissanNewOct=monthly(dms,'nissan','new',later);
  const base = {
    date:asOf,channel:'Operations / CRM',business_line:'All',asset:'Owner action register',
    expected_impact:'Unknown until validation',approved_by:'',date_approved:'',implemented:'No',date_implemented:'',result_notes:'',
    approval_status:'Needs Review'
  };
  const actions=[
    { ...base,store:'Dial Nissan of Chicago',priority:'Critical',confidence:'High',asset:'New vehicle sales / DMS status',
      issue:'Provisional completed-month retail candidate change',
      evidence:`${monthLabel(earlier)} ${nissanSep} vs ${monthLabel(later)} ${nissanOct} retail candidates; new units ${nissanNewSep} vs ${nissanNewOct}. No posted/delivery confirmation.`,
      recommended_action:'Verify posted new-unit results by model, inventory and salesperson; review lead response and appointment shows before changing budgets.' },
    { ...base,store:'Dial Auto Group',priority:'Critical',confidence:'High',asset:'Accounting sold-unit reconciliation',
      issue:'Retail candidate numbers are not confirmed vehicle deliveries',
      evidence:'Tekion Deals Delivery Status is blank across included candidate records; accounting ledger not provided.',
      recommended_action:'Reconcile posted deliveries, unwind/reversal events and final gross by store; until then report provisional counts only.' },
    { ...base,store:'Dial Auto Group',priority:'High',confidence:'High',asset:'CRM appointment reporting',
      issue:'Actual appointment event counts missing',evidence:'CRM lead-export aggregates do not contain validated appointment/show event totals.',
      recommended_action:'Add authorized, privacy-minimized scheduled/shown/no-show/cancelled daily appointment exports.' },
    { ...base,store:'Dial Auto Group',priority:'High',confidence:'High',asset:'Marketing channel coverage',
      issue:'Incomplete spend and conversion-source coverage',evidence:'Connected daily advertising dataset covers only Google Ads Nov 4–10; Meta, Microsoft and web/calls not yet integrated.',
      recommended_action:'Connect approved Meta, Microsoft, GA4, and call-tracking reports; reconcile attribution definitions and account/store mappings.' }
  ];
  const recentMonths=[prevMonth(earlier),earlier,later];
  const cdjrNew=recentMonths.reduce((n,m)=>n+monthly(dms,'cdjr-south','new',m),0);
  const cdjrUsed=recentMonths.reduce((n,m)=>n+monthly(dms,'cdjr-south','used',m),0);
  actions.push({ ...base,store:stores.find(x=>x.key==='cdjr-south').name,priority:'High',confidence:'Medium',asset:'Deal stock-type mapping',
    issue:'Exceptionally used-heavy provisional sales mix',evidence:`Three recent complete months (${monthLabel(recentMonths[0])}–${monthLabel(later)}): new ${cdjrNew}, used ${cdjrUsed}; stock type and rooftop mapping not accounting verified.`,
    recommended_action:'Reconcile actual new/used stock classifications and inter-store deal allocation before modifying merchandising strategy.' });
  return actions;
}
export function makePayload({registry,ads,crm,dms,asOf='2026-11-10',synthetic=false}) {
  if (!validISO(asOf)||asOf<RANGE_START) throw new Error('Invalid as-of date');
  if (!registry || registry.rooftops?.length!==5 || new Set(registry.rooftops.map(x=>x.key)).size!==5) throw new Error('Expected five distinct rooftop keys');
  const stores=registry.rooftops.map(r=>({key:r.key,name:r.displayName}));
  const rooftopIds=new Set(stores.map(r=>r.key));
  for(const row of ads){if(row.store!=='group'&&!rooftopIds.has(row.store)||!ALLOWED_PLATFORMS.includes(row.platform)) throw new Error('Unexpected advertising account/tenant');}
  for(const row of crm){if(!rooftopIds.has(row.store)) throw new Error('Unexpected CRM dealership');}
  for(const row of dms){if(!rooftopIds.has(row.store)) throw new Error('Unexpected DMS dealership');}
  const filtered={
    ads:ads.filter(r=>r.date<=asOf&&r.date>=RANGE_START),
    crm:crm.filter(r=>r.date<=asOf&&r.date>=RANGE_START),
    dms:dms.filter(r=>r.date<=asOf&&r.date>=RANGE_START),
  };
  if (!filtered.crm.length||!filtered.dms.length) throw new Error('Missing CRM/DMS aggregates: refusing misleading report');
  if (filtered.ads.some(r=>r.platform!=='google_ads')) throw new Error('Phase 1 dashboard is explicitly Google-only for paid media');
  const currentMonth=monthFloor(asOf).slice(0,7);
  const previousMonth=prevMonth(currentMonth);
  const earlierMonth=prevMonth(previousMonth);
  const olderMonth=prevMonth(earlierMonth);
  const comparison={earlier:earlierMonth,later:previousMonth};
  const last7start=isoAddDays(asOf,-6);
  const recentStart=isoAddDays(asOf,-60);
  const sourceStatus=Object.fromEntries(Object.entries(filtered).map(([name,rows])=> {
    const allDates=[...new Set(rows.map(r=>r.date))].sort();
    return [name,{rows:rows.length,start:allDates[0]??null,end:allDates.at(-1)??null,description:PROVENANCE[name]}];
  }));
  const flags=[];
  if (!filtered.ads.length) flags.push('No paid-media data supplied');
  if (sourceStatus.ads.start !== sourceStatus.crm.start || sourceStatus.ads.start !== sourceStatus.dms.start) flags.push('Source periods do not align. Avoid ad-to-sale rate or cost-per-sale comparisons.');
  flags.push('No confirmed delivery/posted sales ledger; DMS retail candidate counts are provisional.');
  flags.push('CRM lead creation, DMS sold date, and Google Ads conversion timestamps are different cohort definitions.');
  flags.push('Appointment show counts, Meta, Microsoft, GA4 and call tracking remain unverified.');
  const totals={
    provisional_retail_candidates:aggregate(filtered.dms,'retail_candidates'),
    crm_purchase_lead_records:aggregate(filtered.crm,'leads'),
    connected_google_spend_usd:sumMoney(aggregate(filtered.ads,'spend_usd')),
    unallocated_group_google_spend_usd:sumMoney(aggregate(filtered.ads,'spend_usd',r=>r.store==='group')),
  };
  return {
    schema:'amqur.dealer-intelligence.private-preview.v1',name:'Dial Auto Group',as_of:asOf,
    status:synthetic?'SYNTHETIC DEMO — NOT REAL DATA':'PRIVATE / PROVISIONAL — NOT POSTED SALES',synthetic,
    privacy:'aggregate-only; no customer personal information',engagement:'AMQUR free flagship (family-affiliated)',
    stores,comparison,periods:[
      {id:'last7',label:`${last7start} to ${asOf}`,start:last7start,end:asOf},
      {id:'prev',label:monthLabel(previousMonth),start:previousMonth+'-01',end:monthEnd(previousMonth)},
      {id:'prev2',label:monthLabel(earlierMonth),start:earlierMonth+'-01',end:monthEnd(earlierMonth)},
      {id:'mtd',label:`${monthLabel(currentMonth)} (through ${asOf})`,start:currentMonth+'-01',end:asOf},
      {id:'prev3',label:monthLabel(olderMonth),start:olderMonth+'-01',end:monthEnd(olderMonth)},
      {id:'overlap',label:`${recentStart} to ${asOf}`,start:recentStart,end:asOf},
    ],
    coverage:sourceStatus,totals,flags,
    ...filtered,
    action_register:baseActions(filtered.dms,stores,asOf,comparison),
    notes:['Google spend is an observed channel subtotal, not complete advertising spend.',
    'Google Ads reported conversions are not CRM leads and are excluded from sold-vehicle KPI.',
    'Rows marked 0 in DMS are real zeros in the supplied aggregate, not evidence of final sales.',
    'Nissan Vehicle Exchange campaign earlier-week spike requires source normalization before lead-quality interpretations.',
    'No automatic changes, customer outreach, external sharing or scheduled data exports have been configured.']
  };
}
export function makeOwnerBrief(payload) {
  const first=payload.comparison.earlier,second=payload.comparison.later;
  const money=n=>n===null?'N/A':('$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}));
  const count=n=>n===null?'N/A':n.toLocaleString('en-US');
  const monthTotal=(store,month,line='all')=>aggregate(payload.dms,'retail_candidates',r=>r.store===store&&r.date.startsWith(month)&&(line==='all'||r.business_line===line));
  const current=payload.periods.find(p=>p.id==='last7');
  const within=r=>r.date>=current.start&&r.date<=current.end;
  const retail=aggregate(payload.dms,'retail_candidates',r=>within(r));
  const crm=aggregate(payload.crm,'leads',r=>within(r));
  const rooftopSpend=aggregate(payload.ads,'spend_usd',r=>within(r)&&r.store!=='group');
  const centralSpend=aggregate(payload.ads,'spend_usd',r=>within(r)&&r.store==='group');
  const lines=[
    '# AMQUR | Dial Auto Group | Executive Operations Brief','',
    `**Data cutoff:** ${payload.as_of} · **Engagement:** $0 family-affiliated flagship · **Mode:** READ-ONLY`,
    `**Status:** ${payload.status}`,'',
    '## Decision summary','',
    `- Latest seven-day window (${current.start} to ${current.end}): **${count(retail)} provisional retail-deal candidates**, **${count(crm)} eligible CRM lead records**, **${money(rooftopSpend)} connected Google Ads spend at rooftops**, and **${money(centralSpend)} central-account spend**.`,
    '- These are separate systems and event-date definitions. This is **NOT** a lead-to-sold conversion rate, cost per car sold, advertising ROI, or confirmation of delivered units.',
    '- No verified delivered/posted sales totals or appointment show/no-show data are available. Current recommendation statuses remain `Needs Review`.','',
    `## Completed-month DMS comparison: ${first} → ${second}`,'',
    '| Store | Earlier candidates | Later candidates | New earlier → later | Used earlier → later | Change |',
    '|---|---:|---:|---|---|---:|'
  ];
  for (const store of payload.stores){
    const a=monthTotal(store.key,first)??0,b=monthTotal(store.key,second)??0;
    const newA=monthTotal(store.key,first,'new')??0,newB=monthTotal(store.key,second,'new')??0;
    const usedA=monthTotal(store.key,first,'used')??0,usedB=monthTotal(store.key,second,'used')??0;
    const change=a===0?'N/A':`${((b/a-1)*100).toFixed(1)}%`;
    lines.push(`| ${store.name} | ${a} | ${b} | ${newA} → ${newB} | ${usedA} → ${usedB} | ${change} |`);
  }
  lines.push('',
    '**Interpretation:** DMS figures are filtered retail-like deals from Sold Date, not posted/delivered accounting results. The latest month-to-date is omitted from this full-month comparison.','',
    '## Data quality and attribution','',
    '| Source | Supplied dates | Records (aggregate) | Status |','|---|---|---:|---|');
  for(const [name,s] of Object.entries(payload.coverage)){
    lines.push(`| ${name.toUpperCase()} | ${s.start||'N/A'} to ${s.end||'N/A'} | ${s.rows} | Usable with limits |`);
  }
  lines.push('',...payload.flags.map(x=>`- ${x}`),'',
    '## Approval-ready action register','');
  for(const [i,a] of payload.action_register.entries()){
    lines.push(`${i+1}. **${a.priority} | ${a.store} | ${a.asset}.** ${a.issue}. **Evidence:** ${a.evidence} **Recommendation:** ${a.recommended_action} **Status:** Needs Review / Not implemented.`);
  }
  lines.push('',
    '## Operational constraints','',
    '- Never place raw dealership customer exports, Deal#, VINs, PII, credit data or keys in GitHub or any public dashboard.',
    '- No change to Google/Meta/Microsoft spend, ad text, CRM records, published sites, call routing or customer communications without a store-specific approved action.',
    '- No pricing or manufacturer incentives should be inferred from these analytics reports.',
    '- Public customer-facing AMQUR activation still requires security, vendor, backup, monitoring, consent and release sign-offs.',
    '',`*Generated from PII-free aggregates, as of ${payload.as_of}.*`,'');
  return lines.join('\n');
}

export function dashboardHtml(template,payload) {
  if (!template.includes('<!--AMQUR_PRIVATE_DATA-->')) throw new Error('Dashboard template missing data anchor');
  const safe=JSON.stringify(payload).replaceAll('<','\\u003c').replaceAll('>','\\u003e').replaceAll('&','\\u0026').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
  return template.replace('<!--AMQUR_PRIVATE_DATA-->',`<script id="amqur-data" type="application/json">${safe}</script>`);
}
export async function buildDashboard({adsPath,crmPath,dmsPath,outputDir,asOf='2026-11-10',synthetic=false}) {
  if (!adsPath||!crmPath||!dmsPath||!outputDir)throw new Error('Pass all aggregate inputs and a private output directory');
  const registry=JSON.parse(await readFile(REGISTRY,'utf8'));
  const storeIds=registry.rooftops.map(r=>r.key);
  const [adsText,crmText,dmsText,template]=await Promise.all([
    readFile(adsPath,'utf8'),readFile(crmPath,'utf8'),readFile(dmsPath,'utf8'),readFile(path.join(HERE,'dashboard-template.html'),'utf8')]);
  const ads=parseInput('ads',adsText,[...storeIds,'group']);
  const crm=parseInput('crm',crmText,storeIds);
  const dms=parseDms(dmsText,new Set(storeIds));
  const payload=makePayload({registry,ads,crm,dms,asOf,synthetic});
  const manifest={schema:'amqur.private-source-manifest.v1',generated_at:new Date().toISOString(),source_files:{},status:payload.status};
  for(const [name,txt] of [['ads',adsText],['crm',crmText],['dms',dmsText]]){
    manifest.source_files[name]={sha256:createHash('sha256').update(txt).digest('hex'),rows:payload.coverage[name].rows,
      first_date:payload.coverage[name].start,last_date:payload.coverage[name].end};
  }
  await mkdir(outputDir,{recursive:true,mode:0o700});
  const writes=[
    ['index.html',dashboardHtml(template,payload)],
    ['owner-brief.md',makeOwnerBrief(payload)],
    ['aggregate-report.json',JSON.stringify(payload,null,2)+'\n'],
    ['source-manifest.json',JSON.stringify(manifest,null,2)+'\n'],
  ];
  for(const [name,data] of writes)await writeFile(path.join(outputDir,name),data,{mode:0o600});
  return {outputDir,payload,manifest};
}
const calledDirectly=process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(calledDirectly){
  const opt=x=>{const i=process.argv.indexOf(x);return i<0?null:process.argv[i+1];};
  const params={adsPath:opt('--ads'),crmPath:opt('--crm'),dmsPath:opt('--dms'),outputDir:opt('--out'),asOf:opt('--as-of')||'2026-11-10',synthetic:process.argv.includes('--synthetic')};
  buildDashboard(params).then(r=>{
    console.log('AMQUR private dashboard created. Source windows:',r.payload.coverage);
    console.log('Open privately:',path.join(r.outputDir,'index.html'));
    console.log('Status:',r.payload.status);
  }).catch(e=>{console.error('Dashboard build failed:',e.message);process.exitCode=1;});
}