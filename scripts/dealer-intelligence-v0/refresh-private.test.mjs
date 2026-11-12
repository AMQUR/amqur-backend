/** Safe synthetic-only test suite. No real dealership inputs or outputs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshPrivate } from './refresh-private.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const demo=path.join(HERE,'fixtures/synthetic');
const params=(root)=>({adsPath:path.join(demo,'ads.csv'),crmAggregatePath:path.join(demo,'crm.csv'),
  dmsAggregatePath:path.join(demo,'dms.csv'),privateRoot:root,asOf:'2026-11-10'});
test('synthetic fixture refresh never publishes to API even when paths are valid',async()=>{
  const base=await mkdtemp(path.join(tmpdir(),'amqur-private-refresh-'));
  try {
    const root=path.join(base,'data');
    const res=await refreshPrivate({...params(root),synthetic:true});
    assert.equal(res.published,false);
    await assert.rejects(()=>stat(path.join(root,'aggregate-report.json')));
  } finally {await rm(base,{recursive:true,force:true});}
});
test('reject incomplete source choices, invalid dates, and repository paths before publication',async()=>{
  const base=await mkdtemp(path.join(tmpdir(),'amqur-private-refresh-'));
  try {
    const root=path.join(base,'data');
    await assert.rejects(()=>refreshPrivate({...params(root),crmAggregatePath:undefined,synthetic:true}));
    await assert.rejects(()=>refreshPrivate({...params(root),asOf:'2026-02-31',synthetic:true}));
    await assert.rejects(()=>refreshPrivate({...params(path.join(HERE,'unsafe')),synthetic:true}));
  }finally{await rm(base,{recursive:true,force:true});}
});
test('reject synthetic fixture files when someone forgets --synthetic, without replacing snapshot',async()=>{
  const base=await mkdtemp(path.join(tmpdir(),'amqur-private-refresh-'));
  try {
    const root=path.join(base,'data');
    await assert.rejects(()=>refreshPrivate(params(root)));
    await assert.rejects(()=>stat(path.join(root,'aggregate-report.json')));
  }finally{await rm(base,{recursive:true,force:true});}
});