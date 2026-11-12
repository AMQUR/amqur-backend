/**
 * AMQUR private refresh runner. No vendor API, network, GitHub artifact or production write.
 * Either consumes already validated aggregates or performs local-only Tekion CSV reduction.
 * Requires Node 22 with --experimental-strip-types (policy used by staff API).
 */
import path from 'node:path';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { convertDirectory } from './tekion-export-to-aggregates.mjs';
import { buildFromManifest } from './tekion-deals-to-aggregates.mjs';
import { buildDashboard } from './build-dashboard.mjs';
import { projectDealerIntelligenceSnapshot } from '../../src/operations/dealer-intelligence.policy.ts';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE,'../..');
function contains(base,target) {
  const rel=path.relative(base,target);
  return rel===''||(rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel));
}
function date(value) {
  if (typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid --as-of date');
  const parsed=new Date(value+'T00:00:00Z');
  if(Number.isNaN(parsed.valueOf())||parsed.toISOString().slice(0,10)!==value)throw new Error('Invalid --as-of date');
  return value;
}
function requirePath(s,label) {
  if(!s||!path.isAbsolute(s))throw new Error(label+' must be an absolute path');
  return path.resolve(s);
}
async function atomicWrite(target,content) {
  const p=target+'.new';
  try {await lstat(p);throw new Error('Existing pending snapshot file; manual review required');}
  catch(e){if(e.code!=='ENOENT')throw e;}
  try {await writeFile(p,content,{encoding:'utf8',mode:0o600,flag:'wx'});await rename(p,target);}
  finally{await rm(p,{force:true}).catch(()=>{});}
}
export async function refreshPrivate({adsPath,crmAggregatePath,dmsAggregatePath,crmInputDir,dmsManifestPath,privateRoot,asOf,synthetic=false}) {
  const root=requirePath(privateRoot,'--private-root');
  const repoReal=await realpath(REPO);
  if(contains(repoReal,root))throw new Error('Private report directory must be outside public source repo');
  if (!adsPath)throw new Error('Missing required authorized --ads aggregate');
  if (Boolean(crmAggregatePath)===Boolean(crmInputDir))throw new Error('Choose exactly one CRM aggregate or raw CRM input directory');
  if (Boolean(dmsAggregatePath)===Boolean(dmsManifestPath))throw new Error('Choose exactly one DMS aggregate or raw DMS manifest');
  const cutoff=date(asOf);
  await mkdir(root,{recursive:true,mode:0o700});
  const actualRoot=await realpath(root);
  if(actualRoot!==root||contains(repoReal,actualRoot))throw new Error('Untrusted private output path');
  const rootStat=await lstat(actualRoot);
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||(rootStat.mode&0o027)!==0){
    throw new Error('Private report root must be an actual directory without public permissions');
  }
  const lockPath=path.join(root,'.refresh.lock');
  let lock;
  try {lock=await open(lockPath,'wx',0o600);}
  catch(e){throw new Error('A refresh may already be running; investigate stale lock before retrying');}
  let temp;
  try {
    temp=await mkdtemp(path.join(root,'.candidate-'));
    const dataDir=path.join(temp,'input');
    await mkdir(dataDir,{mode:0o700});
    let crmFile=crmAggregatePath,dmsFile=dmsAggregatePath;
    if(crmInputDir){
      await convertDirectory({inputDir:requirePath(crmInputDir,'--crm-input'),outputDir:dataDir});
      crmFile=path.join(dataDir,'crm.csv');
    }
    if(dmsManifestPath){
      await buildFromManifest({manifestPath:requirePath(dmsManifestPath,'--dms-manifest'),outDir:dataDir,start:'2026-08-01',end:cutoff});
      dmsFile=path.join(dataDir,'dms_retail_candidates.csv');
    }
    const built=await buildDashboard({adsPath:requirePath(adsPath,'--ads'),crmPath:requirePath(crmFile,'CRM aggregate'),
      dmsPath:requirePath(dmsFile,'DMS aggregate'),outputDir:path.join(temp,'report'),asOf:cutoff,synthetic});
    const safe=built.payload;
    if (!synthetic)projectDealerIntelligenceSnapshot(safe);
    // Synthetic test output must remain isolated and NEVER be promoted to the API snapshot file.
    if(synthetic)return {published:false,synthetic:true,asOf:cutoff};
    const reportJson=await readFile(path.join(temp,'report/aggregate-report.json'),'utf8');
    const brief=await readFile(path.join(temp,'report/owner-brief.md'),'utf8');
    const source=await readFile(path.join(temp,'report/source-manifest.json'),'utf8');
    await atomicWrite(path.join(root,'owner-brief.md'),brief);
    await atomicWrite(path.join(root,'source-manifest.json'),source);
    // Published LAST: API will never serve a candidate snapshot whose build was interrupted.
    await atomicWrite(path.join(root,'aggregate-report.json'),reportJson);
    return {published:true,synthetic:false,asOf:cutoff,rows:{ads:safe.ads.length,crm:safe.crm.length,dms:safe.dms.length}};
  } finally {
    if(temp)await rm(temp,{recursive:true,force:true}).catch(()=>{});
    await lock?.close();await rm(lockPath,{force:true}).catch(()=>{});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const opt=k=>{const i=process.argv.indexOf(k);return i<0?undefined:process.argv[i+1]};
  refreshPrivate({adsPath:opt('--ads'),crmAggregatePath:opt('--crm-aggregate'),dmsAggregatePath:opt('--dms-aggregate'),
    crmInputDir:opt('--crm-input'),dmsManifestPath:opt('--dms-manifest'),privateRoot:opt('--private-root'),
    asOf:opt('--as-of'),synthetic:process.argv.includes('--synthetic')}).then(result=>{
      process.stdout.write(result.published?`Validated private snapshot published (cutoff ${result.asOf}).\n`:'Synthetic smoke completed; no report was published.\n');
    }).catch(err=>{process.stderr.write(`Private refresh rejected: ${err.message}\n`);process.exitCode=1;});
}