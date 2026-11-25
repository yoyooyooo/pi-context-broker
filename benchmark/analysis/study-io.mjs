import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalJson,fingerprint} from '../protocol.mjs';
import {verifyBundle,verifyArtifactFiles} from '../evidence/store.mjs';
import {OFFLINE_STUDY_SOURCE_FILES} from '../offline-source-files.mjs';
import {createAnalysisPlan} from './compare.mjs';
import {createStudyDesign,validateStudyDesign,bindStudyPlan,scoreStudy} from './study.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fields=(value,keys)=>assert.deepEqual(Object.keys(value).sort(),[...keys].sort(),'Study command fields changed');
const equal=(a,b,message)=>assert.equal(fingerprint(a),fingerprint(b),message);
const seal=value=>({...value,record_sha256:fingerprint({...value,record_sha256:null})});
const checked=value=>{equal(value.record_sha256,fingerprint({...value,record_sha256:null}),'Study record changed');return value;};

export async function studyImplementation() {
  const files=[];
  for(const path of [...OFFLINE_STUDY_SOURCE_FILES].sort()) {
    const bytes=await readFile(join(root,path));files.push({path,sha256:hash(bytes),bytes:bytes.length});
  }
  return {version:1,scope:'offline study, canonical scorer, evidence verifier and exact static inputs',files,sha256:fingerprint(files)};
}

async function readReference(ref,{paths={},retained}={}) {
  assert.ok(ref&&isAbsolute(ref.path)&&resolve(ref.path)===ref.path,'Use an absolute original record path');
  assert.match(ref.sha256,/^[a-f0-9]{64}$/);
  const path=paths[ref.sha256]??ref.path;assert.ok(isAbsolute(path)&&resolve(path)===path);
  assert.equal(await realpath(path),path,'Study input cannot use a symlink');assert.ok((await lstat(path)).isFile());
  const bytes=await readFile(path);assert.equal(hash(bytes),ref.sha256,'Study input bytes changed');
  if(ref.bytes!==undefined)assert.equal(bytes.length,ref.bytes);
  if(retained)retained.set(ref.sha256,bytes);
  return JSON.parse(bytes);
}

async function save(path,value) {
  assert.ok(isAbsolute(path)&&resolve(path)===path);assert.equal(await realpath(dirname(path)),dirname(path));
  const bytes=Buffer.from(canonicalJson(value)+'\n');await writeFile(path,bytes,{flag:'wx',mode:0o600});
  return {path,sha256:hash(bytes),bytes:bytes.length};
}

export async function freezeStudyDesignFile({request,outputFile}) {
  fields(request,['id','confidence','series','commitments']);
  const implementation=await studyImplementation(),design=createStudyDesign({...request,registeredAt:new Date().toISOString()});
  const record=seal({version:1,kind:'benchmark-study-design-record',design,implementation,model_requests:0,remote_writes:0,record_sha256:null});
  return {status:'design-frozen',reference:await save(outputFile,record),design_sha256:design.design_sha256,
    simultaneous_claim_count:design.claim_ledger.count,model_requests:0,execution_performed:false};
}

async function beforeDispatch(plan) {
  const control=plan.execution.control_root;assert.ok(isAbsolute(control)&&resolve(control)===control);
  assert.equal(await realpath(control),control,'Panel control root cannot be redirected');
  for(const name of ['lease.json','batch.lease.json']) {
    try {await lstat(join(control,name));assert.fail('Study must bind before a panel runner is active');}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const path=join(control,'ledger.jsonl');let receipt;
  try {
    assert.equal(await realpath(path),path);const bytes=await readFile(path);
    assert.equal(bytes.length,0,'Study must bind before any panel ledger activity, including invalid or zero-send attempts');
    receipt={path,status:'empty',sha256:hash(bytes),bytes:0};
  } catch(error){if(error.code!=='ENOENT')throw error;receipt={path,status:'absent'};}
  return {plan_id:plan.id,observed_at:new Date().toISOString(),ledger:receipt};
}

export async function bindStudyPlanFile({request,outputFile}) {
  fields(request,['design','panels']);
  const designRecord=checked(await readReference(request.design));assert.equal(designRecord.kind,'benchmark-study-design-record');
  equal(designRecord.implementation,await studyImplementation(),'Study source changed after design freeze');
  validateStudyDesign(designRecord.design);
  const panels=[],preDispatch=[];
  for(const entry of request.panels) {
    fields(entry,['series_id','panel_id','plan','condition_map']);
    const plan=await readReference(entry.plan);panels.push({...entry,plan});preDispatch.push(await beforeDispatch(plan));
  }
  const plan=bindStudyPlan({design:designRecord.design,panels,registeredAt:new Date().toISOString()});
  const record=seal({version:1,kind:'benchmark-study-plan-record',plan,design_reference:request.design,panel_references:request.panels,
    implementation:designRecord.implementation,pre_dispatch:preDispatch,model_requests:0,remote_writes:0,record_sha256:null});
  return {status:'study-bound-before-dispatch',reference:await save(outputFile,record),plan_sha256:plan.plan_sha256,
    planned_slots:plan.planned_slots,model_requests:0,execution_performed:false};
}

export async function readStudyAnalysisRequest(request,{recordPaths={},rawOptions={}}={}) {
  fields(request,['plan','panels']);const retained=new Map(),read=ref=>readReference(ref,{paths:recordPaths,retained});
  const record=checked(await read(request.plan));assert.equal(record.kind,'benchmark-study-plan-record');
  equal(record.implementation,await studyImplementation(),'Analysis uses another study implementation');
  const design=checked(await read(record.design_reference));assert.equal(design.kind,'benchmark-study-design-record');
  equal(design.design,record.plan.design,'Bound design differs from the retained declaration');equal(design.implementation,record.implementation);
  const panels=[],rawFiles=new Map();
  assert.equal(request.panels.length,record.panel_references.length,'Every planned panel needs an explicit analysis, including an empty one');
  for(const reference of record.panel_references) {
    const source=request.panels.find(p=>p.series_id===reference.series_id&&p.panel_id===reference.panel_id);assert.ok(source,'Missing panel analysis');
    fields(source,['series_id','panel_id','analysis_input','analysis']);
    const plan=await read(reference.plan),input=await read(source.analysis_input),analysis=await read(source.analysis);
    equal(input.protocol,plan.protocol,'Analysis input uses another panel protocol');
    if(input.plan!==undefined)equal(input.plan,createAnalysisPlan(plan.protocol),'Analysis input changes the planned denominator');
    assert.ok(Array.isArray(input.episodes));
    for(const episode of input.episodes) {
      await verifyBundle({episode},rawOptions);
      for(const {artifact,bytes} of (await verifyArtifactFiles(episode.artifacts,rawOptions)).values())rawFiles.set(artifact.sha256,bytes);
    }
    panels.push({series_id:source.series_id,panel_id:source.panel_id,plan,episodes:input.episodes,analysis});
  }
  const analysis=scoreStudy({plan:record.plan,panels});
  return {analysis,input:{plan:record.plan,panels},retained,rawFiles,implementation:record.implementation};
}

export function renderStudyMarkdown(analysis) {
  const lines=['# Benchmark study report','','- Study: '+analysis.study_id+' (`'+analysis.study_plan_sha256+'`).',
    '- Analysis: `'+analysis.analysis_sha256+'`.',
    '- Joint confidence: '+analysis.inference.confidence+'; registered claims: '+analysis.inference.claim_ledger.count+'.',
    '- Actual runs: '+analysis.cost_ledger.actual_runs+'; invalid originals retained: '+analysis.cost_ledger.invalid_runs+'.',
    '- Known input/output subtotals: '+analysis.cost_ledger.known_input_subtotal+' / '+analysis.cost_ledger.known_output_subtotal+'.',
    '- Usage-incomplete runs: '+analysis.cost_ledger.usage_incomplete_run_ids.length+'. Known subtotals do not replace missing totals.',''];
  const display=value=>value===null||value===undefined?'unknown':String(value);
  for(const series of analysis.series) {
    lines.push('## '+series.id,'',series.estimand+'.',
      'Planned slots: '+series.completeness.planned_slots+'; valid: '+series.completeness.valid_slots+'; unresolved: '+series.completeness.unresolved_slots.length+'.','',
      '| Logical condition | Verified quality | Joint interval | Known failure | Unknown | Unresolved |',
      '|---|---:|---|---:|---:|---:|');
    for(const c of series.analysis.conditions) {
      const q=c.metrics.verified_quality,ci=q.interval;
      lines.push('| '+c.condition_id+' | '+display(q.estimate)+' | '+(ci.status==='available'?'['+ci.lower+', '+ci.upper+']':ci.status)+' | '+display(c.metrics.known_failure.estimate)+' | '+c.counts.unknown+' | '+c.counts.unresolved+' |');
    }
    lines.push('','| Comparison | Quality difference | Joint interval | Input ratio | Capped-time ratio |','|---|---:|---|---:|---:|');
    for(const c of series.analysis.comparisons) {
      const ci=c.quality_delta.interval;
      lines.push('| '+c.candidate+' / '+c.reference+' | '+display(c.quality_delta.estimate)+' | '+(ci.status==='available'?'['+ci.lower+', '+ci.upper+']':ci.status)+' | '+display(c.input_ratio.estimate)+' | '+display(c.time_ratio.estimate)+' |');
    }
    lines.push('');
  }
  lines.push('## Interpretation','',...analysis.limitations.map(item=>'- '+item),'',
    'Every local panel result in analysis.json is recomputed with the same study-wide claim count. The original canonical panel analysis hash is retained separately.',
    'Run `node replay.mjs --out /absolute/new-directory` to verify raw artifacts and reproduce this package without models, credentials or package installation.','');
  return lines.join('\n');
}

export async function writeStudyReport({request,directory,recordPaths={},rawOptions={}}) {
  assert.ok(isAbsolute(directory)&&resolve(directory)===directory);assert.equal(await realpath(dirname(directory)),dirname(directory));
  const verified=await readStudyAnalysisRequest(request,{recordPaths,rawOptions});
  const files=new Map([['request.json',Buffer.from(canonicalJson(request)+'\n')],['analysis.json',Buffer.from(canonicalJson(verified.analysis)+'\n')],
    ['report.md',Buffer.from(renderStudyMarkdown(verified.analysis))]]);
  for(const [sha256,bytes] of verified.retained)files.set('records/'+sha256,bytes);
  for(const [sha256,bytes] of verified.rawFiles)files.set('raw/'+sha256,bytes);
  for(const item of verified.implementation.files) {
    const bytes=await readFile(join(root,item.path));assert.equal(hash(bytes),item.sha256,'Study implementation changed while exporting');
    files.set('offline/'+item.path,bytes);
  }
  files.set('replay.mjs',Buffer.from(`import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(await readFile(join(root,'study-report-manifest.json'),'utf8'));
for(const item of manifest.files){
  if(!item.path||item.path.startsWith('/')||item.path.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Unsafe package path');
  const bytes=await readFile(join(root,item.path));
  if(bytes.length!==item.bytes||createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new Error('Study package changed: '+item.path);
}
const index=process.argv.indexOf('--out');if(index<0||!process.argv[index+1])throw new Error('Use --out /absolute/new-directory');
const request=JSON.parse(await readFile(join(root,'request.json'),'utf8'));
const recordPaths=Object.fromEntries(manifest.files.filter(f=>f.path.startsWith('records/')).map(f=>[f.sha256,join(root,f.path)]));
const pathsBySha256=Object.fromEntries(manifest.files.filter(f=>f.path.startsWith('raw/')).map(f=>[f.sha256,join(root,f.path)]));
const {writeStudyReport}=await import('./offline/benchmark/analysis/study-io.mjs');
const result=await writeStudyReport({request,directory:resolve(process.argv[index+1]),recordPaths,rawOptions:{root,pathsBySha256}});
if(result.analysis_sha256!==manifest.analysis_sha256)throw new Error('Replayed study analysis differs');
process.stdout.write(JSON.stringify(result)+'\\n');
`));
  // Reserve an exclusive directory only after every input and raw locator passed.
  await mkdir(directory,{mode:0o700});
  for(const [path,bytes] of files) {await mkdir(dirname(join(directory,path)),{recursive:true});await writeFile(join(directory,path),bytes,{flag:'wx',mode:0o600});}
  const manifest={version:1,kind:'benchmark-study-report',study_plan_sha256:verified.analysis.study_plan_sha256,
    analysis_sha256:verified.analysis.analysis_sha256,implementation:verified.implementation,
    files:[...files].map(([path,bytes])=>({path,sha256:hash(bytes),bytes:bytes.length})),raw_evidence_included:true,model_requests:0};
  await save(join(directory,'study-report-manifest.json'),manifest);
  return {status:'written',directory,analysis_sha256:verified.analysis.analysis_sha256,planned_slots:verified.input.plan.planned_slots,
    actual_runs:verified.analysis.cost_ledger.actual_runs,simultaneous_claim_count:verified.analysis.inference.claim_ledger.count,model_requests:0,execution_performed:false};
}
