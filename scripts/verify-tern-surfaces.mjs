#!/usr/bin/env node
// Extends AH255 controls: same isolation, host resolver, process ledger and Tern ctl transport.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import { appendFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { isolatedEnv, resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { systemTempRoot, evidenceRoot } from './verification-paths.mjs';
import { requiredScenarios, exactCandidate, validateSpec, validateRunLimits } from './tern-surface-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const invocationStartedAt = Math.floor(performance.timeOrigin);

// Shared by the real observer and offline fixtures. Admission is synchronous and
// precedes dispatch; process.exit is deliberate because observer exceptions may be caught.
function createRunGuard(settings, fs, terminate) {
  const elapsed = () => settings.previousElapsedMs + Math.max(0, Date.now() - settings.startedAt);
  const transition = requestId => {
    const lock = `${settings.statePath}.lock`;
    const started = Date.now();
    for (;;) {
      try { fs.mkdirSync(lock); break; }
      catch (error) {
        if (error.code !== 'EEXIST' || Date.now() - started >= 1000) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
    }
    try {
      const state = JSON.parse(fs.readFileSync(settings.statePath, 'utf8'));
      const attempt = requestId !== undefined;
      const reason = state.reason ?? (elapsed() >= settings.limits.maxRunMs ? 'maxRunMs' : attempt && state.admitted >= settings.limits.maxProviderRequests ? 'maxProviderRequests' : null);
      if (!attempt && !reason) return { state, rejected: false };
      const firstRejection = reason && !state.reason;
      if (reason) { state.reason = reason; if (attempt) state.rejected++; }
      else state.admitted++;
      state.elapsedMs = elapsed();
      const temporary = `${settings.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(temporary, settings.statePath);
      if (attempt || firstRejection) fs.appendFileSync(settings.eventsPath, JSON.stringify({ at: new Date().toISOString(), phase: reason ? 'budget-rejection' : 'budget-admission', reason, requestId: requestId ?? null, admitted: state.admitted, rejected: state.rejected }) + '\n', { mode: 0o600 });
      return { state, rejected: Boolean(reason) };
    } finally { fs.rmdirSync(lock); }
  };
  const finish = outcome => {
    if (outcome.rejected) { terminate(); throw new Error('Budget termination returned unexpectedly'); }
    return outcome.state;
  };
  return { check: () => finish(transition(undefined)), admit: requestId => finish(transition(requestId ?? null)) };
}
function ownedWindowDaemons(settings) {
  if (!settings.windowLog) return [];
  let text;
  try { text = fsSync.readFileSync(settings.windowLog, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const match of text.matchAll(/(?:daemon process spawned|daemon_handshake)[^\n]*?pid[=: ]+(\d+)/g)) {
    const pid = Number(match[1]);
    if (result.some(item => item.pid === pid)) continue;
    const argv = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL' });
    const words = argv.stdout?.trim().split(/\s+/) ?? [];
    if (words.includes(settings.daemonSocket) && words.includes('daemon')) result.push({ role: 'owned-window-daemon', pid, proof: { log: settings.windowLog, daemonSocket: settings.daemonSocket, argv: argv.stdout.trim() } });
  }
  return result;
}

// Only launch receipts/IPC registrations from this invocation grant kill authority.
// The separate process keeps the deadline active while the driver is in spawnSync.
async function superviseLimits(settings) {
  const owned = new Map();
  let tripped = false;
  let finishing = false, finishStarted;
  const record = item => { if (Number.isSafeInteger(item.pid) && item.pid > 1 && !owned.has(item.pid)) owned.set(item.pid, { ...item, observedTerminal: false }); };
  const groupState = item => {
    const result = spawnSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL' });
    if (result.status !== 0) throw new Error(`Cannot observe owned group ${item.pid}: ${result.stderr}`);
    const members = result.stdout.trim().split('\n').map(line => line.trim().split(/\s+/)).filter(([, group]) => Number(group) === item.pid);
    item.groupMembers = members.map(([pid, , status]) => ({ pid: Number(pid), status, observedTerminal: status.startsWith('Z') }));
    item.observedGroupAbsent = members.length === 0;
    item.observedGroupTerminal = item.groupMembers.every(member => member.observedTerminal);
    return item.observedGroupTerminal;
  };
  const read = path => { try { return JSON.parse(fsSync.readFileSync(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const observe = () => {
    for (const item of owned.values()) {
      if (item.group) {
        try { process.kill(-item.pid, 0); item.observedGroupAbsent = false; }
        catch (error) { if (error.code === 'ESRCH') { item.observedGroupAbsent = true; item.observedGroupTerminal = true; } else if (error.code === 'EPERM') groupState(item); else throw error; }
      }
      if (item.observedTerminal) continue;
      try { process.kill(item.pid, 0); }
      catch (error) { if (error.code !== 'ESRCH') throw error; item.observedTerminal = true; item.terminalState = 'absent'; }
    }
    const host = read(settings.hostPid);
    if (host) record({ role: 'host', pid: host.pid, group: true, proof: settings.hostPid });
    if (host?.launcherPid) record({ role: 'host-launcher', pid: host.launcherPid, proof: settings.hostPid });
    const hostExit = read(settings.hostExit);
    if (host && hostExit?.observedExit) Object.assign(owned.get(host.pid), { observedTerminal: true, terminalState: 'exit-receipt', ...hostExit });
    for (const item of ownedWindowDaemons(settings)) record(item);
  };
  const signalOwned = signal => {
    for (const item of owned.values()) if (!item.observedTerminal || (item.group && !item.observedGroupAbsent && !item.observedGroupTerminal)) {
      // Let the launcher reap its host and persist the exit receipt before stopping it.
      if (item.role === 'host-launcher' && !read(settings.hostExit)?.observedExit) continue;
      try { process.kill(item.group ? -item.pid : item.pid, signal); item.lastSignal = signal; }
      catch (error) {
        if (error.code === 'ESRCH') { item.observedTerminal = true; item.terminalState = 'absent'; }
        else if (error.code === 'EPERM' && item.group && groupState(item)) { item.observedTerminal = true; item.terminalState = 'group-terminal'; }
        else { item.signalError = error.message; }
      }
    }
  };
  const persist = error => fsSync.writeFileSync(settings.supervisorPath, JSON.stringify({ tripped, error, processes: [...owned.values()] }), { mode: 0o600 });
  const guard = createRunGuard(settings, fsSync, () => { throw new Error('Run budget exhausted'); });
  process.on('message', message => {
    if (message.op === 'own') record(message.item);
    if (message.op === 'terminal') { const item = owned.get(message.pid); if (item) Object.assign(item, { observedTerminal: true, terminalState: 'child-close', code: message.code, signal: message.signal }); }
    if (message.op === 'finish') { finishing = true; finishStarted = Date.now(); }
  });
  process.on('disconnect', () => { tripped = true; });
  setInterval(() => {
    try {
      observe();
      if (!tripped) { try { guard.check(); } catch { tripped = true; } }
      if (tripped) {
        signalOwned('SIGKILL');
        if (process.connected) process.send({ op: 'exhausted' });
      }
      persist();
      if (finishing) {
        signalOwned('SIGKILL');
        if ([...owned.values()].every(item => item.observedTerminal && (!item.group || item.observedGroupAbsent || item.observedGroupTerminal)) || Date.now() - finishStarted > 10000) { persist(); process.exit(0); }
      }
      if (!process.connected && [...owned.values()].every(item => item.observedTerminal && (!item.group || item.observedGroupAbsent || item.observedGroupTerminal))) process.exit(0);
    } catch (error) { tripped = true; signalOwned('SIGKILL'); persist(error.message); }
  }, 20);
  process.send?.({ op: 'ready' });
}

function startLimitSupervisor(settings) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__supervise-limits', JSON.stringify(settings)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  return child;
}

// Public extension observers only: no private setters, synthetic provider or payload mutation.
function observe(api, settings, fs, crypto) {
  const emit = value => { fs.appendFileSync(settings.output, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 }); };
  const guard = settings.runLimits ? createRunGuard(settings.runLimits, fs, () => process.exit(86)) : null;
  const digest = value => crypto.createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
  const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  const imageHashes = value => {
    if (!value || typeof value !== 'object') return [];
    const own = (value.type === 'image' || value.type === 'image_url' || value.inlineData || value.source?.media_type?.startsWith('image/')) ? [digest(value)] : [];
    return [...own, ...Object.values(value).flatMap(imageHashes)];
  };
  const model = ctx => `${ctx.model?.provider}/${ctx.model?.id}`;
  const check = ctx => { if (model(ctx) !== settings.model) throw new Error(`Unauthorized acceptance model: ${model(ctx)}`); };
  api.on('session_start', (_event, ctx) => { check(ctx); emit({ phase: 'selected', model: model(ctx) }); });
  const redact = value => Array.isArray(value) ? value.map(redact) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /authorization|api.?key|token|secret|password/i.test(key) ? '[REDACTED]' : redact(item)])) : value;
  api.on('context', (event, ctx) => { check(ctx); emit({ phase: 'context', model: model(ctx), digest: digest(event.messages), snapshot: redact(event.messages), markers: Object.fromEntries(settings.markers.map(marker => [marker, strings(event.messages).reduce((n, text) => n + text.split(marker).length - 1, 0)])), imageHashes: imageHashes(event.messages) }); });
  api.on('before_provider_request', (event, ctx) => {
    // Never return to provider dispatch after a rejected admission, even if the host catches observer errors.
    try { guard?.admit(event.requestId ?? event.id ?? null); }
    catch (error) { try { emit({ phase: 'budget-failure', error: error.message }); } finally { process.exit(86); } }
    check(ctx);
    emit({ phase: 'request', requestId: event.requestId ?? event.id ?? null, model: model(ctx), snapshot: redact(event.payload), digest: digest(event.payload), markers: Object.fromEntries(settings.markers.map(marker => [marker, strings(event.payload).reduce((n, text) => n + text.split(marker).length - 1, 0)])), imageHashes: imageHashes(event.payload) });
    return undefined;
  });
  api.on('after_provider_response', event => { emit({ phase: 'response', snapshot: redact(event), digest: digest(event) }); });
  api.on('tool_call', event => { emit({ phase: 'tool', name: event.toolName, requestId: event.toolCallId ?? null, input: redact(event.input), inputDigest: digest(event.input), ref: settings.refs.includes(event.input?.path) ? event.input.path : null }); });
  api.on('tool_result', event => { const result = event.result ?? event.content; const path = event.input?.path; let file = null; if (typeof path === 'string' && !path.includes('://')) { try { const bytes = fs.readFileSync(path); file = { path, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }; } catch {} } emit({ phase: 'tool-result', name: event.toolName, snapshot: redact(result), sha256: digest(result), file, requestId: event.toolCallId ?? null }); });
  api.on('agent_end', () => { emit({ phase: 'agent-end' }); });
}
async function finishLimitSupervisor(child, settings) {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise(accept => child.once('close', accept));
    child.send({ op: 'finish' });
    await closed;
  }
  const result = JSON.parse(await readFile(settings.supervisorPath, 'utf8'));
  return { ...result, pid: child.pid, code: child.exitCode, signal: child.signalCode, observedTerminal: child.exitCode !== null || child.signalCode !== null };
}
async function collectLimitResult(settings, supervisor) {
  const state = JSON.parse(await readFile(settings.statePath, 'utf8'));
  state.elapsedMs = settings.previousElapsedMs + Math.max(0, Date.now() - settings.startedAt);
  return { limits: settings.limits, state, exhausted: Boolean(state.reason || supervisor?.tripped), reason: state.reason ?? (supervisor?.tripped ? 'supervisor-failure' : null) };
}

async function selftestLimits() {
  const output = await mkdtemp(join(await systemTempRoot(), 'tern-limits-selftest-'));
  const results = { providerCalls: 0, notionCalls: 0, output, cases: [] };
  const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const read = async path => JSON.parse(await readFile(path, 'utf8'));
  const closed = child => new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ pid: child.pid, code, signal, observedTerminal: true })); });
  for (const name of ['request-limit', 'deadline']) {
    const directory = join(output, name); await mkdir(directory);
    const settings = { limits: { maxRunMs: name === 'deadline' ? 500 : 30000, maxProviderRequests: 12 }, startedAt: Date.now(), previousElapsedMs: 0, statePath: join(directory, 'budget.json'), eventsPath: join(directory, 'provider-events.jsonl'), hostPid: join(directory, 'host-pid.json'), hostExit: join(directory, 'host-exit.json'), supervisorPath: join(directory, 'supervisor.json') };
    validateRunLimits(settings.limits);
    await save(settings.statePath, { admitted: 0, rejected: 0, elapsedMs: 0, reason: null });
    let supervisor, fixture, fixtureClosed;
    const result = { name, status: 'not-run', processes: [] };
    try {
      supervisor = startLimitSupervisor(settings);
      supervisor.stderr.on('data', bytes => appendFileSync(join(directory, 'supervisor.stderr.log'), bytes));
      await new Promise((accept, reject) => { supervisor.once('error', reject); supervisor.once('message', accept); supervisor.once('exit', () => reject(new Error('Supervisor exited before ready'))); });
      const dispatchPath = join(directory, 'dispatch.jsonl');
      const fixtureSource = name === 'request-limit'
        ? `import * as fs from 'node:fs';import * as crypto from 'node:crypto';const createRunGuard=${createRunGuard.toString()};const callbacks={};(${observe.toString()})({on:(name,fn)=>callbacks[name]=fn},${JSON.stringify({ output: settings.eventsPath, model: 'fixture/offline', markers: [], refs: [], runLimits: settings })},fs,crypto);for(let n=1;n<=13;n++){try{callbacks.before_provider_request({requestId:String(n),payload:{}},{model:{provider:'fixture',id:'offline'}})}catch{}fs.appendFileSync(${JSON.stringify(dispatchPath)},JSON.stringify({dispatch:n})+'\\n');}`
        : 'setInterval(()=>{},1000)';
      fixture = spawn(process.execPath, ['--input-type=module', '-e', fixtureSource], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      fixtureClosed = closed(fixture);
      fixture.stdout.on('data', bytes => appendFileSync(join(directory, 'fixture.stdout.log'), bytes));
      fixture.stderr.on('data', bytes => appendFileSync(join(directory, 'fixture.stderr.log'), bytes));
      supervisor.send({ op: 'own', item: { role: 'fixture', pid: fixture.pid, group: true, proof: 'selftest direct spawn' } });
      if (name === 'deadline') {
        // The driver event loop is blocked across expiry; the independent supervisor must kill the fixture.
        spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,900)'], { timeout: 2000 });
      }
      const exit = await fixtureClosed; result.processes.push(exit);
      supervisor.send({ op: 'terminal', pid: fixture.pid, code: exit.code, signal: exit.signal });
      const budget = await collectLimitResult(settings);
      const state = budget.state;
      result.runLimits = budget;
      if (name === 'request-limit') {
        const dispatched = (await readFile(dispatchPath, 'utf8')).trim().split('\n').map(JSON.parse);
        result.dispatched = dispatched.map(item => item.dispatch);
        assert.deepEqual(result.dispatched, Array.from({ length: 12 }, (_, n) => n + 1));
        assert.equal(exit.code, 86); assert.equal(state.admitted, 12); assert.equal(state.rejected, 1); assert.equal(state.reason, 'maxProviderRequests');
        result.request13StoppedBeforeDispatch = true;
        const resumed = createRunGuard({ ...settings, startedAt: Date.now(), previousElapsedMs: state.elapsedMs }, fsSync, () => { throw new Error('resume exhausted'); });
        assert.throws(() => resumed.check(), /resume exhausted/);
        result.resumeRetainsBudget = true;
      } else {
        assert.equal(exit.signal, 'SIGKILL'); assert.equal(state.reason, 'maxRunMs'); assert.equal(state.admitted, 0);
        result.expiredWhileDriverBlocked = true;
      }
      result.status = 'budget-exhausted';
    } finally {
      if (fixture && fixture.exitCode === null && fixture.signalCode === null) { process.kill(-fixture.pid, 'SIGKILL'); await fixtureClosed; }
      if (supervisor) {
        result.supervisor = await finishLimitSupervisor(supervisor, settings);
        await save(join(directory, 'terminal-evidence.json'), result.supervisor);
        assert.ok(result.supervisor.observedTerminal);
        assert.ok(result.supervisor.processes.length && result.supervisor.processes.every(item => item.observedTerminal && (!item.group || item.observedGroupAbsent || item.observedGroupTerminal)), JSON.stringify(result.supervisor));
      }
      result.cleanup = { stopped: result.processes.every(item => item.observedTerminal) && result.supervisor?.processes.every(item => item.observedTerminal && (!item.group || item.observedGroupAbsent || item.observedGroupTerminal)) };
      result.partialManifest = join(directory, 'manifest.json');
      await save(result.partialManifest, result);
    }
    assert.ok(result.cleanup.stopped);
    assert.equal((await read(result.partialManifest)).status, 'budget-exhausted');
    results.cases.push(result);
  }
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    assert.throws(() => validateRunLimits({ maxRunMs: value, maxProviderRequests: 12 }));
    assert.throws(() => validateRunLimits({ maxRunMs: 1000, maxProviderRequests: value }));
  }
  results.status = 'pass';
  await save(join(output, 'selftest-results.json'), results);
  console.log(JSON.stringify(results, null, 2));
}

if (process.argv[2] === '__supervise-limits') { await superviseLimits(JSON.parse(process.argv[3])); }
else if (process.argv[2] === 'selftest-limits') { await selftestLimits(); }
if (['__supervise-limits', 'selftest-limits'].includes(process.argv[2])) {
  // Supervisor intentionally stays alive until its owned processes have terminal evidence.
  if (process.argv[2] === 'selftest-limits') process.exit(0);
} else {
const args = process.argv.slice(2);
const usage = `Usage: node scripts/verify-tern-surfaces.mjs probe|controlled|run --surface pi-terminal|omp-terminal|omp-native --spec /absolute/owned-run.json --evidence-root /absolute/directory [--resume /absolute/manifest.json]\nnode scripts/verify-tern-surfaces.mjs selftest-limits\nrun uses only magpie/group/e2e; controlled uses local delivery provider and is never product acceptance.\nOptional frozen spec.runLimits={maxRunMs,maxProviderRequests}: positive safe integers, cumulative across startup/reset/scenarios/resume. Limits stay in harness settings, never userTask. selftest-limits is offline (zero provider/Notion calls).`;
if (!args.length || args.some(arg => ['help', '--help', '-h'].includes(arg))) { console.log(usage); process.exit(0); }
const action = args.shift();
const options = {};
while (args.length) { const key = args.shift(); assert.ok(['--surface', '--spec', '--evidence-root', '--resume'].includes(key) && args.length, usage); options[key.slice(2)] = args.shift(); }
assert.ok(['run', 'probe', 'controlled'].includes(action), usage);
const surface = options.surface;
assert.ok(['pi-terminal', 'omp-terminal', 'omp-native'].includes(surface), usage);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const pause = ms => new Promise(accept => setTimeout(accept, ms));
const quote = text => `'${String(text).replaceAll("'", "'\\''")}'`;
const base = await mkdtemp(join(await systemTempRoot(), 'broker-tern-surfaces-'));
const evidence = await evidenceRoot(options['evidence-root'], base);
const output = evidence === base ? base : await mkdtemp(join(evidence, `${surface}-`));
const socketRoot = await mkdtemp('/tmp/bts-');
const socket = join(socketRoot, 'w.sock');
const daemonSocket = join(socketRoot, 'd.sock');
const ternDir = join(base, 'tern');
const env = { ...process.env, TERN_CONFIG_DIR: ternDir, TERN_DAEMON_SOCKET: daemonSocket, STENCIL_LOG_DIR: join(base, 'logs'), STENCIL_LOG: 'warn,stencil_tern=debug,tern::plugin=debug' };
const manifest = { version: 1, surface, action, status: 'not-run', base, evidence: output, model: action === 'run' ? 'magpie/group/e2e' : null, startedAt: new Date().toISOString(), scenarios: [], artifacts: [], processes: [] };
let daemon, window;
let environmentServer;
let ternBinary = 'tern';
const nativeWindow = surface === 'omp-native';
let launchedHost = false;
const hostPid = join(base, 'host-pid.json');
const hostExit = join(base, 'host-exit.json');
const observations = join(output, 'provider-events.jsonl');
const actions = join(output, 'actions.jsonl');
let runtimeSpec, runtimeHostEnv;
let limitSettings, limitSupervisor, runGuard, previous;
let cleaningUp = false;
function checkBudget() {
  if (cleaningUp) return;
  if (manifest.budgetExhausted || (limitSupervisor && (limitSupervisor.exitCode !== null || limitSupervisor.signalCode !== null))) throw new Error('Run budget supervisor stopped admission');
  runGuard?.check();
}
let caseBaseline = {};
let caseRequestBaseline = 0;
let caseProofBaseline = new Map();
async function log(value) { await appendFile(actions, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 }); }
function run(file, argv, extra = {}) {
  checkBudget();
  const result = spawnSync(file, argv, { cwd: base, env, encoding: 'utf8', timeout: 30000, ...extra });
  checkBudget();
  assert.equal(result.status, 0, `${file} ${argv.join(' ')}: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout;
}
function ctl(...argv) {
  checkBudget();
  const startedAt = new Date().toISOString();
  const result = spawnSync(ternBinary, ['ctl', '--control', socket, ...argv], { cwd: base, env, encoding: 'utf8', timeout: 30000 });
  appendFileSync(join(output, 'ctl.jsonl'), JSON.stringify({ startedAt, argv, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message ?? null }) + '\n', { mode: 0o600 });
  checkBudget();
  assert.equal(result.status, 0, `Tern ctl ${argv[0]}: ${result.error?.message || result.stderr || result.stdout}`);
  const value = JSON.parse(result.stdout);
  assert.notEqual(value.ok, false, JSON.stringify(value));
  return value;
}
async function until(label, predicate, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { checkBudget(); if (await predicate()) return; await pause(100); }
  throw new Error(`Timeout: ${label}`);
}
async function rows(path = observations) { try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
async function providerRequestCount() {
  // A custom controlled stream does not necessarily emit before_provider_request.
  // Its fixture captures the context inside each actual stream call. Live runs
  // still count only the real dispatch event, never context observer callbacks.
  if (action === 'controlled') return (await rows(runtimeHostEnv.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE)).length;
  return (await rows()).filter(row => row.phase === 'request').length;
}
const nodes = value => !value || typeof value !== 'object' ? [] : [...(Array.isArray(value) ? [] : [value]), ...Object.values(value).flatMap(nodes)];
const editor = () => ctl('tree', '.sf-editor').nodes?.find(node => typeof node.text === 'string');
function terminalText() { return JSON.stringify(ctl('tree')); }
async function shot(label) {
  assert.match(label, /^[a-z0-9-]+$/);
  const tree = ctl('tree');
  await save(join(output, `${label}.tree.json`), tree);
  const capture = ctl('shot', label);
  assert.ok(typeof capture.png === 'string', 'Current ctl shot must return a PNG path');
  const path = resolve(base, capture.png);
  assert.ok(path.startsWith(`${base}/`), 'Capture must belong to this owned window');
  const bytes = await readFile(path);
  manifest.shots ??= [];
  manifest.shots.push({ label, path, sha256: sha(bytes), bytes: bytes.length, capture, tree: `${label}.tree.json` });
}
async function own(child, role) {
  const record = { role, pid: child.pid, argv: child.spawnargs };
  manifest.processes.push(record);
  if (limitSupervisor?.connected) limitSupervisor.send({ op: 'own', item: { role, pid: child.pid, proof: 'direct spawn child', argv: child.spawnargs } });
  child.once('error', error => { record.error = error.message; });
  child.once('close', (code, signal) => {
    Object.assign(record, { code, signal, observedExit: true });
    if (limitSupervisor?.connected) limitSupervisor.send({ op: 'terminal', pid: child.pid, code, signal });
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => { appendFileSync(join(output, `${role}.log`), data, { mode: 0o600 }); });
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await new Promise(accept => child.once('close', accept));
  clearTimeout(timer);
}
async function bindArtifact(item) {
  assert.ok(isAbsolute(item.path), 'Artifact paths must be absolute');
  assert.match(item.sha256, /^[a-f0-9]{64}$/);
  const path = await realpath(item.path);
  const actual = sha(await readFile(path));
  assert.equal(actual, item.sha256, `Frozen hash mismatch: ${path}`);
  manifest.artifacts.push({ role: item.role, path, sha256: actual });
}
async function step(item, scenario, index) {
  checkBudget();
  const label = `${scenario}-${item.id ?? index + 1}`;
  await log({ scenario, index, step: item });
  manifest.currentStep = { scenario, id: item.id ?? String(index + 1), op: item.op };
  switch (item.op) {
    case 'type': ctl('type', JSON.stringify(item.text)); break;
    case 'key': ctl('key', item.key); break;
    case 'candidate': {
      if (item.queryText !== undefined) {
        assert.ok(surface === 'pi-terminal' || surface === 'omp-terminal', 'Unique public query selection requires a terminal surface');
        assert.ok(typeof item.queryText === 'string' && item.queryText.length);
        const request = { version: 1, text: item.queryText, cursor: item.queryText.length, cwd: runtimeSpec.cwd, config: runtimeSpec.config };
        const query = join(runtimeSpec.companion, 'query/completion.mjs');
        const result = spawnSync(process.execPath, [query], { input: JSON.stringify(request), encoding: 'utf8', cwd: runtimeSpec.cwd, env: runtimeHostEnv, timeout: 30000 });
        await save(join(output, `${label}.query.json`), { request, status: result.status, stdout: result.stdout, stderr: result.stderr });
        assert.equal(result.status, 0, result.stderr);
        const response = JSON.parse(result.stdout);
        assert.equal(response.version, 1);
        assert.equal(response.failures?.length ?? 0, 0, 'Candidate query has source failures');
        assert.equal(response.items.length, 1, 'Terminal selection requires one exact public candidate, never a default row assumption');
        for (const key of ['identity', 'ref', 'kind', 'source', 'value']) assert.equal(response.items[0][key], item.identity[key], `Exact candidate ${key}`);
        assert.equal(response.edit?.prefix, item.queryText);
        ctl('key', 'tab');
        await log({ label, selectedIdentity: item.identity, actual: response.items[0], selection: 'single exact public query candidate plus real UI Tab; accepted draft and screenshot asserted separately' });
        break;
      }
      const tree = ctl('tree', item.selector ?? '.sf-item');
      await save(join(output, `${label}.candidates.json`), tree);
      const node = exactCandidate(tree, item.identity);
      await log({ label, selectedIdentity: item.identity, actual: node });
      ctl('click', String(node.rect[0] + node.rect[2] / 2), String(node.rect[1] + node.rect[3] / 2));
      break;
    }
    case 'click': {
      const found = ctl('tree', item.selector).nodes ?? [];
      const matches = found.filter(value => !item.text || value.text === item.text);
      assert.equal(matches.length, 1, 'Click must identify exactly one visible node');
      const node = matches[0];
      assert.ok(node?.rect, `No clickable ${item.selector}`);
      ctl('click', String(node.rect[0] + node.rect[2] * (item.x ?? 0.5)), String(node.rect[1] + node.rect[3] * (item.y ?? 0.5))); break;
    }
    case 'palette': ctl('palette', JSON.stringify(item.query)); break;
    case 'expect':
      if (surface === 'omp-native') await until(label, () => nodes(item.selector ? ctl('tree', item.selector) : ctl('tree')).some(node => typeof node.text === 'string' && (item.match === 'contains' ? node.text.includes(item.text) : node.text === item.text)), item.timeoutMs);
      else ctl('expect', JSON.stringify(item.text));
      break;
    case 'draft': {
      assert.equal(surface, 'omp-native', 'Exact native draft observation requires native renderer; terminal use visible expect + screenshot');
      await until(label, async () => {
        if (!item.token) return editor()?.text === item.text;
        const tree = ctl('tree');
        const all = nodes(tree);
        const draft = all.find(node => node.class?.split(' ').includes('sf-ed-text'));
        if (!draft || draft.text !== item.prefix) return false;
        const descendants = nodes(draft);
        const tokens = descendants.filter(node => node.text === item.token && !node.class?.split(' ').includes('sf-t-icon'));
        if (tokens.length !== 1) return false;
        const caret = descendants.find(node => node.class?.split(' ').includes('sf-caret'));
        if (!caret?.rect || caret.rect[0] < tokens[0].rect[0] + tokens[0].rect[2] - 1) return false;
        if (item.suffix && !descendants.some(node => node.text === item.suffix)) return false;
        await save(join(output, `${label}.draft.json`), { prefix: draft.text, token: tokens[0], caret, suffix: item.suffix ?? '', tree });
        return true;
      }, item.timeoutMs);
      break;
    }
    case 'requests': {
      const count = async () => (await providerRequestCount()) - caseRequestBaseline;
      if (item.stableMs) { const end = Date.now() + item.stableMs; while (Date.now() < end) { assert.equal(await count(), item.count); await pause(100); } }
      else await until(label, async () => (await count()) === item.count, item.timeoutMs);
      break;
    }
    case 'provider': {
      const requests = (await rows()).filter(row => row.phase === (item.phase ?? 'request')).slice(caseBaseline[item.phase ?? 'request'] ?? 0);
      const event = requests[item.index ?? requests.length - 1];
      assert.ok(event, 'Missing actual provider event');
      for (const [marker, count] of Object.entries(item.markers ?? {})) assert.equal(event.markers?.[marker], count, marker);
      if (item.minImages !== undefined) assert.ok(event.imageHashes.length >= item.minImages, 'Image missing from actual request/context');
      if (item.sameImagesFrom !== undefined) assert.deepEqual(event.imageHashes, requests[item.sameImagesFrom]?.imageHashes, 'Attachment identity changed');
      break;
    }
    case 'events': {
      await until(label, async () => (await rows()).filter(row => row.phase === item.phase).length - (caseBaseline[item.phase] ?? 0) >= item.count, item.timeoutMs);
      assert.equal((await rows()).filter(row => row.phase === item.phase).length - (caseBaseline[item.phase] ?? 0), item.count);
      break;
    }
    case 'tool-read': {
      assert.ok(typeof item.path === 'string' && item.path.length);
      await until(label, async () => {
        const events = await rows();
        const calls = events.filter(event => event.phase === 'tool').slice(caseBaseline.tool ?? 0);
        const call = calls.find(event => event.name === 'read' && event.input?.path === item.path);
        if (!call) return false;
        const results = events.filter(event => event.phase === 'tool-result').slice(caseBaseline['tool-result'] ?? 0);
        const result = results.find(event => event.name === 'read' && (event.file?.path === item.path || (call.requestId && event.requestId === call.requestId)));
        if (!result) return false;
        if (item.sha256) assert.equal(result.file?.sha256, item.sha256);
        if (item.snapshotSha256) assert.equal(result.sha256, item.snapshotSha256);
        await save(join(output, `${label}.read.json`), { call, result });
        return true;
      }, item.timeoutMs);
      break;
    }
    case 'controlled-proof': {
      assert.ok(typeof item.path === 'string' && isAbsolute(item.path), 'controlled-proof requires its actual provider output path');
      assert.equal(action, 'controlled');
      await until(label, async () => {
        const events = (await rows(item.path)).slice(caseProofBaseline.get(item.path) ?? 0);
        const rejected = events.find(event => event.phase === 'controlled-rejected');
        assert.ok(!rejected, rejected?.reason);
        const proof = events.find(event => event.phase === 'verified');
        if (!proof) return false;
        assert.equal(proof.realModel, false); assert.equal(proof.liveNotion, false);
        manifest.controlledProof = proof;
        return true;
      }, item.timeoutMs);
      break;
    }
    case 'shot': await shot(item.label ?? label); break;
    case 'control':
      assert.ok(['focus', 'split', 'tab', 'session', 'goto', 'dialog', 'drop'].includes(item.command), 'Unsupported public interaction');
      assert.ok(Array.isArray(item.args) && item.args.every(value => typeof value === 'string'));
      ctl(item.command, ...item.args.map(value => value === '$IMAGE' ? manifest.image.path : value)); break;
    default: throw new Error(`Unknown step ${item.op}`);
  }
}
try {
  const spec = options.spec ? await json(options.spec) : null;
  if (spec) {
    validateRunLimits(spec.runLimits);
    manifest.specSha256 = sha(await readFile(options.spec));
    previous = options.resume ? await json(options.resume) : null;
    if (previous) assert.equal(previous.specSha256, manifest.specSha256, 'Resume requires identical frozen spec');
    if (spec.runLimits) {
      if (previous) assert.ok(previous.runLimits?.state, 'Limited resume requires prior budget accounting');
      const state = previous?.runLimits?.state ?? { admitted: 0, rejected: 0, elapsedMs: 0, reason: null };
      for (const key of ['admitted', 'rejected', 'elapsedMs']) assert.ok(Number.isSafeInteger(state[key]) && state[key] >= 0, `Invalid resume budget ${key}`);
      limitSettings = { limits: spec.runLimits, startedAt: invocationStartedAt, previousElapsedMs: state.elapsedMs, statePath: join(output, 'run-budget.json'), eventsPath: observations, hostPid, hostExit, supervisorPath: join(output, 'limit-supervisor.json'), windowLog: nativeWindow ? join(output, 'window.log') : null, daemonSocket };
      await save(limitSettings.statePath, state);
      manifest.runLimits = { limits: spec.runLimits, state, startedAt: invocationStartedAt };
      runGuard = createRunGuard(limitSettings, fsSync, () => { throw new Error('Run budget exhausted'); });
      runGuard.check();
      limitSupervisor = startLimitSupervisor(limitSettings);
      await new Promise((accept, reject) => { limitSupervisor.once('error', reject); limitSupervisor.once('exit', () => reject(new Error('Limit supervisor exited before ready'))); limitSupervisor.once('message', accept); });
      limitSupervisor.on('message', message => { if (message.op === 'exhausted') manifest.budgetExhausted = true; });
      limitSupervisor.stderr.on('data', bytes => appendFileSync(join(output, 'limit-supervisor.log'), bytes));
      limitSupervisor.on('exit', () => {
        if (!cleaningUp) {
          manifest.budgetExhausted = true;
          try { const host = JSON.parse(fsSync.readFileSync(hostPid, 'utf8')); process.kill(-host.pid, 'SIGKILL'); } catch {}
        }
      });
      checkBudget();
    }
  }
  ternBinary = spec?.ternBinary ?? (await resolveHost('tern')).identity;
  assert.ok(isAbsolute(ternBinary), 'Tern binary must resolve to an explicit executable');
  manifest.transport = nativeWindow ? 'owned-native-window' : 'serve-transport-only-no-companion';
  manifest.ternVersion = run(ternBinary, ['--version']).trim();
  manifest.ternIdentity = { path: await realpath(ternBinary), sha256: sha(await readFile(await realpath(ternBinary))) };
  await writeFile(join(output, 'tern-help.txt'), run(ternBinary, ['help', 'dev']));
  if (spec && action !== 'probe') {
    assert.equal(spec.version, 1);
    if (action === 'run') { assert.equal(spec.surface, surface, 'Spec must match the selected surface'); validateSpec(spec); }
    else { assert.equal(spec.model, 'tern-surface-controlled/delivery'); assert.ok(isAbsolute(spec.controlledExtension)); }
    assert.ok(/\.[cm]?tsx?$/.test(spec.extension), 'Use official installed TypeScript extension entry, never a derived host bundle');
    const requireInstalled = createRequire(spec.extension);
    manifest.localDependencies = [];
    for (const dependency of ['yaml', 'effect']) {
      const path = await realpath(requireInstalled.resolve(dependency));
      assert.ok(path.includes('/node_modules/'), `Dependency ${dependency} must resolve from installed local packages`);
      manifest.localDependencies.push({ name: dependency, path, sha256: sha(await readFile(path)) });
    }
    assert.ok(typeof spec.model === 'string' && spec.model.includes('/'), 'Explicit provider/model required');
    manifest.model = spec.model;
    manifest.scope = spec.scope ?? { cwd: spec.cwd, agentDir: spec.agentDir, config: spec.config };
    assert.ok(spec.fixtureReceipt && isAbsolute(spec.fixtureReceipt));
    const receipt = await json(spec.fixtureReceipt);
    assert.ok(receipt.owned === true, 'Fixture receipt must attest owned targets');
    manifest.fixtureReceipt = { path: spec.fixtureReceipt, sha256: sha(await readFile(spec.fixtureReceipt)) };
    for (const role of ['cli', 'broker', 'tern', 'query']) assert.ok(spec.artifacts.some(item => item.role === role), `Missing frozen ${role}`);
    for (const item of spec.artifacts) await bindArtifact(item);
    assert.equal(await realpath(spec.extension), manifest.artifacts.find(item => item.role === 'broker').path);
    assert.ok(isAbsolute(spec.companion) && isAbsolute(spec.config) && isAbsolute(spec.agentDir));
    assert.equal(await realpath(join(spec.companion, 'query/completion.mjs')), manifest.artifacts.find(item => item.role === 'query').path);
    assert.equal(await realpath(ternBinary), manifest.artifacts.find(item => item.role === 'tern').path);
    const embeddedCli = join(spec.companion, 'query/ntn-skills.mjs');
    assert.equal(sha(await readFile(embeddedCli)), manifest.artifacts.find(item => item.role === 'cli').sha256, 'Companion CLI differs from frozen CLI');
    assert.ok(spec.scenarios?.length);
    await save(join(output, 'run-spec.json'), spec);
    manifest.config = { path: spec.config, sha256: sha(await readFile(spec.config)), agentDir: spec.agentDir };
    if (action === 'run') for (const id of requiredScenarios(surface)) assert.ok(spec.scenarios.some(item => item.id === id), `Missing scenario or explicit gate: ${id}`);
  }
  // Real 2x2 RGBA PNG, decoded by file/sips in smoke; fixture is local and has no network target.
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8Dwn4GBgYGJAQoAHhgCAfW7vs0AAAAASUVORK5CYII=', 'base64');
  const imagePath = join(output, 'attachment.png');
  await writeFile(imagePath, image, { mode: 0o600 });
  manifest.image = { path: imagePath, sha256: sha(image), bytes: image.length };
  await mkdir(join(ternDir, 'omp'), { recursive: true });
  await writeFile(join(ternDir, 'omp/state.json'), JSON.stringify({ managed: false, checked: 0, no_build: false, offered: true }));
  if (spec) {
    await mkdir(join(ternDir, 'plugin-data/context-broker'), { recursive: true });
    await save(join(ternDir, 'plugin-data/context-broker/config.json'), { config: spec.config, agentDir: spec.agentDir, ...spec.companionConfig });
  }
  const host = spec?.hostBinary ?? (action !== 'probe' || surface !== 'pi-terminal' ? (surface === 'pi-terminal' ? 'pi' : 'omp') : process.execPath);
  const command = await resolveHost(host);
  if (spec?.hostSha256) assert.equal(sha(await readFile(command.identity)), spec.hostSha256, 'Host entry hash mismatch');
  const hostArgs = action === 'probe'
    ? (surface === 'pi-terminal' ? ['-e', 'console.log("TERN_TERMINAL_PROBE_NO_PRODUCT");setInterval(()=>{},1000)'] : ['--no-extensions', '--no-skills', '--no-rules', '--no-title', '--no-tools', '--no-session', '--model', 'magpie/group/e2e'])
    : ['--no-extensions', '--no-skills', ...(surface === 'pi-terminal' ? ['--no-mcp', '--no-context-files', '--no-prompt-templates', '--offline', '--approve'] : ['--no-rules', '--no-title', '--smol', spec.model, '--slow', spec.model, '--plan', spec.model]), '--session-dir', join(base, 'sessions'), '-e', spec.extension, '-e', join(base, 'observer.mjs'), '--model', spec.model, ...(spec.hostArgs ?? [])];
  if (action === 'controlled') hostArgs.push('-e', spec.controlledExtension);
  if (spec) assert.ok(!(spec.hostArgs ?? []).some(value => /^(?:--model|--provider|--smol|--slow|--plan|--continue|--resume|--extension|-e)(?:=|$)/.test(value)), 'Host args may not override selector/session/extension');
  const hostEnv = isolatedEnv({ base: join(base, 'home'), agentDir: spec?.agentDir ?? join(base, 'agent'), CONTEXT_BROKER_CONFIG: spec?.config ?? '', CONTEXT_BROKER_HOST: surface === 'pi-terminal' ? 'pi' : 'omp', PI_TUI_NATIVE: surface === 'omp-native' ? '1' : '0', PI_TUI_TSP_RECORD: join(output, 'native.tsp.jsonl'), BROKER_E2E_PROCESS_LEDGER: join(output, 'host-processes.jsonl'), ...(spec?.hostEnv ?? {}) });
  for (const name of spec?.hostEnvNames ?? []) {
    assert.match(name, /^[A-Z][A-Z0-9_]*$/);
    assert.ok(process.env[name] !== undefined, `Missing required environment variable ${name}`);
    hostEnv[name] = process.env[name];
  }
  manifest.hostEnvironment = { explicitNames: Object.keys(hostEnv).sort(), inheritedNames: spec?.hostEnvNames ?? [] };
  runtimeSpec = spec; runtimeHostEnv = hostEnv;
  if (action === 'controlled') assert.ok(typeof hostEnv.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE === 'string' && isAbsolute(hostEnv.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE), 'Controlled requests require the actual provider capture path');
  if (action !== 'probe') manifest.providerRequests = { source: action === 'controlled' ? 'controlled-provider-capture' : 'before_provider_request', path: action === 'controlled' ? hostEnv.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE : observations, baseline: await providerRequestCount() };
  assert.equal(hostEnv.PI_TUI_NATIVE, surface === 'omp-native' ? '1' : '0');
  for (const name of ['HOME', 'PI_CODING_AGENT_DIR', 'OMP_CODING_AGENT_DIR', 'CONTEXT_BROKER_CONFIG']) assert.equal(hostEnv[name], name === 'HOME' ? join(base, 'home') : name === 'CONTEXT_BROKER_CONFIG' ? spec?.config ?? '' : spec?.agentDir ?? join(base, 'agent'), `Unexpected ${name} override`);
  await mkdir(hostEnv.HOME, { recursive: true });
  await mkdir(hostEnv.PI_CODING_AGENT_DIR, { recursive: true });
  if (surface !== 'pi-terminal') {
    const setupPath = join(base, 'host-setup.json');
    const setup = { startup: { setupWizard: false, checkUpdate: false }, modelRoles: Object.fromEntries(['default', 'smol', 'slow', 'plan'].map(role => [role, spec?.model ?? 'magpie/group/e2e'])) };
    await save(setupPath, setup);
    hostArgs.unshift('--config', setupPath);
    manifest.hostSetup = { path: setupPath, sha256: sha(await readFile(setupPath)), setup, provenance: 'AH255 overlay.yml and pro-native-basic/env/agent-run/config.yml: explicit startup.setupWizard=false/checkUpdate=false; model roles use the selected existing model' };
  }
  if (spec) await writeFile(join(base, 'observer.mjs'), `import * as fs from 'node:fs';import * as crypto from 'node:crypto';const createRunGuard=${createRunGuard.toString()};export default api=>{(${observe.toString()})(api,${JSON.stringify({ output: observations, model: spec.model, markers: spec.markers ?? [], refs: spec.refs ?? [], runLimits: limitSettings })},fs,crypto);};`, { mode: 0o600 });
  const launcher = join(base, 'host.mjs');
  const environmentSocket = join(socketRoot, 'env.sock');
  environmentServer = createServer(client => { client.end(JSON.stringify(hostEnv)); environmentServer.close(); });
  await new Promise((accept, reject) => { environmentServer.once('error', reject); environmentServer.listen(environmentSocket, accept); });
  await writeFile(launcher, `import {spawn} from 'node:child_process';import {connect} from 'node:net';import {writeFileSync} from 'node:fs';const parts=[];const channel=connect(${JSON.stringify(environmentSocket)});for await(const chunk of channel)parts.push(chunk);const env=JSON.parse(Buffer.concat(parts).toString());const child=spawn(${JSON.stringify(command.file)},${JSON.stringify([...command.prefix, ...hostArgs])},{cwd:${JSON.stringify(spec?.cwd ?? base)},env,stdio:'inherit',detached:true});writeFileSync(${JSON.stringify(hostPid)},JSON.stringify({pid:child.pid,launcherPid:process.pid}));process.on('SIGTERM',()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}});child.on('close',(code,signal)=>{writeFileSync(${JSON.stringify(hostExit)},JSON.stringify({pid:child.pid,code,signal,observedExit:true}));process.exit(code??0);});`, { mode: 0o600 });
  manifest.host = { path: command.identity, sha256: sha(await readFile(command.identity)), argv: [command.file, ...command.prefix, ...hostArgs], rendererOverride: hostEnv.PI_TUI_NATIVE };
  manifest.host.version = run(command.file, [...command.prefix, '--version'], { env: hostEnv }).trim();
  await writeFile(join(output, 'host-help.txt'), run(command.file, [...command.prefix, '--help'], { env: hostEnv }));
  if (spec?.companion) {
    manifest.pluginInstall = JSON.parse(run(ternBinary, ['plugin', 'install', spec.companion, '--json']));
    manifest.plugins = JSON.parse(run(ternBinary, ['plugin', 'list', '--json']));
  }
  if (!nativeWindow) {
    daemon = spawn(ternBinary, ['daemon', '--socket', daemonSocket], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] }); await own(daemon, 'daemon');
    await until('owned daemon socket', async () => { try { return (await stat(daemonSocket)).isSocket(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } });
  }
  const role = nativeWindow ? 'window' : 'serve';
  window = spawn(ternBinary, nativeWindow ? ['--control', socket, base] : ['serve', '--control', socket, '--out', join(base, 'shots')], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] }); await own(window, role);
  await until('owned control ready', async () => {
    if (window.exitCode !== null) throw new Error(`Owned Tern ${role} exited ${window.exitCode}; no existing window fallback`);
    try { return (await stat(socket)).isSocket(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  if (nativeWindow) {
    await until('owned daemon spawn receipt', async () => /daemon process spawned.*pid[=: ]+(\d+)/.test(await readFile(join(output, 'window.log'), 'utf8')));
    const text = await readFile(join(output, 'window.log'), 'utf8');
    const pid = Number(text.match(/daemon process spawned.*pid[=: ]+(\d+)/)[1]);
    manifest.ownedDaemon = { pid, source: 'owned window daemon process spawned log' };
  }
  if (nativeWindow && spec?.companion) {
    const discovery = join(output, 'window-actions.json');
    await until('window half load', async () => /plugin window halves loaded count=[1-9]/.test(await readFile(join(output, 'window.log'), 'utf8')));
    ctl('carly', 'lua', JSON.stringify(`tern.fs.write(${JSON.stringify(discovery)}, tern.json.encode({actions=cx.actions:list("context-broker"),keys=cx.actions:keys()})); return "saved"`));
    manifest.windowHalfCount = Number((await readFile(join(output, 'window.log'), 'utf8')).match(/plugin window halves loaded count=(\d+)/)[1]);
    await until('actual action discovery', async () => { try { return (await json(discovery)).actions.length > 0; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } });
    manifest.activation = await json(discovery);
    assert.ok(manifest.activation.actions.some(item => item.id === 'plugin.context-broker.complete' && item.available));
    assert.ok(JSON.stringify(manifest.activation.keys).includes('plugin.context-broker.complete'));
    ctl('key', 'escape');
    ctl('key', 'ctrl+alt+shift+k');
    await until('shortcut callback', () => JSON.stringify(ctl('tree')).includes('Manual completion requires a local OMP native draft'));
    manifest.activation.shortcutCallback = true;
    await shot('companion-shortcut');
  }
  ctl('tab', 'new');
  ctl('ready');
  const spawnArgv = [process.execPath, launcher];
  manifest.launch = { executable: process.execPath, launcher, environmentNames: Object.keys(hostEnv), argvContract: 'node launcher; explicit environment transferred once over owned Unix socket, never shell grid or disk' };
  ctl('run', JSON.stringify(spawnArgv.map(quote).join(' ')));
  await until('owned host process receipt', async () => { try { return Boolean((await json(hostPid)).pid); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } });
  launchedHost = true;
  if (surface === 'omp-native') {
    await until('actual native editor', () => Boolean(editor()), 60000);
    await until('native composer without startup picker', () => {
      const tree = ctl('tree');
      return Boolean(editor()) && !nodes(tree).some(node => node.role === 'dialog' || (typeof node.title === 'string' && node.title === 'Sign in · Pick a provider'));
    }, 30000);
    assert.ok((await readFile(join(output, 'native.tsp.jsonl'), 'utf8')).trim(), 'Native TSP recording is required');
    manifest.renderer = { observed: 'native', editor: editor(), evidence: 'native .sf-editor plus recorded TSP; forced probe alone is insufficient' };
  } else {
    if (action === 'probe' && surface === 'pi-terminal') ctl('expect', 'TERN_TERMINAL_PROBE_NO_PRODUCT');
    else if (action === 'probe') ctl('expect', 'magpie');
    else await until('host session ready', async () => (await rows()).some(row => row.phase === 'selected'), 60000);
    assert.equal(ctl('tree', '.sf-editor').nodes?.length ?? 0, 0, 'Terminal surface unexpectedly rendered native editor');
    manifest.renderer = { observed: 'terminal', nativeEditorAbsent: true, evidence: 'PI_TUI_NATIVE=0 and actual Tern tree/startup shot' };
  }
  await shot('startup');
  if (spec && action !== 'probe') {
    await until('actual selected model', async () => (await rows()).some(row => row.phase === 'selected' && row.model === spec.model), 60000);
    for (const scenario of spec.scenarios) {
      assert.match(scenario.id, /^[a-z0-9-]+$/);
      const result = { id: scenario.id, status: 'not-run' }; manifest.scenarios.push(result);
      result.intent = scenario.intent;
      if (previous?.scenarios.some(item => item.id === scenario.id && item.status === 'pass')) { result.status = 'pass'; result.retainedFrom = options.resume; continue; }
      if (scenario.gate) { result.status = 'blocked'; result.reason = scenario.gate; continue; }
      try {
        for (const [index, item] of (scenario.reset ?? []).entries()) await step(item, `${scenario.id}-reset`, index);
        caseBaseline = {};
        for (const row of await rows()) caseBaseline[row.phase] = (caseBaseline[row.phase] ?? 0) + 1;
        caseRequestBaseline = await providerRequestCount();
        caseProofBaseline = new Map();
        for (const item of scenario.steps ?? []) if (item.op === 'controlled-proof') caseProofBaseline.set(item.path, (await rows(item.path)).length);
        assert.ok(scenario.steps?.length && scenario.steps.some(item => ['expect', 'draft', 'requests', 'provider', 'events', 'tool-read'].includes(item.op)) && scenario.steps.some(item => item.op === 'shot'), 'Scenario needs actual observation/assertion and screenshot, or explicit gate');
        for (const [index, item] of scenario.steps.entries()) await step(item, scenario.id, index);
        result.status = 'pass';
      }
      catch (error) { result.status = 'failed'; result.error = error.message; result.stage = manifest.currentStep; throw error; }
    }
    manifest.status = manifest.scenarios.some(item => item.status === 'blocked') ? 'blocked' : 'pass';
    if (action === 'controlled' && manifest.status === 'pass') manifest.status = 'controlled-pass';
  } else { manifest.status = 'probe-only'; manifest.productAcceptance = 'not-run'; }
} catch (error) {
  manifest.status = 'failed'; manifest.error = error.message;
  try { await shot('failure'); } catch (captureError) { manifest.captureError = captureError.message; }
  process.exitCode = 1;
} finally {
  cleaningUp = true;
  const errors = [];
  environmentServer?.close();
  if (launchedHost || fsSync.existsSync(hostPid)) {
    try {
      const identity = await json(hostPid);
      try { await json(hostExit); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { process.kill(-identity.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        await until('host observed exit', async () => { try { return (await json(hostExit)).observedExit; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, 10000);
      }
      manifest.hostExit = await json(hostExit);
    } catch (error) { errors.push(error.message); }
  }
  try { if (window && window.exitCode === null && window.signalCode === null) ctl('quit'); } catch (error) { errors.push(error.message); }
  await stop(window); await stop(daemon);
  // Recover a daemon even when startup failed before assigning manifest.ownedDaemon.
  const daemonReceipts = ownedWindowDaemons({ windowLog: nativeWindow ? join(output, 'window.log') : null, daemonSocket });
  manifest.ownedDaemons = daemonReceipts;
  for (const item of daemonReceipts) {
    try { process.kill(item.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') errors.push(error.message); }
    try { await until('receipt-owned daemon exit', () => { try { process.kill(item.pid, 0); return false; } catch (error) { if (error.code !== 'ESRCH') throw error; return true; } }, 10000); item.observedTerminal = true; item.terminalState = 'absent'; } catch (error) { errors.push(error.message); }
  }
  if (manifest.ownedDaemon) {
    const proven = daemonReceipts.find(item => item.pid === manifest.ownedDaemon.pid);
    if (proven) Object.assign(manifest.ownedDaemon, proven);
    else {
      try { process.kill(manifest.ownedDaemon.pid, 0); errors.push('Owned daemon remains live without exact socket proof'); }
      catch (error) { if (error.code === 'ESRCH') Object.assign(manifest.ownedDaemon, { observedTerminal: true, terminalState: 'absent' }); else errors.push(error.message); }
    }
  }
  if (limitSupervisor) {
    try {
      const terminal = await finishLimitSupervisor(limitSupervisor, limitSettings);
      manifest.limitSupervisor = terminal;
      if (terminal.error || terminal.processes.some(item => !item.observedTerminal || (item.group && !item.observedGroupAbsent && !item.observedGroupTerminal))) errors.push(terminal.error ?? 'Supervisor lacks terminal evidence for an owned PID/group');
    } catch (error) { errors.push(error.message); }
  }
  if (limitSettings) {
    try {
      manifest.runLimits = await collectLimitResult(limitSettings, manifest.limitSupervisor);
      if (manifest.runLimits.exhausted || manifest.budgetExhausted) {
        manifest.status = 'budget-exhausted';
        manifest.error = `Run budget exhausted: ${manifest.runLimits.reason ?? 'supervisor-failure'}`;
        process.exitCode = 1;
      }
    } catch (error) { errors.push(error.message); manifest.status = 'failed'; }
  }
  if (manifest.providerRequests) {
    try { manifest.providerRequests.observed = (await providerRequestCount()) - manifest.providerRequests.baseline; }
    catch (error) { errors.push(error.message); manifest.status = 'failed'; }
  }
  manifest.cleanup = { stopped: !errors.length && (!launchedHost || manifest.hostExit?.observedExit === true) && manifest.processes.every(item => item.observedExit), errors };
  if (!manifest.cleanup.stopped) process.exitCode = 1;
  manifest.finishedAt = new Date().toISOString();
  manifest.verdict = { status: manifest.status, stage: manifest.currentStep ?? 'startup', productAcceptance: action === 'run' && manifest.status === 'pass', resume: { manifest: join(output, 'manifest.json'), completed: manifest.scenarios.filter(item => item.status === 'pass').map(item => item.id) } };
  await save(join(output, 'manifest.json'), manifest);
  console.log(`Tern surface evidence retained: ${output}`);
  console.log(JSON.stringify({ status: manifest.status, cleanup: manifest.cleanup, manifest: join(output, 'manifest.json') }));
}
}
