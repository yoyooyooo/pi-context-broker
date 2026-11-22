import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeEpisode} from './evidence/normalize.mjs';
import {verifyBundle,writeEvidenceBundle,readEvidenceBundle,buildEvidenceIndex,queryEvidenceIndex,inventoryLegacyEvidence,resolveEvidenceRef} from './evidence/store.mjs';
import {exampleEnvelope,exampleEpisode} from './analysis/fixtures.mjs';

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
