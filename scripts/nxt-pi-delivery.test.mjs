import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { nxtTransportSource, reviewNxtCli, nxtModelGuard, validateNxtFixture } from './nxt-pi-delivery.mjs';
import { observer, sourceFinality, closedCliMetrics } from './notion-sdk-pi.mjs';
import { safeRequestMetrics } from './notion-default-context.mjs';

test('published readmes route existing-library setup and combined maintenance before long product details', async () => {
  for (const [file,boundary] of [['README.md','## Why use it'],['README.zh-CN.md','## 为什么使用它']]) {
    // The publishable package copies the repository-root README files during
    // packaging. packages/context-broker/README* are ignored local build
    // outputs and do not exist in a clean GitHub Actions checkout.
    const body=await readFile(new URL('../'+file,import.meta.url),'utf8');
    const intro=body.slice(0,body.indexOf(boundary));
    for(const command of ['/context-broker connect personal ENTRY --config /absolute/config.json',
      'ctl builtin read notion/ntn-skills-maintain --path references/setup.md','ctl library inspect ENTRY',
      'read PAGE_ID --database ENTRY --authoring --read-only','apply RETURNED_PIN --database ENTRY --input DIR --dry-run'])
      assert.ok(intro.includes(command),file+': '+command);
    assert.ok(intro.split('\n').length<55,'The first screen should route without a source or schema crawl');
  }
});

test('SRC19 observation requires an exact enabled owned receipt and cannot reopen the old NXT tasks', () => {
  const source={entry:'4195636c-236e-8104-aafa-f7366fe421ce',target:'41b5636c-236e-81c3-8291-c77b25ac76d1',name:'owned-overlay',refPrefix:'skill://owned/'};
  const config={version:2,kind:'nxt-pi-delivery',scenario:'git-document-overlay',source,tasks:[{id:'read-use',prompts:['Inspect the selected documents without edits.']}]};
  const receipt={ok:true,status:'applied',record:{kind:'skill',enabled:true,name:source.name,ref:'skill://owned/SKILL.md',locator:{type:'shared_skill',database_id:source.entry,page_id:source.target}}};
  validateNxtFixture(config,receipt);
  for(const mutate of [x=>x.record.enabled=false,x=>x.status='planned',x=>x.record.locator.page_id='foreign',x=>x.record.locator.database_id='foreign',x=>x.record.ref='skill://foreign/SKILL.md']) {
    const changed=structuredClone(receipt);mutate(changed);assert.throws(()=>validateNxtFixture(config,changed));
  }
  for(const change of [{version:3},{scenario:'arbitrary'},{tasks:[{id:'maintenance',prompts:['Write.']}]},{tasks:[{id:'read-use',prompts:['Read.','Read again.']}]}])
    assert.throws(()=>validateNxtFixture({...config,...change},receipt));
  const legacy={version:1,kind:'nxt-pi-delivery',source:{entry:source.entry,target:'4195636c-236e-81e0-be28-ed9a783bd84a',name:'nxt-journey'}};
  validateNxtFixture(legacy);assert.throws(()=>validateNxtFixture({...legacy,source}));
});

test('NXT owned natural maintenance fixture is one new explicitly proven page, not the already modified historical target', () => {
  const source={id:'nxt',entry:'4195636c-236e-8104-aafa-f7366fe421ce',target:'4195636c-236e-81e0-be28-ed9a783bd84a',name:'nxt-journey'};
  const page='41c5636c-236e-8101-aabb-ccddeeff9988',path='/owned/create-apply.json',sha256='a'.repeat(64);
  const prefix='skill://shared_skill%3Alibrary-1%3Askill-1/';
  const task={id:'maintenance',target:page,refPrefix:prefix,input:'/owned/new-input',ownership:{path,sha256},
    inputFiles:[{path:'/owned/new-input/SKILL.md'},{path:'/owned/new-input/references/model-maintenance.md'}],
    prompts:['Maintain the owned page.'],expected:{changed:['SKILL.md'],added:['references/model-maintenance.md'],otherFiles:'unchanged',remoteWrites:'not_started'}};
  const config={version:3,kind:'nxt-pi-delivery',scenario:'owned-natural-maintenance',source,
    tasks:[task],fixtureReceipt:{path,sha256}};
  const receipt={ok:true,verified:true,create_operation_id:'skill-create-'+'b'.repeat(64),
    record:{kind:'skill',enabled:true,name:'nxt-natural-maintenance-20261117',ref:prefix+'SKILL.md',
      locator:{type:'shared_skill',database_id:source.entry,page_id:page}},
    file_bindings:[{path:'SKILL.md'},{path:'references/baseline.md'}]};
  validateNxtFixture(config,receipt);
  const measured={...config,version:4,commandOutputProof:1};
  const newReceipt={...receipt,record:{...receipt.record,name:'nxt-daily-performance-20261117'}};
  validateNxtFixture(measured,newReceipt);
  assert.throws(()=>validateNxtFixture({...measured,commandOutputProof:undefined},newReceipt));
  assert.throws(()=>validateNxtFixture(measured,receipt));
  validateNxtFixture({...measured,fixtureName:'nxt-daily-performance-20261117-host'},
    {...newReceipt,record:{...newReceipt.record,name:'nxt-daily-performance-20261117-host'}});
  assert.throws(()=>validateNxtFixture({...measured,fixtureName:'foreign-production'},newReceipt));
  assert.throws(()=>validateNxtFixture({...measured,fixtureName:'nxt-daily-performance-20261117-host'},newReceipt));
  for(const mutate of [
    x=>x.verified=false,x=>x.record.enabled=false,x=>x.record.name='nxt-model-maintenance',
    x=>x.record.locator.page_id='4195636c-236e-81e8-b798-cf623fd25118',
    x=>x.record.locator.database_id='foreign',x=>x.file_bindings.push({path:'references/model-maintenance.md'}),
  ]){const invalid=structuredClone(receipt);mutate(invalid);assert.throws(()=>validateNxtFixture(config,invalid));}
  for(const changed of [{scenario:'git-document-overlay'},{tasks:[{...task,id:'onboarding'}]},
    {tasks:[{...task,ownership:{path:'/foreign',sha256}}]},
    {tasks:[{...task,inputFiles:task.inputFiles.slice(0,1)}]}])
    assert.throws(()=>validateNxtFixture({...config,...changed},receipt));
});

test('NXT real fetch boundary refuses invalid model, output cap and request eleven before dispatch', async t => {
  const base = await mkdtemp(join(tmpdir(), 'nxt-pi-budget-')), controlPath = join(base, 'control.json'), preload = join(base, 'transport.mjs');
  await writeFile(controlPath, '{}'); await writeFile(preload, nxtTransportSource({ controlPath, output: base, model: 'group/worker' }));
  let received = 0;
  const server = createServer((request, response) => { request.resume(); request.once('end', () => { received++; response.end('{}'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const script = join(base, 'exercise.mjs');
  await writeFile(script, `import assert from 'node:assert/strict';import fs from 'node:fs';
const originalFetch=globalThis.fetch;await import(${JSON.stringify(preload)});
// Installed Pi configures Undici after preloads and replaces global fetch.
globalThis.fetch=originalFetch;globalThis[Symbol.for('nxt-pi-delivery.transport')]();
const request=body=>fetch(${JSON.stringify(url)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const body={model:'group/worker',max_completion_tokens:4096,messages:[{role:'user',content:'controlled budget test'}]};
await assert.rejects(request({...body,model:'unapproved'}),/NXT_MODEL_NOT_AUTHORIZED/);
await assert.rejects(request({...body,max_completion_tokens:4097}),/NXT_OUTPUT_BUDGET_NOT_APPLIED/);
for(let i=0;i<10;i++){const response=await request(body);await response.text();}
await assert.rejects(request(body),/NXT_REQUEST_BUDGET_EXHAUSTED/);
fs.writeFileSync(${JSON.stringify(controlPath)},JSON.stringify({failRefresh:true}));
await assert.rejects(fetch('https://api.notion.com/v1/users/me'),/NXT_CONTROLLED_REFRESH_TRANSPORT_FAILURE/);
`);
  try {
    await promisify(execFile)(process.execPath, [script], { env: { PATH: process.env.PATH, HOME: base }, timeout: 30000 });
    assert.equal(received, 10);
    const ledger = (await readFile(join(base, 'transport.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(ledger.filter(row => row.phase === 'request').length, 10);
    assert.equal(ledger.filter(row => row.phase === 'headers' && row.status === 200).length, 10);
    assert.equal(ledger.filter(row => row.phase === 'budget-refused' && row.dispatched === false).length, 1);
    assert.equal(ledger.filter(row => row.phase === 'controlled-source-failure' && row.dispatched === false).length, 1);
    assert.equal(ledger.filter(row => row.phase === 'transport-installed').length, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
  t.diagnostic('Owned local-only transport evidence retained: ' + base);
});

const policy = { task: 'maintenance', node: '/node', cli: '/owned/ntn-skills.mjs', database: 'db', target: 'page',
  refPrefix: 'skill://owner/', input: '/owned/input', description: 'exact', readFiles: [] };
const pin = 'skill://owner/SKILL.md?snapshot=s_' + 'a'.repeat(64);
const apply = `node /owned/ntn-skills.mjs apply '${pin}' --database db --input /owned/input`;

test('NXT public package listing and help composition admit the three readonly cold-onboarding commands', () => {
  const policy = { task: 'onboarding', node: '/node', cli: '/owned/package/dist/ntn-skills.mjs', database: 'db',
    listPaths: ['/owned/package', '/owned/package/dist'], readFiles: ['/owned/package/package.json', '/owned/config.json'] };
  const cli = 'node ' + policy.cli;
  for (const command of [
    'ls -la /owned/package && ls -la /owned/package/dist 2>/dev/null | head -100',
    'ls -la "/owned/package/dist" ; echo "---PKG---"; ls -la "/owned/package"',
    cli + ' ctl library --help && echo "===== CONFIG =====" && ' + cli + ' ctl config --help && echo "===== DATABASE =====" && ' + cli + ' ctl database --help && echo "===== STATUS =====" && ' + cli + ' ctl status --help && echo "===== DOCTOR =====" && ' + cli + ' ctl doctor --help',
  ]) assert.equal(reviewNxtCli(command, policy).kind, 'readonly-shell');
  for (const command of [
    'ls -la /external', 'ls -la /owned/package/../../private', 'ls /owned/package/unknown-link/../dist', 'cat /private/credentials',
    'ls /owned/package > /owned/config.json', 'ls /owned/package 2>/private/output',
    'ls /owned/package | head -100 /private/credentials', 'ls /owned/package | sh',
    'ls "$(cat /private/credentials)"', 'ls /owned/package & echo done',
    'node"" ' + policy.cli + ' --help',
  ]) assert.throws(() => reviewNxtCli(command, policy), command);
  assert.throws(() => reviewNxtCli(apply + ' && echo done', { ...policy, task: 'maintenance', cli: '/owned/ntn-skills.mjs', target: 'page', refPrefix: 'skill://owner/', input: '/owned/input' }));
});

test('NXT native public reads admit the two rejected owned paths and refuse external files, credentials and symlink escape', async t => {
  const base = await mkdtemp(join(tmpdir(), 'nxt-pi-read-guard-')), root = fs.realpathSync(base);
  const manifest = join(root, 'package.json'), config = join(root, 'config.json'), credentials = join(root, 'credentials.json'), escape = join(root, 'escape.json');
  await writeFile(manifest, '{"name":"owned-test"}'); await writeFile(credentials, '{"test":"not a real secret"}'); fs.symlinkSync(credentials, escape);
  const handlers = new Map(), ledger = [], policy = { task: 'onboarding', readFiles: [manifest, config, escape], listPaths: [root] };
  nxtModelGuard({ on: (name, handler) => handlers.set(name, handler) }, { fs: { ...fs, appendFileSync: (_path, value) => ledger.push(JSON.parse(value)) },
    policy, output: '/owned/guard.jsonl', reviewCli: reviewNxtCli, reviewNative: () => { throw new Error('unselected'); } });
  const read = path => handlers.get('tool_call')({ toolName: 'read', toolCallId: path, input: { path } }, {});
  assert.equal(read(config), undefined, 'The native reader reports the missing owned config normally'); assert.equal(read(manifest), undefined);
  assert.equal(handlers.get('tool_call')({ toolName: 'read', toolCallId: 'batch', input: { paths: [manifest, config] } }, {}), undefined);
  for (const path of [credentials, escape, root + '/unknown-link/../package.json', '/Users/yoyo/.pi/agent/models.json', '/Users/yoyo/.config/ntn-skills/config.json']) assert.equal(read(path).block, true);
  assert.deepEqual(ledger.slice(0, 3).map(row => row.allowed), [true, true, true]);
  t.diagnostic('Owned public-read guard evidence retained: ' + root);
});

test('NXT model CLI guard binds actual apply to the separately owned pin and frozen input', () => {
  assert.equal(reviewNxtCli(apply, policy).kind, 'apply');
  assert.equal(reviewNxtCli(apply + ' --dry-run', policy).kind, 'apply-preview');
  assert.throws(() => reviewNxtCli(apply + ' --dry-run --compact', policy),
    'A strict HTTP source audit cannot use a presentation receipt missing the per-attempt trace');
  assert.throws(() => reviewNxtCli(apply + ' --compact', policy),
    'The existing fixed-budget NXT acceptance requires the complete default transport trace');
  assert.equal(reviewNxtCli(apply + ' --compact', { ...policy, commandOutputProof: 1 }).kind, 'apply');
  assert.equal(reviewNxtCli(apply + ' --dry-run --compact', { ...policy, commandOutputProof: 1 }).kind, 'apply-preview');
  assert.throws(() => reviewNxtCli(apply + ' --compact', { ...policy, commandOutputProof: 2 }));
  assert.throws(() => reviewNxtCli('node /owned/ntn-skills.mjs read page --database db --read-only --compact', policy));
  for (const wrong of [apply.replace('owner/', 'foreign/'), apply.replace('/owned/input', '/global'), apply.replace(pin, 'page'), apply + '; echo escaped', apply + ' --remove SKILL.md'])
    assert.throws(() => reviewNxtCli(wrong, policy));
  assert.throws(() => reviewNxtCli(apply, { ...policy, task: 'onboarding' }));
});

test('compact apply output never masquerades as a complete NXT request ledger', () => {
  const full = {
    trace_enabled: true,
    trace_dropped: 0,
    total_requests: 1,
    trace: [{
      event: 'attempt', attempt: 1, kind: 'notion_metadata',
      method: 'GET', outcome: 'success', started_ms: 0, duration_ms: 2,
      request_bytes: 0, response_bytes: 364, http_status: 200,
      retry_after_seconds: null, request_id: null, rate_limit_reason: null, target: null,
    }],
  };
  assert.equal(safeRequestMetrics(full).complete, true);
  const compact = { ...full, trace: undefined, trace_omitted_from_output: true, trace_entries: 1 };
  assert.equal(safeRequestMetrics(compact), undefined,
    'An output presentation with only aggregate counts has unknown per-request proof, not zero requests');
  assert.equal(safeRequestMetrics({ ...full, trace: [], trace_omitted_from_output: true })?.complete, false);
});

test('a closed compact Node command retains its complete independent ledger only with exact original stdout and process proof', async t => {
  const base=await mkdtemp(join(tmpdir(),'nxt-compact-proof-')), preload=join(base,'observer.mjs'),ledger=join(base,'source.jsonl');
  await observer(preload);
  const metrics={trace_enabled:true,trace_dropped:0,total_requests:1,trace:[{
    event:'attempt',attempt:1,kind:'notion_metadata',method:'GET',outcome:'success',started_ms:0,duration_ms:2,
    request_bytes:0,response_bytes:364,http_status:200,retry_after_seconds:null,request_id:null,rate_limit_reason:null,target:null,
  }]};
  const cli=join(base,'owned-cli.mjs'),host=join(base,'host.mjs');
  const body='NOT_A_SECRET_DO_NOT_COPY_BODY_TO_DIAGNOSTICS';
  await writeFile(cli,`import {channel} from 'node:diagnostics_channel';import{createHash}from'node:crypto';
const output=JSON.stringify({ok:true,status:'applied',verified:true,content:${JSON.stringify(body)},request_metrics:{total_requests:1,trace_omitted_from_output:true,trace_entries:1}})+'\\n';
channel('ntn-skills.command-output').publish({version:1,event:'result',operation:'apply',status:'applied',projected:true,output_sha256:createHash('sha256').update(output).digest('hex'),output_bytes:Buffer.byteLength(output),request_metrics:${JSON.stringify(metrics)}});
process.stdout.write(output);\n`);
  await writeFile(host,`import {spawn}from'node:child_process';await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[${JSON.stringify(cli)}],{stdio:['ignore','pipe','pipe']});child.stdout.resume();child.stderr.resume();child.once('error',reject);child.once('close',resolve);});\n`);
  await promisify(execFile)(process.execPath,[host],{env:{PATH:process.env.PATH,HOME:base,SC10_PI_OBSERVER:ledger,SC10_PI_BUNDLED_CLI:cli,NODE_OPTIONS:'--import='+preload},timeout:30000});
  const raw=await readFile(ledger,'utf8'),events=raw.trim().split('\n').map(JSON.parse),pid=events[0].observer_pid;
  assert.equal(raw.includes(body),false,'The independent ledger excludes author content');
  assert.equal(sourceFinality(events,pid,{hostClosed:true}).complete,true);
  const close=events.find(row=>row.kind==='child_close'),diagnostic=events.find(row=>row.kind==='cli_result');
  assert.equal(close.request_metrics,null,'Compact stdout alone still proves no complete trace');
  assert.equal(diagnostic.projected,true);
  assert.equal(closedCliMetrics(events,close).total_requests,1);
  assert.deepEqual(closedCliMetrics(events,close).trace,safeRequestMetrics(metrics).trace);
  for(const changed of [
    events.filter(row=>row.kind!=='cli_result'),events.filter(row=>!(row.kind==='observer_end'&&row.observer_pid===diagnostic.observer_pid)),
    [...events,diagnostic],events.map(row=>row===diagnostic?{...row,output_sha256:'0'.repeat(64)}:row),
    events.map(row=>row===diagnostic?{...row,output_bytes:diagnostic.output_bytes+1}:row),
    events.map(row=>row===diagnostic?{...row,request_metrics:{...row.request_metrics,complete:false}}:row),
    events.map(row=>row===diagnostic?{...row,request_metrics:{...row.request_metrics,total_requests:2}}:row),
    events.map(row=>row===diagnostic?{...row,request_metrics:{...row.request_metrics,trace:[]}}:row),
    events.map(row=>row===diagnostic?{...row,observer_pid:999999}:row),
  ])assert.equal(closedCliMetrics(changed,close),undefined);
  assert.equal(closedCliMetrics(events,{...close,code:1}),undefined);
  assert.equal(closedCliMetrics(events,{...close,signal:'SIGTERM'}),undefined);
  assert.equal(closedCliMetrics(events,{...close,request_metrics:{...diagnostic.request_metrics,total_requests:99}}),undefined);
  t.diagnostic('Original independent Node stdout/ledger fixture: '+base);
});

test('NXT public read output flags are not authority and exact maintenance authoring permits its retained history', () => {
  const read = 'node /owned/ntn-skills.mjs read page --database db';
  assert.equal(reviewNxtCli(read + ' --authoring', policy).kind, 'read');
  assert.equal(reviewNxtCli(read + ' --authoring --json', policy).kind, 'read');
  assert.equal(reviewNxtCli(read + ' --read-only', { ...policy, task: 'read-use' }).kind, 'read');
  assert.equal(reviewNxtCli(read + ' --authoring --read-only', { ...policy, task: 'read-use' }).kind, 'read');
  assert.equal(reviewNxtCli('node /owned/ntn-skills.mjs list --database db', policy).kind, 'list');
  for (const command of [read, read + ' --authoring', read + ' --json'])
    assert.throws(() => reviewNxtCli(command, { ...policy, task: 'read-use' }));
  for (const command of [read.replace('read page', 'read foreign') + ' --authoring',
    read.replace('read page', "read '" + pin + "'") + ' --authoring', read + ' --output /tmp/unowned',
    read + ' --authoring > /tmp/unowned', read + ' --authoring --database foreign'])
    assert.throws(() => reviewNxtCli(command, policy), command);
  assert.throws(() => reviewNxtCli(read, policy), 'Only explicit authoring may retain remote history for this maintenance task');
});

test('NXT public redacted diagnostics require the frozen isolated roots and do not enable other ctl actions', () => {
  const isolated = { ...policy, ownedRoot: '/owned/run', localRoots: { config: '/owned/run/ntn/config', state: '/owned/run/ntn/state', cache: '/owned/run/ntn/cache', data: '/owned/run/ntn/data' } };
  for (const args of ['ctl status', 'ctl config show']) {
    const command = 'node /owned/ntn-skills.mjs ' + args;
    assert.equal(reviewNxtCli(command, isolated).kind, 'local-diagnostics');
    assert.throws(() => reviewNxtCli(command, policy));
    assert.throws(() => reviewNxtCli(command, { ...isolated, localRoots: { ...isolated.localRoots, config: '/Users/yoyo/.config' } }));
  }
  for (const command of ['node /owned/ntn-skills.mjs ctl config set-token --stdin', 'node /owned/ntn-skills.mjs ctl config show --path /private',
    'node /owned/ntn-skills.mjs ctl doctor --database db', 'printenv', 'node -e "process.env"', 'cat /private/credentials',
    'CLI=/owned/ntn-skills.mjs; node "$CLI" --help', 'find /owned/run -type f -print', 'node /owned/ntn-skills.mjs ctl status\nprintenv'])
    assert.throws(() => reviewNxtCli(command, isolated), command);
});

test('NXT model author guard admits one apply and records subsequent refusal', () => {
  const handlers = new Map(), ledger = [];
  nxtModelGuard({ on: (name, handler) => handlers.set(name, handler) }, { fs: { appendFileSync: (_path, value) => ledger.push(JSON.parse(value)) },
    policy, output: '/owned/guard.jsonl', reviewCli: reviewNxtCli, reviewNative: () => { throw new Error('unselected'); } });
  const event = { toolName: 'bash', toolCallId: 'once', input: { command: apply } };
  assert.equal(handlers.get('tool_call')(event, {}), undefined);
  assert.equal(handlers.get('tool_call')({ ...event, toolCallId: 'twice' }, {}).block, true);
  assert.deepEqual(ledger.map(row => row.allowed), [true, false]);
});

test('NXT approved readonly shells seal actual Node descendants while foreign, unfinished and missing-parent processes remain open', async t => {
  const base = await mkdtemp(join(tmpdir(), 'nxt-pi-shell-finality-')), preload = join(base, 'observer.mjs'), ledger = join(base, 'source.jsonl');
  await observer(preload);
  const child = join(base, 'child.mjs'), host = join(base, 'host.mjs');
  await writeFile(child, "process.stdout.write('owned local metadata');\n");
  const command = [process.execPath + ' ' + child, process.execPath + ' ' + child, 'echo done'].join('; ');
  const list = 'ls -la ' + base;
  await writeFile(host, `import {spawn} from 'node:child_process';
for(const command of ${JSON.stringify([command, list])})await new Promise((resolve,reject)=>{const child=spawn('/bin/bash',['-c',command]);child.stdout.resume();child.stderr.resume();child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('Local child failed')));});\n`);
  await promisify(execFile)(process.execPath, [host], { env: { PATH: process.env.PATH, HOME: base,
    SC10_PI_OBSERVER: ledger, NODE_OPTIONS: '--import=' + preload }, timeout: 30000 });
  const events = (await readFile(ledger, 'utf8')).trim().split('\n').map(JSON.parse), hostPid = events[0].observer_pid;
  const options = { hostClosed: true, approvedShellCommands: [{ command, nodeProcesses: 2 }, { command: list, nodeProcesses: 0 }] };
  assert.equal(sourceFinality(events, hostPid, { hostClosed: true }).complete, false, 'The original direct-child-only contract stays strict');
  assert.equal(sourceFinality(events, hostPid, options).complete, true);
  const forked = events.find(event => event.kind === 'observer_start' && event.observer_pid !== hostPid);
  assert.ok(forked && events.some(event => event.kind === 'child_spawn' && event.child_pid === forked.parent_pid));
  const foreign = 2147483000;
  for (const changed of [
    events.filter(event => !(event.kind === 'observer_end' && event.observer_pid === forked.observer_pid)),
    events.filter(event => !(event.kind === 'observer_start' && event.observer_pid === forked.observer_pid)),
    events.filter(event => !(event.kind === 'child_spawn' && event.child_pid === forked.parent_pid)),
    events.filter(event => !(event.kind === 'child_close' && event.child_pid === forked.parent_pid)),
    events.map(event => event === forked ? { ...event, parent_pid: foreign } : event),
    [...events, { kind: 'observer_start', observer_pid: foreign, parent_pid: hostPid }, { kind: 'observer_end', observer_pid: foreign, active_sdk: 0, active_children: 0 }],
    [...events, { kind: 'observer_start', observer_pid: foreign, parent_pid: forked.parent_pid }, { kind: 'observer_end', observer_pid: foreign, active_sdk: 0, active_children: 0 }],
    [...events, { kind: 'alternate_child_api', observer_pid: hostPid, api: 'execFile' }],
  ]) assert.equal(sourceFinality(changed, hostPid, options).complete, false);
  assert.equal(sourceFinality(events, hostPid, { ...options, approvedShellCommands: [{ command: list, nodeProcesses: 0 }] }).complete, false);
  t.diagnostic('Local actual process-tree evidence retained: ' + base);
});

test('SRC19 seals only its hash-bound SDK credential child, redacts stdout, and rejects missing or foreign process proof', async t => {
  const base=await mkdtemp(join(tmpdir(),'src19-gh-probe-')), executable=join(base,'gh'), preload=join(base,'observer.mjs'), ledger=join(base,'source.jsonl');
  const secret='LOCAL_TEST_CREDENTIAL_NOT_REAL';
  await writeFile(executable, '#!/bin/sh\nprintf '+secret+'\nexit 1\n', {mode:0o700});
  const probe={executable,identity:fs.realpathSync(executable),sha256:createHash('sha256').update(await readFile(executable)).digest('hex')};
  await observer(preload,{gitCredentialProbe:probe});
  const host=join(base,'host.mjs');
  await writeFile(host,`import {spawn} from 'node:child_process';import {channel} from 'node:diagnostics_channel';
const event={id:'owned-sdk',operation:'consume'};channel('context-broker.notion-sdk').publish({...event,event:'start'});
await new Promise((resolve,reject)=>{const child=spawn('gh',['auth','token','--hostname','github.com']);child.stdout.resume();child.stderr.resume();child.once('error',reject);child.once('close',()=>resolve());});
channel('context-broker.notion-sdk').publish({...event,event:'end',status:'completed'});\n`);
  await promisify(execFile)(process.execPath,[host],{env:{PATH:base,HOME:base,SC10_PI_OBSERVER:ledger,NODE_OPTIONS:'--import='+preload},timeout:30000});
  const raw=await readFile(ledger,'utf8'),events=raw.trim().split('\n').map(JSON.parse),pid=events[0].observer_pid,options={hostClosed:true,gitCredentialProbe:probe};
  assert.equal(raw.includes(secret),false);assert.equal(raw.includes(createHash('sha256').update(secret).digest('hex')),false);
  assert.equal(sourceFinality(events,pid,{hostClosed:true}).complete,false);
  const complete=sourceFinality(events,pid,options);assert.equal(complete.complete,true);assert.equal(complete.native_credential_probes.length,1);
  for(const changed of [events.filter(e=>e.kind!=='child_close'),events.filter(e=>e.kind!=='child_spawn'),events.filter(e=>!(e.kind==='sdk'&&e.event==='end')),
    events.map(e=>e.kind==='child_start'?{...e,argv:['api','user']}:e),events.map(e=>e.kind==='child_start'?{...e,credential_probe:{...e.credential_probe,sha256:'0'.repeat(64)}}:e),
    events.map(e=>e.kind==='child_close'?{...e,signal:'SIGTERM'}:e)])assert.equal(sourceFinality(changed,pid,options).complete,false);
  t.diagnostic('Owned synthetic native credential process proof: '+base);
});
