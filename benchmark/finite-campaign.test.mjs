import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fingerprint, validateProtocol } from './protocol.mjs';
import { createPreregistrationTemplate } from './templates/preregistration.mjs';
import { preregisterComparison } from './planning.mjs';
import { freezeBatchPlan, scheduleProtocol, runBatch } from './batch.mjs';
import { writeRouteGate, verifyGateReference } from './gate.mjs';
import { pilotScopePolicy, preparePilotScope, readPilotScopeAmendment, scopeReservationFields } from './pilot-scope.mjs';
import { PROSPECTIVE_COHORT, readCohortHistory } from './prospective-cohort.mjs';
import { FINITE_CAMPAIGN, finiteCampaignPolicy, prepareFiniteCampaign, assertFiniteCampaignPlan,
  readFiniteCampaignAmendment, verifyFiniteCampaign, verifyFiniteCampaignScope, finiteCampaignReservationFields, readFiniteCampaignHistory, verifyFiniteOriginalResults } from './finite-campaign.mjs';
import { exampleEnvelope } from './analysis/fixtures.mjs';
import { normalizeEpisode } from './evidence/normalize.mjs';
import { writeEvidenceBundle } from './evidence/store.mjs';
import { assessReportedModel } from './reported-model.mjs';
import { prepareApprovedCampaign, readApprovedCampaign } from './approved-campaign.mjs';
import { declaredSchedule, UNSTARTED_FOLLOWUP } from './campaign-selection.mjs';
import { scoreExperiment } from './analysis/compare.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const reference = async path => ({ path, sha256: sha(await readFile(path)) });
const instrumentation = { version: 1, runtime_sha256: ['a'.repeat(64)], collector_files: [], collector_sha256: fingerprint([]), scope: 'offline fixture only' };
const expansionIds = Array.from({ length: 8 }, (_, i) => 'expansion-case-' + i);

// Synthetic evidence fixtures exercise contracts/accounting, never paid models.
function fixtureProtocol(id, { scope, modelCount = 2, expansion = false, routing = false } = {}) {
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

function sealProtocol(value) { value.protocol_sha256 = fingerprint({ ...value, protocol_sha256: null }); return value; }
function resealPlan(value) { value.plan_sha256 = fingerprint({ ...value, plan_sha256: null }); return value; }
function finitePlan(protocol, execution) {
  // The module fixture uses the actual immutable plan shape without invoking
  // batch dispatch/registration. Integration tests cover the dispatch adapter.
  return resealPlan({ version: 1, kind: 'benchmark-batch-plan', id: protocol.id, registered_at: protocol.registered_at,
    protocol, execution, slots: scheduleProtocol(protocol), plan_sha256: null });
}
async function writeClosedPlan(plan, { startOrdinal, count = plan.slots.length, prefixCount = 0, unknownLast = false, unknownIndices = [] } = {}) {
  const rows = prefixCount ? (await readFile(join(plan.execution.control_root, 'ledger.jsonl'), 'utf8')).trimEnd().split('\n').map(JSON.parse).filter(row => row.type !== 'batch_closed') : [];
  const planRef = await reference(join(plan.execution.control_root, 'plan.json'));
  let amendment;
  if (plan.execution.campaign_scope) amendment = await read(plan.execution.campaign_scope.amendment.path);
  else if (plan.execution.pilot_scope) amendment = await readPilotScopeAmendment(plan.execution.pilot_scope.amendment);
  for (let i = prefixCount; i < count; i++) {
    const slot = plan.slots[i], runId = plan.id + '-' + String(slot.order + 1).padStart(3, '0');
    const fields = plan.execution.campaign_scope ? finiteCampaignReservationFields(plan, amendment, planRef)
      : plan.execution.pilot_scope ? scopeReservationFields(plan, amendment, planRef) : {};
    await save(join(plan.execution.pilot_ledger_root, String(startOrdinal + i).padStart(3, '0') + '.json'), { run_id: runId, experiment_id: plan.id, slot_id: slot.slot_id, ...fields });
    const unknown = unknownIndices.includes(i) || unknownLast && i === count - 1;
    const result = await resultFor(plan, slot, runId, unknown ? { attempts: [null], valid: false, stop: true } : { outcome: i % 3 === 1 ? 'fail' : 'pass' });
    rows.push({ seq: rows.length + 1, type: 'episode_started', ...slot, run_id: runId });
    rows.push({ seq: rows.length + 1, type: 'episode_completed', ...slot, run_id: runId, result });
  }
  rows.push({ seq: rows.length + 1, type: 'batch_closed', reason: count === plan.slots.length ? 'planned_slots_completed' : 'operator_slice_limit' });
  await writeFile(join(plan.execution.control_root, 'ledger.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

async function fixture({ modelCount = 1, expansionCount = modelCount * 16, unknownExpansion = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-finite-campaign-'))), pilot = join(root, 'pilot'), owner = join(root, 'owner');
  await mkdir(pilot); await mkdir(owner);
  const oldControl = join(owner, 'historical'), legacyControl = join(owner, 'legacy'); await mkdir(oldControl); await mkdir(legacyControl);
  const old = freezeBatchPlan({ protocol: fixtureProtocol('historical'), execution: { environment_root: owner, control_root: oldControl, pilot_ledger_root: pilot, instrumentation } });
  const originalBindings = old.protocol.corpus.cases.map(item => ({ id: item.id, protocol_case: item, variant: { content_sha256: fingerprint({ canonical: item.id }) },
    public_case: { content_sha256: fingerprint({ public: item.id }), attachments: [{ path: 'input.csv', sha256: fingerprint({ bytes: item.id }) }],
      prompt_sha256: item.prompt_sha256, contract_sha256: item.contract_sha256, initial_state_sha256: item.initial_state_sha256, authorization_sha256: item.authorization_sha256 } }));
  const originalBindingsPath = join(oldControl, 'bindings.json'); await save(originalBindingsPath, originalBindings);
  old.execution.case_bindings_file = originalBindingsPath; old.execution.case_bindings_sha256 = sha(await readFile(originalBindingsPath)); resealPlan(old);
  const oldPlan = join(oldControl, 'plan.json'); await save(oldPlan, old);
  await writeClosedPlan(old, { startOrdinal: 1, count: 3, unknownIndices: [2] });
  const initialUnknowns = ['historical-003'], unknowns = ['historical-003', 'legacy-gate-009', 'legacy-gate-010'];
  const legacyInput = { id: 'legacy', role: 'gate', authorization: 'Synthetic legacy authorization', history_plan_files: [oldPlan],
    acknowledged_unknown_run_ids: initialUnknowns, gate_episodes: 16, minimum_valid_real_per_condition: 4 };
  const legacyProtocol = fixtureProtocol('legacy-gate', { scope: pilotScopePolicy(legacyInput) });
  const legacyExecution = { environment_root: owner, control_root: legacyControl, pilot_ledger_root: pilot, instrumentation };
  legacyExecution.pilot_scope = await preparePilotScope({ setup: { pilot_scope: legacyInput }, protocol: legacyProtocol, execution: legacyExecution, slots: scheduleProtocol(legacyProtocol) });
  const legacyPlan = freezeBatchPlan({ protocol: legacyProtocol, execution: legacyExecution }), legacyPlanPath = join(legacyControl, 'plan.json');
  await save(legacyPlanPath, legacyPlan); await writeClosedPlan(legacyPlan, { startOrdinal: 4, count: 10, unknownIndices: [8, 9] });
  const originalRegistration = join(pilot, 'scope-registration.json'); await save(originalRegistration, { id: 'legacy', amendment: legacyExecution.pilot_scope.amendment });
  const predecessor = { registration: await reference(originalRegistration), amendment: legacyExecution.pilot_scope.amendment };
  const gateRoot = join(owner, 'prospective-gate'), expansionRoot = join(owner, 'prospective-expansion'); await mkdir(gateRoot); await mkdir(expansionRoot);
  const input = { kind: PROSPECTIVE_COHORT, id: 'prospective', role: 'gate', authorization: 'Synthetic completed prospective cohort',
    predecessor, history_plan_files: [oldPlan, legacyPlanPath], acknowledged_unknown_run_ids: unknowns,
    expansion: { experiment_id: 'prospective-expansion', control_root: expansionRoot, case_ids: expansionIds } };
  const p = fixtureProtocol('prospective-gate', { scope: pilotScopePolicy(input, { modelCount }), modelCount, routing: true });
  const execution = { environment_root: owner, control_root: gateRoot, pilot_ledger_root: pilot, instrumentation, models_sha256: fingerprint({ models: 1 }) };
  execution.pilot_scope = await preparePilotScope({ setup: { pilot_scope: input }, protocol: p, execution, slots: scheduleProtocol(p) });
  const gatePlan = freezeBatchPlan({ protocol: p, execution }); await save(join(gateRoot, 'plan.json'), gatePlan);
  await writeClosedPlan(gatePlan, { startOrdinal: 14 });
  const reg = join(pilot, 'scope-registration-002.json'); await save(reg, { version: 1, kind: 'benchmark-prospective-cohort-succession', sequence: 2,
    predecessor: await reference(originalRegistration), id: input.id, amendment: execution.pilot_scope.amendment });
  const expInput = { kind: PROSPECTIVE_COHORT, id: input.id, role: 'expansion', amendment: execution.pilot_scope.amendment };
  const ep = fixtureProtocol('prospective-expansion', { scope: pilotScopePolicy(expInput, { modelCount }), modelCount, expansion: true, routing: true });
  const ee = { ...execution, control_root: expansionRoot }; delete ee.pilot_scope;
  ee.pilot_scope = await preparePilotScope({ setup: { pilot_scope: expInput }, protocol: ep, execution: ee, slots: scheduleProtocol(ep) });
  const expPlan = freezeBatchPlan({ protocol: ep, execution: ee }); await save(join(expansionRoot, 'plan.json'), expPlan);
  await writeClosedPlan(expPlan, { startOrdinal: 14 + modelCount * 8, count: expansionCount, unknownLast: unknownExpansion });
  return { root, pilot, owner, originalBindings, historyPlans: [oldPlan, legacyPlanPath, join(gateRoot, 'plan.json'), join(expansionRoot, 'plan.json')],
    predecessor: { registration: await reference(reg), amendment: execution.pilot_scope.amendment }, unknowns,
    count: 13 + modelCount * 8 + expansionCount };
}

async function prepare(f, { id = 'finite-gate', role = 'route_gate_only', phase = 'pilot', exposed = false, canonicalExposure = false,
  route, protocol: suppliedProtocol, selection } = {}) {
  const control = join(f.owner, id); await mkdir(control, { recursive: true });
  const input = { kind: FINITE_CAMPAIGN, id, role, authorization: 'Synthetic finite campaign contract', predecessor: f.predecessor, history_plan_files: f.historyPlans,
    ...(f.approval ? { prospective_authorization: f.approval, allocation_id: id } : {}), ...(selection ? { selection } : {}) };
  const p = suppliedProtocol ? structuredClone(suppliedProtocol) : fixtureProtocol(id, { modelCount: 1, routing: true });
  p.id = id; p.phase = phase; delete p.policies.pilot.scope;
  if (route) p.models[0].route = route;
  if (phase === 'confirmation') {
    for (const item of p.corpus.cases) {
      item.split = 'confirmation'; item.material_id = id + '-' + item.material_id;
      if (!exposed) for (const key of ['content_sha256', 'prompt_sha256', 'contract_sha256', 'initial_state_sha256', 'authorization_sha256']) item[key] = fingerprint({ confirmation: id, case: item.id, key });
    }
  }
  const count = selection?.slot_ids.length ?? 8;
  p.policies.budgets[0].batch.max_episodes = count;
  p.policies.campaign = finiteCampaignPolicy(input, { scheduledEpisodes: count }); sealProtocol(p);
  const execution = { environment_root: f.owner, control_root: control, pilot_ledger_root: f.pilot, instrumentation, models_sha256: fingerprint({ models: 1 }) };
  if (canonicalExposure) {
    const bindings = p.corpus.cases.map((item, index) => ({ ...structuredClone(f.originalBindings[index]), id: item.id, protocol_case: item }));
    const path = join(control, 'bindings.json'); await save(path, bindings); execution.case_bindings_file = path; execution.case_bindings_sha256 = sha(await readFile(path));
  }
  const amendment = await prepareFiniteCampaign({ setup: { campaign_scope: input }, protocol: p, execution, slots: scheduleProtocol(p) });
  const path = join(control, 'finite-campaign-amendment.json'); await save(path, amendment);
  execution.campaign_scope = { version: 1, kind: FINITE_CAMPAIGN, id, role, amendment: await reference(path) };
  const plan = finitePlan(p, execution); await save(join(control, 'plan.json'), plan);
  return { plan, amendment, input };
}

async function successor(f, current, sequence) {
  const path = join(f.pilot, 'scope-registration-' + String(sequence).padStart(3, '0') + '.json');
  await save(path, { version: 1, kind: 'benchmark-finite-campaign-succession', sequence, predecessor: f.predecessor.registration,
    id: current.amendment.id, amendment: current.plan.execution.campaign_scope.amendment });
  return { ...f, count: f.count + current.plan.slots.length, predecessor: { registration: await reference(path), amendment: current.plan.execution.campaign_scope.amendment },
    historyPlans: [...f.historyPlans, join(current.plan.execution.control_root, 'plan.json')] };
}

async function approveStoppedFixture(f) {
  const history = await readCohortHistory({ planFiles: f.historyPlans, pilotLedgerRoot: f.pilot });
  const stop = history.episodes.at(-1), normalizedPath = join(stop.directory, 'episode.json'), normalized = await read(normalizedPath);
  const allocations = [
    { id: 'approved-followup', work_index: 0, role: UNSTARTED_FOLLOWUP, reservation_limit: 11 },
    { id: 'approved-grok', work_index: 1, role: 'route_gate_only', reservation_limit: 8 },
    { id: 'approved-terra', work_index: 2, role: 'route_gate_only', reservation_limit: 8 },
    { id: 'approved-confirmation', work_index: 3, role: 'acceptance', reservation_limit: 20 },
    { id: 'approved-code', work_index: 4, role: 'acceptance', reservation_limit: 24 },
    ...Array.from({ length: 5 }, (_, i) => ({ id: 'approved-scale-' + i, work_index: 5, role: 'acceptance', reservation_limit: 2 })),
    { id: 'approved-fault', work_index: 6, role: 'acceptance', reservation_limit: 8 },
  ];
  const proposal = { version: 1, kind: 'prospective-resumption-proposal-not-executable', revision: 2, approved: false, execution_authority: null,
    campaign_absolute_limit: 144, current_physical_reservations: 50, retained_usage_unknown: 4,
    proposed_new_reservation_ceiling: 89, proposed_total_ceiling: 139, unallocated_headroom: 5,
    work: [11, 8, 8, 20, 24, 10, 8].map((maximum_new_reservations, index) => ({ maximum_new_reservations,
      ...([1, 2].includes(index) ? { route: 'provider/' + (index === 1 ? 'grok' : 'terra') + '/fixture-0' } : {}) })),
    retained_stop: { run_id: stop.run_id, result_sha256: normalized.admission.refs[0].sha256,
      normalized_episode_sha256: sha(await readFile(normalizedPath)), current_scope_still_stopped: true, usage_still_unknown: true, invalid_still_retained: true } };
  const proposalPath = join(f.owner, 'proposal.json'); await save(proposalPath, proposal);
  const decision = { version: 1, kind: 'user-prospective-benchmark-resumption-decision', approved: true,
    source: 'Synthetic direct user decision for contract testing', user_message: 'Approve the exact prospective proposal',
    authorization_scope: 'The seven fixed work items within 89 new reservations', recorded_at_utc: '2026-11-23T00:00:00Z',
    approved_proposal: { ...await reference(proposalPath), revision: 2 }, campaign_absolute_limit: 144,
    existing_reservations: 50, retained_usage_unknown: 4, approved_new_reservation_ceiling: 89, approved_total_ceiling: 139, unallocated_headroom: 5 };
  const decisionPath = join(f.owner, 'user-approval.json'); await save(decisionPath, decision);
  const inputs = { id: 'approved-program', userApproval: await reference(decisionPath), predecessor: f.predecessor,
    environmentRoot: f.owner, pilotLedgerRoot: f.pilot, history, allocations };
  const value = await prepareApprovedCampaign(inputs), path = join(f.owner, 'approved-campaign.json'); await save(path, value);
  return { ...f, approval: await reference(path), approvedDocument: value, approvalInputs: inputs };
}

test('explicit approval advances the exact stopped 50-prefix, while old scope and every later stop stay closed', async t => {
  const base = await fixture({ modelCount: 2, expansionCount: 21, unknownExpansion: true });
  await assert.rejects(prepare(base, { id: 'no-new-approval' }), /ORIGINAL_CORE_STOP/);
  const f = await approveStoppedFixture(base), gate = await prepare(f, { id: 'approved-grok', route: 'grok/fixture-0' });
  assert.equal(gate.amendment.version, 2); assert.equal(gate.amendment.history.scheduled_episodes, 50);
  assert.equal(gate.amendment.history_exemption.scheduled_episodes, 13);
  assert.equal(gate.amendment.prospective_authorization.history_boundary.scheduled_episodes, 50);
  assert.equal(gate.amendment.prospective_authorization.campaign_limit, 139);
  assert.equal(gate.amendment.history.unknown_usage_run_ids.length, 4);
  assert.equal(gate.amendment.history.total_usage.input_tokens, null);
  assert.deepEqual((await readApprovedCampaign(f.approval)).value, f.approvedDocument);
  const source = await read(f.historyPlans.at(-1)), stoppedRows = await readFile(join(source.execution.control_root, 'ledger.jsonl'));
  const baselineReservations = await Promise.all(f.approvedDocument.history.reservations.map(item => readFile(item.reference.path)));

  await t.test('approval, proposal, retained stop and allocation changes fail before a callback', async () => {
    for (const reference of [f.approvedDocument.user_approval, f.approvedDocument.proposal]) {
      const bytes = await readFile(reference.path); await writeFile(reference.path, Buffer.concat([bytes, Buffer.from(' ')]));
      await assert.rejects(verifyFiniteCampaignScope(gate.plan, { forReservation: true }), /REFERENCED_BYTES_CHANGED/);
      await writeFile(reference.path, bytes);
    }
    const original = f.approvalInputs;
    const declined = await read(original.userApproval.path), declinedPath = join(f.owner, 'declined-user-decision.json');
    declined.approved = false; await save(declinedPath, declined);
    await assert.rejects(prepareApprovedCampaign({ ...original, userApproval: await reference(declinedPath) }), /EXPLICIT_DECISION_REQUIRED/);
    const invalidAllocations = structuredClone(original.allocations); invalidAllocations.find(item => item.work_index === 5).reservation_limit++;
    await assert.rejects(prepareApprovedCampaign({ ...original, allocations: invalidAllocations }));
    const borrowing = structuredClone(original.allocations); borrowing[1].reservation_limit++; borrowing[2].reservation_limit--;
    await assert.rejects(prepareApprovedCampaign({ ...original, allocations: borrowing }), /WORK_LIMIT_CHANGED/);
    const missing = structuredClone(original.allocations); missing[6].id = missing[5].id;
    await assert.rejects(prepareApprovedCampaign({ ...original, allocations: missing }), /DUPLICATE_ALLOCATION/);
    const execution = structuredClone(gate.plan.execution); delete execution.campaign_scope;
    const changed = structuredClone(gate.plan.protocol); changed.models[0].route = 'other/fixture-0'; sealProtocol(changed);
    await assert.rejects(prepareFiniteCampaign({ setup: { campaign_scope: gate.input }, protocol: changed, execution, slots: scheduleProtocol(changed) }), /APPROVAL_ROUTE_CHANGED/);
    const rows = stoppedRows.toString().trimEnd().split('\n').map(JSON.parse), last = rows.filter(row => row.type === 'episode_completed').at(-1);
    last.result.stop_batch = false; await writeFile(join(source.execution.control_root, 'ledger.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    await assert.rejects(verifyFiniteCampaignScope(gate.plan, { forReservation: true }));
    await writeFile(join(source.execution.control_root, 'ledger.jsonl'), stoppedRows);
  });

  let calls = 0;
  const status = await runBatch({ plan: gate.plan, executeEpisode: async ({ plan, slot, runId }) => {
    const reservation = await read(join(f.pilot, String(51 + calls).padStart(3, '0') + '.json'));
    assert.equal(reservation.run_id, runId); assert.equal(reservation.scope_id, 'approved-grok'); calls++;
    return resultFor(plan, slot, runId);
  } });
  assert.equal(status.completed, 8); assert.equal(calls, 8);
  await runBatch({ plan: gate.plan, executeEpisode: () => assert.fail('No ninth approved gate observation') });
  await assert.rejects(runBatch({ plan: source, executeEpisode: () => assert.fail('Original stopped scope cannot resume') }));
  const next = { ...f, count: 58, historyPlans: [...f.historyPlans, join(gate.plan.execution.control_root, 'plan.json')],
    predecessor: { registration: await reference(join(f.pilot, 'scope-registration-003.json')), amendment: gate.plan.execution.campaign_scope.amendment } };
  const withoutApproval = { ...next }; delete withoutApproval.approval;
  await assert.rejects(prepare(withoutApproval, { id: 'unapproved-successor' }), /APPROVAL_LINEAGE_REQUIRED/);
  const repeated = structuredClone(gate.amendment); repeated.predecessor = next.predecessor;
  repeated.history = await readFiniteCampaignHistory({ planFiles: next.historyPlans, pilotLedgerRoot: f.pilot, prospectiveAuthorization: f.approval });
  repeated.amendment_sha256 = fingerprint({ ...repeated, amendment_sha256: null });
  await assert.rejects(verifyFiniteCampaign(repeated), /ALLOCATION_REUSED/);
  const terra = await prepare(next, { id: 'approved-terra', route: 'terra/fixture-0' });
  let failedCalls = 0;
  await runBatch({ plan: terra.plan, executeEpisode: async ({ plan, slot, runId }) => {
    failedCalls++; return resultFor(plan, slot, runId, { attempts: [null], valid: false, stop: true });
  } });
  assert.equal(failedCalls, 1);
  await assert.rejects(runBatch({ plan: terra.plan, executeEpisode: () => assert.fail('New unknown remains a stop') }), /ORIGINAL_CORE_STOP/);
  await assert.rejects(readFiniteCampaignHistory({ planFiles: [...next.historyPlans, join(terra.plan.execution.control_root, 'plan.json')],
    pilotLedgerRoot: f.pilot, prospectiveAuthorization: f.approval }), /ORIGINAL_CORE_STOP/);
  assert.equal((await readdir(f.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 59);
  assert.deepEqual(await readFile(join(source.execution.control_root, 'ledger.jsonl')), stoppedRows);
  for (const [i, item] of f.approvedDocument.history.reservations.entries()) assert.deepEqual(await readFile(item.reference.path), baselineReservations[i]);
});

test('the separate unstarted follow-up schedules exactly 11 old unstarted cells and retains the full 32-slot denominator', async t => {
  const f = await approveStoppedFixture(await fixture({ modelCount: 2, expansionCount: 21, unknownExpansion: true }));
  const source = await read(f.historyPlans.at(-1)), protocol = structuredClone(source.protocol);
  protocol.models[0].route = 'auto/fixture-0'; protocol.models[0].routing.mode = 'auto-route';
  const selection = { source_plan_sha256: source.plan_sha256, slot_ids: source.slots.slice(21).map(slot => slot.slot_id) };
  const current = await prepare(f, { id: 'approved-followup', role: UNSTARTED_FOLLOWUP, protocol, selection });
  assert.equal(current.plan.slots.length, 11); assert.equal(declaredSchedule(current.plan.protocol).length, 32);
  assert.deepEqual(current.plan.slots, source.slots.slice(21).map((slot, order) => ({ ...slot, order })));
  assert.equal(current.plan.protocol.models[0].route, 'auto/fixture-0');
  assert.equal(validateProtocol(current.plan.protocol, { stage: 'execute' }).valid, true);
  const execution = structuredClone(current.plan.execution); delete execution.campaign_scope;
  await t.test('a completed slot, the invalid twenty-first slot, reorder or changed cases cannot replace the exact suffix', async () => {
    for (const replacement of [source.slots.slice(20, 31).map(slot => slot.slot_id), source.slots.slice(0, 11).map(slot => slot.slot_id), [...selection.slot_ids].reverse()]) {
      const input = structuredClone(current.input), changed = structuredClone(current.plan.protocol);
      input.selection.slot_ids = replacement; changed.policies.campaign.selection.slot_ids = replacement;
      changed.policies.campaign.reservation_limit = replacement.length; changed.policies.budgets[0].batch.max_episodes = replacement.length; sealProtocol(changed);
      await assert.rejects(async () => prepareFiniteCampaign({ setup: { campaign_scope: input }, protocol: changed, execution, slots: scheduleProtocol(changed) }),
        /FOLLOWUP|ALLOCATION_LIMIT/);
    }
    const changed = structuredClone(current.plan.protocol); changed.corpus.cases[0].content_sha256 = 'c'.repeat(64); sealProtocol(changed);
    await assert.rejects(prepareFiniteCampaign({ setup: { campaign_scope: current.input }, protocol: changed, execution, slots: scheduleProtocol(changed) }), /FOLLOWUP_BUSINESS_MATERIAL_CHANGED/);
    const accepted = structuredClone(current.plan.protocol); accepted.policies.decision.mode = 'acceptance'; sealProtocol(accepted);
    assert.equal(validateProtocol(accepted, { stage: 'execute' }).valid, false);
  });
  const episodes = [], status = await runBatch({ plan: current.plan, executeEpisode: async ({ plan, slot, runId }) => {
    const result = await resultFor(plan, slot, runId); episodes.push(await read(join(result.normalized_directory, 'episode.json'))); return result;
  } });
  assert.equal(status.completed, 11); assert.equal(episodes.length, 11);
  const report = scoreExperiment({ protocol: current.plan.protocol, episodes });
  assert.equal(report.completeness.planned_slots, 32); assert.equal(report.completeness.valid_slots, 11);
  assert.equal(report.completeness.unresolved_slots.length, 21);
  assert.equal(report.cost_ledger.actual_runs, 11);
  await runBatch({ plan: current.plan, executeEpisode: () => assert.fail('No twelfth follow-up observation') });
  assert.equal((await readdir(f.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 61);
});

test('finite policies are exact and cannot encode a partial 24-slot cohort', () => {
  const input = { kind: FINITE_CAMPAIGN, id: 'scope', role: 'route_gate_only' };
  assert.equal(finiteCampaignPolicy(input, { scheduledEpisodes: 8 }).reservation_limit, 8);
  for (const count of [0, 7, 9, 24, 145]) assert.throws(() => finiteCampaignPolicy(input, { scheduledEpisodes: count }));
  assert.throws(() => finiteCampaignPolicy({ ...input, role: 'expansion' }, { scheduledEpisodes: 8 }));
});

test('a finite gate retains original history, binds every execution field, closes exactly eight, then permits genuine confirmation', async t => {
  const f = await fixture(), current = await prepare(f), { plan, amendment } = current;
  assert.equal(amendment.history.scheduled_episodes, 37); assert.deepEqual(amendment.history.unknown_usage_run_ids, f.unknowns);
  assert.equal(amendment.history.total_usage.input_tokens, null); assert.equal(amendment.history_exemption.scheduled_episodes, 13);
  assert.deepEqual(await readFiniteCampaignAmendment(plan.execution.campaign_scope.amendment), amendment);
  await verifyFiniteCampaignScope(plan, { forReservation: true });
  await t.test('protocol, execution, schedule and history exemptions cannot drift', () => {
    for (const mutate of [p => { p.execution.runtime = { node: '/changed' }; }, p => { p.execution.instrumentation.scope = 'changed'; },
      p => { p.slots[0].seed++; }, p => { p.protocol.models[0].route = 'other/route'; sealProtocol(p.protocol); },
      p => { p.protocol.policies.budgets[0].episode.max_input_tokens++; sealProtocol(p.protocol); },
      p => { p.execution.pilot_scope = {}; }, p => { p.execution.resumption = {}; }]) {
      const changed = structuredClone(plan); mutate(changed); resealPlan(changed); assert.throws(() => assertFiniteCampaignPlan(changed, amendment));
    }
    const changed = structuredClone(amendment); changed.history_exemption.scheduled_episodes++; changed.amendment_sha256 = fingerprint({ ...changed, amendment_sha256: null });
    assert.throws(() => assertFiniteCampaignPlan(plan, changed), /THIRTEEN_ONLY/);
  });
  await t.test('active shared lease blocks preparation before new scope writes', async () => {
    const lease = join(f.pilot, 'campaign.lease.json'); await save(lease, { pid: process.pid });
    await assert.rejects(prepare(f, { id: 'active-lease' }), /ACTIVE_LEASE/); await rename(lease, lease + '.retained');
  });

  await t.test('preparation rejects a canonical-looking root through a symlink ancestor', async () => {
    const alias = join(f.root, 'owner-alias'); await symlink(f.owner, alias);
    const execution = structuredClone(plan.execution); delete execution.campaign_scope;
    execution.environment_root = alias; execution.control_root = join(alias, 'finite-gate');
    await assert.rejects(prepareFiniteCampaign({ setup: { campaign_scope: current.input }, protocol: plan.protocol, execution, slots: plan.slots }), /ROOT_SYMLINK/);
    const linked = join(plan.execution.control_root, 'linked-amendment.json'); await symlink(plan.execution.campaign_scope.amendment.path, linked);
    await assert.rejects(readFiniteCampaignAmendment({ ...plan.execution.campaign_scope.amendment, path: linked }), /REGULAR_FILE/);
  });
  await t.test('a full predecessor count cannot hide a foreign scope reservation', async () => {
    const path = join(f.pilot, '037.json'), bytes = await readFile(path), row = JSON.parse(bytes); row.scope_id = 'foreign-scope'; await save(path, row);
    await assert.rejects(prepare(f, { id: 'foreign-predecessor' })); await writeFile(path, bytes);
  });
  await writeClosedPlan(plan, { startOrdinal: 38, count: 1 }); await verifyFiniteCampaignScope(plan);

  await t.test('same-run unfinished evidence may be reconciled but never reserves another slot', async () => {
    const path = join(plan.execution.control_root, 'ledger.jsonl'), bytes = await readFile(path);
    const rows = bytes.toString().trimEnd().split('\n').map(JSON.parse).filter(row => row.type !== 'episode_completed').map((row, index) => ({ ...row, seq: index + 1 }));
    await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    await verifyFiniteCampaignScope(plan); await assert.rejects(verifyFiniteCampaignScope(plan, { forReservation: true }), /UNRESOLVED_PREVIOUS_EXECUTION/);
    await writeFile(path, JSON.stringify({ seq: 1, type: 'batch_closed' }) + '\n');
    await assert.rejects(verifyFiniteCampaignScope(plan), /ORPHAN_RESERVATION/); await writeFile(path, bytes);
  });
  await t.test('a closed slice is not a completed finite predecessor', async () => {
    const premature = await successor(f, current, 3);
    await assert.rejects(prepare(premature, { id: 'premature' }), /PREDECESSOR_INCOMPLETE/);
    await rename(join(f.pilot, 'scope-registration-003.json'), join(f.pilot, 'scope-registration-003.fixture-retained.json'));
  });
  await writeClosedPlan(plan, { startOrdinal: 38, count: 8, prefixCount: 1 });
  await verifyFiniteCampaignScope(plan); await assert.rejects(verifyFiniteCampaignScope(plan, { forReservation: true }), { code: 'COHORT_CAP' });
  await t.test('scope/owner, stop and known-usage violations reject further reservation', async () => {
    const reservation = join(f.pilot, '045.json'), bytes = await readFile(reservation), value = JSON.parse(bytes); value.scope_id = 'other'; await save(reservation, value);
    await assert.rejects(verifyFiniteCampaignScope(plan), /FOREIGN_RESERVATION/); await writeFile(reservation, bytes);
    const ledger = join(plan.execution.control_root, 'ledger.jsonl'), ledgerBytes = await readFile(ledger);
    const rows = ledgerBytes.toString().trimEnd().split('\n').map(JSON.parse), event = rows.find(row => row.type === 'episode_completed');
    event.result.stop_batch = true; await writeFile(ledger, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    await assert.rejects(verifyFiniteCampaignScope(plan), /ORIGINAL_CORE_STOP/);
    event.result.stop_batch = false; event.result.budget_usage.input_tokens = null; await writeFile(ledger, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    await assert.rejects(verifyFiniteCampaignScope(plan), /ORIGINAL_UNKNOWN_USAGE/); await writeFile(ledger, ledgerBytes);
  });

  await t.test('reordering two current reservations cannot change their registered slot order', async () => {
    const a = join(f.pilot, '038.json'), b = join(f.pilot, '039.json'), ab = await readFile(a), bb = await readFile(b);
    await writeFile(a, bb); await writeFile(b, ab);
    await assert.rejects(verifyFiniteCampaignScope(plan), /RESERVATION_ORDER_CHANGED/);
    await writeFile(a, ab); await writeFile(b, bb);
  });
  await t.test('a revision reference cannot hide an original stop or unknown before override validation', async () => {
    const path = join(plan.execution.control_root, 'ledger.jsonl'), bytes = await readFile(path);
    const rows = bytes.toString().trimEnd().split('\n').map(JSON.parse), event = rows.find(row => row.type === 'episode_completed');
    const last = rows.pop(); rows.push({ seq: rows.length + 1, type: 'analysis_revision_applied', reference: { path: join(plan.execution.control_root, 'must-not-be-read.json'), sha256: 'f'.repeat(64) } });
    rows.push({ ...last, seq: rows.length + 1 });
    const originalUsage = structuredClone(event.result.budget_usage);
    for (const kind of ['stop', 'usage']) {
      event.result.stop_batch = kind === 'stop'; event.result.budget_usage = structuredClone(originalUsage);
      if (kind === 'usage') event.result.budget_usage.input_tokens = null;
      await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      const error = kind === 'stop' ? /ORIGINAL_CORE_STOP/ : /ORIGINAL_UNKNOWN_USAGE/;
      await assert.rejects(verifyFiniteCampaignScope(plan), error);
      await assert.rejects(verifyFiniteOriginalResults(plan, rows), error);
      await assert.rejects(readFiniteCampaignHistory({ planFiles: [...f.historyPlans, join(plan.execution.control_root, 'plan.json')], pilotLedgerRoot: f.pilot }), error);
    }
    await writeFile(path, bytes);
  });
  const next = await successor(f, current, 3);
  await t.test('confirmation cannot rename the split or rebind known canonical material', async () => {
    await assert.rejects(prepare(next, { id: 'exposed', role: 'acceptance', phase: 'confirmation', exposed: true }), /KNOWN_MATERIAL_EXPOSURE/);
    await assert.rejects(prepare(next, { id: 'rebound-exposed', role: 'acceptance', phase: 'confirmation', canonicalExposure: true }), /KNOWN_MATERIAL_EXPOSURE/);
  });
  const confirmation = await prepare(next, { id: 'confirmation', role: 'acceptance', phase: 'confirmation' });
  assert.equal(confirmation.plan.protocol.phase, 'confirmation'); assert.equal(confirmation.amendment.history.scheduled_episodes, 45);
  await writeClosedPlan(confirmation.plan, { startOrdinal: 46 }); await verifyFiniteCampaignScope(confirmation.plan);
  await t.test('new reader accepts typed confirmation while legacy pilot history remains strict', async () => {
    const planFiles = [...next.historyPlans, join(confirmation.plan.execution.control_root, 'plan.json')];
    const history = await readFiniteCampaignHistory({ planFiles, pilotLedgerRoot: f.pilot }); assert.equal(history.scheduled_episodes, 53);
    assert.deepEqual(history.unknown_usage_run_ids, f.unknowns);
    await assert.rejects(readCohortHistory({ planFiles, pilotLedgerRoot: f.pilot }));
  });
  const originalGateRows = (await readFile(join(plan.execution.control_root, 'ledger.jsonl'), 'utf8')).trimEnd().split('\n').map(JSON.parse);
  assert.equal((await verifyFiniteOriginalResults(plan, originalGateRows)).original_completed, 8, 'Old gate original checks remain valid after later reservations');
  const afterConfirmation = await successor(next, confirmation, 4), failing = await prepare(afterConfirmation, { id: 'new-unknown' });
  await writeClosedPlan(failing.plan, { startOrdinal: 54, unknownLast: true });
  await assert.rejects(verifyFiniteCampaignScope(failing.plan), /ORIGINAL_CORE_STOP/);
  await t.test('a new unknown cannot be moved into another historical exemption', async () => {
    const proposed = await successor(afterConfirmation, failing, 5);
    await assert.rejects(prepare(proposed, { id: 'cannot-acknowledge-new-unknown' }), /ORIGINAL_CORE_STOP|ORIGINAL_UNKNOWN_USAGE|NEW_UNKNOWN_CANNOT_BECOME_HISTORY/);
  });
});


test('actual batch dispatch charges the shared ledger under its campaign lease for gate and genuine confirmation', async () => {
  const f = await fixture(), gate = await prepare(f, { id: 'integration-gate' });
  const calls = new Map();
  const execute = (base, unknown = false) => async ({ plan, slot, runId }) => {
    const count = calls.get(plan.id) ?? 0;
    const reservation = await read(join(f.pilot, String(base + count + 1).padStart(3, '0') + '.json'));
    assert.equal(reservation.run_id, runId); assert.equal(reservation.slot_id, slot.slot_id);
    assert.equal(reservation.plan_sha256, plan.plan_sha256); assert.equal(reservation.scope_kind, FINITE_CAMPAIGN);
    const campaignLease = await read(join(f.pilot, 'campaign.lease.json'));
    assert.equal(campaignLease.plan_sha256, plan.plan_sha256); assert.equal(campaignLease.control_root, plan.execution.control_root);
    const batchLease = await read(join(plan.execution.control_root, 'lease.json')); assert.equal(batchLease.plan_sha256, plan.plan_sha256);
    const rows = (await readFile(join(plan.execution.control_root, 'ledger.jsonl'), 'utf8')).trimEnd().split('\n').map(JSON.parse);
    assert.ok(rows.some(row => row.type === 'episode_started' && row.run_id === runId && row.slot_id === slot.slot_id));
    calls.set(plan.id, count + 1);
    return resultFor(plan, slot, runId, unknown ? { attempts: [null], valid: false, stop: true } : { outcome: count % 3 === 1 ? 'fail' : 'pass' });
  };
  await runBatch({ plan: gate.plan, maximumNewEpisodes: 1, executeEpisode: execute(37) });
  assert.equal(calls.get(gate.plan.id), 1);
  const gateStatus = await runBatch({ plan: gate.plan, executeEpisode: execute(37) });
  assert.equal(gateStatus.completed, 8); assert.equal(calls.get(gate.plan.id), 8);
  const repeat = await runBatch({ plan: gate.plan, executeEpisode: () => assert.fail('No ninth callback after exact eight slots') }); assert.equal(repeat.completed, 8);
  await assert.rejects(verifyFiniteCampaignScope(gate.plan, { forReservation: true }), { code: 'COHORT_CAP' });
  const gateProof = await writeRouteGate({ plan: gate.plan, status: repeat, outputFile: join(f.owner, 'integration-gate-proof.json') });
  assert.equal((await verifyGateReference({ reference: gateProof.reference, environmentRoot: f.owner })).kind, 'benchmark-finite-route-gate');
  const gateRegistrationPath = join(f.pilot, 'scope-registration-003.json'), gateRegistration = await read(gateRegistrationPath);
  assert.equal(gateRegistration.kind, 'benchmark-finite-campaign-succession'); assert.deepEqual(gateRegistration.predecessor, f.predecessor.registration);
  const afterGate = { ...f, count: 45, historyPlans: [...f.historyPlans, join(gate.plan.execution.control_root, 'plan.json')],
    predecessor: { registration: await reference(gateRegistrationPath), amendment: gate.plan.execution.campaign_scope.amendment } };
  const confirmation = await prepare(afterGate, { id: 'integration-confirmation', role: 'acceptance', phase: 'confirmation' });
  assert.equal(confirmation.plan.protocol.phase, 'confirmation'); assert.equal(confirmation.plan.execution.pilot_ledger_root, f.pilot);
  const status = await runBatch({ plan: confirmation.plan, executeEpisode: execute(45) });
  assert.equal(status.completed, 8); assert.equal(calls.get(confirmation.plan.id), 8);
  await runBatch({ plan: confirmation.plan, executeEpisode: () => assert.fail('No ninth confirmation callback') });
  assert.equal((await readdir(f.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 53);
  assert.equal((await verifyGateReference({ reference: gateProof.reference, environmentRoot: f.owner })).kind, 'benchmark-finite-route-gate', 'Historical gate remains verifiable after later campaign reservations');
  const confirmationRegistrationPath = join(f.pilot, 'scope-registration-004.json'), confirmationRegistration = await read(confirmationRegistrationPath);
  assert.equal(confirmationRegistration.kind, 'benchmark-finite-campaign-succession'); assert.deepEqual(confirmationRegistration.predecessor, afterGate.predecessor.registration);
  const afterConfirmation = { ...afterGate, count: 53, historyPlans: [...afterGate.historyPlans, join(confirmation.plan.execution.control_root, 'plan.json')],
    predecessor: { registration: await reference(confirmationRegistrationPath), amendment: confirmation.plan.execution.campaign_scope.amendment } };
  const unknown = await prepare(afterConfirmation, { id: 'integration-unknown' });
  const stopped = await runBatch({ plan: unknown.plan, maximumNewEpisodes: 1, executeEpisode: execute(53, true) });
  assert.equal(stopped.completed, 1); assert.equal(calls.get(unknown.plan.id), 1);
  await assert.rejects(runBatch({ plan: unknown.plan, executeEpisode: () => assert.fail('New unknown must stop before callback') }), /ORIGINAL_CORE_STOP/);
  assert.equal((await readdir(f.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 54);
});
