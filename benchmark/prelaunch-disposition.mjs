import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, link, open, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fingerprint } from './protocol.mjs';
import { executionImplementation } from './implementation.mjs';
import { acquireCampaignLease } from './campaign-dispatch.mjs';
import { inspectStandingLedger, numericStandingNames, readStandingAmendment, readStandingAuthorization,
  standingReservationFields, standingSetupProjection, verifyControllerFiles } from './standing-campaign.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const ownSourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const canonical = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path;
const fields = (value, names) => assert.deepEqual(Object.keys(value).sort(), [...names].sort(), 'PRELAUNCH_RECORD_FIELDS');
const ref = (path, bytes) => ({ path, sha256: sha(bytes) });
export const PRELAUNCH_DISPOSITION_FILE = 'prelaunch-disposition.json';

// This compatibility is a reviewed control-flow claim, not an exception-text
// allowlist. The legacy producer omitted the stack in episode_unresolved.
// Its complete closure and these pre-dispatch boundaries must still be exact.
const legacyProducer = '1fa70d6aafe99891cf2a005a842257775bcbd7f98950f330b5635cc80fc20199';
const boundaryFiles = {
  'execute.mjs': '40c703195db0efd3c0814e61b3473569a02cf2e7053546932f34de0800f02a9c',
  'controller.mjs': '2ca8107a3addf624b53742e46a6d826949be3493ea93960845fea236d3bf1fdf',
  'batch.mjs': 'b172782bf916103998010dc869161eef36b005cf4cb8fdff90768846cc7dff9c',
  '../scripts/paired-resource-profile.mjs': 'a590edcebe0f6074f5f6c471c4c86d43d30aa27907f991fb0413c424c1af4ba4',
};

async function file(path) {
  assert.ok(canonical(path), 'PRELAUNCH_CANONICAL_FILE');
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'PRELAUNCH_ORDINARY_FILE');
  assert.equal(await realpath(path), path, 'PRELAUNCH_FILE_ALIAS');
  const bytes = await readFile(path);
  return { bytes, reference: ref(path, bytes) };
}
async function record(path) { const actual = await file(path); return { ...actual, value: JSON.parse(actual.bytes) }; }
async function verified(reference, json = true) {
  assert.ok(reference && canonical(reference.path)); assert.match(reference.sha256 ?? '', /^[a-f0-9]{64}$/);
  const actual = json ? await record(reference.path) : await file(reference.path);
  assert.equal(actual.reference.sha256, reference.sha256, 'PRELAUNCH_ORIGINAL_CHANGED: ' + reference.path);
  if (reference.bytes !== undefined) assert.equal(actual.bytes.length, reference.bytes, 'PRELAUNCH_ORIGINAL_SIZE_CHANGED');
  return actual;
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.fail('PRELAUNCH_EXECUTION_OR_LEASE_EXISTS: ' + path);
}
function dead(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'PRELAUNCH_OWNER_PID');
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  assert.fail('PRELAUNCH_OWNER_ALIVE');
}
function time(value) { assert.ok(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'PRELAUNCH_TIMESTAMP'); return Date.parse(value); }
async function producer(controller) {
  const implementation = controller?.implementation;
  const current = await executionImplementation();
  assert.ok(implementation?.sha256 === legacyProducer || implementation?.sha256 === current.sha256, 'PRELAUNCH_UNREVIEWED_PRODUCER');
  for (const [path, expected] of Object.entries(boundaryFiles))
    assert.equal(implementation.files.find(item => item.path === path)?.sha256, expected, 'PRELAUNCH_UNREVIEWED_BOUNDARY: ' + path);
  // Verify bytes before importing any retained producer.
  await verifyControllerFiles(controller);
  return import(pathToFileURL(join(controller.source_root, 'benchmark/standing-campaign.mjs')));
}

function failedPrefix(bytes, plan) {
  assert.ok(bytes.length && bytes.at(-1) === 10, 'PRELAUNCH_INCOMPLETE_LEDGER');
  const rows = bytes.toString().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(rows.map(row => row.type), ['batch_opened', 'episode_started', 'episode_unresolved', 'batch_closed'],
    'PRELAUNCH_REQUIRES_SINGLE_CLOSED_FAILURE');
  const [opened, started, failed, closed] = rows, slot = plan.slots[0];
  assert.ok(slot && slot.order === 0, 'PRELAUNCH_FIRST_SLOT_REQUIRED');
  for (const [index, row] of rows.entries()) {
    assert.equal(row.version, 1); assert.equal(row.seq, index + 1); time(row.at);
    assert.equal(row.clock_domain, 'batch-' + opened.lease_id);
    assert.match(row.monotonic_ns, /^[0-9]+$/);
    if (index) {
      assert.ok(time(row.at) >= time(rows[index - 1].at));
      assert.ok(BigInt(row.monotonic_ns) >= BigInt(rows[index - 1].monotonic_ns));
    }
  }
  assert.match(opened.lease_id, /^[a-f0-9-]{36}$/); assert.equal(opened.plan_sha256, plan.plan_sha256);
  for (const event of [started, failed]) {
    for (const [key, expected] of Object.entries(slot)) assert.deepEqual(event[key], expected, 'PRELAUNCH_SLOT_CHANGED');
    assert.equal(event.run_id, plan.id + '-001'); assert.equal(event.result, undefined);
  }
  const condition = plan.protocol.conditions.find(item => item.id === slot.condition_id);
  assert.ok(condition); assert.equal(started.budget_id, condition.budget_id);
  assert.equal(closed.reason, 'unresolved_execution_error'); assert.equal(closed.new_episodes, 1);
  fields(failed.error, ['name', 'message']); assert.equal(failed.error.name, 'AssertionError');
  const match = failed.error.message.match(/^RESOURCE_PROFILE_FILE_CHANGED: ([^\n]+)\n\+ actual - expected\n\n\+ '([a-f0-9]{64})'\n- '([a-f0-9]{64})'\n$/);
  assert.ok(match && canonical(match[1]) && match[2] !== match[3], 'PRELAUNCH_UNREVIEWED_FAILURE');
  return { rows, opened, started, failed, closed, slot, mismatch: { path: match[1], actual_sha256: match[2], expected_sha256: match[3] } };
}

/** Re-derive evidence without inspecting the disposition itself or recursing
 * through the ledger reader. Both publication and every later reservation use
 * this same verifier. The mutable executable is not reread as historical fact. */
async function derive({ controlRoot, request }, { ownerAlreadyClosed = false } = {}) {
  assert.ok(canonical(controlRoot)); assert.equal(await realpath(controlRoot), controlRoot);
  const input = await record(request), value = input.value;
  fields(value, ['version', 'kind', 'reviewed_at', 'reason', 'plan', 'runner_claim', 'runner_receipt', 'invocation_started', 'invocation_result', 'review']);
  assert.equal(value.version, 1); assert.equal(value.kind, 'benchmark-profile-prelaunch-disposition-request');
  time(value.reviewed_at); assert.ok(typeof value.reason === 'string' && value.reason.trim(), 'PRELAUNCH_REVIEW_REASON');
  assert.equal(value.plan.path, join(controlRoot, 'plan.json'));
  const originals = {}, keep = (name, actual) => { originals[name] = actual.reference; return actual.value; };
  const plan = keep('plan', await verified(value.plan));
  assert.equal(plan.kind, 'benchmark-batch-plan'); assert.equal(plan.version, 1);
  assert.equal(plan.plan_sha256, fingerprint({ ...plan, plan_sha256: null }), 'PRELAUNCH_PLAN_CHANGED');
  assert.equal(plan.execution.control_root, controlRoot);
  assert.equal(plan.execution.standing_scope?.kind, 'benchmark-standing-campaign');
  assert.equal(plan.execution.resumption, undefined);
  const environmentRoot = plan.execution.environment_root;
  assert.ok(canonical(environmentRoot) && controlRoot.startsWith(environmentRoot + '/control/'));
  assert.equal(await realpath(environmentRoot), environmentRoot);
  for (const key of ['runner_claim', 'runner_receipt', 'invocation_started', 'invocation_result', 'review'])
    assert.ok(value[key].path.startsWith(environmentRoot + '/control/'), 'PRELAUNCH_REVIEW_NOT_OWNED');
  const amendment = await readStandingAmendment(plan.execution.standing_scope.amendment);
  originals.amendment = plan.execution.standing_scope.amendment;
  const setup = keep('setup', await verified(amendment.setup));
  const workPlan = keep('work_plan', await verified(amendment.work_plan));
  const originalReader = await producer(workPlan.controller);
  const context = await originalReader.readStandingWorkPlan({ authorization: amendment.authorization, workPlan: amendment.work_plan });
  await readStandingAuthorization(amendment.authorization);
  originals.authorization = amendment.authorization; originals.baseline = amendment.baseline;
  assert.deepEqual(plan.execution.implementation, workPlan.controller.implementation);
  assert.deepEqual(amendment.condition_epoch, workPlan.condition_epoch);
  assert.deepEqual(amendment.baseline, workPlan.baseline); assert.equal(amendment.id, plan.id);
  assert.equal(amendment.environment_root, environmentRoot); assert.equal(workPlan.environment_root, environmentRoot);
  assert.equal(amendment.control_root, controlRoot); assert.equal(amendment.pilot_ledger_root, plan.execution.pilot_ledger_root);
  assert.equal(setup.id, plan.id); assert.equal(setup.control_root, controlRoot);
  assert.deepEqual(setup.standing, { authorization: amendment.authorization, work_plan: amendment.work_plan,
    work_item_id: amendment.work_item_id, attempt_id: plan.id, ledger_root: amendment.pilot_ledger_root });
  const item = context.items.find(entry => entry.id === amendment.work_item_id); assert.ok(item);
  const template = keep('template', await verified(item.setup));
  assert.deepEqual(standingSetupProjection(setup), standingSetupProjection(template));
  assert.deepEqual(amendment.slots, plan.slots); assert.equal(item.planned_episodes, plan.slots.length);
  assert.equal(amendment.protocol_sha256, plan.protocol.protocol_sha256);
  const { standing_scope, ...execution } = plan.execution;
  assert.equal(fingerprint(execution), amendment.execution_sha256);

  const ledger = await file(join(controlRoot, 'ledger.jsonl')); originals.ledger = ledger.reference;
  const prefix = failedPrefix(ledger.bytes, plan), { opened, started, closed, slot, mismatch } = prefix;
  const candidate = plan.execution.conditions[slot.condition_id]; assert.ok(candidate && candidate.mode === 'broker');
  const profile = keep('resource_profile', await verified(candidate.resource_profile));
  assert.equal(profile.schema_version, 1); assert.equal(profile.kind, 'benchmark-ordinary-derived-resources');
  const commands = profile.mcp_command_refs?.filter(entry => entry.path === mismatch.path) ?? [];
  assert.equal(commands.length, 1, 'PRELAUNCH_MISMATCH_NOT_DECLARED_COMMAND');
  assert.equal(commands[0].sha256, mismatch.expected_sha256, 'PRELAUNCH_EXPECTED_COMMAND_CHANGED');
  for (const key of ['case_bindings', 'models']) {
    const pathKey = key + '_file', shaKey = key + '_sha256';
    keep(key, await verified({ path: execution[pathKey], sha256: execution[shaKey] }));
  }
  keep('expectation', await verified(candidate.expectations[slot.slot_id] ?? candidate.expectations[slot.case_id]));
  const buildRoot = join(environmentRoot, 'builds', candidate.build_id);
  const condition = plan.protocol.conditions.find(entry => entry.id === slot.condition_id);
  const environmentCondition = plan.protocol.environments?.find(entry => entry.id === condition.environment_id);
  assert.ok(environmentCondition && environmentCondition.build.id === candidate.build_id, 'PRELAUNCH_FROZEN_BUILD_REQUIRED');
  const build = keep('build', await verified({ path: join(buildRoot, 'build.json'), sha256: environmentCondition.build.receipt_sha256 }));
  assert.equal(build.kind, 'paired-build'); assert.equal(build.build_id, candidate.build_id); assert.equal(build.root, buildRoot);
  const environment = keep('environment', await record(join(environmentRoot, 'environment.json')));
  assert.equal(environment.kind, 'paired-development-environment'); assert.equal(environment.root, environmentRoot);
  assert.equal(build.environment_id, environment.environment_id);

  const ledgerRoot = amendment.pilot_ledger_root, names = await readdir(ledgerRoot);
  assert.equal(await realpath(ledgerRoot), ledgerRoot);
  const header = keep('ledger_baseline', await record(join(ledgerRoot, 'ledger-baseline.json')));
  assert.deepEqual(header.authorization, amendment.authorization); assert.deepEqual(header.baseline, amendment.baseline);
  const registrations = [];
  for (const { name } of numericStandingNames(names, 'registration')) registrations.push(await record(join(ledgerRoot, name)));
  const own = registrations.filter(entry => entry.value.id === plan.id);
  assert.equal(own.length, 1, 'PRELAUNCH_REGISTRATION_REQUIRED');
  originals.registration = own[0].reference;
  assert.deepEqual(own[0].value.plan, value.plan); assert.deepEqual(own[0].value.amendment, plan.execution.standing_scope.amendment);
  const reservations = [];
  for (const { name, ordinal } of numericStandingNames(names)) {
    const entry = await record(join(ledgerRoot, name));
    if (entry.value.scope_id === plan.id || entry.value.experiment_id === plan.id || entry.value.run_id === started.run_id)
      reservations.push({ ...entry, ordinal });
  }
  assert.equal(reservations.length, 1, 'PRELAUNCH_RESERVATION_COUNT');
  const reservation = reservations[0]; originals.reservation = reservation.reference;
  assert.equal(reservation.value.run_id, started.run_id); assert.equal(reservation.value.experiment_id, plan.id);
  assert.equal(reservation.value.slot_id, slot.slot_id);
  for (const [key, expected] of Object.entries(standingReservationFields(plan, amendment, value.plan)))
    assert.deepEqual(reservation.value[key], expected, 'PRELAUNCH_RESERVATION_CHANGED');

  const retained = keep('retained_lease', await record(join(controlRoot, 'lease-retained-' + opened.lease_id + '.json')));
  const completed = keep('completed_lease', await record(join(controlRoot, 'lease-completed-' + opened.lease_id + '.json')));
  fields(retained, ['id', 'pid', 'started_at', 'plan_sha256']);
  assert.equal(retained.id, opened.lease_id); assert.equal(retained.plan_sha256, plan.plan_sha256);
  assert.ok(time(retained.started_at) <= time(opened.at), 'PRELAUNCH_LEASE_START_ORDER');
  assert.deepEqual(completed, { ...retained, completed_at: completed.completed_at, reason: closed.reason });
  assert.ok(time(completed.completed_at) >= time(closed.at));
  // A published, fully reverified terminal record already bound the original
  // owner's exit. A later process with the same numeric PID is not that owner.
  if (!ownerAlreadyClosed) dead(retained.pid);
  const claim = keep('runner_claim', await verified(value.runner_claim));
  const receipt = keep('runner_receipt', await verified(value.runner_receipt));
  const runnerRoot = dirname(value.runner_claim.path);
  assert.equal(value.runner_claim.path, join(runnerRoot, 'claim.json'));
  assert.equal(value.runner_receipt.path, join(runnerRoot, 'receipt.json'));
  for (const document of [claim, receipt]) {
    assert.equal(document.version, 1); assert.deepEqual(document.plan, value.plan);
    assert.deepEqual(document.authorization, amendment.authorization); assert.deepEqual(document.work_plan, amendment.work_plan);
    assert.equal(document.work_item_id, amendment.work_item_id); assert.equal(document.attempt_id, plan.id);
    assert.deepEqual(document.resource_policy, { mode: 'unbounded' }); assert.equal(document.supervised_recovery_authorized, true);
  }
  assert.equal(claim.kind, 'standing-campaign-runner-claim'); assert.equal(claim.pid, retained.pid);
  assert.ok(Number.isSafeInteger(claim.checkpoint_interval) && claim.checkpoint_interval > 0);
  assert.ok(time(claim.started_at) <= time(opened.at));
  assert.equal(receipt.kind, 'standing-campaign-runner-receipt'); assert.equal(receipt.status, 'stopped'); assert.equal(receipt.checkpoints, 1);
  assert.deepEqual(receipt.ledger, ledger.reference, 'PRELAUNCH_LEDGER_RECEIPT_CHANGED'); assert.ok(time(receipt.completed_at) >= time(completed.completed_at));
  assert.deepEqual(receipt.result, { invocation: 1, phase: 'after_dispatch',
    requested_limit: Math.min(claim.checkpoint_interval, plan.slots.length), completed_prefix: 0, completed_run_ids: [], new_completed: 0,
    started: 1, completed: 0, remaining: plan.slots.length, checkpoint_required: true, analyze_prefix: false,
    action: 'stop', reason: 'unresolved_execution' });
  const checkpoint = keep('checkpoint', await record(join(runnerRoot, 'checkpoint-001.json')));
  assert.equal(checkpoint.kind, 'standing-campaign-prefix-checkpoint'); assert.equal(checkpoint.version, 1);
  const { version, kind, recorded_at, plan: checkpointPlan, ledger: checkpointLedger, ...progress } = checkpoint;
  assert.deepEqual(progress, receipt.result); assert.deepEqual(checkpointPlan, value.plan); assert.deepEqual(checkpointLedger, ledger.reference);
  assert.ok(time(recorded_at) >= time(closed.at) && time(recorded_at) <= time(receipt.completed_at));
  const invocation = keep('invocation_started', await verified(value.invocation_started));
  const result = keep('invocation_result', await verified(value.invocation_result));
  assert.equal(invocation.pid, retained.pid); assert.deepEqual(invocation.plan, value.plan);
  assert.equal(invocation.node, execution.runtime.node);
  assert.deepEqual(invocation.args, [join(workPlan.controller.source_root, 'benchmark/cli.mjs'), 'run-standing',
    '--plan', value.plan.path, '--out', runnerRoot, '--slice', String(claim.checkpoint_interval)]);
  assert.ok(time(invocation.at_utc) <= time(claim.started_at));
  assert.equal(result.code, 1); assert.equal(result.signal, null);
  assert.ok(time(result.at_utc) >= time(receipt.completed_at) && time(value.reviewed_at) >= time(result.at_utc));
  const stdout = await verified(result.stdout), stderr = await verified(result.stderr, false);
  originals.stdout = stdout.reference; originals.stderr = stderr.reference;
  assert.deepEqual(stdout.value, receipt); assert.equal(stderr.bytes.length, 0, 'PRELAUNCH_UNEXPECTED_STDERR');
  const review = keep('review', await verified(value.review));
  assert.equal(review.version, 1); assert.equal(review.run_id, started.run_id);
  assert.equal(review.status, 'blocked_before_subject_launch', 'PRELAUNCH_REVIEW_REQUIRED');

  const absentPaths = [join(controlRoot, 'lease.json'), join(environmentRoot, 'runs', started.run_id),
    join(controlRoot, started.run_id + '.launch.json'), join(controlRoot, 'turn-control', started.run_id)];
  for (const path of absentPaths) await absent(path);
  return { version: 1, kind: 'benchmark-profile-prelaunch-disposition', request: input.reference,
    reviewed_at: value.reviewed_at, reason: value.reason, status: 'supervised_prelaunch_terminal',
    scope_id: plan.id, run_id: started.run_id, plan_sha256: plan.plan_sha256, reservation_ordinal: reservation.ordinal,
    producer: workPlan.controller, compatibility: 'reviewed-profile-command-identity-prelaunch-v1',
    originals, mismatch, absent_paths: absentPaths,
    accounting: { reservation_retained: true, ledger_changed: false, business_completed: false,
      runtime_usage_status: 'unobserved', model_requests: null, input_tokens: null, output_tokens: null, duration_ms: null },
  };
}

/** Public read-only preflight. It neither acquires a lease nor publishes data. */
export async function verifyProfilePrelaunchDispositionRequest({ controlRoot, request }) {
  const { draft } = await publicationInput({ controlRoot, request });
  const plan = (await verified(draft.originals.plan)).value;
  await absent(join(plan.execution.pilot_ledger_root, 'campaign.lease.json'));
  return draft;
}

export async function verifyProfilePrelaunchDisposition({ reference, predecessor, successor }) {
  const actual = await verified(reference), value = actual.value;
  assert.equal(reference.path, join(predecessor.execution.control_root, PRELAUNCH_DISPOSITION_FILE));
  const { writer, ...recorded } = value;
  assert.ok(writer?.implementation?.files.some(item => item.path === 'prelaunch-disposition.mjs'), 'PRELAUNCH_RETAINED_VERIFIER_REQUIRED');
  // Historical terminal records use the verifier that actually published them.
  // Verify its complete retained closure before importing any of its code.
  await verifyControllerFiles(writer);
  if (writer.source_root !== ownSourceRoot) {
    const retained = await import(pathToFileURL(join(writer.source_root, 'benchmark/prelaunch-disposition.mjs')));
    return retained.verifyProfilePrelaunchDisposition({ reference, predecessor, successor });
  }
  const fresh = await derive({ controlRoot: predecessor.execution.control_root, request: value.request.path }, { ownerAlreadyClosed: true });
  assert.deepEqual(recorded, fresh, 'PRELAUNCH_DISPOSITION_ORIGINALS_CHANGED');
  assert.deepEqual(value.originals.plan, (await record(join(predecessor.execution.control_root, 'plan.json'))).reference);
  assert.equal(value.plan_sha256, predecessor.plan_sha256);
  if (successor) {
    const previous = await readStandingAmendment(predecessor.execution.standing_scope.amendment);
    const next = await readStandingAmendment(successor.execution.standing_scope.amendment);
    assert.notEqual(successor.id, predecessor.id, 'PRELAUNCH_NEW_ATTEMPT_REQUIRED');
    assert.notDeepEqual(next.work_plan, previous.work_plan, 'PRELAUNCH_NEW_WORK_PLAN_REQUIRED');
    assert.notEqual(next.condition_epoch.id, previous.condition_epoch.id, 'PRELAUNCH_NEW_EPOCH_REQUIRED');
    const oldProfile = value.originals.resource_profile, candidates = Object.values(successor.execution.conditions ?? {});
    assert.ok(candidates.length > 0, 'PRELAUNCH_REPAIRED_PROFILE_REQUIRED');
    for (const candidate of candidates) {
      assert.ok(candidate.resource_profile, 'PRELAUNCH_REPAIRED_PROFILE_REQUIRED');
      assert.notEqual(candidate.resource_profile.sha256, oldProfile.sha256, 'PRELAUNCH_REPAIRED_PROFILE_REQUIRED');
      const expectations = Object.values(candidate.expectations ?? {});
      assert.ok(expectations.length > 0, 'PRELAUNCH_FRESH_CAPTURE_REQUIRED');
      for (const expectation of expectations)
        assert.notEqual(expectation.sha256, value.originals.expectation.sha256, 'PRELAUNCH_FRESH_CAPTURE_REQUIRED');
    }
  }
  return { value, reference: actual.reference };
}

export async function readProfilePrelaunchDisposition({ predecessor, successor }) {
  const path = join(predecessor.execution.control_root, PRELAUNCH_DISPOSITION_FILE);
  const actual = await record(path);
  return verifyProfilePrelaunchDisposition({ reference: actual.reference, predecessor, successor });
}

async function publicationInput({ controlRoot, request }) {
  const output = join(controlRoot, PRELAUNCH_DISPOSITION_FILE);
  let actual;
  try { actual = await record(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!actual) return { draft: await derive({ controlRoot, request }), existing: null };
  const requested = await record(request), plan = (await verified(requested.value.plan)).value;
  assert.equal(plan.execution.control_root, controlRoot, 'PRELAUNCH_PLAN_ROOT_CHANGED');
  const existing = await verifyProfilePrelaunchDisposition({ reference: actual.reference, predecessor: plan });
  assert.deepEqual(existing.value.request, requested.reference, 'PRELAUNCH_CONFLICTING_REQUEST');
  const { writer, ...draft } = existing.value;
  return { draft, existing };
}

/** Publish one immutable sidecar under the existing campaign lease. A pending
 * file is private, content-bound progress; only its exact prefix may be resumed.
 * Hard-link publication is atomic and never replaces an existing sidecar. */
export async function disposeProfilePrelaunchFailure({ controlRoot, request, onProgress = async () => {} }) {
  const { draft: initial } = await publicationInput({ controlRoot, request });
  const plan = (await verified(initial.originals.plan)).value;
  const amendment = await readStandingAmendment(plan.execution.standing_scope.amendment);
  const release = await acquireCampaignLease(plan, amendment);
  try {
    const { draft, existing } = await publicationInput({ controlRoot, request });
    assert.deepEqual(draft, initial, 'PRELAUNCH_INPUT_CHANGED_DURING_LEASE');
    const boundary = await inspectStandingLedger({ ledgerRoot: amendment.pilot_ledger_root, baseline: amendment.baseline });
    const output = join(controlRoot, PRELAUNCH_DISPOSITION_FILE);
    if (existing)
      return { status: 'prelaunch_disposition_recorded', disposition: existing.reference, execution_performed: false, model_requests: 0 };
    assert.equal(boundary.registrations.at(-1)?.value.id, plan.id, 'PRELAUNCH_PREDECESSOR_NOT_LATEST');
    const writer = { source_root: ownSourceRoot, implementation: await executionImplementation() };
    const value = { ...draft, writer }, bytes = encode(value);
    const pendingName = 'prelaunch-disposition-' + draft.request.sha256 + '.pending.json', pending = join(controlRoot, pendingName);
    const pendingNames = (await readdir(controlRoot)).filter(name => /^prelaunch-disposition-.*\.pending\.json$/.test(name));
    assert.ok(pendingNames.every(name => name === pendingName), 'PRELAUNCH_CONFLICTING_PENDING_REQUEST');
    let handle;
    try { handle = await open(pending, 'wx', 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (handle) {
      try {
        const midpoint = Math.floor(bytes.length / 2);
        await handle.writeFile(bytes.subarray(0, midpoint)); await handle.sync();
        await onProgress({ phase: 'pending_prefix', path: pending });
        await handle.writeFile(bytes.subarray(midpoint)); await handle.sync();
      } finally { await handle.close(); }
    } else {
      const partial = await file(pending);
      assert.ok(partial.bytes.length <= bytes.length && partial.bytes.equals(bytes.subarray(0, partial.bytes.length)),
        'PRELAUNCH_PENDING_CONFLICT');
      const append = await open(pending, 'a');
      try { await append.writeFile(bytes.subarray(partial.bytes.length)); await append.sync(); }
      finally { await append.close(); }
    }
    await onProgress({ phase: 'pending_complete', path: pending });
    assert.deepEqual(await derive({ controlRoot, request }), draft, 'PRELAUNCH_INPUT_CHANGED_BEFORE_PUBLICATION');
    assert.equal((await file(pending)).reference.sha256, sha(bytes), 'PRELAUNCH_PENDING_CHANGED');
    try { await link(pending, output); }
    catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal((await file(output)).reference.sha256, sha(bytes), 'PRELAUNCH_CONFLICTING_DISPOSITION'); }
    await onProgress({ phase: 'published', path: output });
    const verifiedOutput = await verifyProfilePrelaunchDisposition({ reference: ref(output, bytes), predecessor: plan });
    return { status: 'prelaunch_disposition_recorded', disposition: verifiedOutput.reference, execution_performed: false, model_requests: 0 };
  } finally { await release(); }
}

