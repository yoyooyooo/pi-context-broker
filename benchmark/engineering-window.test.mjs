import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint } from './protocol.mjs';
import { declaredSchedule, scheduleProtocol, ENGINEERING_WINDOW_CONTINUATION } from './campaign-selection.mjs';
import { startupCaptureSchedule, configureComparison } from './configure.mjs';
import { assertSubjectModelWindow } from './controller.mjs';
import { benchmarkMain } from './cli.mjs';
import { executionImplementation } from './implementation.mjs';
import { ENGINEERING_WINDOW_DRAFT, ENGINEERING_WINDOW_REVISION, deriveEngineeringWindowTransition,
  engineeringRemainingBudget, readEngineeringWindowDecision, assertEngineeringWindowCurrentBoundary,
  assertEngineeringWindowSetup } from './campaign-engineering-window-continuation.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ref = name => ({ path: '/synthetic/' + name, sha256: sha(name) });
const seal = (value, key) => { value[key] = fingerprint({ ...value, [key]: null }); return value; };
async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'engineering-window-test-')));
  if (process.platform === 'darwin') t.after(() => execFileSync('/usr/bin/trash', [root]));
  return root;
}
async function save(path, value) { const bytes = JSON.stringify(value, null, 2) + '\n'; await writeFile(path, bytes); return { path, sha256: sha(bytes) }; }
async function absent(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }
function budget() {
  return { id: 'original', episode: { max_duration_ms: 180000, max_model_requests: 10, max_input_tokens: 300000,
    max_output_tokens: 16000, max_http_attempts: 10, max_retries: 0 },
    batch: { max_episodes: 24, max_model_requests: 240, max_input_tokens: 7200000, max_output_tokens: 384000,
      max_duration_ms: 5100000, max_concurrency: 1 }, monetary: { status: 'not_available' } };
}
function completions(count = 7) {
  return Array.from({ length: count }, (_, index) => ({ run_id: 'source-' + (index + 1), result: { status: 'completed', stop_batch: false, stop_reason: null,
    budget_usage: { model_requests: index ? 4 : 7, input_tokens: index ? 17000 : 18222, output_tokens: index ? 400 : 468,
      duration_ms: index ? 25000 : 27348.906042 } } }));
}
function sourceFixture() {
  const allocations = [{ id: 'own8', work_index: 3, role: 'confirmation_continuation', reservation_limit: 8 },
    { id: 'code24', work_index: 4, role: 'acceptance', reservation_limit: 24 },
    ...Array.from({ length: 5 }, (_, index) => ({ id: 'scale-' + index, work_index: 5, role: 'acceptance', reservation_limit: 2 })),
    { id: 'fault8', work_index: 6, role: 'acceptance', reservation_limit: 8 }];
  const protocol = { phase: 'pilot', purpose: 'environment_iteration', assessments: [],
    pairs: Array.from({ length: 12 }, (_, index) => ({ id: 'pair-' + index, case_id: 'case-' + index, condition_ids: ['native', 'broker'], repeat: 0, seed: index })),
    policies: { ordering: { seed: 'retained-order' }, budgets: [budget()], decision: { mode: 'descriptive' } } };
  const source = { id: 'source-code24', plan_sha256: sha('semantic-plan'), protocol, slots: declaredSchedule(protocol) };
  const own = { allocation: allocations[0], registration: { sequence: 12 }, plan: { id: 'source-own8' }, completed: completions(8) };
  const completed = completions(), rows = [{ type: 'batch_opened', clock_domain: 'old-clock', monotonic_ns: '1000000000' }];
  for (const item of completed) rows.push({ type: 'episode_started', run_id: item.run_id }, { type: 'episode_completed', ...item });
  rows.push({ type: 'batch_closed', clock_domain: 'old-clock', monotonic_ns: '5462711364500', reason: 'batch_budget_exhausted', new_episodes: 7 });
  const partial = { allocation: allocations[1], registration: { sequence: 13 }, plan: source, completed,
    planReference: ref('source-plan.json'), ledger: { rows, reference: ref('source-ledger.jsonl') } };
  const parent = seal({ version: 6, kind: 'benchmark-approved-prospective-campaign', allocations,
    history: { scheduled_episodes: 89, episodes: [{ experiment_id: 'older-plan' }] }, total_reservation_ceiling: 139, max_scheduled_episodes: 144 }, 'authorization_sha256');
  return { parent, scopes: [own, partial], continuation: { allocation_id: 'engineering17', experiment_id: 'new-window-code17' } };
}

test('resource carryover retains all seven costs and conservatively floors only the remaining allowance', () => {
  const source = budget(), rows = completions(), result = engineeringRemainingBudget(source, rows);
  assert.deepEqual(result.consumed_usage, { model_requests: 31, input_tokens: 120222, output_tokens: 2868,
    duration_ms: rows.reduce((sum, row) => sum + row.result.budget_usage.duration_ms, 0) });
  assert.deepEqual(result.remaining_budget.batch, { max_episodes: 17, max_model_requests: 209, max_input_tokens: 7079778,
    max_output_tokens: 381132, max_duration_ms: 4922651, max_concurrency: 1 });
  assert.deepEqual(result.remaining_budget.episode, source.episode); assert.deepEqual(result.remaining_budget.monetary, source.monetary);
  assert.ok(result.duration_rounding_ms > 0 && result.duration_rounding_ms < 1);
  assert.ok(result.remaining_budget.batch.max_duration_ms + result.consumed_usage.duration_ms <= source.batch.max_duration_ms);
  assert.equal(result.wallclock_policy, 'remaining_duration_cap_per_new_invocation');
  for (const mutate of [x => x.pop(), x => { x[0].result.budget_usage.input_tokens = null; },
    x => { x[0].result.budget_usage.duration_ms = -1; }, x => { x[0].result.budget_usage.model_requests = 239; }]) {
    const changed = structuredClone(rows); mutate(changed); assert.throws(() => engineeringRemainingBudget(source, changed));
  }
  assert.throws(() => engineeringRemainingBudget({ ...source, batch: { ...source.batch, max_episodes: 25 } }, rows));
});

test('the typed transition derives the exact seventeen suffix and preserves the untouched scale and fault allocations', () => {
  const input = sourceFixture(), result = deriveEngineeringWindowTransition(input.parent, input.scopes, input.continuation);
  assert.deepEqual(result.transition.selection.slot_ids, input.scopes[1].plan.slots.slice(7).map(slot => slot.slot_id));
  assert.equal(result.transition.selection.source_plan_sha256, input.scopes[1].plan.plan_sha256);
  assert.notEqual(result.transition.source_plan.sha256, result.transition.source_plan_sha256);
  assert.deepEqual(result.allocations.slice(1), input.parent.allocations.slice(2));
  assert.equal(result.allocations[0].role, ENGINEERING_WINDOW_CONTINUATION);
  assert.equal(result.allocations.reduce((sum, item) => sum + item.reservation_limit, 0), 35);
  assert.equal(104 + 35, input.parent.total_reservation_ceiling); assert.equal(input.parent.max_scheduled_episodes - 139, 5);
});

test('a partial Own scope, reused Own experiment, wrong source boundary or new stop cannot become an engineering transition', () => {
  for (const mutate of [
    x => { x.parent.version = 5; seal(x.parent, 'authorization_sha256'); },
    x => { x.continuation.experiment_id = x.scopes[0].plan.id; },
    x => { x.continuation.experiment_id = x.scopes[1].plan.id; },
    x => { x.continuation.experiment_id = 'older-plan'; },
    x => { x.continuation.allocation_id = 'own8'; },
    x => { x.scopes[0].completed.pop(); }, x => { x.scopes[1].completed.pop(); },
    x => { x.scopes[1].registration.sequence = 14; },
    x => { x.scopes[1].ledger.rows.at(-1).reason = 'subject_requested_stop'; },
    x => { x.scopes[1].ledger.rows.at(-1).monotonic_ns = '2000000000'; },
    x => { x.scopes[1].ledger.rows.at(-1).clock_domain = 'other'; },
    x => { x.scopes[1].completed[0].result.stop_batch = true; },
    x => { x.scopes[1].completed[0].result.budget_usage.input_tokens = null; },
    x => { x.scopes[1].plan.slots[8].case_id = 'changed'; },
  ]) { const input = sourceFixture(); mutate(input); assert.throws(() => deriveEngineeringWindowTransition(input.parent, input.scopes, input.continuation)); }
});

test('the declared scientific and startup design remains twenty-four while dispatch selects only seventeen', () => {
  const { scopes } = sourceFixture(), source = scopes[1].plan, protocol = structuredClone(source.protocol);
  protocol.policies.campaign = { role: ENGINEERING_WINDOW_CONTINUATION,
    selection: { source_plan_sha256: source.plan_sha256, slot_ids: source.slots.slice(7).map(slot => slot.slot_id) } };
  assert.deepEqual(declaredSchedule(protocol), source.slots);
  assert.deepEqual(scheduleProtocol(protocol), source.slots.slice(7).map((slot, order) => ({ ...slot, order })));
  assert.deepEqual(startupCaptureSchedule(protocol, [{ events: [] }]), source.slots);
  assert.throws(() => startupCaptureSchedule(protocol, [{ events: ['state-change'] }]));
  assert.throws(() => startupCaptureSchedule(protocol, [{ events: [] }], {}));
  const changed = structuredClone(protocol); changed.policies.campaign.selection.slot_ids.reverse(); assert.throws(() => scheduleProtocol(changed));
});

async function decisionFixture(root) {
  const source = sourceFixture(), derived = deriveEngineeringWindowTransition(source.parent, source.scopes, source.continuation);
  const draft = seal({ version: 1, kind: ENGINEERING_WINDOW_DRAFT, id: 'synthetic-draft', approved: false, execution_authority: null,
    parent_authorization: ref('parent.json'), checkpoint: ref('checkpoint.json'), controller_source: ref('composition.json'),
    predecessor: { registration: ref('registration13.json'), amendment: ref('amendment13.json') }, transition: derived.transition,
    model_window: { previous: { start: '2029-12-30T00:00:00.000Z', end: '2029-12-31T00:00:00.000Z' },
      proposed: { start: null, end: null }, duration_hours: 24, automatic_renewal: false } }, 'proposal_sha256');
  const draftReference = await save(join(root, 'draft.json'), draft);
  const decision = { version: 1, kind: 'user-approved-engineering-window-continuation', approved: true, source: 'current-user-message',
    user_message: 'SYNTHETIC OFFLINE FIXTURE ONLY; no real execution authority.', recorded_at_utc: '2030-01-01T00:00:00.000Z',
    approved_draft: draftReference, parent_authorization: draft.parent_authorization, checkpoint: draft.checkpoint,
    controller_source: draft.controller_source, predecessor: draft.predecessor, source_plan: draft.transition.source_plan, source_ledger: draft.transition.source_ledger,
    accepted_history_reservations: 104, registration_sequence: 13, approved_remaining_reservations: 35, total_reservation_ceiling: 139, max_scheduled_episodes: 144,
    model_window: { start: '2030-01-01T00:00:00.000Z', end: '2030-01-02T00:00:00.000Z', automatic_renewal: false },
    future_stop_policy: { core: 'stop', usage_unknown: 'stop', retry: false, renew_window: false } };
  return { draft, draftReference, decision, derived };
}

test('a separate decision binds the exact non-executable draft and a future exclusive twenty-four-hour window', async t => {
  const root = await temporary(t), fixture = await decisionFixture(root);
  const accepted = await readEngineeringWindowDecision(fixture.draftReference, await save(join(root, 'decision.json'), fixture.decision));
  assert.equal(accepted.draft.approved, false); assert.equal(accepted.draft.execution_authority, null);
  assert.deepEqual(accepted.draft.model_window.proposed, { start: null, end: null }); assert.equal(accepted.modelWindow.mode, 'single_new_24h');
  const mutations = [x => { x.approved = false; }, x => { delete x.approved; }, x => { x.approved_draft.sha256 = sha('other'); },
    x => { x.source_ledger.sha256 = sha('other'); }, x => { x.controller_source.sha256 = sha('other'); },
    x => { x.accepted_history_reservations = 105; }, x => { x.registration_sequence = 14; }, x => { x.approved_remaining_reservations = 36; },
    x => { x.model_window.end = '2030-01-03T00:00:00.000Z'; }, x => { x.recorded_at_utc = '2030-01-01T00:00:01.000Z'; },
    x => { x.model_window.automatic_renewal = true; }, x => { x.future_stop_policy.usage_unknown = 'continue'; }];
  for (const [index, mutate] of mutations.entries()) {
    const changed = structuredClone(fixture.decision); mutate(changed);
    await assert.rejects(readEngineeringWindowDecision(fixture.draftReference, await save(join(root, 'decision-bad-' + index + '.json'), changed)));
  }
  const model = { backend: { window: fixture.decision.model_window } }, start = Date.parse(model.backend.window.start), end = Date.parse(model.backend.window.end);
  assertSubjectModelWindow(model, start); assertSubjectModelWindow(model, end - 1);
  for (const now of [start - 1, end, NaN]) assert.throws(() => assertSubjectModelWindow(model, now));
});

test('draft, missing, false and mismatched approval fail before configure writes, captures or authority output', async t => {
  const root = await temporary(t); await mkdir(join(root, 'control'));
  const fixture = await decisionFixture(root), base = { version: 1, environment_root: root, candidates: [{ id: 'left' }, { id: 'right' }],
    budget: {}, decision: {}, models: {}, corpus: {}, campaign_scope: { id: 'engineering17', allocation_id: 'engineering17', role: ENGINEERING_WINDOW_CONTINUATION } };
  const draftSetup = { ...structuredClone(base), control_root: join(root, 'control/draft-setup') };
  draftSetup.campaign_scope.prospective_authorization = fixture.draftReference;
  await assert.rejects(configureComparison(draftSetup), /ENGINEERING_WINDOW_DRAFT_NOT_DISPATCHABLE/); await absent(draftSetup.control_root);
  const missing = { ...structuredClone(base), control_root: join(root, 'control/missing-setup') };
  await assert.rejects(configureComparison(missing), /ENGINEERING_WINDOW_APPROVAL_REQUIRED/); await absent(missing.control_root);
  for (const variant of ['false', 'missing', 'mismatched']) {
    const decision = structuredClone(fixture.decision);
    if (variant === 'false') decision.approved = false;
    if (variant === 'mismatched') decision.approved_draft.sha256 = sha('mismatched');
    const decisionReference = variant === 'missing' ? { path: join(root, 'absent-decision.json'), sha256: sha('missing') }
      : await save(join(root, 'decision-' + variant + '.json'), decision);
    const history = { scheduled_episodes: 104, episodes: Array.from({ length: 104 }, () => ({})), reservations: Array.from({ length: 104 }, () => ({})) };
    const value = seal({ version: 7, kind: 'benchmark-approved-prospective-campaign', id: 'synthetic-authority',
      environment_root: root, pilot_ledger_root: join(root, 'control/pilot'), user_approval: ref('original-decision'), proposal: ref('original-proposal'),
      predecessor: fixture.draft.predecessor, history, history_checkpoint_sha256: fingerprint(history), max_scheduled_episodes: 144,
      new_reservation_ceiling: 35, total_reservation_ceiling: 139, allocations: fixture.derived.allocations,
      revision: { kind: ENGINEERING_WINDOW_REVISION, draft: fixture.draftReference, user_approval: decisionReference,
        parent_authorization: fixture.draft.parent_authorization } }, 'authorization_sha256');
    const setup = { ...structuredClone(base), control_root: join(root, 'control/setup-' + variant) };
    setup.campaign_scope.prospective_authorization = await save(join(root, 'control/authority-' + variant + '.json'), value);
    await assert.rejects(configureComparison(setup)); await absent(setup.control_root);
    const out = join(root, 'authority-output-' + variant + '.json');
    await assert.rejects(benchmarkMain(['prepare-engineering-window', '--draft', fixture.draftReference.path, '--decision', decisionReference.path, '--out', out]));
    await absent(out);
  }
});

test('prospective preparation requires the exact104/13 physical boundary without an active lease', async t => {
  const root = await temporary(t);
  for (const variant of ['closed', 'advanced', 'registration', 'campaign-lease', 'scope-lease']) {
    const ledger = join(root, variant); await mkdir(ledger);
    for (let ordinal = 1; ordinal <= (variant === 'advanced' ? 105 : 104); ordinal++) await save(join(ledger, String(ordinal).padStart(3, '0') + '.json'), { ordinal });
    for (let sequence = 1; sequence <= (variant === 'registration' ? 14 : 13); sequence++)
      await save(join(ledger, sequence === 1 ? 'scope-registration.json' : 'scope-registration-' + String(sequence).padStart(3, '0') + '.json'), { sequence });
    if (variant === 'campaign-lease') await save(join(ledger, 'campaign.lease.json'), {});
    if (variant === 'scope-lease') await save(join(ledger, 'scope-source.lease.json'), {});
    if (variant === 'closed') await assertEngineeringWindowCurrentBoundary(ledger);
    else await assert.rejects(assertEngineeringWindowCurrentBoundary(ledger), /ENGINEERING_WINDOW_(BOUNDARY_ADVANCED|REGISTRY_ADVANCED|ACTIVE_LEASE)/);
  }
});

test('v7 and v8 setup preserve old science, apply residual resources only to CodeMode and bind the executing composition', async t => {
  const root = await temporary(t), window = { start: '2030-01-01T00:00:00Z', end: '2030-01-02T00:00:00Z' };
  const oldWindow = { start: '2029-12-30T00:00:00Z', end: '2029-12-31T00:00:00Z' };
  const original = { version: 1, id: 'source-code24', phase: 'pilot', purpose: 'environment_iteration', environment_root: root,
    control_root: join(root, 'control/original'), corpus: { seed: 'fixed', split: 'development', material_version: '2', selections: [{ caseId: 'references-01-a' }] },
    candidates: [{ id: 'broker', build_id: 'old', mode: 'broker', code_mode: 'free', source_kind: 'notion' }],
    models: { source_file: '/original/models.json', ids: ['auto/gpt-6.2-sol'], window: { start: null, end: null }, parameters: { maxTokens: 4096, thinking: 'medium' } },
    budget: budget(), runtime: { node: '/same/node', pi: '/same/pi', bun: '/same/bun' }, decision: { mode: 'descriptive' }, ordering_seed: 42,
    repetitions: 1, materialization_binding_file: null, campaign_scope: { kind: 'benchmark-finite-campaign', id: 'code24', role: 'acceptance', allocation_id: 'code24',
      authorization: 'original fixture approval', predecessor: { registration: null, amendment: null }, history_plan_files: null, prospective_authorization: null },
    proposal: { status: 'draft' }, analysis: { interactions: [] } };
  const originalReference = await save(join(root, 'original.json'), original), residual = engineeringRemainingBudget(original.budget, completions()).remaining_budget;
  const designs = { entries: [{ allocation_id: 'code24', reservations: 24, setup: originalReference, schedule: ref('schedule24') }] };
  const parent = { value: { version: 6, environment_root: root, revision: { model_window: oldWindow } },
    confirmationContinuation: { repair: { builds: [{ source: { id: 'old' }, target: { id: 'new' } }] }, engineeringDesigns: designs } };
  const selection = { source_plan_sha256: sha('plan24'), slot_ids: Array.from({ length: 17 }, (_, i) => 'slot-' + (i + 7)) };
  const authorized = { value: { version: 7, allocations: [{ id: 'engineering17', role: ENGINEERING_WINDOW_CONTINUATION, reservation_limit: 17 }] },
    engineeringContinuation: { parent, engineeringDesigns: designs, modelWindow: window, remainingBudget: residual,
      transition: { source_allocation_id: 'code24', allocation_id: 'engineering17', experiment_id: 'new-code17', selection },
      controllerImplementation: await executionImplementation() } };
  const setup = structuredClone(original); setup.id = 'new-code17'; setup.control_root = join(root, 'control/new'); setup.models.window = window;
  setup.models.source_file = '/owned/models.json'; setup.candidates[0].build_id = 'new'; setup.materialization_binding_file = '/owned/material.json'; setup.budget = residual;
  Object.assign(setup.campaign_scope, { id: 'engineering17', allocation_id: 'engineering17', role: ENGINEERING_WINDOW_CONTINUATION, selection,
    predecessor: { registration: 'bound', amendment: 'bound' }, history_plan_files: ['old-plan'], prospective_authorization: ref('authority7'), authorization: 'new fixture binding' });
  setup.proposal = { status: 'bound' };
  await assertEngineeringWindowSetup(setup, authorized);
  for (const mutate of [x => { x.budget = budget(); }, x => { x.models.window.end = '2030-01-03T00:00:00Z'; },
    x => { x.models.parameters.maxTokens = 8192; }, x => { x.models.parameters.thinking = 'high'; },
    x => { x.corpus.selections[0].caseId = 'another-case'; }, x => { x.candidates[0].code_mode = 'off'; },
    x => { x.analysis.interactions.push({ kind: 'new-scoring-claim' }); }, x => { x.campaign_scope.selection.slot_ids.reverse(); }]) {
    const changed = structuredClone(setup); mutate(changed); await assert.rejects(assertEngineeringWindowSetup(changed, authorized));
  }
  const repair = structuredClone(authorized); repair.value.version = 8; repair.value.revision = { kind: 'accepted-engineering-preflight-repair' };
  const repairId = 'engineering-codemode-window-17-2', repairExperiment = 'benchmark-codemode-window-17-2';
  repair.value.allocations[0].id = repairId;
  Object.assign(repair.engineeringContinuation.transition, { allocation_id: repairId, experiment_id: repairExperiment });
  const repairSetup = structuredClone(setup); repairSetup.id = repairExperiment;
  repairSetup.campaign_scope.id = repairSetup.campaign_scope.allocation_id = repairId;
  repairSetup.control_root = join(root, 'control/new-repair');
  await assertEngineeringWindowSetup(repairSetup, repair);
  for (const mutate of [x => { x.id = 'benchmark-codemode-window-17-1'; },
    x => { x.campaign_scope.allocation_id = 'engineering-codemode-window-17-1'; },
    x => { x.campaign_scope.selection.slot_ids.reverse(); }, x => { x.budget.batch.max_model_requests++; },
    x => { x.models.window.end = '2030-01-03T00:00:00Z'; }, x => { x.models.parameters.maxTokens = 8192; },
    x => { x.runtime.node = '/changed/node'; }]) {
    const changed = structuredClone(repairSetup); mutate(changed); await assert.rejects(assertEngineeringWindowSetup(changed, repair));
  }
  const wrongSource = structuredClone(authorized); wrongSource.engineeringContinuation.controllerImplementation.sha256 = sha('wrong-source');
  await assert.rejects(assertEngineeringWindowSetup(setup, wrongSource), /ENGINEERING_WINDOW_EXECUTING_SOURCE_CHANGED/);
  const scale = structuredClone(original); scale.id = 'original-scale2'; scale.campaign_scope.id = scale.campaign_scope.allocation_id = 'scale2';
  scale.budget.batch.max_episodes = 2; scale.budget.batch.max_model_requests = 20;
  designs.entries.push({ allocation_id: 'scale2', reservations: 2, setup: await save(join(root, 'scale-original.json'), scale), schedule: ref('scale-schedule') });
  authorized.value.allocations.push({ id: 'scale2', role: 'acceptance', reservation_limit: 2 });
  const scaleSetup = structuredClone(scale); scaleSetup.models.window = window; scaleSetup.candidates[0].build_id = 'new';
  scaleSetup.control_root = join(root, 'control/scale'); scaleSetup.models.source_file = '/owned/models.json'; scaleSetup.materialization_binding_file = '/owned/material.json';
  Object.assign(scaleSetup.campaign_scope, { predecessor: setup.campaign_scope.predecessor, history_plan_files: ['old-plan'], prospective_authorization: ref('authority7') });
  await assertEngineeringWindowSetup(scaleSetup, authorized);
  scaleSetup.budget.batch.max_duration_ms = residual.batch.max_duration_ms;
  await assert.rejects(assertEngineeringWindowSetup(scaleSetup, authorized), /ENGINEERING_WINDOW_UNSTARTED_BUDGET_CHANGED/);
});
