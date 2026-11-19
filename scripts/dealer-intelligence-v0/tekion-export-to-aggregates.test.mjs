import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseTekionDate,parseTekionAggregate,emitAggregate,convertDirectory } from './tekion-export-to-aggregates.mjs';

const shops=['Dial Chevy','Dial Nissan of Chicago','INFINITI OF CHICAGO','Dial Chrysler Dodge Jeep Ram','Chrysler Dodge Jeep RAM of Chicago'];
const header='"Dealership","Contact Name","Creation Time","Status","Department","Sales Lead Type","Stock Type","Source","Sold Date"';
const text=(shop, extra='')=>[header,`"${shop}","SYNTHETIC DUMMY","Nov 4 2026  3:35 PM","Active","Sales","VEHICLE_PURCHASE","New","DAG | Google Ads",""`, extra].filter(Boolean).join('\n');

test('parses Tekion clock formats without inferred timezone offsets',()=>{
 assert.equal(parseTekionDate('Nov 11 2026  2:28 PM'),'2026-11-11');
 assert.equal(parseTekionDate('Oct 10 2026  12:31 AM'),'2026-10-10');
 assert.throws(()=>parseTekionDate('Feb 31 2026  2:00 PM'));
 assert.throws(()=>parseTekionDate('Tomorrow at 11:45 AM'));
});
test('filters duplicate, bad and service records; preserves unknown vehicle type',()=>{
 const lines=[text(shops[0]),`"${shops[0]}","SYNTHETIC DUMMY","Nov 4 2026  3:36 PM","Duplicate","Sales","VEHICLE_PURCHASE","Used","DAG | Meta Ads",""`,
 `"${shops[0]}","SYNTHETIC DUMMY","Nov 4 2026  3:37 PM","Bad","Sales","VEHICLE_PURCHASE","Used","DAG | Meta Ads",""`,
 `"${shops[0]}","SYNTHETIC DUMMY","Nov 4 2026  3:38 PM","Active","Service","","","Website",""`,
 `"${shops[0]}","SYNTHETIC DUMMY","Nov 5 2026  3:38 PM","Active","Sales","VEHICLE_PURCHASE","","Website",""`].join('\n');
 const r=parseTekionAggregate(lines);
 assert.deepEqual([r.stats.raw,r.stats.duplicates,r.stats.bad,r.stats.service,r.stats.eligible],[5,1,1,1,2]);
 assert.equal(r.daily.get('2026-11-04|new'),1);
 assert.equal(r.daily.get('2026-11-05|unclassified'),1);
});
test('fail closed on unknown dealership alias',()=>assert.throws(()=>parseTekionAggregate(text('Some Other Dealer')),/Unknown Tekion dealership/));
test('fail closed on duplicate store exports',()=>{
 const inputs=shops.map(shop=>parseTekionAggregate(text(shop)));
 assert.throws(()=>emitAggregate([...inputs.slice(0,4),inputs[0]]),/Repeated store export/);
});
test('synthetic full set emits safe seven-column aggregate, blank downstream outcomes',()=>{
 const inputs=shops.map(shop=>parseTekionAggregate(text(shop)));
 const o=emitAggregate(inputs);
 assert.equal(o.crmCsv.trim().split('\n').length,16);
 assert.ok(o.crmCsv.startsWith('date,store,business_line,leads,appointments,shows,sold\n'));
 assert.ok(o.crmCsv.includes('2026-11-04,nissan,new,1,,,'));
 assert.ok(!o.crmCsv.includes('SYNTHETIC DUMMY'));
 assert.ok(!o.crmCsv.includes('DAG | Google Ads'));
 assert.equal(o.quality.appointments_shows_sold.startsWith('UNKNOWN'),true);
});
test('local conversion writes no personal information, never stores raw identifiers',async()=>{
 const parent=await mkdtemp(path.join(os.tmpdir(),'amqur-tekion-import-'));
 try{
  const incoming=path.join(parent,'in'), out=path.join(parent,'out');await mkdir(incoming);
  for (let i=0;i<5;i++) await writeFile(path.join(incoming,`_CRM_LEAD_LIST_synthetic-${i}.csv`),text(shops[i]));
  const r=await convertDirectory({inputDir:incoming,outputDir:out});
  assert.equal(r.rows,15);
  const exported=await readFile(path.join(out,'crm.csv'),'utf8');
  assert.ok(!exported.includes('Contact Name'));
  assert.ok(!exported.includes('SYNTHETIC DUMMY'));
  assert.equal(r.quality.stores.length,5);
 }finally{await rm(parent,{recursive:true,force:true});}
});
