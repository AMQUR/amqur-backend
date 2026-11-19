import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {soldISO,cents,aggregateDeals,buildFromManifest} from './tekion-deals-to-aggregates.mjs';
import {parseDms} from './build-dashboard.mjs';

const header='Deal#,Deal Type,Stock Type,Status,Sold Date,Front Gross,Back Gross,Total Gross,Delivery Status,Deal Confirmed,Customer,Customer Email';
const makeRow=(a)=>[...a,'SENSITIVE CUSTOMER','secret@example.invalid'].join(',');
const valid=makeRow(['A1','PERSONAL','NEW','CLOSED_OR_SOLD','10/30/2026','$100.00','$50.00','$150.00','','No']);
const booked=makeRow(['A2','BUSINESS','used','BOOKED','11/05/2026','-$30.00','$50.00','$20.00','','No']);
const quote=makeRow(['A3','PERSONAL','NEW','QUOTE','10/31/2026','$100.00','$0.00','$100.00','','No']);
const unwind=makeRow(['A4','PERSONAL','NEW','UNWIND','11/01/2026','$100.00','$0.00','$100.00','','No']);
const wholesale=makeRow(['A5','WHOLESALE','USED','CLOSED_OR_SOLD','10/30/2026','$100.00','$0.00','$100.00','','No']);
const trade=makeRow(['A6','ONLY_TRADES','','CLOSED_OR_SOLD','10/31/2026','$100.00','$0.00','$100.00','','No']);
const sample=[header,valid,booked,quote,unwind,wholesale,trade].join('\n')+'\n';

test('mm/dd/yyyy and ISO dates are validated without time guessing',()=>{
 assert.equal(soldISO('11/05/2026'),'2026-11-05');
 assert.equal(soldISO('2026-11-05'),'2026-11-05');
 assert.equal(soldISO('02/30/2026'),null);
 assert.equal(soldISO('11/05/26'),null);
});
test('money parsing uses exact cents and rejects untrusted units',()=>{
 assert.equal(cents('$1,234.56'),123456);
 assert.equal(cents('-$3.00'),-300);
 assert.equal(cents('bad'),null);
});
test('retail candidates exclude quotes, unwinds, wholesale and trade only',()=>{
 const r=aggregateDeals({text:sample,store:'nissan',start:'2026-10-28',end:'2026-11-10'});
 assert.equal(r.quality.raw_rows,6);
 assert.equal(r.quality.candidates,2);
 assert.equal(r.quality.new_candidates,1);
 assert.equal(r.quality.used_candidates,1);
 assert.equal(r.quality.quote_with_sold_date,1);
 assert.equal(r.quality.unwind_with_sold_date,1);
 assert.equal(r.quality.gross_sum_mismatch,0);
 assert.equal(r.quality.total_gross_cents,17000);
 assert.equal(r.daily.length,2);
});
test('same-store duplicate deal references are skipped, not double counted',()=>{
 const r=aggregateDeals({text:[header,valid,valid].join('\n'),store:'nissan',start:'2026-10-28',end:'2026-11-10'});
 assert.equal(r.quality.candidates,1);
 assert.equal(r.quality.duplicate_deal_ref,1);
});
test('unknown store, malformed headers and date windows fail closed',()=>{
 assert.throws(()=>aggregateDeals({text:sample,store:'group',start:'2026-10-28',end:'2026-11-10'}));
 assert.throws(()=>aggregateDeals({text:'name,email\na,b\n',store:'nissan',start:'2026-10-28',end:'2026-11-10'}));
 assert.throws(()=>aggregateDeals({text:sample,store:'nissan',start:'2026-11-10',end:'2026-11-01'}));
});
test('output omits customer information and private deal identifiers',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'amqur-deal-test-'));
 try {
  const input=path.join(dir,'deal-input.csv'),manifest=path.join(dir,'manifest.json'),out=path.join(dir,'output');
  await writeFile(input,sample);
  await writeFile(manifest,JSON.stringify({files:[{store:'nissan',path:input}]}));
  const data=await buildFromManifest({manifestPath:manifest,outDir:out,start:'2026-10-28',end:'2026-11-10'});
  assert.equal(data.stores.nissan.quality.candidates,2);
  const csv=await readFile(path.join(out,'dms_retail_candidates.csv'),'utf8');
  const qa=await readFile(path.join(out,'dms_quality.json'),'utf8');
  const parsed=parseDms(csv,new Set(['nissan']));
  assert.equal(parsed.length,28); // 14 calendar days × two new/used business lines
  assert.equal(parsed.reduce((n,r)=>n+r.retail_candidates,0),2);
  assert(parsed.some(r=>r.date==='2026-11-10'&&r.business_line==='new'&&r.retail_candidates===0));
  for (const s of ['SENSITIVE CUSTOMER','secret@example.invalid','A1','A2','Customer Email']) {
    assert.ok(!csv.includes(s),`CSV leaked ${s}`);
    assert.ok(!qa.includes(s),`QA leaked ${s}`);
  }
 } finally {await rm(dir,{recursive:true,force:true});}
});