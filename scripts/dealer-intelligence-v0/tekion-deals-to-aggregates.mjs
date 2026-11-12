/**
 * AMQUR Tekion Deals export → privacy-minimized, provisional retail candidate totals.
 *
 * IMPORTANT: this is NOT a posted/delivered vehicle sales ledger.
 * The only data published is store/date/new-used aggregate counts and QA counters.
 * Do not pipe live customer exports into GitHub, logs or an external LLM.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCsv } from './scorecard.mjs';

const ALLOWED_STORES = new Set(['chevy','nissan','infiniti','cdjr-south','jeep-north']);
const REQUIRED = [
  'Deal#','Deal Type','Stock Type','Status','Sold Date',
  'Front Gross','Back Gross','Total Gross','Delivery Status','Deal Confirmed',
];
const RETAIL_TYPE = new Set(['PERSONAL','BUSINESS']);
const RETAIL_STATUS = new Set(['CLOSED_OR_SOLD','BOOKED']);
const VEHICLE_TYPE = new Set(['NEW','USED']);

function normalized(s) { return (s ?? '').trim().toUpperCase(); }
function validISO(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const value = new Date(iso + 'T00:00:00.000Z');
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0,10) === iso;
}
export function soldISO(raw) {
  const d = String(raw ?? '').trim().split(' ')[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return validISO(d) ? d : null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d);
  if (!m) return null;
  const iso = `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  return validISO(iso) ? iso : null;
}
export function cents(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  let neg = false;
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  s = s.replace(/^\$/,'');
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/.test(s)) return null;
  const [whole,frac=''] = s.replaceAll(',','').split('.');
  const n = Number(whole) * 100 + Number(frac.padEnd(2,'0'));
  if (!Number.isSafeInteger(n)) return null;
  return neg ? -n : n;
}

export function aggregateDeals({ text, store, start, end }) {
  if (!ALLOWED_STORES.has(store)) throw new Error('Unknown dealership mapping');
  if (!validISO(start)||!validISO(end)||start>end) throw new Error('Invalid reporting window');
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('Empty export');
  const head = rows.shift().map(x=>x.trim());
  if (new Set(head).size!==head.length || REQUIRED.some(k=>!head.includes(k))) {
    throw new Error('Unsupported Tekion Deals CSV headers');
  }
  const index = Object.fromEntries(head.map((k,i)=>[k,i]));
  const daily = new Map();
  const month = new Map();
  const ids = new Set();
  const quality = {
    raw_rows:0,invalid_rows:0,missing_sold_date:0,invalid_sold_date:0,
    sold_date_in_window:0,quote_with_sold_date:0,unwind_with_sold_date:0,
    excluded_non_retail:0,candidates:0,new_candidates:0,used_candidates:0,
    delivery_status_blank:0,deal_confirmed_yes:0,duplicate_deal_ref:0,
    gross_missing_or_invalid:0,gross_sum_mismatch:0,negative_gross_count:0,
    front_gross_cents:0,back_gross_cents:0,total_gross_cents:0,
  };
  for (const cols of rows) {
    quality.raw_rows++;
    if (cols.length !== head.length) { quality.invalid_rows++; continue; }
    const v = key => cols[index[key]] ?? '';
    const s = String(v('Sold Date')).trim();
    if (!s) { quality.missing_sold_date++; continue; }
    const date = soldISO(s);
    if (!date) { quality.invalid_sold_date++; continue; }
    if (date < start || date > end) continue;
    quality.sold_date_in_window++;
    const status=normalized(v('Status'));
    const dealType=normalized(v('Deal Type'));
    const vehicle=normalized(v('Stock Type'));
    if (status === 'QUOTE') quality.quote_with_sold_date++;
    if (status === 'UNWIND') quality.unwind_with_sold_date++;
    if (!(RETAIL_TYPE.has(dealType)&&RETAIL_STATUS.has(status)&&VEHICLE_TYPE.has(vehicle))) {
      quality.excluded_non_retail++;
      continue;
    }
    const dealRef=String(v('Deal#')).trim();
    if (dealRef && ids.has(dealRef)) { quality.duplicate_deal_ref++; continue; }
    if (dealRef) ids.add(dealRef);
    quality.candidates++;
    quality[vehicle === 'NEW' ? 'new_candidates' : 'used_candidates']++;
    if (!String(v('Delivery Status')).trim()) quality.delivery_status_blank++;
    if (normalized(v('Deal Confirmed'))==='YES') quality.deal_confirmed_yes++;
    const key=`${date}|${store}|${vehicle.toLowerCase()}`;
    daily.set(key,(daily.get(key) ?? 0)+1);
    const mo=date.slice(0,7);
    month.set(`${mo}|${vehicle.toLowerCase()}`,(month.get(`${mo}|${vehicle.toLowerCase()}`)??0)+1);
    const g=['Front Gross','Back Gross','Total Gross'].map(x=>cents(v(x)));
    if (g.some(x=>x===null)) quality.gross_missing_or_invalid++;
    else {
      if (Math.abs(g[0]+g[1]-g[2])>2) quality.gross_sum_mismatch++;
      if (g[2]<0) quality.negative_gross_count++;
      quality.front_gross_cents+=g[0];quality.back_gross_cents+=g[1];quality.total_gross_cents+=g[2];
    }
  }
  if (quality.candidates!==quality.new_candidates+quality.used_candidates)throw new Error('Failed new/used reconciliation');
  if ([quality.front_gross_cents,quality.back_gross_cents,quality.total_gross_cents].some(n=>!Number.isSafeInteger(n)))throw new Error('Unsafe gross amount');
  return {store,quality,daily:[...daily].sort((a,b)=>a[0].localeCompare(b[0])).map(([k,count])=>({date:k.split('|')[0],store,business_line:k.split('|')[2],retail_candidates:count})),monthly:[...month].sort((a,b)=>a[0].localeCompare(b[0])).map(([k,count])=>({month:k.split('|')[0],business_line:k.split('|')[1],retail_candidates:count}))};
}

export async function buildFromManifest({manifestPath,outDir,start,end}) {
  const config=JSON.parse(await readFile(manifestPath,'utf8'));
  if (!Array.isArray(config.files)||!config.files.length||config.files.length>5)throw new Error('Manifest must map 1–5 stores');
  const found = new Set();
  const reports=[];
  for (const file of config.files) {
    if (!file || !ALLOWED_STORES.has(file.store) || typeof file.path!=='string' || !file.path)throw new Error('Invalid manifest mapping');
    if (found.has(file.store))throw new Error('Duplicate store in manifest');
    found.add(file.store);
    const body=await readFile(file.path,'utf8');
    reports.push(aggregateDeals({text:body,store:file.store,start,end}));
  }
  const all=reports.flatMap(r=>r.daily).sort((a,b)=>a.date.localeCompare(b.date)||a.store.localeCompare(b.store)||a.business_line.localeCompare(b.business_line));
  const csv=['date,store,business_line,retail_candidates'];
  for (const r of all)csv.push(`${r.date},${r.store},${r.business_line},${r.retail_candidates}`);
  const payload={
    status:'PROVISIONAL_NOT_DELIVERED_OR_POSTED',period:{start,end},
    definition:'PERSONAL/BUSINESS, NEW/USED, CLOSED_OR_SOLD/BOOKED, Sold Date in period',
    caveats:['No delivery proof','No posted-accounting gross','No marketing attribution','No customer-level data in outputs'],
    stores:Object.fromEntries(reports.map(r=>[r.store,{quality:r.quality,monthly:r.monthly}])),
  };
  await mkdir(outDir,{recursive:true,mode:0o700});
  await writeFile(path.join(outDir,'dms_retail_candidates.csv'),csv.join('\n')+'\n',{mode:0o600});
  await writeFile(path.join(outDir,'dms_quality.json'),JSON.stringify(payload,null,2)+'\n',{mode:0o600});
  return payload;
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const args=process.argv.slice(2);
 const opt=x=>{ const i=args.indexOf(x);return i===-1?null:args[i+1]; };
 const manifestPath=opt('--manifest'),outDir=opt('--out'),start=opt('--start'),end=opt('--end');
 if (!manifestPath||!outDir||!start||!end) {
  process.stderr.write('Usage: node tekion-deals-to-aggregates.mjs --manifest <local-authorized-manifest.json> --out <private-out-dir> --start YYYY-MM-DD --end YYYY-MM-DD\n');
  process.exitCode=2;
 } else {
  buildFromManifest({manifestPath,outDir,start,end}).then(r=>{
   process.stdout.write(`Aggregates created for ${Object.keys(r.stores).length} store(s); retail delivery remains UNVERIFIED.\n`);
  }).catch(e=>{process.stderr.write(`Deal importer failed: ${e.message}\n`);process.exitCode=1;});
 }
}