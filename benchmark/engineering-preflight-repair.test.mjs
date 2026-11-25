import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint } from './protocol.mjs';
import { engineeringRemainingBudget, ENGINEERING_WINDOW_REVISION, ENGINEERING_WINDOW_SCIENCE,
  isEngineeringContinuationAuthority } from './campaign-engineering-window-continuation.mjs';
import { ENGINEERING_PREFLIGHT_REPAIR_DRAFT, ENGINEERING_PREFLIGHT_REPAIR_REVISION, ENGINEERING_PREFLIGHT_REPAIR_OWNER,
  deriveEngineeringPreflightRepair, assertEngineeringNativeZeroSend, readEngineeringPreflightRepairDecision,
  prepareEngineeringPreflightRepairDraft, readEngineeringPreflightZeroSend } from './campaign-engineering-preflight-repair.mjs';
import { approvedCampaignBinding } from './approved-campaign.mjs';
import { authorizedScope, FINITE_CAMPAIGN } from './finite-campaign.mjs';
import { assertEngineeringRunnerAuthority } from './engineering-runner.mjs';
import { configureComparison } from './configure.mjs';
import { benchmarkMain, parseBenchmarkArgs } from './cli.mjs';
import { executionImplementation } from './implementation.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const ref = name => ({ path: '/synthetic/' + name, sha256: sha(name) });
const seal = (value, key) => { value[key] = fingerprint({ ...value, [key]: null }); return value; };
async function temporary(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'engineering-preflight-repair-test-')));
  if (process.platform === 'darwin') t.after(() => execFileSync('/usr/bin/trash', [path]));
  return path;
}
async function save(path, value) {
  const bytes = JSON.stringify(value, null, 2) + '\n'; await writeFile(path, bytes);
  return { path, sha256: sha(bytes) };
}
async function absent(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }

function parentFixture() {
  const budget = { id: 'original', episode: { max_duration_ms: 180000, max_model_requests: 10, max_input_tokens: 300000,
    max_output_tokens: 16000, max_http_attempts: 10, max_retries: 0 },
    batch: { max_episodes: 24, max_model_requests: 240, max_input_tokens: 7200000, max_output_tokens: 384000,
      max_duration_ms: 5100000, max_concurrency: 1 }, monetary: { status: 'not_available' } };
  const completed = Array.from({ length: 7 }, (_, i) => ({ result: { budget_usage: {
    model_requests: i ? 4 : 7, input_tokens: i ? 17000 : 18222, output_tokens: i ? 400 : 468, duration_ms: i ? 25000 : 27348.906042 } } }));
  const source = { plan_sha256: sha('source'), slots: Array.from({ length: 24 }, (_, i) => ({ slot_id: 'slot-' + i, order: i })),
    protocol: { policies: { budgets: [budget] } } };
  const transition = { source_allocation_id: 'continuation-codemode-24', allocation_id: 'engineering-codemode-window-17-1',
    experiment_id: 'benchmark-codemode-window-17-1', source_plan: ref('source-plan'), source_ledger: ref('source-ledger'),
    source_plan_sha256: source.plan_sha256, source_limit: 24, source_spent: 7, remaining: 17,
    selection: { source_plan_sha256: source.plan_sha256, slot_ids: source.slots.slice(7).map(s => s.slot_id) } };
  const allocations = [{ id: transition.allocation_id, work_index: 4, role: 'engineering_window_continuation', reservation_limit: 17 },
    ...Array.from({ length: 5 }, (_, i) => ({ id: 'scale-' + i, work_index: 5, role: 'acceptance', reservation_limit: 2 })),
    { id: 'fault8', work_index: 6, role: 'acceptance', reservation_limit: 8 }];
  const start = Date.now() - 7200000, window = { mode: 'single_new_24h', start: new Date(start).toISOString(), end: new Date(start + 86400000).toISOString() };
  const history = { scheduled_episodes: 104, episodes: Array.from({ length: 104 }, (_, i) => ({ experiment_id: 'old', run_id: 'old-' + i })),
    reservations: Array.from({ length: 104 }, (_, i) => ({ ordinal: i + 1, reference: ref('reservation-' + i) })), plans: [],
    unknown_usage_run_ids: Array.from({ length: 6 }, (_, i) => 'unknown-' + i) };
  const carryover = engineeringRemainingBudget(budget, completed);
  const value = seal({ version: 7, kind: 'benchmark-approved-prospective-campaign', id: 'v7-parent',
    user_approval: ref('original-decision'), proposal: ref('original-proposal'), predecessor: { registration: ref('registration13'), amendment: ref('amendment13') },
    environment_root: '/synthetic/environment', pilot_ledger_root: '/synthetic/ledger', history, history_checkpoint_sha256: fingerprint(history),
    max_scheduled_episodes: 144, new_reservation_ceiling: 35, total_reservation_ceiling: 139, allocations,
    revision: { kind: ENGINEERING_WINDOW_REVISION, parent_authorization: ref('authority6'), partial_allocation: transition, resource_carryover: carryover, model_window: window },
    authorization_sha256: null }, 'authorization_sha256');
  return { value, engineeringContinuation: { source, scopes: [{}, { completed }], transition, allocations,
    resourceCarryover: carryover, remainingBudget: carryover.remaining_budget, science: structuredClone(ENGINEERING_WINDOW_SCIENCE), modelWindow: window } };
}

test('the sole v8 repair replaces only the unactivated Code17 owner and refunds no Code7 costs', () => {
  const parent = parentFixture(), before = structuredClone(parent), result = deriveEngineeringPreflightRepair(parent);
  assert.deepEqual(parent, before); assert.deepEqual(result.transition, { ...before.engineeringContinuation.transition, ...ENGINEERING_PREFLIGHT_REPAIR_OWNER });
  assert.deepEqual(result.allocations.slice(1), before.value.allocations.slice(1));
  assert.equal(result.allocations.reduce((n, a) => n + a.reservation_limit, 0), 35);
  assert.deepEqual(parent.engineeringContinuation.remainingBudget.batch, { max_episodes: 17, max_model_requests: 209,
    max_input_tokens: 7079778, max_output_tokens: 381132, max_duration_ms: 4922651, max_concurrency: 1 });
  for (const mutate of [p => { p.value.version = 8; }, p => { p.value.version = 6; },
    p => { p.value.allocations[0].id = ENGINEERING_PREFLIGHT_REPAIR_OWNER.allocation_id; },
    p => { p.engineeringContinuation.transition.experiment_id = 'different'; },
    p => { p.value.new_reservation_ceiling = 36; }, p => { p.value.history.scheduled_episodes = 105; },
    p => { p.engineeringContinuation.transition.selection.slot_ids.reverse(); },
    p => { p.engineeringContinuation.science.cross_window_pairing = true; },
    p => { p.engineeringContinuation.remainingBudget.batch.max_model_requests++; },
    p => { p.engineeringContinuation.scopes[1].completed.pop(); }]) {
    const changed = structuredClone(before); mutate(changed); assert.throws(() => deriveEngineeringPreflightRepair(changed));
  }
});

function nativeFixture() {
  const runId = 'benchmark-codemode-window-17-1-capture-m0-e1-c0';
  const budget = { requests: 0, attempts: 0, tools: 0, input_tokens: 0, output_tokens: 0, tokens: 0, usage_unknown: false, stop: null };
  const child = { status: 'passed', exit_code: 0, spawned: true, timed_out: false, signal: null, runtime_check: { status: 'unchanged' } };
  const episode = { status: 'captured', admission: { status: 'captured_not_authorized' }, budget,
    coverage: { attempts: 'complete', tools: 'complete', interventions: 'complete', notion_sdk: 'complete', notion_owned_http: 'complete' },
    requests: [{ attempts: [], accounted: false }] };
  const transport = ['transport_start', 'model_selected', 'session_shutdown', 'transport_end'].map((phase, i) => ({ phase,
    sequence: i + 1, previousSha256: i ? sha('event-' + (i - 1)) : null, eventSha256: sha('event-' + i) }));
  Object.assign(transport.at(-1), { complete: true, attempts: 0, errors: 0, pendingForkRebind: false, incompleteRequestIds: [] });
  const events = [
    { type: 'runtime_start', data: { pid: 1234 } },
    { type: 'provider_send_blocked', data: { error: { code: 'BENCHMARK_ADMISSION_CAPTURE_COMPLETE' } } },
    { type: 'transport_reconciliation', data: { model_http_requests: 0, guarded_fetch_attempts: 0, complete: true, transport_validation: transport } },
    { type: 'runtime_end', data: { status: 'captured', budget, coverage: episode.coverage,
      cleanup: { abort_settled: true, shutdown_emitted: true, dispose_called: true } } },
  ].map((e, i) => ({ ...e, sequence: i + 1, run_id: runId }));
  return { runId, child, episode, events, transport, process: { pid: 1234, process_group: 1234 },
    capture: { status: 'captured', dispatch_error: null, stop_batch: false, shared: child, episode } };
}

test('one captured payload proves zero sends only with the actual settled zero-attempt terminal and transport', () => {
  assertEngineeringNativeZeroSend(nativeFixture());
  for (const mutate of [x => { x.episode.budget.attempts = 1; }, x => { x.episode.budget.usage_unknown = true; },
    x => { delete x.episode.coverage.attempts; },
    x => { x.episode.requests[0].attempts.push({ status: 'sent' }); }, x => { x.child.spawned = false; },
    x => { x.events[2].data.model_http_requests = 1; }, x => { x.events[2].data.guarded_fetch_attempts = 1; },
    x => { x.events[2].data.complete = false; }, x => { x.events[1].data.error.code = 'OTHER_FAILURE'; },
    x => { x.transport.at(-1).complete = false; }, x => { x.transport.at(-1).attempts = 1; },
    x => { x.transport.at(-1).incompleteRequestIds.push('pending'); }, x => { x.transport[1].previousSha256 = sha('wrong'); },
    x => { x.events.at(-1).data.cleanup.abort_settled = false; }, x => { x.events.pop(); }]) {
    const changed = nativeFixture(); mutate(changed); assert.throws(() => assertEngineeringNativeZeroSend(changed));
  }
});

async function decisionFixture(root) {
  const parent = parentFixture(), now = Date.now(), derived = deriveEngineeringPreflightRepair(parent);
  const draft = seal({ version: 1, kind: ENGINEERING_PREFLIGHT_REPAIR_DRAFT, id: 'synthetic-repair', approved: false, execution_authority: null,
    parent_authorization: ref('v7-parent'), controller_source: ref('reviewed-new-controller'), zero_send_proof: ref('independent-zero-send-proof'),
    zero_send_review_record: ref('independent-review-record'), retained_attempt: { claim: ref('retained-claim'), receipt: ref('retained-stopped-receipt'), binding: ref('retained-binding') },
    continuation: structuredClone(ENGINEERING_PREFLIGHT_REPAIR_OWNER), transition: derived.transition, model_window: parent.engineeringContinuation.modelWindow,
    stopped_at: new Date(now - 3600000).toISOString(), zero_send_reviewed_at: new Date(now - 3000000).toISOString(),
    automatic_retry: false, automatic_renewal: false, proposal_sha256: null }, 'proposal_sha256');
  const draftReference = await save(join(root, 'draft.json'), draft);
  const decision = { version: 1, kind: 'user-approved-engineering-preflight-repair', approved: true, source: 'current-user-message',
    user_message: 'SYNTHETIC OFFLINE FIXTURE ONLY; no actual approval or model execution.', recorded_at_utc: new Date(now - 60000).toISOString(),
    approved_draft: draftReference, parent_authorization: draft.parent_authorization, controller_source: draft.controller_source,
    zero_send_proof: draft.zero_send_proof, zero_send_review_record: draft.zero_send_review_record,
    retained_claim: draft.retained_attempt.claim, retained_receipt: draft.retained_attempt.receipt, continuation: draft.continuation,
    accepted_history_reservations: 104, registration_sequence: 13, approved_remaining_reservations: 35, total_reservation_ceiling: 139, max_scheduled_episodes: 144,
    model_window: { start: draft.model_window.start, end: draft.model_window.end, automatic_renewal: false },
    future_stop_policy: { core: 'stop', usage_unknown: 'stop', retry: false, renew_window: false } };
  return { draft, draftReference, decision };
}

test('the separate explicit decision inherits exact window bytes and cannot reuse v7 approval, renew, backdate or claim a future approval', async t => {
  const root = await temporary(t), f = await decisionFixture(root);
  const good = await save(join(root, 'decision.json'), f.decision);
  assert.deepEqual((await readEngineeringPreflightRepairDecision(f.draftReference, good)).decision, f.decision);
  const mutations = [d => { d.kind = 'user-approved-engineering-window-continuation'; }, d => { d.approved = false; },
    d => { d.source = 'prior-user-message'; }, d => { d.approved_draft.sha256 = sha('changed'); },
    d => { d.zero_send_proof.sha256 = sha('replacement-proof'); }, d => { d.retained_claim = ref('new-claim'); },
    d => { d.continuation.experiment_id = 'benchmark-codemode-window-17-1'; },
    d => { d.model_window.end = new Date(Date.parse(d.model_window.end) + 1).toISOString(); },
    d => { d.model_window.start = d.recorded_at_utc; d.model_window.end = new Date(Date.parse(d.recorded_at_utc) + 86400000).toISOString(); },
    d => { d.future_stop_policy.retry = true; }, d => { d.model_window.automatic_renewal = true; },
    d => { d.recorded_at_utc = new Date(Date.parse(f.draft.stopped_at) - 1).toISOString(); },
    d => { d.recorded_at_utc = new Date(Date.parse(f.draft.zero_send_reviewed_at) - 1).toISOString(); },
    d => { d.recorded_at_utc = f.draft.model_window.end; }, d => { d.recorded_at_utc = new Date(Date.now() + 60000).toISOString(); },
    d => { d.approved_remaining_reservations = 36; }];
  for (const [i, mutate] of mutations.entries()) {
    const changed = structuredClone(f.decision); mutate(changed);
    await assert.rejects(readEngineeringPreflightRepairDecision(f.draftReference, await save(join(root, 'bad-' + i + '.json'), changed)));
  }
});

test('repair preparation rejects a v8 parent and unsigned drafts before creating setup or authority output', async t => {
  const root = await temporary(t), f = await decisionFixture(root), parent = await save(join(root, 'parent8.json'), { version: 8 });
  await assert.rejects(prepareEngineeringPreflightRepairDraft({ id: 'repair', parent_authorization: parent,
    controller_source: ref('unused-source'), zero_send_proof: ref('unused-proof'), zero_send_review_record: ref('unused-review') }), /PARENT_V7_ONLY/);
  const controlRoot = join(root, 'control'), setup = { version: 1, environment_root: root, control_root: controlRoot,
    candidates: [{}, {}], corpus: {}, budget: {}, decision: {}, models: {},
    campaign_scope: { role: 'engineering_window_continuation', prospective_authorization: f.draftReference } };
  await assert.rejects(configureComparison(setup), /PREFLIGHT_REPAIR_DRAFT_NOT_DISPATCHABLE/); await absent(controlRoot);
  const output = join(root, 'authority.json'), denied = { ...f.decision, approved: false };
  const decision = await save(join(root, 'denied.json'), denied);
  await assert.rejects(benchmarkMain(['prepare-engineering-preflight-repair', '--draft', f.draftReference.path, '--decision', decision.path, '--out', output]), /EXPLICIT_APPROVAL_REQUIRED/);
  await absent(output);
});

test('a zero-send summary without retained reviewed raw references cannot authorize a repair', async t => {
  const root = await temporary(t); await mkdir(join(root, 'control'));
  const proof = { version: 1, kind: 'independent-stopped-engineering-invocation-review', status: 'passed', findings: [], authority: ref('parent'),
    configure_calls: 1, capture_attempts_retained: 3, capture_design_total: 4, captures_completed: 1, subject_runner_calls: 0,
    normal_analysis_calls: 0, new_reservations: 0, new_registrations: 0, new_closed_observations: 0, independently_established_subject_model_sends: 0,
    zero_send_inferred_from_reservation_count: false, claim_retained: true, later_captures_not_retried: true,
    retry_resume_or_window_renewal_performed: false, successor_dispatch_allowed_by_this_review: false, checked_references: [] };
  await assert.rejects(readEngineeringPreflightZeroSend({ parent: { value: { environment_root: root } }, parentReference: ref('parent'),
    proofReference: await save(join(root, 'control/proof.json'), proof), reviewRecordReference: { path: join(root, 'control/review.json'), sha256: sha('unused') } }));
});

function childFixture() {
  const parent = parentFixture(), derived = deriveEngineeringPreflightRepair(parent), reference = ref('authority8');
  const value = seal({ ...structuredClone(parent.value), version: 8, id: 'repair', allocations: derived.allocations,
    revision: { kind: ENGINEERING_PREFLIGHT_REPAIR_REVISION, parent_authorization: ref('authority7'), next_allocation_id: derived.allocations[0].id },
    authorization_sha256: null }, 'authorization_sha256');
  const authorized = { value, engineeringPreflightRepair: { parent, parentReference: ref('authority7') }, engineeringContinuation: { ...parent.engineeringContinuation, ...derived } };
  const scope = i => ({ version: 2, id: value.allocations[i].id, role: value.allocations[i].role, reservation_limit: value.allocations[i].reservation_limit,
    prospective_authorization: approvedCampaignBinding(reference, value, value.allocations[i].id), predecessor: structuredClone(value.predecessor),
    environment_root: value.environment_root, pilot_ledger_root: value.pilot_ledger_root, history: structuredClone(value.history) });
  const context = () => ({ engineering: authorized, engineeringReference: reference, authorized: { value: { version: 6 } }, reference: ref('authority6'), allocations: new Set() });
  return { parent, authorized, reference, scope, context };
}

test('finite dispatch crosses only the proved unactivated v7 parent after the registered v6 predecessor and retains all allocation guards', async () => {
  const f = childFixture(); assert.equal(await authorizedScope(f.scope(0), f.context()), f.authorized);
  const smaller = f.scope(0); smaller.reservation_limit = 16;
  await assert.rejects(authorizedScope(smaller, f.context()), /EXACT_ALLOCATION_REQUIRED/);
  const wrong = f.scope(0); wrong.predecessor.registration = ref('unrelated-registration');
  await assert.rejects(authorizedScope(wrong, { ...f.context(), authorized: f.authorized, reference: f.reference }), /INITIAL_PREDECESSOR_CHANGED/);
  const skipped = f.scope(1); await assert.rejects(authorizedScope(skipped, f.context()), /NEXT_ALLOCATION_FIRST/);
  const repeated = { ...f.context(), allocations: new Set([f.scope(0).id]) };
  await assert.rejects(authorizedScope(f.scope(0), repeated), /ALLOCATION_REUSED/);
  await assert.rejects(authorizedScope(f.scope(0), { ...f.context(), reference: ref('unrelated-ancestor') }), /LINEAGE_CHANGED/);
  await assert.rejects(authorizedScope(f.scope(0), { ...f.context(), reference: ref('authority7') }), /LINEAGE_CHANGED/);
  const advanced = f.scope(0); advanced.history.scheduled_episodes++;
  advanced.history.episodes.push({ experiment_id: 'current-v8', run_id: 'new-105' }); advanced.history.reservations.push({ ordinal: 105 });
  assert.equal(await authorizedScope(advanced, f.context()), f.authorized);
});

test('v8 cannot skip a prior scale allocation or use a predecessor belonging to another authority', async t => {
  const root = await temporary(t), f = childFixture(), priorRoot = join(root, 'prior'); await mkdir(priorRoot);
  const history = structuredClone(f.authorized.value.history), slots = [{ slot_id: 'one' }, { slot_id: 'two' }];
  const prior = seal({ version: 2, kind: FINITE_CAMPAIGN, id: 'scale-1', role: 'acceptance', authorization: 'SYNTHETIC OFFLINE FIXTURE', registered_at: new Date().toISOString(),
    predecessor: f.authorized.value.predecessor, environment_root: root, pilot_ledger_root: '/synthetic/ledger', max_scheduled_episodes: 144, reservation_limit: 2,
    history, history_exemption: { scheduled_episodes: 13, unknown_usage_run_ids: ['a', 'b', 'c'], checkpoint_sha256: sha('legacy13') },
    prospective_authorization: approvedCampaignBinding(f.reference, f.authorized.value, 'scale-1'), model_conditions: [], environment_conditions: [],
    models_sha256: sha('models'), instrumentation: {}, observer_version: '1.1', plan: { experiment_id: 'scale1', control_root: priorRoot, phase: 'pilot',
      protocol_sha256: sha('protocol'), execution_sha256: sha('execution'), slots_sha256: fingerprint(slots), scheduled_episodes: 2, slots }, amendment_sha256: null }, 'amendment_sha256');
  const amendment = await save(join(priorRoot, 'finite-campaign-amendment.json'), prior);
  const registration = await save(join(root, 'registration.json'), { id: prior.id, amendment });
  const scope = f.scope(1); scope.predecessor = { amendment, registration };
  await assert.rejects(authorizedScope(scope, { ...f.context(), authorized: f.authorized, reference: f.reference }), /ALLOCATION_ORDER/);
  const next = f.scope(3); next.predecessor = { amendment, registration };
  prior.prospective_authorization.reference = ref('foreign-authority'); seal(prior, 'amendment_sha256');
  next.predecessor.amendment = await save(join(priorRoot, 'finite-campaign-amendment.json'), prior);
  next.predecessor.registration = await save(join(root, 'registration.json'), { id: prior.id, amendment: next.predecessor.amendment });
  await assert.rejects(authorizedScope(next, { ...f.context(), authorized: f.authorized, reference: f.reference }), /PREDECESSOR_AUTHORITY_CHANGED/);
});

test('v7 and v8 runners have separate public entry points and the new verifier stays in the static implementation closure', async () => {
  const f = childFixture(); assertEngineeringRunnerAuthority(f.parent, 7); assertEngineeringRunnerAuthority(f.authorized, 8);
  assert.throws(() => assertEngineeringRunnerAuthority(f.authorized, 7), /ENTRYPOINT_AUTHORITY_MISMATCH/);
  assert.throws(() => assertEngineeringRunnerAuthority(f.parent, 8), /ENTRYPOINT_AUTHORITY_MISMATCH/);
  assert.equal(isEngineeringContinuationAuthority({ version: 9, revision: { kind: ENGINEERING_PREFLIGHT_REPAIR_REVISION } }), false);
  assert.equal(isEngineeringContinuationAuthority({ version: 8, revision: { kind: 'unknown' } }), false);
  assert.equal(parseBenchmarkArgs(['run-engineering-preflight-repair', '--plan', '/plan', '--out', '/runner', '--limit', '8']).action, 'run-engineering-preflight-repair');
  assert.throws(() => parseBenchmarkArgs(['run-engineering-preflight-repair', '--retry', 'true']));
  const implementation = await executionImplementation(); assert.ok(implementation.files.some(f => f.path === 'campaign-engineering-preflight-repair.mjs'));
});
