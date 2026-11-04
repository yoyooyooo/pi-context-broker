import assert from 'node:assert/strict';
import test from 'node:test';
import * as diagnostics from 'node:diagnostics_channel';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import { errorMonitor } from 'node:events';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { safeRequestMetrics } from './notion-default-context.mjs';
import { observeSourceTransport, sourceObserverPreloadSource, readSourceObservation } from './skill-consumption-source-observer.mjs';
import { settleSource } from './skill-consumption-model-baseline.mjs';

const secret = 'private-source-marker', privateUrl = 'https://private.example/secret-source';
function requestMetrics() {
  const attempt = (number, status, responseBytes) => ({ event: 'attempt', attempt: number, kind: 'notion_metadata', method: 'POST',
    started_ms: number * 10, duration_ms: 4, outcome: status === 200 ? 'success' : 'failure',
    request_bytes: 12, response_bytes: responseBytes, http_status: status, request_id: privateUrl,
    rate_limit_reason: null, retry_after_seconds: status === 429 ? 0.005 : null, privateBody: secret });
  return { trace_enabled: true, total_requests: 2, trace_dropped: 0,
    trace: [{ event: 'wait', kind: 'queue', milliseconds: 2.5 }, attempt(1, 429, 9),
      { event: 'wait', kind: 'retry', milliseconds: 5 }, attempt(2, 200, 11)], credentials: secret };
}
function fixture({ metrics = requestMetrics(), body = secret, code = 7 } = {}) {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'consumption-source-test-'));
  const cli = path.join(base, 'cli.mjs'), output = path.join(base, 'source.jsonl');
  fs.writeFileSync(cli, 'const value=' + JSON.stringify({ request_metrics: metrics, body }) + ';\n'
    + 'value.args=process.argv.slice(2); value.credential=process.env.SOURCE_TEST_SECRET;\n'
    + 'process.stdout.write(JSON.stringify(value)+"\\n"); process.exitCode=' + code + ';\n', { mode: 0o600 });
  return { base, cli, output };
}
function observe(item, extra = {}) {
  return observeSourceTransport({ diagnostics, fs, crypto, path, output: item.output, cliPath: item.cli,
    checkoutRoot: process.cwd(), clockId: 'source-test', safeRequestMetrics, errorMonitor, ...extra });
}
function consume(file, args, env = process.env) {
  const child = cp.spawn(process.execPath, [file, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
  });
}

test('public spawn observation preserves exact argv, environment, stdout, exit and spawn function while retaining retries', async t => {
  const item = fixture(), spawn = cp.spawn, args = ['list', privateUrl], env = { ...process.env, SOURCE_TEST_SECRET: secret };
  const expected = await consume(item.cli, args, env);
  const observer = observe(item); t.after(observer.finish);
  const actual = await consume(item.cli, args, env); observer.finish();
  assert.deepEqual(actual, expected); assert.equal(actual.code, 7); assert.equal(cp.spawn, spawn);
  assert.deepEqual(JSON.parse(actual.stdout).args, args); assert.equal(JSON.parse(actual.stdout).credential, secret);
  const trace = await readSourceObservation(item.output);
  assert.equal(trace.complete, true); assert.deepEqual(trace.errors, []);
  assert.equal(trace.events.filter(row => row.phase === 'started' && row.kind === 'cli').length, 1);
  assert.equal(trace.events.filter(row => row.phase === 'child-started').length, 1);
  assert.deepEqual(trace.events.filter(row => row.phase === 'attempt').map(row => [row.attempt, row.http_status, row.response_bytes]), [[1,429,9],[2,200,11]]);
  assert.deepEqual(trace.events.filter(row => row.phase === 'wait').map(row => [row.wait_kind,row.milliseconds]), [['queue',2.5],['retry',5]]);
  const end = trace.events.find(row => row.phase === 'completed');
  assert.equal(end.code, 7); assert.equal(end.signal, null); assert.equal(end.stdoutComplete, true);
  assert.equal(end.stdoutBytes, Buffer.byteLength(actual.stdout));
  assert.equal(end.stdoutSha256, crypto.createHash('sha256').update(actual.stdout).digest('hex'));
  const raw = fs.readFileSync(item.output, 'utf8');
  for (const value of [secret, privateUrl, item.cli]) assert.equal(raw.includes(value), false);
  assert.equal(fs.statSync(item.output).mode & 0o777, 0o600);
});

test('an unconsumed stdout remains paused and unobserved; overflow and absent metrics stay unknown', async t => {
  const item = fixture(), observer = observe(item); t.after(observer.finish);
  const child = cp.spawn(process.execPath, [item.cli, 'list'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await new Promise(resolve => child.once('spawn', resolve));
  assert.equal(child.stdout.readableFlowing, null); assert.equal(child.stdout.listenerCount('data'), 0);
  child.stdout.resume(); // The caller elects to drain only after the passive check.
  await closed; observer.finish();
  const rows = (await readSourceObservation(item.output)).events;
  assert.equal(rows.find(row => row.phase === 'completed').stdoutObserved, false);
  assert.equal(rows.find(row => row.phase === 'metrics').total_requests, null);
  for (const [name, config, extra] of [['overflow', { body: 'x'.repeat(2048) }, { maxStdoutBytes: 128 }], ['absent', { metrics: null }, {}]]) {
    await t.test(name, async () => {
      const local = fixture(config), current = observe(local, extra);
      try { await consume(local.cli, ['list']); } finally { current.finish(); }
      const events = (await readSourceObservation(local.output)).events;
      const metric = events.find(row => row.phase === 'metrics');
      assert.equal(metric.observed, false); assert.equal(metric.complete, false); assert.equal(metric.total_requests, null);
      assert.equal(events.find(row => row.phase === 'completed').stdoutOverflow, name === 'overflow');
    });
  }
});

function publishSdk(id, event, extra = {}) {
  const value = { version: 1, id, event, operation: 'consume', pid: process.pid, monotonic_ns: process.hrtime.bigint().toString(), ...extra };
  const before = JSON.stringify(value);
  diagnostics.channel('context-broker.notion-sdk').publish(Object.freeze(value));
  assert.equal(JSON.stringify(value), before);
}
test('SDK observations retain explicit zero-attempt metrics and failed or pending calls without mutating diagnostics', async t => {
  const item = fixture(), observer = observe(item); t.after(observer.finish);
  const zero = crypto.randomUUID(), failure = crypto.randomUUID(), pending = crypto.randomUUID();
  publishSdk(zero, 'start');
  publishSdk(zero, 'end', { elapsed_ms: 0, status: 'completed', sdk_started: true, metrics_observed: true,
    request_metrics: { trace_enabled: true, total_requests: 0, trace_dropped: 0, trace: [] } });
  publishSdk(failure, 'start');
  publishSdk(failure, 'end', { elapsed_ms: 3, status: 'failed', sdk_started: false, metrics_observed: false, request_metrics: null });
  publishSdk(pending, 'start'); observer.finish();
  const trace = await readSourceObservation(item.output);
  assert.equal(trace.complete, false); assert.deepEqual(trace.errors, []);
  const metric = id => trace.events.find(row => row.phase === 'metrics' && row.requestId.endsWith(id));
  assert.equal(metric(zero).total_requests, 0); assert.equal(metric(zero).complete, true);
  assert.equal(metric(failure).total_requests, null); assert.equal(metric(failure).observed, false);
  assert.equal(trace.events.find(row => row.phase === 'completed' && row.requestId.endsWith(failure)).status, 'failed');
  assert.deepEqual(trace.events.at(-1).pendingRequestIds, ['sdk:' + process.pid + ':' + pending]);
  assert.equal(trace.events.at(-1).sdkStarts, 3); assert.equal(trace.events.at(-1).cliStarts, 0);
});

test('evidence write failure cannot escape a source event or change host exit behavior', async () => {
  const item = fixture(); let writes = 0;
  const observer = observe(item, { fs: { ...fs, writeSync(...args) {
    if (writes++ > 0) throw new Error('fixture disk failure');
    return fs.writeSync(...args);
  } } });
  assert.doesNotThrow(() => publishSdk(crypto.randomUUID(), 'start'));
  assert.doesNotThrow(observer.finish);
  const trace = await readSourceObservation(item.output);
  assert.equal(trace.complete, false); assert.ok(trace.errors.includes('missing-end-boundary'));
});

test('serialized preload runs only in the intended owner and leaves the inheriting CLI child unchanged', async () => {
  const item = fixture({ code: 0 }), owner = path.join(item.base, 'owner.mjs'), preload = path.join(item.base, 'preload.mjs');
  fs.writeFileSync(owner, "import {spawn} from 'node:child_process';\nconst child=spawn(process.execPath,[" + JSON.stringify(item.cli)
    + ",'list'],{stdio:['ignore','pipe','pipe']}); child.stdout.on('data',chunk=>process.stdout.write(chunk));"
    + "child.stderr.on('data',chunk=>process.stderr.write(chunk));child.on('error',()=>{process.exitCode=90});child.on('close',code=>{process.exitCode=code});\n");
  fs.writeFileSync(preload, sourceObserverPreloadSource({ output: item.output, checkoutRoot: process.cwd(), clockId: 'preload-test',
    cliPath: item.cli, ownerEntry: owner, ownerParentPid: process.pid }));
  const expected = await consume(owner, [], { ...process.env, NODE_OPTIONS: '', SOURCE_TEST_SECRET: secret });
  const actual = await consume(owner, [], { ...process.env, NODE_OPTIONS: '--import=' + pathToFileURL(preload).href, SOURCE_TEST_SECRET: secret });
  assert.deepEqual(actual, expected);
  const trace = await readSourceObservation(item.output);
  assert.equal(trace.complete, true); assert.equal(trace.events.filter(row => row.phase === 'source_observer_start').length, 1);
  assert.equal(trace.events.at(-1).operations, 1); assert.equal(trace.events.at(-1).cliStarts, 1);
});

function reseal(rows) {
  let previous = null;
  return rows.map((row, index) => {
    const { eventSha256, ...body } = row;
    const next = { ...body, sequence: index + 1, previousSha256: previous };
    previous = crypto.createHash('sha256').update(JSON.stringify(next)).digest('hex');
    return { ...next, eventSha256: previous };
  });
}
test('partial, malformed, missing-attempt and missing-close ledgers remain available but cannot pass completeness', async t => {
  const item = fixture(), observer = observe(item); await consume(item.cli, ['list']); observer.finish();
  const original = fs.readFileSync(item.output, 'utf8'), trace = (await readSourceObservation(item.output)).events;
  const cases = [
    ['partial-line', original.slice(0, -1)], ['null', 'null\n'], ['array', '[]\n'], ['invalid-json', '{\n'],
    ['missing-end', trace.slice(0, -1)],
    ['missing-attempt', reseal(trace.filter(row => row.phase !== 'attempt' || row.attempt !== 2))],
    ['missing-close', reseal(trace.filter(row => row.phase !== 'completed'))],
    ['wrong-clock', reseal(trace.map(row => row.phase === 'metrics' ? { ...row, clockId: 'another' } : row))],
    ['duplicate-close', reseal(trace.flatMap(row => row.phase === 'completed' ? [row, row] : [row]))],
  ];
  for (const [name, rows] of cases) await t.test(name, async () => {
    const file = path.join(item.base, name + '.jsonl');
    const raw = typeof rows === 'string' ? rows : rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    fs.writeFileSync(file, raw);
    const result = await readSourceObservation(file);
    assert.equal(result.complete, false); assert.ok(result.errors.length > 0);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  });
  const missing = await readSourceObservation(path.join(item.base, 'never-started.jsonl'));
  assert.equal(missing.complete, false); assert.deepEqual(missing.events, []);
  assert.throws(() => observe(item, { output: path.join(item.base, 'rejected.jsonl'), checkoutRoot: item.base }), /OUTSIDE_CHECKOUT/);
});

function localChild(file, args, options = {}) {
  const child = cp.spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const stdout = [], stderr = [], errors = [];
  child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
  child.on('error', error => errors.push(error.code));
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({
    code, signal, errors, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
  })));
  return { child, closed };
}

test('unmatched direct children retain identity and natural lifecycle without observing their transport or changing execution', async t => {
  const item = fixture(), args = ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write(process.env.SOURCE_TEST_SECRET); process.exitCode=7', privateUrl];
  const env = { ...process.env, SOURCE_TEST_SECRET: secret }, expected = await localChild(process.execPath, args, { env }).closed;
  const spawn = cp.spawn, observer = observe(item); t.after(observer.finish);
  const child = localChild(process.execPath, args, { env }), actual = await child.closed; observer.finish();
  assert.deepEqual(actual, expected); assert.equal(cp.spawn, spawn);
  const trace = await readSourceObservation(item.output), start = trace.events.find(row => row.phase === 'unmatched_child_start');
  assert.equal(trace.complete, true); assert.deepEqual(trace.errors, []);
  assert.equal(start.parentPid, process.pid); assert.equal(start.transport, 'unknown');
  assert.equal(start.argvSha256, crypto.createHash('sha256').update(JSON.stringify(child.child.spawnargs)).digest('hex'));
  assert.equal(start.argumentCount, child.child.spawnargs.length);
  const lifecycle = trace.events.filter(row => row.childId === start.childId);
  assert.deepEqual(lifecycle.map(row => row.phase), ['unmatched_child_start', 'unmatched_child_spawn', 'unmatched_child_exit', 'unmatched_child_close']);
  assert.ok(lifecycle.slice(1).every(row => row.parentPid === process.pid && row.childPid === child.child.pid));
  assert.equal(lifecycle.at(-1).code, 7); assert.equal(lifecycle.at(-1).signal, null);
  assert.equal(trace.unmatchedChildLifecycle.complete, true); assert.equal(trace.unmatchedChildLifecycle.closes, 1);
  assert.equal(trace.events.at(-1).unmatchedChildren, 1); assert.deepEqual(trace.events.at(-1).pendingChildIds, []);
  assert.equal(trace.events.filter(row => ['started','metrics','completed'].includes(row.phase)).length, 0);
  const raw = fs.readFileSync(item.output, 'utf8');
  for (const value of [secret, privateUrl, args[1], process.execPath]) assert.equal(raw.includes(value), false);
});

test('an unmatched spawn failure has an error and close, no invented PID, spawn or exit', async t => {
  const item = fixture(), observer = observe(item); t.after(observer.finish);
  const actual = await localChild(path.join(item.base, 'missing-executable'), []).closed; observer.finish();
  assert.deepEqual(actual.errors, ['ENOENT']);
  const trace = await readSourceObservation(item.output), lifecycle = trace.events.filter(row => row.childId);
  assert.deepEqual(lifecycle.map(row => row.phase), ['unmatched_child_start','unmatched_child_error','unmatched_child_close']);
  assert.equal(lifecycle[1].code, 'ENOENT'); assert.equal(lifecycle[1].childPid, null); assert.equal(lifecycle[2].childPid, null);
  assert.equal(lifecycle[2].code, actual.code); assert.equal(trace.complete, true);
  assert.equal(trace.unmatchedChildLifecycle.spawns, 0); assert.equal(trace.unmatchedChildLifecycle.exits, 0);
  assert.equal(trace.unmatchedChildLifecycle.errors, 1); assert.equal(trace.unmatchedChildLifecycle.closes, 1);
});

test('real AbortSignal cancellation records error, exit and close without treating them as duplicate completion', async t => {
  const item = fixture(), controller = new AbortController(), observer = observe(item); t.after(observer.finish);
  const value = localChild(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { signal: controller.signal });
  await new Promise(resolve => value.child.once('spawn', resolve)); controller.abort();
  const actual = await value.closed; observer.finish();
  assert.deepEqual(actual.errors, ['ABORT_ERR']); assert.equal(actual.signal, 'SIGTERM');
  const trace = await readSourceObservation(item.output);
  assert.equal(trace.complete, true); assert.deepEqual(trace.errors, []);
  assert.deepEqual(trace.events.filter(row => row.childId).map(row => row.phase),
    ['unmatched_child_start','unmatched_child_spawn','unmatched_child_error','unmatched_child_exit','unmatched_child_close']);
  assert.equal(trace.unmatchedChildLifecycle.errors, 1); assert.equal(trace.unmatchedChildLifecycle.closes, 1);
});

test('direct-child exit does not stand in for close while a descendant still holds stdio', async t => {
  const item = fixture(), observer = observe(item); t.after(observer.finish);
  const script = 'const {spawn}=require("node:child_process"); spawn(process.execPath,["-e",\'setTimeout(()=>process.stdout.write("tail"),250)\'],{stdio:["ignore",1,2]}).unref()';
  const value = localChild(process.execPath, ['-e', script]);
  await new Promise(resolve => value.child.once('exit', resolve));
  const during = await readSourceObservation(item.output, { final: false });
  assert.equal(during.unmatchedChildLifecycle.exits, 1); assert.equal(during.unmatchedChildLifecycle.closes, 0);
  assert.equal(during.unmatchedChildLifecycle.complete, false); assert.equal(during.unmatchedChildLifecycle.pendingChildIds.length, 1);
  const actual = await value.closed; observer.finish();
  assert.equal(actual.stdout, 'tail');
  const after = await readSourceObservation(item.output);
  assert.equal(after.complete, true); assert.equal(after.unmatchedChildLifecycle.starts, 1);
  assert.equal(after.unmatchedChildLifecycle.closes, 1); assert.equal(after.unmatchedChildLifecycle.descendants, 'unobserved');
});

test('unknown-child observation does not resume stdout and a premature owner finish retains pending identity', async t => {
  const item = fixture(), observer = observe(item); t.after(observer.finish);
  const child = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>process.stdout.write("late"),100)'], { stdio:['ignore','pipe','ignore'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  await new Promise(resolve => child.once('spawn', resolve));
  assert.equal(child.stdout.listenerCount('data'), 0); assert.equal(child.stdout.readableFlowing, null);
  observer.finish(); child.stdout.resume(); await closed;
  const trace = await readSourceObservation(item.output);
  assert.equal(trace.complete, false); assert.deepEqual(trace.errors, []);
  assert.equal(trace.unmatchedChildLifecycle.closes, 0); assert.equal(trace.unmatchedChildLifecycle.pendingChildIds.length, 1);
  assert.deepEqual(trace.events.at(-1).pendingChildIds, trace.unmatchedChildLifecycle.pendingChildIds);
});

test('error monitoring preserves an otherwise unhandled child error and owner failure', async () => {
  const item = fixture(), owner = path.join(item.base, 'unhandled-owner.mjs'), preload = path.join(item.base, 'unhandled-preload.mjs');
  fs.writeFileSync(owner, 'import {spawn} from "node:child_process"; spawn(' + JSON.stringify(path.join(item.base, 'missing-executable')) + ',[],{stdio:"ignore"});\n');
  fs.writeFileSync(preload, sourceObserverPreloadSource({ output:item.output, checkoutRoot:process.cwd(), clockId:'unhandled-test',
    cliPath:item.cli, ownerEntry:owner, ownerParentPid:process.pid }));
  const actual = await localChild(process.execPath, [owner], { env:{...process.env,NODE_OPTIONS:'--import='+pathToFileURL(preload).href} }).closed;
  assert.equal(actual.code, 1); assert.match(actual.stderr, /Unhandled 'error' event/);
  const trace = await readSourceObservation(item.output);
  assert.equal(trace.complete, false); assert.deepEqual(trace.errors, []);
  assert.equal(trace.unmatchedChildLifecycle.errors, 1); assert.equal(trace.unmatchedChildLifecycle.closes, 0);
});

test('missing, duplicate, cross-parent and inconsistent unknown-child terminal records are rejected', async t => {
  const item = fixture(), observer = observe(item); await localChild(process.execPath, ['-e','process.exitCode=0']).closed; observer.finish();
  const trace = (await readSourceObservation(item.output)).events;
  const cases = [
    ['missing-spawn', trace.filter(row => row.phase !== 'unmatched_child_spawn')],
    ['missing-exit', trace.filter(row => row.phase !== 'unmatched_child_exit')],
    ['missing-close', trace.filter(row => row.phase !== 'unmatched_child_close')],
    ['duplicate-close', trace.flatMap(row => row.phase === 'unmatched_child_close' ? [row,row] : [row])],
    ['cross-parent', trace.map(row => row.phase === 'unmatched_child_close' ? {...row,parentPid:row.parentPid+1} : row)],
    ['wrong-child-pid', trace.map(row => row.phase === 'unmatched_child_close' ? {...row,childPid:row.childPid+1} : row)],
    ['changed-exit-code', trace.map(row => row.phase === 'unmatched_child_close' ? {...row,code:7} : row)],
    ['wrong-close-count', trace.map(row => row.phase === 'source_observer_end' ? {...row,unmatchedChildCloses:0} : row)],
    ['unknown-contract', trace.map(row => row.phase === 'source_observer_start' ? {...row,unmatchedChildLifecycleVersion:2} : row)],
  ];
  for (const [name, rows] of cases) await t.test(name, async () => {
    const file = path.join(item.base, name+'.jsonl'), raw = reseal(rows).map(row=>JSON.stringify(row)).join('\n')+'\n';
    fs.writeFileSync(file,raw); const actual = await readSourceObservation(file);
    assert.equal(actual.complete,false); assert.ok(actual.errors.length>0); assert.equal(fs.readFileSync(file,'utf8'),raw);
  });
});

test('a real detached bash child closes normally but retains unknown transport', { skip:process.platform==='win32' }, async t => {
  const item=fixture(),observer=observe(item);t.after(observer.finish);
  const value=localChild('/bin/bash',['-c','printf "%s" "$1"','_',secret],{detached:true});
  const actual=await value.closed;observer.finish();
  assert.equal(actual.code,0);assert.equal(actual.stdout,secret);
  const trace=await readSourceObservation(item.output),start=trace.events.find(row=>row.phase==='unmatched_child_start');
  assert.equal(trace.complete,true);assert.equal(start.detached,true);assert.equal(start.transport,'unknown');
  assert.equal(trace.unmatchedChildLifecycle.closes,1);assert.equal(trace.unmatchedChildLifecycle.descendants,'unobserved');
  assert.equal(trace.events.filter(row=>row.phase==='metrics'||row.phase==='attempt').length,0);
  assert.equal(fs.readFileSync(item.output,'utf8').includes(secret),false);
});

test('source quiet boundary waits for the observed unknown child close and records its identity', async t => {
  const item=fixture(),observer=observe(item);t.after(observer.finish);
  const value=localChild(process.execPath,['-e','setTimeout(()=>{},1000)']);
  let closed=false;value.closed.then(()=>{closed=true});
  const boundary=await settleSource(item.output,'sdk'),closedAtBoundary=closed;
  await value.closed;observer.finish();
  const trace=await readSourceObservation(item.output),start=trace.events.find(row=>row.phase==='unmatched_child_start');
  assert.equal(closedAtBoundary,true);assert.equal(boundary.quiet,true);assert.deepEqual(boundary.childIds,[start.childId]);
  assert.equal(trace.unmatchedChildLifecycle.complete,true);
});

test('legacy unmatched starts remain readable without inventing lifecycle receipts', async () => {
  const item=fixture(),observer=observe(item);await localChild(process.execPath,['-e','process.exitCode=0']).closed;observer.finish();
  const events=(await readSourceObservation(item.output)).events;
  const legacy=events.filter(row=>['source_observer_start','unmatched_child_start','source_observer_end'].includes(row.phase)).map(row=>{
    const value={...row};
    if(value.phase==='source_observer_start')delete value.unmatchedChildLifecycleVersion;
    if(value.phase==='unmatched_child_start') {
      for(const key of ['childId','parentPid','childPid','argvSha256','detached'])delete value[key];
      value.kind='observer';
    }
    if(value.phase==='source_observer_end') {delete value.unmatchedChildCloses;delete value.pendingChildIds;}
    return value;
  });
  const file=path.join(item.base,'legacy.jsonl');fs.writeFileSync(file,reseal(legacy).map(row=>JSON.stringify(row)).join('\n')+'\n');
  const actual=await readSourceObservation(file);
  assert.equal(actual.complete,true);assert.deepEqual(actual.errors,[]);assert.equal(actual.unmatchedChildLifecycle,null);
  assert.equal(actual.events.at(-1).unmatchedChildren,1);
});
