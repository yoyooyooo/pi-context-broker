import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeEpisode} from './evidence/normalize.mjs';
import {assessReportedModel} from './reported-model.mjs';
import {deriveRedactedProviderBinding} from './provider-binding.mjs';
import {verifyBundle,writeEvidenceBundle,readEvidenceBundle,buildEvidenceIndex,queryEvidenceIndex,inventoryLegacyEvidence,resolveEvidenceRef} from './evidence/store.mjs';
import {exampleEnvelope,exampleEpisode} from './analysis/fixtures.mjs';
import {fingerprint} from './protocol.mjs';

test('public projection needs an explicit exact manifest mapping and cannot weaken private verification',async()=>{
  const f=await reportedBundle(),episode=structuredClone(f.bundle.episode),pathsBySha256={};
  const mapping=episode.artifacts.map(artifact=>{
    pathsBySha256[artifact.sha256]=artifact.path;
    const format=artifact.kind==='jsonl'?'jsonl':'json',row={source_sha256:artifact.sha256,public_sha256:artifact.sha256,
      source_bytes:artifact.bytes,public_bytes:artifact.bytes,public_path:'raw/'+artifact.sha256,format,changed:false,
      line_locators:format==='jsonl'?'preserved one-to-one':'not a JSONL artifact',
      inner_hash_claims:'historical original claims; transformed bytes are identified by public_sha256'};
    artifact.path=row.public_path;artifact.publication={source_sha256:row.source_sha256,source_bytes:row.source_bytes,transformed:false};return row;
  });
  const descriptor={raw_mapping_sha256:fingerprint(mapping),raw_mapping:mapping};
  episode.identity.public_projection={raw_mapping_sha256:descriptor.raw_mapping_sha256};
  const rehash=()=>{episode.episode_sha256=fingerprint({...episode,episode_sha256:null});};rehash();
  const options={root:f.root,pathsBySha256};
  await assert.rejects(()=>verifyBundle({episode},options),/requires an explicit verified manifest mapping/);
  const result=await verifyBundle({episode},{...options,publicProjection:descriptor});
  assert.match(result.verification_scope,/original-inner-hash-claims-not-recomputed/);
  await assert.rejects(()=>verifyBundle({episode},{...options,publicProjection:{...descriptor,raw_mapping_sha256:'0'.repeat(64)}}),/mapping fingerprint/);
  const originalSize=episode.artifacts[0].publication.source_bytes;episode.artifacts[0].publication.source_bytes++;rehash();
  await assert.rejects(()=>verifyBundle({episode},{...options,publicProjection:descriptor}),/original-to-public mapping/);
  episode.artifacts[0].publication.source_bytes=originalSize;
  const badMapping=structuredClone(mapping);badMapping.find(row=>row.format==='jsonl').line_locators='not guaranteed';
  const badDescriptor={raw_mapping_sha256:fingerprint(badMapping),raw_mapping:badMapping};
  episode.identity.public_projection.raw_mapping_sha256=badDescriptor.raw_mapping_sha256;rehash();
  await assert.rejects(()=>verifyBundle({episode},{...options,publicProjection:badDescriptor}),/row is incomplete/);
  episode.identity.public_projection.raw_mapping_sha256=descriptor.raw_mapping_sha256;
  episode.attempts[0].reported_model.observations[0].value='grok/grok-4.6';rehash();
  await assert.rejects(()=>verifyBundle({episode},{...options,publicProjection:descriptor}),/value or field differs/);
});

async function reportedBundle({values=['grok/grok-4.7'],keep,claimedValues,rawRequest,rawRoute,auto=false}={}) {
  const root=await mkdtemp(join(tmpdir(),'benchmark-reported-raw-')),path=join(root,'raw.json');
  const {input,rawText}=exampleEnvelope({rawPath:path,cost:0.1});await writeFile(path,rawText);
  const attempt=input.attempts[0],route=auto?'auto/grok-4.7':'grok/grok-4.7';
  const routing={mode:auto?'auto-route':'fixed-route',model_variant:'grok-4.7',reported_model_ids:['grok/grok-4.7',...(auto?['auto/grok-4.7']:[])]};
  Object.assign(input.identity,{model_routing:routing,model_route:route,model_provider:'unit-provider',model_api:'openai-completions'});
  const rows=values.map(value=>({type:'provider_stream_event',data:{request_id:rawRequest??attempt.request_id,attempt_id:attempt.id,
    provider:'unit-provider',api:'openai-completions',model:rawRoute??route,event:{model:value}}}));
  const text=rows.map(JSON.stringify).join('\n')+'\n',eventsPath=join(root,'events.jsonl');await writeFile(eventsPath,text);
  const artifact={id:'events',path:eventsPath,kind:'jsonl',sha256:createHash('sha256').update(text).digest('hex'),bytes:Buffer.byteLength(text)};
  input.artifacts.push(artifact);
  attempt.reported_model=assessReportedModel({routing,sent:true,refs:attempt.refs,
    observations:(keep??values.map((_,i)=>i)).map((index,position)=>({value:claimedValues?.[position]??values[index],field:'/data/event/model',bound:true,
      ref:{artifact_id:'events',sha256:artifact.sha256,line:index+1}}))});
  return {root,bundle:normalizeEpisode(input),input,rows};
}

// Synthetic original artifacts exercise the complete offline binding boundary;
// none of these records are a provider execution or retained study material.
async function redactedReportedBundle(marker,{mutate=()=>{},values}={}) {
  const {root,input,rows}=await reportedBundle({values}),attempt=input.attempts[0];
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const model={id:'unit-model',provider:'unit-provider',api:input.identity.model_api,
    route:input.identity.model_route,routing:input.identity.model_routing,parameters:{maxTokens:100}};
  input.identity.model_id=model.id;
  for(const row of rows)row.data.provider=marker;
  const selected={provider:marker,id:model.route,api:model.api,baseUrl:'http://127.0.0.1:1234/v1'};
  const candidate={projection:{model:selected,model_parameters:model.parameters,
    model_configuration:{definition:{providers:{'unit-provider':{api:model.api,baseUrl:selected.baseUrl,models:[{id:model.route}]}}}}}};
  const payload={model:model.route,messages:[]};
  const request={id:attempt.request_id,usage_attempt_id:attempt.id,payload_sha256:hash(JSON.stringify(payload)),
    attempts:[{id:attempt.id,transport_id:1}]};
  const proof={event:rows[0],request,model,candidate,expected:structuredClone(candidate),admission:{differences:[]},payload,
    requestStart:{type:'model_request_start',data:{request_id:request.id,capture_only:false,model:selected}},
    attemptStart:{type:'http_attempt_start',data:{request_id:request.id,attempt_id:attempt.id,method:'POST',
      url_origin:'http://127.0.0.1:1234',url_path:'/v1/chat/completions'}},
    transportStart:{phase:'request_start',category:'model',method:'POST',id:1,
      originSha256:hash('http://127.0.0.1:1234'),pathSha256:hash('/v1/chat/completions')},
    transportSent:{phase:'request_sent',id:1,requestBodySha256:request.payload_sha256},
    transportEnd:{phase:'request_end',id:1},attemptId:attempt.id,refs:attempt.refs};
  const binding=deriveRedactedProviderBinding(proof);
  assert.equal(binding?.status,'known');
  // Negative fixtures keep a claimed known binding but rehash their changed
  // original artifacts, so verifyBundle must rederive rather than trust it.
  mutate(proof,binding,rows);
  const reportedRows=[...rows];
  rows.push(proof.requestStart,proof.attemptStart,...[proof.transportStart,proof.transportSent,proof.transportEnd].filter(Boolean));
  const eventsText=rows.map(JSON.stringify).join('\n')+'\n',events=input.artifacts.find(a=>a.id==='events');
  await writeFile(events.path,eventsText);
  Object.assign(events,{sha256:hash(eventsText),bytes:Buffer.byteLength(eventsText)});
  const eventRef=row=>({artifact_id:'events',sha256:events.sha256,line:rows.indexOf(row)+1});
  const save=async(id,value)=>{
    const text=JSON.stringify(value),path=join(root,id+'.json');
    await writeFile(path,text);
    const artifact={id,path,kind:'json',sha256:hash(text),bytes:Buffer.byteLength(text)};
    input.artifacts.push(artifact);
    return {artifact_id:id,sha256:artifact.sha256,pointer:''};
  };
  const candidateRef=await save('candidate-observed',proof.candidate);
  const expectedRef=await save('collection-provider-binding-expectation',proof.expected);
  proof.admission.expected_file={sha256:expectedRef.sha256};
  const admissionRef=await save('admission-comparison',proof.admission);
  const payloadRef=await save('provider-payload',proof.payload);
  proof.request.start_ref=eventRef(proof.requestStart);
  proof.request.payload_ref=payloadRef;
  proof.request.attempts[0].start_ref=eventRef(proof.attemptStart);
  const runtimeRef=await save('collection-runtime-result',{requests:[proof.request]});
  const protocolRef=await save('collection-protocol',{models:[proof.model]});
  attempt.transport_id=1;
  attempt.provider_binding={...binding,refs:[candidateRef,expectedRef,admissionRef,payloadRef,runtimeRef,protocolRef,...rows.map(eventRef)]};
  attempt.reported_model=assessReportedModel({routing:input.identity.model_routing,sent:true,refs:attempt.refs,
    observations:reportedRows.map(row=>({value:row.data.event.model,field:'/data/event/model',bound:true,ref:eventRef(row)}))});
  return {root,bundle:normalizeEpisode(input)};
}

for(const marker of ['[REDACTED_CREDENTIAL]','REDACTED_CREDENTIAL']) {
  test('redacted provider bundle accepts complete original proof: '+marker,async()=>{
    const f=await redactedReportedBundle(marker);
    assert.equal(f.bundle.episode.attempts[0].provider_binding.observed_provider,marker);
    assert.equal((await verifyBundle(f.bundle,{root:f.root})).valid,true);
  });
  test('redacted provider bundle rejects missing or forged transport proof: '+marker,async()=>{
    for(const mutate of [
      proof=>{proof.transportSent=null;},
      proof=>{proof.transportSent.requestBodySha256='b'.repeat(64);},
      proof=>{proof.transportStart.originSha256='c'.repeat(64);},
    ]) {
      const f=await redactedReportedBundle(marker,{mutate});
      await assert.rejects(()=>verifyBundle(f.bundle,{root:f.root}),/binding differs from raw request metadata/);
    }
  });
  test('redacted provider bundle rejects a claimed different observed marker: '+marker,async()=>{
    const other=marker==='REDACTED_CREDENTIAL'?'[REDACTED_CREDENTIAL]':'REDACTED_CREDENTIAL';
    const f=await redactedReportedBundle(marker,{mutate:(_proof,binding)=>{binding.observed_provider=other;}});
    await assert.rejects(()=>verifyBundle(f.bundle,{root:f.root}),/binding differs from raw request metadata/);
  });
  test('redacted provider bundle cannot reuse proof for another raw marker in the same attempt: '+marker,async()=>{
    const other=marker==='REDACTED_CREDENTIAL'?'[REDACTED_CREDENTIAL]':'REDACTED_CREDENTIAL';
    const f=await redactedReportedBundle(marker,{values:['grok/grok-4.7','grok/grok-4.7'],
      mutate:(_proof,_binding,rows)=>{rows[1].data.provider=other;}});
    await assert.rejects(()=>verifyBundle(f.bundle,{root:f.root}),/binding differs from raw request metadata/);
  });
}

test('bundle verification proves original reported value, request identity and complete event coverage',async()=>{
  const valid=await reportedBundle();assert.equal((await verifyBundle(valid.bundle,{root:valid.root})).valid,true);
  const forged=await reportedBundle({values:['grok/grok-4.6'],claimedValues:['grok/grok-4.7']});
  await assert.rejects(()=>verifyBundle(forged.bundle,{root:forged.root}),/value or field differs/);
  const otherRequest=await reportedBundle({rawRequest:'a-different-request'});
  await assert.rejects(()=>verifyBundle(otherRequest.bundle,{root:otherRequest.root}),/original request and attempt/);
  const otherRoute=await reportedBundle({rawRoute:'some-other-route'});
  await assert.rejects(()=>verifyBundle(otherRoute.bundle,{root:otherRoute.root}),/binding differs/);
  const omitted=await reportedBundle({values:['grok/grok-4.7','grok/grok-4.6','grok/grok-4.7'],keep:[0,2]});
  assert.equal(omitted.bundle.episode.admission.status,'valid');
  await assert.rejects(()=>verifyBundle(omitted.bundle,{root:omitted.root}),/omits an original server model event/);
});
test('raw-backed mismatch remains retainable with usage/cost and an explicit auto alias stays opaque',async()=>{
  const mismatch=await reportedBundle({values:['grok/grok-4.7','grok/grok-4.6']});
  assert.equal((await verifyBundle(mismatch.bundle,{root:mismatch.root})).valid,true);
  assert.equal(mismatch.bundle.episode.admission.status,'invalid');assert.equal(mismatch.bundle.episode.measurements.cost.value.amount,0.1);
  const alias=await reportedBundle({values:['auto/grok-4.7'],auto:true});
  assert.equal((await verifyBundle(alias.bundle,{root:alias.root})).valid,true);
  assert.equal(alias.bundle.episode.attempts[0].reported_model.label_kind,'requested_route_alias');
});

test('offline normalization refuses to make an early missing model valid because a later attempt matches',()=>{
  const {input}=exampleEnvelope({attemptInputs:[100,180],cost:0.1});
  const routing={mode:'auto-route',model_variant:'grok-4.7',reported_model_ids:['grok/grok-4.7']};
  input.identity.model_routing=routing;
  for(const [index,attempt] of input.attempts.entries()) attempt.reported_model=assessReportedModel({routing,sent:attempt.sent,refs:attempt.refs,
    observations:index===0?[]:[{value:'grok/grok-4.7',field:'/data/event/response/model',ref:attempt.refs[0]}]});
  const {episode}=normalizeEpisode(input);
  assert.equal(episode.admission.status,'invalid');assert.ok(episode.admission.reasons.includes('reported_model_missing'));
  assert.equal(episode.result.outcome,'not_applicable');assert.equal(episode.measurements.actual_attempts.value,2);
  assert.equal(episode.measurements.input_total.value.value,280);assert.equal(episode.measurements.cost.value.amount,0.2);
  assert.equal(episode.attempts[1].reported_model.status,'matched');
});
test('reported model claims must reproduce the raw observations and retain hash-bound refs',()=>{
  const {input}=exampleEnvelope();
  input.identity.model_routing={mode:'fixed-route',model_variant:'grok-4.7',reported_model_ids:['grok/grok-4.7']};
  const attempt=input.attempts[0];
  attempt.reported_model=assessReportedModel({routing:input.identity.model_routing,sent:true,refs:attempt.refs,
    observations:[{value:'grok/grok-4.6',field:'/data/event/response/model',ref:attempt.refs[0]}]});
  attempt.reported_model.status='matched';
  assert.throws(()=>normalizeEpisode(input),/differs from its original observations/);
  attempt.reported_model.status='mismatch';attempt.reported_model.observations[0].ref={...attempt.refs[0],sha256:'0'.repeat(64)};
  assert.throws(()=>normalizeEpisode(input),/raw artifact hash/);
});

test('normalization is deterministic and keeps every actual retry',()=>{
  const {input}=exampleEnvelope({attemptInputs:[100,180]});
  const a=normalizeEpisode(input),b=normalizeEpisode(structuredClone(input));
  assert.deepEqual(a,b);
  assert.equal(a.episode.measurements.input_total.value.value,280);
  assert.equal(a.episode.measurements.input_peak.value,180);
  assert.equal(a.episode.measurements.input_first.value,100);
  assert.equal(a.episode.measurements.actual_attempts.value,2);
});
test('cache inclusion is adapter-specific and reasoning is not counted twice',()=>{
  const included=exampleEpisode({attemptInputs:[100],cacheRead:80});
  const excluded=exampleEpisode({attemptInputs:[100],cacheRead:80,cacheWrite:20,inputSemantics:'excludes_cache_read_write'});
  assert.equal(included.measurements.input_total.value.value,100);
  assert.equal(excluded.measurements.input_total.value.value,200);
  assert.equal(included.measurements.output_total.value.value,10);
});
test('missing first attempt remains unknown even if a later attempt has usage',()=>{
  const e=exampleEpisode({attemptInputs:[null,180]});
  assert.equal(e.measurements.input_first.status,'unknown');
  assert.equal(e.measurements.input_total.value.status,'unknown');
  assert.equal(e.measurements.input_peak.status,'unknown');
  assert.equal(e.measurements.input_total.known_subtotal,180);
});
test('unobserved sends and unverified adapter cannot be counted as complete usage',()=>{
  const incomplete=exampleEpisode({attemptsComplete:false});
  const unverified=exampleEpisode({adapterVerified:false});
  assert.equal(incomplete.measurements.input_first.status,'unknown');
  assert.equal(incomplete.measurements.input_total.value.status,'unknown');
  assert.equal(unverified.measurements.input_total.value.status,'unknown');
});
test('native and nested tool facts retain ancestry, args, errors and distinct counts',()=>{
  const tools=[{id:'p',parent_id:null,name:'code',args:{code:'call()'},status:'pass',interface_misuse:false,logical_operation_id:'op'},
    {id:'p/1',parent_id:'p',name:'skills_read',args:{path:'refs/guide.md'},status:'fail',error:'original error',interface_misuse:true,logical_operation_id:'op'}];
  const e=exampleEpisode({tools});
  assert.deepEqual(e.tools[1].args,{path:'refs/guide.md'});
  assert.equal(e.tools[1].error,'original error');
  assert.equal(e.measurements.tool_top_level.value,1);
  assert.equal(e.measurements.tool_nested.value,1);
  assert.equal(e.measurements.logical_operations.value,1);
  assert.equal(e.measurements.interface_misuse.value,1);
});
test('cyclic or missing tool parents are rejected',()=>{
  const tool={id:'p',parent_id:'missing',name:'read',args:{},status:'pass'};
  assert.throws(()=>exampleEpisode({tools:[tool]}),/parent/);
  assert.throws(()=>exampleEpisode({tools:[{...tool,parent_id:'p'}]}),/acyclic/);
});
test('unknown is not failure and critical contract failure blocks verified success',()=>{
  const u=exampleEpisode({outcome:'unknown'}),f=exampleEpisode({criticalFail:true});
  assert.equal(u.result.outcome,'unknown');assert.equal(u.result.verified_success,false);
  assert.equal(f.result.outcome,'fail');assert.deepEqual(f.result.critical_failures,['business-contract']);
});
test('rescue, incomplete intervention observation and clarification are distinct',()=>{
  assert.equal(exampleEpisode({rescue:true}).result.unassisted_success,false);
  assert.equal(exampleEpisode({interventionsComplete:false}).result.unassisted_success,null);
  const {input}=exampleEnvelope({rescue:true});input.interventions[0].kind='task_clarification';
  assert.equal(normalizeEpisode(input).episode.result.unassisted_success,true);
});
test('unsupported and invalid are not model failures',()=>{
  assert.equal(exampleEpisode({capability:'unsupported'}).result.outcome,'not_applicable');
  assert.equal(exampleEpisode({valid:false,outcome:'fail'}).result.outcome,'not_applicable');
});
test('known facts require hash-bound locators and explicit precision',()=>{
  const {input}=exampleEnvelope();
  input.timing.duration_ms.refs=[];
  assert.throws(()=>normalizeEpisode(input),/raw evidence/);
  const other=exampleEnvelope().input;
  other.attempts[0].usage.input.refs[0].sha256='0'.repeat(64);
  assert.throws(()=>normalizeEpisode(other),/raw artifact hash/);
});
test('duplicate attempt IDs, noninteger tokens and negative durations are rejected',()=>{
  const a=exampleEnvelope({attemptInputs:[10,20]}).input;a.attempts[1].id=a.attempts[0].id;
  assert.throws(()=>normalizeEpisode(a),/Duplicate attempt/);
  assert.throws(()=>exampleEpisode({attemptInputs:[1.5]}),/safe integers/);
  assert.throws(()=>exampleEpisode({duration:-1}),/nonnegative/);
});
test('unpriced route is unknown, not free',()=>{
  assert.equal(exampleEpisode().measurements.cost.status,'unknown');
  assert.equal(exampleEpisode({cost:0.1,attemptInputs:[100,200]}).measurements.cost.value.amount,0.2);
  const {input}=exampleEnvelope({cost:0});delete input.attempts[0].pricing_verified;
  assert.throws(()=>normalizeEpisode(input),/verified pricing/);
});
test('bundle verifies actual bytes and locators and rebuilds without rewriting raw',async()=>{
  const root=await mkdtemp(join(tmpdir(),'benchmark-evidence-test-')),path=join(root,'raw.json');
  const {input,rawText}=exampleEnvelope({rawPath:path});await writeFile(path,rawText);
  const bundle=normalizeEpisode(input),directory=join(root,'normalized');
  const receipt=await writeEvidenceBundle({directory,bundle,rawRoot:root});
  const second=await writeEvidenceBundle({directory,bundle,rawRoot:root});
  assert.equal(receipt.receipt_sha256,second.receipt_sha256);
  assert.deepEqual(await readEvidenceBundle({directory,rawRoot:root}),bundle);
  assert.equal(await readFile(path,'utf8'),rawText);
  assert.equal(await resolveEvidenceRef(input.timing.duration_ms.refs[0],input.artifacts,{root}),100);
  await writeFile(path,rawText+' ');
  await assert.rejects(()=>verifyBundle(bundle,{root}),/hash or size mismatch/);
});
test('existing raw hash cannot bless a nonexistent line or JSON pointer',async()=>{
  const root=await mkdtemp(join(tmpdir(),'benchmark-locator-test-')),path=join(root,'raw.json');
  const {input,rawText}=exampleEnvelope({rawPath:path});await writeFile(path,rawText);
  input.timing.duration_ms.refs[0].pointer='/not-present';
  await assert.rejects(()=>verifyBundle(normalizeEpisode(input),{root}),/pointer does not exist/);
});

async function locatorBundle(text,kind='text') {
  const root=await mkdtemp(join(tmpdir(),'benchmark-locator-views-'));
  const {input,rawText}=exampleEnvelope({rawPath:'raw.json'});await writeFile(join(root,'raw.json'),rawText);
  const artifact={id:'locator',path:'locator.raw',kind,sha256:createHash('sha256').update(text).digest('hex'),bytes:Buffer.byteLength(text)};
  await writeFile(join(root,artifact.path),text);input.artifacts.push(artifact);
  const ref=locator=>({artifact_id:artifact.id,sha256:artifact.sha256,...locator});
  return {root,artifact,ref,bundle:{...normalizeEpisode(input),locators:[]}};
}

test('each verification rereads and hashes bytes after prior locator success',async()=>{
  const f=await locatorBundle('{"first":1}', 'json');
  f.bundle.locators=[f.ref({pointer:'/first'}),f.ref({line:1})];
  assert.equal((await verifyBundle(f.bundle,{root:f.root})).valid,true);
  await writeFile(join(f.root,f.artifact.path),'{"first":2}');
  await assert.rejects(()=>verifyBundle(f.bundle,{root:f.root}),/hash or size mismatch: locator/);
  await assert.rejects(()=>resolveEvidenceRef(f.ref({pointer:'/first'}),f.bundle.episode.artifacts,{root:f.root}),/hash or size mismatch: locator/);
});

test('verification views stay local to each evidence root and source mapping',async()=>{
  const a=await locatorBundle('{"first":1}','json'),b=await locatorBundle('{"second":2}','json');
  a.bundle.locators=[a.ref({pointer:'/first'})];b.bundle.locators=[b.ref({pointer:'/second'})];
  const results=await Promise.all([verifyBundle(a.bundle,{root:a.root}),verifyBundle(b.bundle,{root:b.root})]);
  assert.ok(results.every(result=>result.valid));
  b.bundle.locators=[b.ref({pointer:'/first'})];
  await assert.rejects(()=>verifyBundle(b.bundle,{root:b.root}),/pointer does not exist/);
  await assert.rejects(()=>verifyBundle(a.bundle,{root:b.root}),/hash or size mismatch: locator/);
  const mapped='mapped.json',pathsBySha256={[a.artifact.sha256]:mapped};
  await writeFile(join(a.root,mapped),'{"first":1}');
  assert.equal((await verifyBundle(a.bundle,{root:a.root,pathsBySha256})).valid,true);
  await writeFile(join(a.root,mapped),'{"first":2}');
  await assert.rejects(()=>verifyBundle(a.bundle,{root:a.root,pathsBySha256}),/hash or size mismatch: locator/);
  await assert.rejects(()=>verifyBundle(a.bundle,{root:a.root,pathsBySha256:{[a.artifact.sha256]:join(b.root,b.artifact.path)}}),/outside the supplied evidence root/);
  assert.equal((await verifyBundle(a.bundle,{root:a.root})).valid,true);
});

test('private JSON parsing remains lazy and preserves locator error order',async()=>{
  const f=await locatorBundle('not JSON\n','json');
  assert.equal((await verifyBundle(f.bundle,{root:f.root})).valid,true);
  f.bundle.locators=[f.ref({line:1})];
  assert.equal((await verifyBundle(f.bundle,{root:f.root})).valid,true);
  f.bundle.locators=[f.ref({line:2}),f.ref({pointer:''})];
  await assert.rejects(()=>verifyBundle(f.bundle,{root:f.root}),/Raw line locator exceeds artifact: locator/);
  f.bundle.locators.reverse();
  await assert.rejects(()=>verifyBundle(f.bundle,{root:f.root}),SyntaxError);
});

test('JSON views preserve null roots, escaped pointers and own-property bounds',async()=>{
  const f=await locatorBundle('{"a/b":{"~key":null},"array":[false,0],"empty":""}','json');
  f.bundle.locators=['','/a~1b/~0key','/array/0','/array/1','/empty'].map(pointer=>f.ref({pointer}));
  assert.equal((await verifyBundle(f.bundle,{root:f.root})).valid,true);
  assert.equal(await resolveEvidenceRef(f.ref({pointer:'/a~1b/~0key'}),f.bundle.episode.artifacts,{root:f.root}),null);
  for(const pointer of ['/a~1b/missing','/array/2','/constructor']) {
    f.bundle.locators=[f.ref({pointer})];
    await assert.rejects(()=>verifyBundle(f.bundle,{root:f.root}),/pointer does not exist/);
  }
  f.bundle.locators=[f.ref({pointer:'/a~2b'})];
  await assert.rejects(()=>verifyBundle(f.bundle,{root:f.root}),/exactly one valid line or JSON pointer/);
  const nil=await locatorBundle('null\n','json');
  nil.bundle.locators=[nil.ref({pointer:''}),nil.ref({line:1})];
  assert.equal((await verifyBundle(nil.bundle,{root:nil.root})).valid,true);
  assert.equal(await resolveEvidenceRef(nil.ref({pointer:''}),nil.bundle.episode.artifacts,{root:nil.root}),null);
  nil.bundle.locators.push(nil.ref({pointer:'/child'}));
  await assert.rejects(()=>verifyBundle(nil.bundle,{root:nil.root}),/pointer does not exist/);
});

test('line views preserve empty files, final newlines and retained empty lines',async()=>{
  for(const [text,expected] of [['',[]],['one',['one']],['one\n',['one']],['one\n\n',['one','']],['one\r\n',['one\r']]]) {
    const f=await locatorBundle(text);
    f.bundle.locators=expected.map((_,index)=>f.ref({line:index+1}));
    assert.equal((await verifyBundle(f.bundle,{root:f.root})).valid,true);
    for(const [index,line] of expected.entries())
      assert.equal(await resolveEvidenceRef(f.ref({line:index+1}),f.bundle.episode.artifacts,{root:f.root}),line);
    f.bundle.locators.push(f.ref({line:expected.length+1}));
    await assert.rejects(()=>verifyBundle(f.bundle,{root:f.root}),/Raw line locator exceeds artifact: locator/);
    await assert.rejects(()=>resolveEvidenceRef(f.bundle.locators.at(-1),f.bundle.episode.artifacts,{root:f.root}),/Evidence line does not exist/);
  }
});

test('public JSONL validation retains empty lines for subsequent locator checks',async()=>{
  const f=await locatorBundle('{"first":1}\n\n','jsonl'),episode=f.bundle.episode,pathsBySha256={};
  f.bundle.locators=[f.ref({line:1}),f.ref({line:2})];
  const mapping=episode.artifacts.map(artifact=>{
    pathsBySha256[artifact.sha256]=artifact.path;
    const format=artifact.kind==='jsonl'?'jsonl':'json',row={source_sha256:artifact.sha256,public_sha256:artifact.sha256,
      source_bytes:artifact.bytes,public_bytes:artifact.bytes,public_path:'raw/'+artifact.sha256,format,changed:false,
      line_locators:format==='jsonl'?'preserved one-to-one':'not a JSONL artifact',
      inner_hash_claims:'historical original claims; transformed bytes are identified by public_sha256'};
    artifact.path=row.public_path;artifact.publication={source_sha256:row.source_sha256,source_bytes:row.source_bytes,transformed:false};return row;
  });
  const descriptor={raw_mapping_sha256:fingerprint(mapping),raw_mapping:mapping};
  episode.identity.public_projection={raw_mapping_sha256:descriptor.raw_mapping_sha256};
  episode.episode_sha256=fingerprint({...episode,episode_sha256:null});
  const options={root:f.root,pathsBySha256,publicProjection:descriptor};
  const original=structuredClone(f.bundle);
  assert.equal((await verifyBundle(f.bundle,options)).valid,true);
  assert.deepEqual(f.bundle,original);
  f.bundle.locators.push(f.ref({line:3}));
  await assert.rejects(()=>verifyBundle(f.bundle,options),/Raw line locator exceeds artifact: locator/);
});

test('index deduplicates reanalysis and supports stable field queries',()=>{
  const e=exampleEpisode(),other=exampleEpisode({condition:'reference'});
  const index=buildEvidenceIndex([e,e,other]);
  assert.equal(index.rows.length,2);
  assert.equal(queryEvidenceIndex(index,{condition_id:'candidate',outcome:'pass'}).length,1);
  assert.throws(()=>buildEvidenceIndex([e,{...e,episode_sha256:'0'.repeat(64)}]),/reanalysis/);
});
test('legacy inventory marks unavailable and truncated evidence without importing samples',async()=>{
  const root=await mkdtemp(join(tmpdir(),'benchmark-history-test-'));
  const path=join(root,'partial.jsonl');await writeFile(path,'{"ok":true}');
  const result=await inventoryLegacyEvidence({artifacts:[{id:'partial',path,kind:'jsonl'},{id:'missing',path:join(root,'absent'),kind:'json'}]});
  assert.equal(result.entries[0].status,'incomplete');assert.equal(result.entries[1].status,'unavailable');
  assert.equal(result.imported_model_samples,0);
  assert.equal((await inventoryLegacyEvidence()).status,'unavailable');
});

test('missing cache component preserves verified known subtotal without inventing complete input',()=>{
  const e=exampleEpisode({inputSemantics:'excludes_cache_read_write',cacheRead:null,cacheWrite:20});
  assert.equal(e.measurements.input_total.value.status,'unknown');
  assert.equal(e.measurements.input_total.known_subtotal,120);
});
test('two identical actual sends remain two attempts inside one logical decision',()=>{
  const {input}=exampleEnvelope({attemptInputs:[100,100]});
  input.attempts[1].request_id=input.attempts[0].request_id;
  const e=normalizeEpisode(input).episode;
  assert.equal(e.measurements.actual_attempts.value,2);
  assert.equal(e.measurements.model_decisions.value,1);
  assert.equal(e.measurements.retries.value,1);
  assert.equal(e.measurements.input_total.value.value,200);
  assert.equal(e.measurements.transport_http_attempts.status,'unknown');
});
