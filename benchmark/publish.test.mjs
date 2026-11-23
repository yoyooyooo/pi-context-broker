import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson, fingerprint } from './protocol.mjs';
import { exampleEnvelope, exampleProtocol } from './analysis/fixtures.mjs';
import { normalizeEpisode } from './evidence/normalize.mjs';
import { scoreExperiment } from './analysis/compare.mjs';
import { createPublicSanitizer, writePublicEvidencePackage, verifyPublicEvidencePackage } from './publish.mjs';
import { assessReportedModel } from './reported-model.mjs';
import { deriveRedactedProviderBinding } from './provider-binding.mjs';
import { verifyBundle } from './evidence/store.mjs';

const run=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const privateId='4205636c-236e-8110-9a1a-ce92cfb83ee0',secret='synthetic-export-secret-1234567890';
const markerBytes=Buffer.from('00ff0a0d2a6d','hex');
const markerApproval={sha256:'72ee7e95938b82284a312ea248777aad5e5220a20242ccf98d103d33427fc681',
 bytes:6,kind:'source-bytes',purpose:'public-synthetic-fixture'};
async function fixture({terminalOwner,reportedRoute}={}){
 const root=await mkdtemp(join(tmpdir(),'benchmark-public-unit-')),originals=join(root,'private-originals');
 await mkdir(originals);
 const protocol=exampleProtocol({cases:[{id:'c1',family:'unit',cluster_id:'cluster',material_id:'material'}]});
 protocol.private_metadata={workspace:'/Users/unit-person/project',page:privateId};
 protocol.protocol_sha256=fingerprint({...protocol,protocol_sha256:null});
 const episodes=[];
 for(const [index,condition] of ['candidate','reference'].entries()){
  const listing=terminalOwner?'total 8\n-rw-r--r--@  1 '+terminalOwner+' staff 12 Nov 22 12:00 result.json\npublic repo: https://github.com/yoyooyooo/example\n':'';
  const tools=terminalOwner?[{id:'terminal-listing',parent_id:null,name:'bash',status:'pass',
    result:{content:[{type:'text',text:listing}],structuredContent:{output:listing}}}]:[];
  const f=exampleEnvelope({condition,caseId:'c1',outcome:index===0?'unknown':'pass',attemptInputs:[100,110],tools,rawPath:join(originals,condition+'.json')});
  const raw=JSON.parse(f.rawText);
  raw.publication_unit_only=true;raw.authorization='Bearer '+secret;raw.apiKey=secret;
  raw.remote={bound_name:'bm-unit-private-name-11223344',bound_page_id:privateId,notes:'user file /Users/unit-person/project/input.json'};
  raw.usage={input_tokens:210,output_tokens:20};
  const bytes=canonicalJson(raw)+'\n',old=f.input.artifacts[0].sha256;
  function update(value){if(!value||typeof value!=='object')return;for(const [key,child]of Object.entries(value)){
   if(key==='sha256'&&child===old)value[key]=sha(bytes);else update(child);
  }}
  update(f.input);f.input.artifacts[0].bytes=Buffer.byteLength(bytes);await writeFile(f.input.artifacts[0].path,bytes);
  if(reportedRoute){
   const routing={mode:'fixed-route',model_variant:'synthetic-model',reported_model_ids:[reportedRoute]};
   Object.assign(f.input.identity,{model_routing:routing,model_route:reportedRoute,
    model_api:'openai-completions',model_provider:'synthetic-provider'});
   const providerRows=f.input.attempts.map(attempt=>({type:'provider_stream_event',data:{
    request_id:attempt.request_id,attempt_id:attempt.id,provider:'synthetic-provider',api:'openai-completions',
    model:reportedRoute,event:{model:reportedRoute}}}));
   const providerText=providerRows.map(JSON.stringify).join('\n')+'\n';
   const providerPath=join(originals,condition+'-reported.jsonl'),providerSha=sha(providerText);
   await writeFile(providerPath,providerText);
   f.input.artifacts.push({id:'provider-events',path:providerPath,kind:'jsonl',sha256:providerSha,bytes:Buffer.byteLength(providerText)});
   f.input.attempts.forEach((attempt,i)=>{attempt.reported_model=assessReportedModel({routing,sent:true,
    observations:[{value:reportedRoute,field:'/data/event/model',bound:true,
     ref:{artifact_id:'provider-events',sha256:providerSha,line:i+1}}]});});
  }
  const lines=[{sequence:1,type:'unit',path:'/Users/unit-person/private',secret,usage:{input_tokens:100}},{sequence:2,type:'unit',page_id:privateId,value:'kept'}];
  const text=lines.map(JSON.stringify).join('\n')+'\n',id='events-'+privateId,file=join(originals,condition+'.jsonl');
  await writeFile(file,text);f.input.artifacts.push({id,path:file,kind:'jsonl',sha256:sha(text),bytes:Buffer.byteLength(text)});
  f.input.business.refs.push({artifact_id:id,sha256:sha(text),line:2});
  episodes.push(normalizeEpisode(f.input).episode);
 }
 return {root,originals,input:{protocol,episodes},directory:join(root,'public'),redactions:{secrets:[secret]}};
}
async function addBinary(f,{bytes=markerBytes,kind='source-bytes',episodeIndex=0}={}){
 const episode=f.input.episodes[episodeIndex],path=join(f.originals,'format-marker-'+episodeIndex+'.bin');
 await writeFile(path,bytes);
 const artifact={id:'synthetic-format-marker',path,sha256:sha(bytes),bytes:bytes.length,kind};
 episode.artifacts.push(artifact);episode.episode_sha256=fingerprint({...episode,episode_sha256:null});
 return artifact;
}

async function redactedProviderFixture(){
 const f=await fixture(),route='private-route/synthetic-model',provider='private-provider-label',api='openai-completions';
 const routing={mode:'fixed-route',model_variant:'synthetic-model',reported_model_ids:[route]};
 const model=f.input.protocol.models[0];
 Object.assign(model,{provider,route,api,parameters:{maxTokens:4096},routing});
 f.input.protocol.protocol_sha256=fingerprint({...f.input.protocol,protocol_sha256:null});
 const selected={id:route,api,provider:'[REDACTED_CREDENTIAL]',baseUrl:'http://127.0.0.1:1234/v1'};
 const projection={model:selected,model_parameters:model.parameters,model_configuration:{definition:{providers:{
  [provider]:{api,baseUrl:selected.baseUrl,models:[{id:route}]},
 }}}};
 for(const episode of f.input.episodes){
  Object.assign(episode.identity,{model_id:model.id,model_provider:provider,model_route:route,model_api:api,model_routing:routing});
  const artifact=async(id,value,kind='json')=>{
   const bytes=kind==='jsonl'?value.map(canonicalJson).join('\n')+'\n':canonicalJson(value)+'\n';
   const item={id,path:join(f.originals,episode.identity.condition_id+'-'+id),kind,sha256:sha(bytes),bytes:Buffer.byteLength(bytes)};
   await writeFile(item.path,bytes);episode.artifacts.push(item);return item;
  };
  const ref=(item,pointer='')=>({artifact_id:item.id,sha256:item.sha256,pointer});
  const line=(item,index)=>({artifact_id:item.id,sha256:item.sha256,line:index+1});
  const candidate=await artifact('candidate-observed',{projection});
  const expected=await artifact('collection-provider-binding-expectation',{projection});
  const admission=await artifact('admission-comparison',{differences:[],expected_file:{sha256:expected.sha256}});
  const protocol=await artifact('collection-protocol',f.input.protocol);
  const payloads=episode.attempts.map(()=>({model:route,messages:[{role:'user',content:'Synthetic request'}]}));
  const payload=await artifact('payloads',payloads),eventRows=[],transportRows=[];
  episode.attempts.forEach((attempt,index)=>{
   attempt.transport_id=index+1;
   eventRows.push(
    {type:'model_request_start',data:{request_id:attempt.request_id,capture_only:false,model:selected}},
    {type:'http_attempt_start',data:{request_id:attempt.request_id,attempt_id:attempt.id,method:'POST',
     url_origin:'http://127.0.0.1:1234',url_path:'/v1/chat/completions'}},
    {type:'provider_stream_event',data:{request_id:attempt.request_id,attempt_id:attempt.id,
     provider:'[REDACTED_CREDENTIAL]',api,model:route,event:{model:route}}});
   transportRows.push(
    {phase:'request_start',category:'model',method:'POST',id:attempt.transport_id,
     originSha256:sha('http://127.0.0.1:1234'),pathSha256:sha('/v1/chat/completions')},
    {phase:'request_sent',id:attempt.transport_id,requestBodySha256:sha(canonicalJson(payloads[index]))},
    {phase:'request_end',id:attempt.transport_id});
  });
  const events=await artifact('events',eventRows,'jsonl'),transport=await artifact('transport',transportRows,'jsonl');
  const requests=episode.attempts.map((attempt,index)=>({id:attempt.request_id,usage_attempt_id:attempt.id,
   payload_sha256:sha(canonicalJson(payloads[index])),start_ref:line(events,index*3),payload_ref:ref(payload,'/'+index),
   attempts:[{id:attempt.id,transport_id:attempt.transport_id,start_ref:line(events,index*3+1)}]}));
  const runtime=await artifact('collection-runtime-result',{requests});
  episode.attempts.forEach((attempt,index)=>{
   const refs=[ref(candidate),ref(expected),ref(admission),ref(protocol),ref(runtime),ref(payload,'/'+index),
    ...[0,1,2].map(offset=>line(events,index*3+offset)),...[0,1,2].map(offset=>line(transport,index*3+offset))];
   attempt.provider_binding=deriveRedactedProviderBinding({event:eventRows[index*3+2],request:requests[index],attemptId:attempt.id,
    requestStart:eventRows[index*3],candidate:{projection},expected:{projection},admission:{differences:[]},
    payload:payloads[index],attemptStart:eventRows[index*3+1],transportStart:transportRows[index*3],
    transportSent:transportRows[index*3+1],transportEnd:transportRows[index*3+2],model,refs});
   assert.equal(attempt.provider_binding?.status,'known');
   attempt.reported_model=assessReportedModel({routing,sent:true,refs:attempt.refs,
    observations:[{value:route,field:'/data/event/model',bound:true,ref:line(events,index*3+2)}]});
  });
  episode.episode_sha256=fingerprint({...episode,episode_sha256:null});
 }
 return f;
}
test('redacted-provider request chains survive publication and independent replay with explicit manifest authorization',async()=>{
 const f=await redactedProviderFixture(),sourceHashes=new Map();
 for(const episode of f.input.episodes){
  assert.equal((await verifyBundle({episode},{root:f.root})).valid,true);
  for(const artifact of episode.artifacts)sourceHashes.set(artifact.path,sha(await readFile(artifact.path)));
 }
 const out=await writePublicEvidencePackage({...f,rawRoot:f.root}),episode=out.input.episodes[0];
 const events=episode.artifacts.find(item=>item.id==='events');
 const eventRows=(await readFile(join(out.directory,events.path),'utf8')).trimEnd().split('\n').map(JSON.parse);
 assert.equal(eventRows.find(row=>row.type==='http_attempt_start').data.url_path,'/v1/chat/completions');
 assert.equal(episode.attempts[0].provider_binding.status,'known');
 assert.match(episode.identity.model_provider,/^\[identity:/);
 assert.equal(out.verified.valid,true);
 await assert.rejects(()=>verifyBundle({episode},{root:out.directory}),/explicit verified manifest mapping/);
 const privateClaim=structuredClone(episode);delete privateClaim.identity.public_projection;
 privateClaim.episode_sha256=fingerprint({...privateClaim,episode_sha256:null});
 await assert.rejects(()=>verifyBundle({episode:privateClaim},{root:out.directory}),/binding differs/);
 const {stdout}=await run(process.execPath,[join(out.directory,'replay.mjs')],{timeout:15000});
 assert.equal(JSON.parse(stdout).analysis_sha256,out.analysis.analysis_sha256);
 assert.equal(JSON.parse(stdout).model_requests,0);
 for(const [path,hash] of sourceHashes)assert.equal(sha(await readFile(path)),hash);
});

test('sanitizer removes credentials and machine identity while preserving usage numbers and pointer keys',()=>{
 const s=createPublicSanitizer({redactions:{secrets:[secret]}});
 const value=s.walk({authorization:'Bearer '+secret,api_key:{nested:secret},token_v2:'not-a-public-value',encrypted_content:'opaque-provider-state',note:'file /Users/unit-person/a.txt',
  nested:'{"token":"hidden-value","input_tokens":101}',[privateId]:{total:3},pointer:'/'+privateId+'/total',
  instruction:'Globals:\n- text(value)\nA:\n- heading',usage:{input_tokens:100,output_tokens:20,cached_tokens:30},endpoint:'http://127.0.0.1:3425/v1'});
 s.assertClean(JSON.stringify(value));
 assert.deepEqual(value.usage,{input_tokens:100,output_tokens:20,cached_tokens:30});
 assert.equal(value.api_key.nested,'[REDACTED]');assert.equal(value.token_v2,'[REDACTED]');assert.equal(value.encrypted_content,'[REDACTED]');assert.equal(JSON.parse(value.nested).input_tokens,101);
 const key=value.pointer.split('/')[1];assert.equal(value[key].total,3);
 assert.ok(!value.endpoint.includes('127.0.0.1'));
});
test('observed HTTP paths preserve routing structure without exposing query credentials or filesystem fields',()=>{
 const s=createPublicSanitizer();
 const projected=s.walk({type:'http_attempt_start',data:{url_path:'/v1/chat/completions?api_key=private-value&mode=stream',
  diagnostic_path:'/private/project/config.json'},unrelated:{url_path:'/opt/private/config.json'}});
 assert.match(projected.data.url_path,/^\/v1\/chat\/completions\?/);
 assert.equal(new URL(projected.data.url_path,'https://request.invalid').searchParams.get('api_key'),'[REDACTED]');
 assert.equal(new URL(projected.data.url_path,'https://request.invalid').searchParams.get('mode'),'stream');
 assert.match(projected.data.diagnostic_path,/^\[path:/);assert.match(projected.unrelated.url_path,/^\[path:/);
 assert.ok(!JSON.stringify(projected).includes('private-value'));
 s.assertClean(JSON.stringify(projected));
});
test('public export preserves metrics, unknowns, raw line refs and original hashes with offline replay',async()=>{
 const f=await fixture(),before=scoreExperiment(f.input);
 const exported=await writePublicEvidencePackage({...f,rawRoot:f.root,analysis:before});
 assert.equal(exported.model_requests,0);assert.equal(exported.verified.valid,true);
 assert.equal(exported.analysis.conditions[0].counts.unknown,1);
 assert.deepEqual(exported.analysis.conditions.map(x=>x.counts),before.conditions.map(x=>x.counts));
 assert.equal(exported.manifest.source_analysis_sha256,before.analysis_sha256);
 assert.ok(exported.manifest.raw_mapping.every(row=>row.source_sha256&&row.public_sha256&&row.changed));
 const lineMapping=exported.manifest.raw_mapping.find(row=>row.format==='jsonl');
 const text=await readFile(join(exported.directory,lineMapping.public_path),'utf8');
 assert.equal(text.trimEnd().split('\n').length,2);assert.ok(!text.includes(privateId)&&!text.includes(secret));
 for(const row of exported.manifest.raw_mapping)assert.equal(sha(await readFile(join(exported.directory,row.public_path))),row.public_sha256);
 const {stdout}=await run(process.execPath,[join(exported.directory,'replay.mjs'),'--out',join(f.root,'replayed')],{timeout:15000});
 const replay=JSON.parse(stdout);assert.equal(replay.analysis_sha256,exported.analysis.analysis_sha256);assert.equal(replay.model_requests,0);
 const again=await writePublicEvidencePackage({...f,rawRoot:f.root});assert.equal(again.manifest_sha256,exported.manifest_sha256);
 const original=await readFile(f.input.episodes[0].artifacts[0].path,'utf8');assert.ok(original.includes(secret)&&original.includes(privateId));
});
test('reported-model evidence survives identifier projection and standalone replay',async()=>{
 const f=await fixture({reportedRoute:'private-route/synthetic-model'});
 const exported=await writePublicEvidencePackage({...f,rawRoot:f.root,
  redactions:{...f.redactions,identifier_words:['private-route']}});
 const projected=JSON.parse(await readFile(join(exported.directory,'analysis-input.json'),'utf8'));
 for(const episode of projected.episodes){
  assert.equal(episode.identity.model_routing.model_variant,'synthetic-model');
  assert.ok(!episode.identity.model_routing.reported_model_ids[0].includes('private-route'));
  for(const attempt of episode.attempts){
   assert.equal(attempt.reported_model.status,'matched');
   assert.equal(attempt.reported_model.assurance,'provider_reported_label_not_backend_attestation');
   assert.deepEqual(attempt.reported_model.reported_ids,episode.identity.model_routing.reported_model_ids);
  }
 }
 assert.ok((await readFile(join(exported.directory,'offline/benchmark/reported-model.mjs'),'utf8')).includes('assessReportedModel'));
 const {stdout}=await run(process.execPath,[join(exported.directory,'replay.mjs')],{timeout:15000});
 assert.equal(JSON.parse(stdout).model_requests,0);
});
test('changed original raw bytes cannot be laundered into a public evidence package',async()=>{
 const f=await fixture();await writeFile(f.input.episodes[0].artifacts[0].path,'changed\n');
 await assert.rejects(writePublicEvidencePackage({...f,rawRoot:f.root}),/hash|fingerprint|size/i);
});
test('public verification and replay both reject modified published raw bytes',async()=>{
 const f=await fixture(),out=await writePublicEvidencePackage({...f,rawRoot:f.root});
 const file=join(out.directory,out.manifest.raw_mapping[0].public_path);await writeFile(file,'tampered\n');
 await assert.rejects(verifyPublicEvidencePackage({directory:out.directory}),/equal|hash|size/i);
 await assert.rejects(run(process.execPath,[join(out.directory,'replay.mjs')],{timeout:15000}));
});
test('private-oracle and opaque binary inputs are refused rather than silently released',async()=>{
 for(const kind of ['private-oracle','binary','json']){
  const f=await fixture(),episode=f.input.episodes[0],bytes=kind==='binary'?Buffer.from([0xff,0xfe,0x80]):Buffer.from(kind==='json'?JSON.stringify({contracts:[{kind:'artifact-json',expected:{answer:7}}]}):'{}\n');
  const path=join(f.originals,'forbidden-'+kind);await writeFile(path,bytes);
  episode.artifacts.push({id:'forbidden',path,sha256:sha(bytes),bytes:bytes.length,kind});
  episode.episode_sha256=fingerprint({...episode,episode_sha256:null});
  await assert.rejects(writePublicEvidencePackage({...f,rawRoot:f.root}),kind==='binary'?/binary/i:/oracle/i);
 }
});

test('reviewed synthetic binary bytes retain their identity through publication and offline replay',async()=>{
 const f=await fixture({terminalOwner:'yoyo'}),artifact=await addBinary(f),before=scoreExperiment(f.input);
 assert.equal(sha(markerBytes),markerApproval.sha256);
 const out=await writePublicEvidencePackage({...f,rawRoot:f.root,analysis:before,
  reviewedBinaryArtifacts:[markerApproval],redactions:{...f.redactions,identifier_words:['yoyo'],terminal_usernames:['yoyo']}});
 assert.equal(out.manifest.publication_version,'1.0.4');
 assert.deepEqual(out.manifest.policy.reviewed_binary_artifacts,[markerApproval]);
 const row=out.manifest.raw_mapping.find(item=>item.source_sha256===artifact.sha256);
 assert.equal(row.format,'binary');assert.equal(row.changed,false);
 assert.equal(row.source_sha256,row.public_sha256);assert.equal(row.source_bytes,6);assert.equal(row.public_bytes,6);
 assert.deepEqual(await readFile(join(out.directory,row.public_path)),markerBytes);
 assert.deepEqual(await readFile(artifact.path),markerBytes);
 assert.deepEqual(out.analysis.conditions.map(x=>x.counts),before.conditions.map(x=>x.counts));
 for(const item of out.manifest.files){
  if(item.path===row.public_path)continue;
  const text=await readFile(join(out.directory,item.path),'utf8');
  for(const value of [secret,privateId,'/Users/unit-person',f.root])assert.ok(!text.includes(value),item.path);
  assert.doesNotMatch(text,/(?<![\p{L}\p{N}_-])yoyo(?![\p{L}\p{N}_-])/u,item.path);
 }
 const {stdout}=await run(process.execPath,[join(out.directory,'replay.mjs')],{timeout:15000});
 assert.equal(JSON.parse(stdout).analysis_sha256,out.analysis.analysis_sha256);assert.equal(JSON.parse(stdout).model_requests,0);
 assert.equal((await verifyPublicEvidencePackage({directory:out.directory})).valid,true);
});

test('binary publication fails closed without the exact reviewed hash, byte count, kind and purpose',async()=>{
 const cases=[
  {approved:[],error:/explicit reviewed publication policy/},
  {approved:[{...markerApproval,sha256:'0'.repeat(64)}],error:/explicit reviewed publication policy/},
  {approved:[{...markerApproval,bytes:7}],error:/byte count mismatch/},
  {approved:[markerApproval],artifact:{kind:'binary'},error:/artifact kind mismatch/},
  {approved:[markerApproval],artifact:{bytes:Buffer.from([0xff,0xfe,0x80])},error:/explicit reviewed publication policy/},
  {approved:[{...markerApproval,purpose:'private-runtime-log'}],error:/public-synthetic-fixture/},
 ];
 for(const item of cases){
  const f=await fixture();await addBinary(f,item.artifact);
  await assert.rejects(writePublicEvidencePackage({...f,rawRoot:f.root,reviewedBinaryArtifacts:item.approved}),item.error);
 }
});

test('deduplicating reviewed bytes cannot authorize a different artifact kind',async()=>{
 const f=await fixture();await addBinary(f);await addBinary(f,{episodeIndex:1,kind:'binary'});
 await assert.rejects(writePublicEvidencePackage({...f,rawRoot:f.root,reviewedBinaryArtifacts:[markerApproval]}),/artifact kind mismatch/);
});

test('public projection does not reveal an identity that was restored from a credential-redacted label',()=>{
 const binding={observed_provider:'[REDACTED_CREDENTIAL]',value:'private-provider-label'};
 const s=createPublicSanitizer({material:[binding]});
 const projected=s.walk({binding,provider:'private-provider-label'});
 assert.equal(projected.binding.value,projected.provider);assert.notEqual(projected.provider,binding.value);
 s.assertClean(JSON.stringify(projected));
});

test('whole-token and terminal-owner redaction preserve longer public repository identities',()=>{
 const listing='total 8\n-rw-r--r--@  1 yoyo staff 12 Nov 22 12:00 file.json\n';
 const s=createPublicSanitizer({redactions:{identifier_words:['private-handle']},
  material:[{home:'/Users/yoyo/project',listing}]});
 const projected=s.walk({listing,owner:'yoyo',annotation:'user=yoyo; private-handle.',
  repository:'https://github.com/yoyooyooo/example',longer:'yoyooyooo yoyo-helper',
  pointer:'/yoyo/owner',yoyo:{owner:'yoyo'}});
 assert.match(projected.listing,/\[username:[a-f0-9]{20}\]/);
 assert.equal(projected.repository,'https://github.com/yoyooyooo/example');
 assert.equal(projected.longer,'yoyooyooo yoyo-helper');
 assert.equal(projected[projected.pointer.split('/')[1]].owner,projected.owner);
 assert.ok(!projected.annotation.includes('private-handle'));
 s.assertClean(JSON.stringify(projected));
 assert.throws(()=>s.assertClean(JSON.stringify({owner:'yoyo'})),/identifier word/i);
 assert.throws(()=>s.assertClean(JSON.stringify({listing:'-rw-r--r-- 1 502 staff 3 Nov 22 file\n'})),/terminal owner/i);
 const numeric=s.text('-rw-r--r-- 1 502 staff 3 Nov 22 file\n');
 s.assertClean(numeric);assert.match(numeric,/\[username:/);
});

test('terminal user redaction propagates through normalized results and raw artifacts with new hashes and replay',async()=>{
 const f=await fixture({terminalOwner:'yoyo'}),before=scoreExperiment(f.input);
 const originalResult=f.input.episodes[0].tools[0].result;
 assert.match(originalResult.content[0].text,/\byoyo\b/);
 const exported=await writePublicEvidencePackage({...f,rawRoot:f.root,
  redactions:{...f.redactions,identifier_words:['yoyo'],terminal_usernames:['yoyo']}});
 const projected=exported.input.episodes[0].tools[0].result;
 assert.doesNotMatch(projected.content[0].text,/(?<![\p{L}\p{N}_-])yoyo(?![\p{L}\p{N}_-])/u);
 assert.equal(projected.content[0].text,projected.structuredContent.output);
 assert.match(projected.content[0].text,/yoyooyooo/);
 assert.deepEqual(exported.analysis.conditions.map(x=>x.counts),before.conditions.map(x=>x.counts));
 assert.equal(exported.manifest.publication_version,'1.0.4');
 assert.ok(exported.manifest.policy.terminal_username_count>0);
 const rawArtifact=f.input.episodes[0].artifacts[0];
 const mapping=exported.manifest.raw_mapping.find(row=>row.source_sha256===rawArtifact.sha256);
 assert.ok(mapping.changed);assert.notEqual(mapping.public_sha256,mapping.source_sha256);
 const raw=JSON.parse(await readFile(join(exported.directory,mapping.public_path),'utf8'));
 assert.equal(raw.tools[0].result.content[0].text,projected.content[0].text);
 assert.equal(raw.tools[0].result.structuredContent.output,projected.structuredContent.output);
 for(const item of exported.manifest.files){
  const bytes=await readFile(join(exported.directory,item.path));
  assert.equal(sha(bytes),item.sha256);
  assert.doesNotMatch(bytes.toString('utf8'),/(?<![\p{L}\p{N}_-])yoyo(?![\p{L}\p{N}_-])/u,item.path);
 }
 const {stdout}=await run(process.execPath,[join(exported.directory,'replay.mjs')],{timeout:15000});
 assert.equal(JSON.parse(stdout).analysis_sha256,exported.analysis.analysis_sha256);
 assert.match(await readFile(rawArtifact.path,'utf8'),/\byoyo\b/);
});
