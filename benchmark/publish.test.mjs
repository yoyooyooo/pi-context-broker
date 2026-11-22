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

const run=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const privateId='4205636c-236e-8110-9a1a-ce92cfb83ee0',secret='synthetic-export-secret-1234567890';
const markerBytes=Buffer.from('00ff0a0d2a6d','hex');
const markerApproval={sha256:'72ee7e95938b82284a312ea248777aad5e5220a20242ccf98d103d33427fc681',
 bytes:6,kind:'source-bytes',purpose:'public-synthetic-fixture'};
async function fixture({terminalOwner}={}){
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
 assert.equal(out.manifest.publication_version,'1.0.2');
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
 assert.equal(exported.manifest.publication_version,'1.0.2');
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
