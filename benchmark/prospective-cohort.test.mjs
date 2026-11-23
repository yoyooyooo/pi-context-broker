import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fingerprint } from './protocol.mjs';
import { createPreregistrationTemplate } from './templates/preregistration.mjs';
import { preregisterComparison } from './planning.mjs';
import { freezeBatchPlan, runBatch, scheduleProtocol } from './batch.mjs';
import { acquirePilotScopeLease, checkCampaignScope, pilotScopePolicy, preparePilotScope, readPilotScopeAmendment, verifyPilotScope } from './pilot-scope.mjs';
import { PROSPECTIVE_COHORT, readCohortHistory } from './prospective-cohort.mjs';
import { verifyGateReference, writeRouteGate } from './gate.mjs';
import { exampleEnvelope } from './analysis/fixtures.mjs';
import { normalizeEpisode } from './evidence/normalize.mjs';
import { writeEvidenceBundle } from './evidence/store.mjs';
import { executionImplementation } from './implementation.mjs';
import { assessReportedModel } from './reported-model.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const reference = async path => ({ path, sha256: sha(await readFile(path)) });
const instrumentation = { version: 1, runtime_sha256: ['a'.repeat(64)], collector_files: [], collector_sha256: fingerprint([]), scope: 'offline fixture only' };
const expansionIds = Array.from({ length: 8 }, (_, i) => 'expansion-case-' + i);

// These synthetic envelopes test accounting and control flow, never model quality.
function protocol(id, { scope, modelCount = 2, expansion = false, routing = false } = {}) {
  const p = createPreregistrationTemplate(), hash = fingerprint({ cohort_fixture: true });
  for (const [index, environment] of p.environments.entries()) {
    environment.status = 'frozen'; environment.build.id = 'fixture-build'; environment.build.receipt_sha256 = hash;
    for (const item of [environment.build.cli, environment.build.broker]) for (const key of Object.keys(item)) item[key] = key === 'commit' ? '1'.repeat(40) : hash;
    for (const [name, runtime] of Object.entries(environment.runtime)) Object.assign(runtime, { entry: '/synthetic/' + name, version: '1.0.0', sha256: hash });
    environment.pi.entry = environment.runtime.pi.entry; environment.pi.entry_kind = 'pi-sdk';
    for (const key of Object.keys(environment.pi)) if (key.endsWith('_sha256')) environment.pi[key] = hash;
    environment.pi.extensions.forEach(item => { item.sha256 = hash; });
    if (index === 1) {
      environment.pi.mode = 'native'; environment.pi.extensions = environment.pi.extensions.filter(item => item.role !== 'broker');
      environment.pi.native_root = { path: '/synthetic/native', content_sha256: hash };
    }
    environment.manifest_sha256 = fingerprint({ ...environment, manifest_sha256: null });
  }
  const models = Array.from({ length: modelCount }, (_, index) => {
    const model = structuredClone(p.models[0]);
    Object.assign(model, { id: 'provider/fixture-' + index, provider: 'provider', family: 'fixture-' + index, route: 'fixed/fixture-' + index });
    model.adapter.verification = 'verified'; model.adapter.evidence_sha256 = hash;
    if (routing) model.routing = { mode: 'fixed-route', model_variant: 'fixture-' + index, reported_model_ids: ['server/fixture-' + index] };
    return model;
  });
  const ids = expansion ? expansionIds : Array.from({ length: 4 }, (_, i) => 'gate-case-' + i);
  const cases = ids.map(id => ({ id, protocol_case: { ...p.corpus.cases[0], id, material_id: id, cluster_id: id, content_sha256: fingerprint({ id }) } }));
  const budget = structuredClone(p.policies.budgets[0]);
  budget.episode = { max_duration_ms: 1000, max_model_requests: 10, max_input_tokens: 1000, max_output_tokens: 1000, max_http_attempts: 10, max_retries: 0 };
  const count = modelCount * 2 * ids.length;
  budget.batch = { max_episodes: count, max_model_requests: count * 10, max_input_tokens: count * 1000, max_output_tokens: count * 1000, max_duration_ms: count * 100000, max_concurrency: 1 };
  return preregisterComparison({ id, phase: 'pilot', purpose: 'native_calibration', environments: p.environments, models,
    corpus: p.corpus, cases, budget, decision: { ...p.policies.decision, absolute_quality_required: 0.8, unassisted_quality_required: 0.8, input_ratio_max: 1.1, capped_time_ratio_max: 1.15 },
    pilotScope: scope, orderingSeed: 0, registeredAt: '2026-11-22T10:00:00Z',
    allowedChanges: ['build', 'runtime', 'pi_mode', 'config', 'extensions', 'tools', 'catalog', 'sources', 'native_root',
      'guidance', 'injection', 'return_contract', 'error_contract', 'cache', 'session', 'recovery', 'code_mode'] });
}

async function resultFor(plan, slot, runId, { attempts = [50], attemptsComplete = true, valid = true, stop = false, outcome = 'pass', omitRouting = false } = {}) {
  const root = plan.execution.environment_root, rawRoot = join(root, 'raw'); await mkdir(rawRoot, { recursive: true });
  const rawPath = join(rawRoot, runId + '.json');
  const envelope = exampleEnvelope({ condition: slot.condition_id, caseId: slot.case_id, episodeId: runId,
    repeat: slot.repeat, attemptInputs: attempts, attemptsComplete, valid, outcome, rawPath });
  const condition = plan.protocol.conditions.find(item => item.id === slot.condition_id);
  const environment = plan.protocol.environments.find(item => item.id === condition.environment_id);
  const model = plan.protocol.models.find(item => item.id === condition.model_id);
  Object.assign(envelope.input.identity, { run_id: runId, experiment_id: plan.id, model_id: condition.model_id,
    environment_sha256: environment.manifest_sha256, build_id: environment.build.id, analysis_implementation: { files: [] } });
  if (model.routing && !omitRouting) {
    Object.assign(envelope.input.identity, { model_route: model.route, model_routing: model.routing, model_api: model.api, model_provider: model.provider });
    const events = envelope.input.attempts.map(attempt => ({ type: 'provider_stream_event', data: { request_id: attempt.request_id,
      attempt_id: attempt.id, api: model.api, model: model.route, provider: model.provider,
      event: model.api === 'openai-completions' ? { model: model.routing.reported_model_ids[0] } : { response: { model: model.routing.reported_model_ids[0] } } } }));
    const text = events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
    const path = join(rawRoot, runId + '-provider.jsonl'); await writeFile(path, text);
    const artifact = { id: 'provider-events', path, sha256: sha(text), bytes: Buffer.byteLength(text), kind: 'jsonl' }; envelope.input.artifacts.push(artifact);
    for (const [index, attempt] of envelope.input.attempts.entries()) {
      const ref = { artifact_id: artifact.id, sha256: artifact.sha256, line: index + 1 };
      attempt.reported_model = assessReportedModel({ routing: model.routing, sent: attempt.sent, observations: [{ value: model.routing.reported_model_ids[0],
        field: model.api === 'openai-completions' ? '/data/event/model' : '/data/event/response/model', bound: true, ref }], refs: [ref] });
    }
  }
  await writeFile(rawPath, envelope.rawText);
  const bundle = normalizeEpisode(envelope.input), episode = bundle.episode, directory = join(root, 'evidence', runId);
  await writeEvidenceBundle({ directory, bundle, rawRoot: root });
  return { status: valid ? 'completed' : 'invalid', normalized_directory: directory, episode_sha256: episode.episode_sha256,
    budget_usage: { model_requests: episode.measurements.actual_attempts.status === 'known' ? episode.measurements.actual_attempts.value : null,
      input_tokens: episode.measurements.input_total.value.status === 'known' ? episode.measurements.input_total.value.value : null,
      output_tokens: episode.measurements.output_total.value.status === 'known' ? episode.measurements.output_total.value.value : null,
      duration_ms: episode.timing.duration_ms.value }, stop_batch: stop, stop_reason: stop ? 'synthetic_core_stop' : null };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-finite-cohort-'))), pilot = join(root, 'pilot'); await mkdir(pilot);
  const oldRoot = join(root, 'historical-subject'), oldControl = join(root, 'historical-plan'); await mkdir(oldRoot); await mkdir(oldControl);
  const old = freezeBatchPlan({ protocol: protocol('historical-plan'), execution: { environment_root: oldRoot, control_root: oldControl, pilot_ledger_root: pilot, instrumentation } });
  const oldPlan = join(oldControl, 'plan.json'); await save(oldPlan, old); const rows = [];
  for (let i = 0; i < 3; i++) {
    const runId = 'historical-' + i, slot = old.slots[i];
    await save(join(pilot, String(i + 1).padStart(3, '0') + '.json'), { run_id: runId, experiment_id: old.id, slot_id: slot.slot_id });
    const result = await resultFor(old, slot, runId, { attempts: i === 2 ? [null] : [25], valid: i !== 2, stop: i === 2 });
    rows.push({ seq: rows.length + 1, type: 'episode_started', run_id: runId, slot_id: slot.slot_id });
    rows.push({ seq: rows.length + 1, type: 'episode_completed', run_id: runId, slot_id: slot.slot_id, result });
  }
  rows.push({ seq: rows.length + 1, type: 'batch_closed' });
  await writeFile(join(oldControl, 'ledger.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const control = join(root, 'legacy-scope'); await mkdir(control);
  const input = { id: 'legacy-scope', role: 'gate', authorization: 'Offline fixture legacy authorization', history_plan_files: [oldPlan],
    acknowledged_unknown_run_ids: ['historical-2'], gate_episodes: 16, minimum_valid_real_per_condition: 4 };
  const p = protocol('legacy-scope-gate', { scope: pilotScopePolicy(input) });
  const execution = { environment_root: oldRoot, control_root: control, pilot_ledger_root: pilot, instrumentation };
  execution.pilot_scope = await preparePilotScope({ setup: { pilot_scope: input }, protocol: p, execution, slots: scheduleProtocol(p) });
  const legacy = freezeBatchPlan({ protocol: p, execution }); await save(join(control, 'plan.json'), legacy);
  await runBatch({ plan: legacy, maximumNewEpisodes: 1, executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId,
    { attempts: [], attemptsComplete: false, valid: false, stop: true }) });
  const environment = join(root, 'new-subject'); await mkdir(environment);
  return { root, pilot, environment, legacy, historyPlans: [oldPlan, join(control, 'plan.json')],
    predecessor: { registration: await reference(join(pilot, 'scope-registration.json')), amendment: legacy.execution.pilot_scope.amendment },
    unknowns: ['historical-2', 'legacy-scope-gate-001'].sort() };
}

async function cohort(f, { id = 'cohort-a', modelCount = 2, predecessor = f.predecessor, historyPlans = f.historyPlans, unknowns = f.unknowns } = {}) {
  const control = join(f.root, id + '-gate'); await mkdir(control);
  const input = { kind: PROSPECTIVE_COHORT, id, role: 'gate', authorization: 'Offline fixture prospective authorization',
    predecessor, history_plan_files: historyPlans, acknowledged_unknown_run_ids: unknowns,
    expansion: { experiment_id: id + '-expansion', control_root: join(f.root, id + '-expansion'), case_ids: expansionIds } };
  const p = protocol(id + '-gate', { scope: pilotScopePolicy(input, { modelCount }), modelCount, routing: true });
  const execution = { environment_root: f.environment, control_root: control, pilot_ledger_root: f.pilot, instrumentation,
    models_sha256: fingerprint({ modelCount }) };
  execution.pilot_scope = await preparePilotScope({ setup: { pilot_scope: input }, protocol: p, execution, slots: scheduleProtocol(p) });
  const plan = freezeBatchPlan({ protocol: p, execution }); await save(join(control, 'plan.json'), plan);
  return { plan, input, modelCount };
}

async function expansion(f, c, gate) {
  const input = { kind: PROSPECTIVE_COHORT, id: c.input.id, role: 'expansion', amendment: c.plan.execution.pilot_scope.amendment };
  const p = protocol(c.input.expansion.experiment_id, { scope: pilotScopePolicy(input, { modelCount: c.modelCount }), modelCount: c.modelCount, expansion: true, routing: true });
  const execution = { environment_root: f.environment, control_root: c.input.expansion.control_root, pilot_ledger_root: f.pilot, instrumentation,
    models_sha256: c.plan.execution.models_sha256, ...(gate ? { route_gate: gate } : {}) };
  await mkdir(execution.control_root);
  execution.pilot_scope = await preparePilotScope({ setup: { pilot_scope: input }, protocol: p, execution, slots: scheduleProtocol(p) });
  const plan = freezeBatchPlan({ protocol: p, execution }); await save(join(execution.control_root, 'plan.json'), plan); return plan;
}

test('a new apparatus retains a closed unknown-send history, admits every quality outcome, then adds a single-model cohort', async () => {
  const f = await fixture(), before = await readFile(join(f.legacy.execution.control_root, 'ledger.jsonl')), c = await cohort(f);
  const amendment = await readPilotScopeAmendment(c.plan.execution.pilot_scope.amendment);
  assert.equal(amendment.history.scheduled_episodes, 4); assert.equal(amendment.history.total_usage.model_requests, null);
  assert.deepEqual(amendment.history.unknown_usage_run_ids, f.unknowns); assert.equal(amendment.reservation_limit, 48);
  let calls = 0;
  const status = await runBatch({ plan: c.plan, executeEpisode: ({ plan, slot, runId }) => {
    calls++; return resultFor(plan, slot, runId, { outcome: ['pass', 'fail', 'unknown'][calls % 3] });
  } });
  assert.equal(calls, 16);
  const receipt = await writeRouteGate({ plan: c.plan, status, outputFile: join(f.root, 'cohort-gate.json') });
  const gate = await verifyGateReference({ reference: receipt.reference, environmentRoot: f.environment });
  assert.equal(gate.kind, 'benchmark-cohort-gate'); assert.equal(gate.episode_evidence.length, 16);
  assert.deepEqual(Object.values(gate.condition_coverage), [4, 4, 4, 4]);
  const missing = structuredClone(status); missing.episodes.pop();
  await assert.rejects(writeRouteGate({ plan: c.plan, status: missing, outputFile: join(f.root, 'missing.json') }));
  const duplicate = structuredClone(status); duplicate.episodes[0] = duplicate.episodes[1];
  await assert.rejects(writeRouteGate({ plan: c.plan, status: duplicate, outputFile: join(f.root, 'duplicate.json') }));
  const next = await expansion(f, c, receipt.reference);
  const expanded = await runBatch({ plan: next, executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId) });
  assert.equal(expanded.completed, 32); assert.equal((await readdir(f.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 52);
  await assert.rejects(verifyPilotScope(next, { forReservation: true }), { code: 'COHORT_CAP' });
  const single = await cohort(f, { id: 'cohort-b', modelCount: 1,
    predecessor: { registration: await reference(join(f.pilot, 'scope-registration-002.json')), amendment: c.plan.execution.pilot_scope.amendment },
    historyPlans: [...f.historyPlans, join(c.plan.execution.control_root, 'plan.json'), join(next.execution.control_root, 'plan.json')] });
  const singleAmendment = await readPilotScopeAmendment(single.plan.execution.pilot_scope.amendment);
  assert.equal(singleAmendment.reservation_limit, 24); assert.deepEqual(singleAmendment.history_exemption, amendment.history_exemption);
  const singleStatus = await runBatch({ plan: single.plan, executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId, { outcome: 'fail' }) });
  assert.equal(singleStatus.completed, 8);
  const singleGate = await writeRouteGate({ plan: single.plan, status: singleStatus, outputFile: join(f.root, 'single-gate.json') });
  assert.equal((await verifyGateReference({ reference: singleGate.reference, environmentRoot: f.environment })).episode_evidence.length, 8);
  assert.equal((await read(join(f.pilot, 'scope-registration-003.json'))).kind, 'benchmark-prospective-cohort-succession');
  assert.deepEqual(await readFile(join(f.legacy.execution.control_root, 'ledger.jsonl')), before);
  await assert.rejects(runBatch({ plan: c.plan, executeEpisode: () => assert.fail('The old cohort cannot reopen') }));
  assert.ok((await executionImplementation()).files.some(file => file.path === 'prospective-cohort.mjs'));
});

test('expansion needs its own gate and a new cohort cannot acknowledge away a newly unknown final observation', async () => {
  const f = await fixture(), c = await cohort(f, { modelCount: 1 }), ungated = await expansion(f, c);
  await assert.rejects(runBatch({ plan: ungated, executeEpisode: () => assert.fail('No send before gate') }), /GATE_REQUIRED/);
  const status = await runBatch({ plan: c.plan, executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId) });
  const receipt = await writeRouteGate({ plan: c.plan, status, outputFile: join(f.root, 'gate.json') });
  const next = structuredClone(ungated); next.execution.route_gate = receipt.reference;
  next.plan_sha256 = fingerprint({ ...next, plan_sha256: null });
  // The ungated plan has never run; create the concrete gate-bound plan in this fixture.
  await save(join(next.execution.control_root, 'plan.json'), next);
  let count = 0;
  const stopped = await runBatch({ plan: next, executeEpisode: ({ plan, slot, runId }) => {
    count++; return resultFor(plan, slot, runId, count === 16 ? { attempts: [null], stop: true } : {});
  } });
  assert.equal(stopped.completed, 16); assert.equal(stopped.episodes.at(-1).result.stop_batch, true);
  const unknownRun = stopped.episodes.at(-1).run_id;
  await assert.rejects(cohort(f, { id: 'cannot-erase-stop', modelCount: 1,
    predecessor: { registration: await reference(join(f.pilot, 'scope-registration-002.json')), amendment: c.plan.execution.pilot_scope.amendment },
    historyPlans: [...f.historyPlans, join(c.plan.execution.control_root, 'plan.json'), join(next.execution.control_root, 'plan.json')],
    unknowns: [...f.unknowns, unknownRun] }), /NEW_UNKNOWN_CANNOT_BECOME_HISTORY/);
  await assert.rejects(runBatch({ plan: next, executeEpisode: () => assert.fail('A new unknown stops all further sends') }), /RETAINED_CORE_STOP/);
});

test('closed history bytes, routing identity, finite phase roots and incomplete predecessor checks cannot be bypassed', async () => {
  const f = await fixture(), c = await cohort(f), mutation = structuredClone(c.plan);
  mutation.protocol.models[0].routing.reported_model_ids = ['unregistered/model'];
  mutation.protocol.protocol_sha256 = fingerprint({ ...mutation.protocol, protocol_sha256: null });
  mutation.plan_sha256 = fingerprint({ ...mutation, plan_sha256: null });
  await assert.rejects(verifyPilotScope(mutation), /MODEL_CHANGED/);
  const moved = structuredClone(c.plan); moved.execution.control_root = join(f.root, 'another-gate');
  moved.plan_sha256 = fingerprint({ ...moved, plan_sha256: null });
  await assert.rejects(verifyPilotScope(moved), /PHASE_ROOT_CHANGED/);
  await runBatch({ plan: c.plan, maximumNewEpisodes: 1, executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId) });
  await assert.rejects(cohort(f, { id: 'premature-model', modelCount: 1,
    predecessor: { registration: await reference(join(f.pilot, 'scope-registration-002.json')), amendment: c.plan.execution.pilot_scope.amendment },
    historyPlans: [...f.historyPlans, join(c.plan.execution.control_root, 'plan.json')] }), /PREDECESSOR_INCOMPLETE/);
  await writeFile(join(f.pilot, '004.json'), (await readFile(join(f.pilot, '004.json'), 'utf8')) + ' ');
  await assert.rejects(verifyPilotScope(c.plan), /HISTORY_CHANGED/);
});

test('one campaign lease serializes different cohort owners, and every reservation rechecks registration', async () => {
  const f = await fixture(), a = await cohort(f), b = await cohort(f, { id: 'cohort-b', modelCount: 1 });
  const aa = await readPilotScopeAmendment(a.plan.execution.pilot_scope.amendment), bb = await readPilotScopeAmendment(b.plan.execution.pilot_scope.amendment);
  const release = await acquirePilotScopeLease(a.plan, aa);
  await assert.rejects(acquirePilotScopeLease(b.plan, bb), { code: 'EEXIST' }); await release();
  let calls = 0;
  await assert.rejects(runBatch({ plan: a.plan, executeEpisode: async ({ plan, slot, runId }) => {
    calls++;
    const result = await resultFor(plan, slot, runId);
    // An out-of-band competing registration must be detected before a second send.
    await save(join(f.pilot, 'scope-registration-003.json'), { version: 1, sequence: 3, kind: 'benchmark-prospective-cohort-succession',
      predecessor: b.input.predecessor.registration, id: b.input.id, amendment: b.plan.execution.pilot_scope.amendment });
    return result;
  } }), /REGISTRATION_HISTORY_CHANGED/);
  assert.equal(calls, 1); await assert.rejects(checkCampaignScope(b.plan), /REGISTRATION_HISTORY_CHANGED/);
});

test('new cohort evidence cannot fall back to the legacy envelope by omitting its routing contract', async () => {
  const f = await fixture(), c = await cohort(f, { modelCount: 1 });
  await runBatch({ plan: c.plan, maximumNewEpisodes: 1,
    executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId, { omitRouting: true }) });
  await assert.rejects(verifyPilotScope(c.plan), /MODEL_ROUTING_MISMATCH/);
  await assert.rejects(runBatch({ plan: c.plan, executeEpisode: () => assert.fail('Missing response identity cannot authorize another send') }), /MODEL_ROUTING_MISMATCH/);
});
