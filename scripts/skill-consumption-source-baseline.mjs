#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, constants, createWriteStream } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safeRequestMetrics } from './notion-default-context.mjs';
import { safeDiagnostic } from './verification-command.mjs';
import { verificationCliEnvironment } from './verification-paths.mjs';
import { consumptionMetricStats } from './skill-consumption-cost.mjs';
import { signalHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';

const script = fileURLToPath(import.meta.url);
const checkout = resolve(dirname(script), '..');
const defaults = { cold: 5, warm: 20, 'expired-unchanged': 20, partial: 5 };
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (a, b) => canonical(a) === canonical(b);
const now = () => process.hrtime.bigint();
const milliseconds = (end, start) => Number(end - start) / 1e6;
const save = async (path, value) => { await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await chmod(path, 0o600); };
const within = (parent, child) => { const part = relative(parent, child); return part !== '' && !part.startsWith('..' + sep) && part !== '..' && !isAbsolute(part); };
const present = async path => { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const cleanError = error => ({ code: /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'DRIVER_FAILURE', message: safeDiagnostic(Buffer.from(String(error?.message ?? error))) });
const help = [
  'Source CLI baseline; never invokes a model or actively edits source pages.',
  'Current consumption may retain/adopt Records; actual source writes remain in the ledger.',
  '  node scripts/skill-consumption-source-baseline.mjs --help',
  '  node scripts/skill-consumption-source-baseline.mjs doctor --config /absolute/config.json',
  '  node scripts/skill-consumption-source-baseline.mjs plan --config /absolute/config.json',
  '  node scripts/skill-consumption-source-baseline.mjs run --run /absolute/frozen-run',
  '  node scripts/skill-consumption-source-baseline.mjs run --config /absolute/config.json',
  '  node scripts/skill-consumption-source-baseline.mjs evidence --run /absolute/frozen-run',
  '  node scripts/skill-consumption-source-baseline.mjs cleanup --run /absolute/frozen-run',
  '',
  'Config: command (absolute executable argv), database, root (unfixed exact main ref),',
  'evidenceRoot (absolute, outside checkout); optional resourcePath, timeoutMs (default 120000),',
  'pipeline (prepare-fixed-main by default, resource-only, or inspect-current),',
  'samples ({cold:5,warm:20,"expired-unchanged":20,partial:5}). Authentication is inherited.',
  'doctor only reads paths and runs --version/--help. plan freezes identities and sample order',
  'before remote reads. Each run has private CLI state. Warm/expired share one owned cache.',
  'Expired uses --max-age 1s and a measured >=1001ms pause, never refresh/0 or clock rewriting.',
  'Partial setup moves only an owned root-main object to system Trash; measured pinned prepare',
  'then fixed reads may fail. There is no current-version fallback. All failures are retained.',
  'resource-only requires resourcePath and cold-only counts; every sample uses empty owned state,',
  'one current resource read, then local manifest/object observations without prepare/files calls.',
  'inspect-current requires cold-only counts and no resourcePath; each sample runs one public',
  'ctl prepare --purpose inspect in empty owned state, without follow-up read/files. A failed',
  'sample stops remaining samples and retains its working state for original-operation recovery.',
  'Observed materialization is not delivery. Provider HTTP=0 does not exclude inline Records ZIP.',
  'cleanup moves only the owned working directory to Trash and retains evidence.',
].join('\n');

export function metricsSummary(metrics) {
  if (!metrics) return { complete: false, observedHttpAttempts: null, sourceHttpAttempts: null, requestBytes: null, responseBytes: null, queueWaitMs: null, retryWaitMs: null };
  const attempts = metrics.trace.filter(event => event.event === 'attempt');
  const sum = values => metrics.complete && values.every(value => typeof value === 'number' && Number.isFinite(value))
    ? values.reduce((total, value) => total + value, 0) : null;
  return { complete: metrics.complete, observedHttpAttempts: attempts.length,
    sourceHttpAttempts: metrics.complete ? metrics.total_requests : null,
    failedHttpAttempts: metrics.complete ? attempts.filter(event => event.outcome !== 'success').length : null,
    requestBytes: sum(attempts.map(event => event.request_bytes)), responseBytes: sum(attempts.map(event => event.response_bytes)),
    queueWaitMs: sum(metrics.trace.filter(event => event.event === 'wait' && event.kind === 'queue').map(event => event.milliseconds)),
    retryWaitMs: sum(metrics.trace.filter(event => event.event === 'wait' && event.kind === 'retry').map(event => event.milliseconds)),
    httpDurationSumMs: sum(attempts.map(event => event.duration_ms)),
    byKind: Object.fromEntries(['notion_metadata', 'notion_body', 'notion_write', 'provider'].map(kind => [kind, metrics.complete ? attempts.filter(event => event.request_kind === kind).length : null])) };
}

/** Capture every launched child, including failed spawn, timeout, malformed/partial output.
 * Raw stdout is private evidence; stderr is retained only as hash/count and redacted text.
 */
export async function measureCommand(command, args, { directory, id, env, cwd = checkout, timeoutMs = 120000, signal, json = true }) {
  assert.match(id, /^[A-Za-z0-9_.-]+$/);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stdoutPath = join(directory, id + '.stdout');
  const stderrPath = join(directory, id + '.stderr.txt');
  const receiptPath = join(directory, id + '.json');
  const lifecycle = join(directory, id + '.lifecycle.jsonl');
  const started = now(), startedAt = new Date().toISOString();
  const record = (event, details = {}) => appendFileSync(lifecycle, JSON.stringify({ event, monotonicNs: now().toString(), ...details }) + '\n', { mode: 0o600 });
  const output = createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 });
  const outHash = createHash('sha256'), errHash = createHash('sha256');
  const out = [], err = [];
  let outBytes = 0, errBytes = 0, spawned, closed, pid = null, spawnError = null, timedOut = false, cancelled = false;
  record('planned', { commandSha256: sha(canonical(command)), argvSha256: sha(canonical(args)), startedAt });
  let child, outputFinished, code = null, closeSignal = null, captureFailure = null;
  try {
    child = spawn(command[0], [...command.slice(1), ...args], { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => { outBytes += bytes.length; outHash.update(bytes); if (outBytes <= 32 * 1024 * 1024) out.push(bytes); });
    child.stderr.on('data', bytes => { errBytes += bytes.length; errHash.update(bytes); if (errBytes <= 65536) err.push(bytes); });
    outputFinished = pipeline(child.stdout, output).catch(error => { captureFailure = 'STDOUT_EVIDENCE_FAILED'; record('stdout-error', cleanError(error)); return false; });
    const closedPromise = new Promise(accept => {
      child.once('spawn', () => { spawned = now(); pid = child.pid ?? null; record('spawn', { pid }); });
      child.once('error', error => { spawnError = error.code ?? 'SPAWN_FAILED'; record('spawn-error', { code: spawnError }); });
      child.once('close', (exitCode, signalName) => { code = exitCode; closeSignal = signalName; closed = now(); record('close', { pid, code, signal: closeSignal }); accept(); });
    });
    let escalation;
    const terminate = reason => {
      if (closed !== undefined) return;
      timedOut ||= reason === 'timeout'; cancelled ||= reason === 'cancelled';
      record(reason, { pid }); signalHost(child, 'SIGTERM');
      escalation ??= setTimeout(() => { record('kill-escalation', { pid }); signalHost(child, 'SIGKILL'); }, 2000);
    };
    const timer = setTimeout(() => terminate('timeout'), timeoutMs);
    const abort = () => terminate('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    await closedPromise;
    clearTimeout(timer); clearTimeout(escalation);
    signal?.removeEventListener('abort', abort);
    await outputFinished;
  } catch (error) {
    spawnError = error.code ?? 'SPAWN_FAILED'; record('launch-exception', { code: spawnError });
    output.end(); await new Promise(accept => output.once('close', accept)); closed = now();
  }
  const stdoutComplete = outBytes <= 32 * 1024 * 1024;
  let value = null, jsonValid = !json;
  if (json && stdoutComplete) try { value = JSON.parse(Buffer.concat(out).toString('utf8')); jsonValid = true; } catch { /* unknown, not zero */ }
  const metrics = captureFailure === null && stdoutComplete ? safeRequestMetrics(value?.request_metrics) ?? null : null;
  const diagnostic = safeDiagnostic(Buffer.concat(err));
  await writeFile(stderrPath, diagnostic + (diagnostic ? '\n' : ''), { mode: 0o600 });
  const failure = spawnError ? 'SPAWN_FAILED' : cancelled ? 'CANCELLED' : timedOut ? 'TIMEOUT' : code !== 0 ? 'PROCESS_FAILED'
    : captureFailure ?? (!stdoutComplete ? 'OUTPUT_TOO_LARGE_TO_PARSE' : !jsonValid ? 'INVALID_JSON' : json && value?.ok !== true ? 'CLI_REJECTED' : null);
  const receipt = { version: 1, id, command, args, startedAt, startedNs: started.toString(), spawnedNs: spawned?.toString() ?? null,
    closedNs: closed?.toString() ?? null, pid, code, signal: closeSignal, spawnError, timedOut, cancelled,
    elapsedMs: closed === undefined ? null : milliseconds(closed, started), spawnMs: spawned === undefined ? null : milliseconds(spawned, started),
    stdout: { path: stdoutPath, bytes: outBytes, sha256: outHash.digest('hex'), parsedComplete: stdoutComplete && jsonValid },
    stderr: { path: stderrPath, bytes: errBytes, sha256: errHash.digest('hex'), savedSha256: sha(await readFile(stderrPath)), rawRetained: false, truncatedDiagnostic: errBytes > 2000 },
    lifecycle, lifecycleSha256: sha(await readFile(lifecycle)), failure, errorCode: /^[A-Z][A-Z0-9_]{0,79}$/.test(value?.error?.code ?? '') ? value.error.code : null,
    metrics, costs: metricsSummary(metrics), receiptPath, layer: 'source-cli', providerTotalCost: null };
  await save(receiptPath, receipt);
  return { receipt, value };
}

async function configuration(path) {
  assert.ok(isAbsolute(path ?? ''), '--config must be absolute');
  const value = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Config must be an object');
  assert.ok(Object.keys(value).every(key => ['command', 'database', 'root', 'evidenceRoot', 'resourcePath', 'timeoutMs', 'samples', 'pipeline'].includes(key)), 'Unknown config field');
  assert.ok(Array.isArray(value.command) && value.command.length > 0 && isAbsolute(value.command[0]) && value.command.every(arg => typeof arg === 'string' && arg.length > 0 && !arg.includes('\0')), 'command must be absolute executable argv');
  assert.match(value.database, /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i);
  const root = new URL(value.root);
  assert.equal(root.protocol, 'skill:');
  assert.ok(decodeURIComponent(root.hostname).startsWith('shared_skill:') && root.pathname.length > 1 && !root.search && !root.hash, 'root must be an unfixed exact shared main ref');
  assert.ok(isAbsolute(value.evidenceRoot), 'evidenceRoot must be absolute');
  if (value.resourcePath !== undefined) assert.ok(typeof value.resourcePath === 'string' && value.resourcePath && !isAbsolute(value.resourcePath) && !value.resourcePath.split('/').includes('..') && !/[\\\0?#]/u.test(value.resourcePath), 'resourcePath must be a relative path');
  const samples = value.samples ?? defaults;
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(defaults).sort(), 'All four sample groups are required');
  for (const count of Object.values(samples)) assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= 1000, 'Sample count out of range');
  assert.ok(samples.cold >= 1, 'At least one cold sample anchors source identity');
  const timeoutMs = value.timeoutMs ?? 120000;
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 50 && timeoutMs <= 600000, 'timeoutMs out of range');
  const config = { ...value, samples, timeoutMs };
  pipelineMode(config);
  return config;
}

function pipelineMode(config) {
  const mode = config.pipeline ?? 'prepare-fixed-main';
  assert.ok(['prepare-fixed-main', 'resource-only', 'inspect-current'].includes(mode), 'Unknown source pipeline');
  if (mode === 'resource-only') {
    assert.ok(config.resourcePath && config.resourcePath !== decodeURIComponent(new URL(config.root).pathname.slice(1)), 'Select a resource distinct from the main file');
    assert.ok(config.samples.cold > 0 && ['warm', 'expired-unchanged', 'partial'].every(group => config.samples[group] === 0), 'resource-only currently measures independent cold samples');
  }
  if (mode === 'inspect-current') {
    assert.equal(config.resourcePath, undefined, 'inspect-current does not accept resourcePath');
    assert.ok(config.samples.cold > 0 && ['warm', 'expired-unchanged', 'partial'].every(group => config.samples[group] === 0), 'inspect-current requires independent cold samples');
  }
  return mode;
}

async function fingerprintCommand(command) {
  const artifacts = [];
  for (const arg of command) if (isAbsolute(arg)) {
    const file = await realpath(arg), metadata = await stat(file);
    assert.ok(metadata.isFile(), 'Command artifacts must be files');
    const bytes = await readFile(file); artifacts.push({ path: arg, realpath: file, bytes: bytes.length, sha256: sha(bytes) });
  }
  return { argv: command, artifacts, sha256: sha(canonical({ argv: command, artifacts })) };
}

export async function doctor(config) {
  const command = await fingerprintCommand(config.command);
  const probe = args => {
    const result = spawnSync(config.command[0], [...config.command.slice(1), ...args], { cwd: checkout, env: process.env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, 'Offline CLI probe failed: ' + args.join(' '));
    return { args, bytes: Buffer.byteLength(result.stdout), sha256: sha(result.stdout), text: result.stdout };
  };
  const version = probe(['--version']), prepare = probe(config.pipeline === 'inspect-current' ? ['ctl', 'prepare', '--help'] : ['prepare', '--help']), read = probe(['read', '--help']);
  const runtime = spawnSync(config.command[0], ['--version'], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(runtime.status, 0, 'Executable version probe failed');
  for (const flag of ['--metrics', '--database', '--max-age']) assert.ok(prepare.text.includes(flag) && read.text.includes(flag), 'CLI does not expose ' + flag);
  assert.ok(prepare.text.includes('Ns') && read.text.includes('--from'), 'CLI duration or relative read contract unsupported');
  let trashAvailable = true;
  try { await access('/usr/bin/trash', constants.X_OK); } catch { trashAvailable = false; }
  return { version: 1, status: 'ready', readOnly: true, command, cliVersion: version.text.trim(), runtimeVersion: runtime.stdout.trim(), driverNodeVersion: process.version,
    prepareHelp: { bytes: prepare.bytes, sha256: prepare.sha256 }, readHelp: { bytes: read.bytes, sha256: read.sha256 },
    credentialConfigured: Boolean(process.env.NOTION_API_TOKEN), trashAvailable, traceLimit: 10000,
    ttl: { warm: '5m', expired: '1s', expiredWaitMs: 1001 } };
}

export async function freezePlan(config) {
  const resourceOnly = pipelineMode(config) === 'resource-only';
  const inspectOnly = pipelineMode(config) === 'inspect-current';
  const checked = await doctor(config);
  assert.ok(checked.trashAvailable || config.samples.partial === 0, '/usr/bin/trash is required for partial samples');
  await mkdir(config.evidenceRoot, { recursive: true, mode: 0o700 });
  const output = await realpath(config.evidenceRoot), checkoutRoot = await realpath(checkout);
  assert.ok(output !== checkoutRoot && !within(checkoutRoot, output), 'Evidence must be outside checkout');
  const runId = 'source-' + new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8);
  const run = join(output, runId); await mkdir(run, { mode: 0o700 });
  const driverBytes = await readFile(script), savedDriver = join(run, 'source-driver.mjs');
  await writeFile(savedDriver, driverBytes, { flag: 'wx', mode: 0o600 });
  const samples = Object.keys(defaults).flatMap(group => Array.from({ length: config.samples[group] }, (_, index) => ({
    id: group + '-' + String(index + 1).padStart(3, '0'), group, index: index + 1,
    state: group === 'warm' || group === 'expired-unchanged' ? 'steady' : group + '-' + String(index + 1).padStart(3, '0'),
  })));
  const body = { version: 1, kind: 'skill-consumption-source-baseline', runId, run, createdAt: new Date().toISOString(),
    driver: { path: script, sha256: sha(driverBytes), savedPath: savedDriver }, checkout: checkoutRoot,
    checkoutHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).stdout.trim(),
    config, command: checked.command, cliVersion: checked.cliVersion, runtimeVersion: checked.runtimeVersion, driverNodeVersion: checked.driverNodeVersion,
    help: { prepare: checked.prepareHelp, read: checked.readHelp }, traceLimit: checked.traceLimit, ttl: checked.ttl, samples,
    sourceAnchor: resourceOnly ? 'first-successful-cold-resource-read-and-actual-local-snapshot-with-all-earlier-failures-retained' : 'first-successful-cold-actual-graph-with-all-earlier-failures-retained',
    setup: resourceOnly || inspectOnly ? 'none-each-sample-starts-with-empty-owned-state' : 'separate-receipts-and-costs-for-steady-and-each-partial-owned-cache',
    partial: resourceOnly || inspectOnly ? 'not-applicable-independent-cold-plan' : 'trash-verified-owned-root-main-object-preserve-manifest-pinned-prepare-then-fixed-reads-no-current-fallback',
    pipeline: resourceOnly ? ['read-one-current-resource', 'observe-owned-cache-without-another-cli'] : inspectOnly ? ['prepare-one-current-inspect'] : ['prepare-use', 'read-every-prepared-main-at-returned-pin', ...(config.resourcePath ? ['read-one-relative-resource-at-root-pin'] : [])],
    ...(inspectOnly ? { timing: { elapsedMs: 'measured CLI child launch through close, including startup and complete stdout',
      rootReadyMs: 'public preparation_metrics.root_ready_ms from the same call; preparation start through ready root, excluding earlier CLI startup' },
    failurePolicy: 'stop remaining samples after any failure; retain original operation and working state; no replay' } : {}),
    scope: 'source-cli-only', modelProviderTotalCost: null, productAcceptance: 'not-inferred' };
  const plan = { ...body, sha256: sha(canonical(body)) };
  await save(join(run, 'plan.json'), plan);
  return plan;
}

async function loadPlan(run) {
  assert.ok(isAbsolute(run ?? ''), '--run must be absolute');
  const resolved = await realpath(run);
  const plan = JSON.parse(await readFile(join(resolved, 'plan.json'), 'utf8'));
  const { sha256: expected, ...body } = plan;
  assert.equal(plan.kind, 'skill-consumption-source-baseline');
  assert.equal(plan.run, resolved); assert.equal(sha(canonical(body)), expected, 'Frozen plan changed');
  assert.ok(!within(await realpath(checkout), resolved) && resolved !== await realpath(checkout), 'Run must be outside checkout');
  return plan;
}

export function sourceIdentity(graph) {
  assert.equal(graph?.ok, true); assert.equal(graph.status, 'ready'); assert.equal(graph.version, 1);
  assert.ok(Array.isArray(graph.nodes) && Array.isArray(graph.roots) && graph.roots.every(root => root.readiness === 'ready'), 'Incomplete graph');
  const nodes = graph.nodes.filter(node => node.state === 'prepared');
  assert.ok(nodes.length > 0 && nodes.every(node => node.id === node.record?.id && node.binding?.record?.id === node.id && typeof node.content === 'string'), 'Missing prepared identity');
  for (const node of nodes) {
    assert.equal(sha(node.content), node.body_sha256); assert.equal(Buffer.byteLength(node.content), node.bytes);
    assert.equal(node.binding.body_sha256, node.body_sha256); assert.equal(node.ref, node.binding.ref);
  }
  const { sha256: lock, ...vector } = graph.graph_lock;
  assert.equal(sha(canonical(vector)), lock, 'Graph lock mismatch');
  assert.equal(vector.scope, graph.scope);
  const bindings = nodes.map(node => ({ id: node.id, scope: node.binding.scope, snapshot_id: node.binding.snapshot_id, version_id: node.binding.version_id,
    body_sha256: node.body_sha256, bytes: node.bytes, entrypoint: node.path, record: node.record, ref: node.ref, files: node.files })).sort((a, b) => a.id.localeCompare(b.id));
  return { scope: graph.scope, roots: vector.roots, required: vector.required, graphLockSha256: lock, bindings };
}

function validateRead(value, node) {
  assert.equal(value?.ok, true); assert.deepEqual(value.record, node.record);
  for (const key of ['scope', 'snapshot_id', 'version_id']) assert.equal(value[key], node.binding[key]);
  assert.equal(value.ref, node.ref); assert.equal(value.entrypoint, node.path); assert.equal(value.path, node.path);
  assert.equal(value.content, node.content); assert.equal(value.has_more, false);
  const lines = node.content.split('\n').length;
  assert.deepEqual(value.range, { start: 1, end: lines, total_lines: lines });
  assert.equal(sha(value.content), node.body_sha256); assert.equal(Buffer.byteLength(value.content), node.bytes);
  assert.equal(value.freshness?.policy, 'pinned');
}

/** Observations after the single resource child closes; this performs no CLI or network work.
 * Missing other objects remain observations, never evidence that they were delivered. */
async function observeResource(plan, item, value, state) {
  assert.equal(value?.ok, true); assert.equal(value.has_more, false); assert.equal(typeof value.content, 'string');
  const requested = new URL(plan.config.root), returned = new URL(value.ref);
  assert.equal(value.record.id, decodeURIComponent(requested.hostname));
  assert.equal(value.record.locator.database_id, plan.config.database);
  assert.equal(value.entrypoint, decodeURIComponent(requested.pathname.slice(1)));
  assert.equal(value.path, plan.config.resourcePath);
  assert.equal(decodeURIComponent(returned.hostname), value.record.id);
  assert.equal(returned.protocol, 'skill:'); assert.equal(decodeURIComponent(returned.pathname.slice(1)), value.path);
  assert.match(value.snapshot_id, /^s_[a-f0-9]{64}$/); assert.equal(returned.searchParams.get('snapshot'), value.snapshot_id);
  const lines = value.content.split('\n').length;
  assert.deepEqual(value.range, { start: 1, end: lines, total_lines: lines });
  assert.equal(await realpath(state), state);
  const sourceManifest = join(state, 'snapshots', value.snapshot_id + '.json');
  assert.equal(await realpath(sourceManifest), sourceManifest); assert.ok((await lstat(sourceManifest)).isFile());
  const rawManifest = await readFile(sourceManifest), manifest = JSON.parse(rawManifest);
  assert.deepEqual(manifest.record, value.record);
  for (const key of ['snapshot_id', 'scope', 'version_id', 'entrypoint']) assert.equal(manifest[key], value[key]);
  for (const key of ['file_bindings', 'native_references', 'members', 'required']) assert.deepEqual(manifest[key] ?? [], value[key] ?? []);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 1, 'A resource baseline needs an actual multifile snapshot');
  const selected = manifest.files.find(file => file.path === value.path);
  assert.ok(selected); assert.equal(sha(value.content), selected.sha256); assert.equal(Buffer.byteLength(value.content), selected.bytes);
  const binding = manifest.file_bindings?.find(file => file.path === value.path);
  if (binding) assert.equal(returned.searchParams.get('file_id'), binding.file_id);
  const objects = join(state, 'objects'); assert.equal(await realpath(objects), objects);
  const cacheObjects = [];
  for (const name of (await readdir(objects)).sort()) {
    assert.match(name, /^[a-f0-9]{64}$/);
    const path = join(objects, name); assert.equal(await realpath(path), path); assert.ok((await lstat(path)).isFile());
    const bytes = await readFile(path); cacheObjects.push({ sha256: name, observedSha256: sha(bytes), bytes: bytes.length });
  }
  const effectiveManifestFiles = manifest.files.map(file => {
    const object = cacheObjects.find(object => object.sha256 === file.sha256);
    return { ...file, present: object !== undefined, valid: object ? object.observedSha256 === file.sha256 && object.bytes === file.bytes : null };
  });
  const output = join(plan.run, 'materialization'); await mkdir(output, { recursive: true, mode: 0o700 });
  const savedManifest = join(output, item.id + '.snapshot.json');
  await writeFile(savedManifest, rawManifest, { flag: 'wx', mode: 0o600 });
  const materialization = { snapshotManifest: { path: savedManifest, bytes: rawManifest.length, sha256: sha(rawManifest) },
    effectiveManifestFiles, cacheObjects, phase: 'after-single-resource-read-before-any-other-cli',
    cliOutputPaths: [value.path], modelDelivery: 'not-observed', otherCachedFilesReturnedInCliOutput: false, zipFormat: 'requires-independent-source-proof' };
  await save(join(output, item.id + '.json'), materialization);
  const { created_at, ...identityManifest } = manifest;
  return { identity: { kind: 'single-resource', manifest: identityManifest, resource: { ...selected, ref: value.ref, range: value.range } }, materialization };
}

async function manifestInventory(state) {
  const files = [];
  const visit = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (path === state && entry.name === 'objects') continue;
      const child = join(path, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'Owned state contains a symlink');
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) { const bytes = await readFile(child); files.push({ path: relative(state, child), bytes: bytes.length, sha256: sha(bytes) }); }
    }
  };
  await visit(state);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function trashMain(plan, item, node, runOperation) {
  const state = join(plan.run, 'working', item.state, 'state');
  const object = join(state, 'objects', node.body_sha256);
  assert.match(node.body_sha256, /^[a-f0-9]{64}$/);
  assert.equal(await realpath(state), state);
  assert.equal(await realpath(dirname(object)), join(state, 'objects'));
  assert.ok((await lstat(object)).isFile() && !(await lstat(object)).isSymbolicLink(), 'Partial object must be an owned regular file');
  const bytes = await readFile(object);
  assert.equal(sha(bytes), node.body_sha256); assert.equal(bytes.length, node.bytes);
  const directory = join(plan.run, 'partial');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const backup = join(directory, item.id + '.original.bin');
  await writeFile(backup, bytes, { flag: 'wx', mode: 0o600 });
  const before = await manifestInventory(state);
  const trash = await runOperation(item.id + '-trash', ['/usr/bin/trash'], [object], { json: false, role: 'partial-state-setup', timeoutMs: 30000 });
  const after = await manifestInventory(state);
  const receipt = { version: 1, object, original: { bytes: bytes.length, sha256: sha(bytes), backup }, trash: trash.receipt.receiptPath,
    absentAfterTrash: !(await present(object)), manifestBefore: before, manifestAfter: after, manifestPreserved: same(before, after) };
  await save(join(directory, item.id + '.json'), receipt);
  assert.equal(trash.receipt.failure, null); assert.equal(receipt.absentAfterTrash, true); assert.equal(receipt.manifestPreserved, true);
  return receipt;
}

export async function executePlan(plan) {
  assert.equal(sha(await readFile(script)), plan.driver.sha256, 'Driver changed after plan freeze');
  assert.deepEqual(await fingerprintCommand(plan.config.command), plan.command, 'CLI artifact changed after plan freeze');
  assert.equal(await present(join(plan.run, 'run-start.json')), false, 'This run already started; create a new frozen plan to repeat');
  await save(join(plan.run, 'run-start.json'), { at: new Date().toISOString(), pid: process.pid, planSha256: plan.sha256 });
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const operations = [], setups = [], samples = [];
  const inspectOnly = pipelineMode(plan.config) === 'inspect-current';
  let inspectFailed = false;
  await save(join(plan.run, 'operations.json'), operations);
  let baseline = null, steadySetup = null;
  const operation = async (id, command, args, options = {}) => {
    const result = await measureCommand(command, args, { directory: join(plan.run, 'operations'), id, env: options.env ?? process.env,
      timeoutMs: plan.config.timeoutMs, signal: stop.signal, ...options });
    operations.push({ id, role: options.role ?? 'sample', receipt: result.receipt });
    await save(join(plan.run, 'operations.json'), operations);
    return result;
  };
  const pipelineSample = async (item, { setup = false, target = plan.config.root } = {}) => {
    const started = now(), receipts = [], errors = [];
    const base = join(plan.run, 'working', item.state);
    if (inspectOnly) assert.equal(await present(base), false, 'Cold inspect state must not pre-exist');
    await mkdir(base, { recursive: true, mode: 0o700 });
    const env = { ...verificationCliEnvironment(base), NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000',
      ...(inspectOnly ? { NTN_SKILLS_SCHEDULER_ROOT: join(base, 'scheduler') } : {}) };
    const invoke = async (suffix, args) => {
      const result = await operation(item.id + '-' + suffix, plan.config.command, args, { env, role: setup ? 'setup' : 'sample' });
      receipts.push(result.receipt);
      if (result.receipt.failure) errors.push({ stage: suffix, code: result.receipt.failure, errorCode: result.receipt.errorCode });
      return result.value;
    };
    const args = inspectOnly
      ? ['ctl', 'prepare', target, '--purpose', 'inspect', '--database', plan.config.database, '--metrics']
      : ['prepare', target, '--purpose', 'use', '--database', plan.config.database, '--metrics'];
    if (!inspectOnly && !setup && item.group === 'expired-unchanged') args.push('--max-age', '1s');
    else if (!inspectOnly && target === plan.config.root) args.push('--max-age', '5m');
    const graph = await invoke('prepare', args);
    let identity = null, nodes = [], rootReadyMs = null;
    if (graph?.ok === true && graph.status === 'ready') try {
      identity = sourceIdentity(graph); nodes = graph.nodes.filter(node => node.state === 'prepared');
      assert.equal(graph.roots.length, 1); assert.equal(graph.roots[0].target, target);
      const requestedRoot = new URL(plan.config.root), selectedRoot = nodes.find(node => node.id === graph.roots[0].id);
      assert.equal(selectedRoot?.record?.id, decodeURIComponent(requestedRoot.hostname));
      assert.equal(selectedRoot?.path, decodeURIComponent(requestedRoot.pathname.slice(1)));
      assert.equal(selectedRoot?.record?.locator?.database_id, plan.config.database);
      if (inspectOnly) {
        assert.equal(graph.purpose, 'inspect'); assert.equal(graph.graph_lock.purpose, 'inspect');
        assert.equal(nodes.length, 1); assert.equal(graph.usage?.prepared_nodes, 1);
        assert.equal(selectedRoot.source, 'notion', 'Cold inspect did not observe the source');
        const measuredRootReady = graph.preparation_metrics?.root_ready_ms;
        assert.ok(Number.isSafeInteger(measuredRootReady) && measuredRootReady >= 0, 'Missing inspect root-ready timing');
        rootReadyMs = measuredRootReady;
        identity = { ...identity, directory: nodes.map(node => ({ id: node.id, required: node.required, candidates: node.candidates,
          references: node.references, unresolved_references: node.unresolved_references ?? [] })) };
        if (!receipts[0].costs.complete) errors.push({ stage: 'metrics', code: 'INCOMPLETE_METRICS' });
      }
      if (baseline !== null && !same(identity, baseline.identity)) errors.push({ stage: 'identity', code: 'SOURCE_DRIFT' });
      if (baseline === null && item.group === 'cold' && !setup && receipts[0]?.failure === null) {
        baseline = { sample: item.id, identity, sha256: sha(canonical(identity)) };
        await save(join(plan.run, 'source-baseline.json'), baseline);
      }
      const rootNodes = graph.roots.map(root => nodes.find(node => node.id === root.id));
      if (!setup && item.group === 'warm' && rootNodes.some(node => node?.source !== 'local_cache')) errors.push({ stage: 'initial-state', code: 'WARM_CACHE_NOT_OBSERVED' });
      if (!setup && item.group === 'expired-unchanged' && rootNodes.some(node => node?.source !== 'notion' || node.freshness?.policy !== 'max_age' || node.freshness?.max_age_ms !== 1000)) errors.push({ stage: 'initial-state', code: 'TTL_REVALIDATION_NOT_OBSERVED' });
      for (const [index, node] of (inspectOnly ? [] : nodes).entries()) {
        if (stop.signal.aborted) { errors.push({ stage: 'read-' + (index + 1), code: 'RUN_CANCELLED_BEFORE_READ' }); break; }
        const read = await invoke('read-' + String(index + 1).padStart(3, '0'), ['read', node.ref, '--database', plan.config.database, '--metrics']);
        try { validateRead(read, node); } catch (error) { errors.push({ stage: 'read-' + (index + 1), code: 'FIXED_READ_MISMATCH', diagnostic: cleanError(error) }); }
      }
      if (plan.config.resourcePath && !stop.signal.aborted) {
        const root = rootNodes[0], file = root?.files?.find(file => file.path === plan.config.resourcePath);
        if (!root || !file) errors.push({ stage: 'resource', code: 'RESOURCE_NOT_IN_ROOT_MANIFEST' });
        else {
          const read = await invoke('resource', ['read', plan.config.resourcePath, '--from', root.ref, '--database', plan.config.database, '--metrics']);
          if (read?.ok !== true || read.path !== file.path || read.snapshot_id !== root.binding.snapshot_id || typeof read.content !== 'string' ||
            sha(read.content) !== file.sha256 || Buffer.byteLength(read.content) !== file.bytes || read.has_more !== false) errors.push({ stage: 'resource', code: 'RESOURCE_READ_MISMATCH' });
        }
      }
    } catch (error) { errors.push({ stage: 'graph', code: 'INVALID_GRAPH_EVIDENCE', diagnostic: cleanError(error) }); }
    else errors.push({ stage: 'prepare', code: 'NO_READY_GRAPH' });
    const completed = now();
    const sum = field => receipts.length && receipts.every(receipt => typeof receipt.costs[field] === 'number')
      ? receipts.reduce((total, receipt) => total + receipt.costs[field], 0) : null;
    const result = { version: 1, ...item, setup, status: errors.length ? 'failed' : 'passed', errors,
      startedNs: inspectOnly ? receipts[0]?.startedNs ?? null : started.toString(),
      completedNs: inspectOnly ? receipts[0]?.closedNs ?? null : completed.toString(),
      elapsedMs: inspectOnly ? receipts[0]?.elapsedMs ?? null : milliseconds(completed, started),
      identitySha256: identity === null ? null : sha(canonical(identity)), sourceIdentityVerified: baseline !== null && identity !== null && same(identity, baseline.identity),
      preparation: { target, preparedNodes: identity?.bindings.length ?? null, ...(inspectOnly ? { rootReadyMs } : {}), requestFreshness: graph?.nodes?.filter(node => node.state === 'prepared').map(node => ({ id: node.id, source: node.source ?? null, freshness: node.freshness ?? null })) ?? null },
      operations: receipts.map(receipt => receipt.receiptPath), logicalOperations: receipts.length, cliStarts: receipts.filter(receipt => receipt.pid !== null).length,
      plannedMainReads: inspectOnly ? 0 : identity?.bindings.length ?? baseline?.identity.bindings.length ?? null,
      executedMainReads: receipts.filter(receipt => receipt.args[0] === 'read' && !receipt.args.includes('--from')).length,
      costs: { cliElapsedSumMs: receipts.every(receipt => typeof receipt.elapsedMs === 'number') ? receipts.reduce((total, receipt) => total + receipt.elapsedMs, 0) : null, sourceHttpAttempts: sum('sourceHttpAttempts'),
        requestBytes: sum('requestBytes'), responseBytes: sum('responseBytes'), queueWaitMs: sum('queueWaitMs'), retryWaitMs: sum('retryWaitMs'),
        metricsComplete: receipts.every(receipt => receipt.costs.complete), providerTotalCost: null } };
    return { result, graph, env };
  };
  const resourceSample = async item => {
    const errors = [], base = join(plan.run, 'working', item.state);
    assert.equal(await present(base), false, 'Cold resource state must not pre-exist');
    await mkdir(base, { recursive: true, mode: 0o700 });
    const env = { ...verificationCliEnvironment(base), NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000' };
    const { receipt, value } = await operation(item.id + '-resource', plan.config.command,
      ['read', plan.config.resourcePath, '--from', plan.config.root, '--database', plan.config.database, '--metrics'], { env });
    if (receipt.failure) errors.push({ stage: 'resource', code: receipt.failure, errorCode: receipt.errorCode });
    let identity = null, materialization = null;
    if (receipt.failure === null) try {
      const observed = await observeResource(plan, item, value, join(base, 'state'));
      identity = observed.identity; materialization = observed.materialization;
      if (baseline !== null && !same(identity, baseline.identity)) errors.push({ stage: 'identity', code: 'SOURCE_DRIFT' });
      if (baseline === null) {
        baseline = { sample: item.id, identity, sha256: sha(canonical(identity)) };
        await save(join(plan.run, 'source-baseline.json'), baseline);
      }
    } catch (error) { errors.push({ stage: 'resource-observation', code: 'INVALID_RESOURCE_EVIDENCE', diagnostic: cleanError(error) }); }
    const completed = now();
    return { version: 1, ...item, setup: false, status: errors.length ? 'failed' : 'passed', errors,
      startedNs: receipt.startedNs, completedNs: receipt.closedNs, elapsedMs: receipt.elapsedMs,
      observationEndedNs: completed.toString(), observationElapsedMs: receipt.closedNs === null ? null : milliseconds(completed, BigInt(receipt.closedNs)),
      identitySha256: identity === null ? null : sha(canonical(identity)), sourceIdentityVerified: baseline !== null && identity !== null && same(identity, baseline.identity),
      preparation: null, requestedResourceCount: 1, resourcePath: plan.config.resourcePath, materialization,
      operations: [receipt.receiptPath], logicalOperations: 1, cliStarts: receipt.pid === null ? 0 : 1,
      plannedMainReads: 0, executedMainReads: 0, initialState: { strategy: 'empty-owned-state', path: base },
      costs: { cliElapsedSumMs: receipt.elapsedMs, sourceHttpAttempts: receipt.costs.sourceHttpAttempts,
        requestBytes: receipt.costs.requestBytes, responseBytes: receipt.costs.responseBytes, queueWaitMs: receipt.costs.queueWaitMs,
        retryWaitMs: receipt.costs.retryWaitMs, metricsComplete: receipt.costs.complete, providerTotalCost: null } };
  };
  try {
    for (const item of plan.samples) {
      if (stop.signal.aborted) { samples.push({ ...item, status: 'not_run', errors: [{ code: 'RUN_CANCELLED' }], elapsedMs: null, costs: null }); continue; }
      if (inspectFailed) { samples.push({ ...item, status: 'not_run', errors: [{ code: 'INSPECT_STOPPED_AFTER_FAILURE' }], elapsedMs: null, costs: null }); continue; }
      let initialState = null;
      try {
        if (pipelineMode(plan.config) === 'resource-only') {
          samples.push(await resourceSample(item));
          await save(join(plan.run, 'samples.json'), samples);
          process.stdout.write(JSON.stringify({ run: plan.run, sample: item.id, status: samples.at(-1).status }) + '\n');
          continue;
        }
        if (item.group === 'warm' || item.group === 'expired-unchanged') {
          if (steadySetup === null) {
            steadySetup = await pipelineSample({ id: 'setup-steady', group: 'warm', state: 'steady', index: 0 }, { setup: true });
            setups.push(steadySetup.result); await save(join(plan.run, 'setups.json'), setups);
          }
          if (item.group === 'expired-unchanged') {
            const waitStarted = now(); await new Promise(accept => setTimeout(accept, plan.ttl.expiredWaitMs)); const waitEnded = now();
            initialState = { strategy: 'elapsed-positive-ttl', waitStartedNs: waitStarted.toString(), waitEndedNs: waitEnded.toString(), elapsedMs: milliseconds(waitEnded, waitStarted), maxAge: '1s' };
          } else initialState = { strategy: 'shared-owned-warm-state', setupStatus: steadySetup.result.status };
        }
        let target = plan.config.root;
        if (item.group === 'partial') {
          const seeded = await pipelineSample({ ...item, id: 'setup-' + item.id }, { setup: true });
          setups.push(seeded.result); await save(join(plan.run, 'setups.json'), setups);
          assert.equal(seeded.result.status, 'passed', 'Partial setup did not establish the locked graph');
          const rootId = seeded.graph.roots[0]?.id, root = seeded.graph.nodes.find(node => node.state === 'prepared' && node.id === rootId);
          assert.ok(root, 'Partial root main missing');
          initialState = await trashMain(plan, item, root, operation); target = root.ref;
        }
        const sampled = await pipelineSample(item, { target });
        if (inspectOnly) initialState = { strategy: 'empty-owned-state', path: join(plan.run, 'working', item.state) };
        samples.push({ ...sampled.result, initialState });
      } catch (error) {
        samples.push({ ...item, status: 'failed', errors: [{ stage: 'initial-state-or-driver', ...cleanError(error) }], initialState,
          elapsedMs: null, operations: operations.filter(operation => operation.id.startsWith(item.id + '-')).map(operation => operation.receipt.receiptPath), costs: null });
      }
      if (inspectOnly && samples.at(-1)?.status !== 'passed') inspectFailed = true;
      await save(join(plan.run, 'samples.json'), samples);
      process.stdout.write(JSON.stringify({ run: plan.run, sample: item.id, status: samples.at(-1).status }) + '\n');
    }
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    await save(join(plan.run, 'samples.json'), samples); await save(join(plan.run, 'setups.json'), setups);
    await save(join(plan.run, 'run-end.json'), { at: new Date().toISOString(), cancelled: stop.signal.aborted, planSha256: plan.sha256, samples: samples.length });
  }
  return evidence(plan);
}

export async function evidence(plan) {
  const samples = JSON.parse(await readFile(join(plan.run, 'samples.json'), 'utf8'));
  const setups = JSON.parse(await readFile(join(plan.run, 'setups.json'), 'utf8'));
  const operations = JSON.parse(await readFile(join(plan.run, 'operations.json'), 'utf8'));
  const coverage = same(samples.map(sample => sample.id), plan.samples.map(sample => sample.id));
  let commandUnchanged = false;
  try { commandUnchanged = same(await fingerprintCommand(plan.config.command), plan.command); } catch { /* unavailable is not unchanged */ }
  const artifactErrors = [];
  if (plan.driver.savedPath) try { assert.equal(sha(await readFile(plan.driver.savedPath)), plan.driver.sha256); }
  catch (error) { artifactErrors.push({ operation: 'frozen-driver', ...cleanError(error) }); }
  for (const sample of samples) if (sample.materialization?.snapshotManifest) try {
    const manifest = sample.materialization.snapshotManifest, bytes = await readFile(manifest.path);
    assert.equal(bytes.length, manifest.bytes); assert.equal(sha(bytes), manifest.sha256);
  } catch (error) { artifactErrors.push({ operation: sample.id + '-snapshot-manifest', ...cleanError(error) }); }
  for (const operation of operations) try {
    const receipt = JSON.parse(await readFile(operation.receipt.receiptPath, 'utf8'));
    assert.deepEqual(receipt, operation.receipt);
    const stdout = await readFile(receipt.stdout.path);
    assert.equal(stdout.length, receipt.stdout.bytes); assert.equal(sha(stdout), receipt.stdout.sha256);
    assert.equal(sha(await readFile(receipt.stderr.path)), receipt.stderr.savedSha256);
    const lifecycle = await readFile(receipt.lifecycle);
    assert.equal(sha(lifecycle), receipt.lifecycleSha256);
    const events = lifecycle.toString('utf8').trim().split('\n').map(JSON.parse);
    if (receipt.pid !== null) assert.ok(events.some(event => event.event === 'spawn' && event.pid === receipt.pid) && events.some(event => event.event === 'close' && event.pid === receipt.pid));
  } catch (error) { artifactErrors.push({ operation: operation.id, ...cleanError(error) }); }
  const groups = Object.fromEntries(Object.keys(defaults).map(group => {
    const values = samples.filter(sample => sample.group === group);
    return [group, { planned: plan.config.samples[group], samples: values.map(sample => sample.id),
      comparableSamples: values.filter(sample => sample.status === 'passed' && sample.sourceIdentityVerified && sample.costs?.metricsComplete).length,
      outcomes: Object.fromEntries(['passed', 'failed', 'not_run'].map(status => [status, values.filter(sample => sample.status === status).length])),
      elapsedMs: consumptionMetricStats(values.map(sample => sample.elapsedMs ?? null)),
      ...(pipelineMode(plan.config) === 'inspect-current' ? { rootReadyMs: consumptionMetricStats(values.map(sample => sample.preparation?.rootReadyMs ?? null)) } : {}),
      cliStarts: consumptionMetricStats(values.map(sample => sample.cliStarts ?? null)),
      costs: Object.fromEntries(['cliElapsedSumMs', 'sourceHttpAttempts', 'requestBytes', 'responseBytes', 'queueWaitMs', 'retryWaitMs'].map(key => [key, consumptionMetricStats(values.map(sample => sample.costs?.[key] ?? null))])) }];
  }));
  const report = { version: 1, planSha256: plan.sha256, run: plan.run, coverageComplete: coverage, commandUnchanged, artifactIntegrity: { valid: artifactErrors.length === 0, errors: artifactErrors }, samples: samples.length, groups,
    setups, setupOperations: operations.filter(item => item.role !== 'sample').map(item => ({ id: item.id, role: item.role, elapsedMs: item.receipt.elapsedMs, receipt: item.receipt.receiptPath })),
    operationCount: operations.length, failedOperations: operations.filter(item => item.receipt.failure).map(item => ({ id: item.id, failure: item.receipt.failure, receipt: item.receipt.receiptPath })),
    layer: 'source-cli', aggregation: 'all-planned-samples-failures-retained-unknown-metrics-null-p95-requires-20-observations',
    providerTotalCost: null, modelAcceptance: 'not-run', productAcceptance: 'not-inferred' };
  await save(join(plan.run, 'evidence.json'), report);
  return report;
}

export async function cleanup(plan) {
  assert.ok(await present(join(plan.run, 'run-end.json')), 'Cleanup requires an ended run');
  if (pipelineMode(plan.config) === 'inspect-current') {
    const samples = JSON.parse(await readFile(join(plan.run, 'samples.json'), 'utf8'));
    assert.ok(samples.length === plan.samples.length && samples.every(sample => sample.status === 'passed'), 'Retain the failed inspect working state for review and original-operation recovery');
  }
  const working = join(plan.run, 'working');
  if (!(await present(working))) return { status: 'already-clean', run: plan.run };
  assert.equal(await realpath(working), working); assert.ok((await lstat(working)).isDirectory() && !(await lstat(working)).isSymbolicLink());
  const before = sha(await readFile(join(plan.run, 'evidence.json')));
  const child = await measureCommand(['/usr/bin/trash'], [working], { directory: join(plan.run, 'cleanup'), id: 'working-' + randomUUID(), env: process.env, json: false, timeoutMs: 30000 });
  const receipt = { status: child.receipt.failure ? 'failed' : 'clean', run: plan.run, working, commandReceipt: child.receipt.receiptPath,
    evidenceSha256Before: before, evidenceSha256After: sha(await readFile(join(plan.run, 'evidence.json'))), workingAbsent: !(await present(working)) };
  await save(join(plan.run, 'cleanup.json'), receipt);
  return receipt;
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help') { console.log(help); return; }
  const [mode, ...rest] = argv;
  assert.ok(['doctor', 'plan', 'run', 'evidence', 'cleanup'].includes(mode), 'Unknown mode');
  assert.ok(rest.length === 2 && ['--config', '--run'].includes(rest[0]), 'Expected exactly --config or --run');
  if (mode === 'doctor' || mode === 'plan' || mode === 'run' && rest[0] === '--config') {
    assert.equal(rest[0], '--config'); const config = await configuration(rest[1]);
    if (mode === 'doctor') { console.log(JSON.stringify(await doctor(config), null, 2)); return; }
    const plan = await freezePlan(config); console.log(JSON.stringify({ frozenPlan: join(plan.run, 'plan.json'), sha256: plan.sha256, run: plan.run }));
    if (mode === 'plan') return;
    console.log(JSON.stringify(await executePlan(plan), null, 2)); return;
  }
  assert.equal(rest[0], '--run'); const plan = await loadPlan(rest[1]);
  const result = mode === 'run' ? await executePlan(plan) : mode === 'evidence' ? await evidence(plan) : await cleanup(plan);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify(cleanError(error))); process.exitCode = 1; });
}
