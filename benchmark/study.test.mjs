import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readFile,mkdir,realpath,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fingerprint} from './protocol.mjs';
import {createPreregistrationTemplate} from './templates/preregistration.mjs';
import {boundedBudget,preregisterComparison} from './planning.mjs';
import {freezeBatchPlan} from './batch.mjs';
import {normalizeEpisode} from './evidence/normalize.mjs';
import {exampleEnvelope} from './analysis/fixtures.mjs';
import {scoreExperiment} from './analysis/compare.mjs';
import {createStudyDesign,bindStudyPlan,scoreStudy,studyConditionProfile} from './analysis/study.mjs';
import {freezeStudyDesignFile,bindStudyPlanFile,writeStudyReport} from './analysis/study-io.mjs';

// Real protocol/normalizer/scorer paths, with explicitly synthetic observations.
// No fixture in this file is an actual model execution or confirmation material.
const cases=[{id:'c1',family:'f1',cluster_id:'shared'},{id:'c2',family:'f1',cluster_id:'shared'},{id:'c3',family:'f2',cluster_id:'other'}];
const hash=label=>fingerprint({synthetic_study_test:label});
const seal=p=>{for(const e of p.environments)e.manifest_sha256=fingerprint({...e,manifest_sha256:null});
  for(const c of p.conditions)c.environment_sha256=p.environments.find(e=>e.id===c.environment_id).manifest_sha256;
  p.protocol_sha256=fingerprint({...p,protocol_sha256:null});return p;};

function panel(id,caseIds,{repetitions=1,models=1,edit}={}) {
  const draft=createPreregistrationTemplate();
  for(const e of draft.environments) {
    e.status='frozen';e.build.id='synthetic';e.build.receipt_sha256=hash('build');
    for(const artifact of [e.build.cli,e.build.broker])for(const key of Object.keys(artifact))artifact[key]=key==='commit'?'1'.repeat(40):hash(key);
    for(const [name,runtime] of Object.entries(e.runtime))Object.assign(runtime,{entry:'/synthetic/'+name,version:'1.0.0',sha256:hash(name)});
    e.pi.entry=e.runtime.pi.entry;
    for(const key of Object.keys(e.pi))if(key.endsWith('_sha256'))e.pi[key]=hash(key==='catalog_sha256'?id:key);
    for(const extension of e.pi.extensions)extension.sha256=hash(extension.id);
    e.manifest_sha256=fingerprint({...e,manifest_sha256:null});
  }
  const selected=Array.from({length:models},(_,index)=>{
    const m=structuredClone(draft.models[0]);Object.assign(m,{id:'model-'+index,family:'family-'+index,route:'auto/model-'+index});
    Object.assign(m.adapter,{verification:'verified',evidence_sha256:hash('adapter')});return m;
  });
  const material=caseIds.map(caseId=>({...draft.corpus.cases[0],...cases.find(c=>c.id===caseId),material_id:'material-'+caseId,
    content_sha256:hash(id+caseId),prompt_sha256:hash('prompt-'+id+caseId)}));
  const interactions=[];
  for(let a=0;a<models;a++)for(let b=a+1;b<models;b++)interactions.push({id:`model-${a}-${b}`,kind:'model_environment',condition_ids:[`m${a}-e0`,`m${a}-e1`,`m${b}-e0`,`m${b}-e1`]});
  const p=preregisterComparison({id,phase:'regression',purpose:'environment_iteration',environments:draft.environments,models:selected,
    corpus:draft.corpus,cases:material.map(protocol_case=>({id:protocol_case.id,protocol_case})),repetitions,
    budget:boundedBudget({id:'budget',episodes:caseIds.length*2*models*repetitions,durationMs:1000,requests:3,inputTokens:10000,outputTokens:1000,batchDurationMs:100000}),
    decision:{...draft.policies.decision,absolute_quality_required:.9,unassisted_quality_required:.9,quality_delta_min:-.03,input_ratio_max:1.1,capped_time_ratio_max:1.15},
    analysis:{capped_time_horizon_ms:1000,success_budgets:{time_ms:[100,500,1000],input_tokens:[100,1000,10000]},resource_bounds:{},interactions},
    allowedChanges:['tools'],orderingSeed:19,registeredAt:'2026-11-25T01:00:00Z'});
  if(edit)edit(p);seal(p);
  return freezeBatchPlan({protocol:p,registeredAt:p.registered_at,execution:{environment_root:'/synthetic/study',control_root:'/synthetic/study/'+id}});
}

function setup(options={}) {
  const plans=[panel('panel-a',['c1'],options),panel('panel-b',['c2','c3'],options)],p=plans[0].protocol;
  const conditions=p.conditions.map(c=>({id:c.id,role:c.environment_id,profile:studyConditionProfile(p,c.id)}));
  const comparisons=p.pairs.map(pair=>({candidate:pair.condition_ids[0],reference:pair.condition_ids[1]}));
  const uniqueComparisons=[...new Map(comparisons.map(c=>[fingerprint(c),c])).values()];
  const series={id:'native',phase:'regression',conditions,comparisons:uniqueComparisons,cases:structuredClone(cases),
    repetitions:options.repetitions??1,ordering_seed:19,family_weights:[{family:'f1',weight:.5},{family:'f2',weight:.5}],
    analysis:structuredClone(p.policies.analysis),primary_metrics:p.metrics.primary,
    panels:[{id:'a',case_ids:['c1']},{id:'b',case_ids:['c2','c3']}]};
  const design=createStudyDesign({id:'synthetic-study',registeredAt:'2026-11-25T00:00:00Z',series:[series]});
  const bindings=plans.map((plan,index)=>({series_id:'native',panel_id:index?'b':'a',plan,
    condition_map:Object.fromEntries(plan.protocol.conditions.map(c=>[c.id,c.id]))}));
  const plan=bindStudyPlan({design,panels:bindings,registeredAt:'2026-11-25T02:00:00Z'});
  return {design,plan,plans,bindings,series};
}

function observed(plan,options=()=>({})) {
  return plan.slots.map(slot=>{
    const {input}=exampleEnvelope({condition:slot.condition_id,caseId:slot.case_id,repeat:slot.repeat,
      episodeId:plan.id+'-'+slot.condition_id+'-'+slot.case_id+'-'+slot.repeat,...options(slot)});
    input.identity.experiment_id=plan.id;return normalizeEpisode(input).episode;
  });
}
function inputs(fixture,options=()=>({})) {
  return fixture.bindings.map(binding=>{const episodes=observed(binding.plan,options);return {...binding,episodes,analysis:scoreExperiment({protocol:binding.plan.protocol,episodes})};});
}
const result=(fixture,panels=inputs(fixture))=>scoreStudy({plan:fixture.plan,panels});

test('global family weights reweight original case rows instead of averaging panel rates',()=>{
  const f=setup(),r=result(f,inputs(f,s=>({outcome:s.condition_id==='m0-e0'&&s.case_id!=='c1'?'fail':'pass'})));
  const c=r.series[0].analysis.conditions[0];assert.equal(c.metrics.verified_quality.estimate,.25);
  assert.notEqual(c.metrics.verified_quality.estimate,.5);assert.notEqual(c.metrics.verified_quality.estimate,1/3);
  assert.equal(r.series[0].analysis.comparisons[0].quality_delta.estimate,-.75);
  assert.equal(c.panel_conditions.length,2);assert.equal(new Set(c.panel_conditions.map(x=>x.catalog_sha256)).size,2);
  assert.equal(c.environment_id,undefined);assert.equal(r.cost_ledger.actual_runs,6);
});

test('one cluster across panels and extra repeats cannot manufacture independent information',()=>{
  const a=result(setup()),b=result(setup({repetitions:4}));
  const x=a.series[0].analysis.comparisons[0].quality_delta.interval,y=b.series[0].analysis.comparisons[0].quality_delta.interval;
  assert.equal(x.clusters,2);assert.equal(x.effective_clusters,2);assert.deepEqual(x,y);
  assert.ok(x.lower<-.03);assert.equal(a.series[0].analysis.comparisons[0].decision.status,'descriptive');
});

test('local panel intervals and series intervals use the complete preregistered claim ledger',()=>{
  const f=setup(),panels=inputs(f),r=result(f,panels),count=f.design.claim_ledger.count;
  assert.equal(count,114);assert.equal(r.inference.claim_ledger.count,count);
  assert.equal(panels[0].analysis.statistical_policy.simultaneous_claim_count,38);
  assert.equal(r.panels[0].analysis.conditions[0].metrics.verified_quality.interval.comparisons,count);
  assert.ok(r.panels[0].analysis.conditions[0].metrics.verified_quality.interval.radius>panels[0].analysis.conditions[0].metrics.verified_quality.interval.radius);
  assert.equal(r.series[0].analysis.comparisons[0].quality_delta.interval.comparisons,count);
  const missing=structuredClone(panels);missing[1].episodes=[];missing[1].analysis=scoreExperiment({protocol:missing[1].plan.protocol,episodes:[]});
  assert.deepEqual(result(f,missing).inference.claim_ledger,r.inference.claim_ledger);
});

test('valid unknown, invalid-only and absent planned units retain different meanings and all costs',()=>{
  const f=setup(),panels=inputs(f,s=>s.case_id==='c1'&&s.condition_id==='m0-e0'?{outcome:'unknown'}:{});
  const original=observed(f.plans[1],s=>({valid:false,attemptInputs:[70,null]})).find(e=>e.identity.case_id==='c2'&&e.identity.condition_id==='m0-e0');
  panels[1].episodes=panels[1].episodes.filter(e=>!(e.identity.case_id==='c2'&&e.identity.condition_id==='m0-e0'));
  panels[1].episodes.push(original);panels[1].analysis=scoreExperiment({protocol:panels[1].plan.protocol,episodes:panels[1].episodes});
  const r=result(f,panels),c=r.series[0].analysis.conditions[0];
  assert.equal(c.counts.unknown,1);assert.equal(c.counts.fail,0);assert.equal(c.counts.unresolved,1);
  assert.equal(c.metrics.verified_quality.estimate,null);assert.equal(c.metrics.verified_quality.planned_verified_lower_bound,.5);
  assert.equal(r.series[0].completeness.planned_slots,6);assert.equal(r.series[0].completeness.unresolved_slots.length,1);
  assert.equal(r.cost_ledger.known_input_subtotal,570);assert.equal(r.cost_ledger.invalid_runs,1);
  assert.equal(r.cost_ledger.complete_input_total,null);assert.equal(r.series[0].analysis.comparisons[0].input_ratio.status,'unknown');
});

test('a valid unknown receives zero verified credit without becoming a confirmed failure',()=>{
  const f=setup(),r=result(f,inputs(f,s=>({outcome:s.condition_id==='m0-e0'?'unknown':'pass'})));
  const c=r.series[0].analysis.conditions[0];assert.equal(c.metrics.verified_quality.estimate,0);
  assert.equal(c.metrics.known_failure.estimate,0);assert.equal(c.metrics.success_identification_bounds.upper,1);
  assert.equal(c.counts.unknown,3);assert.equal(c.counts.fail,0);
});

test('linked invalid replacement retains both attempts while one valid slot supplies quality',()=>{
  const f=setup(),panels=inputs(f),p=panels[0],original=observed(p.plan,()=>({valid:false,attemptInputs:[70]}))[0];
  const valid=p.episodes.find(e=>e.identity.condition_id===original.identity.condition_id);
  const replacement={...valid,identity:{...valid.identity,episode_id:valid.identity.episode_id+'-replacement',run_id:valid.identity.run_id+'-replacement',retest_of:original.identity.episode_id}};
  replacement.episode_sha256=fingerprint({...replacement,episode_sha256:null});
  p.episodes=p.episodes.filter(e=>e.identity.episode_id!==valid.identity.episode_id);p.episodes.push(original,replacement);
  p.analysis=scoreExperiment({protocol:p.plan.protocol,episodes:p.episodes});const r=result(f,panels);
  assert.equal(r.cost_ledger.actual_runs,7);assert.equal(r.cost_ledger.invalid_runs,1);assert.equal(r.cost_ledger.known_input_subtotal,670);
  assert.equal(r.series[0].completeness.valid_slots,6);
});

test('study cannot drop a panel, reassign a cluster or change product/tools/resource mode after design',()=>{
  const f=setup();assert.throws(()=>bindStudyPlan({design:f.design,panels:f.bindings.slice(0,1),registeredAt:'2026-11-25T02:00:00Z'}),/Missing planned panel/);
  for(const edit of [p=>{p.corpus.cases[0].cluster_id='invented-independent';},p=>{p.environments[0].pi.tools[0].description+='changed';},
    p=>{p.policies.budgets[0].episode.max_input_tokens=12345;}]){
    const changed=structuredClone(f.bindings);edit(changed[1].plan.protocol);seal(changed[1].plan.protocol);
    changed[1].plan=freezeBatchPlan({protocol:changed[1].plan.protocol,execution:changed[1].plan.execution,registeredAt:changed[1].plan.registered_at});
    assert.throws(()=>bindStudyPlan({design:f.design,panels:changed,registeredAt:'2026-11-25T02:00:00Z'}));
  }
});

test('changed original plan or analysis and duplicated physical runs cannot enter the study',()=>{
  const f=setup(),panels=inputs(f),wrong=structuredClone(panels);wrong[0].analysis.conditions[0].counts.pass=999;
  wrong[0].analysis.analysis_sha256=fingerprint({...wrong[0].analysis,analysis_sha256:null});assert.throws(()=>result(f,wrong),/does not reproduce/);
  const changed=structuredClone(panels);changed[0].plan.slots.pop();assert.throws(()=>result(f,changed),/execution plan changed/);
  const duplicate=structuredClone(panels),e=duplicate[1].episodes[0];e.identity.run_id=duplicate[0].episodes[0].identity.run_id;
  e.episode_sha256=fingerprint({...e,episode_sha256:null});duplicate[1].analysis=scoreExperiment({protocol:duplicate[1].plan.protocol,episodes:duplicate[1].episodes});
  assert.throws(()=>result(f,duplicate),/One physical run/);
});

test('four-cell interactions use matched global case/repeat records and the same global allocation',()=>{
  const f=setup({models:2}),r=result(f,inputs(f,s=>({outcome:s.condition_id==='m1-e0'&&s.case_id==='c1'?'fail':'pass'})));
  const interaction=r.series[0].analysis.model_environment_interaction.comparisons[0];
  assert.equal(interaction.estimate,.25);assert.equal(interaction.interval.comparisons,f.design.claim_ledger.count);
  assert.equal(interaction.interval.clusters,2);assert.equal(interaction.paired_units.length,3);
  assert.equal(interaction.metrics.cost.interval.status,'unavailable');
  assert.equal(r.series[0].analysis.comparisons[0].input_ratio.interval.status,'unavailable');
});

test('material-state differences between model groups cannot be concealed by the aggregate view',()=>{
  const f=setup({models:2}),changed=structuredClone(f.bindings),p=changed[1].plan.protocol;
  for(const condition of p.conditions.filter(c=>c.model_id==='model-1'))condition.initial_state_sha256=hash('different-model-initial-state');
  seal(p);changed[1].plan=freezeBatchPlan({protocol:p,execution:changed[1].plan.execution,registeredAt:changed[1].plan.registered_at});
  assert.throws(()=>bindStudyPlan({design:f.design,panels:changed,registeredAt:'2026-11-25T02:00:00Z'}),/matched common scope/);
});

const run=promisify(execFile),bytesHash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function writeJson(path,value) {
  const bytes=Buffer.from(JSON.stringify(value)+'\n');await writeFile(path,bytes,{flag:'wx'});
  return {path,sha256:bytesHash(bytes),bytes:bytes.length};
}
async function ioFixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),'benchmark-study-test-'))),f=setup();
  const declaration={id:'offline-study',confidence:.95,series:[f.series],commitments:[{id:'synthetic-generator',sha256:hash('unit-generator-only')}]};
  const design=await freezeStudyDesignFile({request:declaration,outputFile:join(root,'design.json')});
  const bindings=[];
  for(const [index,prior] of f.plans.entries()) {
    const control=join(root,prior.id);await mkdir(control);
    const protocol=structuredClone(prior.protocol);protocol.registered_at=new Date().toISOString();seal(protocol);
    const plan=freezeBatchPlan({protocol,execution:{environment_root:root,control_root:control},registeredAt:protocol.registered_at});
    const reference=await writeJson(join(root,prior.id+'.plan.json'),plan);
    bindings.push({series_id:'native',panel_id:index?'b':'a',plan:reference,condition_map:Object.fromEntries(plan.protocol.conditions.map(c=>[c.id,c.id]))});
  }
  const request={design:design.reference,panels:bindings};
  return {root,request};
}
async function ioAnalysis(f) {
  const bound=await bindStudyPlanFile({request:f.request,outputFile:join(f.root,'bound.json')}),panels=[];
  for(const binding of f.request.panels) {
    const plan=JSON.parse(await readFile(binding.plan.path,'utf8')),episodes=[];
    for(const slot of plan.slots) {
      const episodeId=plan.id+'-'+slot.condition_id+'-'+slot.case_id+'-'+slot.repeat,rawPath=join(f.root,episodeId+'.raw.json');
      const fixture=exampleEnvelope({condition:slot.condition_id,caseId:slot.case_id,repeat:slot.repeat,episodeId,rawPath});
      fixture.input.identity.experiment_id=plan.id;await writeFile(rawPath,fixture.rawText,{flag:'wx'});episodes.push(normalizeEpisode(fixture.input).episode);
    }
    panels.push({series_id:binding.series_id,panel_id:binding.panel_id,
      analysis_input:await writeJson(join(f.root,plan.id+'.input.json'),{protocol:plan.protocol,episodes}),
      analysis:await writeJson(join(f.root,plan.id+'.analysis.json'),scoreExperiment({protocol:plan.protocol,episodes}))});
  }
  return {plan:bound.reference,panels};
}

test('binding refuses an active or already used panel even when an old attempt sent zero requests',async()=>{
  const f=await ioFixture(),plan=JSON.parse(await readFile(f.request.panels[0].plan.path,'utf8'));
  await writeFile(join(plan.execution.control_root,'ledger.jsonl'),JSON.stringify({seq:1,type:'episode_completed',result:{actual_model_requests:0}})+'\n');
  await assert.rejects(bindStudyPlanFile({request:f.request,outputFile:join(f.root,'refused.json')}),/before any panel ledger activity/);
  await assert.rejects(lstat(join(f.root,'refused.json')),error=>error.code==='ENOENT');
});

test('standalone package verifies raw locators and reproduces the entire study with no credentials or networking',async()=>{
  const f=await ioFixture(),request=await ioAnalysis(f),directory=join(f.root,'package');
  const exported=await writeStudyReport({request,directory}),manifest=JSON.parse(await readFile(join(directory,'study-report-manifest.json'),'utf8'));
  assert.equal(manifest.raw_evidence_included,true);assert.equal(manifest.files.filter(f=>f.path.startsWith('raw/')).length,6);
  assert.ok(manifest.implementation.files.every(f=>!/(?:configure|runner|models|standing-campaign)\.mjs$/.test(f.path)));
  const guard=join(f.root,'network-forbidden.mjs');
  await writeFile(guard,`import http from 'node:http';import https from 'node:https';import net from 'node:net';import dgram from 'node:dgram';import {syncBuiltinESMExports} from 'node:module';
const forbidden=()=>{throw new Error('Network forbidden during study replay');};
globalThis.fetch=forbidden;http.request=http.get=https.request=https.get=net.connect=net.createConnection=dgram.createSocket=forbidden;net.Socket.prototype.connect=forbidden;syncBuiltinESMExports();\n`);
  const output=join(f.root,'replayed');
  const replay=await run(process.execPath,['--import',guard,join(directory,'replay.mjs'),'--out',output],{env:{LANG:'C',TZ:'UTC'},cwd:f.root});
  assert.equal(JSON.parse(replay.stdout).analysis_sha256,exported.analysis_sha256);
  assert.deepEqual(await readFile(join(directory,'analysis.json')),await readFile(join(output,'analysis.json')));
  for(const file of manifest.files)assert.equal(bytesHash(await readFile(join(directory,file.path))),file.sha256,'Replay changed its original package');
  const raw=manifest.files.find(f=>f.path.startsWith('raw/'));await writeFile(join(directory,raw.path),'tampered');
  await assert.rejects(run(process.execPath,[join(directory,'replay.mjs'),'--out',join(f.root,'tampered-replay')],{env:{LANG:'C',TZ:'UTC'}}),/Study package changed/);
});

test('changed raw source cannot produce an analysis package or quietly use normalized claims alone',async()=>{
  const f=await ioFixture(),request=await ioAnalysis(f),input=JSON.parse(await readFile(request.panels[0].analysis_input.path,'utf8'));
  await writeFile(input.episodes[0].artifacts[0].path,'changed raw bytes');
  await assert.rejects(writeStudyReport({request,directory:join(f.root,'refused')}),/Raw artifact hash or size mismatch/);
  await assert.rejects(lstat(join(f.root,'refused')),error=>error.code==='ENOENT');
});
