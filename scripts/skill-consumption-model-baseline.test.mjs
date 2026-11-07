import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import * as baselineDriver from './skill-consumption-model-baseline.mjs';
import { comparisonCatalog, modelBaselineHostArgs, modelBaselineSource, modelBaselineTools, observeNativeInspection,
  summarizeNativeSource, validateModelBaselineConfig, verifyComparisonCatalog, verifyNativeInspectionEvents,
  summarizeSource, verifyComparisonSelection, verifyModelAnswer, verifyModelRawEvidence, readModelReviewStop,
  modelProcessTerminalFailure } from './skill-consumption-model-baseline.mjs';

const dailyRoute = { modelContract: 'daily-route-v1', model: 'magpie/group/flash', thinkingLevel: 'high', rpcTimeoutMs: 300000 };
const dailyProfile = { ...dailyRoute, controllerRetries: 0, fallback: 'forbidden',
  ownedProjectRetry: { retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } } };

test('daily route is explicit and freezes one sample per cache condition without changing legacy defaults', () => {
  const legacy = { version: 1, extension: '/fixture/index.mjs', transport: 'sdk', database: '12345678-1234-1234-1234-123456789012',
    prompt: 'Inspect the selected Skill.', expectedAnswers: ['reference'], counts: { cold: 5, warm: 20 } };
  assert.equal(validateModelBaselineConfig(legacy), legacy);
  for (const warm of [0, 1]) {
    const config = { ...legacy, ...dailyRoute, counts: { cold: 1, warm } };
    assert.equal(validateModelBaselineConfig(config), config);
  }
  for (const changed of [{ modelContract: 'unknown' }, { model: 'magpie/group/flash-free' }, { thinkingLevel: 'medium' },
    { rpcTimeoutMs: 120000 }, { counts: { cold: 2, warm: 0 } }, { counts: { cold: 1, warm: 2 } }, { controllerRetries: 1 }])
    assert.throws(() => validateModelBaselineConfig({ ...legacy, ...dailyRoute, counts: { cold: 1, warm: 0 }, ...changed }));
  for (const key of Object.keys(dailyRoute)) {
    const config = { ...legacy, ...dailyRoute, counts: { cold: 1, warm: 0 } }; delete config[key];
    assert.throws(() => validateModelBaselineConfig(config), key);
  }
  assert.throws(() => validateModelBaselineConfig({ ...legacy, counts: { cold: 1, warm: 0 } }), 'Legacy warm minimum stays unchanged');
  assert.throws(() => validateModelBaselineConfig({ ...legacy, model: dailyRoute.model }), 'A model arg alone cannot select a contract');
});

test('daily route host args select the frozen model and high thinking while legacy args stay unchanged', () => {
  const options = { base: '/owned', observer: '/owned/cost.mjs', transport: '/owned/transport.mjs' };
  const config = { extension: '/fixture/index.mjs' };
  const legacy = modelBaselineHostArgs(config, options), daily = modelBaselineHostArgs({ ...config, ...dailyRoute }, options);
  assert.deepEqual(legacy.slice(-2), ['--model', 'magpie/group/flash-free']);
  assert.equal(legacy.includes('--thinking'), false);
  assert.deepEqual(daily.slice(-4), ['--model', 'magpie/group/flash', '--thinking', 'high']);
  assert.deepEqual(daily.slice(0, -4), legacy.slice(0, -2));
});

test('metadata selection keeps one controlled model and no daily thinking or real-model contract', () => {
  assert.equal(typeof baselineDriver.modelBaselineSelectionArgs, 'function');
  const args = baselineDriver.modelBaselineSelectionArgs({ extension: '/fixture/index.mjs', ...dailyRoute }, {
    base: '/owned', observer: '/owned/cost.mjs', transport: '/owned/transport.mjs',
    provider: '/owned/provider.mjs', controlledModel: 'catalog-controlled/catalog',
  });
  assert.equal(args.filter(value => value === '--model').length, 1);
  assert.equal(args[args.indexOf('--model') + 1], 'catalog-controlled/catalog');
  assert.equal(args.includes('--thinking'), false); assert.equal(args.includes(dailyRoute.model), false);
  assert.ok(args.includes('/owned/provider.mjs'));
});

function dailyEvidenceFixture() {
  const sample = { turn: 2, submitNs: '10', completeNs: '100' }, payload = { sha256: digest('wire'), bytes: 4 };
  const events = [{ phase: 'provider_request', turn: 2, request: 3, provider: 'magpie', model: 'group/flash',
    requestModel: 'group/flash', reasoningEffort: 'high', payload },
  { phase: 'message_end', turn: 2, request: 3, message: { role: 'assistant', provider: 'magpie', model: 'group/flash',
    responseModel: 'actual-upstream-model', thinkingLevel: 'high', providerThinkingLevel: 'high',
    usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25 } } }];
  const transport = [{ phase: 'request_start', id: 7, category: 'model', monotonicNs: '20' },
    { phase: 'request_sent', id: 7, requestBodySha256: payload.sha256, requestBodyBytes: 4 },
    { phase: 'request_end', id: 7, category: 'model', outcome: 'completed', status: 200 }];
  return {sample,events,transport};
}

test('daily model evidence binds each actual request, high wire payload and response usage without guessing the route', () => {
  assert.equal(typeof baselineDriver.modelBaselineModelEvidence, 'function');
  const {sample,events,transport}=dailyEvidenceFixture();
  const check = (changed = events, wires = transport) => baselineDriver.modelBaselineModelEvidence(sample, changed, wires, dailyProfile);
  const result = check(); assert.equal(result.complete, true, result.errors.join(','));
  assert.equal(result.requests.length, 1); assert.equal(result.requests[0].response.responseModel, 'actual-upstream-model');
  assert.equal(result.requests[0].response.usage.totalTokens, 25); assert.deepEqual(result.requests[0].wireRequestIds, [7]);
  for (const mutate of [
    rows => { rows[0].provider = 'other'; }, rows => { rows[0].model = 'group/flash-free'; },
    rows => { rows[0].provider = 'magpie/group'; rows[0].model = 'flash'; },
    rows => { delete rows[0].reasoningEffort; }, rows => { rows[0].reasoningEffort = 'medium'; },
    rows => { rows[1].request = 2; }, rows => { rows[1].turn = 1; }, rows => { rows[1].message.provider = 'other'; },
    rows => { rows[1].message.model = 'group/flash-free'; }, rows => { rows[1].message.providerThinkingLevel = 'low'; },
    rows => { rows[1].message.provider = 'magpie/group'; rows[1].message.model = 'flash'; },
    rows => { rows[1].message.usage.totalTokens = null; }, rows => { rows.push(structuredClone(rows[1])); },
  ]) { const changed = structuredClone(events); mutate(changed); assert.equal(check(changed).complete, false); }
  for (const mutate of [
    rows => rows.splice(1, 1), rows => { rows[1].requestBodySha256 = digest('other'); },
    rows => { rows[1].requestBodyBytes = 5; }, rows => { rows[2].status = 503; }, rows => { delete rows[2].status; },
    rows => rows.push({ ...rows[0], id: 8 }, { ...rows[1], id: 8 }, { ...rows[2], id: 8 }),
  ]) { const changed = structuredClone(transport); mutate(changed); assert.equal(check(events, changed).complete, false); }
});

test('daily route rejects a different wire model even when the sent body hash and high effort match', () => {
  for(const requestModel of ['group/flash','magpie/group/flash','group/worker','magpie/group/worker']) {
    const {sample,events,transport}=dailyEvidenceFixture(),body=JSON.stringify({model:requestModel,reasoning_effort:'high'});
    events[0].requestModel=requestModel;events[0].payload={sha256:digest(body),bytes:Buffer.byteLength(body)};
    transport[1].requestBodySha256=digest(body);transport[1].requestBodyBytes=Buffer.byteLength(body);
    const result=baselineDriver.modelBaselineModelEvidence(sample,events,transport,dailyProfile);
    const accepted=['group/flash','magpie/group/flash'].includes(requestModel);
    assert.equal(result.complete,accepted,requestModel);
    if(!accepted)assert.ok(result.errors.includes('MODEL_REQUEST_ROUTE_UNPROVEN'));
    assert.equal(result.requests[0].requestModel,requestModel);
  }
});

test('daily route retains an unreported response model as unknown and fails its route contract', () => {
  for(const responseModel of [undefined,null,'']) {
    const {sample,events,transport}=dailyEvidenceFixture();events[1].message.responseModel=responseModel;
    const result=baselineDriver.modelBaselineModelEvidence(sample,events,transport,dailyProfile);
    assert.equal(result.complete,false);assert.ok(result.errors.includes('MODEL_RESPONSE_ROUTE_UNPROVEN'));
    assert.equal(result.requests[0].response.responseModel,responseModel??null,'Do not fill the missing route from the selected model');
    assert.equal(result.requests[0].response.usage.totalTokens,25,'Retain actual usage even when route evidence fails');
  }
});

test('daily application completion accepts proved SSE cancellation only for the exact paired normal response', () => {
  const { sample, events, transport } = dailyEvidenceFixture();
  events[1].message.stopReason = 'stop';
  Object.assign(transport[2], { outcome: 'failure', errorCode: 20, errorName: 'AbortError', modelApi: 'openai-completions',
    contentEncoding: 'identity', contentType: 'text/event-stream', sseCompletion: { method: 'bounded-sse-data-done-v1', doneEvents: 1 } });
  const check = (changed = events, wires = transport) => baselineDriver.modelBaselineModelEvidence(sample, changed, wires, dailyProfile);
  const result = check(); assert.equal(result.complete, true, result.errors.join(','));
  assert.equal(result.requests[0].applicationCompletion, 'sse-done-before-http-cancel');
  assert.equal(transport[2].outcome, 'failure'); assert.equal(transport[2].errorCode, 20);
  for (const mutate of [rows => { delete rows[2].sseCompletion; }, rows => { rows[2].sseCompletion.doneEvents = 0; },
    rows => { rows[2].sseCompletion.doneEvents = 2; }, rows => { rows[2].errorName = 'Error'; },
    rows => { rows[2].contentEncoding = 'gzip'; }, rows => { rows[2].modelApi = 'openai-responses'; },
    rows => { rows[1].requestBodySha256 = digest('unrelated-body'); }, rows => { rows[1].requestBodyBytes++; },
    rows => { rows.push(structuredClone(rows[2])); }]) {
    const wires = structuredClone(transport); mutate(wires); assert.equal(check(events, wires).complete, false);
  }
  for (const mutate of [rows => { rows[1].request++; }, rows => { rows[1].turn++; },
    rows => { rows[1].message.stopReason = 'length'; }, rows => { rows[1].message.responseModel = null; },
    rows => { rows[1].message.usage.totalTokens = 0; }, rows => { rows.push(structuredClone(rows[1])); }]) {
    const changed = structuredClone(events); mutate(changed); assert.equal(check(changed).complete, false);
  }
});

test('daily summary keeps HTTP successful separate from proved application completion', () => {
  assert.equal(typeof baselineDriver.summarizeTurn, 'function');
  const { sample, events, transport } = dailyEvidenceFixture();
  events[0].monotonicNs = '30'; Object.assign(events[0].payload, { components: [], diagnosticSpans: [] });
  events[1].monotonicNs = '80'; events[1].message.stopReason = 'stop';
  events.push({ phase: 'observer_end', complete: true });
  Object.assign(transport[2], { outcome: 'failure', errorCode: 20, errorName: 'AbortError', modelApi: 'openai-completions',
    contentEncoding: 'identity', contentType: 'text/event-stream', responseEntityBytes: 20, decodedResponseBytes: 20,
    sseCompletion: { method: 'bounded-sse-data-done-v1', doneEvents: 1 } });
  transport.push({ phase: 'transport_end', complete: true, selectedModel: digest(dailyRoute.model) });
  const summary = baselineDriver.summarizeTurn(sample, events, transport, dailyProfile);
  assert.equal(summary.observationComplete, true); assert.equal(summary.modelHttp.successful, 0);
  assert.equal(summary.modelHttp.attempts, 1); assert.equal(summary.modelHttp.completed, 1);
  assert.equal(summary.modelApplication.completed, 1); assert.equal(summary.modelApplication.httpComplete, 0);
  assert.equal(summary.modelApplication.sseDoneBeforeHttpCancel, 1); assert.equal(summary.modelApplication.unproven, 0);
  const missing = structuredClone(transport); delete missing[2].sseCompletion;
  const rejected = baselineDriver.summarizeTurn(sample, events, missing, dailyProfile);
  assert.equal(rejected.observationComplete, false); assert.equal(rejected.modelHttp.successful, 0);
  assert.equal(rejected.modelApplication.completed, 0); assert.equal(rejected.modelApplication.unproven, 1);
});

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
  const lines=[],rawWrites=[],hooks=new Map(),channels=new Map();
  let failWrites=false,failRawWrites=false;
  const api={on:(name,handler)=>hooks.set(name,[...(hooks.get(name)??[]),handler])};
  const files=nativeFiles.map(({body,...file})=>file);
  const handle=observeNativeInspection(api,{crypto,path,files,catalog:nativeMetadata,output:'/private/native.jsonl',clockId:'native-test',
    fs:{constants:{O_CREAT:1,O_EXCL:2,O_WRONLY:4},openSync:()=>1,writeSync:(_fd,line)=>{if(failWrites)throw new Error('EVIDENCE_WRITE_FAILED');lines.push(line);},closeSync:()=>{},
      writeFileSync:(file,bytes,options)=>{if(failRawWrites)throw new Error('RAW_EVIDENCE_WRITE_FAILED');rawWrites.push({file,bytes,options});}},
    diagnostics:{subscribe:(name,handler)=>channels.set(name,handler),unsubscribe:name=>channels.delete(name)},...overrides});
  const fire=(name,event={})=>{for(const handler of hooks.get(name)??[])assert.equal(handler(event),undefined,'The passive observer must not transform an event');};
  const read=(file,id='call-'+file.path,{pathname=file.absolutePath,content=file.body,isError=false,details}={})=>{
    fire('tool_call',{toolName:'read',toolCallId:id,input:{path:pathname}});
    fire('tool_result',{toolName:'read',toolCallId:id,content:[{type:'text',text:content}],isError,details});
  };
  const provider=(messages,extra={})=>fire('before_provider_request',{payload:{model:'controlled',messages:[{role:'system',content:nativeSystem},...messages],tools:[{type:'function',function:{name:'read',parameters:{type:'object'}}}],...extra}});
  fire('input');
  return {fire,read,provider,channels,rawWrites,failWrites:value=>{failWrites=value;},failRawWrites:value=>{failRawWrites=value;},finish:handle.finish,events:()=>lines.map(line=>JSON.parse(line))};
}

test('raw provider evidence preserves actual body, schema and guidance without event headers or mutation', () => {
  const probe=nativeProbe({rawDirectory:'/private/provider-payloads'});
  const payload={model:'controlled',messages:[{role:'system',content:nativeSystem},{role:'user',content:'Inspect the frozen files.'}],
    tools:[{type:'function',function:{name:'read',description:'Read a file.',parameters:{type:'object',properties:{path:{type:'string'}}}}}]};
  const original=JSON.stringify(payload);
  probe.fire('before_provider_request',{payload,headers:{authorization:'PRIVATE_EVENT_HEADER_NOT_PAYLOAD'}});
  probe.finish();
  assert.equal(JSON.stringify(payload),original);
  assert.equal(probe.rawWrites.length,1,'Every actual provider payload needs its complete private original');
  assert.deepEqual(probe.rawWrites[0],{file:'/private/provider-payloads/provider-1.json',bytes:original,options:{flag:'wx',mode:0o600}});
  const event=probe.events().find(item=>item.phase==='native_provider');
  assert.equal(event.rawPayload,'provider-1.json');assert.equal(event.payloadSha256,digest(original));
  assert.equal(event.payloadBytes,Buffer.byteLength(original));
  assert.equal(probe.events().at(-1).rawPayloads,1);verifyNativeInspectionEvents(probe.events());
});

test('a failed raw write leaves the provider untouched and cannot claim an observer terminal', () => {
  const probe=nativeProbe({rawDirectory:'/private/provider-payloads'}),payload={messages:[{role:'user',content:'Actual task'}],tools:[]};
  const before=structuredClone(payload);probe.failRawWrites(true);
  assert.doesNotThrow(()=>probe.fire('before_provider_request',{payload}));probe.finish();
  assert.deepEqual(payload,before);assert.equal(probe.rawWrites.length,0);
  assert.equal(probe.events().at(-1).complete,false);assert.throws(()=>verifyNativeInspectionEvents(probe.events()));
});

test('private provider and answer originals bind complete cost events and reject tampering or missing observations', async t => {
  const base=await mkdtemp(path.join(tmpdir(),'model-baseline-raw-'));
  t.after(()=>{if(process.platform==='darwin')assert.equal(spawnSync('/usr/bin/trash',[base]).status,0);});
  const rawDirectory=path.join(base,'provider-payloads');await mkdir(rawDirectory);
  const probe=nativeProbe({rawDirectory});probe.provider([]);probe.finish();
  for(const item of probe.rawWrites)await writeFile(item.file,item.bytes,item.options);
  const event=probe.events().find(item=>item.phase==='native_provider'),answerText='Actual final answer, including --from.';
  const sample={id:'cold-1',turn:1,stopReason:'stop',answerFile:'cold-1-answer.json',answerSha256:digest(answerText),answerBytes:Buffer.byteLength(answerText)};
  const answer={version:1,sampleId:sample.id,turn:1,stopReason:'stop',text:answerText};
  await writeFile(path.join(base,sample.answerFile),JSON.stringify(answer),{mode:0o600});
  const costEvents=[{phase:'provider_request',turn:1,payload:{sha256:event.payloadSha256,bytes:event.payloadBytes}},
    {phase:'agent_end',turn:1,final:{text:{sha256:sample.answerSha256,bytes:sample.answerBytes}}}];
  const input={processEvidence:base,events:probe.events(),costEvents,answers:[sample]};
  assert.deepEqual(await verifyModelRawEvidence(input),{complete:true,providerOriginals:1,finalAnswers:1,contentPolicy:'private provider body and actual final text; no HTTP headers'});
  await assert.rejects(verifyModelRawEvidence({...input,events:input.events.slice(0,-1)}),/lifecycle/);
  await assert.rejects(verifyModelRawEvidence({...input,costEvents:[...costEvents,costEvents[0]]}),/every cost event/);
  await assert.rejects(verifyModelRawEvidence({...input,costEvents:costEvents.slice(0,1)}),/agent terminal/);
  await writeFile(probe.rawWrites[0].file,probe.rawWrites[0].bytes.replace('controlled','altered---'));
  await assert.rejects(verifyModelRawEvidence(input));
  await writeFile(probe.rawWrites[0].file,probe.rawWrites[0].bytes);
  await writeFile(path.join(base,sample.answerFile),JSON.stringify({...answer,text:'Fabricated final --from'}));
  await assert.rejects(verifyModelRawEvidence(input));
  await writeFile(path.join(base,sample.answerFile),JSON.stringify(answer));
  await writeFile(path.join(rawDirectory,'provider-2.json'),'{}');
  await assert.rejects(verifyModelRawEvidence(input),/Missing or extra/);
});

test('semantic stop is bound to one completed answer and cannot replace a prompt, model or outcome', async t => {
  const base=await mkdtemp(path.join(tmpdir(),'model-baseline-review-'));
  t.after(()=>{if(process.platform==='darwin')assert.equal(spawnSync('/usr/bin/trash',[base]).status,0);});
  const sample={id:'cold-1',answerSha256:digest('Observed final answer')};
  assert.equal(await readModelReviewStop(base,[sample]),null);
  const request={version:1,kind:'semantic-failure',sampleId:sample.id,answerSha256:sample.answerSha256,reason:'The required cache boundary is missing.'};
  const file=path.join(base,'semantic-stop-request.json'),write=value=>writeFile(file,JSON.stringify(value));
  await write(request);const actual=await readModelReviewStop(base,[sample]);
  assert.equal(actual.answerSha256,sample.answerSha256);assert.equal(actual.requestSha256,digest(JSON.stringify(request)));
  for(const changed of [{...request,sampleId:'cold-2'},{...request,answerSha256:'a'.repeat(64)},
    {...request,kind:'passed'},{...request,prompt:'Retry with an easier task'},{...request,reason:''}]) {
    await write(changed);await assert.rejects(readModelReviewStop(base,[sample]));
  }
  await write(request);await assert.rejects(readModelReviewStop(base,[sample,sample]),/one completed/);
});

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

  const catalogRoot=path.join(base,'catalog'),viewId='12345678-1234-1234-1234-123456789012',candidates=[],records=[];
  for(const name of ['reader','other-one','other-two']) {
    const directory=path.join(catalogRoot,name),description='Inspect '+name+'.';
    await mkdir(path.join(directory,'references'),{recursive:true});
    const files=[{path:'SKILL.md',body:'---\nname: '+name+'\ndescription: '+description+'\n---\nRead references/check.md.\n'},
      {path:'references/check.md',body:'Reference for '+name+'.\n'}];
    for(const file of files)await writeFile(path.join(directory,file.path),file.body);
    const record={id:'shared_skill:fixture:'+name,kind:'skill',name,description,ref:'skill://'+encodeURIComponent('shared_skill:fixture:'+name)+'/SKILL.md'};
    const manifest=await write(name+'-manifest.json',{complete:true,record,entrypoint:'SKILL.md',scope:'a'.repeat(64),snapshot_id:'s_'+digest(name),version_id:digest('version-'+name),
      files:files.map(({path,body})=>({path,bytes:Buffer.byteLength(body),sha256:digest(body)}))});
    candidates.push({recordId:record.id,manifest,directory});records.push(record);
  }
  const multiSource=await write('multi-source.json',{transport:'sdk',operation:'list',status:'completed',resultObserved:true,
    value:{scope:'a'.repeat(64),view:{id:viewId},records,count:3,coverage:{exhaustive:true,search_index_limited:false,failed_sources:[]}}});
  const multiPayload={messages:[{role:'system',content:catalogFor(records)}]},multiPayloadIdentity=await write('multi-payload.json',multiPayload);
  const multiSelection=await write('multi-selection.json',{kind:'installed-pi-catalog-preflight',status:'passed',sourceMode:'sdk',pi:output.comparison.nativePackage,runtimeUnchanged:true,
    bodyRequests:0,realModelRequests:0,processesClosed:true,defaultDiscovery:{status:'passed',catalog:{status:'ready'}},
    evidence:base,files:['multi-source.json','multi-payload.json'],record:records[0],viewId,catalog:comparisonCatalog(multiPayload),setupCost:{kind:'controlled-fixture',httpAttempts:0}});
  const descriptor={version:2,roles:['previous-broker','notion-candidate','pi-native-local'],intent:'inspect',entry:'read',model:'magpie/group/flash-free',
    promptSha256:digest(config.prompt),expectedAnswersSha256:digest(JSON.stringify(config.expectedAnswers)),counts:config.counts,
    notionSelection:multiSelection,notionProviderPayload:multiPayloadIdentity,notionCatalogSource:multiSource,
    piVersion:output.comparison.nativePackage.version,viewId,directory:catalogRoot,candidates,selectedRecordId:records[0].id,requiredResources:['references/check.md']};
  const invoke=async(name,descriptor,overrides={})=>{
    const comparison=await write(name+'-comparison.json',descriptor),input=await write(name+'-config.json',{...config,...overrides,comparison:comparison.path});
    return spawnSync(process.execPath,[fileURLToPath(new URL('./skill-consumption-model-baseline.mjs',import.meta.url)),'doctor','--config',input.path],
      {encoding:'utf8',env:process.env,timeout:20000});
  };
  const multi=await invoke('multi',descriptor);assert.equal(multi.status,0,multi.stderr);
  const comparison=JSON.parse(multi.stdout).comparison;
  assert.equal(comparison.version,2);assert.equal(comparison.catalog.length,3);assert.equal(comparison.candidates.length,3);
  assert.equal(comparison.requiredFiles.length,2);assert.equal(comparison.unselectedFiles.length,4);
  assert.equal(comparison.source.recordId,records[0].id);
  const pairedSource=await write('paired-source.json',{transport:'sdk',operation:'list',status:'completed',resultObserved:true,
    value:{version:1,catalog:{ok:false,error:{code:'IDENTITY_CONFLICT',message:'Unrelated full inventory conflict'}},
      directory:{ok:true,value:{scope:'a'.repeat(64),databases:[],view:{id:viewId},records,count:3,
        coverage:{exhaustive:true,search_index_limited:false,failed_sources:[]}}}}});
  const pairedSelection=await write('paired-selection.json',{...JSON.parse(await readFile(multiSelection.path,'utf8')),
    files:['paired-source.json','multi-payload.json']});
  const paired=await invoke('paired',{...descriptor,notionSelection:pairedSelection,notionCatalogSource:pairedSource});
  assert.equal(paired.status,0,paired.stderr);
  assert.equal(JSON.parse(paired.stdout).comparison.source.recordId,records[0].id);
  assert.equal(JSON.parse(paired.stdout).comparison.catalog.length,3);
  assert.equal(digest(await readFile(pairedSource.path)),pairedSource.sha256,'Doctor preserves the raw failed/full and successful/View outcomes');
  const dailyDescriptor={...descriptor,...dailyRoute,counts:{cold:1,warm:0}},dailyOverrides={...dailyRoute,counts:{cold:1,warm:0}};
  const dailyDoctor=await invoke('daily',dailyDescriptor,dailyOverrides);
  assert.equal(dailyDoctor.status,0,dailyDoctor.stderr);
  const dailyOutput=JSON.parse(dailyDoctor.stdout);
  assert.deepEqual(dailyOutput.modelProfile,dailyProfile);
  assert.equal(dailyOutput.modelProfileSha256,digest(JSON.stringify(dailyProfile)));
  assert.deepEqual(dailyOutput.comparison.modelProfile,dailyProfile);
  assert.equal(dailyOutput.comparison.sha256,digest(await readFile(path.join(base,'daily-comparison.json'))));
  for(const changed of [{modelContract:undefined},{model:'magpie/group/flash-free'},{thinkingLevel:'medium'},{rpcTimeoutMs:120000}]) {
    const rejected=await invoke('daily-mismatch-'+Object.keys(changed)[0],{...dailyDescriptor,...changed},dailyOverrides);
    assert.notEqual(rejected.status,0,'Comparison manifest must freeze every daily-route parameter');
  }

  // Exercise the public run controller with only its RPC boundary replaced.
  // Doctor and the installed SettingsManager remain real, but no Pi RPC process,
  // provider, source, prompt execution or authentication operation is started.
  const fakeRpc=path.join(base,'controlled-rpc.mjs'),loader=path.join(base,'controlled-loader.mjs');
  await writeFile(fakeRpc,`import fs from 'node:fs';import path from 'node:path';
export async function startRpc(options) {
 const file=process.env.BASELINE_CONTROLLED_RPC_CAPTURE,settingsFile=path.join(options.cwd,'.pi','settings.json');
 const receipt={cwd:options.cwd,args:options.args,timeoutMs:options.timeoutMs,schedulerRoot:options.env.NTN_SKILLS_SCHEDULER_ROOT,
  projectSettings:fs.existsSync(settingsFile)?JSON.parse(fs.readFileSync(settingsFile,'utf8')):null,calls:[]};
 const record=call=>{receipt.calls.push(call);fs.writeFileSync(file,JSON.stringify(receipt));};record('start');
 return {lifecycle:[],command:async type=>{record(type);if(type!=='get_state')throw Error('UNEXPECTED_RPC_COMMAND');
   return {model:{provider:'magpie',id:'group/flash'},thinkingLevel:process.env.BASELINE_CONTROLLED_THINKING};},
  prompt:async()=>{record('prompt');throw Error('CONTROLLED_STOP_AFTER_STATE');},closeInput:async()=>record('closeInput'),stop:async()=>record('stop')};
}`);
  const driverUrl=new URL('./skill-consumption-model-baseline.mjs',import.meta.url).href;
  await writeFile(loader,`import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){
 if(context.parentURL===${JSON.stringify(driverUrl)}&&specifier.endsWith('context-broker-rpc-harness.mjs'))
  return {url:${JSON.stringify(pathToFileURL(fakeRpc).href)},shortCircuit:true};return next(specifier,context);}});`);
  for(const mode of ['high','low','legacy']) {
    const capture=path.join(base,'controlled-'+mode+'.json'),evidence=path.join(base,'controlled-'+mode+'-evidence');await mkdir(evidence);
    const file=path.join(base,mode==='legacy'?'config.json':'daily-config.json');
    const outcome=spawnSync(process.execPath,['--import',loader,fileURLToPath(new URL('./skill-consumption-model-baseline.mjs',import.meta.url)),
      'run','--config',file,'--evidence-root',evidence],{encoding:'utf8',timeout:30000,
      env:{...process.env,BASELINE_CONTROLLED_RPC_CAPTURE:capture,BASELINE_CONTROLLED_THINKING:mode}});
    await write('controlled-'+mode+'-result.json',{status:outcome.status,stdout:outcome.stdout,stderr:outcome.stderr});
    assert.notEqual(outcome.status,0,'The controlled stop and absent real evidence must not count as model acceptance');
    const captured=JSON.parse(await readFile(capture,'utf8'));
    assert.equal(captured.schedulerRoot,path.join(captured.cwd,'request-engine'));
    const [runDirectory]=await readdir(evidence),report=JSON.parse(await readFile(path.join(evidence,runDirectory,'report.json'),'utf8'));
    const plan=JSON.parse(await readFile(path.join(evidence,runDirectory,'plan.json'),'utf8'));
    assert.equal(report.status,'incomplete');assert.equal(report.samples.filter(sample=>sample.status==='passed').length,0);
    if(mode==='legacy') {
      assert.equal(captured.timeoutMs,120000);assert.equal(captured.projectSettings,null);
      assert.equal(captured.calls.includes('get_state'),false);assert.equal(captured.calls.filter(x=>x==='prompt').length,1);
      assert.equal(Object.hasOwn(plan,'modelProfile'),false);assert.equal(Object.hasOwn(report,'modelProfile'),false);
    } else {
      assert.equal(captured.timeoutMs,300000);assert.deepEqual(captured.projectSettings,dailyProfile.ownedProjectRetry);
      assert.equal(captured.calls.filter(x=>x==='get_state').length,1);assert.equal(captured.calls.includes('set_auto_retry'),false);
      assert.equal(captured.calls.filter(x=>x==='prompt').length,mode==='high'?1:0);
      if(mode==='high')assert.ok(captured.calls.indexOf('get_state')<captured.calls.indexOf('prompt'));
      assert.deepEqual(plan.modelProfile,dailyProfile);assert.deepEqual(report.modelProfile,dailyProfile);
      assert.equal(report.modelProfileSha256,digest(JSON.stringify(dailyProfile)));
      assert.deepEqual(report.processes[0].projectRetry.effective,{projectTrusted:true,enabled:false,maxRetries:0,providerMaxRetries:0});
      assert.equal(report.processes[0].retryPolicyUnchanged,true);
      const state=JSON.parse(await readFile(path.join(evidence,runDirectory,'process-1',report.samples[0].modelStateFile),'utf8'));
      assert.equal(state.actual.thinkingLevel,mode);assert.equal(state.modelProfileSha256,report.modelProfileSha256);
      if(mode==='low') {assert.equal(report.samples[0].submitNs,undefined);assert.equal(report.samples[0].submitToCompletionMs,null);}
    }
  }
  for(const scenario of ['missing','duplicate','wrong-owner','outside-root','wrong-scope','stale-payload','host-version']) {
    const changed=structuredClone(descriptor);
    if(scenario==='missing')changed.candidates.pop();
    else if(scenario==='duplicate')changed.candidates[1].recordId=changed.candidates[0].recordId;
    else if(scenario==='wrong-owner')changed.candidates[1].manifest=changed.candidates[0].manifest;
    else if(scenario==='outside-root')changed.candidates[1].directory=directory;
    else if(scenario==='wrong-scope') {
      const manifest=JSON.parse(await readFile(changed.candidates[1].manifest.path,'utf8'));manifest.scope='d'.repeat(64);
      changed.candidates[1].manifest=await write('wrong-scope-manifest.json',manifest);
    } else if(scenario==='stale-payload')changed.notionProviderPayload=payload;
    else changed.piVersion='0.0.0';
    const rejected=await invoke('multi-'+scenario,changed);assert.notEqual(rejected.status,0,scenario);
  }
  const disabled=structuredClone(descriptor),manualFile=path.join(candidates[1].directory,'SKILL.md');
  const manual=(await readFile(manualFile,'utf8')).replace('---\n','---\ndisable-model-invocation: true\n');
  await writeFile(manualFile,manual);
  const manualManifest=JSON.parse(await readFile(candidates[1].manifest.path,'utf8'));
  Object.assign(manualManifest.files.find(file=>file.path==='SKILL.md'),{bytes:Buffer.byteLength(manual),sha256:digest(manual)});
  disabled.candidates[1].manifest=await write('manual-manifest.json',manualManifest);
  const rejected=await invoke('multi-manual',disabled);assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/model-visible/);
  const policyDescriptor={...disabled,visibilityPolicy:'native-default-policy'};
  const policyResult=await invoke('multi-native-default',policyDescriptor);
  assert.equal(policyResult.status,0,policyResult.stderr);
  const policy=JSON.parse(policyResult.stdout).comparison;
  assert.equal(policy.visibility.policy,'native-default-policy');
  assert.equal(policy.visibility.costQuestion,'system-default-workflow');
  assert.equal(policy.visibility.sameVisibleCandidates,false);
  assert.equal(policy.visibility.nativeInventory.length,3);assert.equal(policy.candidates.length,3);
  assert.deepEqual(policy.catalog.map(skill=>skill.name).sort(),['other-two','reader']);
  assert.deepEqual(policy.visibility.notionOnly.map(skill=>skill.name),['other-one']);
  assert.equal(policy.visibility.notionVisible.length,3);
  assert.equal(policy.requiredFiles.length,2);assert.equal(policy.unselectedFiles.length,4);
  assert.equal(policy.nativePrompt.sha256,digest(policy.nativePrompt.text));
  assert.equal((await readFile(manualFile,'utf8')),manual,'Doctor must retain the authored manual-only policy');
  for(const scenario of ['unknown-policy','missing-owner','changed-metadata','changed-author-policy']) {
    const changed=structuredClone(policyDescriptor);
    if(scenario==='unknown-policy')changed.visibilityPolicy='auto';
    else if(scenario==='missing-owner')changed.candidates.pop();
    else if(scenario==='changed-metadata') {
      const manifest=structuredClone(manualManifest);manifest.record.description+=' changed';
      changed.candidates[1].manifest=await write('changed-native-metadata.json',manifest);
    } else await writeFile(manualFile,manual.replace('disable-model-invocation: true','disable-model-invocation: false'));
    try {const bad=await invoke('native-policy-'+scenario,changed);assert.notEqual(bad.status,0,scenario);}
    finally {if(scenario==='changed-author-policy')await writeFile(manualFile,manual);}
  }
  const legacyPolicy=JSON.parse(await readFile(path.join(base,'comparison.json'),'utf8'));
  const legacyRejected=await invoke('legacy-native-policy',{...legacyPolicy,visibilityPolicy:'native-default-policy'});
  assert.notEqual(legacyRejected.status,0);assert.match(legacyRejected.stderr,/version 2/);
  const allManual=structuredClone(policyDescriptor);
  for(const index of [0,2]) {
    const file=path.join(allManual.candidates[index].directory,'SKILL.md');
    const text=(await readFile(file,'utf8')).replace('---\n','---\ndisable-model-invocation: true\n');
    await writeFile(file,text);
    const manifest=JSON.parse(await readFile(allManual.candidates[index].manifest.path,'utf8'));
    Object.assign(manifest.files.find(file=>file.path==='SKILL.md'),{bytes:Buffer.byteLength(text),sha256:digest(text)});
    allManual.candidates[index].manifest=await write('all-manual-'+index+'.json',manifest);
  }
  const empty=await invoke('all-manual-native-policy',allManual);assert.equal(empty.status,0,empty.stderr);
  const emptyCatalog=JSON.parse(empty.stdout).comparison;
  assert.equal(emptyCatalog.visibility.nativeInventory.length,3);assert.equal(emptyCatalog.visibility.notionVisible.length,3);
  assert.deepEqual(emptyCatalog.catalog,[]);assert.equal(emptyCatalog.visibility.notionOnly.length,3);
  assert.equal(emptyCatalog.nativePrompt.text,'');assert.equal(emptyCatalog.requiredFiles.length,2);
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

test('a closed native child with unknown source cost stops later samples after the owned terminal', () => {
  const probe=nativeProbe();probe.read(nativeFiles[0]);
  probe.channels.get('tracing:child_process.spawn:start')({process:{once:(_event,callback)=>callback(0,null)}});
  probe.provider([{role:'tool',tool_call_id:'call-SKILL.md',content:nativeFiles[0].body}]);probe.finish();
  const transportEvents=[{phase:'transport_end',complete:true}];
  const source=summarizeNativeSource(probe.events(),transportEvents,hostClosed,nativeFiles);
  assert.equal(source.hostClosed,true);assert.equal(source.sourceObserverComplete,true);
  assert.equal(source.unmatchedChildren,1);assert.equal(source.httpAttempts,null);
  const result={status:'closed',source,observedSourcesQuiet:source.complete,inspectionComplete:true,rawEvidence:{complete:true}};
  assert.match(modelProcessTerminalFailure(result,{costEvents:[{phase:'observer_end',complete:true}],transportEvents,
    inspectionRequired:true}),/Source observation is incomplete/);
});

test('later samples require source, cost, transport and raw originals to close; a captured HTTP failure is not erased', () => {
  const result={status:'closed',source:{complete:true,hostClosed:true},observedSourcesQuiet:true,inspectionComplete:true,rawEvidence:{complete:true}};
  const options={costEvents:[{phase:'observer_end',complete:true}],
    transportEvents:[{phase:'request_end',status:200,outcome:'failure',errorCode:20},{phase:'transport_end',complete:true}],inspectionRequired:true};
  const original=structuredClone(options.transportEvents);
  assert.equal(modelProcessTerminalFailure(result,options),undefined);
  assert.deepEqual(options.transportEvents,original,'HTTP 200 with a captured stream failure remains a failure record');
  for(const [changed,observed,reason] of [
    [{status:'running'},{},/close boundary/],
    [{source:undefined},{},/close boundary/],
    [{source:{complete:false,hostClosed:true}},{},/Source observation/],
    [{observedSourcesQuiet:false},{},/Source observation/],
    [{},{costEvents:[]},/cost observation/],
    [{},{costEvents:[{phase:'observer_end',complete:false}]},/cost observation/],
    [{},{transportEvents:[]},/transport observation/],
    [{},{transportEvents:[{phase:'transport_end',complete:false}]},/transport observation/],
    [{inspectionComplete:false},{},/Raw provider/],
    [{rawEvidence:undefined},{},/Raw provider/],
  ])assert.match(modelProcessTerminalFailure({...result,...changed},{...options,...observed}),reason);
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

const visibleRecords=['reader','other-one','other-two'].map((name,index)=>({
  id:'shared_skill:fixture:'+name,ref:'skill://'+encodeURIComponent('shared_skill:fixture:'+name)+'/SKILL.md',
  kind:'skill',name,description:index===0?'Inspect fixed files.':'Inspect '+name+'.',
}));
const catalogFor=(records=visibleRecords)=>'<ntn-skills-view-catalog><view source="notion" id="view" database="db">Ready</view><available_skills>'
  +records.map((record,index)=>'<skill><name>'+record.name+'</name><description>'+record.description+'</description><location>sr:C'
    +String.fromCharCode(97+index).repeat(22)+'</location></skill>').join('')+'</available_skills></ntn-skills-view-catalog>';

test('a complete multi-candidate directory compares exact metadata without changing source names or imposing provider order',()=>{
  const actual=comparisonCatalog({messages:[{role:'system',content:catalogFor()}]});
  const native=visibleRecords.map(record=>({...record,disableModelInvocation:false})).reverse(),before=structuredClone(native);
  verifyComparisonCatalog(native,actual);assert.deepEqual(native,before);
  for(const scenario of ['missing','duplicate-name','disabled','description','case']) {
    const changed=structuredClone(native);
    if(scenario==='missing')changed.pop();
    else if(scenario==='duplicate-name')changed[1].name=changed[0].name;
    else if(scenario==='disabled')changed[1].disableModelInvocation=true;
    else if(scenario==='description')changed[1].description+=' changed';
    else changed[1].name=changed[1].name.toUpperCase();
    assert.throws(()=>verifyComparisonCatalog(changed,actual),undefined,scenario);
  }
  assert.throws(()=>comparisonCatalog({system:catalogFor([visibleRecords[0],visibleRecords[0]])}),/Duplicate visible names/);
  assert.throws(()=>comparisonCatalog({system:catalogFor().replace('sr:C'+'b'.repeat(22),'sr:C'+'a'.repeat(22))}),/distinct exact entry/);
});

test('native-default policy permits authored visibility differences without weakening the full inventory or metadata',()=>{
  const actual=comparisonCatalog({system:catalogFor()});
  const native=visibleRecords.map((record,index)=>({...record,disableModelInvocation:index===1})),before=structuredClone(native);
  assert.throws(()=>verifyComparisonCatalog(native,actual),/model-visible/);
  assert.doesNotThrow(()=>verifyComparisonCatalog(native,actual,'native-default-policy'));
  assert.deepEqual(native,before);
  for(const scenario of ['missing','duplicate','name','description','unknown-flag']) {
    const changed=structuredClone(native);
    if(scenario==='missing')changed.pop();
    else if(scenario==='duplicate')changed[1].name=changed[0].name;
    else if(scenario==='name')changed[1].name='replacement';
    else if(scenario==='description')changed[1].description+=' changed';
    else delete changed[1].disableModelInvocation;
    assert.throws(()=>verifyComparisonCatalog(changed,actual,'native-default-policy'),undefined,scenario);
  }
  const visible=native.map(skill=>({...skill,disableModelInvocation:false}));
  for(const policy of [null,'auto','native-default',false])assert.throws(()=>verifyComparisonCatalog(visible,actual,policy),/visibility policy/);
});

test('each native-default arm still verifies its actual catalog, including an empty native catalog',()=>{
  const native=visibleRecords.map(({name,description})=>({name,description,filePath:'/frozen/'+name+'/SKILL.md'}));
  const format=skills=>skills.length?'<available_skills>'+skills.map(skill=>'<skill><name>'+skill.name+'</name><description>'
    +skill.description+'</description><location>'+skill.filePath+'</location></skill>').join('')+'</available_skills>':'';
  for(const expected of [[],native.filter(skill=>skill.name!=='other-one')]) {
    for(const actual of [expected,native]) {
      const probe=nativeProbe({catalog:expected});
      probe.provider([],{messages:[{role:'system',content:format(actual)}]});probe.finish();
      assert.equal(probe.events().find(row=>row.phase==='native_provider').catalogMatches,actual===expected);
    }
  }
  for(const actual of [visibleRecords,visibleRecords.slice(0,2)]) {
    const probe=nativeProbe({source:fixedSource,catalog:visibleRecords});
    probe.provider([],{messages:[{role:'system',content:catalogFor(actual)}]});probe.finish();
    assert.equal(probe.events().find(row=>row.phase==='native_provider').catalogMatches,actual===visibleRecords);
  }
});

function catalogSelectionProbe() {
  const payloads=[0,1,2].map(index=>({messages:[{role:'system',content:index<2?
    '<ntn-skills-discovery status="pending">Metadata is pending; the directory is not empty.</ntn-skills-discovery>':catalogFor()}]}));
  const providers=payloads.map((payload,index)=>({phase:'provider',number:index+1,turn:index<2?1:2,sha256:digest(JSON.stringify(payload)),payload}));
  const requestId='sdk:1:source-id';
  return {hooks:[providers[0],{phase:'tool_call',name:'notion_list',id:'call',input:{}},
    {phase:'tool_result',name:'notion_list',id:'call',isError:false},...providers.slice(1),{phase:'end',complete:true}],
    wires:providers.map(row=>({sha256:row.sha256})),
    sources:[{id:'source-id',pid:1,transport:'sdk',operation:'list',status:'completed',resultObserved:true,value:{
      scope:'a'.repeat(64),view:{id:'view'},records:structuredClone(visibleRecords),count:3,
      coverage:{exhaustive:true,search_index_limited:false,failed_sources:[]}}}],
    sourceEvents:[{phase:'started',requestId,kind:'sdk',operation:'list'},{phase:'completed',requestId,status:'completed'}],
    expectedRecords:structuredClone(visibleRecords),viewId:'view'};
}

test('metadata selection proves an ordinary ready turn, actual HTTP payload and the same complete SDK owner set',()=>{
  const input=catalogSelectionProbe(),checked=verifyComparisonSelection(input);
  assert.equal(checked.catalog.length,3);assert.equal(checked.source.id,'source-id');
  for(const scenario of ['no-new-turn','wire-mismatch','source-id','missing-result','source-owner','source-description','failed-source','wrong-view','body-operation']) {
    const value=structuredClone(input),providers=value.hooks.filter(row=>row.phase==='provider');
    if(scenario==='no-new-turn')providers.at(-1).turn=1;
    else if(scenario==='wire-mismatch')value.wires.at(-1).sha256='0'.repeat(64);
    else if(scenario==='source-id')value.sources[0].id='forged';
    else if(scenario==='missing-result')value.sources=[];
    else if(scenario==='source-owner')value.sources[0].value.records[1].id='shared_skill:another-owner';
    else if(scenario==='source-description')value.sources[0].value.records[1].description='Replacement text';
    else if(scenario==='failed-source')value.sources[0].value.coverage.failed_sources=['unavailable'];
    else if(scenario==='wrong-view')value.sources[0].value.view.id='another-view';
    else value.sourceEvents[0].operation='consume';
    assert.throws(()=>verifyComparisonSelection(value),undefined,scenario);
  }
  const pending=structuredClone(input),last=pending.hooks.filter(row=>row.phase==='provider').at(-1);
  last.payload=pending.hooks[0].payload;last.sha256=digest(JSON.stringify(last.payload));pending.wires.at(-1).sha256=last.sha256;
  assert.throws(()=>verifyComparisonSelection(pending),/Pending or failed/);
});

test('unselected native bodies fail even when the selected files were already delivered or bytes are identical',()=>{
  for(const sameBytes of [false,true]) {
    const other={...nativeFiles[0],absolutePath:'/frozen/other/SKILL.md',recordId:'shared_skill:fixture:other',
      ...(sameBytes?{}:{body:'Unselected instructions.',bytes:Buffer.byteLength('Unselected instructions.'),sha256:digest('Unselected instructions.')})};
    const probe=nativeProbe({unselectedFiles:[other]});
    nativeFiles.forEach(file=>probe.read(file));probe.read(other,'unselected');
    probe.provider([...nativeFiles.map(file=>({role:'tool',tool_call_id:'call-'+file.path,content:file.body})),
      {role:'tool',tool_call_id:'unselected',content:other.body}]);probe.finish();
    assert.throws(()=>verifyNativeInspectionEvents(probe.events()),/unselected candidate body/);
    const provider=probe.events().find(row=>row.phase==='native_provider');
    assert.equal(provider.files.length,2);assert.equal(provider.unselectedBodies.length,1);
    assert.equal(summarizeNativeSource(probe.events(),[{phase:'transport_end',complete:true}],hostClosed,nativeFiles).complete,false);
  }
  const failed=nativeProbe({unselectedFiles:[{...nativeFiles[0],absolutePath:'/frozen/other/SKILL.md',recordId:'other'}]});
  failed.read(nativeFiles[0],'denied',{pathname:'/frozen/other/SKILL.md',content:'Access denied',isError:true});failed.finish();
  verifyNativeInspectionEvents(failed.events());
});

test('Notion unselected scalar and batch reads cannot be hidden by a correct selected owner receipt or a short ref',()=>{
  const other={recordId:'shared_skill:fixture:other-one',name:'other-one',snapshotId:'s_'+'d'.repeat(64),scope:fixedSource.scope,versionId:'e'.repeat(64)};
  for(const scenario of ['proof-owner','canonical-owner','catalog-short-ref','batch']) {
    const probe=nativeProbe({source:fixedSource,files:boundFiles,unselectedSources:[other],catalog:visibleRecords});
    if(scenario==='catalog-short-ref')probe.provider([],{messages:[{role:'system',content:catalogFor()}]});
    const ref=scenario==='canonical-owner'?'skill://'+encodeURIComponent(other.recordId)+'/SKILL.md':'sr:C'+'b'.repeat(22);
    probe.fire('tool_call',{toolName:'read',toolCallId:'unselected',input:scenario==='batch'?{paths:[ref]}:{path:ref}});
    probe.fire('tool_result',{toolName:'read',toolCallId:'unselected',content:[{type:'text',text:'Unselected body.'}],
      details:scenario==='proof-owner'||scenario==='batch'?{contextBrokerRead:{binding:{record:{id:other.recordId}}}}:{}});
    probe.provider([{role:'tool',tool_call_id:'unselected',content:'Unselected body.'}]);probe.finish();
    assert.throws(()=>verifyNativeInspectionEvents(probe.events()),/unselected candidate body/,scenario);
  }
});


function combinedCatalogSelectionProbe() {
  const input = catalogSelectionProbe(), source = input.sources[0], directory = { ...source.value, databases: [] };
  const full = { ...structuredClone(directory), records: [...directory.records, { id: 'outside-default', name: 'Outside' }], count: 4 };
  delete full.view;
  source.value = { version: 1, catalog: { ok: true, value: full }, directory: { ok: true, value: directory } };
  return input;
}

test('combined catalog: SC20 selects the successful directory without duplicating the raw source receipt', () => {
  const input = combinedCatalogSelectionProbe(), source = input.sources[0], directory = source.value.directory.value;
  const original = JSON.stringify(source), checked = verifyComparisonSelection(input);
  assert.equal(checked.catalog.length, 3); assert.equal(checked.source, source); assert.deepEqual(checked.directory, directory);
  assert.equal(JSON.stringify(source), original); assert.equal(input.sources.length, 1);
});


test('combined catalog: SC20 retains an unrelated full failure but cannot substitute the full inventory for a failed View', () => {
  const input = combinedCatalogSelectionProbe(), source = input.sources[0];
  source.value.catalog = { ok: false, error: { code: 'IDENTITY_CONFLICT', message: 'Unrelated full inventory conflict' } };
  const before = JSON.stringify(source), checked = verifyComparisonSelection(input);
  assert.equal(checked.source, source); assert.equal(checked.directory.records.length, 3);
  assert.equal(JSON.stringify(source), before); assert.equal(input.sources.length, 1);
  for (const mutate of [
    value => { value.directory = { ok: false, error: { code: 'VIEW_INCOMPLETE', message: 'Incomplete View' } }; },
    value => { value.directory.value.coverage.exhaustive = false; },
    value => { value.directory.value.coverage.failed_sources = ['unavailable']; },
    value => { value.directory.value.scope = 'foreign'; },
    value => { value.directory.value.records.pop(); value.directory.value.count--; },
    value => { value.directory.value.view.id = 'other'; },
    value => { value.catalog.value.databases = [{ database_id: 'db', shared_library: { library_id: 'old' } }];
      value.directory.value.databases = [{ database_id: 'db', shared_library: { library_id: 'new' } }]; },
  ]) { const changed = combinedCatalogSelectionProbe(); mutate(changed.sources[0].value); assert.throws(() => verifyComparisonSelection(changed)); }
});


test('metadata diagnostics: failed SDK terminal and known catalog error stay distinct from the blocking raw-result gate', () => {
  const input = combinedCatalogSelectionProbe(), source = input.sources[0];
  source.file = 'source-results/source-1.json';
  source.value.catalog = { ok: false, error: { code: 'INVALID_SHARED_SKILL', message: 'Skill ID must be a stable bounded identity.' } };
  input.sourceEvents.push(
    { phase: 'started', kind: 'sdk', operation: 'list', requestId: 'sdk:1:failed-id' },
    { phase: 'completed', kind: 'sdk', operation: 'list', requestId: 'sdk:1:failed-id', status: 'failed', elapsedMs: 10129, sourceMonotonicNs: '200' });
  const before = JSON.stringify(input);
  let validation;
  assert.throws(() => verifyComparisonSelection(input), error => {
    validation = error;
    return /Every actual metadata operation needs its raw SDK result/.test(error.message);
  });
  assert.equal(typeof baselineDriver.catalogSelectionDiagnostics, 'function');
  const diagnostics = baselineDriver.catalogSelectionDiagnostics(input.sources, input.sourceEvents);
  assert.deepEqual(diagnostics.sourceFailures, [{
    requestId: 'sdk:1:source-id', operation: 'list', sourceFile: 'source-results/source-1.json', facet: 'catalog',
    error: { code: 'INVALID_SHARED_SKILL', message: 'Skill ID must be a stable bounded identity.' },
  }]);
  assert.deepEqual(diagnostics.failedSdkOperations, [{
    requestId: 'sdk:1:failed-id', operation: 'list', status: 'failed',
    elapsedMs: 10129, sourceMonotonicNs: '200', error: null,
  }], 'A terminal without a captured error cannot inherit another request failure');
  assert.equal(typeof baselineDriver.catalogSelectionFailureEvidence, 'function');
  const report = { sourceAccounting: { complete: true }, ...diagnostics };
  Object.assign(report, baselineDriver.catalogSelectionFailureEvidence(validation, report));
  assert.equal(report.status, 'failed');
  assert.equal(report.error, 'INVALID_SHARED_SKILL: Skill ID must be a stable bounded identity.');
  assert.deepEqual(report.validationError, { code: 'ERR_ASSERTION', message: validation.message });
  assert.deepEqual(report.sourceAccounting, { complete: true }, 'Complete accounting does not imply successful selection');
  assert.equal(JSON.stringify(input), before, 'Diagnosis must not rewrite the raw result or terminal');
});

test('metadata diagnostics: a successful independent View still passes with its unrelated full failure retained', () => {
  const input = combinedCatalogSelectionProbe(), source = input.sources[0];
  source.file = 'source-results/source-1.json';
  source.value.catalog = { ok: false, error: { code: 'IDENTITY_CONFLICT', message: 'Unrelated full inventory conflict' } };
  const before = JSON.stringify(input);
  assert.equal(typeof baselineDriver.catalogSelectionDiagnostics, 'function');
  const diagnostics = baselineDriver.catalogSelectionDiagnostics(input.sources, input.sourceEvents);
  const checked = verifyComparisonSelection(input);
  assert.equal(checked.source, source);
  assert.equal(checked.directory.records.length, 3);
  assert.equal(diagnostics.sourceFailures[0].error.code, 'IDENTITY_CONFLICT');
  assert.deepEqual(diagnostics.failedSdkOperations, []);
  assert.equal(JSON.stringify(input), before);
});

test('metadata diagnostics: a malformed raw result preserves other source failures and unknown SDK terminals without passing selection', () => {
  const input = combinedCatalogSelectionProbe(), source = input.sources[0];
  source.file = 'source-results/source-1.json';
  source.value.catalog = { ok: false, error: { code: 'INVALID_SHARED_SKILL', message: 'Skill ID must be a stable bounded identity.' } };
  const malformed = { ...structuredClone(source), id: 'malformed', file: 'source-results/source-2.json' };
  delete malformed.value.directory;
  input.sources.push(malformed);
  input.sourceEvents.push(
    { phase: 'started', kind: 'sdk', operation: 'list', requestId: 'sdk:1:malformed' },
    { phase: 'completed', kind: 'sdk', operation: 'list', requestId: 'sdk:1:malformed', status: 'completed' },
    { phase: 'started', kind: 'sdk', operation: 'list', requestId: 'sdk:1:unknown' },
    { phase: 'completed', kind: 'sdk', operation: 'list', requestId: 'sdk:1:unknown', status: 'failed' });
  const before = JSON.stringify(input);
  assert.throws(() => verifyComparisonSelection(input), /Every actual metadata operation needs its raw SDK result/);
  let validation;
  assert.throws(() => verifyComparisonSelection({ ...input,
    sourceEvents: input.sourceEvents.filter(row => row.requestId !== 'sdk:1:unknown'),
  }), error => { validation = error; return /Both combined catalog outcomes are required/.test(error.message); });
  for (const sources of [input.sources, [...input.sources].reverse()]) {
    const diagnostics = baselineDriver.catalogSelectionDiagnostics(sources, input.sourceEvents);
    assert.deepEqual(diagnostics.sourceFailures, [{
      requestId: 'sdk:1:source-id', operation: 'list', sourceFile: 'source-results/source-1.json', facet: 'catalog',
      error: source.value.catalog.error,
    }]);
    assert.deepEqual(diagnostics.sourceDiagnosticErrors, [{
      requestId: 'sdk:1:malformed', operation: 'list', sourceFile: 'source-results/source-2.json',
      error: { code: 'ERR_ASSERTION', message: 'Both combined catalog outcomes are required' },
    }]);
    assert.deepEqual(diagnostics.failedSdkOperations, [{
      requestId: 'sdk:1:unknown', operation: 'list', status: 'failed',
      elapsedMs: null, sourceMonotonicNs: null, error: null,
    }]);
    const report = { ...diagnostics, ...baselineDriver.catalogSelectionFailureEvidence(validation, diagnostics) };
    assert.equal(report.status, 'failed');
    assert.deepEqual(report.validationError, { code: 'ERR_ASSERTION', message: validation.message });
  }
  assert.equal(JSON.stringify(input), before, 'Diagnostic parsing must preserve every raw result and terminal');
});

test('metadata diagnostics: execution errors keep priority and unknown failures do not acquire a source cause', () => {
  assert.equal(typeof baselineDriver.catalogSelectionDiagnostics, 'function');
  assert.equal(typeof baselineDriver.catalogSelectionFailureEvidence, 'function');
  const validation = Object.assign(new Error('Every actual metadata operation needs its raw SDK result'), { code: 'ERR_ASSERTION' });
  const diagnostics = baselineDriver.catalogSelectionDiagnostics([], [{
    phase: 'completed', kind: 'sdk', operation: 'list', requestId: 'sdk:1:unknown', status: 'failed',
  }]);
  const unknown = baselineDriver.catalogSelectionFailureEvidence(validation, diagnostics);
  assert.equal(unknown.status, 'failed');
  assert.equal(unknown.error, validation.message);
  assert.deepEqual(unknown.validationError, { code: 'ERR_ASSERTION', message: validation.message });
  assert.deepEqual(diagnostics.sourceFailures, []);
  assert.equal(diagnostics.failedSdkOperations[0].error, null);
  const execution = 'Actual RPC submission failed before validation';
  const report = { ...diagnostics, error: execution, sourceFailures: [{
    requestId: 'sdk:1:other', sourceFile: 'source-results/source-1.json', facet: 'catalog',
    error: { code: 'INVALID_SHARED_SKILL', message: 'Later known catalog error' },
  }] };
  const before = JSON.stringify(report);
  const outcome = baselineDriver.catalogSelectionFailureEvidence(validation, report);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, execution);
  assert.deepEqual(outcome.validationError, { code: 'ERR_ASSERTION', message: validation.message });
  assert.equal(JSON.stringify(report), before);
});
