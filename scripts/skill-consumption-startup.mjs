#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNotionFixture, database, canary, resourceCanary } from './notion-integration-fixture.mjs';
import { isolatedEnv, resolveHost, runCommand, writeFakeProvider } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { consumptionCostExtensionSource, consumptionMetricStats, readConsumptionCostEvents } from './skill-consumption-cost.mjs';

const self = fileURLToPath(import.meta.url), root = dirname(dirname(self));
const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => process.hrtime.bigint().toString();
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
const rows = async file => {
  try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const elapsed = (start, end) => /^\d+$/.test(start) && /^\d+$/.test(end) && BigInt(end) >= BigInt(start) ? Number(BigInt(end) - BigInt(start)) / 1e6 : null;
const usage = `Usage:
  node scripts/skill-consumption-startup.mjs help
  node scripts/skill-consumption-startup.mjs doctor [--extension ABSOLUTE_ENTRY]
  node scripts/skill-consumption-startup.mjs run --evidence-root ABSOLUTE_DIRECTORY
    [--extension ABSOLUTE_ENTRY] [--list-delay-ms 2000] [--cold-samples 5]
    [--failure-samples 5] [--warm-samples 0|20] [--timeout-ms 30000]

Runs installed Pi with an isolated HOME, a controlled Notion CLI fixture, the
existing fake provider and a passive observer. No real model or Notion HTTP.
Ordinary native RPC input is sent with waitForState:false. The plan, source tree
hashes, every failed sample, source-call timings and close events are retained.
Warm samples use a primed Broker catalog in NEW Pi processes; the fixture still
delays any uncached/default-View list calls. This is not a real API/token baseline.
`;

export function parseStartupArgs(argv) {
  const [action = 'help', ...args] = argv;
  if (['help', '--help', '-h'].includes(action)) return { action: 'help' };
  if (!['doctor', 'run'].includes(action)) throw new Error('STARTUP_COMMAND_INVALID');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--extension', '--evidence-root', '--list-delay-ms', '--cold-samples', '--failure-samples', '--warm-samples', '--timeout-ms'].includes(key)
        || !args[index + 1] || args[index + 1].startsWith('--') || options[key] !== undefined) throw new Error('STARTUP_OPTION_INVALID');
    options[key] = args[index + 1];
  }
  const number = (key, fallback, minimum, maximum) => {
    const value = options[key] === undefined ? fallback : Number(options[key]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('STARTUP_OPTION_INVALID:' + key);
    return value;
  };
  const extension = options['--extension'] ?? join(root, 'packages/context-broker/src/index.ts');
  if (!isAbsolute(extension)) throw new Error('STARTUP_EXTENSION_MUST_BE_ABSOLUTE');
  if (action === 'run' && !isAbsolute(options['--evidence-root'] ?? '')) throw new Error('STARTUP_EVIDENCE_ROOT_REQUIRED');
  const warmSamples = number('--warm-samples', 0, 0, 100);
  if (warmSamples > 0 && warmSamples < 20) throw new Error('STARTUP_WARM_REQUIRES_AT_LEAST_20_SAMPLES');
  return { action, extension, evidenceRoot: options['--evidence-root'], listDelayMs: number('--list-delay-ms', 2000, 100, 10000),
    coldSamples: number('--cold-samples', 5, 5, 100), failureSamples: number('--failure-samples', 5, 5, 100), warmSamples,
    timeoutMs: number('--timeout-ms', 30000, 1000, 120000) };
}

async function tree(directory) {
  const files = [];
  const visit = async (base, prefix = '') => {
    for (const item of (await readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', '.git'].includes(item.name)) continue;
      const name = prefix + item.name, path = join(base, item.name);
      if (item.isDirectory()) await visit(path, name + '/');
      else if (item.isFile()) { const bytes = await readFile(path); files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) }); }
      else files.push({ path: name, kind: 'nonregular' });
    }
  };
  try { await visit(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { sha256: hash(JSON.stringify(files)), files };
}

async function identities(extension) {
  const host = await resolveHost('pi');
  const within = relative(join(root, 'packages/context-broker/src'), extension);
  const sourceRoot = within !== '..' && !within.startsWith('..' + sep) && !isAbsolute(within)
    ? join(root, 'packages/context-broker/src') : dirname(extension);
  const files = {};
  for (const file of [self, join(root, 'scripts/skill-consumption-cost.mjs'), join(root, 'scripts/notion-integration-fixture.mjs'),
    join(root, 'packages/context-broker/scripts/context-broker-e2e-fixture.mjs'), join(root, 'packages/context-broker/scripts/context-broker-rpc-harness.mjs'),
    join(root, 'package.json'), extension, host.identity]) files[file] = hash(await readFile(file));
  const source = await tree(sourceRoot);
  let revision = null;
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { /* A packaged checkout may lack Git metadata. */ }
  return { node: process.version, pi: { path: host.path, identity: host.identity }, extension, sourceRoot,
    source, files, revision, runtimeSha256: hash(JSON.stringify({ files, source: source.sha256, node: process.version })) };
}

export async function startupDoctor(extension) {
  await access(extension);
  const probe = await mkdtemp(join(tmpdir(), 'skill-startup-doctor-'));
  const result = await runCommand('pi', ['--version'], { cwd: probe, env: isolatedEnv({ base: probe, agentDir: join(probe, 'agent') }), timeoutMs: 10000 });
  return { status: 'ready', piVersion: result.stdout.trim(), identity: await identities(extension),
    modelNetwork: false, notionNetwork: false, method: 'local-file-hashes-and-isolated-pi-version-only', probe };
}

/** Transparent command wrapper for the owned fixture, not a global fetch hook.
 * These byte counts are subprocess stdout/stderr bytes. They are NOT HTTP or
 * token counts. Arguments and the child's stdout/stderr are forwarded unchanged.
 */
export async function runStartupSourceProxy(configPath, args) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const sampleId = process.env.SKILL_STARTUP_SAMPLE_ID;
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(sampleId) || !isAbsolute(config.ledger) || !Array.isArray(config.command)
      || config.command[0] !== process.execPath || config.command[1] !== join(root, 'scripts/notion-integration-fixture.mjs')) throw new Error('STARTUP_SOURCE_PROXY_CONFIG_INVALID');
  const id = process.pid + '-' + randomUUID();
  const command = ['list', 'views', 'ctl', 'read', 'prepare', 'files', 'export'].includes(args[0]) ? args[0] : 'other';
  const log = (phase, details = {}) => appendFileSync(config.ledger, JSON.stringify({ sampleId, id, command,
    argumentsSha256: hash(JSON.stringify(args)), phase, monotonicNs: now(), ...details }) + '\n', { mode: 0o600 });
  log('source-start', { pid: process.pid });
  const child = spawn(config.command[0], [...config.command.slice(1), ...args], { env: process.env, stdio: ['inherit', 'pipe', 'pipe'] });
  let stdoutBytes = 0, stderrBytes = 0, spawnError = null;
  child.stdout.on('data', chunk => { stdoutBytes += chunk.length; process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; process.stderr.write(chunk); });
  child.on('error', error => { spawnError = { code: error.code ?? null, sha256: hash(error.message) }; });
  const handlers = ['SIGTERM', 'SIGINT'].map(signal => {
    const handler = () => { const forwarded = child.kill(signal); log('source-signal', { signal, childPid: child.pid ?? null, forwarded }); };
    process.on(signal, handler); return [signal, handler];
  });
  log('source-child-spawn-return', { pid: process.pid, childPid: child.pid ?? null });
  const closed = await new Promise(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal })));
  log('source-close', { ...closed, childPid: child.pid ?? null, stdoutBytes, stderrBytes, spawnError });
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  return closed.code ?? 1;
}

async function provider(base) {
  const entry = await writeFakeProvider(base), original = await readFile(entry, 'utf8');
  const anchor = 'appendFileSync(captureFile, JSON.stringify({ model: model.id, context }) + "\\n");';
  if (original.split(anchor).length !== 2) throw new Error('STARTUP_FAKE_PROVIDER_CAPTURE_CHANGED');
  const observed = original.replace('import { appendFileSync } from "node:fs";', 'import { appendFileSync } from "node:fs";\nimport { createHash } from "node:crypto";')
    .replace(anchor, `const started = process.hrtime.bigint().toString();
  const json = JSON.stringify(context);
  const measure = value => { const text = JSON.stringify(value) ?? 'null'; return { bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }; };
  appendFileSync(captureFile, JSON.stringify({ boundary: 'controlled-stream-invocation', monotonicNs: started,
    modelSha256: createHash('sha256').update(model.id).digest('hex'), context: measure(context),
    components: Object.fromEntries(['systemPrompt', 'messages', 'tools'].map(key => [key, measure(context[key])])),
    skillBodyMarkerCount: json.split(${JSON.stringify(canary)}).length - 1,
    resourceMarkerCount: json.split(${JSON.stringify(resourceCanary)}).length - 1,
    inputTokens: null, wireBytes: null, method: 'controlled-provider-context-json-not-http-payload-or-token-usage' }) + '\\n', {mode: 0o600});`);
  await writeFile(entry, observed, { mode: 0o600 });
  return { entry, originalSha256: hash(original), observedSha256: hash(observed),
    difference: 'only-the-existing-capture-statement-and-crypto-import; stream-return-events-and-provider-registration-unchanged' };
}

function summarizeSourceCalls(sourceCalls, completion, providerNs) {
  const sourceStart = sourceCalls.filter(event => event.phase === 'source-start'), sourceEnd = sourceCalls.filter(event => event.phase === 'source-close');
  const calls = sourceStart.map(event => {
    const end = sourceEnd.find(candidate => candidate.id === event.id);
    return { id: event.id, command: event.command, startedNs: event.monotonicNs, completedNs: end?.monotonicNs ?? null,
      durationMs: elapsed(event.monotonicNs, end?.monotonicNs), code: end?.code ?? null, signal: end?.signal ?? null,
      stdoutBytes: end?.stdoutBytes ?? null, stderrBytes: end?.stderrBytes ?? null,
      startedAfterCompletion: completion ? BigInt(event.monotonicNs) > BigInt(completion.monotonicNs) : null,
      activeAtCompletion: completion ? BigInt(event.monotonicNs) <= BigInt(completion.monotonicNs)
        && (!end || BigInt(end.monotonicNs) > BigInt(completion.monotonicNs)) : null };
  });
  const lists = calls.filter(call => call.command === 'list'), bodies = calls.filter(call => ['read', 'prepare', 'export'].includes(call.command));
  const latestListCompletion = lists.filter(call => call.completedNs).map(call => BigInt(call.completedNs)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0).at(-1)?.toString();
  return { calls, lists, bodies, latestListCompletion,
    directory: { listCalls: lists.length, failedListCalls: lists.filter(call => call.code !== null && call.code !== 0).length,
      providerAfterAllObservedListCompletions: providerNs && latestListCompletion ? BigInt(providerNs) >= BigInt(latestListCompletion) : null },
    consumption: { sourceCalls: calls.length, bodyCalls: bodies.length,
      activeSourceCallsAtCompletion: completion ? calls.filter(call => call.activeAtCompletion).length : null,
      backgroundCallsStartedAfterCompletion: completion ? calls.filter(call => call.startedAfterCompletion).length : null,
      sourceStdoutBytes: calls.length && calls.every(call => call.stdoutBytes !== null) ? calls.reduce((total, call) => total + call.stdoutBytes, 0) : null } };
}

export function summarizeStartupSample({ scenario, submission, observerEvents = [], observerError = null, providerCalls = [], sourceCalls = [], lifecycle = [], driver = [], rpcError = null, closeError = null, rpcFrames = [] }) {
  const first = providerCalls[0], effective = observerEvents.find(event => event.phase === 'message_update' && event.firstEffectiveText);
  const completion = observerEvents.filter(event => event.phase === 'agent_end').at(-1);
  const source = summarizeSourceCalls(sourceCalls, completion, first?.monotonicNs);
  const observedEnd = observerEvents.at(-1), close = lifecycle.filter(event => event.event === 'close').at(-1);
  const finalText = rpcFrames.filter(frame => frame.type === 'agent_end').at(-1)?.messages?.filter(message => message.role === 'assistant').at(-1)?.content
    ?.filter(part => part.type === 'text').map(part => part.text).join('') ?? '';
  const errors = [];
  if (rpcError) errors.push('STARTUP_RPC_FAILED');
  if (closeError || !close || close.code !== 0 || close.signal) errors.push('STARTUP_PROCESS_CLOSE_INCOMPLETE');
  if (observerError || observedEnd?.phase !== 'observer_end' || observedEnd.complete !== true) errors.push('STARTUP_OBSERVER_INCOMPLETE');
  if (!first || !effective || !completion || finalText.trim() !== 'OK') errors.push('STARTUP_ORDINARY_TURN_INCOMPLETE');
  if (!source.calls.length) errors.push('STARTUP_SOURCE_NOT_OBSERVED');
  if (source.calls.some(call => call.completedNs === null)) errors.push('STARTUP_SOURCE_CLOSE_MISSING');
  if (source.bodies.length || providerCalls.some(call => call.skillBodyMarkerCount || call.resourceMarkerCount)) errors.push('STARTUP_UNEXPECTED_BODY_CONSUMPTION');
  if (scenario.cache === 'cold' && !source.lists.length) errors.push('STARTUP_COLD_DIRECTORY_NOT_OBSERVED');
  return { id: scenario.id, group: scenario.group, scenario, status: errors.length ? 'incomplete' : 'observed', errors,
    taskStatus: finalText.trim() === 'OK' ? 'completed' : rpcError ? 'failed' : 'unproven', rpcError, closeError, observerError,
    submission, timings: { submitToFirstProviderMs: elapsed(submission.monotonicNs, first?.monotonicNs),
      submitToFirstEffectiveTextMs: elapsed(submission.monotonicNs, effective?.monotonicNs),
      submitToCompletionMs: elapsed(submission.monotonicNs, completion?.monotonicNs),
      submitToLastDirectoryCompletionMs: elapsed(submission.monotonicNs, source.latestListCompletion),
      submitToProcessCloseMs: elapsed(submission.monotonicNs, close?.monotonicNs) },
    directory: source.directory,
    consumption: { controlledProviderCalls: providerCalls.length, beforeProviderHookEvents: observerEvents.filter(event => event.phase === 'provider_request').length,
      firstProviderContextJsonBytes: first?.context?.bytes ?? null, totalProviderContextJsonBytes: providerCalls.reduce((total, call) => total + call.context.bytes, 0),
      ...source.consumption,
      modelHttpAttempts: null, notionHttpAttempts: null, inputTokens: null, outputTokens: null, wireBytes: null,
      method: 'controlled-stream-and-fixture-subprocess-observations-only' },
    calls: source.calls, lifecycle, driver, observerEventCount: observerEvents.length, observerChainSha256: observedEnd?.eventSha256 ?? null,
    observerWorkMs: observedEnd?.observerWorkMs ?? null };
}

/** Read-only final reconciliation. A quiet interval is not an execution receipt:
 * source wrappers may start after their host closed or after result.json was read.
 * Existing per-sample snapshots and their failures remain immutable.
 */
export async function reconcileStartupBatch(evidence, samples, { allowLegacyLifecycle = false } = {}) {
  if (!isAbsolute(evidence)) throw new Error('STARTUP_EVIDENCE_ROOT_REQUIRED');
  const artifacts = [], batchErrors = [], ownedProcesses = [];
  const readLedger = async (file, jsonl = true) => {
    const bytes = await readFile(join(evidence, file));
    artifacts.push({ file, bytes: bytes.length, sha256: hash(bytes) });
    if (jsonl && bytes.length && bytes.at(-1) !== 10) throw new Error('STARTUP_LEDGER_TRUNCATED');
    const value = jsonl ? bytes.toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(bytes);
    if (!Array.isArray(value)) throw new Error('STARTUP_LEDGER_INVALID');
    return value;
  };
  let sourceEvents = [];
  try { sourceEvents = await readLedger('source-calls.jsonl'); }
  catch { batchErrors.push('STARTUP_BATCH_SOURCE_LEDGER_UNREADABLE'); }
  const sampleIds = new Set(samples.map(sample => sample.id));
  if (sourceEvents.some(event => !sampleIds.has(event.sampleId))) batchErrors.push('STARTUP_SOURCE_SAMPLE_UNKNOWN');
  const finalized = [];
  for (const sample of samples) {
    const errors = [...sample.errors, ...batchErrors];
    let observerEvents = [], providerCalls = [], lifecycle = [], lifecycleMethod = 'process-lifecycle.json';
    try { observerEvents = await readLedger(sample.id + '/observer.jsonl'); }
    catch { errors.push('STARTUP_BATCH_OBSERVER_UNREADABLE'); }
    try { providerCalls = await readLedger(sample.id + '/provider.jsonl'); }
    catch { errors.push('STARTUP_BATCH_PROVIDER_UNREADABLE'); }
    try { lifecycle = await readLedger(sample.id + '/process-lifecycle.json', false); }
    catch {
      if (allowLegacyLifecycle) { lifecycle = sample.lifecycle; lifecycleMethod = 'legacy-result.json-lifecycle'; }
      else errors.push('STARTUP_BATCH_PROCESS_LEDGER_UNREADABLE');
    }
    const completion = observerEvents.filter(event => event.phase === 'agent_end').at(-1);
    const events = sourceEvents.filter(event => event.sampleId === sample.id), source = summarizeSourceCalls(events, completion, providerCalls[0]?.monotonicNs);
    const close = lifecycle.filter(event => event.event === 'close').at(-1);
    if (!close || close.code !== 0 || close.signal) errors.push('STARTUP_PROCESS_CLOSE_INCOMPLETE');
    if (observerEvents.at(-1)?.phase !== 'observer_end' || observerEvents.at(-1)?.complete !== true) errors.push('STARTUP_OBSERVER_INCOMPLETE');
    const newCallIds = source.calls.filter(call => !sample.calls.some(previous => previous.id === call.id)).map(call => call.id);
    const afterHostClose = close ? events.filter(event => ['source-start', 'source-child-spawn-return'].includes(event.phase)
      && BigInt(event.monotonicNs) > BigInt(close.monotonicNs)).map(event => event.id) : [];
    if (newCallIds.length) errors.push('STARTUP_SOURCE_LATE_OBSERVATION');
    if (afterHostClose.length) errors.push('STARTUP_SOURCE_AFTER_HOST_CLOSE');
    if (!source.calls.length) errors.push('STARTUP_SOURCE_NOT_OBSERVED');
    if (source.calls.some(call => call.completedNs === null)) errors.push('STARTUP_SOURCE_CLOSE_MISSING');
    if (sample.calls.some(previous => !source.calls.some(call => call.id === previous.id))) errors.push('STARTUP_SOURCE_SNAPSHOT_LOST');
    if (source.bodies.length) errors.push('STARTUP_UNEXPECTED_BODY_CONSUMPTION');
    const processes = [
      ...lifecycle.filter(event => event.event === 'spawn').map(event => ({ role: 'host', pid: event.pid })),
      ...events.filter(event => event.phase === 'source-start').map(event => ({ role: 'source-proxy', pid: event.pid, callId: event.id })),
      ...events.filter(event => event.phase === 'source-child-spawn-return').map(event => ({ role: 'source-child', pid: event.childPid, callId: event.id })),
    ];
    for (const owned of processes) {
      let present = null, code = null;
      if (Number.isSafeInteger(owned.pid) && owned.pid > 0) {
        try { process.kill(owned.pid, 0); present = true; }
        catch (error) { code = error.code ?? null; if (code === 'ESRCH') present = false; }
      }
      ownedProcesses.push({ sampleId: sample.id, ...owned, checkedAtMonotonicNs: now(), present, code,
        method: 'signal-0-presence-only; absence-does-not-supply-exit-code-or-close-event' });
      if (present !== false) errors.push('STARTUP_RECORDED_PID_UNRESOLVED');
    }
    finalized.push({ ...sample, status: errors.length ? 'incomplete' : 'observed', errors: [...new Set(errors)], lifecycle,
      directory: source.directory, consumption: { ...sample.consumption, ...source.consumption }, calls: source.calls,
      timings: { ...sample.timings, submitToLastDirectoryCompletionMs: elapsed(sample.submission.monotonicNs, source.latestListCompletion) },
      reconciliation: { lifecycleMethod, originalStatus: sample.status, originalCallCount: sample.calls.length,
        newCallIds, afterHostClose: [...new Set(afterHostClose)], originalSnapshot: sample.id + '/result.json' } });
  }
  return { version: 1, checkedAtMonotonicNs: now(), status: batchErrors.length || finalized.some(sample => sample.status !== 'observed') ? 'incomplete' : 'observed',
    errors: batchErrors, artifacts, ownedProcesses, sourceStarts: sourceEvents.filter(event => event.phase === 'source-start').length,
    sourceCloses: sourceEvents.filter(event => event.phase === 'source-close').length, samples: finalized,
    limitations: ['This is an observed ledger cutoff, not a guarantee that an unrecorded process cannot start later.',
      'A missing PID does not repair a missing close receipt; a present PID may have been reused and is never signalled beyond signal 0.',
      'No RPC input, provider, source arguments, response values or timeout are changed by reconciliation.'] };
}

async function sourceQuiet(ledger, sampleId, timeoutMs) {
  const started = process.hrtime.bigint();
  let stableSince = started, previous = '';
  while (Number(process.hrtime.bigint() - started) / 1e6 < timeoutMs) {
    const events = (await rows(ledger)).filter(event => event.sampleId === sampleId), fingerprint = hash(JSON.stringify(events));
    if (fingerprint !== previous) { previous = fingerprint; stableSince = process.hrtime.bigint(); }
    const open = events.filter(event => event.phase === 'source-start').some(event => !events.some(end => end.phase === 'source-close' && end.id === event.id));
    if (!open && Number(process.hrtime.bigint() - stableSince) / 1e6 >= 250) return { settled: events.some(event => event.phase === 'source-start'),
      observation: events.length ? 'all-observed-calls-closed' : 'no-source-observation', milliseconds: Number(process.hrtime.bigint() - started) / 1e6 };
    await pause(25);
  }
  return { settled: false, milliseconds: Number(process.hrtime.bigint() - started) / 1e6 };
}

function safeError(error) {
  return error ? { name: error.name ?? 'Error', sha256: hash(String(error.message ?? error)),
    reason: /timed out/.test(String(error.message)) ? 'timeout' : /EOF/.test(String(error.message)) ? 'eof-shutdown-failed' : 'operation-failed' } : null;
}

async function prepareSource(base, sourceLedger, options) {
  await mkdir(base, { recursive: true, mode: 0o700 });
  const fixture = await createNotionFixture(base);
  await fixture.setScenario('normal', { listDelayMs: options.listDelayMs, failList: options.failList,
    cacheIdentity: true, catalogTtlMs: 600000 });
  const config = join(base, 'source-proxy.json');
  await save(config, { command: fixture.command, ledger: sourceLedger });
  return { command: [process.execPath, self, 'source-proxy', config], cacheDir: join(base, 'broker-cache'), fixtureState: fixture.statePath };
}

async function collectSample({ evidence, scenario, sharedSource, options, clockId, prompt }) {
  const base = join(evidence, scenario.id); await mkdir(base, { mode: 0o700 });
  const sourceLedger = join(evidence, 'source-calls.jsonl');
  const source = sharedSource ?? await prepareSource(join(base, 'fixture'), sourceLedger, { listDelayMs: options.listDelayMs, failList: scenario.failList });
  const cacheBefore = await tree(source.cacheDir);
  const agentDir = join(base, 'agent'); await mkdir(join(agentDir, 'context-broker'), { recursive: true, mode: 0o700 });
  await save(join(agentDir, 'context-broker', 'config.yml'), { sources: [{ type: 'notion', id: 'notion', namespace: 'notion', command: source.command,
    database, cacheDir: source.cacheDir, requestTimeoutMs: Math.max(15000, options.listDelayMs * 3), prefetch: false }] });
  const controlledProvider = await provider(base), providerFile = join(base, 'provider.jsonl'), observerFile = join(base, 'observer.jsonl');
  await writeFile(providerFile, '', { mode: 0o600 });
  const observer = join(base, 'observer-extension.mjs');
  await writeFile(observer, consumptionCostExtensionSource({ output: observerFile, checkoutRoot: root, runId: clockId, sampleId: scenario.id, clockId }), { mode: 0o600 });
  const env = isolatedEnv({ base, agentDir, CONTEXT_BROKER_HOST: 'pi', CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: providerFile,
    CONTEXT_BROKER_LOG_FILE: join(base, 'decisions.jsonl'), SKILL_STARTUP_SAMPLE_ID: scenario.id });
  const args = ['--no-extensions', '-e', controlledProvider.entry, '-e', options.extension, '-e', observer,
    '--model', 'context-broker-e2e/fake', '--session-dir', join(base, 'sessions')];
  const driver = [{ event: 'before-startRpc', monotonicNs: now(), waitForState: false }];
  let rpc, rpcError, closeError, submission;
  try {
    rpc = await startRpc({ host: 'pi', args, cwd: base, env, timeoutMs: options.timeoutMs, waitForState: false });
    driver.push({ event: 'rpc-handle-returned-without-state-handshake', monotonicNs: now() });
    submission = { prompt, promptSha256: hash(prompt), monotonicNs: now(), clockId, boundary: 'immediately-before-native-rpc-prompt-call' };
    // prompt() writes the native JSON command synchronously before its first await.
    const submitted = rpc.prompt(prompt);
    driver.push({ event: 'native-prompt-call-returned', monotonicNs: now() });
    await submitted;
    driver.push({ event: 'native-prompt-completed', monotonicNs: now() });
  } catch (error) { rpcError = safeError(error); }
  finally {
    if (!submission) submission = { prompt, promptSha256: hash(prompt), monotonicNs: now(), clockId, boundary: 'not-submitted' };
    try {
      const quiet = await sourceQuiet(sourceLedger, scenario.id, Math.min(options.timeoutMs, 10000));
      driver.push({ event: 'source-quiescence-observation', monotonicNs: now(), ...quiet });
    } catch (error) { driver.push({ event: 'source-quiescence-observation-failed', monotonicNs: now(), error: safeError(error) }); }
    if (rpc) {
      try { await rpc.closeInput(); } catch (error) { closeError = safeError(error); await rpc.stop().catch(() => {}); }
      driver.push({ event: 'owned-process-shutdown-returned', monotonicNs: now() });
    }
  }
  await save(join(base, 'submission.json'), submission);
  await save(join(base, 'process-lifecycle.json'), rpc?.lifecycle ?? []);
  let observerEvents = [], observerError = null;
  try { observerEvents = (await readConsumptionCostEvents(observerFile)).events; }
  catch (error) { observerError = safeError(error); }
  const providerCalls = await rows(providerFile), sourceCalls = (await rows(sourceLedger)).filter(event => event.sampleId === scenario.id);
  const result = summarizeStartupSample({ scenario, submission, observerEvents, observerError, providerCalls, sourceCalls,
    lifecycle: rpc?.lifecycle ?? [], driver, rpcError, closeError, rpcFrames: rpc?.frames ?? [] });
  Object.assign(result, { controlledProvider, cacheBefore, cacheAfter: await tree(source.cacheDir), files: {
    observer: relative(evidence, observerFile), provider: relative(evidence, providerFile), source: 'source-calls.jsonl', submission: scenario.id + '/submission.json' } });
  await save(join(base, 'result.json'), result);
  return result;
}

export async function collectStartupBaseline(options) {
  if (!isAbsolute(options.evidenceRoot ?? '')) throw new Error('STARTUP_EVIDENCE_ROOT_REQUIRED');
  const destination = resolve(options.evidenceRoot), checkout = await realpath(root);
  const lexical = relative(checkout, destination);
  if (lexical === '' || lexical !== '..' && !lexical.startsWith('..' + sep) && !isAbsolute(lexical)) throw new Error('STARTUP_EVIDENCE_MUST_BE_OUTSIDE_CHECKOUT');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const target = await realpath(destination), rel = relative(checkout, target);
  if (rel === '' || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) throw new Error('STARTUP_EVIDENCE_MUST_BE_OUTSIDE_CHECKOUT');
  const previousMask = process.umask(0o077);
  try {
    const evidence = await mkdtemp(join(target, 'skill-startup-')); await chmod(evidence, 0o700);
    const clockId = 'startup-' + randomUUID(), prompt = 'Reply with OK.';
    const doctor = await startupDoctor(options.extension);
    const scenarios = [
      ...Array.from({ length: options.coldSamples }, (_, index) => ({ id: 'cold-delay-' + (index + 1), group: 'cold-delay', cache: 'cold', session: 'new', failList: false })),
      ...Array.from({ length: options.failureSamples }, (_, index) => ({ id: 'cold-failure-' + (index + 1), group: 'cold-failure', cache: 'cold', session: 'new', failList: true })),
      ...(options.warmSamples ? [{ id: 'warm-primer', group: 'warm-primer', cache: 'cold', session: 'new', failList: false },
        ...Array.from({ length: options.warmSamples }, (_, index) => ({ id: 'warm-' + (index + 1), group: 'warm-broker-catalog-new-process', cache: 'warm', session: 'new', failList: false }))] : []),
    ];
    const plan = { version: 1, createdAt: new Date().toISOString(), clockId, options, prompt, promptSha256: hash(prompt),
      model: 'context-broker-e2e/fake', modelMethod: 'existing-controlled-provider-with-passive-capture-only', prefetch: false,
      submissionMethod: 'native-prompt-before-get-state-handshake', source: 'createNotionFixture-listDelayMs-failList',
      interpretation: 'No real Notion/model HTTP. Fixture stdout and provider context JSON are not wire bytes or tokens.', doctor, scenarios };
    await save(join(evidence, 'plan.json'), plan);
    let samples = [];
    let sharedSource;
    if (options.warmSamples) sharedSource = await prepareSource(join(evidence, 'warm-shared-source'), join(evidence, 'source-calls.jsonl'), { listDelayMs: options.listDelayMs, failList: false });
    console.log(JSON.stringify({ event: 'startup-baseline-start', evidence, planned: scenarios.length, runtimeSha256: doctor.identity.runtimeSha256 }));
    for (const scenario of scenarios) {
      let result;
      try { result = await collectSample({ evidence, scenario, sharedSource: scenario.group.startsWith('warm') ? sharedSource : undefined, options, clockId, prompt }); }
      catch (error) {
        result = summarizeStartupSample({ scenario, submission: { prompt, promptSha256: hash(prompt), monotonicNs: now(), clockId, boundary: 'setup-or-collection-failed' }, rpcError: safeError(error) });
        result.errors.push('STARTUP_SAMPLE_COLLECTION_FAILED');
        await mkdir(join(evidence, scenario.id), { recursive: true, mode: 0o700 });
        await save(join(evidence, scenario.id, 'result.json'), result);
      }
      samples.push(result);
      await save(join(evidence, 'samples.json'), samples);
      console.log(JSON.stringify({ event: 'startup-sample', id: result.id, status: result.status, taskStatus: result.taskStatus, timings: result.timings,
        directory: result.directory, bodyCalls: result.consumption.bodyCalls, errors: result.errors }));
    }
    const reconciliation = await reconcileStartupBatch(evidence, samples);
    await save(join(evidence, 'batch-reconciliation.json'), reconciliation);
    samples = reconciliation.samples;
    await save(join(evidence, 'samples-final.json'), samples);
    const finalIdentity = await identities(options.extension);
    const groups = Object.fromEntries([...new Set(scenarios.map(scenario => scenario.group))].map(group => {
      const items = samples.filter(sample => sample.group === group);
      return [group, { n: items.length, observed: items.filter(item => item.status === 'observed').length, failures: items.filter(item => item.status !== 'observed').map(item => item.id),
        directoryFailures: items.reduce((total, item) => total + item.directory.failedListCalls, 0),
        providerAfterAllObservedListCompletions: items.filter(item => item.directory.providerAfterAllObservedListCompletions === true).length,
        bodyCalls: items.reduce((total, item) => total + item.consumption.bodyCalls, 0),
        timings: Object.fromEntries(['submitToFirstProviderMs', 'submitToFirstEffectiveTextMs', 'submitToCompletionMs', 'submitToLastDirectoryCompletionMs', 'submitToProcessCloseMs']
          .map(key => [key, consumptionMetricStats(items.map(item => item.timings[key]))])) }];
    }));
    const report = { version: 1, evidence, planSha256: hash(JSON.stringify(plan)), planned: scenarios.length, n: samples.length,
      status: samples.every(sample => sample.status === 'observed') && finalIdentity.runtimeSha256 === doctor.identity.runtimeSha256 ? 'baseline-observed' : 'baseline-incomplete',
      runtimeUnchanged: finalIdentity.runtimeSha256 === doctor.identity.runtimeSha256, initialRuntimeSha256: doctor.identity.runtimeSha256,
      finalRuntimeSha256: finalIdentity.runtimeSha256, reconciliation: { file: 'batch-reconciliation.json', status: reconciliation.status,
        sourceStarts: reconciliation.sourceStarts, sourceCloses: reconciliation.sourceCloses }, groups, samples,
      limitations: ['Controlled provider always replies OK; this establishes dispatch/latency, not model task quality.',
        'The fake provider does not invoke the SDK onPayload callback; its stream boundary is recorded separately from before_provider_request.',
        'No real HTTP attempts, wire bytes or model tokens are inferred from fixture execution or JSON size.',
        'Every planned sample and failed observation remains in the report; warm priming is retained as its own sample.',
        'Per-sample result.json and samples.json are collection snapshots; final samples include an independent reread of source and owned-process evidence.',
        'Warm means a primed Broker catalog in a new process, not a claim that every default-View/CLI cache is warm.'] };
    await save(join(evidence, 'report.json'), report);
    console.log(JSON.stringify({ event: 'startup-baseline-complete', evidence, status: report.status, planned: report.planned, n: report.n, groups }));
    return report;
  } finally { process.umask(previousMask); }
}

async function main(argv) {
  if (argv[0] === 'source-proxy') { process.exitCode = await runStartupSourceProxy(argv[1], argv.slice(2)); return; }
  const options = parseStartupArgs(argv);
  if (options.action === 'help') { console.log(usage); return; }
  if (options.action === 'doctor') { console.log(JSON.stringify(await startupDoctor(options.extension), null, 2)); return; }
  const report = await collectStartupBaseline(options);
  if (report.status !== 'baseline-observed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === self) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ error: safeError(error) })); process.exitCode = 1;
});
