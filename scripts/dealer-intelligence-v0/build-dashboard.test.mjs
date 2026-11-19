import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseDms,makePayload,dashboardHtml,buildDashboard} from './build-dashboard.mjs';
import {parseInput} from './scorecard.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const registry={rooftops:[
 {key:'chevy',displayName:'Dial Chevy of Chicago'},
 {key:'nissan',displayName:'Dial Nissan of Chicago'},
 {key:'infiniti',displayName:'INFINITI of Chicago'},
 {key:'cdjr-south',displayName:'Dial Chrysler Dodge Jeep Ram of Chicago (South)'},
 {key:'jeep-north',displayName:'Jeep of Chicago (North CDJR)'}]};
const allowed=new Set(registry.rooftops.map(x=>x.key));
const dmsHeader='sold_date,store,business_line,retail_candidates,status,source';
const dmsRows=[dmsHeader,
 '2026-09-05,nissan,new,5,PROVISIONAL_NOT_POSTED,Tekion Deal List',
 '2026-10-05,nissan,new,2,PROVISIONAL_NOT_POSTED,Tekion Deal List',
 '2026-11-04,chevy,used,0,PROVISIONAL_NOT_POSTED,Tekion Deal List',
 '2026-11-05,chevy,used,4,PROVISIONAL_NOT_POSTED,Tekion Deal List'].join('\n')+'\n';
const sampleAds='date,store,platform,business_line,spend_usd,impressions,clicks,reported_conversions\n2026-11-05,chevy,google_ads,unclassified,20.50,200,10,1.2\n2026-11-05,group,google_ads,unclassified,3.00,100,5,1\n';
const sampleCrm='date,store,business_line,leads,appointments,shows,sold\n2026-11-05,chevy,used,20,,,\n';
const parse=()=>({ads:parseInput('ads',sampleAds,[...allowed,'group']),crm:parseInput('crm',sampleCrm,[...allowed]),dms:parseDms(dmsRows,allowed)});

test('DMS aggregate accepts real zero values without treating them as missing',()=>{
 const rows=parseDms(dmsRows,allowed);
 assert.equal(rows.length,4);assert.equal(rows[2].retail_candidates,0);
});
test('DMS refuses customer-level or additional identifier columns',()=>{
 assert.throws(()=>parseDms(dmsRows.replace(dmsHeader,dmsHeader+',contact_email'),allowed),/PII-free/);
});
test('DMS refuses duplicate rows, unknown stores, invalid status, negative candidates and bad date',()=>{
 const repeat=dmsRows+'2026-11-05,chevy,used,4,PROVISIONAL_NOT_POSTED,Tekion Deal List\n';
 assert.throws(()=>parseDms(repeat,allowed),/duplicate/);
 assert.throws(()=>parseDms(dmsRows.replace('chevy,used','other,used'),allowed),/invalid/);
 assert.throws(()=>parseDms(dmsRows.replace('PROVISIONAL_NOT_POSTED','DELIVERED'),allowed),/invalid/);
 assert.throws(()=>parseDms(dmsRows.replace('new,5,','new,-5,'),allowed),/invalid|must be/);
 assert.throws(()=>parseDms(dmsRows.replace('2026-09-05','2026-02-30'),allowed),/invalid/);
});
test('payload keeps central advertising spend separate and zero values distinct from missing',()=>{
 const p=makePayload({registry,...parse(),asOf:'2026-11-10'});
 assert.equal(p.totals.connected_google_spend_usd,23.5);
 assert.equal(p.totals.unallocated_group_google_spend_usd,3);
 assert.equal(p.totals.provisional_retail_candidates,11);
 assert.equal(p.totals.crm_purchase_lead_records,20);
 assert.equal(p.dms.find(r=>r.date==='2026-11-04').retail_candidates,0);
 assert.match(p.status,/PROVISIONAL/);
 assert(p.flags.some(x=>/not confirmed|not delivered|No confirmed/i.test(x)));
 assert(p.action_register.every(x=>x.approval_status==='Needs Review' && x.implemented==='No'));
 assert(!JSON.stringify(p).includes('secret@example.com'));
});
test('builder rejects invalid day, unexpected store mapping and invalid source platforms',()=>{
 assert.throws(()=>makePayload({registry,...parse(),asOf:'2026-02-31'}),/Invalid as-of/);
 const p=parse();p.ads[0].platform='made_up';
 assert.throws(()=>makePayload({registry,...p,asOf:'2026-11-10'}),/Unexpected advertising/);
 assert.throws(()=>makePayload({registry,ads:[],crm:[],dms:[],asOf:'2026-11-10'}),/Missing CRM/);
});
test('rendering neutralizes script injection through untrusted JSON values',()=>{
 const template='<body><!--AMQUR_PRIVATE_DATA--></body>';
 const result=dashboardHtml(template,{untrusted:'</script><script>globalThis.pwned=1</script>'});
 assert(!result.includes('</script><script>globalThis.pwned'));
 assert(result.includes('\\u003c/script\\u003e'));
 assert.throws(()=>dashboardHtml('<body></body>',{}),/anchor/);
});
test('private files use exact approved aggregates and do not echo customer identifiers',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'amqur-ui-test-'));
 try{
  const ads=path.join(dir,'ads.csv'),crm=path.join(dir,'crm.csv'),dms=path.join(dir,'dms.csv'),out=path.join(dir,'private');
  await Promise.all([writeFile(ads,sampleAds),writeFile(crm,sampleCrm),writeFile(dms,dmsRows)]);
  const result=await buildDashboard({adsPath:ads,crmPath:crm,dmsPath:dms,outputDir:out,asOf:'2026-11-10',synthetic:true});
  assert.equal(result.payload.synthetic,true);
  assert.deepEqual((await readdir(out)).sort(),['aggregate-report.json','index.html','owner-brief.md','source-manifest.json']);
  const html=await readFile(path.join(out,'index.html'),'utf8');
  const json=await readFile(path.join(out,'aggregate-report.json'),'utf8');
  const manifest=JSON.parse(await readFile(path.join(out,'source-manifest.json'),'utf8'));
  assert.match(html,/SYNTHETIC DEMO/);
  assert.match(html,/id="store-filter"/);
  assert.match(html,/Google Ads spend/);
  assert.match(json,/Needs Review/);
  assert.equal(manifest.source_files.ads.rows,2);
  assert.equal(manifest.source_files.dms.rows,4);
  assert.match(manifest.source_files.ads.sha256,/^[0-9a-f]{64}$/);
  for(const forbidden of ['secret@example.invalid','Customer Email','SENSITIVE CUSTOMER','Contact Name','Dealertrack Loan Number']){
   assert(!html.includes(forbidden),`Private dashboard unexpectedly contains ${forbidden}`);
   assert(!json.includes(forbidden),`Private aggregate JSON unexpectedly contains ${forbidden}`);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('private outputs are refused inside public Git checkout',async()=>{
 await assert.rejects(()=>buildDashboard({
  adsPath:path.join(HERE,'fixtures/synthetic/ads.csv'),
  crmPath:path.join(HERE,'fixtures/synthetic/crm.csv'),
  dmsPath:path.join(HERE,'fixtures/synthetic/dms.csv'),
  outputDir:path.join(HERE,'private-output'),asOf:'2026-11-10',synthetic:true
 }),/inside the public source repository/);
});
test('synthetic fixtures cannot silently be presented as real data',async()=>{
 await assert.rejects(()=>buildDashboard({
  adsPath:path.join(HERE,'fixtures/synthetic/ads.csv'),
  crmPath:path.join(HERE,'fixtures/synthetic/crm.csv'),
  dmsPath:path.join(HERE,'fixtures/synthetic/dms.csv'),
  outputDir:path.join(tmpdir(),'amqur-uncreated-preview'),asOf:'2026-11-10',synthetic:false
 }),/require explicit --synthetic/);
});
test('stock comparison remains provisional; no cost-per-sold or ad ROAS is fabricated',()=>{
 const payload=makePayload({registry,...parse(),asOf:'2026-11-10'});
 assert.equal(payload.totals.verified_deliveries,undefined);
 assert.equal(payload.totals.cost_per_sold,undefined);
 assert(!JSON.stringify(payload).includes('confirmed_sold'));
 assert.match(payload.action_register[0].evidence,/No posted\/delivery confirmation/);
});