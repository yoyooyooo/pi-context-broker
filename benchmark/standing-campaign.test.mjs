import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readStandingAuthorization, numericStandingNames, standingCampaignPolicy, standingSetupProjection,
  assertStandingSetup, prepareStandingScope, verifyStandingPlan, inspectStandingLedger, reserveStandingEpisode, reconcileStandingLease } from './standing-campaign.mjs';
import { classifyStandingProgress, runStandingSlices, withoutStandingAnalysisCredentials } from './standing-runner.mjs';
import { benchmarkResultExitCode, parseBenchmarkArgs } from './cli.mjs';
import { executionImplementation } from './implementation.mjs';
import { fingerprint } from './protocol.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function files(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-standing-test-')));
  t.after(() => promisify(execFile)('/usr/bin/trash', [root]));
  return async (name, value) => {
    const path = join(root, name), bytes = JSON.stringify(value, null, 2) + '\n';
    await writeFile(path, bytes, { flag: 'wx' }); return { path, sha256: sha(bytes) };
  };
}
function grant() {
  return { version: 1, kind: 'user-standing-benchmark-authorization', id: 'standing-fixture', approved: true,
    source: 'current-user-message', user_message: 'Continue this task and all related batches without resource limits.',
    recorded_at_utc: '2000-01-01T00:00:00Z', task: 'Notion Skills Benchmark', authorization_expiry: null,
    per_batch_approval_required: false, resource_policy: { mode: 'unbounded' }, supervised_recovery_authorized: true };
}
function plan(count = 24) {
  return { id: 'standing-full-design', slots: Array.from({ length: count }, (_, order) => ({ order,
    slot_id: 'slot-' + order, case_id: 'case-' + order, condition_id: 'condition', repeat: 0, seed: 7 })),
  protocol: { policies: { budgets: [{ mode: 'unbounded', batch: { max_episodes: null, max_duration_ms: null } }] },
    models: [{ backend: { window: { mode: 'standing', start: '2000-01-01T00:00:00Z', end: null } } }] } };
}
function append(rows, p, count, reason, result = {}) {
  const before = rows.filter(row => row.type === 'episode_started').length;
  const put = value => rows.push({ seq: rows.length + 1, ...value });
  put({ type: 'batch_opened' });
  for (const slot of p.slots.slice(before, before + count)) {
    const run_id = p.id + '-' + String(slot.order + 1).padStart(3, '0');
    put({ type: 'episode_started', ...slot, run_id });
    put({ type: 'episode_completed', ...slot, run_id, result: { status: 'completed', stop_batch: false, stop_reason: null,
      budget_usage: { model_requests: 1000000, input_tokens: 1000000000, output_tokens: 100000000,
        duration_ms: 1000000000 }, ...result } });
  }
  put({ type: 'batch_closed', reason, new_episodes: count });
}

test('a byte-bound standing grant remains reusable without expiry or allocation fields', async t => {
  const save = await files(t), value = grant(), ref = await save('grant.json', value);
  assert.deepEqual((await readStandingAuthorization(ref)).value, value);
  assert.deepEqual(await readStandingAuthorization(ref), await readStandingAuthorization(ref));
  for (const [name, mutate] of [
    ['expiry', value => { value.authorization_expiry = '2000-01-02T00:00:00Z'; }],
    ['per-batch', value => { value.per_batch_approval_required = true; }],
    ['quota', value => { value.resource_policy.max_requests = 1000000000; }],
    ['allocations', value => { value.allocations = [{ episodes: 42 }]; }],
    ['unapproved', value => { value.approved = false; }],
  ]) {
    const bad = grant(); mutate(bad); await assert.rejects(readStandingAuthorization(await save(name + '.json', bad)));
  }
  await assert.rejects(readStandingAuthorization({ ...ref, sha256: '0'.repeat(64) }), /STANDING_REFERENCE_CHANGED/);
});

test('scientific coverage can change across work plans while retaining the same standing grant', () => {
  const context = { attemptId: 'attempt-1', authorization: { value: grant() }, workPlan: { value: { id: 'work-plan-1' } },
    item: { id: 'design-1', planned_episodes: 1001 }, conditionEpoch: { id: 'unbounded-condition', started_at: '2000-01-01T00:00:00Z', authorization: { path: '/grant.json', sha256: 'a'.repeat(64) } } };
  const policy = standingCampaignPolicy(context, { scheduledEpisodes: 1001 });
  assert.equal(policy.planned_episodes, 1001); assert.equal(policy.authorization_id, grant().id);
  assert.equal(policy.reservation_limit, undefined); assert.equal(policy.max_scheduled_episodes, undefined);
  assert.deepEqual(policy.resource_policy, { mode: 'unbounded' });
  assert.throws(() => standingCampaignPolicy(context, { scheduledEpisodes: 1000 }), /STANDING_SCIENTIFIC_COVERAGE_CHANGED/);
  context.workPlan.value.id = 'work-plan-2'; context.item.planned_episodes = 2; context.attemptId = 'attempt-2';
  assert.equal(standingCampaignPolicy(context, { scheduledEpisodes: 2 }).authorization_id, policy.authorization_id);
});

test('new attempt identity cannot disguise a changed scientific template', () => {
  const original = { id: 'template', control_root: '/template', models: { parameters: { maxTokens: 4096 } }, budget: { mode: 'unbounded' }, candidates: ['a', 'b'] };
  const retry = { ...structuredClone(original), id: 'attempt-2', control_root: '/attempt-2', standing: { attempt_id: 'attempt-2' } };
  assert.deepEqual(standingSetupProjection(retry), standingSetupProjection(original));
  retry.models.parameters.maxTokens = 8192;
  assert.notDeepEqual(standingSetupProjection(retry), standingSetupProjection(original));
});

test('numeric ledgers cross 999 without lexical order or a hidden ordinal ceiling', () => {
  assert.deepEqual(numericStandingNames(['1001.json', '999.json', '1000.json', 'ledger-baseline.json']),
    [{ name: '999.json', ordinal: 999 }, { name: '1000.json', ordinal: 1000 }, { name: '1001.json', ordinal: 1001 }]);
  assert.deepEqual(numericStandingNames(['scope-registration-1000.json', 'scope-registration-999.json'], 'registration').map(item => item.ordinal), [999, 1000]);
  assert.throws(() => numericStandingNames(['01000.json']), /STANDING_NONCANONICAL_ORDINAL/);
  assert.throws(() => numericStandingNames(['9007199254740992.json']), /STANDING_ORDINAL_INVALID/);
});

test('the finite design completes in slices despite spending beyond every historical allowance', async () => {
  const p = plan(), rows = [], calls = [], analyses = [];
  const run = async () => runStandingSlices({ plan: p, maximumSlice: 8, readRows: async () => structuredClone(rows),
    runSlice: async limit => { calls.push(limit); append(rows, p, limit, calls.length === 3 ? 'planned_slots_completed' : 'operator_slice_limit'); },
    writeCheckpoint: async () => {}, verifySnapshot: async () => {}, analyzePrefix: async value => analyses.push(value.completed_prefix) });
  assert.equal((await run()).action, 'finish'); assert.deepEqual(calls, [8, 8, 8]); assert.deepEqual(analyses, [8, 16, 24]);
  assert.equal((await run()).action, 'finish'); assert.deepEqual(calls, [8, 8, 8]);
});

test('unknown costs, core faults and unresolved execution stop the attempt with retained evidence', () => {
  for (const [variant, expected] of [['unknown', 'unknown_usage'], ['core', 'core_stop'], ['unresolved', 'unresolved_execution'], ['identity', 'frozen_slot_changed']]) {
    const p = plan(), rows = []; append(rows, p, 1, 'operator_slice_limit');
    if (variant === 'unknown') rows[2].result.budget_usage.input_tokens = null;
    if (variant === 'core') rows[2].result.stop_batch = true;
    if (variant === 'unresolved') { rows.splice(2, 1); rows.forEach((row, index) => { row.seq = index + 1; }); }
    if (variant === 'identity') rows[2].case_id = 'foreign';
    assert.equal(classifyStandingProgress({ plan: p, rows, requestedLimit: 1 }).reason, expected);
  }
});

test('a silent invocation or closed zero-progress invocation cannot create an unlimited retry loop', async () => {
  for (const silent of [true, false]) {
    const p = plan(), rows = []; let calls = 0, checkpoints = 0;
    const result = await runStandingSlices({ plan: p, maximumSlice: 8, readRows: async () => rows,
      runSlice: async () => { calls++; if (!silent) append(rows, p, 0, 'operator_slice_limit'); },
      writeCheckpoint: async () => { checkpoints++; }, verifySnapshot: async () => {}, analyzePrefix: async () => assert.fail('No empty analysis') });
    assert.equal(result.reason, 'zero_progress'); assert.equal(calls, 1); assert.equal(checkpoints, 1);
  }
});

test('checkpoint mutation is detected before analysis or another dispatch', async () => {
  const p = plan(), rows = []; let snapshot, calls = 0;
  await assert.rejects(runStandingSlices({ plan: p, maximumSlice: 8,
    readRows: async () => { snapshot = JSON.stringify(rows); return structuredClone(rows); },
    runSlice: async limit => { calls++; append(rows, p, limit, 'operator_slice_limit'); },
    writeCheckpoint: async () => append(rows, p, 1, 'operator_slice_limit'),
    verifySnapshot: async () => assert.equal(JSON.stringify(rows), snapshot, 'STANDING_SNAPSHOT_CHANGED'),
    analyzePrefix: async () => assert.fail('No analysis over changed evidence') }), /STANDING_SNAPSHOT_CHANGED/);
  assert.equal(calls, 1);
});

test('standing CLI stops return nonzero and checkpoint frequency is a separate option', () => {
  assert.equal(benchmarkResultExitCode('run-standing', { status: 'stopped' }), 1);
  assert.equal(benchmarkResultExitCode('run-standing', { status: 'completed' }), 0);
  assert.deepEqual(parseBenchmarkArgs(['run-standing', '--plan', '/plan.json', '--out', '/run', '--slice', '8']),
    { action: 'run-standing', plan: '/plan.json', out: '/run', slice: '8' });
  assert.throws(() => parseBenchmarkArgs(['run-standing', '--max-requests', '1000']), /Unexpected option/);
});

test('serial prefix analysis has no task credentials and restores the exact environment on success or failure', async () => {
  const original = { BENCHMARK_FIXTURE_KEY: 'synthetic-key', NOTION_API_TOKEN: 'synthetic-token', PATH: '/fixture/bin' };
  for (const fail of [false, true]) {
    const environment = { ...original };
    const operation = withoutStandingAnalysisCredentials({ apiKeyEnv: 'BENCHMARK_FIXTURE_KEY', environment }, async () => {
      await Promise.resolve(); assert.deepEqual(environment, { PATH: '/fixture/bin' });
      if (fail) throw new Error('synthetic analysis failure'); return 'analyzed';
    });
    if (fail) await assert.rejects(operation, /synthetic analysis failure/);
    else assert.equal(await operation, 'analyzed');
    assert.deepEqual(environment, original);
  }
  const absent = { PATH: '/fixture/bin' };
  await withoutStandingAnalysisCredentials({ apiKeyEnv: 'BENCHMARK_FIXTURE_KEY', environment: absent }, async () => {});
  assert.deepEqual(absent, { PATH: '/fixture/bin' });
});

test('real files bind a unique attempt, exclusive registration, reservation and retained orphan without provider calls', async t => {
  const environmentRoot = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-standing-ledger-test-')));
  t.after(() => promisify(execFile)('/usr/bin/trash', [environmentRoot]));
  const control = join(environmentRoot, 'control'), controlRoot = join(control, 'attempt-1'), ledgerRoot = join(control, 'standing-ledger');
  await mkdir(controlRoot, { recursive: true });
  const write = async (path, value) => {
    const bytes = JSON.stringify(value, null, 2) + '\n'; await writeFile(path, bytes, { flag: 'wx' }); return { path, sha256: sha(bytes) };
  };
  const authorization = await write(join(control, 'grant.json'), grant());
  const epoch = { id: 'unbounded-fixture', started_at: '2000-01-01T00:00:00Z', authorization };
  const historicalAuthorization = await write(join(control, 'historical-authority.json'), { fixture: 'retained history' });
  const baseline = await write(join(control, 'baseline.json'), { version: 1, kind: 'benchmark-standing-history-baseline', id: 'fixture-baseline',
    environment_root: environmentRoot, ledger_root: join(control, 'historical-ledger'), historical_authorization: historicalAuthorization,
    controller: { source_root: '/fixture-historical-reader', implementation: {} }, observations: 998, registrations: 0, registration_refs: [],
    history: { scheduled_episodes: 998, reservations: Array(998).fill({ fixture: true }), episodes: Array(998).fill({ fixture: true }) },
    published_evidence: [], verified_at: '2000-01-01T00:00:00Z' });
  const template = { version: 1, id: 'template', control_root: join(control, 'template'), environment_root: environmentRoot,
    budget: { id: 'unbounded', mode: 'unbounded',
      episode: { max_duration_ms: null, max_model_requests: null, max_input_tokens: null, max_output_tokens: null, max_http_attempts: null, max_retries: null },
      batch: { max_duration_ms: null, max_model_requests: null, max_input_tokens: null, max_output_tokens: null, max_episodes: null, max_concurrency: 1 },
      monetary: { policy: 'unpriced', max_amount: null } }, models: { window: { mode: 'standing', start: epoch.started_at, end: null } } };
  const setupReference = await write(join(control, 'template.json'), template), implementation = await executionImplementation();
  const workPlan = await write(join(control, 'work-plan.json'), { version: 1, kind: 'benchmark-standing-work-plan', id: 'work-plan',
    task: 'Notion Skills Benchmark', environment_root: environmentRoot, authorization, resource_policy: { mode: 'unbounded' }, condition_epoch: epoch,
    controller: { source_root: dirname(dirname(fileURLToPath(import.meta.url))), implementation }, baseline,
    entries: [{ id: 'case-design', setup: setupReference, planned_episodes: 2 }], created_at: '2000-01-01T00:00:00Z' });
  const setup = { ...template, id: 'attempt-1', control_root: controlRoot,
    standing: { authorization, work_plan: workPlan, work_item_id: 'case-design', attempt_id: 'attempt-1', ledger_root: ledgerRoot } };
  await write(join(controlRoot, 'setup.json'), setup);
  const context = await assertStandingSetup(setup), slots = plan(2).slots;
  const protocol = { id: setup.id, policies: { campaign: standingCampaignPolicy(context, { scheduledEpisodes: 2 }) }, protocol_sha256: 'a'.repeat(64) };
  const execution = { environment_root: environmentRoot, control_root: controlRoot, pilot_ledger_root: ledgerRoot, implementation };
  const scope = await prepareStandingScope({ setup, protocol, execution, slots }); execution[scope.field] = scope.registration;
  const p = { version: 1, kind: 'benchmark-batch-plan', id: setup.id, protocol, execution, slots, plan_sha256: null };
  p.plan_sha256 = fingerprint(p); const planReference = await write(join(controlRoot, 'plan.json'), p);
  await verifyStandingPlan(p);
  await assert.rejects(verifyStandingPlan(p, { activate: true }), /STANDING_ACTIVATION_REQUIRES_OWN_LEASE/);
  await write(join(ledgerRoot, 'campaign.lease.json'), { id: 'lease-fixture', pid: process.pid, scope_id: p.id,
    plan_sha256: p.plan_sha256, control_root: controlRoot });
  const amendment = await verifyStandingPlan(p, { activate: true });
  const registered = await inspectStandingLedger({ ledgerRoot, baseline });
  assert.equal(registered.local_registrations, 1); assert.equal(registered.global_observations, 998);
  assert.equal((await verifyStandingPlan(p, { activate: true })).id, p.id);
  assert.equal((await inspectStandingLedger({ ledgerRoot, baseline })).local_registrations, 1);
  await assert.rejects(reconcileStandingLease({ plan: p, leaseId: 'lease-fixture' }), /STANDING_LEASE_OWNER_ALIVE/);
  const reservation = await reserveStandingEpisode({ plan: p, amendment, slot: slots[0], runId: p.id + '-001', planReference });
  assert.equal(reservation.ordinal, 999);
  assert.equal(JSON.parse(await readFile(join(ledgerRoot, '999.json'), 'utf8')).authorization.sha256, authorization.sha256);
  await assert.rejects(verifyStandingPlan(p, { forReservation: true }), /STANDING_ORPHAN_RESERVATION/);
  const changed = structuredClone(setup); changed.budget.episode.max_model_requests = 99;
  await assert.rejects(assertStandingSetup(changed), /STANDING_SCIENTIFIC_TEMPLATE_CHANGED/);
});
