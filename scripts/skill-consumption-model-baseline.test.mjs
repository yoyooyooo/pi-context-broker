import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { comparisonCatalog, modelBaselineHostArgs, modelBaselineSource, modelBaselineTools, observeNativeInspection,
  summarizeNativeSource, validateModelBaselineConfig, verifyComparisonCatalog, verifyNativeInspectionEvents,
  summarizeSource, verifyModelAnswer } from './skill-consumption-model-baseline.mjs';

test('ordinary task acceptance rejects permission-only replies containing the expected answer', () => {
  assert.equal(verifyModelAnswer({ stopReason: 'stop', text: '请先确认授权，我才能回答 12 加 7 是否等于 19。' }, ['19', '十九']), false);
  assert.equal(verifyModelAnswer({ stopReason: 'stop', text: 'I need your approval to answer whether the result is 19.' }, ['19']), false);
  assert.equal(verifyModelAnswer({ stopReason: 'stop', text: '12 加 7 等于 19。' }, ['19', '十九']), true);
});

test('a truncated, aborted, empty or wrong final answer cannot pass a cost sample', () => {
  for (const stopReason of ['length', 'aborted', 'error', 'toolUse', undefined]) {
    assert.equal(verifyModelAnswer({ stopReason, text: '19' }, ['19']), false);
  }
  assert.equal(verifyModelAnswer({ stopReason: 'stop', text: '   ' }, ['19']), false);
  assert.equal(verifyModelAnswer({ stopReason: 'stop', text: '20' }, ['19']), false);
});

const hostClosed = [{ event: 'spawn', pid: 123 }, { event: 'close', pid: 123, observedExit: true }];
const completedSource = id => [
  { phase: 'started', requestId: id },
  { phase: 'metrics', requestId: id, observed: true, complete: true },
  { phase: 'completed', requestId: id },
];

test('an empty source ledger or missing host lifecycle is unknown, not complete zero cost', () => {
  const empty = summarizeSource([], { beforeCloseRequestIds: [], ownedLifecycle: hostClosed });
  assert.equal(empty.complete, false);
  assert.equal(empty.observedHttpAttempts, 0);
  assert.equal(empty.httpAttempts, null);
  assert.equal(empty.decodedResponseBytes, null);
  assert.equal(summarizeSource(completedSource('a'), { beforeCloseRequestIds: ['a'] }).complete, false);
  const observed = summarizeSource(completedSource('a'), { beforeCloseRequestIds: ['a'], ownedLifecycle: hostClosed });
  assert.equal(observed.complete, true);
  assert.equal(observed.httpAttempts, 0);
  assert.match(observed.completenessScope, /not a metadata-producer terminal/);
});

test('late source starts and missing or duplicated closes invalidate final reconciliation', () => {
  const boundary = { beforeCloseRequestIds: ['a'], ownedLifecycle: hostClosed };
  const late = summarizeSource([...completedSource('a'), ...completedSource('b')], boundary);
  assert.equal(late.complete, false);
  assert.deepEqual(late.lateStarts, ['b']);
  assert.equal(late.httpAttempts, null);
  assert.equal(summarizeSource(completedSource('a').slice(0, -1), boundary).complete, false);
  assert.equal(summarizeSource([...completedSource('a'), { phase: 'completed', requestId: 'a' }], boundary).complete, false);
});

test('SDK mode requires an absent command and emits the unchanged default source; legacy CLI remains explicit', () => {
  const config = { version: 1, extension: '/fixture/index.mjs', database: '12345678-1234-1234-1234-123456789012',
    prompt: '12 加 7 是多少？', expectedAnswers: ['19'], counts: { cold: 5, warm: 20 } };
  const sdk = { ...config, transport: 'sdk' }, before = JSON.stringify(sdk);
  assert.equal(validateModelBaselineConfig(sdk), sdk);
  const source = modelBaselineSource(sdk, { cacheDir: '/fixture/cache' });
  assert.equal(Object.hasOwn(source, 'command'), false); assert.equal(source.prefetch, false);
  assert.equal(JSON.stringify(sdk), before);
  for (const command of [undefined, null, [], ['/node', '/cli']]) assert.throws(() => validateModelBaselineConfig({ ...sdk, command }), /omit command/);
  assert.throws(() => modelBaselineSource(sdk, { command: ['/wrapper'] }), /must not install a source wrapper/);
  const legacy = { ...config, command: ['/node', '/cli'] };
  assert.equal(validateModelBaselineConfig(legacy), legacy);
  assert.deepEqual(modelBaselineSource(legacy, { command: ['/ledger', '/config'] }).command, ['/ledger', '/config']);
  assert.throws(() => validateModelBaselineConfig(config));
  assert.throws(() => validateModelBaselineConfig({ ...legacy, transport: 'alternate' }));
  assert.throws(() => validateModelBaselineConfig({ ...sdk, model: 'another-provider/model' }));
});

test('native Skill profiling preserves every original tool and rejects undeclared or narrowed profiles', () => {
  const config={version:1,extension:'/fixture/index.mjs',transport:'sdk',database:'12345678-1234-1234-1234-123456789012',
    prompt:'Use the public preparation entry and explain the selected Skill.',expectedAnswers:['doctor'],counts:{cold:1,warm:1}};
  const standard=['read','bash','edit','write','grep','find','ls'];
  assert.deepEqual(modelBaselineTools(config),standard);
  assert.deepEqual(modelBaselineTools({...config,toolProfile:'standard'}),standard);
  const native={...config,toolProfile:'native-skills'};
  assert.equal(validateModelBaselineConfig(native),native);
  assert.deepEqual(modelBaselineTools(native),[...standard,'notion_list','notion_use']);
  assert.deepEqual(modelBaselineTools({...config,toolProfile:'legacy-skills'}),[...standard,'skill_search','skill_prepare','skill_graph']);
  for(const toolProfile of [null,'prepare-only','native',[],{tools:['skill_prepare']}])
    assert.throws(()=>validateModelBaselineConfig({...config,toolProfile}),/Unsupported model tool profile/);
  assert.throws(()=>validateModelBaselineConfig({...native,tools:['skill_prepare']}));
  assert.deepEqual(modelBaselineTools(config),standard);
});

test('SDK, CLI and HTTP counts stay distinct; missing, late and unmatched observations cannot prove zero cost', () => {
  const operation = (id, kind, attempts) => [
    { phase: 'started', requestId: id, kind },
    ...Array.from({ length: attempts }, (_, index) => ({ phase: 'attempt', kind: 'http', requestId: id, attempt: index + 1,
      request_kind: kind === 'sdk' ? 'notion_body' : 'notion_metadata', request_bytes: 3, response_bytes: 7 })),
    { phase: 'metrics', requestId: id, observed: true, complete: true },
    { phase: 'completed', requestId: id, kind, sdkStarted: kind === 'sdk' },
  ];
  const sdk = operation('sdk', 'sdk', 2), cli = operation('cli', 'cli', 1), ledger = [...cli, ...sdk];
  const options = { transport: 'sdk', sourceObservation: { complete: true, errors: [] }, ownedLifecycle: hostClosed, beforeCloseRequestIds: ['cli', 'sdk'] };
  const value = summarizeSource(ledger, options);
  assert.equal(value.complete, true); assert.equal(value.sdkStarts, 1); assert.equal(value.cliStarts, 1); assert.equal(value.httpAttempts, 3);
  assert.equal(value.sdkEntered, 1); assert.equal(value.decodedResponseBytes, 21); assert.equal(value.wireBytes, null);
  assert.equal(summarizeSource(sdk, { ...options, beforeCloseRequestIds: ['sdk'] }).httpAttempts, 2);
  const zero = summarizeSource(operation('sdk', 'sdk', 0), { ...options, beforeCloseRequestIds: ['sdk'] });
  assert.equal(zero.cliStarts, 0); assert.equal(zero.httpAttempts, 0);
  for (const [rows, changed] of [
    [[], { beforeCloseRequestIds: [] }],
    [sdk.filter(row => row.phase !== 'metrics'), { beforeCloseRequestIds: ['sdk'] }],
    [ledger, { sourceObservation: { complete: false, errors: ['missing-end-boundary'] } }],
    [ledger, { beforeCloseRequestIds: [] }],
    [[...ledger, { phase: 'unmatched_child_start' }], {}],
  ]) {
    const result = summarizeSource(rows, { ...options, ...changed });
    assert.equal(result.complete, false); assert.equal(result.httpAttempts, null); assert.equal(result.decodedResponseBytes, null);
  }
});

test('a closed unknown child proves its direct lifecycle only; total source and descendant network cost remain unknown', () => {
  const childId='child:123:1', childLifecycle={version:1,starts:1,spawns:1,exits:1,closes:1,errors:0,pendingChildIds:[],complete:true,descendants:'unobserved'};
  const ledger=[...completedSource('a'),{phase:'unmatched_child_start',childId,parentPid:123},
    {phase:'unmatched_child_spawn',childId,parentPid:123,childPid:456},
    {phase:'unmatched_child_exit',childId,parentPid:123,childPid:456,code:0,signal:null},
    {phase:'unmatched_child_close',childId,parentPid:123,childPid:456,code:0,signal:null}];
  const options={transport:'sdk',sourceObservation:{complete:true,errors:[],unmatchedChildLifecycle:childLifecycle},
    ownedLifecycle:hostClosed,beforeCloseRequestIds:['a'],beforeCloseChildIds:[childId]};
  const actual=summarizeSource(ledger,options);
  assert.equal(actual.sourceObserverComplete,true); assert.deepEqual(actual.unmatchedChildLifecycle,childLifecycle);
  assert.equal(actual.complete,false); assert.equal(actual.unmatchedChildren,1); assert.equal(actual.observedHttpAttempts,0);
  assert.equal(actual.httpAttempts,null); assert.equal(actual.requestBodyBytes,null); assert.equal(actual.decodedResponseBytes,null);
  assert.deepEqual(actual.lateChildStarts,[]);
  const late=summarizeSource(ledger,{...options,beforeCloseChildIds:[]});
  assert.deepEqual(late.lateChildStarts,[childId]); assert.equal(late.complete,false);
  const legacy=summarizeSource([...completedSource('a'),{phase:'unmatched_child_start'}],
    {...options,sourceObservation:{complete:true,errors:[]},beforeCloseChildIds:undefined});
  assert.equal(legacy.unmatchedChildLifecycle,null); assert.equal(legacy.complete,false); assert.equal(legacy.httpAttempts,null);
});

test('a pure Pi native local comparison accepts no Broker runtime, source command or product tools', () => {
  const native = { version: 1, role: 'pi-native-local', comparison: '/frozen/comparison.json',
    prompt: 'Inspect the selected Skill and its reference.', expectedAnswers: ['reference'], counts: { cold: 1, warm: 1 } };
  assert.equal(validateModelBaselineConfig(native), native);
  assert.deepEqual(modelBaselineTools(native), ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
  for (const [key, value] of Object.entries({ extension: '/broker/index.ts', transport: 'sdk', command: ['/node', '/cli'],
    database: '12345678-1234-1234-1234-123456789012', packagePath: '/broker.tgz', toolProfile: 'native-skills' }))
    assert.throws(() => validateModelBaselineConfig({ ...native, [key]: value }));
  assert.throws(() => validateModelBaselineConfig({ ...native, comparison: undefined }));
  assert.throws(() => validateModelBaselineConfig({ ...native, role: 'local-via-broker' }));
});

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const nativeFiles = [
  {path:'SKILL.md',absolutePath:'/frozen/reader/SKILL.md',body:'Main Skill instructions.\nRead references/check.md.\n'},
  {path:'references/check.md',absolutePath:'/frozen/reader/references/check.md',body:'Complete fixed resource.\nSecond line.\n'},
].map(file=>({...file,sha256:digest(file.body),bytes:Buffer.byteLength(file.body)}));
const nativeMetadata = [{name:'reader',description:'Inspect fixed files.',filePath:nativeFiles[0].absolutePath}];
const nativeSystem = '<available_skills><skill><name>reader</name><description>Inspect fixed files.</description><location>/frozen/reader/SKILL.md</location></skill></available_skills>';
const notionSystem = '<ntn-skills-view-catalog><view source="notion" id="view" database="db">Ready</view><available_skills><skill><name>reader</name><description>Inspect fixed files.</description><location>sr:C'+'a'.repeat(22)+'</location></skill></available_skills></ntn-skills-view-catalog>';
function nativeProbe(overrides={}) {
  const lines=[],hooks=new Map(),channels=new Map();
  let failWrites=false;
  const api={on:(name,handler)=>hooks.set(name,[...(hooks.get(name)??[]),handler])};
  const files=nativeFiles.map(({body,...file})=>file);
  const handle=observeNativeInspection(api,{crypto,path,files,catalog:nativeMetadata,output:'/private/native.jsonl',clockId:'native-test',
    fs:{constants:{O_CREAT:1,O_EXCL:2,O_WRONLY:4},openSync:()=>1,writeSync:(_fd,line)=>{if(failWrites)throw new Error('EVIDENCE_WRITE_FAILED');lines.push(line);},closeSync:()=>{}},
    diagnostics:{subscribe:(name,handler)=>channels.set(name,handler),unsubscribe:name=>channels.delete(name)},...overrides});
  const fire=(name,event={})=>{for(const handler of hooks.get(name)??[])assert.equal(handler(event),undefined,'The passive observer must not transform an event');};
  const read=(file,id='call-'+file.path,{pathname=file.absolutePath,content=file.body,isError=false,details}={})=>{
    fire('tool_call',{toolName:'read',toolCallId:id,input:{path:pathname}});
    fire('tool_result',{toolName:'read',toolCallId:id,content:[{type:'text',text:content}],isError,details});
  };
  const provider=(messages,extra={})=>fire('before_provider_request',{payload:{model:'controlled',messages:[{role:'system',content:nativeSystem},...messages],tools:[{type:'function',function:{name:'read',parameters:{type:'object'}}}],...extra}});
  fire('input');
  return {fire,read,provider,channels,failWrites:value=>{failWrites=value;},finish:handle.finish,events:()=>lines.map(line=>JSON.parse(line))};
}

test('the frozen comparison uses actual system catalog names, descriptions and exact entries', () => {
  const actual=comparisonCatalog({messages:[{role:'system',content:notionSystem}]});
  verifyComparisonCatalog(nativeMetadata.map(row=>({...row,disableModelInvocation:false})),actual);
  for(const text of [notionSystem.replace('<name>reader</name>','<name>notion-reader</name>'),
    notionSystem.replace('Inspect fixed files.','Another description.')])
    assert.throws(()=>verifyComparisonCatalog(nativeMetadata.map(row=>({...row,disableModelInvocation:false})),comparisonCatalog({messages:[{role:'system',content:text}]})),/Actual candidate names\/descriptions differ/);
  assert.throws(()=>comparisonCatalog({messages:[{role:'assistant',content:notionSystem}]}),/actual ready/);
  assert.throws(()=>comparisonCatalog({messages:[{role:'system',content:notionSystem.replace('id="view"','status="pending"')}]}),/Pending or failed/);
  assert.throws(()=>comparisonCatalog({messages:[{role:'system',content:notionSystem.replace('sr:C'+'a'.repeat(22),'/private/cache/SKILL.md')}]}),/exact entry/);
  assert.throws(()=>verifyComparisonCatalog(nativeMetadata.map(row=>({...row,disableModelInvocation:true})),actual),/model-visible/);
});

test('native launch uses Pi discovery and ordinary tools without loading Broker', () => {
  const config={role:'pi-native-local'},options={base:'/owned',observer:'/owned/cost.mjs',transport:'/owned/transport.mjs',inspection:'/owned/inspection.mjs',comparison:{directory:'/frozen/reader'}};
  const args=modelBaselineHostArgs(config,options);
  assert.ok(args.includes('--no-extensions')&&args.includes('--no-skills'));
  assert.equal(args[args.indexOf('--skill')+1],'/frozen/reader');
  assert.equal(args[args.indexOf('--tools')+1],'read,bash,edit,write,grep,find,ls');
  assert.deepEqual(args.filter((_value,index)=>args[index-1]==='-e'),[options.transport,options.observer,options.inspection]);
  assert.throws(()=>modelBaselineSource(config),/no Broker source/);
  assert.throws(()=>modelBaselineHostArgs(config,{...options,comparison:null}),/verified frozen/);
  const source=modelBaselineSource({transport:'sdk',database:'db'},{cacheDir:'/cache',viewId:'actual-view'});
  assert.equal(source.default_view_id,'actual-view'); assert.equal(Object.hasOwn(source,'command'),false);
});

test('the public Doctor resolves the actual installed Pi bundled CLI and native discovery module', {timeout:30000}, async t => {
  const host=await resolveHost('pi');
  const base=await mkdtemp(path.join(tmpdir(),'model-baseline-doctor-'));
  // Only the comparison's source/selection are controlled fixtures. The public
  // Doctor, PATH resolution, installed Pi package and loadSkills are unmocked.
  const directory=path.join(base,'reader');await mkdir(path.join(directory,'references'),{recursive:true});
  const sourceFiles=[{path:'SKILL.md',body:'---\nname: reader\ndescription: Inspect fixed files.\n---\nRead references/check.md.\n'},
    {path:'references/check.md',body:'Complete fixed reference.\n'}];
  for(const file of sourceFiles)await writeFile(path.join(directory,file.path),file.body);
  const record={id:'shared_skill:fixture:reader',kind:'skill',name:'reader',description:'Inspect fixed files.',ref:'skill://reader/SKILL.md'};
  const write=async(name,value)=>{const target=path.join(base,name),bytes=JSON.stringify(value);await writeFile(target,bytes);return{path:target,sha256:digest(bytes)};};
  const source=await write('source.json',{transport:'sdk',operation:'list',status:'completed',resultObserved:true,
    value:{scope:'a'.repeat(64),records:[record],count:1,coverage:{exhaustive:true,search_index_limited:false,failed_sources:[]}}});
  const payload=await write('payload.json',{messages:[{role:'system',content:notionSystem}]});
  const selection=await write('selection.json',{kind:'installed-pi-selection-preflight',status:'passed',sourceMode:'sdk',
    bodyRequests:0,realModelRequests:0,processesClosed:true,defaultDiscovery:{status:'passed',catalog:{status:'ready'}},
    evidence:base,files:['source.json','payload.json'],record,viewId:'controlled-view',setupCost:{kind:'controlled-fixture',httpAttempts:0}});
  const manifest=await write('manifest.json',{complete:true,record,entrypoint:'SKILL.md',scope:'a'.repeat(64),snapshot_id:'s_'+'b'.repeat(64),version_id:'c'.repeat(64),
    files:sourceFiles.map(({path,body})=>({path,bytes:Buffer.byteLength(body),sha256:digest(body)}))});
  const config={version:1,role:'pi-native-local',comparison:path.join(base,'comparison.json'),prompt:'Inspect the reader Skill and its reference.',expectedAnswers:['reference'],counts:{cold:1,warm:1}};
  await write('comparison.json',{version:1,roles:['previous-broker','notion-candidate','pi-native-local'],intent:'inspect',entry:'read',model:'magpie/group/flash-free',
    promptSha256:digest(config.prompt),expectedAnswersSha256:digest(JSON.stringify(config.expectedAnswers)),counts:config.counts,
    notionSelection:selection,notionProviderPayload:payload,notionCatalogSource:source,manifest,directory,requiredResources:['references/check.md']});
  const configFile=await write('config.json',config);
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./skill-consumption-model-baseline.mjs',import.meta.url)),'doctor','--config',configFile.path],
    {encoding:'utf8',env:process.env,timeout:20000});
  await write('doctor-result.json',{host,status:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr});
  t.diagnostic('Controlled-input, installed-Pi public Doctor evidence: '+base);
  assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(result.stdout);
  assert.equal(output.status,'ready');assert.equal(output.piIdentity,host.identity);assert.equal(output.sourceTransport,'pi-native-local');
  assert.match(output.comparison.nativeLoader.path,/\/dist\/core\/skills\.js$/);
  await access(output.comparison.nativeLoader.path);
  assert.equal(output.comparison.nativeLoader.sha256,digest(await readFile(output.comparison.nativeLoader.path)));
  assert.equal(output.runtimeDirectory,path.dirname(path.dirname(output.comparison.nativeLoader.path)));
  assert.equal(output.authentication,'not-probed');assert.equal(output.extension,null);assert.equal(output.cliSha256,null);
  assert.deepEqual(output.comparison.catalog.map(({name,description})=>({name,description})),[{name:'reader',description:'Inspect fixed files.'}]);
});

test('native delivery binds each full read to the same actual outer provider tool output', () => {
  const probe=nativeProbe();nativeFiles.forEach(file=>probe.read(file));
  probe.provider(nativeFiles.map(file=>({role:'tool',tool_call_id:'call-'+file.path,content:file.body})));
  probe.finish();const events=verifyNativeInspectionEvents(probe.events()),request=events.find(event=>event.phase==='native_provider');
  assert.equal(request.catalogMatches,true);assert.equal(request.brokerAbsent,true);
  assert.deepEqual(request.files.map(file=>file.path),nativeFiles.map(file=>file.path));
  assert.ok(request.files.every(file=>file.span.start===0&&file.span.end>0&&file.span.encoding==='raw'));
  const source=summarizeNativeSource(events,[{phase:'transport_end',complete:true}],hostClosed,nativeFiles);
  assert.equal(source.complete,true);assert.equal(source.httpAttempts,0);assert.equal(source.sdkStarts,0);
  assert.equal(source.nativeFileReadResults,2);assert.equal(source.nativeFileReadBytes,nativeFiles.reduce((total,file)=>total+file.bytes,0));
  assert.equal(source.filesystemSyscalls,null);
});

test('partial, wrong-owner path, failed, details-only and mismatched outer tool outputs do not prove native delivery', () => {
  for(const scenario of ['partial','wrong-path','failed','details-only','wrong-call','assistant-only','arguments-only']) {
    const probe=nativeProbe(),file=nativeFiles[0],id='native-call';
    probe.read(file,id,scenario==='partial'?{content:file.body.slice(0,-1)}:scenario==='wrong-path'?{pathname:'/another-owner/SKILL.md'}:
      scenario==='failed'?{isError:true}:scenario==='details-only'?{content:'ready',details:{content:file.body}}:{});
    const output=scenario==='assistant-only'?{role:'assistant',content:file.body}:scenario==='arguments-only'?
      {role:'assistant',content:'',tool_calls:[{id,type:'function',function:{name:'read',arguments:JSON.stringify({body:file.body})}}]}:
      {role:'tool',tool_call_id:scenario==='wrong-call'?'other-call':id,content:file.body};
    probe.provider([output]);probe.finish();
    assert.equal(probe.events().find(event=>event.phase==='native_provider').files.length,0,scenario);
  }
});

test('absence, truncation and tampering of native evidence remain unknown instead of zero source cost', () => {
  const probe=nativeProbe();probe.read(nativeFiles[0]);probe.provider([{role:'tool',tool_call_id:'call-SKILL.md',content:nativeFiles[0].body}]);probe.finish();
  const good=probe.events(),changed=structuredClone(good);changed[1].path='forged';
  assert.throws(()=>verifyNativeInspectionEvents(changed),/hash chain/);
  for(const events of [[],good.slice(0,-1),changed]) {
    const source=summarizeNativeSource(events,[{phase:'transport_end',complete:true}],hostClosed,nativeFiles);
    assert.equal(source.complete,false);assert.equal(source.httpAttempts,null);assert.equal(source.requestBodyBytes,null);
  }
  assert.equal(summarizeNativeSource(good,[],hostClosed,nativeFiles).complete,false);
  assert.equal(summarizeNativeSource(good,[{phase:'transport_end',complete:true}],[],nativeFiles).complete,false);
});

test('SDK operations, closed unknown children, non-model HTTP and Broker schema or guidance invalidate native zero-cost claims', () => {
  for(const scenario of ['sdk','child','http','tool-schema','guidance','catalog']) {
    const probe=nativeProbe();probe.read(nativeFiles[0]);
    if(scenario==='sdk')probe.channels.get('context-broker.notion-sdk')({event:'start'});
    if(scenario==='child')probe.channels.get('tracing:child_process.spawn:start')({process:{once:(_event,callback)=>callback(0,null)}});
    const extra=scenario==='tool-schema'?{tools:[{function:{name:'notion_use'}}]}:scenario==='guidance'?
      {messages:[{role:'system',content:nativeSystem+'<ntn-skills-guidance>Loaded</ntn-skills-guidance>'}]}:scenario==='catalog'?
      {messages:[{role:'system',content:nativeSystem.replace('<name>reader</name>','<name>replacement</name>')}]}:{};
    probe.provider([{role:'tool',tool_call_id:'call-SKILL.md',content:nativeFiles[0].body}],extra);probe.finish();
    const transport=[...(scenario==='http'?[{phase:'request_start',category:'other'}]:[]),{phase:'transport_end',complete:true}];
    const source=summarizeNativeSource(probe.events(),transport,hostClosed,nativeFiles);
    assert.equal(source.complete,false,scenario);assert.equal(source.httpAttempts,null,scenario);
  }
});

test('identical bytes in different native files retain distinct path identities', () => {
  const duplicate={...nativeFiles[1],body:nativeFiles[0].body,sha256:nativeFiles[0].sha256,bytes:nativeFiles[0].bytes};
  const probe=nativeProbe({files:[nativeFiles[0],duplicate].map(({body,...file})=>file)});
  probe.read(nativeFiles[0]);probe.provider([{role:'tool',tool_call_id:'call-SKILL.md',content:nativeFiles[0].body}]);probe.finish();
  const observed=probe.events().find(event=>event.phase==='native_provider').files;
  assert.deepEqual(observed.map(file=>file.path),['SKILL.md']);
  assert.equal(observed.some(file=>file.path===duplicate.path),false,'A main read cannot stand in for a same-byte resource read');
});

const fixedSource={scope:'a'.repeat(64),recordId:'shared_skill:library-fixed:reader',snapshotId:'s_'+'b'.repeat(64),versionId:'c'.repeat(64),entrypoint:'SKILL.md'};
const boundFiles=nativeFiles.map((file,index)=>({...file,fileId:'file-'+index}));
const fixedRef=file=>'skill://'+encodeURIComponent(fixedSource.recordId)+'/'+file.path+'?snapshot='+fixedSource.snapshotId+'&file_id='+file.fileId;
const scalarResourceProof=(file,id)=>({version:1,toolCallId:id,id:fixedSource.recordId,scope:fixedSource.scope,
  snapshot_id:fixedSource.snapshotId,version_id:fixedSource.versionId,ref:fixedRef(file),path:file.path,file_id:file.fileId,
  bytes:file.bytes,sha256:file.sha256,loaded:false,delivered_complete_text:true});

test('the common Notion inspect arm binds main and scalar resource receipts to the frozen scope, owner, pin and File ID', () => {
  const probe=nativeProbe({source:fixedSource,files:boundFiles.map(({body,...file})=>file)}),main=boundFiles[0],resource=boundFiles[1];
  const content=main.body+'\n\n<skill-directory>fixed metadata</skill-directory>';
  const proof={version:3,toolCallId:'main',snapshotId:fixedSource.snapshotId,contentIdentity:JSON.stringify([fixedSource.scope,fixedSource.recordId]),
    bodySha256:main.sha256,bytes:main.bytes,delivery:{start:0,end:main.body.length,encoding:'raw'},
    binding:{scope:fixedSource.scope,record:{id:fixedSource.recordId,entrypoint:'SKILL.md'},snapshot_id:fixedSource.snapshotId,
      version_id:fixedSource.versionId,body_sha256:main.sha256,ref:fixedRef(main)}};
  probe.read(main,'main',{pathname:'sr:C'+'m'.repeat(22),content,details:{contextBrokerRead:proof}});
  probe.read(resource,'resource',{pathname:'sr:R'+'r'.repeat(22),details:{contextBrokerResource:scalarResourceProof(resource,'resource')}});
  probe.provider([{role:'tool',tool_call_id:'main',content},{role:'tool',tool_call_id:'resource',content:resource.body}]);probe.finish();
  assert.deepEqual(probe.events().find(event=>event.phase==='native_provider').files.map(file=>file.path),boundFiles.map(file=>file.path));
  for(const [field,value] of [['scope','d'.repeat(64)],['id','another-owner'],['snapshot_id','s_'+'e'.repeat(64)],
    ['version_id','f'.repeat(64)],['file_id','another-file'],['path','another.md'],['toolCallId','other-call']]) {
    const denied=nativeProbe({source:fixedSource,files:boundFiles.map(({body,...file})=>file)});
    denied.read(resource,'resource',{pathname:'sr:R'+'r'.repeat(22),details:{contextBrokerResource:{...scalarResourceProof(resource,'resource'),[field]:value}}});
    denied.provider([{role:'tool',tool_call_id:'resource',content:resource.body}]);denied.finish();
    assert.equal(denied.events().find(event=>event.phase==='native_provider').files.length,0,field);
  }
});

test('Notion batch inspection reuses the real projection validator and preserves one outer call with full per-file spans', async () => {
  const hooks=registerHooks({resolve(specifier,context,next){return next(specifier==='./native-reference'&&context.parentURL?.endsWith('/resource-read-projection.ts')?specifier+'.ts':specifier,context);}});
  let module;
  try{module=await import('../packages/context-broker/src/resource-read-projection.ts');}finally{hooks.deregister();}
  const file=boundFiles[1],id='one-outer-batch';
  const result=module.compileResourceRead({toolCallId:id,batch:{selection:{scope:fixedSource.scope,owner:fixedSource.recordId,snapshot_id:fixedSource.snapshotId,version_id:fixedSource.versionId},
    files:[{requested_ref:fixedRef(file),ref:fixedRef(file),file_id:file.fileId,path:file.path,bytes:file.bytes,sha256:file.sha256,encoding:'utf8',content:file.body}]},
    modelRefs:['sr:R'+'r'.repeat(22)],maxContextBytes:10000});
  const content=result.content.map(part=>part.text).join('\n');
  for(const scenario of ['complete','partial-output','wrong-owner','details-only','nested']) {
    const probe=nativeProbe({source:fixedSource,files:boundFiles.map(({body,...file})=>file),validateResourceReadProjection:module.validateResourceReadProjection});
    const details=structuredClone(result.details);
    if(scenario==='wrong-owner')details.contextBrokerResource.selection.owner='another-owner';
    probe.fire('tool_call',{toolName:'read',toolCallId:id,input:{paths:['sr:R'+'r'.repeat(22)]}});
    probe.fire('tool_result',{toolName:'read',toolCallId:id,content:scenario==='details-only'?[{type:'text',text:'ready'}]:result.content,details,
      ...(scenario==='nested'?{parentToolCallId:'code-mode'}:{})});
    probe.provider([{role:'tool',tool_call_id:id,content:scenario==='partial-output'?file.body:content}]);probe.finish();
    const observed=probe.events().find(event=>event.phase==='native_provider').files;
    assert.equal(observed.length,scenario==='complete'?1:0,scenario);
    if(scenario==='complete'){assert.equal(observed[0].toolCallIdSha256,digest(id));assert.equal(observed[0].span.encoding,'json');assert.equal(observed[0].path,file.path);}
  }
});

test('native evidence write failure cannot change a tool result or fabricate a complete trace', () => {
  const probe=nativeProbe(),file=nativeFiles[0];
  probe.fire('tool_call',{toolName:'read',toolCallId:'unchanged',input:{path:file.absolutePath}});
  const event={toolName:'read',toolCallId:'unchanged',content:[{type:'text',text:file.body}]},before=structuredClone(event);
  probe.failWrites(true);assert.doesNotThrow(()=>probe.fire('tool_result',event));
  assert.deepEqual(event,before);probe.failWrites(false);probe.finish();
  assert.equal(probe.events().at(-1).complete,false);
  assert.equal(summarizeNativeSource(probe.events(),[{phase:'transport_end',complete:true}],hostClosed,nativeFiles).httpAttempts,null);
});
