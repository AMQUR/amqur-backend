import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseDms,makePayload} from './build-dashboard.mjs';
import {parseInput} from './scorecard.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const registry={rooftops:[
  {key:'chevy',displayName:'Dial Chevy of Chicago'},
  {key:'nissan',displayName:'Dial Nissan of Chicago'},
  {key:'infiniti',displayName:'INFINITI of Chicago'},
  {key:'cdjr-south',displayName:'Dial Chrysler Dodge Jeep Ram of Chicago (South)'},
  {key:'jeep-north',displayName:'Jeep of Chicago (North CDJR)'}]};
const ads='date,store,platform,business_line,spend_usd,impressions,clicks,reported_conversions\n2026-11-05,chevy,google_ads,unclassified,20.50,200,10,1.2\n2026-11-05,group,google_ads,unclassified,3.00,100,5,1\n';
const crm='date,store,business_line,leads,appointments,shows,sold\n2026-11-05,chevy,used,20,,,\n';
const dms='sold_date,store,business_line,retail_candidates,status,source\n2026-09-05,nissan,new,5,PROVISIONAL_NOT_POSTED,Tekion Deal List\n2026-10-05,nissan,new,2,PROVISIONAL_NOT_POSTED,Tekion Deal List\n2026-11-05,chevy,used,4,PROVISIONAL_NOT_POSTED,Tekion Deal List\n';
function input(){const ids=registry.rooftops.map(x=>x.key);return makePayload({registry,ads:parseInput('ads',ads,[...ids,'group']),crm:parseInput('crm',crm,ids),dms:parseDms(dms,new Set(ids)),asOf:'2026-11-10',synthetic:true});}
async function renderClient(){
 const template=await readFile(path.join(HERE,'dashboard-template.html'),'utf8');
 const scripts=[...template.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
 assert.equal(scripts.length,1,'Expected exactly one inline client script in the source template');
 const code=scripts[0][1];
 new vm.Script(code,{filename:'dashboard-client.js'});
 const elements=new Map(),clicks=[];
 const element=id=>{
  if(!elements.has(id)) elements.set(id,{id,value:'',textContent:'',innerHTML:'',options:[],add(o){this.options.push(o);},click(){clicks.push(id);}});
  return elements.get(id);
 };
 const document={getElementById:element,createElement:element};
 element('amqur-data').textContent=JSON.stringify(input());
 let href=null;
 const context={document,window:{print(){}},Option:function(label,value){return {label,value};},
  Intl,Date,Math,JSON,Number,Set,Array,String,Object,Blob,
  URL:{createObjectURL(){return 'blob://private-test';},revokeObjectURL(){}},
  setTimeout(fn){fn();},console};
 vm.runInNewContext(code,context,{timeout:3000});
 return {elements,element,clicks,getHref:()=>href};
}
test('inline dashboard JavaScript parses, renders and exposes five store filters',async()=>{
 const {element}=await renderClient();
 assert.equal(element('store-filter').options.length,6);
 assert.equal(element('period-filter').options.length,6);
 assert.equal(element('kpi-retail').textContent,'4');
 assert.equal(element('kpi-leads').textContent,'20');
 assert.equal(element('kpi-ads').textContent,'$20.50');
 assert.match(element('activity-chart').innerHTML,/<svg /);
 assert.match(element('store-table').innerHTML,/Dial Nissan/);
});
test('period, store and line filters update independent KPIs without inventing spend allocations',async()=>{
 const {element}=await renderClient();
 element('period-filter').value='prev';element('period-filter').onchange();
 assert.equal(element('kpi-retail').textContent,'2');
 assert.equal(element('kpi-ads').textContent,'N/A');
 element('store-filter').value='nissan';element('store-filter').onchange();
 assert.equal(element('kpi-retail').textContent,'2');
 element('line-filter').value='new';element('line-filter').onchange();
 assert.equal(element('kpi-retail').textContent,'2');
 assert.equal(element('kpi-ads').textContent,'N/A');
 assert.match(element('kpi-ads-sub').textContent,/not split by new\/used/);
});
test('client controls have handlers and dynamic action register is never marked approved',async()=>{
 const {element}=await renderClient();
 assert.equal(typeof element('export-btn').onclick,'function');
 assert.equal(typeof element('print-btn').onclick,'function');
 assert.match(element('action-list').innerHTML,/Needs Review/);
 assert(!element('action-list').innerHTML.includes('Approved ·'));
 assert(!element('action-list').innerHTML.includes('Implemented ·'));
});