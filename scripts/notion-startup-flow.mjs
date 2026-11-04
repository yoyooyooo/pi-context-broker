#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, resolveHost, runCommand, writeFakeProvider } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { createNotionFixture, database, canary, skillRef } from './notion-integration-fixture.mjs';
import { systemTempRoot, evidenceRoot } from './verification-paths.mjs';

const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '..');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const now = () => process.hrtime.bigint().toString();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function rows(path) {
  try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function waitFor(label, predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await pause(25); }
  throw new Error(`Timed out waiting for ${label}`);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
function bodyCount(capture) { return JSON.stringify(capture.context.messages.filter(message => message.role !== 'system')).split(canary).length - 1; }
function systemText(capture) { return JSON.stringify([capture.context.systemPrompt, ...capture.context.messages.filter(message => message.role === 'system')]); }

// A controlled CLI transport: the unchanged integration fixture still supplies
// every wire receipt. Only explicit metadata/body gates and failures are added.
async function source(specPath, args) {
  const spec = await json(specPath);
  const command = args[0], id = `${process.pid}-${now()}`;
  let child, receivedSignal;
  const log = (event, extra = {}) => appendFileSync(spec.ledger, JSON.stringify({ event, id, pid: process.pid, command, args: args.slice(1), monotonicNs: now(), ...extra }) + '\n');
  log('start');
  process.once('exit', code => log('exit', { code, signal: receivedSignal ?? null }));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    receivedSignal = signal;
    log('signal', { signal });
    child?.kill(signal);
    process.exit(signal === 'SIGTERM' ? 143 : 130);
  });
  let control = await json(spec.control);
  const body = ['prepare', 'read', 'export'].includes(command);
  const held = () => command === 'list' ? control.holdList : body ? control.holdBody : false;
  if (held()) {
    log('waiting', { gate: command === 'list' ? 'metadata' : 'body' });
    while (held()) { await pause(25); control = await json(spec.control); }
    log('released');
  }
  const failure = command === 'list' ? control.failList : body ? control.failBody : undefined;
  if (failure) {
    log('failure', { code: failure });
    process.stdout.write(JSON.stringify({ ok: false, error: { code: failure, message: 'Controlled startup fixture failure' } }) + '\n');
    process.exitCode = 1;
    return;
  }
  child = spawn(spec.command[0], [...spec.command.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  child.stdout.on('data', data => stdout.push(data));
  child.stderr.on('data', data => stderr.push(data));
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  const output = Buffer.concat(stdout), diagnostic = Buffer.concat(stderr);
  log('fixture-close', { childPid: child.pid, ...result, stdoutBytes: output.length, stdoutSha256: hash(output) });
  process.stdout.write(output); process.stderr.write(diagnostic);
  process.exitCode = result.code ?? 1;
}

async function observedProvider(base) {
  const path = await writeFakeProvider(base);
  let code = await readFile(path, 'utf8');
  code = code.replace('import { appendFileSync }', 'import { appendFileSync, readFileSync }');
  code = code.replace('JSON.stringify({ model: model.id, context })', 'JSON.stringify({ model: model.id, context, monotonicNs: process.hrtime.bigint().toString() })');
  code = code.replace('const output = {', `const plan = JSON.parse(readFileSync(process.env.BROKER_STARTUP_PLAN, 'utf8'));
  const requested = plan.trigger && context.messages.some(message => message.role === 'user' && JSON.stringify(message).includes(plan.trigger));
  const completed = context.messages.some(message => message.role === 'toolResult' && message.toolCallId === plan.id);
  const call = requested && !completed ? { type: 'toolCall', id: plan.id, name: plan.name, arguments: plan.input } : undefined;
  const output = {`);
  code = code.replace('content: [{ type: "text", text: "OK" }]', 'content: call ? [call] : [{ type: "text", text: "OK" }]');
  code = code.replace('stopReason: "stop"', 'stopReason: call ? "toolUse" : "stop"');
  code = code.replace('for (const event of events) yield event;', `if (call) {
    yield { type: 'start', partial: output };
    yield { type: 'toolcall_start', contentIndex: 0, partial: output };
    yield { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: output };
    yield { type: 'done', reason: 'toolUse', message: output };
  } else for (const event of events) yield event;`);
  await writeFile(path, code);
  return path;
}

async function fixture(name, scratch, evidence, extension, control = { holdList: true, holdBody: false }) {
  const base = join(scratch, name), output = join(evidence, name), agentDir = join(base, 'agent');
  await mkdir(join(agentDir, 'context-broker'), { recursive: true }); await mkdir(output);
  const original = await createNotionFixture(join(base, 'fixture'));
  const state = join(base, 'control.json'), ledger = join(output, 'source-processes.jsonl');
  await save(state, control);
  const spec = join(base, 'source.json');
  await save(spec, { command: original.command, control: state, ledger });
  const config = join(agentDir, 'context-broker', 'config.yml');
  await save(config, { sources: [{ type: 'notion', id: 'notion', namespace: 'notion', command: [process.execPath, script, 'source', spec], database, prefetch: false, cacheDir: join(base, 'source-cache') }] });
  const provider = await observedProvider(base), providerFile = join(output, 'provider.jsonl'), plan = join(base, 'plan.json');
  await save(plan, {});
  const observers = [];
  for (const phase of ['before-broker', 'after-broker']) {
    const path = join(base, phase + '.mjs');
    await writeFile(path, `import { appendFileSync } from 'node:fs';
export default function observe(api) {
 for (const name of ['session_start','session_shutdown','resources_discover','input','before_agent_start','agent_start','agent_end','tool_call','tool_result']) api.on(name, (event) => {
  appendFileSync(${JSON.stringify(join(output, 'host-events.jsonl'))}, JSON.stringify({ event: name, phase: ${JSON.stringify(phase)}, monotonicNs: process.hrtime.bigint().toString(), text: event.text, prompt: event.prompt, source: event.source, reason: event.reason, toolName: event.toolName, toolCallId: event.toolCallId, systemPrompt: name === 'before_agent_start' ? event.systemPrompt : undefined }) + '\\n');
 });
}
`);
    observers.push(path);
  }
  const env = isolatedEnv({ base, agentDir, TMPDIR: await systemTempRoot(), TERM: 'xterm-256color', COLORTERM: 'truecolor', CONTEXT_BROKER_CONFIG: config,
    CONTEXT_BROKER_HOST: 'omp', CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: providerFile, BROKER_STARTUP_PLAN: plan,
    BROKER_E2E_PROCESS_LEDGER: join(output, 'host-processes.jsonl'), CONTEXT_BROKER_LOG_FILE: join(output, 'decisions.jsonl') });
  const args = ['--no-extensions','--no-mcp','--no-context-files','--no-prompt-templates','--approve','--offline','--session-dir',join(base,'sessions'),'--tools','read',
    '-e',observers[0],'-e',provider,'-e',extension,'-e',observers[1],'--provider','context-broker-e2e','--model','fake'];
  return {
    base, output, agentDir, args, env, state, ledger, plan, providerFile, original,
    change: async changes => save(state, { ...await json(state), ...changes }),
    capture: () => rows(providerFile), calls: () => rows(ledger), events: () => rows(join(output, 'host-events.jsonl')),
    async settleSources() {
      await save(state, { ...await json(state), holdList: false, holdBody: false });
      await waitFor('owned source processes to exit', async () => (await rows(ledger)).filter(row => row.event === 'start').every(row => !alive(row.pid)));
      try { await writeFile(join(output, 'source-cli-calls.jsonl'), await readFile(original.callsPath)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}

async function assertOrdinaryPending(f, rpc, text = 'SC09_ORDINARY_PENDING') {
  await waitFor('a held list request', async () => (await f.calls()).some(row => row.event === 'waiting' && row.command === 'list'));
  await rpc.prompt(text);
  const captures = await f.capture(), calls = await f.calls();
  assert.equal(captures.length, 1);
  assert.equal(bodyCount(captures[0]), 0);
  assert.match(JSON.stringify(captures[0].context), /status=\\?"pending/);
  assert.equal(calls.some(row => ['prepare','read','export'].includes(row.command)), false);
  assert.equal(calls.some(row => row.command === 'list' && row.event === 'exit'), false);
  const input = (await f.events()).find(row => row.event === 'input' && row.phase === 'before-broker' && row.text === text);
  const started = calls.find(row => row.command === 'list' && row.event === 'waiting');
  assert.ok(input && started);
  assert.ok(BigInt(started.monotonicNs) < BigInt(input.monotonicNs));
  assert.ok(BigInt(input.monotonicNs) < BigInt(captures[0].monotonicNs));
  return { listWaitNs: started.monotonicNs, inputNs: input.monotonicNs, providerNs: captures[0].monotonicNs, bodyReadsBeforeProvider: 0 };
}

async function rpcCase(name, f) {
  const rpc = await startRpc({ host: 'pi', cwd: f.base, env: f.env, args: f.args, waitForState: false, timeoutMs: 30_000 });
  let eof = false, result = {};
  try {
    if (name === 'rpc-pending') {
      result.order = await assertOrdinaryPending(f, rpc);
      await f.change({ holdList: false });
      await rpc.prompt('/skill:notion-ui-alpha SC09_NATIVE_AFTER_PENDING');
      await rpc.prompt('$ui-alpha@notion SC09_DOLLAR_AFTER_NATIVE');
      const captures = await f.capture();
      assert.equal(captures.length, 3);
      for (const capture of captures.slice(1)) { assert.equal(bodyCount(capture), 1); assert.ok(!systemText(capture).includes(canary)); }
      assert.match(JSON.stringify(captures[1].context.messages), /SC09_NATIVE_AFTER_PENDING/);
      assert.match(JSON.stringify(captures[2].context.messages), /SC09_DOLLAR_AFTER_NATIVE/);
      const complete = (await f.calls()).find(row => row.command === 'list' && row.event === 'exit');
      assert.ok(complete && BigInt(result.order.providerNs) < BigInt(complete.monotonicNs));
      result.order.listCompleteNs = complete.monotonicNs;
    } else if (name.startsWith('rpc-failure-')) {
      result.order = await assertOrdinaryPending(f, rpc);
      await f.change({ holdList: false });
      await waitFor('directory failure', async () => (await f.calls()).some(row => row.command === 'list' && row.event === 'failure'));
      await waitFor('host source warning', () => rpc.frames.some(frame => JSON.stringify(frame).includes(name.slice('rpc-failure-'.length))));
      await rpc.prompt('SC09_ORDINARY_AFTER_DIRECTORY_FAILURE');
      assert.equal((await f.capture()).length, 2);
      assert.ok((await f.capture()).every(capture => bodyCount(capture) === 0));
      assert.equal((await f.calls()).some(row => ['prepare','read','export'].includes(row.command)), false);
    } else if (name === 'rpc-selection-failure') {
      await f.change({ holdList: false, failBody: 'ACCESS_DENIED' });
      const outcome = await rpc.prompt('/skill:notion-ui-alpha SC09_SELECTED_DENIED');
      assert.equal((await f.capture()).length, 0, 'A failed exact native selection must not start the provider');
      assert.ok((await f.calls()).some(row => row.event === 'failure' && row.code === 'ACCESS_DENIED' && row.command === 'prepare'));
      result.outcome = outcome;
      await rpc.prompt('SC09_ORDINARY_AFTER_SELECTED_FAILURE');
      assert.equal((await f.capture()).length, 1);
      assert.equal(bodyCount((await f.capture())[0]), 0);
    } else if (name === 'rpc-abort' || name === 'rpc-new-session') {
      await waitFor('held directory', async () => (await f.calls()).some(row => row.event === 'waiting' && row.command === 'list'));
      const pending = rpc.prompt('/skill:notion-ui-alpha SC09_CANCELLED_INPUT').then(value => ({ value }), error => ({ error: error.message }));
      await waitFor('actual selected input', async () => (await f.events()).some(row => row.event === 'input' && row.text?.includes('SC09_CANCELLED_INPUT')));
      result.boundary = await rpc.command(name === 'rpc-abort' ? 'abort' : 'new_session');
      await f.change({ holdList: false });
      result.oldPrompt = await pending;
      assert.equal((await f.capture()).length, 0, `${name} must prevent a late provider request after metadata completes`);
      await rpc.prompt('SC09_NEXT_ORDINARY');
      assert.equal((await f.capture()).length, 1);
      assert.equal(bodyCount((await f.capture())[0]), 0);
      if (name === 'rpc-new-session') { await rpc.prompt('/skill:notion-ui-alpha SC09_NEW_SESSION_NATIVE'); assert.equal(bodyCount((await f.capture()).at(-1)), 1); }
    } else if (name === 'rpc-tool-stop') {
      await save(f.plan, { trigger: 'SC09_MODEL_READ', id: 'sc09-cancelled-read', name: 'read', input: { path: skillRef } });
      const pending = rpc.prompt('SC09_MODEL_READ').then(value => ({ value }), error => ({ error: error.message }));
      await waitFor('model native read while metadata is held', async () => (await f.events()).some(row => row.event === 'tool_call' && row.toolCallId === 'sc09-cancelled-read'));
      await rpc.command('abort');
      result.oldPrompt = await pending;
      await save(f.plan, {});
      await f.change({ holdList: false });
      await rpc.prompt('SC09_AFTER_TOOL_STOP');
      assert.ok((await f.capture()).every(capture => bodyCount(capture) === 0));
      assert.equal((await f.calls()).some(row => ['prepare','read','export'].includes(row.command)), false);
    } else if (name === 'rpc-eof') {
      result.order = await assertOrdinaryPending(f, rpc);
      await rpc.closeInput(); eof = true;
      assert.equal((await f.capture()).length, 1);
    } else throw new Error('Unknown RPC case: ' + name);
    return result;
  } finally {
    if (!eof) await rpc.stop().catch(error => { result.stopError = error.message; });
    await save(join(f.output, 'rpc.json'), rpc.frames);
    await save(join(f.output, 'rpc-lifecycle.json'), rpc.lifecycle);
    assert.ok(rpc.lifecycle.some(row => row.event === 'close'), 'Owned RPC close must be observed');
  }
}

async function ptyCase(name, f) {
  const host = await resolveHost('pi');
  const command = [host.file, ...host.prefix, '--tui-mode', 'regular', ...f.args];
  const expected = (where, extra = {}) => ({ path: f.ledger, where, ...extra });
  const steps = [{ label: 'composer-pending', screen: { stage: 'draft', token: '' }, screenContains: ['fake'], ledger: [expected({ event: 'waiting', command: 'list' })], providerCount: 0 }];
  if (name === 'pty-pending') {
    steps.push(
      { label: 'ordinary-pending', send: 'SC09_PTY_ORDINARY\r', screen: { stage: 'submitted' }, providerCount: 1 },
      { label: 'release-metadata', fixtureState: { path: f.state, changes: { holdList: false } }, providerCount: 1 },
      { label: 'exact-native-draft', send: '/skill:notion-ui-alpha SC09_PTY_NATIVE', screen: { stage: 'draft', token: '/skill:notion-ui-alpha SC09_PTY_NATIVE' }, providerCount: 1 },
      { label: 'exact-native-submit', send: '\r', screen: { stage: 'submitted' }, requests: 2 },
      { label: 'dollar-candidate', send: '$ui-a', screen: { stage: 'candidate', prefix: '$ui-a', selected: '$ui-alpha@notion' }, providerCount: 2 },
      { label: 'dollar-accepted', send: '\t', screen: { stage: 'draft', token: '$ui-alpha@notion' }, providerCount: 2 },
      { label: 'dollar-submit', send: ' SC09_PTY_DOLLAR\r', screen: { stage: 'submitted' }, requests: 3 },
    );
  } else if (name === 'pty-stop') {
    steps.push(
      { label: 'release-metadata', fixtureState: { path: f.state, changes: { holdList: false, holdBody: true } } },
      { label: 'dollar-candidate', send: '$ui-a', screen: { stage: 'candidate', prefix: '$ui-a', selected: '$ui-alpha@notion' }, providerCount: 0 },
      { label: 'dollar-accepted', send: '\t', screen: { stage: 'draft', token: '$ui-alpha@notion' }, providerCount: 0 },
      { label: 'selected-body-wait', send: ' SC09_PTY_CANCELLED\r', ledger: [expected({ event: 'waiting', command: 'prepare' })], providerCount: 0 },
      { label: 'second-enter', send: '\r', providerCount: 0 },
      { label: 'escape-stop', send: '\u001b', ledger: [expected({ event: 'signal', command: 'prepare' }, { exited: ['pid'] })], providerCount: 0 },
      { label: 'release-body', fixtureState: { path: f.state, changes: { holdBody: false } }, providerCount: 0 },
      { label: 'ordinary-after-stop', send: '\u0015SC09_PTY_AFTER_STOP\r', screen: { stage: 'submitted' }, providerCount: 1 },
      { label: 'retry-selected', send: '$ui-alpha@notion SC09_PTY_RETRY\r', screen: { stage: 'submitted' }, requests: 2 },
    );
  } else throw new Error('Unknown PTY case: ' + name);
  steps.push({ label: 'natural-eof', send: '\u0004', exit: true });
  const spec = join(f.base, 'pty.json');
  await save(spec, { command, cwd: f.base, env: f.env, evidence: f.output, provider: f.providerFile, canary, steps });
  const child = spawn('python3', [join(root, '.agents/skills/verify-context-broker/scripts/pi-pty-driver.py'), spec], { cwd: f.base, env: isolatedEnv({ base: f.base, agentDir: f.agentDir }), stdio: ['ignore','pipe','pipe'] });
  const stdout = [], stderr = [];
  child.stdout.on('data', value => stdout.push(value)); child.stderr.on('data', value => stderr.push(value));
  const closed = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  await save(join(f.output, 'driver-exit.json'), { pid: child.pid, ...closed, observedExit: true });
  await writeFile(join(f.output, 'driver-stdout.log'), Buffer.concat(stdout)); await writeFile(join(f.output, 'driver-stderr.log'), Buffer.concat(stderr));
  assert.equal(closed.code, 0, 'Actual PTY actions failed; inspect the raw terminal and result');
  const captures = await f.capture();
  assert.equal(bodyCount(captures[0]), 0);
  if (name === 'pty-pending') {
    const firstList = (await f.calls()).find(row => row.event === 'exit' && row.command === 'list');
    assert.ok(firstList && BigInt(captures[0].monotonicNs) < BigInt(firstList.monotonicNs));
  } else assert.equal((await f.calls()).filter(row => row.event === 'waiting' && row.command === 'prepare').length, 1, 'Double Enter must not prepare twice');
  return { providerRequests: captures.length, terminalStatus: (await json(join(f.output, 'result.json'))).status, cleanup: await json(join(f.output, 'cleanup.json')) };
}

const caseNames = ['rpc-pending','rpc-failure-RATE_LIMITED','rpc-failure-NOTION_UNAVAILABLE','rpc-failure-ACCESS_DENIED','rpc-selection-failure','rpc-abort','rpc-new-session','rpc-tool-stop','rpc-eof','pty-pending','pty-stop'];
async function retained(directory) {
  const manifest = await json(join(directory, 'manifest.json'));
  for (const item of manifest.cases) {
    await access(join(directory, item.name, 'case-result.json'));
    if (item.name.startsWith('rpc-')) assert.ok((await json(join(directory, item.name, 'rpc-lifecycle.json'))).some(row => row.event === 'close'));
    else assert.equal((await json(join(directory, item.name, 'cleanup.json'))).observedExit, true);
  }
  return { status: 'preserved', functionalStatus: manifest.status, directory, cases: manifest.cases.map(({ name, status, error, sourcesExited }) => ({ name, status, error, sourcesExited })) };
}

async function main(args) {
  const usage = 'node scripts/notion-startup-flow.mjs run [--case NAME[,NAME] --evidence-root ABS --extension ABS] | evidence|cleanup --evidence ABS';
  if (!args.length || args.some(arg => ['--help','help','-h'].includes(arg))) { console.log(usage + '\nCases: ' + caseNames.join(',')); return; }
  const action = args.shift(), options = {};
  while (args.length) { const key = args.shift(); assert.ok(['--case','--evidence-root','--extension','--evidence'].includes(key) && args.length, usage); options[key.slice(2)] = args.shift(); }
  if (action === 'evidence' || action === 'cleanup') {
    const directory = options.evidence; assert.ok(isAbsolute(directory ?? ''));
    const result = await retained(directory);
    if (action === 'cleanup') {
      const manifest = await json(join(directory, 'manifest.json')), scratch = await realpath(manifest.scratch);
      assert.equal(dirname(scratch), await systemTempRoot()); assert.ok(scratch.split('/').at(-1).startsWith('broker-notion-startup-scratch-'));
      assert.equal((await json(join(scratch, 'ownership.json'))).evidence, directory);
      for (const item of manifest.cases) assert.ok((await rows(join(directory, item.name, 'source-processes.jsonl'))).filter(row => row.event === 'start').every(row => !alive(row.pid)), 'Owned source process still exists');
      await runCommand('/usr/bin/trash', [scratch], { cwd: root, env: process.env });
      await save(join(directory, 'cleanup.json'), { scratch, status: 'trashed', evidencePreserved: true });
    }
    console.log(JSON.stringify(result, null, 2)); return;
  }
  assert.equal(action, 'run', usage);
  assert.ok(!process.versions.bun, 'Run real host drivers with Node');
  const selected = options.case ? options.case.split(',') : caseNames;
  assert.ok(selected.every(name => caseNames.includes(name)) && new Set(selected).size === selected.length);
  const temporaryRoot = await systemTempRoot(), extension = options.extension ?? join(root, 'packages/context-broker/src/index.ts');
  assert.ok(isAbsolute(extension));
  const evidence = await mkdtemp(join(await evidenceRoot(options['evidence-root'], temporaryRoot), 'broker-notion-startup-evidence-'));
  const scratch = await mkdtemp(join(temporaryRoot, 'broker-notion-startup-scratch-'));
  await save(join(scratch, 'ownership.json'), { evidence });
  const files = [extension, ...['host-skills.ts','pi-host-adapter.ts','types.ts'].map(name => join(dirname(extension), name))];
  const inputs = await Promise.all(files.map(async path => ({ path, sha256: hash(await readFile(path)) })));
  const version = (await runCommand('pi', ['--version'], { cwd: scratch, env: isolatedEnv({ base: scratch, agentDir: join(scratch, 'probe-agent'), TMPDIR: temporaryRoot }) })).stdout.trim();
  const manifest = { status: 'running', scratch, temporaryRoot, inputs, host: { ...await resolveHost('pi'), version }, node: process.version, boundary: 'real installed Pi RPC/PTY; controlled source CLI and provider; no live Notion or real model', cases: [] };
  await save(join(evidence, 'manifest.json'), manifest);
  console.log('Startup flow evidence: ' + evidence);
  for (const name of selected) {
    const f = await fixture(name, scratch, evidence, extension, { holdList: true, holdBody: false, ...(name.startsWith('rpc-failure-') ? { failList: name.slice('rpc-failure-'.length) } : {}) });
    const item = { name, status: 'running', startedNs: now() }; manifest.cases.push(item); await save(join(evidence, 'manifest.json'), manifest);
    console.log('Running ' + name);
    try { item.result = name.startsWith('rpc-') ? await rpcCase(name, f) : await ptyCase(name, f); item.status = 'passed'; }
    catch (error) { item.status = 'failed'; item.error = error.message; item.stack = error.stack; }
    finally {
      try { await f.settleSources(); item.sourcesExited = true; } catch (error) { item.status = 'failed'; item.cleanupError = error.message; }
      item.endedNs = now();
      item.sourceCalls = (await f.calls()).filter(row => row.event === 'start').map(({ command, args, pid }) => ({ command, args, pid }));
      await save(join(f.output, 'case-result.json'), item); await save(join(evidence, 'manifest.json'), manifest);
      console.log(JSON.stringify({ case: name, status: item.status, error: item.error, cleanupError: item.cleanupError }));
    }
  }
  manifest.status = manifest.cases.every(item => item.status === 'passed') ? 'passed' : 'failed';
  await save(join(evidence, 'manifest.json'), manifest);
  console.log(JSON.stringify(await retained(evidence), null, 2));
  if (manifest.status !== 'passed') process.exitCode = 1;
}

if (process.argv[2] === 'source') await source(process.argv[3], process.argv.slice(4));
else await main(process.argv.slice(2));
