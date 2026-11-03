#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('node prefetch-cli-counterfactual.mjs --command-json \'["/absolute/node","/absolute/installed/ntn-skills.js"]\' --graph GRAPH --entry DATABASE --root-id EXACT_ID --evidence-root /absolute/evidence [--samples 1..3]');
  console.log('Read-only retained graph comparison. Each arm restores only the complete manifest into independent empty CLI roots, then selects the same pinned root and Required closure. Inherits existing authorization without reading or copying credentials.');
  process.exit(0);
}
const allowed = new Set(['--command-json', '--graph', '--entry', '--root-id', '--evidence-root', '--samples']);
const options = new Map();
for (let index = 0; index < argv.length; index += 2) {
  const key = argv[index], value = argv[index + 1];
  assert(allowed.has(key) && typeof value === 'string' && !options.has(key), 'Invalid or repeated argument');
  options.set(key, value);
}
const required = key => { const value = options.get(key); assert(value, key + ' is required'); return value; };
const command = JSON.parse(required('--command-json'));
assert(Array.isArray(command) && command.length === 2 && command.every(value => typeof value === 'string' && isAbsolute(value)), 'Use exact installed Node and CLI entry paths');
const graph = required('--graph'), entry = required('--entry'), rootId = required('--root-id'), evidenceRoot = required('--evidence-root');
assert(/^graph-[a-f0-9]{64}$/.test(graph) && /^shared_skill:/.test(rootId) && isAbsolute(evidenceRoot));
const samples = Number(options.get('--samples') ?? 1);
assert(Number.isSafeInteger(samples) && samples >= 1 && samples <= 3);
await mkdir(evidenceRoot, { recursive: true });
const evidence = await realpath(await mkdtemp(join(evidenceRoot, 'retained-prefetch-')));
const hash = value => createHash('sha256').update(value).digest('hex');
const budget = { maxNodes: 1, maxDepth: 0, maxBytes: 65536, maxTimeMs: 45000, queueBudgetMs: 5000, rateShare: 0.25 };
const manifest = {
  version: 1, status: 'running', evidence, command: await Promise.all(command.map(path => realpath(path))),
  cli_sha256: hash(await readFile(command[1])), graph, entry, root_id: rootId, samples, budget,
  scenario: 'explicit retained-A root use, optional root inspect warming; current pages may only validate authorization',
  authorization: 'inherited process environment, never copied or serialized', arms: [],
  limitations: ['One small retained graph, not a general performance claim', 'CLI consumer comparison; real Pi/provider selection is a separate layer', 'No state/cache is shared between arms; manifest restoration is reported separately'],
};
await writeFile(join(evidence, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ evidence, phase: 'started', samples }));
const owned = new Set();
const stop = () => { for (const child of owned) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
let sequence = 0;
async function invoke(name, args, env, allowFailure = false) {
  const ordinal = ++sequence, started = performance.now(), prefix = join(evidence, String(ordinal).padStart(3, '0') + '-' + name);
  await writeFile(prefix + '.command.json', JSON.stringify({ argv: [...command, ...args], started_at: new Date().toISOString() }, null, 2));
  const child = spawn(command[0], [command[1], ...args], { env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  owned.add(child);
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
  const timeout = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, 180000);
  const exit = await new Promise((done, fail) => { child.on('error', fail); child.on('close', (code, signal) => done({ code, signal })); });
  clearTimeout(timeout); owned.delete(child);
  const elapsed_ms = performance.now() - started;
  await writeFile(prefix + '.json', Buffer.concat(stdout));
  await writeFile(prefix + '.stderr', Buffer.concat(stderr));
  const value = JSON.parse(Buffer.concat(stdout).toString('utf8'));
  const metrics = value.request_metrics;
  assert(metrics && Array.isArray(metrics.trace) && metrics.trace_enabled === true && metrics.trace_dropped === 0, 'Complete actual request metrics are required; absence is not zero');
  assert.equal(metrics.unknown_request_bytes, 0); assert.equal(metrics.unknown_response_bytes, 0);
  assert.equal(metrics.requests.notion_write, 0, 'This retained comparison must not write Notion');
  assert.equal(metrics.requests.provider, 0);
  assert.equal(metrics.body_requests.current_body, 0, 'No current instruction bytes may replace A');
  assert.equal(metrics.body_requests.unclassified_body, 0);
  const observation = { name, exit, elapsed_ms, ok: value.ok === true, error: value.error?.code,
    requests: metrics.requests, body_requests: metrics.body_requests,
    request_bytes: metrics.request_bytes, response_bytes: metrics.response_bytes,
    queue_wait_ms: metrics.queue_wait_ms, retry_wait_ms: metrics.retry_wait_ms, actual_trace_file: prefix + '.json' };
  await writeFile(prefix + '.observation.json', JSON.stringify(observation, null, 2));
  console.log(JSON.stringify({ phase: name, ok: observation.ok, elapsed_ms, requests: observation.requests }));
  if (!allowFailure) assert(exit.code === 0 && value.ok === true, 'Public command failed: ' + name);
  return { value, observation, metrics };
}
try {
  for (let sample = 1; sample <= samples; sample++) for (const enabled of [false, true]) {
    const name = sample + '-' + (enabled ? 'budget-on' : 'budget-off'), state = join(evidence, name);
    const env = { ...process.env, NTN_SKILLS_HOME: join(state, 'state'), NTN_SKILLS_CONFIG_HOME: join(state, 'config'),
      NTN_SKILLS_CACHE_HOME: join(state, 'cache'), NTN_SKILLS_DATA_HOME: join(state, 'data'), NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000' };
    const restored = await invoke(name + '-manifest', ['ctl', 'library', 'graph', 'restore', graph, '--entry', entry, '--materialize', 'manifest'], env);
    assert.equal(restored.value.manifest_complete, true);
    assert.equal(restored.value.loaded, false);
    assert(restored.value.nodes.every(node => node.materialization?.materialized_paths?.length === 0), 'Every consumer starts without file objects');
    const binding = restored.value.graph_lock.bindings.find(binding => binding.record.id === rootId);
    assert(binding, 'Exact selected root is absent from the restored version vector');
    const bindingFile = join(state, 'session-bindings.json');
    await writeFile(bindingFile, JSON.stringify(restored.value.graph_lock.bindings));
    let warmed;
    if (enabled) warmed = await invoke(name + '-prefetch', [
      'prepare', binding.ref, '--purpose', 'inspect', '--priority', 'prefetch',
      '--max-nodes', String(budget.maxNodes), '--max-depth', String(budget.maxDepth),
      '--max-instruction-bytes', String(budget.maxBytes), '--max-context-bytes', String(budget.maxBytes),
      '--time-budget-ms', String(budget.maxTimeMs), '--queue-budget-ms', String(budget.queueBudgetMs), '--rate-share', String(budget.rateShare), '--metrics',
    ], env, true);
    if (warmed?.value.ok) {
      assert.equal(warmed.value.purpose, 'inspect'); assert.deepEqual(warmed.value.required_closure, []);
      assert.deepEqual(warmed.value.nodes.filter(node => node.state === 'prepared').map(node => node.id), [rootId]);
    }
    const foreground = await invoke(name + '-use', ['prepare', binding.ref, '--purpose', 'use', '--session-bindings', bindingFile, '--metrics'], env);
    assert.equal(foreground.value.purpose, 'use');
    for (const selected of foreground.value.session_bindings) {
      const expected = restored.value.graph_lock.bindings.find(binding => binding.record.id === selected.record.id);
      assert.deepEqual(selected, expected, 'Foreground must preserve each exact restored A binding');
    }
    const prepared = warmed?.value.ok ? warmed.value.nodes.filter(node => node.state === 'prepared') : [];
    const used = new Set(foreground.value.session_bindings.map(binding => binding.record.id + ':' + binding.snapshot_id + ':' + binding.body_sha256));
    const wasted_instruction_bytes = prepared.reduce((sum, node) => sum + (used.has(node.id + ':' + node.binding.snapshot_id + ':' + node.body_sha256) ? 0 : node.bytes), 0);
    const warmOnlyRetainedBytes = warmed?.metrics.trace.filter(event => event.event === 'attempt' && event.body_kind === 'retained_body')
      .reduce((sum, event) => sum + (event.response_bytes ?? 0), 0) ?? 0;
    manifest.arms.push({
      sample, enabled, state, restored: restored.observation, prefetch: warmed?.observation ?? null, foreground: foreground.observation,
      foreground_wait_ms: foreground.observation.elapsed_ms,
      preparation_and_foreground_ms: foreground.observation.elapsed_ms + (warmed?.observation.elapsed_ms ?? 0),
      total_request_count_excluding_manifest: [warmed, foreground].filter(Boolean).reduce((sum, phase) => sum + Object.values(phase.metrics.requests).reduce((n, count) => n + count, 0), 0),
      total_response_bytes_excluding_manifest: foreground.metrics.response_bytes + (warmed?.metrics.response_bytes ?? 0),
      wasted_instruction_bytes,
      prefetch_retained_response_bytes: warmOnlyRetainedBytes,
      unused_prefetch_retained_response_bytes: warmed?.value.ok && wasted_instruction_bytes === 0 ? 0 : warmOnlyRetainedBytes,
      pins: foreground.value.session_bindings.map(binding => ({ id: binding.record.id, scope: binding.scope, snapshot_id: binding.snapshot_id, body_sha256: binding.body_sha256 })),
    });
    await writeFile(join(evidence, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  manifest.status = 'passed';
  manifest.default_budget = 0;
  manifest.performance_conclusion = 'Measured arms are reported individually; no default change or general benefit is inferred.';
} catch (error) {
  manifest.status = 'failed'; manifest.error = String(error);
  process.exitCode = 1; stop();
} finally {
  await writeFile(join(evidence, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ evidence, status: manifest.status, error: manifest.error, arms: manifest.arms.length }));
}
