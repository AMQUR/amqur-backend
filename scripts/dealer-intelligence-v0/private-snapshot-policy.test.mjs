/** Contract-only tests. Every input below is generated from explicitly synthetic CSV fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInput } from './scorecard.mjs';
import { makePayload, parseDms } from './build-dashboard.mjs';
import { projectDealerIntelligenceSnapshot } from '../../src/operations/dealer-intelligence.policy.ts';
const HERE = path.dirname(fileURLToPath(import.meta.url));
async function fixture() {
  const fixtureDir=path.join(HERE,'fixtures/synthetic');
  const registry=JSON.parse(await readFile(path.resolve(HERE,'../../config/rooftops/registry.json'),'utf8'));
  const storeIds=registry.rooftops.map(x=>x.key);
  const [ads,crm,dms]=await Promise.all(['ads','crm','dms'].map(name=>readFile(path.join(fixtureDir,`${name}.csv`),'utf8')));
  const parsed={registry,ads:parseInput('ads',ads,[...storeIds,'group']),crm:parseInput('crm',crm,storeIds),dms:parseDms(dms,new Set(storeIds)),asOf:'2026-11-10'};
  // We intentionally model a production-shaped snapshot IN MEMORY for validator tests only.
  // This test creates no real report, does not write to disk and does not claim real results.
  return makePayload({...parsed,synthetic:false});
}
test('whitelists aggregate schemas while preserving unknown/null outcomes',async()=>{
  const payload=await fixture();
  const out=projectDealerIntelligenceSnapshot(payload);
  assert.equal(out.stores.length,5);
  assert.equal(out.schema,'amqur.dealer-intelligence.private-preview.v1');
  assert.deepEqual(Object.keys(out.crm[0]),['date','store','business_line','leads','appointments','shows','sold']);
  assert.equal(out.action_register.every(x=>x.approval_status==='Needs Review'&&x.implemented==='No'),true);
});
test('rejects synthetic snapshot flags, duplicates and unknown rooftops',async()=>{
  const original=await fixture();
  for(const mutate of [r=>{r.synthetic=true},r=>{r.stores[0].key='wrong'},r=>{r.dms.push({...r.dms[0]})}]){
    const r=structuredClone(original);mutate(r);
    assert.throws(()=>projectDealerIntelligenceSnapshot(r));
  }
});
test('rejects personal data columns, PII in descriptions, and tampered totals',async()=>{
  const original=await fixture();
  for(const mutate of [
    r=>{r.crm[0].customer_email='someone@example.com'},
    r=>{r.action_register[0].evidence='person@example.com'},
    r=>{r.totals.crm_purchase_lead_records+=1},
    r=>{r.ads[0].spend_usd=-1},
    r=>{r.coverage.crm.rows+=1},
  ]){
    const r=structuredClone(original);mutate(r);
    assert.throws(()=>projectDealerIntelligenceSnapshot(r));
  }
});