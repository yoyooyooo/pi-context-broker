import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from './protocol.mjs';
import { executionImplementation } from './implementation.mjs';
import { acquireCampaignLease } from './campaign-dispatch.mjs';
import { assertStandingSetup, prepareStandingScope, standingCampaignPolicy, verifyStandingPlan,
  reserveStandingEpisode, inspectStandingLedger, reconcileStandingLease } from './standing-campaign.mjs';
import { disposeProfilePrelaunchFailure, verifyProfilePrelaunchDispositionRequest,
  verifyProfilePrelaunchDisposition, PRELAUNCH_DISPOSITION_FILE } from './prelaunch-disposition.mjs';
import { benchmarkMain, parseBenchmarkArgs } from './cli.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const encode = value => JSON.stringify(value, null, 2) + '\n';
const ledgerBytes = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const stamp = n => '2000-01-01T00:00:' + String(n).padStart(2, '0') + '.000Z';
async function write(path, value) {
  const bytes = encode(value); await writeFile(path, bytes, { flag: 'wx' }); return { path, sha256: sha(bytes) };
}
async function child(script, args = []) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    process.stdout.on('data', bytes => { output += bytes; }); process.stderr.on('data', bytes => { output += bytes; });
    process.on('error', reject); process.on('exit', (code, signal) => resolve({ pid: process.pid, code, signal, output }));
  });
}
const grant = () => ({ version: 1, kind: 'user-standing-benchmark-authorization', id: 'fixture-authority',
  approved: true, source: 'current-user-message', user_message: 'Continue this task and related repairs.',
  recorded_at_utc: stamp(0), task: 'Notion Skills Benchmark', authorization_expiry: null,
  per_batch_approval_required: false, resource_policy: { mode: 'unbounded' }, supervised_recovery_authorized: true });

async function fixture(t) {
  const environmentRoot = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-prelaunch-test-')));
  t.after(() => t.diagnostic('Retained task-owned fixtures (no permanent deletion): ' + environmentRoot));
  const control = join(environmentRoot, 'control'); await mkdir(control);
  const ledgerRoot = join(control, 'standing-ledger');
  const authorization = await write(join(control, 'grant.json'), grant());
  const historicalAuthorization = await write(join(control, 'history-authorization.json'), { retained: true });
  const baseline = await write(join(control, 'baseline.json'), {
    version: 1, kind: 'benchmark-standing-history-baseline', id: 'baseline',
    environment_root: environmentRoot, ledger_root: join(control, 'history-ledger'), historical_authorization: historicalAuthorization,
    controller: { source_root: '/retained-fixture', implementation: {} }, observations: 249, registrations: 0, registration_refs: [],
    history: { scheduled_episodes: 249, reservations: Array(249).fill({ retained: true }), episodes: Array(249).fill({ retained: true }) },
    published_evidence: [], verified_at: stamp(0),
  });
  await write(join(environmentRoot, 'environment.json'), { kind: 'paired-development-environment', root: environmentRoot, environment_id: 'fixture' });
  const implementation = await executionImplementation();
  async function attempt(id, epochId = id) {
    const controlRoot = join(control, id); await mkdir(controlRoot);
    const buildId = 'build-' + id, buildRoot = join(environmentRoot, 'builds', buildId); await mkdir(buildRoot, { recursive: true });
    const buildReference = await write(join(buildRoot, 'build.json'), { version: 1, kind: 'paired-build', root: buildRoot, build_id: buildId, environment_id: 'fixture' });
    const command = join(controlRoot, 'command.bin'); await writeFile(command, 'original executable\n', { flag: 'wx' });
    const commandReference = { path: command, sha256: sha(await readFile(command)), bytes: (await readFile(command)).length };
    const resourceProfile = await write(join(controlRoot, 'profile.json'), { schema_version: 1, kind: 'benchmark-ordinary-derived-resources',
      owner_root: environmentRoot, mcp_command_refs: [{ server: 'fixture', ...commandReference }] });
    const expectation = await write(join(controlRoot, 'expectation.json'), { build_id: buildId, fixture: id });
    const cases = await write(join(controlRoot, 'cases.json'), [{ id: 'case' }]), models = await write(join(controlRoot, 'models.json'), [{ id: 'model' }]);
    const epoch = { id: epochId, started_at: stamp(0), authorization };
    const template = { version: 1, id: id + '-template', environment_root: environmentRoot, control_root: join(controlRoot, 'template'),
      budget: { id: 'unbounded', mode: 'unbounded',
        episode: { max_duration_ms: null, max_model_requests: null, max_input_tokens: null, max_output_tokens: null, max_http_attempts: null, max_retries: null },
        batch: { max_duration_ms: null, max_model_requests: null, max_input_tokens: null, max_output_tokens: null, max_episodes: null, max_concurrency: 1 },
        monetary: { policy: 'unpriced', max_amount: null } }, models: { window: { mode: 'standing', start: epoch.started_at, end: null } } };
    const templateReference = await write(join(controlRoot, 'template.json'), template);
    const workPlan = await write(join(controlRoot, 'work-plan.json'), {
      version: 1, kind: 'benchmark-standing-work-plan', id: id + '-work', task: 'Notion Skills Benchmark',
      environment_root: environmentRoot, authorization, resource_policy: { mode: 'unbounded' }, condition_epoch: epoch,
      controller: { source_root: sourceRoot, implementation }, baseline,
      entries: [{ id: 'case-design', setup: templateReference, planned_episodes: 1 }], created_at: stamp(0),
    });
    const setup = { ...template, id, control_root: controlRoot, standing: {
      authorization, work_plan: workPlan, work_item_id: 'case-design', attempt_id: id, ledger_root: ledgerRoot,
    } };
    await write(join(controlRoot, 'setup.json'), setup);
    const context = await assertStandingSetup(setup);
    const slots = [{ order: 0, slot_id: 'condition--case--r0', assessment_id: 'condition--case--r0', case_id: 'case', condition_id: 'condition', repeat: 0, seed: 7 }];
    const protocol = { id, conditions: [{ id: 'condition', environment_id: 'environment', model_id: 'model', budget_id: 'unbounded' }],
      environments: [{ id: 'environment', build: { id: buildId, receipt_sha256: buildReference.sha256 } }],
      policies: { campaign: standingCampaignPolicy(context, { scheduledEpisodes: 1 }) }, protocol_sha256: 'a'.repeat(64) };
    const execution = { environment_root: environmentRoot, control_root: controlRoot, pilot_ledger_root: ledgerRoot, implementation,
      runtime: { node: process.execPath },
      conditions: { condition: { build_id: buildId, mode: 'broker', resource_profile: resourceProfile, expectations: { case: expectation } } },
      case_bindings_file: cases.path, case_bindings_sha256: cases.sha256, models_file: models.path, models_sha256: models.sha256 };
    const scope = await prepareStandingScope({ setup, protocol, execution, slots }); execution[scope.field] = scope.registration;
    const plan = { version: 1, kind: 'benchmark-batch-plan', id, protocol, execution, slots, plan_sha256: null };
    plan.plan_sha256 = fingerprint(plan); const planReference = await write(join(controlRoot, 'plan.json'), plan);
    const amendment = await verifyStandingPlan(plan);
    return { plan, planReference, amendment, controlRoot, resourceProfile, commandReference, expectation, workPlan, epoch };
  }
  const old = await attempt('failed-attempt');
  const release = await acquireCampaignLease(old.plan, old.amendment);
  await verifyStandingPlan(old.plan, { activate: true });
  const runId = old.plan.id + '-001';
  const reservation = await reserveStandingEpisode({ plan: old.plan, amendment: old.amendment,
    slot: old.plan.slots[0], runId, planReference: old.planReference });
  await release();
  assert.equal(reservation.ordinal, 250);
  const deadProcess = await child(''); assert.equal(deadProcess.code, 0);
  const pid = deadProcess.pid, leaseId = randomUUID(), actualSha = sha('updated executable\n');
  let error;
  try { assert.equal(actualSha, old.commandReference.sha256, 'RESOURCE_PROFILE_FILE_CHANGED: ' + old.commandReference.path); }
  catch (failure) { error = { name: failure.name, message: failure.message }; }
  const rows = [
    { type: 'batch_opened', plan_sha256: old.plan.plan_sha256, lease_id: leaseId },
    { type: 'episode_started', ...old.plan.slots[0], run_id: runId, budget_id: 'unbounded' },
    { type: 'episode_unresolved', ...old.plan.slots[0], run_id: runId, error },
    { type: 'batch_closed', reason: 'unresolved_execution_error', new_episodes: 1 },
  ].map((row, index) => ({ version: 1, seq: index + 1, at: stamp(index + 2), monotonic_ns: String(index + 1), clock_domain: 'batch-' + leaseId, ...row }));
  const ledgerPath = join(old.controlRoot, 'ledger.jsonl'), originalLedger = ledgerBytes(rows);
  await writeFile(ledgerPath, originalLedger, { flag: 'wx' }); const ledgerReference = { path: ledgerPath, sha256: sha(originalLedger) };
  const lease = { id: leaseId, pid, started_at: rows[0].at, plan_sha256: old.plan.plan_sha256 };
  await write(join(old.controlRoot, 'lease-retained-' + leaseId + '.json'), lease);
  await write(join(old.controlRoot, 'lease-completed-' + leaseId + '.json'), { ...lease, completed_at: stamp(6), reason: rows.at(-1).reason });
  const runnerRoot = join(old.controlRoot, 'runner'); await mkdir(runnerRoot);
  const shared = { version: 1, plan: old.planReference, authorization, work_plan: old.workPlan, work_item_id: 'case-design',
    attempt_id: old.plan.id, resource_policy: { mode: 'unbounded' }, supervised_recovery_authorized: true };
  const runnerClaim = await write(join(runnerRoot, 'claim.json'), { ...shared, kind: 'standing-campaign-runner-claim',
    pid, started_at: stamp(1), checkpoint_interval: 1 });
  const result = { invocation: 1, phase: 'after_dispatch', requested_limit: 1, completed_prefix: 0, completed_run_ids: [], new_completed: 0,
    started: 1, completed: 0, remaining: 1, checkpoint_required: true, analyze_prefix: false, action: 'stop', reason: 'unresolved_execution' };
  await write(join(runnerRoot, 'checkpoint-001.json'), { version: 1, kind: 'standing-campaign-prefix-checkpoint', recorded_at: stamp(6),
    ...result, plan: old.planReference, ledger: ledgerReference });
  const receipt = { ...shared, kind: 'standing-campaign-runner-receipt', status: 'stopped', completed_at: stamp(7),
    checkpoints: 1, result, ledger: ledgerReference };
  const runnerReceipt = await write(join(runnerRoot, 'receipt.json'), receipt);
  const stdout = await write(join(old.controlRoot, 'stdout.json'), receipt), stderrPath = join(old.controlRoot, 'stderr.log');
  await writeFile(stderrPath, '', { flag: 'wx' });
  const invocationStarted = await write(join(old.controlRoot, 'started.json'), { at_utc: stamp(0), pid, node: process.execPath,
    args: [join(sourceRoot, 'benchmark/cli.mjs'), 'run-standing', '--plan', old.planReference.path, '--out', runnerRoot, '--slice', '1'], plan: old.planReference });
  const invocationResult = await write(join(old.controlRoot, 'exit.json'), { at_utc: stamp(8), code: 1, signal: null,
    stdout, stderr: { path: stderrPath, sha256: sha('') } });
  const review = await write(join(old.controlRoot, 'review.json'), { version: 1, kind: 'independent-fixture-review',
    run_id: runId, status: 'blocked_before_subject_launch' });
  const requestValue = { version: 1, kind: 'benchmark-profile-prelaunch-disposition-request', reviewed_at: stamp(9),
    reason: 'Retain the prelaunch executable identity failure and use a new immutable profile.', plan: old.planReference,
    runner_claim: runnerClaim, runner_receipt: runnerReceipt, invocation_started: invocationStarted, invocation_result: invocationResult, review };
  const request = (await write(join(old.controlRoot, 'request.json'), requestValue)).path;
  return { environmentRoot, control, ledgerRoot, baseline, old, attempt, runId, rows, originalLedger, ledgerPath, leaseId,
    request, requestValue, args: { controlRoot: old.controlRoot, request } };
}

// Keep the reference chain valid so a forged producer reaches its boundary
// check instead of failing on a stale request, plan or work-plan file hash.
async function rebindProducer(f, implementation) {
  const replace = async (path, value) => {
    const bytes = encode(value); await writeFile(path, bytes); return { path, sha256: sha(bytes) };
  };
  const workPlan = JSON.parse(await readFile(f.old.workPlan.path));
  workPlan.controller.implementation = implementation;
  const workReference = await replace(f.old.workPlan.path, workPlan);
  const plan = structuredClone(f.old.plan), amendmentPath = plan.execution.standing_scope.amendment.path;
  const amendment = JSON.parse(await readFile(amendmentPath)); amendment.work_plan = workReference;
  amendment.amendment_sha256 = fingerprint({ ...amendment, amendment_sha256: null });
  plan.execution.standing_scope.amendment = await replace(amendmentPath, amendment);
  plan.plan_sha256 = fingerprint({ ...plan, plan_sha256: null });
  const planReference = await replace(f.old.planReference.path, plan);
  await replace(f.request, { ...f.requestValue, plan: planReference });
}

test('the current reviewed producer preserves four original rows and unknown usage while a real successor succeeds', async t => {
  const f = await fixture(t);
  const draft = await verifyProfilePrelaunchDispositionRequest(f.args);
  assert.equal(draft.producer.implementation.files.find(item => item.path === 'execute.mjs').sha256,
    '9352324150f4990f3b713b901a82ab28827d812735fabf2db1ee35b395718cea');
  assert.equal(draft.reservation_ordinal, 250);
  assert.equal(draft.accounting.model_requests, null); assert.equal(draft.accounting.business_completed, false);
  await assert.rejects(readFile(join(f.old.controlRoot, PRELAUNCH_DISPOSITION_FILE)), { code: 'ENOENT' });
  const next = await f.attempt('repaired-attempt');
  let release = await acquireCampaignLease(next.plan, next.amendment);
  try { await assert.rejects(verifyStandingPlan(next.plan, { activate: true }), /STANDING_PREDECESSOR_UNRESOLVED/); }
  finally { await release(); }
  const first = await benchmarkMain(['reconcile', '--root', f.old.controlRoot, '--prelaunch-request', f.request]);
  const repeated = await disposeProfilePrelaunchFailure(f.args); assert.deepEqual(repeated, first);
  const oldRelease = await acquireCampaignLease(f.old.plan, f.old.amendment);
  try {
    await assert.rejects(verifyStandingPlan(f.old.plan, { activate: true }), /STANDING_ATTEMPT_PRELAUNCH_TERMINAL/);
    await assert.rejects(verifyStandingPlan(f.old.plan, { forReservation: true }), /STANDING_ATTEMPT_PRELAUNCH_TERMINAL/);
  } finally { await oldRelease(); }
  assert.equal(await readFile(f.ledgerPath, 'utf8'), f.originalLedger);
  const sidecar = JSON.parse(await readFile(first.disposition.path)); assert.equal(sidecar.accounting.model_requests, null);
  release = await acquireCampaignLease(next.plan, next.amendment);
  try {
    await verifyStandingPlan(next.plan, { activate: true });
    await verifyStandingPlan(next.plan, { forReservation: true });
    const reserved = await reserveStandingEpisode({ plan: next.plan, amendment: next.amendment,
      slot: next.plan.slots[0], runId: next.plan.id + '-001', planReference: next.planReference });
    assert.equal(reserved.ordinal, 251);
  } finally { await release(); }
  const boundary = await inspectStandingLedger({ ledgerRoot: f.ledgerRoot, baseline: f.baseline });
  assert.equal(boundary.local_observations, 2); assert.equal(boundary.local_registrations, 2);
  assert.deepEqual(boundary.registrations.at(-1).value.predecessor_disposition, first.disposition);
  assert.equal(await readFile(f.ledgerPath, 'utf8'), f.originalLedger);
  await assert.rejects(verifyStandingPlan(f.old.plan, { forReservation: true }), /RETIRED_OR_UNREGISTERED|PRELAUNCH_TERMINAL/);
});

test('legacy and current producer claims cannot exchange execute boundaries or accept an unreviewed execute', async t => {
  const legacyProducer = '1fa70d6aafe99891cf2a005a842257775bcbd7f98950f330b5635cc80fc20199';
  const legacyExecute = '40c703195db0efd3c0814e61b3473569a02cf2e7053546932f34de0800f02a9c';
  const currentExecute = '9352324150f4990f3b713b901a82ab28827d812735fabf2db1ee35b395718cea';
  for (const [legacy, actual, expected] of [[true, currentExecute, legacyExecute], [false, legacyExecute, currentExecute],
    [true, 'b'.repeat(64), legacyExecute], [false, 'b'.repeat(64), currentExecute]]) {
    const f = await fixture(t), implementation = structuredClone(f.old.plan.execution.implementation);
    if (legacy) implementation.sha256 = legacyProducer;
    implementation.files.find(item => item.path === 'execute.mjs').sha256 = actual;
    await rebindProducer(f, implementation);
    await assert.rejects(verifyProfilePrelaunchDispositionRequest(f.args), error => {
      assert.match(error.message, /PRELAUNCH_UNREVIEWED_BOUNDARY: execute\.mjs/);
      assert.equal(error.actual, actual); assert.equal(error.expected, expected); return true;
    });
    await assert.rejects(readFile(join(f.old.controlRoot, PRELAUNCH_DISPOSITION_FILE)), { code: 'ENOENT' });
  }
});

test('an unreviewed producer and changes to the three companion boundaries stay rejected', async t => {
  for (const path of [null, 'controller.mjs', 'batch.mjs', '../scripts/paired-resource-profile.mjs']) {
    const f = await fixture(t), implementation = structuredClone(f.old.plan.execution.implementation);
    if (path) implementation.files.find(item => item.path === path).sha256 = 'b'.repeat(64);
    else implementation.sha256 = 'a'.repeat(64);
    await rebindProducer(f, implementation);
    await assert.rejects(verifyProfilePrelaunchDispositionRequest(f.args), error => {
      assert.ok(error.message.includes(path ? 'PRELAUNCH_UNREVIEWED_BOUNDARY: ' + path : 'PRELAUNCH_UNREVIEWED_PRODUCER'));
      return true;
    });
  }
});

test('registered successor rechecks original evidence and later launch evidence before another reservation', async t => {
  const f = await fixture(t); await disposeProfilePrelaunchFailure(f.args);
  const next = await f.attempt('next');
  const release = await acquireCampaignLease(next.plan, next.amendment);
  try {
    await verifyStandingPlan(next.plan, { activate: true });
    await writeFile(f.ledgerPath, f.originalLedger + '\n');
    await assert.rejects(verifyStandingPlan(next.plan, { forReservation: true }), /ORIGINAL_CHANGED|ORIGINALS_CHANGED|LEDGER_RECEIPT_CHANGED/);
    await writeFile(f.ledgerPath, f.originalLedger);
    const diagnostic = join(f.old.controlRoot, f.runId + '.dispatch-error.json');
    await writeFile(diagnostic, '{', { flag: 'wx' });
    await assert.rejects(verifyStandingPlan(next.plan, { forReservation: true }),
      error => error.message.includes('PRELAUNCH_EXECUTION_OR_LEASE_EXISTS: ' + diagnostic));
    await rename(diagnostic, diagnostic + '.retained-fixture');
    const runRoot = join(f.environmentRoot, 'runs', f.runId); await mkdir(runRoot, { recursive: true });
    await assert.rejects(reserveStandingEpisode({ plan: next.plan, amendment: next.amendment, slot: next.plan.slots[0],
      runId: next.plan.id + '-001', planReference: next.planReference }), /PRELAUNCH_EXECUTION_OR_LEASE_EXISTS/);
    assert.equal((await readdir(f.ledgerRoot)).includes('251.json'), false);
  } finally { await release(); }
});

test('SIGKILL halfway through pending publication retains a dead lease; explicit reconciliation then replay converges', async t => {
  const f = await fixture(t);
  const script = 'import { disposeProfilePrelaunchFailure } from ' + JSON.stringify(new URL('./prelaunch-disposition.mjs', import.meta.url).href) + ';'
    + 'const [controlRoot, request] = process.argv.slice(1);'
    + 'await disposeProfilePrelaunchFailure({ controlRoot, request, onProgress: async ({ phase }) => {'
    + 'if (phase === "pending_prefix") process.kill(process.pid, "SIGKILL"); }});';
  const killed = await child(script, [f.old.controlRoot, f.request]);
  assert.equal(killed.signal, 'SIGKILL', killed.output);
  await assert.rejects(readFile(join(f.old.controlRoot, PRELAUNCH_DISPOSITION_FILE)), { code: 'ENOENT' });
  const pendingName = (await readdir(f.old.controlRoot)).find(name => name.endsWith('.pending.json'));
  const partial = await readFile(join(f.old.controlRoot, pendingName)); assert.throws(() => JSON.parse(partial));
  const lease = JSON.parse(await readFile(join(f.ledgerRoot, 'campaign.lease.json')));
  assert.equal(lease.pid, killed.pid);
  await assert.rejects(disposeProfilePrelaunchFailure(f.args), { code: 'EEXIST' });
  const reconciled = await reconcileStandingLease({ plan: f.old.plan, leaseId: lease.id });
  assert.equal(reconciled.scope_lease_id, lease.id);
  const final = await disposeProfilePrelaunchFailure(f.args), again = await disposeProfilePrelaunchFailure(f.args);
  assert.deepEqual(final, again);
  assert.equal(await readFile(f.ledgerPath, 'utf8'), f.originalLedger);
  const next = await f.attempt('after-kill');
  const release = await acquireCampaignLease(next.plan, next.amendment);
  try { await verifyStandingPlan(next.plan, { activate: true }); await verifyStandingPlan(next.plan, { forReservation: true }); }
  finally { await release(); }
});

test('live concurrent writers are serialized and a publication checkpoint can be replayed without a duplicate record', async t => {
  const f = await fixture(t); let paused, continuePublication;
  const ready = new Promise(resolve => { paused = resolve; });
  const wait = new Promise(resolve => { continuePublication = resolve; });
  const first = disposeProfilePrelaunchFailure({ ...f.args, onProgress: async ({ phase }) => {
    if (phase === 'pending_complete') { paused(); await wait; }
  } });
  await ready;
  try {
    await assert.rejects(disposeProfilePrelaunchFailure(f.args), { code: 'EEXIST' });
    const lease = JSON.parse(await readFile(join(f.ledgerRoot, 'campaign.lease.json')));
    await assert.rejects(reconcileStandingLease({ plan: f.old.plan, leaseId: lease.id }), /OWNER_ALIVE/);
  } finally { continuePublication(); }
  const result = await first;
  await assert.rejects(disposeProfilePrelaunchFailure({ ...f.args, request: (await write(join(f.old.controlRoot, 'conflict.json'),
    { ...f.requestValue, reason: 'A conflicting review cannot replace the first record.' })).path }), /CONFLICTING_REQUEST/);
  assert.equal((await verifyProfilePrelaunchDisposition({ reference: result.disposition, predecessor: f.old.plan })).value.run_id, f.runId);
});

test('crash after atomic final publication preserves one verified record and permits replay', async t => {
  const f = await fixture(t);
  await assert.rejects(disposeProfilePrelaunchFailure({ ...f.args, onProgress: async ({ phase }) => {
    if (phase === 'published') throw new Error('simulated interruption after publication');
  } }), /simulated interruption/);
  const result = await disposeProfilePrelaunchFailure(f.args);
  assert.equal(result.disposition.path, join(f.old.controlRoot, PRELAUNCH_DISPOSITION_FILE));
  assert.equal(await readFile(f.ledgerPath, 'utf8'), f.originalLedger);
});

test('execution artifacts, including partial or linked dispatch diagnostics, never receive a disposition', async t => {
  for (const location of ['run', 'launch', 'turn', 'diagnostic', 'partial_diagnostic', 'linked_diagnostic']) {
    const f = await fixture(t);
    const path = location === 'run' ? join(f.environmentRoot, 'runs', f.runId)
      : location === 'turn' ? join(f.old.controlRoot, 'turn-control', f.runId)
      : join(f.old.controlRoot, f.runId + (location === 'launch' ? '.launch.json' : '.dispatch-error.json'));
    if (location === 'run' || location === 'turn') await mkdir(path, { recursive: true });
    else if (location === 'partial_diagnostic') await writeFile(path, '{', { flag: 'wx' });
    else if (location === 'linked_diagnostic') await symlink(f.old.commandReference.path, path);
    else await write(path, { retained: true });
    await assert.rejects(disposeProfilePrelaunchFailure(f.args),
      error => error.message.includes('PRELAUNCH_EXECUTION_OR_LEASE_EXISTS: ' + path));
    await assert.rejects(readFile(join(f.old.controlRoot, PRELAUNCH_DISPOSITION_FILE)), { code: 'ENOENT' });
  }
});

test('later slots and multiple starts stay outside the single first-slot disposition', async t => {
  for (const change of ['later_slot', 'multiple_starts']) {
    const f = await fixture(t);
    if (change === 'later_slot') {
      for (const row of f.rows.filter(row => row.run_id)) { row.order = 1; row.run_id = f.old.plan.id + '-002'; }
    } else f.rows.splice(2, 0, structuredClone(f.rows[1]));
    await writeFile(f.ledgerPath, ledgerBytes(f.rows));
    await assert.rejects(verifyProfilePrelaunchDispositionRequest(f.args),
      change === 'later_slot' ? /PRELAUNCH_SLOT_CHANGED/ : /PRELAUNCH_REQUIRES_SINGLE_CLOSED_FAILURE/);
    await assert.rejects(readFile(join(f.old.controlRoot, PRELAUNCH_DISPOSITION_FILE)), { code: 'ENOENT' });
  }
});

test('unknown errors, orphan reservations, active owners and original changes fail closed', async t => {
  for (const change of ['unknown_error', 'missing_reservation', 'live_owner', 'changed_review', 'changed_profile', 'changed_build', 'producer']) {
    const f = await fixture(t);
    if (change === 'unknown_error') {
      f.rows[2].error.message = 'The request may have been sent'; await writeFile(f.ledgerPath, ledgerBytes(f.rows));
    } else if (change === 'missing_reservation') await rename(join(f.ledgerRoot, '250.json'), join(f.ledgerRoot, 'retained-orphan-250.json'));
    else if (change === 'live_owner') {
      const path = join(f.old.controlRoot, 'lease-retained-' + f.leaseId + '.json');
      const lease = JSON.parse(await readFile(path)); lease.pid = process.pid; await writeFile(path, encode(lease));
      const complete = join(f.old.controlRoot, 'lease-completed-' + f.leaseId + '.json');
      const value = JSON.parse(await readFile(complete)); value.pid = process.pid; await writeFile(complete, encode(value));
    } else if (change === 'changed_review') await writeFile(f.requestValue.review.path, '{}\n');
    else if (change === 'changed_profile') await writeFile(f.old.resourceProfile.path, '{}\n');
    else if (change === 'changed_build') {
      const path = join(f.environmentRoot, 'builds', f.old.plan.execution.conditions.condition.build_id, 'build.json');
      await writeFile(path, (await readFile(path, 'utf8')) + '\n');
    } else {
      const plan = JSON.parse(await readFile(f.old.workPlan.path)); plan.controller.implementation.sha256 = 'a'.repeat(64);
      await writeFile(f.old.workPlan.path, encode(plan));
    }
    await assert.rejects(disposeProfilePrelaunchFailure(f.args), /PRELAUNCH_/);
    await assert.rejects(readFile(join(f.old.controlRoot, PRELAUNCH_DISPOSITION_FILE)), { code: 'ENOENT' });
  }
});

test('a conflicting partial record or an original changed during publication cannot become a terminal sidecar', async t => {
  const f = await fixture(t);
  await assert.rejects(disposeProfilePrelaunchFailure({ ...f.args, onProgress: async ({ phase }) => {
    if (phase === 'pending_prefix') throw new Error('pause');
  } }), /pause/);
  const pending = join(f.old.controlRoot, (await readdir(f.old.controlRoot)).find(name => name.endsWith('.pending.json')));
  await writeFile(pending, 'unrelated partial');
  await assert.rejects(disposeProfilePrelaunchFailure(f.args), /PRELAUNCH_PENDING_CONFLICT/);
  const g = await fixture(t);
  await assert.rejects(disposeProfilePrelaunchFailure({ ...g.args, onProgress: async ({ phase }) => {
    if (phase === 'pending_complete') await mkdir(join(g.environmentRoot, 'runs', g.runId), { recursive: true });
  } }), /PRELAUNCH_EXECUTION_OR_LEASE_EXISTS/);
  await assert.rejects(readFile(join(g.old.controlRoot, PRELAUNCH_DISPOSITION_FILE)), { code: 'ENOENT' });
});

test('new scope must use a new condition epoch and mixed recovery CLI options are rejected', async t => {
  const f = await fixture(t); await disposeProfilePrelaunchFailure(f.args);
  const next = await f.attempt('same-epoch-attempt', f.old.epoch.id);
  const release = await acquireCampaignLease(next.plan, next.amendment);
  try { await assert.rejects(verifyStandingPlan(next.plan, { activate: true }), /PRELAUNCH_NEW_EPOCH_REQUIRED/); }
  finally { await release(); }
  assert.equal(parseBenchmarkArgs(['reconcile', '--root', f.old.controlRoot, '--prelaunch-request', f.request])['prelaunch-request'], f.request);
  for (const options of [['--lease', 'dead'], ['--retire-reason', 'reason'], ['--scope-only', 'true']])
    await assert.rejects(benchmarkMain(['reconcile', '--root', f.old.controlRoot, '--prelaunch-request', f.request, ...options]), /cannot be combined/);
});


test('a later controller with changed execute bytes replays the retained verifier despite PID reuse', async t => {
  const f = await fixture(t), first = await disposeProfilePrelaunchFailure(f.args);
  const prepared = await f.attempt('prepared-next');
  const readerRoot = join(f.control, 'later-reader', 'broker');
  const implementation = await executionImplementation();
  for (const entry of implementation.files) {
    const target = resolve(readerRoot, 'benchmark', entry.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(resolve(sourceRoot, 'benchmark', entry.path)), { flag: 'wx' });
  }
  const changed = join(readerRoot, 'benchmark/execute.mjs');
  await writeFile(changed, (await readFile(changed, 'utf8')) + '\n// A later reader identity; behavior is unchanged.\n');
  const script = `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { mkdir, readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const [readerRoot, oldRoot, request, dispositionFile, preparedFile] = process.argv.slice(1);
    const load = async path => JSON.parse(await readFile(path));
    const sha = bytes => createHash('sha256').update(bytes).digest('hex');
    const write = async (path, value) => {
      const bytes = JSON.stringify(value, null, 2) + '\\n';
      await writeFile(path, bytes, { flag: 'wx' }); return { path, sha256: sha(bytes) };
    };
    const module = name => import(pathToFileURL(join(readerRoot, 'benchmark', name)));
    const recovery = await module('prelaunch-disposition.mjs'), standing = await module('standing-campaign.mjs');
    const dispatch = await module('campaign-dispatch.mjs'), protocolModule = await module('protocol.mjs');
    const implementation = await (await module('implementation.mjs')).executionImplementation();
    const disposition = await load(dispositionFile), predecessor = await load(join(oldRoot, 'plan.json'));
    const retainedLease = await load(disposition.originals.retained_lease.path), actualKill = process.kill.bind(process);
    let oldPidChecks = 0;
    process.kill = (pid, signal) => {
      if (pid === retainedLease.pid && signal === 0) { oldPidChecks++; return true; }
      return actualKill(pid, signal);
    };
    assert.notEqual(implementation.sha256, disposition.writer.implementation.sha256);
    assert.notEqual(implementation.files.find(item => item.path === 'execute.mjs').sha256,
      disposition.writer.implementation.files.find(item => item.path === 'execute.mjs').sha256);
    const reference = { path: dispositionFile, sha256: sha(await readFile(dispositionFile)) };
    await recovery.verifyProfilePrelaunchDisposition({ reference, predecessor });
    const repeated = await recovery.disposeProfilePrelaunchFailure({ controlRoot: oldRoot, request });
    assert.deepEqual(repeated.disposition, reference);
    await recovery.verifyProfilePrelaunchDispositionRequest({ controlRoot: oldRoot, request });
    assert.equal(oldPidChecks, 0, 'A reused numeric PID must not re-open the bound terminal fact');

    const prepared = await load(preparedFile), preparedAmendment = await standing.readStandingAmendment(prepared.execution.standing_scope.amendment);
    const priorWork = await load(preparedAmendment.work_plan.path), priorTemplate = await load(priorWork.entries[0].setup.path);
    const controlRoot = join(prepared.execution.environment_root, 'control/later-reader-attempt'); await mkdir(controlRoot);
    const id = 'later-reader-attempt', template = { ...priorTemplate, id: id + '-template', control_root: join(controlRoot, 'template') };
    const templateRef = await write(join(controlRoot, 'template.json'), template);
    const work = { ...priorWork, id: id + '-work', controller: { source_root: readerRoot, implementation },
      condition_epoch: { ...priorWork.condition_epoch, id: 'later-reader-epoch' },
      entries: [{ ...priorWork.entries[0], setup: templateRef }] };
    const workRef = await write(join(controlRoot, 'work-plan.json'), work);
    const setup = { ...template, id, control_root: controlRoot, standing: { authorization: work.authorization,
      work_plan: workRef, work_item_id: work.entries[0].id, attempt_id: id, ledger_root: prepared.execution.pilot_ledger_root } };
    await write(join(controlRoot, 'setup.json'), setup);
    const context = await standing.assertStandingSetup(setup);
    const protocol = { ...prepared.protocol, id, policies: { ...prepared.protocol.policies,
      campaign: standing.standingCampaignPolicy(context, { scheduledEpisodes: 1 }) } };
    const { standing_scope, ...execution } = prepared.execution;
    Object.assign(execution, { control_root: controlRoot, implementation });
    const scope = await standing.prepareStandingScope({ setup, protocol, execution, slots: prepared.slots });
    execution[scope.field] = scope.registration;
    const plan = { ...prepared, id, protocol, execution, plan_sha256: null };
    plan.plan_sha256 = protocolModule.fingerprint(plan);
    const planReference = await write(join(controlRoot, 'plan.json'), plan);
    const amendment = await standing.verifyStandingPlan(plan), release = await dispatch.acquireCampaignLease(plan, amendment);
    let reserved;
    try {
      await standing.verifyStandingPlan(plan, { activate: true });
      await standing.verifyStandingPlan(plan, { forReservation: true });
      reserved = await standing.reserveStandingEpisode({ plan, amendment, slot: plan.slots[0], runId: id + '-001', planReference });
      assert.equal(reserved.ordinal, 251);
    } finally { await release(); }
    assert.equal(oldPidChecks, 0);
    await write(join(oldRoot, 'lease.json'), { fixture: 'later real batch lease still blocks' });
    await assert.rejects(standing.inspectStandingLedger({ ledgerRoot: amendment.pilot_ledger_root, baseline: amendment.baseline }),
      /PRELAUNCH_EXECUTION_OR_LEASE_EXISTS/);
    console.log(JSON.stringify({ status: 'later_reader_verified', later_reader_sha256: implementation.sha256,
      retained_writer_sha256: disposition.writer.implementation.sha256, old_pid_checks: oldPidChecks, reservation_ordinal: reserved.ordinal }));
  `;
  const result = await child(script, [readerRoot, f.old.controlRoot, f.request, first.disposition.path, prepared.planReference.path]);
  assert.equal(result.code, 0, result.output);
  const receipt = JSON.parse(result.output.trim());
  assert.equal(receipt.status, 'later_reader_verified'); assert.equal(receipt.old_pid_checks, 0); assert.equal(receipt.reservation_ordinal, 251);
  assert.equal(await readFile(f.ledgerPath, 'utf8'), f.originalLedger);
  t.diagnostic(result.output.trim());
});

