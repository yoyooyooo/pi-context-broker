import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import diagnostics from 'node:diagnostics_channel';
import { canonicalJson, fingerprint } from './protocol.mjs';
import { CURRENT_COLLECTOR_VERSION, collectEpisode, collectNotionManagement, collectRawUsage, collectProviderApplicationCompletion, deliveredSourceBodies, deriveRedactedProviderBinding, verifiedNotionListRuntime } from './collect.mjs';
import { exampleProtocol } from './analysis/fixtures.mjs';
import { assertCompletedStandingEvidence } from './standing-campaign.mjs';
import { readSubjectTurnControl } from './execute.mjs';
import { loadCurrentSourceViews } from './current-source-views.mjs';
import { RETAINED_SOURCE_CONTRACT } from './retained-source-views.mjs';
import { observeEpisodeNotion } from './runtime/episode-notion.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture({ outcome='pass', missingUsage=false, tools=[], source=false, opaque=false, capture=false, budgetStopped=false, adapter=true,
  routing, reportedModels=[], api='openai-completions', providerError=false, sourceFrom, answer=null, managementEvents, remoteWrite }={}) {
  const root=await mkdtemp(join(tmpdir(),'benchmark-collect-unit-')),runRoot=join(root,'runs','unit-run'),workspace=join(runRoot,'workspace');
  await mkdir(join(workspace,'output'),{recursive:true});
  const save=async(path,value)=>{await mkdir(join(path,'..'),{recursive:true});const text=typeof value==='string'?value:canonicalJson(value)+'\n';await writeFile(path,text);return {path,sha256:sha(text),bytes:Buffer.byteLength(text)};};
  const materialPath=join(root,'materials','unit-skill','SKILL.md'),body='# Unit Skill\nUse the supplied input.\n';
  const material=await save(materialPath,body);
  const oracle={schema_version:1,case_id:'c1',capability_scope:'common',required_capabilities:['workspace-files'],
    ...(answer?{facts:{total:{anyOf:['total: 7']},uncertain:{anyOf:['ownership is unproven']},invented:{anyOf:['ownership confirmed']}}}:{}),contracts:[
    answer?{id:'answer',kind:'final-answer',turn_id:'turn-1',assessment:answer.assessment??'necessary-facts',
      all:['total'],any:['uncertain'],none:['invented'],critical:true}:
    {id:'deliverable',kind:'artifact-json',path:'output/result.json',comparison:'exact',expected:{answer:7},critical:true},
    {id:'selection',kind:'selection',allowed_sets:source?[['unit-skill']]:[[]],critical:false},
    ...(source?[{id:'main-source',kind:'resources',critical:true,alternatives:[[{skill_id:'unit-skill',path:'SKILL.md',sha256:material.sha256}]]}]:[]),
  ]};
  const oracleFile=await save(join(root,'private','oracle.json'),oracle);
  const proof=await save(join(root,'private','adapter.json'),{scope:'synthetic-unit-only',status:'passed',api});
  const p=exampleProtocol({cases:[{id:'c1',family:'unit',material_id:'material',cluster_id:'cluster',split:'development',contract_sha256:fingerprint(oracle)}]});
  const authorization=remoteWrite===undefined?null:{workspace_read:['input/**'],workspace_write:[],remote_write:remoteWrite};
  if(authorization)p.corpus.cases[0].authorization_sha256=fingerprint(authorization);
  p.corpus.content_sha256='a'.repeat(64);p.corpus.capabilities=[{id:'workspace-files',scope:'common',environment_ids:p.conditions.map(c=>c.environment_id)}];
  const model={id:'model',provider:'unit-provider',route:'unit-route',api,parameters:{},...(routing?{routing}:{}),
    adapter:{id:'unit-adapter',version:'1',verification:'verified',evidence_sha256:proof.sha256}};
  p.models=[model];for(const c of p.conditions)c.environment_sha256='b'.repeat(64);
  p.protocol_sha256=fingerprint({...p,protocol_sha256:null});
  const condition=p.conditions[0],slot={slot_id:'unit-slot',pair_id:'c1-r0',case_id:'c1',condition_id:condition.id,repeat:0,seed:0};
  const binding={id:'c1',protocol_case:p.corpus.cases[0],oracle_path:oracleFile.path,oracle_sha256:oracleFile.sha256,
    skills_root:join(root,'materials'),skill_inventory:[{...material,skill_id:'unit-skill',resource_path:'SKILL.md'}],
    public_case:{id:'c1',title:'Synthetic collector unit fixture',...(authorization?{authorization,authorization_sha256:fingerprint(authorization)}:{}),
      completion:answer?{kind:'final-answer',paths:[]}:{paths:['output/result.json']},turns:[{id:'turn-1',prompt:'Unit task'}]},events:[],clarification:[]};
  const run={run_id:'unit-run',root:runRoot,pi_launch:{mode:'native',native_corpus:{root:join(runRoot,'skills','native')}}};
  const shared={run_id:'unit-run',build_id:'unit-build',root:runRoot,status:'passed',exit_code:0,signal:null,timed_out:false,spawned:true,
    runtime_check:{status:'unchanged'},frozen_artifacts:'passed'};
  await save(join(runRoot,'run.json'),run);await save(join(runRoot,'result.json'),shared);
  let outputFile=null;
  if(!answer&&outcome!=='missing')outputFile=await save(join(workspace,'output/result.json'),outcome==='pass'?{answer:7}:{answer:8});
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
  let notion=null;
  if(managementEvents!==undefined){
    await mkdir(join(runRoot,'subject-runtime'));
    const cli=await save(join(runRoot,'observer-cli.mjs'),'// synthetic observer fixture\n');
    const prior=process.env.PAIRED_CLI_ENTRY;process.env.PAIRED_CLI_ENTRY=cli.path;
    try{
      const observer=observeEpisodeNotion({config:{runRoot,controlDir:join(runRoot,'notion-control'),correlation:{episode_id:'unit-run'}},
        recorder:{scrub:structuredClone,record:(type,data)=>({artifact_id:'events',line:record(type,data)}),
          addArtifact:async(id,path,kind)=>{const bytes=await readFile(path);const artifact={id,path,sha256:sha(bytes),bytes:bytes.length,kind};rawArtifacts.push(artifact);return artifact;}},
        context:()=>({stage:'user_task',turn_id:'turn-1',model_request_id:null,active_tool_call_ids:[]})});
      for(const event of managementEvents)diagnostics.channel('context-broker.notion-materialization').publish(event);
      notion=await observer.finish();
      // Empty SDK observations isolate this collector contract; this fixture
      // does not claim current product source delivery or management execution.
      notion.source_contract=RETAINED_SOURCE_CONTRACT;
    }finally{if(prior===undefined)delete process.env.PAIRED_CLI_ENTRY;else process.env.PAIRED_CLI_ENTRY=prior;}
  }
  if(source) {
    const copied=join(run.pi_launch.native_corpus.root,'unit-skill','SKILL.md');await save(copied,body);
    tools=[...tools,{id:'read-skill',name:'read',args:{path:copied,...(sourceFrom===undefined?{}:{from:sourceFrom})},
      result:{content:[{type:'text',text:body}],structuredContent:body},isError:false}];
  }
  if(opaque)tools=[...tools,{id:'shell',name:'bash',args:{command:'opaque behavior'},result:{content:[{type:'text',text:''}]},isError:false}];
  for(const t of tools){record('session_event',{type:'tool_execution_start',toolCallId:t.id,toolName:t.name,args:t.args,...(t.parent?{parentToolCallId:t.parent}:{})});
    record('session_event',{type:'tool_execution_end',toolCallId:t.id,toolName:t.name,result:t.result,isError:t.isError,...(t.parent?{parentToolCallId:t.parent}:{})});}
  const endData={id:answer?.wrongTurn?'another-turn':'turn-1',settled:!answer?.unsettled,is_idle:true,
    ...(answer&&!answer.omitText?{final_text:answer.text??null}:{})};
  const endLine=record('user_turn_end',endData);
  if(answer?.duplicateEnd)record('user_turn_end',endData);
  const events=await add('events',join(runRoot,'events.jsonl'),rows.map(JSON.stringify).join('\n')+'\n','jsonl');
  const bindRefs=value=>Array.isArray(value)?value.map(bindRefs):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value.artifact_id?{...value,sha256:rawArtifacts.find(item=>item.id===value.artifact_id).sha256}:value).map(([key,item])=>[key,bindRefs(item)])):value;
  const eRef=line=>({artifact_id:'events',sha256:events.sha256,line});
  const snapshot=await add('workspace-final',join(runRoot,'workspace-final.json'),{files:outputFile?[{path:'output/result.json',sha256:outputFile.sha256}]:[]});
  const rRef=(a,pointer='')=>({artifact_id:a.id,sha256:a.sha256,pointer});
  const episode={version:1,status:capture?'captured':budgetStopped?'budget_stopped':'completed',
    correlation:{run_id:'unit-run',episode_id:'unit-run',candidate_id:condition.id,task_id:'c1'},
    admission:{status:capture?'captured_not_authorized':'accepted_before_task',refs:[]},
    coverage:{attempts:'complete',tools:'complete',interventions:'complete'},
    completion:{cleanup:{abort_settled:true,dispose_called:true}},timing:{duration_ms:100,started_monotonic_ns:'0'},
    turns:capture?[]:[{id:'turn-1',...(answer&&Object.hasOwn(answer,'summaryText')?{final_text:answer.summaryText}:{}),end_ref:eRef(endLine),workspace_manifest_ref:rRef(snapshot)}],interventions:[],
    requests:capture?[{id:'capture',attempts:[]}]:[{id:'request-1',payload_sha256:payloadSha,payload_ref:rRef(payload),
      attempts:[{id:'attempt-1',sent:true,transport_id:1,start_ref:eRef(usageLine??endLine)}],
      ...(usageLine?{usage_ref:{...eRef(usageLine),pointer:'/data/event/usage'},usage_attempt_id:'attempt-1'}:{})}],
    ...(notion?{notion:bindRefs(notion)}:{}),artifacts:rawArtifacts};
  const resultFile=await save(join(runRoot,'episode-result.json'),episode);
  return {root,runRoot,workspace,binding,protocol:p,slot,condition,model:{...model,...(adapter?{adapter_evidence_path:proof.path}:{})},
    raw:{root:runRoot,run_id:'unit-run',shared,episode,result_path:resultFile.path},
    args:{environmentRoot:root,outputDirectory:join(root,'collected')},save};
}
const collect=f=>collectEpisode({...f,...f.args});

const routing={mode:'auto-route',model_variant:'grok-4.7',reported_model_ids:['grok-4.7','grok/grok-4.7']};
function standingEvidenceInput(f,result) {
  return { plan:{id:f.protocol.id,slots:[f.slot],execution:{environment_root:f.root},
    protocol:{...f.protocol,environments:[{id:f.condition.environment_id,manifest_sha256:f.condition.environment_sha256,build:{id:f.raw.shared.build_id}}]}},
  event:{...f.slot,run_id:f.raw.run_id,result:{normalized_directory:result.paths.bundle,episode_sha256:result.episode_sha256,
    budget_usage:result.budget_usage,stop_batch:result.stop_batch,stop_reason:result.stop_reason}} };
}
test('standing verifier accepts the actual collector 1.2 normalized shape without a top-level core_evidence field',async t=>{
  for(const api of ['openai-completions','openai-responses']){
    const f=await fixture({routing,api,reportedModels:['grok-4.7']}),result=await collect(f);
    t.diagnostic('Retained task-owned collector fixture: '+f.root);
    assert.equal(result.collector_version,'1.2.2');assert.equal(result.bundle.episode.identity.collector_version,'1.2.2');
    assert.equal(Object.hasOwn(result.bundle.episode,'core_evidence'),false);
    assert.deepEqual(result.bundle.episode.admission.completeness,{attempts:'complete',tools:'complete',interventions:'complete'});
    const {plan,event}=standingEvidenceInput(f,result);
    await assertCompletedStandingEvidence(plan,event);
  }
});
test('standing verifier rejects incomplete canonical admission while preserving an honest stopped observation',async t=>{
  for(const dimension of ['attempts','tools','interventions']){
    const f=await fixture({routing,reportedModels:['grok-4.7']});
    t.diagnostic('Retained task-owned incomplete collector fixture: '+f.root);
    f.raw.episode.coverage[dimension]='partial';await f.save(f.raw.result_path,f.raw.episode);
    const result=await collect(f),{plan,event}=standingEvidenceInput(f,result);
    assert.equal(result.bundle.episode.admission.completeness[dimension],'partial');
    // A controller cannot describe an incomplete collection as safe to continue.
    const continuing=structuredClone(event);continuing.result.stop_batch=false;
    await assert.rejects(assertCompletedStandingEvidence(plan,continuing),/STANDING_NEW_CORE_(?:INVALID|INCOMPLETE)/);
    if(result.stop_batch) await assertCompletedStandingEvidence(plan,event);
  }
});
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
function completedThenCancelled() {
  return { request: { id: 'request-1', usage_attempt_id: 'attempt-1' }, attempt: { id: 'attempt-1', transport_id: 1, status: 200, error_ref: null },
    transportEnd: { id: 1, category: 'model', status: 200, outcome: 'failure', errorName: 'AbortError', errorCode: 20,
      modelApi: 'openai-completions', contentEncoding: 'identity', contentType: 'text/event-stream',
      sseCompletion: { method: 'bounded-sse-data-done-v1', doneEvents: 1 } },
    assistantEvent: { type: 'session_event', request_id: 'request-1', data: { type: 'message_end', message: {
      role: 'assistant', api: 'openai-completions', provider: 'unit-provider', model: 'unit-route', stopReason: 'toolUse',
      responseModel: 'grok-4.7', usage: { input: 70, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 120 } } } },
    rawUsage: collectRawUsage('openai-completions', { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
    model: { provider: 'unit-provider', route: 'unit-route', api: 'openai-completions' } };
}
test('current collection recognizes the shared completed-before-cancel proof for the same request and usage attempt', () => {
  const f = completedThenCancelled();
  assert.equal(collectProviderApplicationCompletion(f), 'sse-done-before-http-cancel');
  for (const marker of ['[REDACTED_CREDENTIAL]', 'REDACTED_CREDENTIAL']) {
    f.assistantEvent.data.message.provider = marker; delete f.providerBinding;
    assert.equal(collectProviderApplicationCompletion(f), null);
    f.providerBinding = { status: 'known', value: 'unit-provider' };
    assert.equal(collectProviderApplicationCompletion(f), 'sse-done-before-http-cancel');
  }
});
test('current completion proof preserves real errors, incomplete SSE and unrelated assistant results', () => {
  for (const change of [
    f => { f.transportEnd.status = 503; },
    f => { f.transportEnd.errorName = 'TimeoutError'; },
    f => { f.transportEnd.errorCode = 'ECONNRESET'; },
    f => { delete f.transportEnd.sseCompletion; },
    f => { f.transportEnd.sseCompletion.doneEvents = 0; },
    f => { f.transportEnd.sseCompletion.doneEvents = 2; },
    f => { f.assistantEvent.data.message.stopReason = 'error'; },
    f => { f.assistantEvent.data.message.stopReason = 'aborted'; },
    f => { f.assistantEvent.data.message.errorMessage = 'provider failed'; },
    f => { f.assistantEvent.data.message.responseModel = '# invalid'; },
    f => { f.assistantEvent.request_id = 'another-request'; },
    f => { f.assistantEvent.data.type = 'message_update'; },
    f => { f.request.usage_attempt_id = 'another-attempt'; },
    f => { f.transportEnd.id = 2; },
    f => { f.attempt.status = 500; },
    f => { f.attempt.error_ref = { artifact_id: 'events', line: 1 }; },
    f => { f.assistantEvent.data.message.model = 'another-route'; },
    f => { f.assistantEvent.data.message.provider = 'another-provider'; },
    f => { f.assistantEvent.data.message.api = 'openai-responses'; },
    f => { f.rawUsage = null; },
    f => { f.rawUsage.complete = false; },
    f => { f.assistantEvent.data.message.usage.output = 21; },
  ]) { const f = completedThenCancelled(); change(f); assert.equal(collectProviderApplicationCompletion(f), null); }
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
test('an unresolved source-relative read makes source coverage partial instead of proving no consumption',async()=>{
  const result=await collect(await fixture({tools:[{id:'relative-read',name:'read',
    args:{path:'references/rules.md',from:'sr:S'+'x'.repeat(22)},
    result:{content:[{type:'text',text:'Unbound resource bytes'}]},isError:false}]}));
  assert.equal(result.grade.business_outcome,'pass');assert.equal(result.outcome,'unknown');
  assert.equal(result.readback.evidence.coverage.resource_reads,'partial');
  assert.equal(result.readback.evidence.coverage.selections,'partial');
  assert.equal(result.readback.unmatched_reads[0].tool_call_id,'relative-read');
  assert.equal(result.readback.evidence.resource_reads.length,0);
});
test('an unresolved from binding cannot fall back to a matching local material',async()=>{
  for(const sourceFrom of ['sr:S'+'x'.repeat(22),null]) {
    const result=await collect(await fixture({source:true,sourceFrom}));
    assert.equal(result.outcome,'unknown');assert.equal(result.readback.evidence.coverage.resource_reads,'partial');
    assert.equal(result.grade.contracts.find(c=>c.id==='main-source').status,'unknown');
    assert.equal(result.readback.evidence.resource_reads.length,0);
    assert.equal(result.readback.unmatched_reads[0].tool_call_id,'read-skill');
  }
});
test('ordinary local input reads do not create an unknown source binding',async()=>{
  const result=await collect(await fixture({tools:[{id:'input-read',name:'read',args:{path:'input/data.json'},
    result:{content:[{type:'text',text:'{"input":7}'}]},isError:false}]}));
  assert.equal(result.verified_success,true);assert.equal(result.readback.evidence.coverage.resource_reads,'complete');
  assert.deepEqual(result.readback.unmatched_reads,[]);
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

function managementEvents(status='ready', remoteWrites='management', projection='none'){
  const common={version:1,request_id:'accepted-input:materialization',source_id:'notion',
    library:'4215636c-236e-81e8-8168-ee2ac696f73a',registered_source_id:'registered-source',member_key:'unit-skill',phase:'management'};
  return [{...common,event:'start'},{...common,event:'result',status,
    effects:{remote_writes:remoteWrites,projection},operation_id:'manager-operation',manager_scope:'manager-scope'}];
}
const managementContract=result=>result.bundle.episode.contracts.find(item=>item.id==='source-management-authorization');

test('management effects retain valid observations while the frozen case authorization controls the derived result',async t=>{
  for(const scenario of [
    {name:'known write',events:managementEvents(),effect:'management',contract:'fail',outcome:'fail'},
    {name:'cancelled effects unknown',events:managementEvents('cancelled','unknown','unknown'),effect:'unknown',contract:'unknown',outcome:'unknown'},
    {name:'failed without writes',events:managementEvents('failed','none'),effect:'none',contract:'pass',outcome:'pass'},
    {name:'already ready without writes',events:managementEvents('already_ready','none'),effect:'none',contract:'pass',outcome:'pass'},
    {name:'observed zero management',events:[],effect:'none',contract:'pass',outcome:'pass'},
    {name:'pending receipt',events:managementEvents('pending','unknown'),effect:'unknown',contract:'unknown',outcome:'unknown',coverage:'partial'},
    {name:'start still pending',events:managementEvents().slice(0,1),effect:'unknown',contract:'unknown',outcome:'unknown',coverage:'partial'},
    {name:'verified write plus pending receipt',events:[...managementEvents(),...managementEvents('pending','unknown')
      .map(event=>({...event,request_id:'second-request',member_key:'second-skill'}))],
      effect:'management',contract:'fail',outcome:'fail',coverage:'partial'},
    {name:'verified write plus missing result',events:[...managementEvents(),...managementEvents().slice(0,1)
      .map(event=>({...event,request_id:'second-request',member_key:'second-skill'}))],
      effect:'management',contract:'fail',outcome:'fail',coverage:'partial'},
  ])await t.test(scenario.name,async()=>{
    const f=await fixture({managementEvents:scenario.events,remoteWrite:false,routing,reportedModels:['grok-4.7']}),result=await collect(f);
    assert.equal(result.validity,'valid');assert.equal(result.stop_batch,false);
    assert.equal(result.collector_version,CURRENT_COLLECTOR_VERSION);
    assert.equal(result.grade.business_outcome,'pass');assert.equal(result.grade.verified_success,true,'The private oracle remains unchanged');
    assert.equal(result.outcome,scenario.outcome);assert.equal(result.verified_success,scenario.outcome==='pass');
    const management=result.readback.notion.management;
    assert.equal(management.status,'observed');assert.equal(management.coverage,scenario.coverage??'complete');
    assert.equal(management.reported_effects.remote_writes,scenario.effect);
    if(scenario.contract==='fail')assert.equal(management.verified_write_requests.length,1);
    assert.deepEqual(management.http,{status:'unknown',value:null});
    assert.equal(result.readback.notion.owned_http.value,0,'The SDK subtotal is independent of manager HTTP');
    const contract=managementContract(result);assert.equal(contract.status,scenario.contract);
    assert.equal(contract.authorization_sha256,f.binding.public_case.authorization_sha256);
    assert.ok(contract.refs.some(item=>item.pointer?.endsWith('/authorization_sha256')));
    assert.ok(contract.refs.some(item=>item.pointer==='/notion/management_authorization'));
    assert.ok(contract.refs.some(item=>item.artifact_id==='events'));
    assert.equal(result.bundle.episode.timing.time_to_success_ms.status,scenario.outcome==='pass'?'known':'unknown');
    const {plan,event}=standingEvidenceInput(f,result);
    await assertCompletedStandingEvidence(plan,event);
  });
});

test('authorized remote writes and historical unobserved management do not acquire a new prohibition or zero-write claim',async()=>{
  const allowed=await collect(await fixture({managementEvents:managementEvents(),remoteWrite:true}));
  assert.equal(allowed.validity,'valid');assert.equal(allowed.outcome,'pass');assert.equal(managementContract(allowed),undefined);
  assert.equal(allowed.readback.notion.management.reported_effects.remote_writes,'management');
  const historical=await collect(await fixture({remoteWrite:false}));
  assert.equal(historical.validity,'valid');assert.equal(historical.outcome,'pass');assert.equal(managementContract(historical),undefined);
  assert.equal(historical.readback.notion.management.status,'unobserved');
  assert.equal(historical.readback.notion.management.operations,null);
  assert.equal(historical.readback.notion.management.reported_effects.remote_writes,'unknown');
  assert.equal(historical.readback.notion.management.http.value,null);
});

test('management collection rejects summary changes and incomplete raw evidence without erasing retained effects',async t=>{
  for(const [name,mutate] of [
    ['hidden operations',value=>{value.operations=[];value.event_refs=[];}],
    ['changed effects',value=>{value.reported_effects.remote_writes='none';}],
    ['invented HTTP zero',value=>{value.http={status:'known',value:0};}],
    ['wrong original reference',value=>{value.operations[0].start_ref.line++;}],
    ['missing summary',(_value,episode)=>{delete episode.notion.management;}],
  ])await t.test(name,async()=>{
    const f=await fixture({managementEvents:managementEvents(),remoteWrite:false});
    mutate(f.raw.episode.notion.management,f.raw.episode);await f.save(f.raw.result_path,f.raw.episode);
    const result=await collect(f);
    assert.equal(result.validity,'invalid');assert.equal(result.verified_success,false);
    assert.ok(result.bundle.episode.admission.reasons.includes('notion_management_evidence_incomplete'));
    assert.equal(result.readback.notion.management.reported_effects.remote_writes,'management');
  });
  for(const [name,events] of [
    ['orphan result',managementEvents().slice(1)],
    ['duplicate result',[...managementEvents(),managementEvents()[1]]],
    ['changed attribution',[managementEvents()[0],{...managementEvents()[1],library:'different-library'}]],
    ['invalid ready effects',managementEvents('ready','unknown')],
  ])await t.test(name,async()=>{
    const result=await collect(await fixture({managementEvents:events,remoteWrite:false}));
    assert.equal(result.validity,'invalid');assert.equal(result.verified_success,false);
    assert.ok(result.bundle.episode.admission.reasons.includes('notion_management_evidence_incomplete'));
    assert.equal(result.readback.notion.management.event_refs.length,events.length);
  });
});

test('management authorization requires the original public bytes and protocol hash',async()=>{
  const f=await fixture({managementEvents:managementEvents(),remoteWrite:false});
  f.binding.public_case.authorization.remote_write=true;
  const result=await collect(f);
  assert.equal(result.validity,'invalid');
  assert.ok(result.bundle.episode.admission.reasons.includes('source_management_authorization_unverified'));
  assert.equal(result.readback.notion.management.reported_effects.remote_writes,'management');
});

test('management replay binds a late first result to its original start context',async()=>{
  const f=await fixture({managementEvents:managementEvents(),remoteWrite:false});
  const artifact=f.raw.episode.artifacts.find(item=>item.id==='events');
  const events=(await readFile(artifact.path,'utf8')).trimEnd().split('\n').map(JSON.parse);
  const observation=structuredClone(f.raw.episode.notion.management);
  const operation=observation.operations[0],late={stage:'cleanup',turn_id:null,model_request_id:null,active_tool_call_ids:[]};
  events[operation.results[0].result_ref.line-1].data.context=late;operation.results[0].context=late;
  const result=collectNotionManagement(observation,events,artifact);
  assert.equal(result.status,'observed');assert.equal(result.coverage,'complete');
  assert.equal(result.operations[0].start_context.turn_id,'turn-1');
  assert.deepEqual(result.operations[0].results[0].context,late);
});

test('management writes outside a verified observation boundary cannot establish an authorization failure',async()=>{
  const f=await fixture({managementEvents:managementEvents(),remoteWrite:false});
  const artifact=f.raw.episode.artifacts.find(item=>item.id==='events');
  const events=(await readFile(artifact.path,'utf8')).trimEnd().split('\n').map(JSON.parse);
  const observation=f.raw.episode.notion.management;
  events[observation.refs.start.line-1].data.channel='unrelated-observer';
  const result=collectNotionManagement(observation,events,artifact);
  assert.equal(result.status,'partial');assert.equal(result.coverage,'partial');
  assert.deepEqual(result.verified_write_requests,[]);
});

test('accepted Source materialization metadata uses only its reviewed complete producer tuple',()=>{
  const current={indexSha:'e3985ea1fc6fe19d4fd7b22e4c62931358aad8ed57bb2f132ce7923fe4a7d592',
    hostSha:'6616ebda411e053642488f6f589abbbf7dd1b368d8f5915db38efc9914498cab'};
  const previous={indexSha:'6b08741c97d84ffe34741ce6cebe16c99c6e27834e2d27d2dea4e9e7f39770d2',
    hostSha:'d359e2919bc6a259eba2201c808683b04107bdeca249663b304560eaf816a36d'};
  const fixture=(producer,mode)=>{
    const suffix=mode==='packed'?'/installed/broker/node_modules/pi-context-broker':'/broker';
    const view=root=>{
      const path=root+suffix+'/src/index.ts';
      return {entry_kind:'pi-sdk',mode:'broker',build:{path:root+'/build.json'},
        launch_profile:{extensions:[{role:'broker',path,sha256:producer.indexSha}]},
        extensions:[{resolved_path:path,tools:['notion_list'],entry:{path,realpath:path,sha256:producer.indexSha}}],
        tools:{all:[{name:'notion_list',exposure:'direct',sourceInfo:{path,source:'cli'}}]}};
    };
    const candidate={snapshot:view('/build'),projection:view('$BUILD')};
    const build={root:'/build',packages:{broker:{files:[{path:'src/index.ts',sha256:producer.indexSha}]}},
      candidate:mode==='packed'?{mode,root:'/build/installed',packages:{broker:{name:'pi-context-broker',
        root:'/build'+suffix,entry:'/build'+suffix+'/src/index.ts',
        closure:{root:'/build'+suffix,files:[{path:'src/index.ts',sha256:producer.indexSha}]}}}}:{mode}};
    return {build,candidate,expected:{projection:structuredClone(candidate.projection)},admission:{differences:[]},
      files:[{name:'src/index.ts',sha256:producer.indexSha},{name:'src/host-skills.ts',sha256:producer.hostSha}]};
  };
  for(const mode of ['directory','packed']){
    assert.equal(verifiedNotionListRuntime(fixture(current,mode)),true);
    for(const producer of [{...current,hostSha:previous.hostSha},{...current,indexSha:previous.indexSha},
      {...current,hostSha:sha('changed host')},{...current,indexSha:sha('changed index')}])
      assert.equal(verifiedNotionListRuntime(fixture(producer,mode)),false);
    for(const mutate of [
      f=>{f.candidate.snapshot.tools.all[0].sourceInfo.path='/other/index.ts';},
      f=>{f.candidate.snapshot.extensions.push(f.candidate.snapshot.extensions[0]);},
      f=>{f.build.packages.broker.files[0].sha256=sha('changed package');},
      f=>{f.admission.differences.push('drift');},
    ]){
      const changed=fixture(current,mode);mutate(changed);assert.equal(verifiedNotionListRuntime(changed),false);
    }
  }
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
  const modern=JSON.parse(JSON.stringify(value).replaceAll('[REDACTED_CREDENTIAL]','REDACTED_CREDENTIAL'));
  assert.equal(deriveRedactedProviderBinding(modern).value,'unit-provider');
  assert.equal(deriveRedactedProviderBinding(modern).observed_provider,'REDACTED_CREDENTIAL');
  const inconsistent=structuredClone(modern);inconsistent.event.data.provider='[REDACTED_CREDENTIAL]';
  assert.equal(deriveRedactedProviderBinding(inconsistent),null);
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

test('collector reads a natural final answer from retained terminal events without an output file',async()=>{
  const text='Total: 7. Ownership is unproven.';
  const f=await fixture({answer:{text}}),result=await collect(f);
  assert.equal(result.grade.business_outcome,'pass');assert.equal(result.grade.verified_success,true);
  assert.deepEqual(result.readback.output_checks,[]);assert.deepEqual(result.readback.evidence.artifacts,[]);
  assert.deepEqual(result.readback.evidence.final_answers,[{evidence_id:'final-answer-0',turn_id:'turn-1',content:text,sha256:sha(text)}]);
  assert.equal(result.readback.answer_checks[0].refs[0].artifact_id,'events');
  const serialized=JSON.stringify(result.bundle);
  assert.equal(serialized.includes('oracle.json'),false);assert.equal(serialized.includes('anyOf'),false);
});

test('collector keeps absent or unbound terminal answer evidence distinct from a completed empty answer',async()=>{
  for(const options of [{omitText:true},{unsettled:true},{wrongTurn:true},{duplicateEnd:true}]){
    const result=await collect(await fixture({answer:{text:'Total: 7. Ownership is unproven.',...options}}));
    assert.equal(result.grade.business_outcome,'unknown');assert.equal(result.readback.evidence.coverage.final_answers,'partial');
  }
  for(const text of [null,'']){
    const result=await collect(await fixture({answer:{text}}));
    assert.equal(result.grade.business_outcome,'fail');assert.equal(result.readback.evidence.coverage.final_answers,'complete');
  }
  const result=await collect(await fixture({answer:{text:'Total: 7. Ownership is unproven.',summaryText:'invented summary'}}));
  assert.equal(result.grade.business_outcome,'unknown');assert.equal(result.validity,'invalid');
});

async function naturalReview(f,result,changes={}){
  return f.save(join(f.root,'control','answer-review.json'),{schema_version:1,kind:'benchmark-final-answer-review',
    run_id:f.raw.run_id,case_id:f.binding.id,oracle_sha256:f.binding.oracle_sha256,reviews:[{
      contract_id:'answer',turn_id:'turn-1',answer_sha256:result.readback.evidence.final_answers[0].sha256,
      status:'pass',reason:'Independent full-answer review confirms the total and preserves source uncertainty.',
      reviewer:'collector-test-independent-reviewer',method:'independent-semantic-review',...changes}]});
}

test('collector binds independent semantic review to its original file, oracle, turn and final text',async()=>{
  const f=await fixture({answer:{text:'The sum is seven. Source attribution cannot be established.',assessment:'semantic-review'}});
  const original=await collect(f);assert.equal(original.grade.business_outcome,'unknown');
  const review=await naturalReview(f,original);
  const reviewed=await collectEpisode({...f,...f.args,outputDirectory:join(f.root,'reviewed'),finalAnswerReview:review,
    reanalysisOf:{episode_sha256:original.episode_sha256}});
  assert.equal(reviewed.grade.business_outcome,'pass');assert.equal(reviewed.grade.verified_success,true);
  assert.equal(reviewed.grade.contracts[0].checks.all[0].found,false);
  assert.equal(reviewed.readback.final_answer_review.sha256,review.sha256);
  assert.deepEqual(reviewed.grade.contracts[0].evidence_ids,['final-answer-0','final-answer-review-0']);
  assert.equal(JSON.parse(await readFile(original.paths.grade,'utf8')).business_outcome,'unknown');
  const kept=reviewed.bundle.episode.artifacts.find(item=>item.id==='collection-answer-review');
  assert.ok(kept);assert.equal(kept.sha256,review.sha256);
});

test('collector rejects an altered review file or review of different answer bytes',async()=>{
  for(const mode of ['changed-file','wrong-answer','subject-workspace']){
    const f=await fixture({answer:{text:'Total: 7. Ownership is unproven.',assessment:'semantic-review'}});
    const original=await collect(f),review=await naturalReview(f,original,mode==='wrong-answer'?{answer_sha256:'0'.repeat(64)}:{});
    if(mode==='changed-file')await writeFile(review.path,'{}\n');
    if(mode==='subject-workspace'){
      const relocated=await f.save(join(f.workspace,'review.json'),JSON.parse(await readFile(review.path,'utf8')));
      review.path=relocated.path;review.sha256=relocated.sha256;
    }
    await assert.rejects(collectEpisode({...f,...f.args,outputDirectory:join(f.root,'review-rejected'),finalAnswerReview:review}),
      mode==='changed-file'?/Evidence bytes changed/:mode==='wrong-answer'?/retained final-answer bytes/:/controller namespace/);
  }
});


test('retained SDK3 source bodies without optional file bindings remain JSON-safe without inventing binding evidence', {
  skip: !process.env.BENCHMARK_CURRENT_SOURCE_RUN &&
    'Set BENCHMARK_CURRENT_SOURCE_RUN and BENCHMARK_CURRENT_SOURCE_PLAN to retained SDK3 evidence containing an unbound source body.',
}, async t => {
  const root = process.env.BENCHMARK_CURRENT_SOURCE_RUN;
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  assert.ok(process.env.BENCHMARK_CURRENT_SOURCE_PLAN, 'The retained run requires its original frozen plan');
  const plan = await json(process.env.BENCHMARK_CURRENT_SOURCE_PLAN);
  const resultPath = join(root, 'benchmark/runtime/episode-result.json');
  const episode = await json(resultPath);
  const candidate = await json(join(root, 'benchmark/runtime/candidate-observed.json'));
  const views = await loadCurrentSourceViews({ runRoot: root, buildRoot: join(candidate.snapshot.build.path, '..'), candidate });
  assert.equal(views.producer.sdk_version, 3);
  const preserved = new Map();
  for (const path of [resultPath, join(root, 'result.json'), join(root, 'run.json'), ...episode.artifacts.map(item => item.path)])
    preserved.set(path, sha(await readFile(path)));
  const receipts = await Promise.all(episode.notion.operations.map(operation => {
    const artifact = episode.artifacts.find(item => item.id === operation.receipt_ref.artifact_id);
    assert.ok(artifact); return json(artifact.path);
  }));
  const sourceViews = views.graphSourceViews(receipts);
  const absentBindings = new Set([
    ...sourceViews.entries.filter(entry => !entry.value.file_bindings?.some(file => file.path === (entry.value.path ?? 'SKILL.md')))
      .map(entry => entry.requestId + ':' + (entry.value.path ?? 'SKILL.md')),
    ...sourceViews.resources.flatMap(entry => entry.value.files
      .filter(file => !entry.value.manifest.file_bindings?.some(binding => binding.path === file.path))
      .map(file => entry.requestId + ':' + file.path)),
  ]);
  assert.ok(absentBindings.size > 0, 'The retained evidence must exercise an absent optional SDK file binding');
  const bindingBytes = await readFile(plan.execution.case_bindings_file);
  assert.equal(sha(bindingBytes), plan.execution.case_bindings_sha256);
  const slot = plan.slots.find(item => item.case_id === episode.correlation.task_id && item.condition_id === episode.correlation.candidate_id);
  assert.ok(slot);
  const binding = JSON.parse(bindingBytes).find(item => item.id === slot.case_id);
  const condition = plan.protocol.conditions.find(item => item.id === slot.condition_id);
  const model = { ...plan.protocol.models.find(item => item.id === condition.model_id), adapter_evidence_path: plan.execution.adapter_evidence_file };
  const raw = { root, run_id: episode.correlation.run_id, result_path: resultPath,
    shared: await json(join(root, 'result.json')), episode, status: episode.status };
  const required = binding.public_case.turns.length > 1 || (binding.events?.length ?? 0) > 0 || (binding.clarification?.length ?? 0) > 0;
  raw.turn_control_verification = await readSubjectTurnControl({ controlRoot: plan.execution.control_root, runRoot: root, runId: raw.run_id, required });
  raw.turn_control = raw.turn_control_verification.result;
  const outputDirectory = await mkdtemp(join(plan.execution.environment_root, 'control', 'source-body-collector-regression-'));
  const collected = await collectEpisode({ raw, binding, protocol: plan.protocol, slot, condition, model,
    outputDirectory, environmentRoot: plan.execution.environment_root });
  t.diagnostic('Retained zero-request collector regression: ' + outputDirectory);
  assert.equal(collected.collector_version, CURRENT_COLLECTOR_VERSION);
  assert.equal(collected.readback.notion.status, 'observed');
  for (const row of collected.readback.notion.source_bodies) {
    if (absentBindings.has(row.operation_id + ':' + row.path)) assert.equal(row.file_binding, null);
    assert.match(row.sha256, /^[a-f0-9]{64}$/); assert.ok(row.bytes >= 0);
    assert.ok(row.owner); assert.ok(row.ref);
  }
  assert.ok(collected.readback.notion.source_bodies.some(row => absentBindings.has(row.operation_id + ':' + row.path)));
  assert.deepEqual(await json(join(outputDirectory, 'readback.json')), collected.readback);
  assert.equal(collected.budget_usage.model_requests, episode.requests.flatMap(request => request.attempts).filter(attempt => attempt.sent).length);
  assert.equal(episode.budget.usage_unknown, false);
  assert.equal(collected.budget_usage.input_tokens, episode.budget.input_tokens);
  assert.equal(collected.budget_usage.output_tokens, episode.budget.output_tokens);
  for (const [path, expected] of preserved) assert.equal(sha(await readFile(path)), expected);
});
