/**
 * AMQUR / Dial Auto Group: one-way PII-minimizing Tekion CRM LEAD LIST aggregator.
 *
 * - Reads sensitive raw CSVs ONLY from an authorized local directory.
 * - Exports store/day/business-line counts to the existing scorecard `crm.csv` schema.
 * - Never writes contact names, phones, emails, notes, VINs, Lead IDs or deal IDs.
 * - Blank appointments/shows/sold = unknown, not zero; CRM status is NOT DMS proof.
 * - Fail closed on unknown dealer aliases, invalid dates, duplicate store exports,
 *   unexpected statuses, or an output directory inside the public repository.
 *
 * No API calls, mutations, LLM calls, network traffic, or customer outreach.
 */
import { readFile, readdir, mkdir, writeFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './scorecard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STORE_ALIASES = new Map([
  ['dial chevy', 'chevy'],
  ['dial nissan of chicago', 'nissan'],
  ['infiniti of chicago', 'infiniti'],
  ['dial chrysler dodge jeep ram', 'cdjr-south'],
  ['chrysler dodge jeep ram of chicago', 'jeep-north'],
]);
const STORES = ['chevy', 'nissan', 'infiniti', 'cdjr-south', 'jeep-north'];
const EXPECTED_STATUS = new Set(['active','inactive','duplicate','bad','closed','booked']);
const REQUIRED = ['Dealership','Creation Time','Status','Department','Sales Lead Type','Stock Type'];
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
const HEAD = 'date,store,business_line,leads,appointments,shows,sold';

export function parseTekionDate(value) {
  const m = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i.exec((value || '').trim());
  if (!m) throw new Error('Unexpected Tekion Creation Time format');
  const month = MONTHS[m[1].toLowerCase()], day=Number(m[2]), year=Number(m[3]);
  const hour=Number(m[4]), minute=Number(m[5]);
  if (!Number.isInteger(year) || year < 2020 || year > 2100 || hour < 1 || hour > 12 || minute < 0 || minute > 59) throw new Error('Invalid Tekion Creation Time');
  const date = new Date(Date.UTC(year,month-1,day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth()+1 !== month || date.getUTCDate() !== day) throw new Error('Invalid Tekion Creation Time date');
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

export function parseTekionAggregate(csvText, filenameHint='CRM_LEAD_LIST') {
  const table = parseCsv(csvText);
  if (table.length < 2) throw new Error('Empty Tekion CRM lead export');
  const header = table[0].map(v=>v.trim());
  if (new Set(header).size !== header.length) throw new Error('Duplicate Tekion export columns');
  for (const need of REQUIRED) if (!header.includes(need)) throw new Error(`Missing required Tekion column: ${need}`);
  const pos = Object.fromEntries(header.map((h,i)=>[h,i]));
  const daily = new Map();
  let store=null, first=null,last=null, raw=0, duplicates=0,bad=0,service=0, acquisition_only=0, eligible=0;
  let crm_sold_date_indicators=0, vehicle_exchange=0;
  const srcPos = pos['Source'];
  const soldDatePos = pos['Sold Date'];
  for (let n=1;n<table.length;n++) {
    const row = table[n];
    if (row.length !== header.length) throw new Error(`Malformed CSV column count at line record ${n+1}`);
    const lookup=k=>(row[pos[k]] || '').trim();
    const recognized = STORE_ALIASES.get(lookup('Dealership').toLowerCase());
    if (!recognized) throw new Error('Unknown Tekion dealership alias: no fuzzy store mapping allowed');
    if (store && store!==recognized) throw new Error('Multiple dealerships in one Tekion export');
    store=recognized;
    const day=parseTekionDate(lookup('Creation Time'));
    if (!first || day<first) first=day;
    if (!last || day>last) last=day;
    const stat=lookup('Status').toLowerCase();
    if (!EXPECTED_STATUS.has(stat)) throw new Error('Unexpected Tekion CRM Status');
    const dept=lookup('Department').toLowerCase();
    const leadType=lookup('Sales Lead Type').toUpperCase();
    raw++;
    if (stat==='duplicate') duplicates++;
    if (stat==='bad') bad++;
    if (dept==='service') service++;
    if (leadType==='VEHICLE_ACQUISITION_ONLY') acquisition_only++;
    if (soldDatePos !== undefined && (row[soldDatePos]||'').trim()) crm_sold_date_indicators++;
    const isEligible=dept==='sales' && leadType==='VEHICLE_PURCHASE' && stat!=='duplicate' && stat!=='bad';
    if (!isEligible) continue;
    let line=lookup('Stock Type').toLowerCase();
    if (line!=='new' && line!=='used') line='unclassified';
    const key=`${day}|${line}`;
    daily.set(key,(daily.get(key)||0)+1);
    eligible++;
    if (srcPos!==undefined && (row[srcPos]||'').trim().toLowerCase().startsWith('vehicle exchange')) vehicle_exchange++;
  }
  if (!store) throw new Error(`No valid dealership recognized in ${filenameHint}`);
  return {store, daily, stats:{store,first_date:first,last_date:last,raw,duplicates,bad,service,acquisition_only,eligible,crm_sold_date_indicators,vehicle_exchange}};
}

function inDir(dir, parent) { const rel = path.relative(parent, dir);return rel==='' || (!rel.startsWith('..'+path.sep) && rel!=='..' && !path.isAbsolute(rel)); }

export function emitAggregate(inputs) {
  if (inputs.length !== 5) throw new Error('Exactly five different dealership exports are required');
  const byStore = new Map();
  for (const input of inputs) {
    if (byStore.has(input.store)) throw new Error('Repeated store export; risk of double-counting');
    byStore.set(input.store,input);
  }
  for (const store of STORES) if (!byStore.has(store)) throw new Error('Missing dealership export');
  const lines=[HEAD];
  const quality=[];
  for (const store of STORES) {
    const {daily,stats}=byStore.get(store);
    quality.push(stats);
    // Only emit observed cohort dates; do NOT imply zeros on days absent from the export.
    const days=[...new Set([...daily.keys()].map(k=>k.split('|')[0]))].sort();
    for (const day of days) for (const line of ['new','used','unclassified']) {
      const count = daily.get(`${day}|${line}`) || 0;
      lines.push(`${day},${store},${line},${count},,,`);
    }
  }
  return {crmCsv:lines.join('\n')+'\n',quality:{provenance:'Tekion CRM_LEAD_LIST - unverified sale and appointment outcomes',filter:'Sales + VEHICLE_PURCHASE, excluding Status Duplicate and Bad',appointments_shows_sold:'UNKNOWN; exported blank; require event and DMS reconciliation',stores:quality}};
}

export async function convertDirectory({inputDir,outputDir}) {
  if (!inputDir || !outputDir) throw new Error('--input and --out are required');
  const target=path.resolve(outputDir);
  const targetExistingParent=existsSync(target) ? await realpath(target) : path.resolve(target);
  if (inDir(targetExistingParent,ROOT)) throw new Error('Refusing to write sensitive-derived outputs within the public AMQUR repository');
  const entries=(await readdir(inputDir)).filter(x=>/^_CRM_LEAD_LIST_[a-zA-Z0-9-]+\.csv$/.test(x)).sort();
  if (entries.length!==5) throw new Error('Need exactly 5 Tekion _CRM_LEAD_LIST_*.csv exports in the input folder');
  const data=[];
  for (const name of entries) {
    const csvText=await readFile(path.join(inputDir,name),'utf8');
    data.push(parseTekionAggregate(csvText,name));
  }
  const result=emitAggregate(data);
  await mkdir(target,{recursive:true,mode:0o700});
  await writeFile(path.join(target,'crm.csv'),result.crmCsv,{encoding:'utf8',mode:0o600});
  await writeFile(path.join(target,'crm_aggregate_quality.json'),JSON.stringify(result.quality,null,2)+'\n',{encoding:'utf8',mode:0o600});
  return {output:target,rows:result.crmCsv.trimEnd().split('\n').length-1,quality:result.quality};
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  const option=key=>{const i=args.indexOf(key);return i<0?null:args[i+1];};
  convertDirectory({inputDir:option('--input'),outputDir:option('--out')}).then(result=>{
    const count=result.quality.stores.reduce((n,s)=>n+s.raw,0);
    process.stdout.write(`AMQUR local CRM aggregation completed: ${count} source rows; ${result.rows} PII-free aggregate rows; ${result.quality.stores.length} stores. No CRM mutations.\n`);
  }).catch(e=>{ process.stderr.write(`CRM aggregate import failed: ${e.message}\n`);process.exitCode=1; });
}
