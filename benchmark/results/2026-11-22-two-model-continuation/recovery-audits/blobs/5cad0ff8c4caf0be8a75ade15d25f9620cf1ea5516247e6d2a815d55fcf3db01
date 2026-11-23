import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, fingerprint } from './protocol.mjs';
import { validateBatchPlan } from './batch.mjs';
import { executionImplementation, instrumentationIdentity } from './implementation.mjs';
import { inventoryPublicInputs } from './subject.mjs';
import { prepareMaterialOwnership, verifyMaterialOwnership } from './material-ownership.mjs';

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const registrationName = 'collection-repair-registration.json';
const kind = 'benchmark-collection-recovery';
const hashPattern = /^[a-f0-9]{64}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(canonicalJson(value) + '\n');
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const sameRef = (a, b) => a?.path === b?.path && a?.sha256 === b?.sha256;
const fixedPath = plan => join(plan.execution.control_root, registrationName);
const allowedChanges = new Set(['cli.mjs', 'controller.mjs', 'pilot-scope.mjs', 'prospective-cohort.mjs',
  'collection-recovery.mjs', 'material-ownership.mjs']);
const additions = new Set(['collection-recovery.mjs', 'material-ownership.mjs']);
const registrationKeys = new Set(['version', 'kind', 'created_at', 'reason', 'plan', 'ledger_prefix', 'frozen_controller',
  'before_implementation', 'implementation', 'source_changes', 'before_sources', 'implementation_sources',
  'instrumentation', 'frozen_inputs', 'repairs', 'material_bindings', 'registration_sha256']);

function absolute(path) {
  assert.ok(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'Collection recovery needs canonical absolute paths');
  return path;
}
function descriptor(ref) {
  assert.ok(ref && typeof ref === 'object' && !Array.isArray(ref)); absolute(ref.path);
  assert.ok(hashPattern.test(ref.sha256 ?? ''), 'Collection recovery needs a SHA256 reference');
  if (ref.bytes !== undefined) assert.ok(Number.isSafeInteger(ref.bytes) && ref.bytes >= 0);
  return ref;
}
async function ordinaryDirectory(path) {
  absolute(path); const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Collection recovery directory must be ordinary');
  assert.equal(await realpath(path), path, 'Collection recovery directory cannot contain symlinks');
}
async function ownedDirectories(environmentRoot, path) {
  await ordinaryDirectory(environmentRoot); absolute(path);
  assert.ok(inside(environmentRoot, path), 'Collection recovery destination escapes its environment');
  let current = environmentRoot;
  for (const name of relative(environmentRoot, path).split(sep).filter(Boolean)) {
    current = join(current, name);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await ordinaryDirectory(current);
  }
}
async function bytesAt(path, root) {
  absolute(path); if (root) assert.ok(inside(root, path), 'Collection recovery evidence escapes its owner');
  const before = await lstat(path);
  assert.ok(before.isFile() && !before.isSymbolicLink(), 'Collection recovery evidence must be an ordinary file');
  assert.equal(await realpath(path), path, 'Collection recovery evidence ancestors cannot be symlinks');
  const bytes = await readFile(path), after = await lstat(path);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key], 'Collection recovery evidence changed while reading');
  assert.equal(await realpath(path), path);
  return bytes;
}
async function referenceAt(path, root) {
  const bytes = await bytesAt(path, root); return { path, sha256: sha(bytes), bytes: bytes.length };
}
async function verifiedBytes(ref, root) {
  descriptor(ref); const bytes = await bytesAt(ref.path, root);
  assert.equal(sha(bytes), ref.sha256, 'Collection recovery evidence SHA256 changed');
  if (ref.bytes !== undefined) assert.equal(bytes.length, ref.bytes, 'Collection recovery evidence byte count changed');
  return bytes;
}
async function noFile(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.fail('Collection recovery requires absent active lease or registration: ' + path);
}
async function noActiveLease(plan) {
  await noFile(join(plan.execution.control_root, 'lease.json'));
  const shared = plan.execution.pilot_ledger_root; await ordinaryDirectory(shared);
  await noFile(join(shared, 'campaign.lease.json'));
  assert.ok(!(await readdir(shared)).some(name => /^scope-.+\.lease\.json$/.test(name)), 'Collection recovery requires no active scope lease');
}
async function writeOnce(path, bytes, environmentRoot) {
  await ownedDirectories(environmentRoot, dirname(path));
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.deepEqual(await bytesAt(path, environmentRoot), bytes, 'Collection recovery refuses to overwrite an existing artifact'); }
  return { path, sha256: sha(bytes), bytes: bytes.length };
}
function parseLedger(bytes) {
  assert.ok(bytes.length && bytes.at(-1) === 10, 'Collection recovery requires complete ledger appends');
  return bytes.toString('utf8').split('\n').slice(0, -1).map((line, index) => {
    assert.ok(line); const row = JSON.parse(line); assert.equal(row.version, 1); assert.equal(row.seq, index + 1, 'Collection recovery ledger sequence changed'); return row;
  });
}
function slotFor(plan, event) {
  const slot = plan.slots.find(item => item.slot_id === event.slot_id);
  assert.ok(slot, 'Collection recovery ledger names an unknown slot');
  for (const [key, value] of Object.entries(slot)) assert.deepEqual(event[key], value, 'Collection recovery slot identity changed: ' + key);
  const runId = plan.id + '-' + String(slot.order + 1).padStart(3, '0');
  assert.equal(event.run_id, runId, 'Collection recovery run identity changed');
  const condition = plan.protocol.conditions.find(item => item.id === slot.condition_id);
  assert.ok(condition); if (event.type === 'episode_started') assert.equal(event.budget_id, condition.budget_id, 'Collection recovery budget identity changed');
  return slot;
}

/** A narrowly scoped first-gate collection failure, not a retry or an unknown-cost exemption. */
export function validateCollectionRecoveryLedger({ plan, bytes, prefix, reference, repairs = [] }) {
  const rows = parseLedger(bytes), boundary = prefix?.through_seq ?? rows.length;
  if (prefix) {
    descriptor(prefix); assert.ok(Number.isSafeInteger(prefix.bytes) && prefix.bytes > 0 && bytes.length >= prefix.bytes);
    assert.equal(sha(bytes.subarray(0, prefix.bytes)), prefix.sha256, 'Original failed ledger byte prefix changed');
    assert.equal(bytes[prefix.bytes - 1], 10); assert.equal(parseLedger(bytes.subarray(0, prefix.bytes)).length, boundary);
  }
  const original = rows.slice(0, boundary);
  assert.equal(original.at(-1)?.type, 'batch_closed', 'Collection recovery needs a closed original failed batch');
  assert.equal(original.at(-1).reason, 'unresolved_execution_error');
  const starts = original.filter(row => row.type === 'episode_started'), failures = original.filter(row => row.type === 'episode_unresolved');
  assert.equal(starts.length, 1, 'Collection recovery is limited to the first dispatched gate episode');
  assert.equal(failures.length, 1); assert.equal(original.filter(row => row.type === 'episode_completed').length, 0);
  const started = starts[0], failed = failures[0]; slotFor(plan, started); slotFor(plan, failed);
  assert.equal(started.order, 0); assert.equal(failed.run_id, started.run_id); assert.ok(failed.seq > started.seq);
  assert.deepEqual(failed.error, { name: 'AssertionError', message: 'Evidence file escapes the owned environment' }, 'Only the owned-material collection failure is recoverable');
  if (prefix) assert.deepEqual(repairs.map(item => ({ run_id: item.run_id, slot_id: item.slot_id,
    episode_started_seq: item.episode_started_seq, episode_unresolved_seq: item.episode_unresolved_seq })),
  [{ run_id: started.run_id, slot_id: started.slot_id, episode_started_seq: started.seq, episode_unresolved_seq: failed.seq }]);
  let active = false, newInBatch = 0, originalRecovered = false, zeroSendBatchClosed = false, retainedStop = false;
  const allStarts = new Map(), completed = new Map();
  for (const row of rows) {
    assert.ok(['batch_opened', 'batch_closed', 'batch_stopped', 'episode_started', 'episode_unresolved', 'episode_completed'].includes(row.type), 'Collection recovery rejects unregistered ledger transitions');
    if (row.type === 'batch_opened') { assert.equal(active, false); active = true; newInBatch = 0; assert.equal(row.plan_sha256, plan.plan_sha256); continue; }
    if (row.type === 'batch_closed') {
      assert.equal(active, true); assert.equal(row.new_episodes, newInBatch); active = false;
      if (row.seq > boundary && originalRecovered && !zeroSendBatchClosed) { assert.equal(newInBatch, 0, 'The first recovery batch must dispatch zero new episodes'); zeroSendBatchClosed = true; }
      continue;
    }
    assert.equal(active, true, 'Collection recovery ledger event occurs outside an open batch');
    if (row.type === 'batch_stopped') continue;
    slotFor(plan, row);
    if (row.type === 'episode_started') {
      assert.ok(!allStarts.has(row.run_id), 'Collection recovery cannot restart an existing run');
      if (row.seq > boundary) {
        assert.equal(zeroSendBatchClosed, true, 'Original recovery must close a zero-send batch before any new dispatch');
        assert.ok([...allStarts.keys()].every(runId => completed.has(runId)), 'Collection recovery cannot dispatch past an unresolved execution');
        assert.equal(retainedStop, false, 'Collection recovery cannot dispatch past a retained stop or unknown usage');
        assert.equal(row.order, allStarts.size, 'Collection recovery must retain the frozen dispatch order');
      }
      allStarts.set(row.run_id, row); newInBatch++; continue;
    }
    assert.ok(allStarts.has(row.run_id), 'Collection recovery completion has no original start');
    if (row.type === 'episode_unresolved') { assert.ok(!completed.has(row.run_id)); continue; }
    assert.ok(row.seq > boundary && reference, 'Collection recovery cannot replace a previous completion');
    assert.ok(!completed.has(row.run_id), 'Collection recovery cannot duplicate a completion');
    assert.ok(sameRef(row.result?.collection_recovery, reference), 'Collection recovery result reference is missing or differs');
    assert.equal(row.result?.analysis_revision, undefined, 'Collection recovery and analysis revision are distinct');
    assert.equal(row.result?.run_root, join(plan.execution.environment_root, 'runs', row.run_id), 'Collection recovery result changed raw ownership');
    assert.equal(row.result?.normalized_directory, join(plan.execution.control_root, 'collection-repair-results', row.run_id, 'normalized'), 'Collection recovery result must use its separate retained output');
    assert.ok(hashPattern.test(row.result?.episode_sha256 ?? ''), 'Collection recovery completion lacks normalized evidence');
    if (row.run_id === started.run_id) {
      assert.equal(row.reconciled, true); assert.equal(newInBatch, 0);
      if (prefix) assert.deepEqual(row.result.budget_usage, repairs[0].budget_usage, 'Recovered completion must retain actual original usage');
      originalRecovered = true;
    }
    else assert.equal(zeroSendBatchClosed, true);
    assert.equal(typeof row.result.stop_batch, 'boolean', 'Collection recovery must retain the batch-stop decision');
    retainedStop ||= row.result.stop_batch || ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms']
      .some(key => !Number.isFinite(row.result.budget_usage?.[key]) || row.result.budget_usage[key] < 0);
    completed.set(row.run_id, row);
  }
  return { rows, original, started, failed, completed: [...completed.values()], original_recovered: originalRecovered,
    zero_send_batch_closed: zeroSendBatchClosed, active };
}

/** Every changed byte is fixed by the registration; collector/runtime/scoring sources cannot change. */
export function collectionRecoverySourceChanges(before, after) {
  for (const value of [before, after]) {
    assert.equal(value?.version, 1); assert.ok(Array.isArray(value.files) && value.files.length);
    assert.equal(value.sha256, fingerprint(value.files));
    assert.equal(new Set(value.files.map(file => file.path)).size, value.files.length);
    for (const file of value.files) {
      assert.ok(typeof file.path === 'string' && file.path && !isAbsolute(file.path));
      assert.ok(inside(dirname(moduleRoot), resolve(moduleRoot, file.path)), 'Recovery source inventory escapes the repository');
      assert.ok(hashPattern.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0);
    }
  }
  assert.equal(after.scope, before.scope);
  const old = new Map(before.files.map(item => [item.path, item])), next = new Map(after.files.map(item => [item.path, item])), changes = [];
  for (const [path, file] of old) {
    assert.ok(next.has(path), 'Collection recovery cannot remove frozen source files');
    if (file.sha256 === next.get(path).sha256 && file.bytes === next.get(path).bytes) continue;
    assert.ok(allowedChanges.has(path), 'Collection recovery cannot alter ' + path);
    changes.push({ path, before: file, after: next.get(path) });
  }
  for (const [path, file] of next) if (!old.has(path)) {
    assert.ok(additions.has(path), 'Collection recovery cannot add arbitrary controller dependencies');
    changes.push({ path, before: null, after: file });
  }
  for (const path of additions) assert.ok(next.has(path), 'Collection recovery implementation is incomplete');
  assert.ok(changes.length); return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export function validateCollectionRecoveryRaw({ plan, slot, run, shared, runtime, observed, expectation, payloads }) {
  const candidate = plan.execution.conditions[slot.condition_id], condition = plan.protocol.conditions.find(item => item.id === slot.condition_id);
  const model = plan.protocol.models.find(item => item.id === condition.model_id), budget = plan.protocol.policies.budgets.find(item => item.id === condition.budget_id).episode;
  const runId = plan.id + '-' + String(slot.order + 1).padStart(3, '0'), root = join(plan.execution.environment_root, 'runs', runId);
  for (const item of [run, shared]) { assert.equal(item.run_id, runId); assert.equal(item.root, root); assert.equal(item.build_id, candidate.build_id); }
  assert.equal(run.build_root, join(plan.execution.environment_root, 'builds', candidate.build_id));
  assert.equal(run.pi_launch?.mode, candidate.mode);
  assert.equal(shared.status, 'passed'); assert.equal(shared.exit_code, 0); assert.equal(shared.spawned, true);
  assert.equal(shared.timed_out, false); assert.equal(shared.signal ?? null, null);
  assert.equal(shared.frozen_artifacts, 'passed'); assert.equal(shared.runtime_check?.status, 'unchanged');
  assert.equal(runtime.status, 'completed'); assert.equal(runtime.entry_kind, 'pi-sdk');
  assert.deepEqual(runtime.correlation, { run_id: runId, episode_id: runId, candidate_id: slot.condition_id, task_id: slot.case_id });
  assert.equal(runtime.admission?.status, 'accepted_before_task'); assert.equal(runtime.error ?? null, null);
  assert.equal(runtime.turns?.length, 1); assert.equal(runtime.completion?.agent_settled, true);
  for (const key of ['abort_settled', 'shutdown_emitted', 'dispose_called']) assert.equal(runtime.completion.cleanup?.[key], true);
  for (const key of ['attempts', 'tools', 'interventions', 'notion_sdk', 'notion_owned_http']) assert.equal(runtime.coverage?.[key], 'complete');
  assert.deepEqual(observed.projection, expectation.projection, 'Recovered subject differs from its original startup expectation');
  assert.equal(observed.projection.model.id, model.route); assert.equal(observed.projection.model.api, model.api);
  assert.deepEqual(observed.projection.model_parameters, model.parameters);
  if (model.routing) assert.deepEqual(observed.projection.model_routing, model.routing);
  assert.equal(runtime.budget?.usage_unknown, false); assert.equal(runtime.budget.stop ?? null, null);
  assert.equal(budget.max_retries, 0); assert.ok(runtime.requests?.length > 0);
  assert.equal(runtime.requests.length, runtime.budget.requests); assert.equal(payloads.length, runtime.requests.length);
  let requests = 0, input = 0, output = 0;
  const ids = new Set();
  for (let index = 0; index < runtime.requests.length; index++) {
    const request = runtime.requests[index]; assert.ok(!ids.has(request.id)); ids.add(request.id);
    assert.equal(request.sequence, index + 1); assert.equal(request.accounted, true); assert.equal(request.attempts?.length, 1);
    assert.equal(payloads[index].model, model.route, 'Recovered request payload changed model route');
    assert.equal(sha(JSON.stringify(payloads[index])), request.payload_sha256, 'Recovered serialized request payload changed');
    const attempt = request.attempts[0]; assert.equal(attempt.sent, true); assert.equal(attempt.status, 200);
    assert.equal(attempt.request_id, request.id); assert.equal(request.usage_attempt_id, attempt.id);
    if (model.routing) {
      assert.equal(attempt.reported_model?.status, 'matched');
      assert.ok(attempt.reported_model.reported_ids?.length > 0);
      assert.ok(attempt.reported_model.reported_ids.every(id => model.routing.reported_model_ids.includes(id)), 'Recovered provider label is outside the frozen route group');
    }
    assert.equal(request.usage?.complete_for_token_budget, true);
    for (const key of ['input', 'output']) assert.ok(Number.isFinite(request.usage[key]) && request.usage[key] >= 0);
    input += request.usage.input; output += request.usage.output; requests++;
  }
  assert.equal(runtime.budget.attempts, requests); assert.equal(runtime.budget.input_tokens, input); assert.equal(runtime.budget.output_tokens, output);
  assert.equal(runtime.budget.tokens, input + output);
  const usage = { model_requests: requests, input_tokens: input, output_tokens: output, duration_ms: runtime.timing?.duration_ms };
  for (const [key, value] of Object.entries(usage)) assert.ok(Number.isFinite(value) && value >= 0 && value <= budget['max_' + key], 'Recovered usage is unknown or exceeds its original budget');
  assert.ok(requests <= budget.max_http_attempts); return usage;
}

async function planContext(plan, planFile = join(plan.execution.control_root, 'plan.json')) {
  validateBatchPlan(plan); const e = plan.execution;
  assert.equal(plan.protocol.phase, 'pilot'); assert.equal(e.pilot_scope?.role, 'gate', 'Collection recovery is gate-only');
  assert.equal(e.resumption, undefined); assert.equal(e.episode_fixtures, undefined, 'Collection recovery cannot hide turn fixtures');
  await ordinaryDirectory(e.environment_root); await ordinaryDirectory(e.control_root);
  assert.ok(inside(e.environment_root, e.control_root) && e.control_root !== e.environment_root);
  assert.equal(planFile, join(e.control_root, 'plan.json'));
  const planRef = await referenceAt(planFile, e.environment_root);
  assert.deepEqual(JSON.parse(await verifiedBytes(planRef, e.environment_root)), plan);
  const amendment = JSON.parse(await verifiedBytes(e.pilot_scope.amendment, e.environment_root));
  assert.equal(amendment.kind, 'benchmark-prospective-cohort'); assert.equal(amendment.id, e.pilot_scope.id);
  const inputFiles = [await referenceAt(e.case_bindings_file, e.environment_root), await referenceAt(e.models_file, e.environment_root),
    await referenceAt(e.adapter_evidence_file, e.environment_root), await referenceAt(e.pilot_scope.amendment.path, e.environment_root)];
  assert.equal(inputFiles[0].sha256, e.case_bindings_sha256); assert.equal(inputFiles[1].sha256, e.models_sha256);
  for (const model of plan.protocol.models) assert.equal(inputFiles[2].sha256, model.adapter.evidence_sha256, 'Frozen adapter evidence changed');
  const bindings = JSON.parse(await verifiedBytes(inputFiles[0], e.environment_root));
  assert.ok(Array.isArray(bindings) && bindings.length); assert.equal(new Set(bindings.map(binding => binding.id)).size, bindings.length);
  assert.deepEqual(bindings.map(binding => binding.id).sort(), [...new Set(plan.slots.map(slot => slot.case_id))].sort());
  const identities = [];
  for (const binding of bindings) {
    assert.equal(binding.public_case?.turns?.length, 1, 'Collection recovery is limited to single-turn cases');
    assert.deepEqual(binding.events, []); assert.deepEqual(binding.clarification, []);
    assert.equal(binding.protocol_case?.id, binding.id);
    inputFiles.push(await referenceAt(binding.oracle_path, e.environment_root)); assert.equal(inputFiles.at(-1).sha256, binding.oracle_sha256);
    await ordinaryDirectory(binding.input_root); assert.ok(inside(e.environment_root, binding.input_root));
    const inventory = await inventoryPublicInputs(binding.input_root);
    assert.equal(sha(JSON.stringify(inventory)), binding.input_inventory_sha256, 'Frozen public task inputs changed');
    identities.push({ case_id: binding.id, binding_sha256: fingerprint(binding), input_inventory_sha256: binding.input_inventory_sha256 });
  }
  for (const condition of Object.values(e.conditions)) for (const ref of Object.values(condition.expectations)) {
    await verifiedBytes(ref, e.environment_root); inputFiles.push(await referenceAt(ref.path, e.environment_root));
  }
  const files = [...new Map(inputFiles.map(ref => [ref.path, ref])).values()].sort((a, b) => a.path.localeCompare(b.path));
  const buildIds = [...new Set(Object.values(e.conditions).map(condition => condition.build_id))]; assert.equal(buildIds.length, 1);
  return { planRef: { ...planRef, plan_sha256: plan.plan_sha256 }, bindings, frozenInputs: { files, bindings: identities },
    frozenController: join(e.environment_root, 'builds', buildIds[0], 'source/broker/benchmark/cli.mjs') };
}
async function archiveSources(implementation, sourceRoot, directory, environmentRoot) {
  const rows = [];
  for (const file of implementation.files) {
    const path = resolve(sourceRoot, file.path); assert.ok(inside(dirname(sourceRoot), path));
    const bytes = await verifiedBytes({ ...file, path });
    rows.push({ ...file, archive: await writeOnce(join(directory, file.sha256 + '.source'), bytes, environmentRoot) });
  }
  return rows;
}
async function verifyArchives(implementation, rows, directory, environmentRoot) {
  assert.deepEqual(rows.map(({ archive, ...file }) => file), implementation.files);
  const sources = new Map();
  for (const row of rows) {
    assert.equal(row.archive.path, join(directory, row.sha256 + '.source'));
    assert.equal(row.archive.sha256, row.sha256); assert.equal(row.archive.bytes, row.bytes);
    sources.set(row.path, await verifiedBytes(row.archive, environmentRoot));
  }
  return sources;
}

/** Reconstruct the original instrumentation from retained bytes, without assuming
 * that a later controller reading history is the controller that executed it. */
export async function archivedCollectionInstrumentation(execution, sources) {
  const observations = [];
  for (const condition of Object.values(execution.conditions)) for (const ref of Object.values(condition.expectations)) {
    const projection = JSON.parse(await verifiedBytes(ref, execution.environment_root)).projection;
    observations.push(fingerprint({ subject_observer_files: projection.visibility.projection.files, pi_files: projection.pi.files,
      node: projection.node.sha256, bun: projection.bun.sha256, ...(projection.git ? { git: projection.git } : {}) }));
  }
  const seen = new Map();
  function visit(path) {
    if (seen.has(path)) return;
    const absolutePath = resolve(moduleRoot, path), name = relative(dirname(moduleRoot), absolutePath);
    assert.ok(inside(dirname(moduleRoot), absolutePath) && name, 'Archived collector dependency escapes its repository');
    const bytes = sources.get(path); assert.ok(Buffer.isBuffer(bytes), 'Archived collector dependency is missing: ' + path);
    seen.set(path, { path: name, sha256: sha(bytes), bytes: bytes.length });
    if (!path.endsWith('.mjs')) return;
    for (const match of bytes.toString('utf8').matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:(?:[^\n;]+?)\s+from\s+)?['\"](\.[^'\"]+)['\"]/g))
      visit(relative(moduleRoot, resolve(dirname(absolutePath), match[1])));
  }
  visit('collect.mjs');
  const files = [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { version: 1, runtime_sha256: [...new Set(observations)].sort(), collector_files: files, collector_sha256: fingerprint(files),
    scope: 'exact observer projection, maintained SDK modules and collector static dependency closure' };
}
async function partialCollection(root, environmentRoot) {
  const files = [];
  async function visit(directory) {
    let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await ordinaryDirectory(directory);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name); assert.ok(!entry.isSymbolicLink());
      if (entry.isDirectory()) await visit(path); else { assert.ok(entry.isFile()); files.push(await referenceAt(path, environmentRoot)); }
    }
  }
  await visit(join(root, 'benchmark/normalized')); return files;
}
async function rawRepair(plan, started, failed) {
  const e = plan.execution, root = join(e.environment_root, 'runs', started.run_id); await ordinaryDirectory(root);
  const runRef = await referenceAt(join(root, 'run.json'), root), sharedRef = await referenceAt(join(root, 'result.json'), root),
    runtimeRef = await referenceAt(join(root, 'benchmark/runtime/episode-result.json'), root);
  const run = JSON.parse(await verifiedBytes(runRef, root)), shared = JSON.parse(await verifiedBytes(sharedRef, root)), runtime = JSON.parse(await verifiedBytes(runtimeRef, root));
  assert.ok(Array.isArray(runtime.artifacts) && runtime.artifacts.length);
  assert.equal(new Set(runtime.artifacts.map(item => item.id)).size, runtime.artifacts.length, 'Raw artifact ids must be unique');
  const artifacts = [];
  for (const ref of runtime.artifacts) { assert.equal(ref.realpath, ref.path); await verifiedBytes(ref, root); artifacts.push({ id: ref.id, ...await referenceAt(ref.path, root), kind: ref.kind }); }
  const artifact = id => { const ref = artifacts.find(item => item.id === id); assert.ok(ref, 'Raw recovery artifact is missing: ' + id); return ref; };
  const readArtifact = async id => JSON.parse(await verifiedBytes(artifact(id), root));
  const candidate = e.conditions[started.condition_id], expectationRef = candidate.expectations[started.case_id];
  const expectation = JSON.parse(await verifiedBytes(expectationRef, e.environment_root));
  const comparison = await readArtifact('admission-comparison'); assert.deepEqual(comparison.differences, []); assert.ok(sameRef(comparison.expected_file, expectationRef));
  const payloads = [];
  for (const request of runtime.requests) {
    const ref = artifact(request.payload_ref?.artifact_id); assert.equal(ref.sha256, request.payload_ref.sha256);
    // Artifact SHA binds retained JSON bytes; payload_sha256 binds compact wire JSON.
    payloads.push(JSON.parse(await verifiedBytes(ref, root)));
  }
  const usage = validateCollectionRecoveryRaw({ plan, slot: started, run, shared, runtime, observed: await readArtifact('candidate-observed'), expectation, payloads });
  const reservations = [];
  for (const name of (await readdir(e.pilot_ledger_root)).filter(name => /^\d{3}\.json$/.test(name)).sort()) {
    const ref = await referenceAt(join(e.pilot_ledger_root, name), e.pilot_ledger_root), value = JSON.parse(await verifiedBytes(ref, e.pilot_ledger_root));
    if (value.run_id !== started.run_id) continue;
    assert.equal(value.experiment_id, plan.id); assert.equal(value.slot_id, started.slot_id); assert.equal(value.plan_sha256, plan.plan_sha256);
    assert.equal(value.scope_id, e.pilot_scope.id); assert.equal(value.scope_role, 'gate');
    assert.ok(sameRef(value.plan, await referenceAt(join(e.control_root, 'plan.json'), e.environment_root))); reservations.push(ref);
  }
  assert.equal(reservations.length, 1, 'Recovered execution needs exactly one existing shared reservation');
  return { run_id: started.run_id, slot_id: started.slot_id, episode_started_seq: started.seq, episode_unresolved_seq: failed.seq,
    original_error: failed.error, run: runRef, shared: sharedRef, runtime: runtimeRef, raw_artifacts: artifacts,
    original_partial_collection: await partialCollection(root, e.environment_root), reservation: reservations[0], budget_usage: usage };
}
function materialFingerprint(binding) {
  return fingerprint({ materialization_proof: binding.materialization_proof, skills_root: binding.skills_root, skill_inventory: binding.skill_inventory });
}

/** Read-only preparation; this never creates a registration, output, lease or model request. */
export async function preflightCollectionRecovery({ planFile, frozenController }) {
  absolute(planFile);
  const plan = validateBatchPlan(JSON.parse(await bytesAt(planFile))), e = plan.execution;
  const context = await planContext(plan, planFile), destination = fixedPath(plan), assetRoot = join(e.control_root, 'collection-repair-evidence');
  assert.equal(frozenController, context.frozenController, 'Before source must be the frozen subject build controller');
  await noFile(destination); await noActiveLease(plan);
  const ledgerPath = join(e.control_root, 'ledger.jsonl'), ledgerBytes = await bytesAt(ledgerPath, e.environment_root);
  const original = validateCollectionRecoveryLedger({ plan, bytes: ledgerBytes }); assert.equal(original.active, false);
  const implementation = await executionImplementation(), sourceChanges = collectionRecoverySourceChanges(e.implementation, implementation);
  assert.deepEqual(await instrumentationIdentity(e), e.instrumentation, 'Collection recovery cannot change runtime or collector instrumentation');
  for (const file of e.implementation.files) {
    const path = resolve(dirname(frozenController), file.path);
    assert.ok(inside(dirname(dirname(frozenController)), path)); await verifiedBytes({ ...file, path }, e.environment_root);
  }
  const repair = await rawRepair(plan, original.started, original.failed);
  return { plan, context, destination, assetRoot, ledgerPath, ledgerBytes, original, implementation, sourceChanges, repair };
}

/** Explicit one-time registration. It preserves original plan, failure, raw run and shared accounting. */
export async function createCollectionRecovery({ planFile, frozenController, reason }) {
  assert.ok(typeof reason === 'string' && reason.trim().length >= 10, 'Collection recovery needs an explicit reason');
  const { plan, context, destination, assetRoot, ledgerPath, ledgerBytes, original, implementation, sourceChanges, repair }
    = await preflightCollectionRecovery({ planFile, frozenController });
  const e = plan.execution;
  const beforeSources = await archiveSources(e.implementation, dirname(frozenController), join(assetRoot, 'source-before'), e.environment_root);
  const implementationSources = await archiveSources(implementation, moduleRoot, join(assetRoot, 'source-after'), e.environment_root);
  const materialBindings = [];
  for (const binding of context.bindings) {
    const result = await prepareMaterialOwnership({ binding, directory: join(assetRoot, 'materials', materialFingerprint(binding)), environmentRoot: e.environment_root });
    materialBindings.push({ case_id: binding.id, original_binding_sha256: fingerprint(binding), reference: result.reference });
  }
  const value = { version: 1, kind, created_at: new Date().toISOString(), reason, plan: context.planRef,
    ledger_prefix: { path: ledgerPath, sha256: sha(ledgerBytes), bytes: ledgerBytes.length, through_seq: original.rows.length },
    frozen_controller: await referenceAt(frozenController, e.environment_root), before_implementation: e.implementation,
    implementation, source_changes: sourceChanges, before_sources: beforeSources, implementation_sources: implementationSources,
    instrumentation: e.instrumentation, frozen_inputs: context.frozenInputs, repairs: [repair], material_bindings: materialBindings, registration_sha256: null };
  value.registration_sha256 = fingerprint(value);
  // Last preflight before the exclusive registration write; no ledger or model action occurs here.
  await noActiveLease(plan); assert.deepEqual(await bytesAt(ledgerPath, e.environment_root), ledgerBytes);
  assert.deepEqual((await planContext(plan)).frozenInputs, context.frozenInputs);
  assert.deepEqual(await rawRepair(plan, original.started, original.failed), repair);
  assert.deepEqual(await executionImplementation(), implementation);
  await noFile(destination); await ownedDirectories(e.environment_root, dirname(destination));
  const bytes = encode(value); await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  const reference = { path: destination, sha256: sha(bytes) };
  return { reference, recovery: await verifyCollectionRecovery({ reference, plan }) };
}

/** Read-only validation, also valid while the original batch holds its normal lease. */
export async function verifyCollectionRecovery({ reference, plan }) {
  descriptor(reference); assert.equal(reference.path, fixedPath(plan), 'Collection recovery must use the fixed explicit registration');
  const e = plan.execution, context = await planContext(plan), assetRoot = join(e.control_root, 'collection-repair-evidence');
  const value = JSON.parse(await verifiedBytes(reference, e.environment_root));
  assert.ok(Object.keys(value).every(key => registrationKeys.has(key)), 'Unknown collection recovery override');
  assert.equal(value.version, 1); assert.equal(value.kind, kind);
  assert.equal(value.registration_sha256, fingerprint({ ...value, registration_sha256: null }), 'Collection recovery registration changed');
  assert.deepEqual(value.plan, context.planRef); assert.deepEqual(value.before_implementation, e.implementation);
  assert.deepEqual(value.frozen_inputs, context.frozenInputs); assert.deepEqual(value.instrumentation, e.instrumentation);
  assert.equal(value.frozen_controller.path, context.frozenController);
  const beforeCli = value.before_implementation.files.find(file => file.path === 'cli.mjs');
  assert.equal(value.frozen_controller.sha256, beforeCli.sha256); assert.equal(value.frozen_controller.bytes, beforeCli.bytes);
  assert.deepEqual(collectionRecoverySourceChanges(value.before_implementation, value.implementation), value.source_changes);
  const beforeSources = await verifyArchives(value.before_implementation, value.before_sources, join(assetRoot, 'source-before'), e.environment_root);
  const afterSources = await verifyArchives(value.implementation, value.implementation_sources, join(assetRoot, 'source-after'), e.environment_root);
  assert.deepEqual(await archivedCollectionInstrumentation(e, beforeSources), e.instrumentation, 'Original archived collector instrumentation changed');
  assert.deepEqual(await archivedCollectionInstrumentation(e, afterSources), e.instrumentation, 'Recovery archived collector instrumentation changed');
  assert.equal(value.ledger_prefix.path, join(e.control_root, 'ledger.jsonl'));
  const ledger = validateCollectionRecoveryLedger({ plan, bytes: await bytesAt(value.ledger_prefix.path, e.environment_root),
    prefix: value.ledger_prefix, reference, repairs: value.repairs });
  assert.deepEqual(value.repairs, [await rawRepair(plan, ledger.started, ledger.failed)], 'Original failed raw execution or reservation changed');
  assert.equal(value.material_bindings.length, context.bindings.length);
  const projectedBindings = [];
  for (let i = 0; i < context.bindings.length; i++) {
    const binding = context.bindings[i], item = value.material_bindings[i];
    assert.equal(item.case_id, binding.id); assert.equal(item.original_binding_sha256, fingerprint(binding));
    assert.equal(item.reference.path, join(assetRoot, 'materials', materialFingerprint(binding), 'material-ownership.json'));
    const projected = await verifyMaterialOwnership({ binding, reference: item.reference, environmentRoot: e.environment_root });
    projectedBindings.push({ ...item, binding: projected.binding });
  }
  return { ...value, reference: { path: reference.path, sha256: reference.sha256 }, projectedBindings,
    original_recovered: ledger.original_recovered, zero_send_batch_closed: ledger.zero_send_batch_closed };
}

/** Result consumers must verify the same registration, even when a caller dropped its reference. */
export async function verifyCollectionRecoveryResults(plan, completed) {
  assert.ok(Array.isArray(completed)); const path = fixedPath(plan);
  // Legacy plans without a repair need no new ownership constraint. Existence
  // is checked first; an existing repair still receives the full strict guard.
  try { await lstat(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    assert.ok(completed.every(row => !row.result?.collection_recovery), 'Collection recovery result lost its registration'); return null;
  }
  const ref = await referenceAt(path, plan.execution.environment_root);
  const recovery = await verifyCollectionRecovery({ reference: { path: ref.path, sha256: ref.sha256 }, plan });
  const ledger = parseLedger(await bytesAt(join(plan.execution.control_root, 'ledger.jsonl'), plan.execution.environment_root));
  const actual = ledger.filter(row => row.type === 'episode_completed');
  assert.equal(completed.length, actual.length, 'Collection recovery consumer omitted completed results');
  const seen = new Set();
  for (const row of completed) {
    assert.ok(!seen.has(row.run_id)); seen.add(row.run_id);
    const original = actual.find(item => item.run_id === row.run_id);
    assert.ok(original && original.slot_id === row.slot_id, 'Collection recovery consumer changed result ownership');
    assert.deepEqual(row.result, original.result, 'Collection recovery consumer changed a retained result');
    assert.ok(sameRef(row.result?.collection_recovery, recovery.reference), 'Collection recovery result is missing the registration reference');
  }
  return recovery;
}
