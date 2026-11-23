import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, fingerprint } from './protocol.mjs';
import { collectEpisode, collectRawUsage, deliveredSourceBodies, deriveRedactedProviderBinding } from './collect.mjs';
import { exampleProtocol } from './analysis/fixtures.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture({ outcome='pass', missingUsage=false, tools=[], source=false, opaque=false, capture=false, budgetStopped=false, adapter=true,
  routing, reportedModels=[], api='openai-completions', providerError=false }={}) {
  const root=await mkdtemp(join(tmpdir(),'benchmark-collect-unit-')),runRoot=join(root,'runs','unit-run'),workspace=join(runRoot,'workspace');
  await mkdir(join(workspace,'output'),{recursive:true});
  const save=async(path,value)=>{await mkdir(join(path,'..'),{recursive:true});const text=typeof value==='string'?value:canonicalJson(value)+'\n';await writeFile(path,text);return {path,sha256:sha(text),bytes:Buffer.byteLength(text)};};
  const materialPath=join(root,'materials','unit-skill','SKILL.md'),body='# Unit Skill\nUse the supplied input.\n';
  const material=await save(materialPath,body);
  const oracle={schema_version:1,case_id:'c1',capability_scope:'common',required_capabilities:['workspace-files'],contracts:[
    {id:'deliverable',kind:'artifact-json',path:'output/result.json',comparison:'exact',expected:{answer:7},critical:true},
    {id:'selection',kind:'selection',allowed_sets:source?[['unit-skill']]:[[]],critical:false},
    ...(source?[{id:'main-source',kind:'resources',critical:true,alternatives:[[{skill_id:'unit-skill',path:'SKILL.md',sha256:material.sha256}]]}]:[]),
  ]};
  const oracleFile=await save(join(root,'private','oracle.json'),oracle);
  const proof=await save(join(root,'private','adapter.json'),{scope:'synthetic-unit-only',status:'passed',api});
  const p=exampleProtocol({cases:[{id:'c1',family:'unit',material_id:'material',cluster_id:'cluster',split:'development',contract_sha256:fingerprint(oracle)}]});
  p.corpus.content_sha256='a'.repeat(64);p.corpus.capabilities=[{id:'workspace-files',scope:'common',environment_ids:p.conditions.map(c=>c.environment_id)}];
  const model={id:'model',provider:'unit-provider',route:'unit-route',api,parameters:{},...(routing?{routing}:{}),
    adapter:{id:'unit-adapter',version:'1',verification:'verified',evidence_sha256:proof.sha256}};
  p.models=[model];for(const c of p.conditions)c.environment_sha256='b'.repeat(64);
  p.protocol_sha256=fingerprint({...p,protocol_sha256:null});
  const condition=p.conditions[0],slot={slot_id:'unit-slot',pair_id:'c1-r0',case_id:'c1',condition_id:condition.id,repeat:0,seed:0};
  const binding={id:'c1',protocol_case:p.corpus.cases[0],oracle_path:oracleFile.path,oracle_sha256:oracleFile.sha256,
    skills_root:join(root,'materials'),skill_inventory:[{...material,skill_id:'unit-skill',resource_path:'SKILL.md'}],
    public_case:{id:'c1',title:'Synthetic collector unit fixture',completion:{paths:['output/result.json']},turns:[{id:'turn-1',prompt:'Unit task'}]},events:[],clarification:[]};
  const run={run_id:'unit-run',root:runRoot,pi_launch:{mode:'native',native_corpus:{root:join(runRoot,'skills','native')}}};
  const shared={run_id:'unit-run',build_id:'unit-build',root:runRoot,status:'passed',exit_code:0,signal:null,timed_out:false,spawned:true,
    runtime_check:{status:'unchanged'},frozen_artifacts:'passed'};
  await save(join(runRoot,'run.json'),run);await save(join(runRoot,'result.json'),shared);
  let outputFile=null;
  if(outcome!=='missing')outputFile=await save(join(workspace,'output/result.json'),outcome==='pass'?{answer:7}:{answer:8});
  const rawArtifacts=[],add=async(id,path,value,kind='json')=>{const a={id,...await save(path,value),kind};rawArtifacts.push(a);return a;};
  const payload=await add('request-1-payload',join(runRoot,'payload.json'),{model:'unit-route',messages:[{role:'user',content:'Unit task'}]});
  const payloadSha=sha(JSON.stringify(JSON.parse(await readFile(payload.path,'utf8'))));
  const trace=[];let previous=null;
  const event=fields=>{const row={version:1,sequence:trace.length+1,previousSha256:previous,clockId:'unit-run',monotonicNs:String(trace.length+1),...fields};row.eventSha256=sha(JSON.stringify(row));previous=row.eventSha256;trace.push(row);};
  event({phase:'transport_start'});
  if(!capture){event({phase:'request_start',id:1,category:'model'});event({phase:'request_sent',id:1,requestBodySha256:payloadSha});event({phase:'request_end',id:1,category:'model',outcome:providerError?'failure':'completed'});}
  event({phase:'transport_end',attempts:capture?0:1,errors:0,incompleteRequestIds:[],pendingForkRebind:false,complete:true});
  const transport=await add('transport',join(runRoot,'transport.jsonl'),trace.map(JSON.stringify).join('\n')+'\n','jsonl');
  const rows=[];const record=(type,data,request_id=null)=>{const row={version:1,sequence:rows.length+1,type,turn_id:'turn-1',request_id,
    monotonic_ns:String(1000000+rows.length*1000000),wall_time:'2026-01-01T00:00:00.000Z',data};rows.push(row);return rows.length;};
  let usageLine=null;
  if(!capture)for(const reported of reportedModels)record('provider_stream_event', {request_id:'request-1',attempt_id:'attempt-1',provider:'unit-provider',api,model:'unit-route',
    event:api==='openai-responses'?{type:'response.created',response:{model:reported}}:{model:reported}},'request-1');
  if(!capture&&!missingUsage)usageLine=record('provider_stream_event',{request_id:'request-1',attempt_id:'attempt-1',provider:'unit-provider',api,model:'unit-route',
    event:api==='openai-responses'?{type:'response.completed',response:{usage:{input_tokens:100,output_tokens:20,total_tokens:120,input_tokens_details:{cached_tokens:30}}}}
      :{usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:30}}}},'request-1');
  if(source) {
    const copied=join(run.pi_launch.native_corpus.root,'unit-skill','SKILL.md');await save(copied,body);
    tools=[...tools,{id:'read-skill',name:'read',args:{path:copied},result:{content:[{type:'text',text:body}],structuredContent:body},isError:false}];
  }
  if(opaque)tools=[...tools,{id:'shell',name:'bash',args:{command:'opaque behavior'},result:{content:[{type:'text',text:''}]},isError:false}];
  for(const t of tools){record('session_event',{type:'tool_execution_start',toolCallId:t.id,toolName:t.name,args:t.args,...(t.parent?{parentToolCallId:t.parent}:{})});
    record('session_event',{type:'tool_execution_end',toolCallId:t.id,toolName:t.name,result:t.result,isError:t.isError,...(t.parent?{parentToolCallId:t.parent}:{})});}
  const endLine=record('user_turn_end',{id:'turn-1',settled:true,is_idle:true});
  const events=await add('events',join(runRoot,'events.jsonl'),rows.map(JSON.stringify).join('\n')+'\n','jsonl');
  const eRef=line=>({artifact_id:'events',sha256:events.sha256,line});
  const snapshot=await add('workspace-final',join(runRoot,'workspace-final.json'),{files:outputFile?[{path:'output/result.json',sha256:outputFile.sha256}]:[]});
  const rRef=(a,pointer='')=>({artifact_id:a.id,sha256:a.sha256,pointer});
  const episode={version:1,status:capture?'captured':budgetStopped?'budget_stopped':'completed',
    correlation:{run_id:'unit-run',episode_id:'unit-run',candidate_id:condition.id,task_id:'c1'},
    admission:{status:capture?'captured_not_authorized':'accepted_before_task',refs:[]},
    coverage:{attempts:'complete',tools:'complete',interventions:'complete'},
    completion:{cleanup:{abort_settled:true,dispose_called:true}},timing:{duration_ms:100,started_monotonic_ns:'0'},
    turns:capture?[]:[{id:'turn-1',end_ref:eRef(endLine),workspace_manifest_ref:rRef(snapshot)}],interventions:[],
    requests:capture?[{id:'capture',attempts:[]}]:[{id:'request-1',payload_sha256:payloadSha,payload_ref:rRef(payload),
      attempts:[{id:'attempt-1',sent:true,transport_id:1,start_ref:eRef(usageLine??endLine)}],
      ...(usageLine?{usage_ref:{...eRef(usageLine),pointer:'/data/event/usage'},usage_attempt_id:'attempt-1'}:{})}],
    artifacts:rawArtifacts};
  const resultFile=await save(join(runRoot,'episode-result.json'),episode);
  return {root,runRoot,workspace,binding,protocol:p,slot,condition,model:{...model,...(adapter?{adapter_evidence_path:proof.path}:{})},
    raw:{root:runRoot,run_id:'unit-run',shared,episode,result_path:resultFile.path},
    args:{environmentRoot:root,outputDirectory:join(root,'collected')},save};
}
const collect=f=>collectEpisode({...f,...f.args});

const routing={mode:'auto-route',model_variant:'grok-4.7',reported_model_ids:['grok-4.7','grok/grok-4.7']};
test('collector binds every original server label to its actual attempt and freezes the extraction module',async()=>{
  for(const api of ['openai-completions','openai-responses']){
    const result=await collect(await fixture({routing,api,reportedModels:['grok/grok-4.7','grok-4.7']}));
    assert.equal(result.validity,'valid');assert.equal(result.stop_batch,false);
    assert.deepEqual(result.budget_usage,{model_requests:1,input_tokens:100,output_tokens:20,duration_ms:100});
    const report=result.bundle.episode.attempts[0].reported_model;
    assert.equal(report.status,'matched');assert.equal(report.assurance,'provider_reported_label_not_backend_attestation');
    assert.deepEqual(report.reported_ids,['grok/grok-4.7','grok-4.7']);
    assert.equal(report.observations.length,2);
    for(const observation of report.observations){
      assert.equal(observation.bound,true);assert.match(observation.ref.sha256,/^[a-f0-9]{64}$/);
      assert.equal(observation.ref.artifact_id,'events');assert.ok(observation.ref.line>0);
      assert.equal(observation.field,api==='openai-responses'?'/data/event/response/model':'/data/event/model');
    }
    assert.ok(JSON.stringify(result.bundle.episode.identity.analysis_implementation).includes('benchmark/reported-model.mjs'));
  }
});
test('wrong and missing reported variants invalidate the core without erasing known consumption',async()=>{
  for(const reportedModels of [[],['grok/grok-4.7','grok/grok-4.6','grok/grok-4.7'],['auto/grok-4.7']]){
    const result=await collect(await fixture({routing,reportedModels}));
    assert.equal(result.validity,'invalid');assert.equal(result.stop_batch,true);assert.equal(result.outcome,'not_applicable');
    assert.ok(result.bundle.episode.admission.reasons.includes(reportedModels.length?'reported_model_mismatch':'reported_model_missing'));
    assert.equal(result.bundle.episode.admission.completeness.attempts,'complete');
    assert.deepEqual(result.budget_usage,{model_requests:1,input_tokens:100,output_tokens:20,duration_ms:100});
    assert.equal(result.bundle.episode.measurements.input_total.known_subtotal,100);
    assert.equal(result.bundle.episode.measurements.output_total.known_subtotal,20);
  }
});
test('a failed provider response is distinguishable from an otherwise complete response lacking identity',async()=>{
  const result=await collect(await fixture({routing,providerError:true}));
  assert.equal(result.validity,'invalid');assert.equal(result.stop_batch,true);
  assert.ok(result.bundle.episode.admission.reasons.includes('reported_model_unavailable_after_provider_error'));
  assert.equal(result.budget_usage.model_requests,1);assert.equal(result.budget_usage.input_tokens,100);
});
test('routing policy does not require server identity before any actual model send',async()=>{
  const result=await collect(await fixture({routing,capture:true}));
  assert.equal(result.budget_usage.model_requests,0);
  assert.ok(!result.bundle.episode.admission.reasons.some(reason=>reason.startsWith('reported_model')));
});

test('raw API usage keeps cached subsets and absent fields without Pi zero fallback',()=>{
  const u=collectRawUsage('openai-completions',{usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:30}}});
  assert.equal(u.input,100);assert.equal(u.cache_read,30);assert.equal(u.cache_write,null);assert.equal(u.reasoning,null);
  assert.equal(collectRawUsage('openai-completions',{}),null);
});
test('actual independent output bytes grade success and reproduce immutable collection',async()=>{
  const f=await fixture(),first=await collect(f),second=await collect(f);
  assert.equal(first.validity,'valid');assert.equal(first.verified_success,true);assert.equal(first.stop_batch,false);
  assert.deepEqual(first.budget_usage,{model_requests:1,input_tokens:100,output_tokens:20,duration_ms:100});
  assert.equal(first.bundle.episode.measurements.input_total.value.value,100);
  assert.equal(first.episode_sha256,second.episode_sha256);
  assert.ok(!first.bundle.episode.artifacts.some(a=>a.path===f.binding.oracle_path));
  assert.equal(first.bundle.episode.timing.time_to_success_ms.status,'known');
});
test('wrong or missing observed deliverable remains valid business failure',async()=>{
  for(const outcome of ['fail','missing']){
    const result=await collect(await fixture({outcome}));
    assert.equal(result.validity,'valid');assert.equal(result.outcome,'fail');assert.equal(result.stop_batch,false);
  }
});
test('sent request without raw usage stays unknown and stops the next paid dispatch',async()=>{
  const result=await collect(await fixture({missingUsage:true}));
  assert.equal(result.budget_usage.model_requests,1);assert.equal(result.budget_usage.input_tokens,null);
  assert.equal(result.bundle.episode.measurements.input_total.value.status,'unknown');assert.equal(result.stop_batch,true);
});
test('pre-send capture is invalid as a business sample and proves actual zero only from complete transport',async()=>{
  const result=await collect(await fixture({capture:true}));
  assert.equal(result.validity,'invalid');assert.equal(result.outcome,'not_applicable');
  assert.equal(result.budget_usage.model_requests,0);assert.equal(result.budget_usage.input_tokens,0);
});
test('native source consumption needs exact returned bytes and an observed path binding',async()=>{
  const result=await collect(await fixture({source:true}));
  assert.equal(result.verified_success,true);
  assert.equal(result.readback.evidence.resource_reads[0].skill_id,'unit-skill');
  assert.equal(result.readback.evidence.selections[0].skill_id,'unit-skill');
});
test('opaque shell filesystem use cannot prove that no Skill was consumed',async()=>{
  const result=await collect(await fixture({opaque:true}));
  assert.equal(result.grade.business_outcome,'pass');assert.equal(result.outcome,'unknown');
  assert.equal(result.grade.contracts.find(c=>c.id==='selection').status,'unknown');
});
test('an executed shell failure or unknown terminal status cannot prove absent source consumption',async()=>{
  for(const isError of [true,undefined]) {
    const result=await collect(await fixture({tools:[{id:'failed-shell',name:'bash',args:{command:'run a script'},
      result:{content:[{type:'text',text:'partial output before failure'}]},isError}]}));
    assert.equal(result.grade.business_outcome,'pass');assert.equal(result.outcome,'unknown');
    assert.deepEqual(result.readback.opaque_tools,['failed-shell']);
  }
});
test('mutated output after the observed subject boundary cannot become assisted success',async()=>{
  const f=await fixture();await f.save(join(f.workspace,'output/result.json'),{answer:9});
  const result=await collect(f);assert.equal(result.validity,'invalid');assert.equal(result.stop_batch,true);
  assert.ok(result.bundle.episode.admission.reasons.some(r=>r.startsWith('output_changed_after_subject_boundary')));
});
test('a missing adapter proof does not convert raw numbers into verified full usage',async()=>{
  const result=await collect(await fixture({adapter:false}));
  assert.equal(result.validity,'invalid');assert.equal(result.budget_usage.input_tokens,null);
});
test('nested source result survives an outer CodeMode failure',async()=>{
  const body='# Native source\n',proof={version:2,toolCallId:'outer/1',bodySha256:sha(body),bytes:Buffer.byteLength(body)};
  const child={id:'outer/1',parent_id:'outer',name:'read',status:'pass',result:{content:[{type:'text',text:body}],details:{contextBrokerRead:proof}}};
  assert.equal(deliveredSourceBodies(child)[0].body,body);
  assert.equal(deliveredSourceBodies({...child,status:'fail'}).length,0);
});

test('known provider failure and budget exhaustion remain valid observations when core evidence is intact',async()=>{
  for(const status of ['failed','budget_stopped']) {
    const f=await fixture({outcome:'fail'});
    f.raw.episode.status=status;await f.save(f.raw.result_path,f.raw.episode);
    const result=await collect(f);
    assert.equal(result.validity,'valid');assert.equal(result.outcome,'fail');assert.equal(result.stop_batch,false);
  }
});
test('a required Notion source cannot silently substitute a missing observer with zero requests',async()=>{
  const f=await fixture();
  f.protocol.environments=[{id:f.condition.environment_id,pi:{sources:[{id:'notion',kind:'notion'}]}}];
  f.protocol.protocol_sha256=fingerprint({...f.protocol,protocol_sha256:null});
  const result=await collect(f);
  assert.equal(result.validity,'invalid');assert.equal(result.readback.notion.owned_http.value,null);
  assert.ok(result.bundle.episode.admission.reasons.includes('core_notion_evidence_missing'));
});
test('analysis identity contains retained actual implementation bytes and rejects missing delivery semantics',async()=>{
  const result=await collect(await fixture());
  const identity=result.bundle.episode.identity;
  const files=identity.analysis_implementation.files;
  for(const name of ['benchmark/collect.mjs','benchmark/corpus/grader.mjs','benchmark/evidence/normalize.mjs']) {
    const file=files.find(item=>item.path===name);
    assert.ok(file);const retained=result.bundle.episode.artifacts.find(a=>a.id===file.artifact_id);
    assert.equal(sha(await readFile(retained.path)),file.sha256);
  }
  assert.equal(identity.collector_source_sha256,files.find(item=>item.path==='benchmark/collect.mjs').sha256);
  const body='# Unbound receipt',child={id:'read',name:'bash',status:'pass',result:{content:[{type:'text',text:body}],
    details:{contextBrokerRead:{version:2,toolCallId:'read',bodySha256:sha(body),bytes:Buffer.byteLength(body)}}}};
  assert.deepEqual(deliveredSourceBodies(child),[]);
});

test('redacted provider recovery requires the unique observed configuration and exact request/transport chain',()=>{
  const selected={id:'unit-route',api:'openai-responses',provider:'[REDACTED_CREDENTIAL]',baseUrl:'http://127.0.0.1:1234/v1'};
  const projection={model:selected,model_parameters:{maxTokens:4096},model_configuration:{definition:{providers:{
    'unit-provider':{api:'openai-completions',baseUrl:selected.baseUrl,models:[{id:'unit-route',api:'openai-responses'}]},
  }}}};
  const value={event:{type:'provider_stream_event',data:{provider:'[REDACTED_CREDENTIAL]',api:'openai-responses',model:'unit-route',request_id:'r1',attempt_id:'a1'}},
    request:{id:'r1',usage_attempt_id:'a1',payload_sha256:'a'.repeat(64)},
    requestStart:{type:'model_request_start',data:{request_id:'r1',capture_only:false,model:structuredClone(selected)}},
    candidate:{projection},expected:{projection:structuredClone(projection)},admission:{differences:[]},payload:{model:'unit-route'},
    attemptStart:{type:'http_attempt_start',data:{request_id:'r1',attempt_id:'a1',method:'POST',url_origin:'http://127.0.0.1:1234',url_path:'/v1/responses'}},
    transportStart:{phase:'request_start',category:'model',method:'POST',id:1,originSha256:sha('http://127.0.0.1:1234'),pathSha256:sha('/v1/responses')},
    transportSent:{phase:'request_sent',id:1,requestBodySha256:'a'.repeat(64)},transportEnd:{phase:'request_end',id:1},
    model:{provider:'unit-provider',route:'unit-route',api:'openai-responses',parameters:{maxTokens:4096}},
    refs:[{artifact_id:'unit-raw',sha256:'a'.repeat(64),pointer:''}]};
  const recovered=deriveRedactedProviderBinding(value);
  assert.equal(recovered.value,'unit-provider');assert.equal(recovered.precision,'derived');
  assert.equal(recovered.observed_provider,'[REDACTED_CREDENTIAL]');
  assert.equal(recovered.verification_scope,'private-original-transport-hashes-recomputed');
  const projected=structuredClone(value);
  projected.candidate.projection.model.baseUrl='https://published-endpoint.invalid/v1';
  projected.candidate.projection.model_configuration.definition.providers['unit-provider'].baseUrl='https://published-endpoint.invalid/v1';
  projected.expected=structuredClone(projected.candidate);projected.requestStart.data.model=structuredClone(projected.candidate.projection.model);
  projected.attemptStart.data.url_origin='https://published-endpoint.invalid';
  assert.equal(deriveRedactedProviderBinding(projected),null);
  const publicProof=deriveRedactedProviderBinding({...projected,publicProjection:true});
  assert.equal(publicProof.value,'unit-provider');assert.equal(publicProof.verification_scope,'public-projection-original-transport-hash-claims-retained');
  const badBody=structuredClone(projected);badBody.transportSent.requestBodySha256='b'.repeat(64);
  assert.equal(deriveRedactedProviderBinding({...badBody,publicProjection:true}),null);
  const badIdentity=structuredClone(projected);badIdentity.event.data.attempt_id='another-attempt';
  assert.equal(deriveRedactedProviderBinding({...badIdentity,publicProjection:true}),null);
  const missingClaim=structuredClone(projected);delete missingClaim.transportStart.originSha256;
  assert.equal(deriveRedactedProviderBinding({...missingClaim,publicProjection:true}),null);
  const bad=[
    x=>{x.event.data.provider=null;},
    x=>{x.event.data.provider='another-provider';},
    x=>{x.candidate.projection.model_configuration.definition.providers.other=structuredClone(x.candidate.projection.model_configuration.definition.providers['unit-provider']);x.expected=structuredClone(x.candidate);},
    x=>{x.admission.differences=['changed'];},
    x=>{x.requestStart.data.model.baseUrl='http://other.invalid/v1';},
    x=>{x.payload.model='wrong';},
    x=>{x.transportSent.requestBodySha256='b'.repeat(64);},
    x=>{x.transportStart.originSha256='c'.repeat(64);},
    x=>{x.event.data.attempt_id='another-attempt';},
  ];
  for(const mutate of bad){const item=structuredClone(value);mutate(item);assert.equal(deriveRedactedProviderBinding(item),null);}
});

test('bridge and parent failures suppress success credit without discarding observed business values or usage',async()=>{
 const scenarios=[
  f=>{f.binding.public_case.turns.push({id:'turn-2',prompt:'Continue'});},
  f=>{f.binding.events=[{id:'version-event',before_turn:'turn-1'}];},
  f=>{f.raw.turn_control={version:1,run_id:'unit-run',episode_id:'unit-run',status:'stopped'};},
  f=>{f.raw.turn_control_verification={status:'unavailable',required:true,result:null,receipt:null,reason:'Missing terminal controller receipt'};},
  f=>{f.raw.dispatch_error={name:'Error',message:'Parent controller failed after child completion'};},
 ];
 for(const setup of scenarios){
  const f=await fixture();setup(f);const result=await collect(f);
  assert.equal(result.validity,'invalid');assert.equal(result.verified_success,false);assert.equal(result.stop_batch,true);
  assert.equal(result.grade.business_outcome,'pass');assert.equal(result.grade.verified_success,true);
  assert.equal(result.outcome,'not_applicable');
  assert.deepEqual(result.budget_usage,{model_requests:1,input_tokens:100,output_tokens:20,duration_ms:100});
  assert.equal(result.bundle.episode.business.status,'pass');
  assert.ok(result.bundle.episode.admission.reasons.some(reason=>/turn_control|subject_dispatch_error/.test(reason)));
 }
});

test('turn evidence collector closure excludes subject dispatch and private fixture generation',async()=>{
 const result=await collect(await fixture());
 const names=result.bundle.episode.identity.analysis_implementation.files.map(item=>item.path);
 assert.ok(names.includes('benchmark/collect-turns.mjs'));
 for(const forbidden of ['benchmark/execute.mjs','benchmark/fixture.mjs','benchmark/fixture-turn-adapter.mjs','benchmark/corpus/index.mjs'])
  assert.ok(!names.includes(forbidden),forbidden);
 assert.equal(result.readback.turn_control.required,false);
});
