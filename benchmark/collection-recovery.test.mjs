import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { fingerprint } from './protocol.mjs';
import { validateCollectionRecoveryLedger, collectionRecoverySourceChanges, validateCollectionRecoveryRaw,
  verifyCollectionRecovery, verifyCollectionRecoveryResults, archivedCollectionInstrumentation,
  prepareAdapterEvidenceOwnership, validateStandingZeroSendCollectionRaw } from './collection-recovery.mjs';

const hash = 'a'.repeat(64), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = rows => Buffer.from(rows.map((row, i) => JSON.stringify({ version: 1, seq: i + 1, ...row })).join('\n') + '\n');
const reference = { path: '/owned/control/gate/collection-repair-registration.json', sha256: hash };
function fixture() {
  const slots = [0, 1].map(order => ({ slot_id: 'slot-' + order, pair_id: 'pair-' + order, case_id: 'case', condition_id: 'condition', repeat: 0, seed: 9, order }));
  const plan = { id: 'gate', plan_sha256: hash, slots,
    execution: { environment_root: '/owned', control_root: '/owned/control/gate',
      conditions: { condition: { build_id: 'build', mode: 'broker' } } },
    protocol: { conditions: [{ id: 'condition', model_id: 'model', budget_id: 'budget' }],
      models: [{ id: 'model', route: 'group/variant', api: 'openai-completions', parameters: { maxTokens: 50 },
        routing: { mode: 'fixed-route', reported_model_ids: ['group/variant'] } }],
      policies: { budgets: [{ id: 'budget', episode: { max_retries: 0, max_model_requests: 2, max_http_attempts: 2,
        max_input_tokens: 100, max_output_tokens: 50, max_duration_ms: 1000 } }] } } };
  const started = { type: 'episode_started', ...slots[0], run_id: 'gate-001', budget_id: 'budget' };
  const failed = { type: 'episode_unresolved', ...slots[0], run_id: 'gate-001',
    error: { name: 'AssertionError', message: 'Evidence file escapes the owned environment' } };
  const rows = [{ type: 'batch_opened', plan_sha256: hash }, started, failed,
    { type: 'batch_closed', reason: 'unresolved_execution_error', new_episodes: 1 }];
  const bytes = encode(rows), prefix = { path: '/owned/control/gate/ledger.jsonl', sha256: sha(bytes), bytes: bytes.length, through_seq: rows.length };
  const usage = { model_requests: 1, input_tokens: 40, output_tokens: 2, duration_ms: 20 };
  const repairs = [{ run_id: 'gate-001', slot_id: slots[0].slot_id, episode_started_seq: 2, episode_unresolved_seq: 3, budget_usage: usage }];
  const complete = (order, changes = {}) => ({ type: 'episode_completed', ...slots[order], run_id: 'gate-00' + (order + 1),
    ...(order === 0 ? { reconciled: true } : {}), result: { collection_recovery: reference, budget_usage: usage, stop_batch: false,
      run_root: '/owned/runs/gate-00' + (order + 1), normalized_directory: '/owned/control/gate/collection-repair-results/gate-00' + (order + 1) + '/normalized',
      episode_sha256: hash, ...changes } });
  const open = { type: 'batch_opened', plan_sha256: hash }, close = { type: 'batch_closed', new_episodes: 0, reason: 'operator_slice_limit' };
  const next = { type: 'episode_started', ...slots[1], run_id: 'gate-002', budget_id: 'budget' };
  const check = suffix => validateCollectionRecoveryLedger({ plan, bytes: encode([...rows, ...suffix]), prefix, reference, repairs });
  return { plan, rows, bytes, prefix, reference, repairs, complete, open, close, next, check, usage };
}

test('original closed collection failure remains one unresolved reservation', () => {
  const f = fixture(), result = validateCollectionRecoveryLedger({ plan: f.plan, bytes: f.bytes });
  assert.equal(result.started.run_id, 'gate-001'); assert.equal(result.completed.length, 0); assert.equal(result.active, false);
});
test('verification permits the batch-owned active states without requiring lease removal', () => {
  const f = fixture(); assert.equal(f.check([f.open]).active, true);
  assert.equal(f.check([f.open, f.complete(0)]).original_recovered, true);
  const state = f.check([f.open, f.complete(0), f.close, f.open, f.next]);
  assert.equal(state.active, true); assert.equal(state.zero_send_batch_closed, true);
});
test('first offline completion closes before ordinary bounded dispatch resumes', () => {
  const f = fixture(); const result = f.check([f.open, f.complete(0), f.close, f.open, f.next, f.complete(1),
    { type: 'batch_closed', new_episodes: 1, reason: 'planned_slots_completed' }]);
  assert.equal(result.completed.length, 2); assert.equal(result.active, false);
});
test('a byte-preserving prefix is required even when parsed JSON is equivalent', () => {
  const f = fixture(), changed = Buffer.from(f.bytes.toString().replace('{"version"', '{ "version"'));
  assert.throws(() => validateCollectionRecoveryLedger({ plan: f.plan, bytes: changed, prefix: f.prefix, reference, repairs: f.repairs }), /prefix changed/);
});
test('new dispatch cannot precede recovery or share its zero-send batch', () => {
  const f = fixture(); assert.throws(() => f.check([f.open, f.next]), /zero-send batch/);
  assert.throws(() => f.check([f.open, f.complete(0), f.next]), /zero-send batch/);
});
test('collection recovery cannot restart or duplicate the old run', () => {
  const f = fixture(); assert.throws(() => f.check([f.open, f.rows[1]]), /restart/);
  assert.throws(() => f.check([f.open, f.complete(0), f.complete(0)]), /duplicate/);
});
test('completion must retain explicit reference, original raw owner and original accounted usage', () => {
  const f = fixture();
  for (const changes of [{ collection_recovery: undefined }, { collection_recovery: { ...reference, sha256: 'b'.repeat(64) } },
    { run_root: '/foreign/run' }, { normalized_directory: '/owned/runs/gate-001/benchmark/normalized/normalized' },
    { budget_usage: { ...f.usage, model_requests: 0 } }, { analysis_revision: reference }])
    assert.throws(() => f.check([f.open, f.complete(0, changes)]));
});
test('foreign plan, model condition, case and budget cannot enter the suffix', () => {
  const f = fixture(); assert.throws(() => f.check([{ ...f.open, plan_sha256: 'b'.repeat(64) }]));
  for (const change of [{ condition_id: 'other' }, { case_id: 'other' }, { budget_id: 'other' }, { run_id: 'gate-999' }])
    assert.throws(() => f.check([f.open, f.complete(0), f.close, f.open, { ...f.next, ...change }]));
});
test('only the exact owned-material failure at the first gate slot is eligible', () => {
  const f = fixture();
  for (const change of [{ error: { name: 'AssertionError', message: 'unknown cost' } }, { error: { name: 'Error', message: f.rows[2].error.message } }]) {
    const rows = structuredClone(f.rows); Object.assign(rows[2], change);
    assert.throws(() => validateCollectionRecoveryLedger({ plan: f.plan, bytes: encode(rows) }), /recoverable/);
  }
  const rows = structuredClone(f.rows); rows[3].reason = 'unknown_budget_usage';
  assert.throws(() => validateCollectionRecoveryLedger({ plan: f.plan, bytes: encode(rows) }));
});
test('ledger gaps, partial appends, undeclared revisions and hidden extra completions are rejected', () => {
  const f = fixture(); assert.throws(() => f.check([{ type: 'analysis_revision_applied', reference }]));
  assert.throws(() => validateCollectionRecoveryLedger({ plan: f.plan, bytes: f.bytes.subarray(0, -1) }), /complete ledger/);
  assert.throws(() => validateCollectionRecoveryLedger({ plan: f.plan, bytes: Buffer.from(f.bytes.toString().replace('"seq":2', '"seq":9')) }), /sequence/);
});

const inventory = files => ({ version: 1, scope: 'same execution scope', files: files.map(([path, hashChar = 'a']) => ({ path, sha256: hashChar.repeat(64), bytes: 7 })), sha256: null });
function sources() {
  const before = inventory([['cli.mjs'], ['controller.mjs'], ['pilot-scope.mjs'], ['prospective-cohort.mjs'], ['collect.mjs'], ['subject.mjs'], ['evidence/normalize.mjs'], ['corpus/grader.mjs']]);
  before.sha256 = fingerprint(before.files);
  const after = structuredClone(before);
  after.files.find(file => file.path === 'controller.mjs').sha256 = 'b'.repeat(64);
  after.files.push({ path: 'collection-recovery.mjs', sha256: hash, bytes: 7 }, { path: 'material-ownership.mjs', sha256: hash, bytes: 7 });
  after.sha256 = fingerprint(after.files); return { before, after };
}
test('source transition allows only registered controller repair and material modules', () => {
  const { before, after } = sources();
  assert.deepEqual(collectionRecoverySourceChanges(before, after).map(row => row.path), ['collection-recovery.mjs', 'controller.mjs', 'material-ownership.mjs']);
});
test('collector, normalization, grader, subject, dependency deletion and arbitrary imports cannot change', () => {
  for (const path of ['collect.mjs', 'subject.mjs', 'evidence/normalize.mjs', 'corpus/grader.mjs']) {
    const { before, after } = sources(); after.files.find(file => file.path === path).sha256 = 'c'.repeat(64); after.sha256 = fingerprint(after.files);
    assert.throws(() => collectionRecoverySourceChanges(before, after), /cannot alter/);
  }
  for (const action of ['delete', 'add', 'escape']) {
    const { before, after } = sources();
    if (action === 'delete') after.files = after.files.filter(file => file.path !== 'subject.mjs');
    else after.files.push({ path: action === 'add' ? 'unsafe-override.mjs' : '../../outside.mjs', sha256: hash, bytes: 7 });
    after.sha256 = fingerprint(after.files); assert.throws(() => collectionRecoverySourceChanges(before, after));
  }
});
test('standing closeout wiring changes do not widen the historical paid-gate source contract', () => {
  for (const path of ['configure.mjs', 'batch.mjs', 'standing-campaign.mjs']) {
    const { before, after } = sources();
    before.files.push({ path, sha256: hash, bytes: 7 });
    after.files.push({ path, sha256: 'c'.repeat(64), bytes: 7 });
    before.sha256 = fingerprint(before.files); after.sha256 = fingerprint(after.files);
    assert.throws(() => collectionRecoverySourceChanges(before, after), /cannot alter/);
    assert.ok(collectionRecoverySourceChanges(before, after, { closeoutOnly: true }).some(file => file.path === path));
  }
});

function rawFixture() {
  const f = fixture(), model = f.plan.protocol.models[0], root = '/owned/runs/gate-001';
  const projection = { model: { id: model.route, api: model.api }, model_parameters: model.parameters, model_routing: model.routing };
  const runtime = { status: 'completed', entry_kind: 'pi-sdk', correlation: { run_id: 'gate-001', episode_id: 'gate-001', candidate_id: 'condition', task_id: 'case' },
    admission: { status: 'accepted_before_task' }, turns: [{}], completion: { agent_settled: true, cleanup: { abort_settled: true, shutdown_emitted: true, dispose_called: true } },
    coverage: Object.fromEntries(['attempts', 'tools', 'interventions', 'notion_sdk', 'notion_owned_http'].map(key => [key, 'complete'])),
    budget: { requests: 1, attempts: 1, input_tokens: 40, output_tokens: 2, tokens: 42, usage_unknown: false }, timing: { duration_ms: 20 },
    requests: [{ id: 'r1', sequence: 1, accounted: true, payload_sha256: sha(JSON.stringify({ model: model.route })), usage_attempt_id: 'a1', usage: { input: 40, output: 2, complete_for_token_budget: true },
      attempts: [{ id: 'a1', request_id: 'r1', sent: true, status: 200, reported_model: { status: 'matched', reported_ids: [model.route] } }] }] };
  return { plan: f.plan, slot: f.plan.slots[0], run: { run_id: 'gate-001', root, build_id: 'build', build_root: '/owned/builds/build', pi_launch: { mode: 'broker' } },
    shared: { run_id: 'gate-001', root, build_id: 'build', status: 'passed', exit_code: 0, spawned: true, timed_out: false, frozen_artifacts: 'passed', runtime_check: { status: 'unchanged' } },
    runtime, observed: { projection }, expectation: { projection: structuredClone(projection) }, payloads: [{ model: model.route }] };
}
test('completed raw is accepted only with original startup and fully known positive usage', () => {
  assert.deepEqual(validateCollectionRecoveryRaw(rawFixture()), fixture().usage);
});
test('raw recovery rejects unknown usage, extra attempts, changed model or candidate, and premature process exit', () => {
  const changes = [x => x.runtime.budget.usage_unknown = true, x => x.runtime.requests[0].attempts.push(x.runtime.requests[0].attempts[0]),
    x => x.payloads[0].model = 'other', x => x.runtime.correlation.candidate_id = 'other', x => x.shared.exit_code = 1,
    x => x.observed.projection.model_parameters.maxTokens = 99, x => x.runtime.coverage.attempts = 'partial',
    x => x.runtime.requests[0].attempts[0].reported_model.reported_ids = ['foreign/variant'],
    x => x.runtime.budget.input_tokens = 0, x => x.runtime.timing.duration_ms = null,
    x => x.run.build_id = 'other', x => x.runtime.completion.cleanup.dispose_called = false, x => x.runtime.requests[0].payload_sha256 = hash];
  for (const mutate of changes) { const input = rawFixture(); mutate(input); assert.throws(() => validateCollectionRecoveryRaw(input)); }
});
test('reference validation rejects a non-fixed path before reading or writing anything', async () => {
  await assert.rejects(verifyCollectionRecovery({ reference: { path: '/foreign/repair.json', sha256: hash }, plan: fixture().plan }), /fixed explicit registration/);
});
test('ordinary unregistered results remain compatible and orphaned repair refs are rejected', async () => {
  const plan = fixture().plan; plan.execution.control_root = '/path-that-does-not-exist-for-collection-recovery-tests/control';
  plan.execution.environment_root = '/path-that-does-not-exist-for-collection-recovery-tests';
  assert.equal(await verifyCollectionRecoveryResults(plan, [{ run_id: 'old', result: { status: 'retained' } }]), null);
  await assert.rejects(verifyCollectionRecoveryResults(plan, [{ run_id: 'old', result: { collection_recovery: reference } }]), /lost its registration/);
});


test('historical instrumentation reconstructs retained collector bytes independently of live sources', async () => {
  const sources = new Map([['collect.mjs', Buffer.from("import { helper } from './evidence/helper.mjs';\n")],
    ['evidence/helper.mjs', Buffer.from('export const helper = 1;\n')]]);
  const execution = { environment_root: '/unused', conditions: {} };
  const result = await archivedCollectionInstrumentation(execution, sources);
  assert.deepEqual(result.runtime_sha256, []);
  assert.deepEqual(result.collector_files.map(file => file.path), ['benchmark/collect.mjs', 'benchmark/evidence/helper.mjs']);
  assert.equal(result.collector_files[0].sha256, sha(sources.get('collect.mjs')));
  assert.equal(result.collector_sha256, fingerprint(result.collector_files));
  const changed = new Map(sources); changed.set('evidence/helper.mjs', Buffer.from('export const helper = 2;\n'));
  assert.notEqual((await archivedCollectionInstrumentation(execution, changed)).collector_sha256, result.collector_sha256);
});
test('archival instrumentation refuses missing dependency bytes or a path escape', async () => {
  const execution = { environment_root: '/unused', conditions: {} };
  await assert.rejects(archivedCollectionInstrumentation(execution,
    new Map([['collect.mjs', Buffer.from("import './missing.mjs';\n")]])), /dependency is missing/);
  await assert.rejects(archivedCollectionInstrumentation(execution,
    new Map([['collect.mjs', Buffer.from("import '../../outside.mjs';\n")]])), /escapes/);
});


test('later unknown usage, a retained core stop and an unresolved run cannot be bypassed; business failure alone may continue', () => {
  const f = fixture(), third = { ...f.plan.slots[1], slot_id: 'slot-2', pair_id: 'pair-2', order: 2 };
  f.plan.slots.push(third);
  const next = { type: 'episode_started', ...third, run_id: 'gate-003', budget_id: 'budget' };
  const prefix = [f.open, f.complete(0), f.close, f.open, f.next];
  assert.throws(() => f.check([...prefix, next]), /unresolved/);
  for (const change of [{ stop_batch: true }, { budget_usage: { ...f.usage, input_tokens: null } }])
    assert.throws(() => f.check([...prefix, f.complete(1, change), next]), /stop or unknown/);
  assert.equal(f.check([...prefix, f.complete(1, { grade: 'fail', stop_batch: false }), next]).active, true);
  assert.throws(() => f.check([f.open, f.complete(0), f.close, f.open, next]), /frozen dispatch order/);
});
test('legacy absent registration permits sibling temporary control and environment roots', async () => {
  const root = join(tmpdir(), 'benchmark-collection-recovery-absent-' + randomUUID()), plan = fixture().plan;
  plan.execution.environment_root = join(root, 'environment');
  plan.execution.control_root = join(root, 'legacy-control');
  assert.equal(await verifyCollectionRecoveryResults(plan, [{ run_id: 'legacy', result: { status: 'retained' } }]), null);
  await assert.rejects(verifyCollectionRecoveryResults(plan,
    [{ run_id: 'legacy', result: { collection_recovery: reference } }]), /lost its registration/);
});

test('standing closeout retains one invalid zero-send completion and can never dispatch another slot', () => {
  const f = fixture();
  f.repairs[0].budget_usage = { model_requests: 0, input_tokens: 0, output_tokens: 0, duration_ms: 47870.911792 };
  const complete = changes => f.complete(0, { status: 'invalid', stop_batch: true, budget_usage: f.repairs[0].budget_usage, ...changes });
  const check = suffix => validateCollectionRecoveryLedger({ plan: f.plan, bytes: encode([...f.rows, ...suffix]),
    prefix: f.prefix, reference, repairs: f.repairs, closeoutOnly: true });
  const result = check([f.open, complete(), f.close]);
  assert.equal(result.original_recovered, true); assert.equal(result.zero_send_batch_closed, true);
  assert.equal(result.completed.length, 1);
  assert.throws(() => check([f.open, complete(), f.close, f.open, f.next]), /cannot dispatch/);
  for (const changed of [{ status: 'completed' }, { stop_batch: false },
    { budget_usage: { ...f.repairs[0].budget_usage, duration_ms: 0 } },
    { budget_usage: { ...f.repairs[0].budget_usage, input_tokens: null } }])
    assert.throws(() => check([f.open, complete(changed), f.close]));
});

test('future adapter ownership preserves raw proof bytes, source identity and exclusive owned output', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-adapter-ownership-')));
  t.diagnostic('Retained task-owned fixture: ' + root);
  const environmentRoot = join(root, 'owned'); await mkdir(environmentRoot);
  const source = join(root, 'original.json'), directory = join(environmentRoot, 'control/adapter');
  const bytes = Buffer.from('{ "version": 1, "controlled": true }\n'); await writeFile(source, bytes);
  const args = { source, sha256: sha(bytes), directory, environmentRoot };
  const first = await prepareAdapterEvidenceOwnership(args);
  assert.deepEqual(await readFile(first.owned.path), bytes);
  assert.deepEqual(await readFile(source), bytes);
  assert.equal(first.original.path, source); assert.equal(first.owned.sha256, first.original.sha256);
  assert.deepEqual(await prepareAdapterEvidenceOwnership(args), first);
  await assert.rejects(prepareAdapterEvidenceOwnership({ ...args, sha256: hash }), /adapter evidence changed/);
  const linked = join(root, 'linked.json'); await symlink(source, linked);
  await assert.rejects(prepareAdapterEvidenceOwnership({ ...args, source: linked }), /ordinary file/);
  await assert.rejects(prepareAdapterEvidenceOwnership({ ...args, directory: join(root, 'outside') }), /escapes/);
  await writeFile(first.owned.path, 'different');
  await assert.rejects(prepareAdapterEvidenceOwnership(args), /overwrite/);
});

function providerTrace(runId, rows = []) {
  let previous = null;
  const values = [{ phase: 'transport_start' }, ...rows, { phase: 'transport_end', complete: true,
    attempts: rows.filter(row => row.phase === 'request_start').length, errors: 0, incompleteRequestIds: [], pendingForkRebind: false }];
  return values.map((value, index) => {
    const row = { version: 1, sequence: index + 1, previousSha256: previous, clockId: runId, monotonicNs: String(index + 1), ...value };
    row.eventSha256 = sha(JSON.stringify(row)); previous = row.eventSha256; return JSON.stringify(row);
  }).join('\n') + '\n';
}

test('standing raw closeout independently verifies complete transport and refuses any send, unknown usage or different rejection', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-standing-raw-closeout-')));
  t.diagnostic('Retained task-owned fixture: ' + root);
  const input = rawFixture(), runId = input.run.run_id;
  input.plan.execution.environment_root = root;
  input.plan.execution.standing_scope = { kind: 'benchmark-standing-campaign' };
  input.run.root = input.shared.root = join(root, 'runs', runId);
  input.run.build_root = join(root, 'builds', 'build');
  input.shared.status = 'failed'; input.shared.exit_code = 1;
  Object.assign(input.runtime, { status: 'invalid', admission: { status: 'pending' }, requests: [], turns: [], interventions: [],
    error: { name: 'AssertionError', code: 'ERR_ASSERTION', message: 'BENCHMARK_NOTION_STARTUP_PENDING' },
    budget: { requests: 0, attempts: 0, tools: 0, input_tokens: 0, output_tokens: 0, tokens: 0, usage_unknown: false, stop: null } });
  input.runtime.completion.agent_settled = false; input.runtime.timing.duration_ms = 47870.911792;
  input.transportPath = join(input.run.root, 'benchmark/runtime/transport.jsonl');
  await mkdir(join(input.run.root, 'benchmark/runtime'), { recursive: true });
  const trace = providerTrace(runId, [{ phase: 'request_start', id: 1, category: 'other' },
    { phase: 'request_end', id: 1, category: 'other', outcome: 'failure' }]);
  await writeFile(input.transportPath, trace);
  assert.deepEqual(await validateStandingZeroSendCollectionRaw(input), { model_requests: 0, input_tokens: 0, output_tokens: 0, duration_ms: 47870.911792 });
  for (const mutate of [x => x.runtime.budget.requests = 1, x => x.runtime.budget.input_tokens = 1,
    x => x.runtime.budget.usage_unknown = true, x => x.runtime.requests.push({}), x => x.runtime.turns.push({}),
    x => x.runtime.coverage.attempts = 'partial', x => x.runtime.completion.cleanup.dispose_called = false,
    x => x.runtime.error.message = 'different failure', x => x.shared.timed_out = true,
    x => x.runtime.timing.duration_ms = null, x => x.runtime.correlation.candidate_id = 'other']) {
    const changed = structuredClone(input); mutate(changed);
    await assert.rejects(validateStandingZeroSendCollectionRaw(changed));
  }
  await writeFile(input.transportPath, providerTrace(runId, [{ phase: 'request_start', id: 1, category: 'model' },
    { phase: 'request_end', id: 1, category: 'model', outcome: 'completed' }]));
  await assert.rejects(validateStandingZeroSendCollectionRaw(input), /zero model transport/);
  await writeFile(input.transportPath, trace.replace('"complete":true', '"complete":false'));
  await assert.rejects(validateStandingZeroSendCollectionRaw(input), /PROVIDER_TRACE_INVALID/);
  await writeFile(input.transportPath, trace.trimEnd());
  await assert.rejects(validateStandingZeroSendCollectionRaw(input), /PROVIDER_TRACE_TRUNCATED/);
  assert.throws(() => validateCollectionRecoveryRaw(input), 'The paid gate still requires a completed paid run');
});
