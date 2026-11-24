import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fingerprint, validateProtocol } from './protocol.mjs';
import { createPreregistrationTemplate } from './templates/preregistration.mjs';
import { preregisterComparison } from './planning.mjs';
import { freezeBatchPlan, scheduleProtocol, runBatch } from './batch.mjs';
import { writeRouteGate, verifyGateReference } from './gate.mjs';
import { pilotScopePolicy, preparePilotScope, readPilotScopeAmendment, scopeReservationFields } from './pilot-scope.mjs';
import { PROSPECTIVE_COHORT, readCohortHistory } from './prospective-cohort.mjs';
import { FINITE_CAMPAIGN, finiteCampaignPolicy, prepareFiniteCampaign, assertFiniteCampaignPlan,
  readFiniteCampaignAmendment, verifyFiniteCampaign, verifyFiniteCampaignScope, finiteCampaignReservationFields, readFiniteCampaignHistory, readAliasRevisionHistory, verifyFiniteOriginalResults, readAcceptedHistoryExtension, readAcceptedConfirmationContinuation } from './finite-campaign.mjs';
import { exampleEnvelope } from './analysis/fixtures.mjs';
import { normalizeEpisode } from './evidence/normalize.mjs';
import { writeEvidenceBundle } from './evidence/store.mjs';
import { assessReportedModel } from './reported-model.mjs';
import { prepareApprovedCampaign, prepareApprovedCampaignRevision, prepareApprovedCampaignHistoryExtension, prepareApprovedCampaignConfirmationContinuation, readApprovedCampaign } from './approved-campaign.mjs';
import { declaredSchedule, UNSTARTED_FOLLOWUP, CONFIRMATION_CONTINUATION } from './campaign-selection.mjs';
import { startupCaptureSchedule, captureBindingsForCase } from './configure.mjs';
import { scoreExperiment } from './analysis/compare.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const reference = async path => ({ path, sha256: sha(await readFile(path)) });
const instrumentation = { version: 1, runtime_sha256: ['a'.repeat(64)], collector_files: [], collector_sha256: fingerprint([]), scope: 'offline fixture only' };
const expansionIds = Array.from({ length: 8 }, (_, i) => 'expansion-case-' + i);

// Synthetic evidence fixtures exercise contracts/accounting, never paid models.
function fixtureProtocol(id, { scope, modelCount = 2, expansion = false, routing = false, caseCount = 4 } = {}) {
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
  const ids = expansion ? expansionIds : Array.from({ length: caseCount }, (_, i) => 'gate-case-' + i);
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

async function resultFor(plan, slot, runId, { attempts = [50], attemptsComplete = true, valid = true, stop = false, outcome = 'pass', omitRouting = false, reportedLabel, aliasStop = false, usageStop = false, admissionStop } = {}) {
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
    const label = reportedLabel ?? model.routing.reported_model_ids[0];
    const events = envelope.input.attempts.map(attempt => ({ type: 'provider_stream_event', data: { request_id: attempt.request_id,
      attempt_id: attempt.id, api: model.api, model: model.route, provider: model.provider,
      event: model.api === 'openai-completions' ? { model: label } : { response: { model: label } } } }));
    const text = events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
    const path = join(rawRoot, runId + '-provider.jsonl'); await writeFile(path, text);
    const artifact = { id: 'provider-events', path, sha256: sha(text), bytes: Buffer.byteLength(text), kind: 'jsonl' }; envelope.input.artifacts.push(artifact);
    for (const [index, attempt] of envelope.input.attempts.entries()) {
      const ref = { artifact_id: artifact.id, sha256: artifact.sha256, line: index + 1 };
      attempt.reported_model = assessReportedModel({ routing: model.routing, sent: attempt.sent, observations: [{ value: label,
        field: model.api === 'openai-completions' ? '/data/event/model' : '/data/event/response/model', bound: true, ref }], refs: [ref] });
    }
  }
  if (aliasStop) {
    envelope.input.admission.reasons = ['reported_model_mismatch', 'runtime_not_a_business_episode:invalid'];
    const runtime = { status: 'invalid', error: { code: 'BENCHMARK_REPORTED_MODEL_MISMATCH',
      details: { reported_model: envelope.input.attempts[0].reported_model } },
      budget: { usage_unknown: false, requests: 1, attempts: 1, input_tokens: attempts[0], output_tokens: 10 } };
    const path = join(rawRoot, runId + '-runtime.json'), bytes = JSON.stringify(runtime) + '\n'; await writeFile(path, bytes);
    envelope.input.artifacts.push({ id: 'collection-runtime-result', path, sha256: sha(bytes), bytes: Buffer.byteLength(bytes), kind: 'json' });
  }
  if (usageStop) {
    const runtime = { status: 'invalid', error: { code: 'BENCHMARK_USAGE_UNKNOWN' },
      budget: { usage_unknown: true, requests: attempts.length, attempts: attempts.length,
        input_tokens: attempts.reduce((sum, value) => sum + (value ?? 0), 0), output_tokens: attempts.length * 10 } };
    const path = join(rawRoot, runId + '-runtime.json'), bytes = JSON.stringify(runtime) + '\n'; await writeFile(path, bytes);
    envelope.input.artifacts.push({ id: 'collection-runtime-result', path, sha256: sha(bytes), bytes: Buffer.byteLength(bytes), kind: 'json' });
  }
  if (admissionStop) await admissionStopArtifacts(envelope, plan, slot, runId, admissionStop);
  await writeFile(rawPath, envelope.rawText);
  const bundle = normalizeEpisode(envelope.input), episode = bundle.episode, directory = join(root, 'evidence', runId);
  await writeEvidenceBundle({ directory, bundle, rawRoot: root });
  return { status: admissionStop ? 'admission_rejected' : valid ? 'completed' : 'invalid', normalized_directory: directory, episode_sha256: episode.episode_sha256,
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
async function writeClosedPlan(plan, { startOrdinal, count = plan.slots.length, prefixCount = 0, unknownLast = false, unknownIndices = [], resultOptions } = {}) {
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
    const result = await resultFor(plan, slot, runId, (typeof resultOptions === 'function' ? resultOptions(i) : resultOptions)
      ?? (unknown ? { attempts: [null], valid: false, stop: true } : { outcome: i % 3 === 1 ? 'fail' : 'pass' }));
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
  route, protocol: suppliedProtocol, selection, prepareExecution } = {}) {
  const control = join(f.owner, id); await mkdir(control, { recursive: true });
  const input = { kind: FINITE_CAMPAIGN, id, role, authorization: 'Synthetic finite campaign contract', predecessor: f.predecessor, history_plan_files: f.historyPlans,
    ...(f.approval ? { prospective_authorization: f.approval, allocation_id: id } : {}), ...(selection ? { selection } : {}) };
  const p = suppliedProtocol ? structuredClone(suppliedProtocol) : fixtureProtocol(id, { modelCount: 1, routing: true });
  p.id = id; p.phase = phase; delete p.policies.pilot.scope;
  if (route) p.models[0].route = route;
  if (phase === 'confirmation' && role !== CONFIRMATION_CONTINUATION) {
    for (const item of p.corpus.cases) {
      item.split = 'confirmation'; item.material_id = id + '-' + item.material_id;
      if (!exposed) for (const key of ['content_sha256', 'prompt_sha256', 'contract_sha256', 'initial_state_sha256', 'authorization_sha256']) item[key] = fingerprint({ confirmation: id, case: item.id, key });
    }
  }
  const count = selection?.slot_ids.length ?? declaredSchedule(p).length;
  p.policies.budgets[0].batch.max_episodes = count;
  p.policies.campaign = finiteCampaignPolicy(input, { scheduledEpisodes: count }); sealProtocol(p);
  const execution = { environment_root: f.owner, control_root: control, pilot_ledger_root: f.pilot, instrumentation, models_sha256: fingerprint({ models: 1 }) };
  if (canonicalExposure) {
    const bindings = p.corpus.cases.map((item, index) => ({ ...structuredClone(f.originalBindings[index]), id: item.id, protocol_case: item }));
    const path = join(control, 'bindings.json'); await save(path, bindings); execution.case_bindings_file = path; execution.case_bindings_sha256 = sha(await readFile(path));
  }
  if (prepareExecution) { await prepareExecution(p, execution); sealProtocol(p); }
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

async function approveStoppedFixture(f, { grokRoute = 'grok/fixture-0' } = {}) {
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
      ...([1, 2].includes(index) ? { route: 'provider/' + (index === 1 ? grokRoute : 'terra/fixture-0') } : {}) })),
    retained_stop: { run_id: stop.run_id, result_sha256: normalized.admission.refs[0].sha256,
      normalized_episode_sha256: normalized.episode_sha256, current_scope_still_stopped: true, usage_still_unknown: true, invalid_still_retained: true } };
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
    const retainedEpisodePath = join(original.history.episodes.at(-1).directory, 'episode.json');
    const retainedEpisodeBytes = await readFile(retainedEpisodePath), retainedEpisode = JSON.parse(retainedEpisodeBytes);
    assert.notEqual(sha(retainedEpisodeBytes), retainedEpisode.episode_sha256, 'Real proposals bind semantic episode hashes rather than JSON file hashes');
    retainedEpisode.identity.case_id = 'tampered'; await save(retainedEpisodePath, retainedEpisode);
    await assert.rejects(prepareApprovedCampaign(original), /RETAINED_STOP_CONTENT_CHANGED/);
    await writeFile(retainedEpisodePath, retainedEpisodeBytes);
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

test('an exact known alias stop permits only its seven unstarted slots under the original 139 ceiling', async t => {
  const f = await approveStoppedFixture(await fixture({ modelCount: 2, expansionCount: 21, unknownExpansion: true }), { grokRoute: 'auto/fixture-0' });
  const originalApprovalBytes = await readFile(f.approval.path);
  const p = fixtureProtocol('approved-grok', { modelCount: 1, routing: true });
  p.models[0].route = 'auto/fixture-0'; p.models[0].routing.mode = 'auto-route';
  const gate = await prepare(f, { id: 'approved-grok', protocol: p });
  const sourcePlan = await reference(join(gate.plan.execution.control_root, 'plan.json'));
  await writeClosedPlan(gate.plan, { startOrdinal: 51, count: 1,
    resultOptions: { valid: false, stop: true, reportedLabel: 'group/auto-fixture-0', aliasStop: true } });
  const stopped = { ...await successor(f, gate, 3), count: 51 };
  const sourceLedger = join(gate.plan.execution.control_root, 'ledger.jsonl'), stoppedBytes = await readFile(sourceLedger);
  const metadataPath = join(f.owner, 'route-metadata.json');
  await save(metadataPath, { command: ['magpie', 'group', 'auto-fixture-0'], exit_code: 0, stdout: 'Fixture  auto/fixture-0\n' });
  const inputs = { id: 'alias-revision', parentAuthorization: f.approval, predecessor: stopped.predecessor,
    followupAllocationId: 'approved-grok-unstarted', sourcePlan, metadata: await reference(metadataPath) };
  const historyInputs = { ...inputs, planFiles: stopped.historyPlans, pilotLedgerRoot: f.pilot };
  await assert.rejects(readFiniteCampaignHistory({ planFiles: stopped.historyPlans, pilotLedgerRoot: f.pilot,
    prospectiveAuthorization: f.approval }), /ORIGINAL_CORE_STOP/);
  const history = await readAliasRevisionHistory(historyInputs);
  const revision = await prepareApprovedCampaignRevision({ ...inputs, history });
  assert.equal(revision.version, 2); assert.equal(revision.history.scheduled_episodes, 51);
  assert.equal(revision.new_reservation_ceiling, 88); assert.equal(revision.total_reservation_ceiling, 139);
  assert.equal(revision.max_scheduled_episodes, 144);
  assert.deepEqual(revision.history.unknown_usage_run_ids, f.approvedDocument.history.unknown_usage_run_ids);
  assert.equal(revision.history.episodes.at(-1).admission, 'invalid');
  assert.equal(revision.history.episodes.at(-1).stop_batch, true);
  assert.equal(revision.history.known_subtotal.model_requests, f.approvedDocument.history.known_subtotal.model_requests + 1);
  assert.deepEqual(revision.allocations.filter(item => item.id !== inputs.followupAllocationId),
    f.approvedDocument.allocations.filter(item => item.id !== 'approved-grok'));
  const revisionPath = join(f.owner, 'alias-revision.json'); await save(revisionPath, revision);
  const revisionRef = await reference(revisionPath);
  const revised = { ...stopped, approval: revisionRef };
  assert.deepEqual((await readApprovedCampaign(revisionRef)).value, revision);

  await t.test('hash, authority, predecessor, allocation and retained-result changes are rejected', async () => {
    for (const ref of [inputs.parentAuthorization, inputs.metadata, inputs.sourcePlan]) {
      const bytes = await readFile(ref.path); await writeFile(ref.path, Buffer.concat([bytes, Buffer.from(' ')]));
      await assert.rejects(readApprovedCampaign(revisionRef), /CHANGED/); await writeFile(ref.path, bytes);
    }
    const changedInputs = { ...inputs, predecessor: f.predecessor, history };
    await assert.rejects(prepareApprovedCampaignRevision(changedInputs));
    const badHist = structuredClone(history); badHist.unknown_usage_run_ids.push('new-unknown');
    await assert.rejects(prepareApprovedCampaignRevision({ ...inputs, history: badHist }), /NEW_UNKNOWN/);
    await assert.rejects(prepareApprovedCampaignRevision({ ...inputs, history, followupAllocationId: 'approved-terra' }), /FRESH_ALLOCATION/);
    await assert.rejects(prepareApprovedCampaignRevision({ ...inputs, history, parentAuthorization: revisionRef }), /ORIGINAL_APPROVAL_ONLY/);
    const cases = [
      value => { value.allocations[1].reservation_limit = 8; value.new_reservation_ceiling = 89; value.total_reservation_ceiling = 140; },
      value => { value.allocations[0].reservation_limit--; value.allocations[1].reservation_limit++; },
      value => { value.allocations[0].id = value.allocations[1].id; },
      value => { value.history.episodes.at(-1).admission = 'valid'; value.history_checkpoint_sha256 = fingerprint(value.history); },
      value => { value.revision.retained_stop.reported_model_id = 'group/auto-other'; },
    ];
    for (const [index, change] of cases.entries()) {
      const changed = structuredClone(revision); change(changed); changed.authorization_sha256 = fingerprint({ ...changed, authorization_sha256: null });
      const path = join(f.owner, 'invalid-revision-' + index + '.json'); await save(path, changed);
      await assert.rejects(readApprovedCampaign(await reference(path)));
    }
    await assert.rejects(prepare(revised, { id: 'approved-terra', route: 'terra/fixture-0' }), /FOLLOWUP_FIRST/);
  });

  const protocol = structuredClone(gate.plan.protocol);
  protocol.models[0].routing.reported_model_ids.push('group/auto-fixture-0');
  const selection = { source_plan_sha256: gate.plan.plan_sha256, slot_ids: gate.plan.slots.slice(1).map(slot => slot.slot_id) };
  const followup = await prepare(revised, { id: inputs.followupAllocationId, role: UNSTARTED_FOLLOWUP, protocol, selection });
  assert.equal(followup.plan.slots.length, 7);
  assert.equal(declaredSchedule(followup.plan.protocol).length, 8);
  assert.deepEqual(followup.plan.slots, gate.plan.slots.slice(1).map((slot, order) => ({ ...slot, order })));
  assert.equal(followup.amendment.history_exemption.scheduled_episodes, 13);
  assert.equal(followup.amendment.prospective_authorization.history_boundary.scheduled_episodes, 51);
  const execution = structuredClone(followup.plan.execution); delete execution.campaign_scope;

  await t.test('no invalid cell, extra alias, route, subject or statistical denominator change is hidden in the repair', async () => {
    const replay = structuredClone(followup.plan.protocol), replayInput = structuredClone(followup.input);
    replayInput.selection.slot_ids = gate.plan.slots.slice(0, 7).map(slot => slot.slot_id);
    replay.policies.campaign.selection = replayInput.selection; sealProtocol(replay);
    await assert.rejects(prepareFiniteCampaign({ setup: { campaign_scope: replayInput }, protocol: replay, execution, slots: scheduleProtocol(replay) }), /EXACT_UNSTARTED_SUFFIX/);
    for (const change of [
      value => value.models[0].routing.reported_model_ids.push('another/fixture-0'),
      value => { value.models[0].backend.window.end = '2026-11-24T01:00:00Z'; },
      value => { value.environments[0].build.id = 'other-build'; value.environments[0].manifest_sha256 = fingerprint({ ...value.environments[0], manifest_sha256: null }); },
      value => { value.policies.statistics.confidence = 0.90; },
    ]) {
      const changed = structuredClone(followup.plan.protocol); change(changed); sealProtocol(changed);
      await assert.rejects(prepareFiniteCampaign({ setup: { campaign_scope: followup.input }, protocol: changed, execution, slots: scheduleProtocol(changed) }));
    }
    await assert.rejects(verifyFiniteCampaignScope(gate.plan, { forReservation: true }), /ORIGINAL_CORE_STOP/);
  });

  const observations = [];
  const status = await runBatch({ plan: followup.plan, executeEpisode: async ({ plan, slot, runId }) => {
    const result = await resultFor(plan, slot, runId, { reportedLabel: 'group/auto-fixture-0' });
    observations.push(await read(join(result.normalized_directory, 'episode.json'))); return result;
  } });
  assert.equal(status.completed, 7); assert.equal(observations.length, 7);
  const report = scoreExperiment({ protocol: followup.plan.protocol, episodes: observations });
  assert.equal(report.completeness.planned_slots, 8); assert.equal(report.completeness.valid_slots, 7);
  assert.equal(report.completeness.unresolved_slots.length, 1); assert.equal(report.cost_ledger.actual_runs, 7);
  const afterFollowup = { ...revised, count: 58, historyPlans: [...revised.historyPlans, join(followup.plan.execution.control_root, 'plan.json')],
    predecessor: { registration: await reference(join(f.pilot, 'scope-registration-004.json')), amendment: followup.plan.execution.campaign_scope.amendment } };
  await assert.rejects(prepare(afterFollowup, { id: inputs.followupAllocationId, role: UNSTARTED_FOLLOWUP, protocol, selection }), /ALLOCATION_REUSED/);
  const terra = await prepare(afterFollowup, { id: 'approved-terra', route: 'terra/fixture-0' });
  await runBatch({ plan: terra.plan, executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId) });
  const afterTerra = { ...afterFollowup, count: 66, historyPlans: [...afterFollowup.historyPlans, join(terra.plan.execution.control_root, 'plan.json')],
    predecessor: { registration: await reference(join(f.pilot, 'scope-registration-005.json')), amendment: terra.plan.execution.campaign_scope.amendment } };
  const originalExpansion = await read(f.historyPlans.at(-1));
  const oldSelection = { source_plan_sha256: originalExpansion.plan_sha256, slot_ids: originalExpansion.slots.slice(21).map(slot => slot.slot_id) };
  const oldFollowup = await prepare(afterTerra, { id: 'approved-followup', role: UNSTARTED_FOLLOWUP, protocol: originalExpansion.protocol, selection: oldSelection });
  assert.equal(oldFollowup.plan.slots.length, 11); assert.equal(declaredSchedule(oldFollowup.plan.protocol).length, 32);
  let unknownCalls = 0;
  await runBatch({ plan: oldFollowup.plan, executeEpisode: ({ plan, slot, runId }) => {
    unknownCalls++; return resultFor(plan, slot, runId, { attempts: [null], valid: false, stop: true });
  } });
  assert.equal(unknownCalls, 1);
  await assert.rejects(readFiniteCampaignHistory({ planFiles: [...afterTerra.historyPlans, join(oldFollowup.plan.execution.control_root, 'plan.json')],
    pilotLedgerRoot: f.pilot, prospectiveAuthorization: revisionRef }), /ORIGINAL_CORE_STOP/);
  await assert.rejects(runBatch({ plan: oldFollowup.plan, executeEpisode: () => assert.fail('New unknown cannot become another amendment exemption') }), /ORIGINAL_CORE_STOP/);
  assert.equal((await readdir(f.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 67);
  assert.deepEqual(await readFile(f.approval.path), originalApprovalBytes);
  assert.deepEqual(await readFile(sourceLedger), stoppedBytes);
});

async function acceptedExtensionFixture() {
  const f = await approveStoppedFixture(await fixture({ modelCount: 2, expansionCount: 21, unknownExpansion: true }), { grokRoute: 'auto/fixture-0' });
  const protocol = fixtureProtocol('approved-grok', { modelCount: 1, routing: true });
  protocol.models[0].route = 'auto/fixture-0'; protocol.models[0].routing.mode = 'auto-route';
  const gate = await prepare(f, { id: 'approved-grok', protocol });
  await writeClosedPlan(gate.plan, { startOrdinal: 51, count: 1,
    resultOptions: { valid: false, stop: true, reportedLabel: 'group/auto-fixture-0', aliasStop: true } });
  const alias = { ...await successor(f, gate, 3), count: 51 };
  const metadataPath = join(f.owner, 'alias-metadata.json');
  await save(metadataPath, { command: ['magpie', 'group', 'auto-fixture-0'], exit_code: 0, stdout: 'Fixture auto/fixture-0\n' });
  const aliasInputs = { id: 'alias-authority', parentAuthorization: f.approval, predecessor: alias.predecessor,
    sourcePlan: await reference(join(gate.plan.execution.control_root, 'plan.json')), metadata: await reference(metadataPath), followupAllocationId: 'approved-grok-unstarted' };
  const aliasHistory = await readAliasRevisionHistory({ ...aliasInputs, planFiles: alias.historyPlans, pilotLedgerRoot: f.pilot });
  const parentValue = await prepareApprovedCampaignRevision({ ...aliasInputs, history: aliasHistory });
  const parentPath = join(f.owner, 'alias-authority.json'); await save(parentPath, parentValue);
  const parentReference = await reference(parentPath), revised = { ...alias, approval: parentReference };
  const followupProtocol = structuredClone(gate.plan.protocol); followupProtocol.models[0].routing.reported_model_ids.push('group/auto-fixture-0');
  const selection = { source_plan_sha256: gate.plan.plan_sha256, slot_ids: gate.plan.slots.slice(1).map(slot => slot.slot_id) };
  const grok = await prepare(revised, { id: aliasInputs.followupAllocationId, role: UNSTARTED_FOLLOWUP, protocol: followupProtocol, selection });
  await writeClosedPlan(grok.plan, { startOrdinal: 52 }); const afterGrok = await successor(revised, grok, 4);
  const terra = await prepare(afterGrok, { id: 'approved-terra', route: 'terra/fixture-0' });
  await writeClosedPlan(terra.plan, { startOrdinal: 59,
    resultOptions: index => index === 7 ? { attempts: [50, null], valid: false, stop: true, usageStop: true } : {} });
  const stopped = await successor(afterGrok, terra, 5);
  const rows = (await readFile(join(terra.plan.execution.control_root, 'ledger.jsonl'), 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const terminal = rows.filter(row => row.type === 'episode_completed').at(-1);
  const stop = { physical_reservations: 66, approved_total: 139, hard_limit: 144, remaining_approved_unsent: 73, unallocated_spare: 5,
    scope_completed: 8, last_run: terminal.run_id, last_run_result: terminal.result,
    ledger: await reference(join(terra.plan.execution.control_root, 'ledger.jsonl')) };
  const stopPath = join(f.owner, 'accepted-stop.json'); await save(stopPath, stop);
  const draftPath = join(f.owner, 'NEXT-DECISION.md'); await writeFile(draftPath, 'Retain the terminal unknown and continue the existing 73 never-started slots.\n');
  const allocations = parentValue.allocations.filter(item => ![grok.amendment.id, terra.amendment.id].includes(item.id));
  const proposal = { version: 1, kind: 'prospective-decision-draft-not-an-authorization', status: 'awaiting_user_decision', approved: false, execution_authority: null,
    reviewable_draft: await reference(draftPath), existing_ordinary_work_approval: parentValue.user_approval,
    existing_campaign_authority: parentReference, approved_proposal_constraints_source: parentValue.proposal, retained_stop: await reference(stopPath),
    current_reservations: 66, retained_effective_unknown_token_episodes: 5, retained_original_unknown_token_episodes: 5,
    total_approved_ceiling_unchanged: 139, absolute_ceiling_unchanged: 144, additional_reservations_requested: 0,
    unallocated_reservations_stay_unused: 5, remaining_allocations: allocations };
  const proposalPath = join(f.owner, 'accepted-proposal.json'); await save(proposalPath, proposal);
  const decision = { version: 1, kind: 'user-approved-campaign-history-extension-decision', approved: true, source: 'current-user-message',
    user_message: 'Accept this exact history extension', accepted_at: '2026-11-23T12:00:00Z', authorization_scope: 'Continue only the existing 73 slots; future stops remain stops',
    parent_authorization: parentReference, accepted_proposal: await reference(proposalPath), accepted_reviewable_draft: proposal.reviewable_draft,
    current_reservations: 66, retained_effective_unknown_token_episodes: 5, retained_original_unknown_token_episodes: 5,
    approved_remaining_reservations: 73, total_reservation_ceiling: 139, max_scheduled_episodes: 144, unallocated_headroom: 5, additional_reservations: 0,
    next_allocation_id: allocations[0].id, remaining_allocations: allocations, future_core_stop_policy: 'stop', future_unknown_usage_policy: 'stop',
    retained_stop: proposal.retained_stop, provider_diagnosis_authorized: true };
  const decisionPath = join(f.owner, 'accepted-user-decision.json'); await save(decisionPath, decision);
  const inputs = { id: 'accepted-history', parentAuthorization: parentReference, userApproval: await reference(decisionPath), predecessor: stopped.predecessor };
  const historyInputs = { ...inputs, planFiles: stopped.historyPlans, pilotLedgerRoot: f.pilot };
  return { f, stopped, grok, terra, parentValue, parentReference, proposal, proposalPath, decision, inputs, historyInputs, stop };
}

test('a new explicit decision accepts only one terminal unknown after complete allocations and preserves future stops', async t => {
  const fixture = await acceptedExtensionFixture(), { f, stopped, grok, terra, parentValue, parentReference, inputs, historyInputs } = fixture;
  const immutablePaths = [f.approval.path, parentReference.path, fixture.proposalPath, inputs.userApproval.path,
    ...stopped.historyPlans, ...stopped.historyPlans.map(path => join(path.slice(0, -'plan.json'.length), 'ledger.jsonl')),
    ...Array.from({ length: 66 }, (_, index) => join(f.pilot, String(index + 1).padStart(3, '0') + '.json'))];
  const immutable = await Promise.all(immutablePaths.map(async path => [path, await readFile(path)]));
  const initialNames = await readdir(f.pilot);
  await assert.rejects(readFiniteCampaignHistory({ planFiles: stopped.historyPlans, pilotLedgerRoot: f.pilot, prospectiveAuthorization: parentReference }), /ORIGINAL_CORE_STOP/);
  const history = await readAcceptedHistoryExtension(historyInputs);
  const value = await prepareApprovedCampaignHistoryExtension({ ...inputs, history });
  assert.deepEqual(await readdir(f.pilot), initialNames, 'Data-only preparation must not register or reserve');
  assert.equal(value.version, 3); assert.equal(value.history.scheduled_episodes, 66);
  assert.equal(value.new_reservation_ceiling, 73); assert.equal(value.total_reservation_ceiling, 139); assert.equal(value.max_scheduled_episodes, 144);
  assert.equal(value.history.unknown_usage_run_ids.length, 5); assert.equal(value.history.total_usage.input_tokens, null);
  assert.deepEqual(value.history.episodes.slice(0, 51), parentValue.history.episodes);
  assert.deepEqual(value.revision.consumed_allocations, [grok.amendment.id, terra.amendment.id]);
  assert.deepEqual(value.allocations, parentValue.allocations.filter(item => !value.revision.consumed_allocations.includes(item.id)));
  assert.deepEqual(value.proposal, parentValue.proposal); assert.deepEqual(value.user_approval, parentValue.user_approval);
  assert.equal(value.history.episodes.at(-1).stop_batch, true); assert.equal(value.history.episodes.at(-1).admission, 'invalid');
  assert.equal((await read(fixture.proposalPath)).approved, false);
  const path = join(f.owner, 'accepted-history.json'); await save(path, value); const reference3 = await reference(path);
  const checked = await readApprovedCampaign(reference3);
  assert.deepEqual(checked.original.value, f.approvedDocument); assert.equal(checked.retainedAliasStop.retained.ordinal, 51);
  assert.deepEqual(checked.proposal, (await readApprovedCampaign(parentReference)).proposal);
  let serial = 0;
  const rejectedAuthority = async change => {
    const changed = structuredClone(value); await change(changed);
    changed.authorization_sha256 = fingerprint({ ...changed, authorization_sha256: null });
    const path = join(f.owner, 'rejected-authority-' + serial++ + '.json'); await save(path, changed);
    await assert.rejects(readApprovedCampaign(await reference(path)));
  };
  const changedDecision = async change => {
    const decision = structuredClone(fixture.decision); await change(decision);
    const path = join(f.owner, 'rejected-decision-' + serial++ + '.json'); await save(path, decision);
    await rejectedAuthority(value => { value.revision.user_approval = { path, sha256: sha(JSON.stringify(decision, null, 2) + '\n') }; });
  };

  await t.test('missing or false decisions, wrong draft/hash/parent, altered budgets and unknown counts cannot authorize', async () => {
    await rejectedAuthority(value => { delete value.revision.user_approval; });
    for (const change of [
      value => { value.approved = false; },
      value => { value.parent_authorization = f.approval; },
      value => { value.accepted_proposal.sha256 = '0'.repeat(64); },
      value => { value.accepted_reviewable_draft.sha256 = '0'.repeat(64); },
      value => { value.additional_reservations = 1; },
      value => { value.total_reservation_ceiling++; value.approved_remaining_reservations++; },
      value => { value.retained_effective_unknown_token_episodes--; },
      value => { value.retained_original_unknown_token_episodes++; },
      value => { value.next_allocation_id = value.remaining_allocations[1].id; },
      value => { value.future_unknown_usage_policy = 'continue'; },
    ]) await changedDecision(change);
    await changedDecision(async value => {
      const proposal = { ...fixture.proposal, approved: true }, path = join(f.owner, 'falsified-approved-draft.json'); await save(path, proposal);
      value.accepted_proposal = await reference(path);
    });
    for (const key of ['retained_effective_unknown_token_episodes', 'retained_original_unknown_token_episodes']) {
      const proposal = { ...fixture.proposal, [key]: fixture.proposal[key] + 1 }, path = join(f.owner, key + '-draft.json'); await save(path, proposal);
      const decision = { ...fixture.decision, [key]: proposal[key], accepted_proposal: await reference(path) };
      const decisionPath = join(f.owner, key + '-decision.json'); await save(decisionPath, decision);
      await assert.rejects(readAcceptedHistoryExtension({ ...historyInputs, userApproval: await reference(decisionPath) }), /UNKNOWN_COUNT/);
    }
    await assert.rejects(prepareApprovedCampaignHistoryExtension({ ...inputs, userApproval: f.approvalInputs.userApproval, history }));
    await rejectedAuthority(value => { value.revision.parent_authorization = reference3; });
    const cycle = structuredClone(value), cyclePath = join(f.owner, 'cyclic-authority.json');
    cycle.revision.parent_authorization = { path: cyclePath, sha256: '0'.repeat(64) };
    cycle.authorization_sha256 = fingerprint({ ...cycle, authorization_sha256: null }); await save(cyclePath, cycle);
    await assert.rejects(readApprovedCampaign(await reference(cyclePath)), /ANCESTRY_CYCLE/);
  });

  await t.test('history, consumption, stop identity and every allocation field remain immutable', async () => {
    for (const change of [
      value => { value.history.episodes[0].budget_usage.input_tokens = 0; },
      value => { value.history.known_subtotal.model_requests++; },
      value => { value.history.total_usage.input_tokens = value.history.known_subtotal.input_tokens; },
      value => { value.history.unknown_usage_run_ids.pop(); },
      value => { value.revision.consumed_allocations.reverse(); },
      value => { value.revision.retained_stop.ordinal--; },
      value => { value.revision.retained_stop.source_slot_id = terra.plan.slots[6].slot_id; },
      value => { value.revision.retained_stop.runtime_result.sha256 = '0'.repeat(64); },
      value => { value.revision.retained_stop.accepted = true; },
      value => { value.revision.next_allocation_id = value.allocations[1].id; },
      value => { value.allocations[0].id += '-replacement'; },
      value => { value.allocations[0].work_index = 3; },
      value => { value.allocations[0].role = 'acceptance'; },
      value => { value.allocations.reverse(); },
      value => { value.allocations[0].reservation_limit--; value.allocations[1].reservation_limit++; },
      value => { value.allocations[0].reservation_limit++; value.new_reservation_ceiling++; value.total_reservation_ceiling++; },
    ]) await rejectedAuthority(value => { change(value); value.history_checkpoint_sha256 = fingerprint(value.history); });
  });

  await t.test('partial/open/reinterpreted scopes, extra stops, active leases and mutated original files fail', async () => {
    const ledgerPath = fixture.stop.ledger.path, bytes = await readFile(ledgerPath), rows = bytes.toString().trimEnd().split('\n').map(JSON.parse);
    const rejectRows = async (changed, pattern) => {
      await writeFile(ledgerPath, changed.map((row, index) => JSON.stringify({ ...row, seq: index + 1 })).join('\n') + '\n');
      try { await assert.rejects(readAcceptedHistoryExtension(historyInputs), pattern); } finally { await writeFile(ledgerPath, bytes); }
    };
    await rejectRows(rows.filter(row => !['episode_started', 'episode_completed'].includes(row.type) || row.run_id !== fixture.stop.last_run), /PARTIAL_SCOPE/);
    await rejectRows(rows.slice(0, -1), /OPEN_SCOPE/);
    await rejectRows([...rows.slice(0, -1), { type: 'analysis_revision_applied', reference: f.approval }, rows.at(-1)], /SOURCE_REINTERPRETED/);
    await rejectRows([...rows.slice(0, -1), { type: 'collection_recovery_applied', reference: f.approval }, rows.at(-1)], /SOURCE_REINTERPRETED/);
    const earlier = rows.filter(row => row.type === 'episode_completed').at(-2);
    const nonterminal = { ...fixture.stop, last_run: earlier.run_id, last_run_result: earlier.result }, nonterminalPath = join(f.owner, 'nonterminal-stop.json'); await save(nonterminalPath, nonterminal);
    const nonterminalProposal = { ...fixture.proposal, retained_stop: await reference(nonterminalPath) }, nonterminalProposalPath = join(f.owner, 'nonterminal-proposal.json'); await save(nonterminalProposalPath, nonterminalProposal);
    const nonterminalDecision = { ...fixture.decision, retained_stop: nonterminalProposal.retained_stop, accepted_proposal: await reference(nonterminalProposalPath) };
    const nonterminalDecisionPath = join(f.owner, 'nonterminal-decision.json'); await save(nonterminalDecisionPath, nonterminalDecision);
    await assert.rejects(readAcceptedHistoryExtension({ ...historyInputs, userApproval: await reference(nonterminalDecisionPath) }), /STOP_RUN_CHANGED/);
    // Rebind the accepted ledger digest so the extra original stop reaches the
    // ordinary guard, instead of failing only because its bytes changed.
    const extra = structuredClone(rows); extra.find(row => row.type === 'episode_completed').result.stop_batch = true;
    await writeFile(ledgerPath, extra.map(row => JSON.stringify(row)).join('\n') + '\n');
    const extraStop = { ...fixture.stop, ledger: await reference(ledgerPath) }, extraStopPath = join(f.owner, 'extra-stop.json'); await save(extraStopPath, extraStop);
    const extraProposal = { ...fixture.proposal, retained_stop: await reference(extraStopPath) }, extraProposalPath = join(f.owner, 'extra-stop-proposal.json'); await save(extraProposalPath, extraProposal);
    const extraDecision = { ...fixture.decision, retained_stop: extraProposal.retained_stop, accepted_proposal: await reference(extraProposalPath) };
    const extraDecisionPath = join(f.owner, 'extra-stop-decision.json'); await save(extraDecisionPath, extraDecision);
    try { await assert.rejects(readAcceptedHistoryExtension({ ...historyInputs, userApproval: await reference(extraDecisionPath) }), /ORIGINAL_CORE_STOP/); }
    finally { await writeFile(ledgerPath, bytes); }
    for (const changedPath of [f.approval.path, fixture.proposalPath, fixture.proposal.reviewable_draft.path,
      inputs.predecessor.registration.path, value.revision.retained_stop.episode.path, value.revision.retained_stop.runtime_result.path,
      join(f.pilot, '052.json')]) {
      const original = await readFile(changedPath); await writeFile(changedPath, Buffer.concat([original, Buffer.from(' ')]));
      try { await assert.rejects(readApprovedCampaign(reference3)); } finally { await writeFile(changedPath, original); }
    }
    const lease = join(f.pilot, 'campaign.lease.json'); await save(lease, { fixture: true });
    try {
      await assert.rejects(readAcceptedHistoryExtension(historyInputs), /ACTIVE_LEASE/);
      await assert.rejects(prepareApprovedCampaignHistoryExtension({ ...inputs, history }), /ACTIVE_LEASE/);
      assert.deepEqual((await readApprovedCampaign(reference3)).value, value, 'A future batch lease cannot invalidate an already pinned historical authority');
    } finally { await rename(lease, join(f.owner, 'retired-fixture-lease.json')); }
    const oldScopeLease = join(f.pilot, 'scope-' + grok.amendment.id + '.lease.json'); await save(oldScopeLease, { fixture: true });
    try { await assert.rejects(readApprovedCampaign(reference3), /ACTIVE_LEASE/); }
    finally { await rename(oldScopeLease, join(f.owner, 'retired-consumed-scope-lease.json')); }
    await assert.rejects(readAcceptedHistoryExtension({ ...historyInputs, predecessor: f.predecessor }));
  });

  await t.test('a campaign lease acquired during raw history reading invalidates preparation', async () => {
    const lease = join(f.pilot, 'campaign.lease.json'), originalRead = fs.promises.readFile;
    let inserted = false;
    fs.promises.readFile = async (...args) => {
      const bytes = await originalRead(...args);
      // A real lease file appears after the initial boundary check, exactly
      // when the accepted terminal bundle's original runtime bytes are read.
      if (!inserted && String(args[0]) === value.revision.retained_stop.runtime_result.path) {
        inserted = true; await save(lease, { fixture: 'concurrent-campaign' });
      }
      return bytes;
    };
    syncBuiltinESMExports();
    try { await assert.rejects(readAcceptedHistoryExtension(historyInputs), /ACTIVE_LEASE/); assert.equal(inserted, true); }
    finally {
      fs.promises.readFile = originalRead; syncBuiltinESMExports();
      if (inserted) await rename(lease, join(f.owner, 'retired-concurrent-fixture-lease.json'));
    }
  });

  const revised = { ...stopped, approval: reference3 };
  await assert.rejects(prepare(revised, { id: 'approved-confirmation', role: 'acceptance', phase: 'confirmation' }), /NEXT_ALLOCATION_FIRST/);
  const terraRows = (await readFile(fixture.stop.ledger.path, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  await assert.rejects(verifyFiniteOriginalResults(terra.plan, terraRows), /ORIGINAL_CORE_STOP/);
  const originalExpansion = await read(f.historyPlans.at(-1));
  const selection = { source_plan_sha256: originalExpansion.plan_sha256, slot_ids: originalExpansion.slots.slice(21).map(slot => slot.slot_id) };
  const followup = await prepare(revised, { id: 'approved-followup', role: UNSTARTED_FOLLOWUP, protocol: originalExpansion.protocol, selection });
  assert.equal(followup.plan.slots.length, 11); assert.equal(declaredSchedule(followup.plan.protocol).length, 32);
  let calls = 0;
  await runBatch({ plan: followup.plan, executeEpisode: ({ plan, slot, runId }) => {
    calls++; return resultFor(plan, slot, runId, { attempts: [null], valid: false, stop: true, usageStop: true });
  } });
  assert.equal(calls, 1);
  await assert.rejects(runBatch({ plan: followup.plan, executeEpisode: () => assert.fail('A later unknown must stop before dispatch') }), /ORIGINAL_CORE_STOP/);
  const newLedger = join(followup.plan.execution.control_root, 'ledger.jsonl'), newBytes = await readFile(newLedger);
  const withoutStopFlag = newBytes.toString().trimEnd().split('\n').map(JSON.parse);
  withoutStopFlag.find(row => row.type === 'episode_completed').result.stop_batch = false;
  await writeFile(newLedger, withoutStopFlag.map(row => JSON.stringify(row)).join('\n') + '\n');
  try { await assert.rejects(runBatch({ plan: followup.plan, executeEpisode: () => assert.fail('Unknown usage alone must stop before dispatch') }), /ORIGINAL_UNKNOWN_USAGE/); }
  finally { await writeFile(newLedger, newBytes); }
  await assert.rejects(readFiniteCampaignHistory({ planFiles: [...stopped.historyPlans, join(followup.plan.execution.control_root, 'plan.json')],
    pilotLedgerRoot: f.pilot, prospectiveAuthorization: reference3 }), /ORIGINAL_CORE_STOP/);
  assert.equal((await readdir(f.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 67);
  assert.deepEqual((await readApprovedCampaign(reference3)).value, value);
  await assert.rejects(readAcceptedHistoryExtension(historyInputs), /CURRENT_BOUNDARY_CHANGED/);
  const futureLease = join(f.pilot, 'campaign.lease.json'); await save(futureLease, { fixture: 'later-batch' });
  try {
    assert.deepEqual((await readApprovedCampaign(reference3)).value, value, 'The bound 66 remain readable with reservation 67 and its campaign lease');
    await assert.rejects(readAcceptedHistoryExtension(historyInputs), /ACTIVE_LEASE/);
  } finally { await rename(futureLease, join(f.owner, 'retired-later-fixture-lease.json')); }
  for (const [path, bytes] of immutable) assert.deepEqual(await readFile(path), bytes);
});

test('another explicit history extension can inherit v3 only after its next allocation is fully consumed', async () => {
  const fixture = await acceptedExtensionFixture(), { f, stopped, inputs, historyInputs } = fixture;
  const first = await prepareApprovedCampaignHistoryExtension({ ...inputs, history: await readAcceptedHistoryExtension(historyInputs) });
  const firstPath = join(f.owner, 'first-extension.json'); await save(firstPath, first); const firstReference = await reference(firstPath);
  const source = await read(f.historyPlans.at(-1)), selection = { source_plan_sha256: source.plan_sha256, slot_ids: source.slots.slice(21).map(slot => slot.slot_id) };
  const followup = await prepare({ ...stopped, approval: firstReference }, { id: 'approved-followup', role: UNSTARTED_FOLLOWUP, protocol: source.protocol, selection });
  await writeClosedPlan(followup.plan, { startOrdinal: 67,
    resultOptions: index => index === 10 ? { attempts: [50, null], valid: false, stop: true, usageStop: true } : {} });
  const after = await successor(stopped, followup, 6);
  const ledger = join(followup.plan.execution.control_root, 'ledger.jsonl'), rows = (await readFile(ledger, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const terminal = rows.filter(row => row.type === 'episode_completed').at(-1);
  const stop = { physical_reservations: 77, approved_total: 139, hard_limit: 144, remaining_approved_unsent: 62, unallocated_spare: 5,
    scope_completed: 11, last_run: terminal.run_id, last_run_result: terminal.result, ledger: await reference(ledger) };
  const stopPath = join(f.owner, 'second-stop.json'); await save(stopPath, stop);
  const draftPath = join(f.owner, 'second-draft.md'); await writeFile(draftPath, 'Retain this new final unknown and continue only the remaining 62 existing slots.\n');
  const allocations = first.allocations.filter(item => item.id !== followup.amendment.id);
  const proposal = { ...fixture.proposal, existing_campaign_authority: firstReference, retained_stop: await reference(stopPath), reviewable_draft: await reference(draftPath),
    current_reservations: 77, retained_effective_unknown_token_episodes: 6, retained_original_unknown_token_episodes: 6, remaining_allocations: allocations };
  const proposalPath = join(f.owner, 'second-proposal.json'); await save(proposalPath, proposal);
  const decision = { ...fixture.decision, parent_authorization: firstReference, accepted_proposal: await reference(proposalPath), accepted_reviewable_draft: proposal.reviewable_draft,
    retained_stop: proposal.retained_stop, current_reservations: 77, retained_effective_unknown_token_episodes: 6, retained_original_unknown_token_episodes: 6,
    approved_remaining_reservations: 62, remaining_allocations: allocations, next_allocation_id: allocations[0].id };
  const decisionPath = join(f.owner, 'second-decision.json'); await save(decisionPath, decision);
  const nextInputs = { id: 'second-extension', parentAuthorization: firstReference, userApproval: await reference(decisionPath), predecessor: after.predecessor };
  const history = await readAcceptedHistoryExtension({ ...nextInputs, planFiles: after.historyPlans, pilotLedgerRoot: f.pilot });
  const second = await prepareApprovedCampaignHistoryExtension({ ...nextInputs, history });
  assert.equal(second.history.scheduled_episodes, 77); assert.equal(second.new_reservation_ceiling, 62); assert.equal(second.total_reservation_ceiling, 139);
  assert.deepEqual(second.history.episodes.slice(0, 66), first.history.episodes); assert.deepEqual(second.revision.consumed_allocations, ['approved-followup']);
  assert.equal(second.revision.next_allocation_id, 'approved-confirmation');
  const secondPath = join(f.owner, 'second-extension.json'); await save(secondPath, second);
  const checked = await readApprovedCampaign(await reference(secondPath));
  assert.deepEqual(checked.original.value, f.approvedDocument); assert.equal(checked.retainedAliasStop.retained.ordinal, 51);
  assert.deepEqual(checked.proposal, (await readApprovedCampaign(f.approval)).proposal);
});

function transportRows(runId, { modelTransport = false, incomplete = false } = {}) {
  const bodies = [{ phase: 'transport_start' }];
  if (modelTransport) bodies.push({ phase: 'request_start', id: 1, category: 'model' }, { phase: 'request_end', id: 1, category: 'model', outcome: 'completed' });
  if (incomplete) bodies.push({ phase: 'observer_error' });
  bodies.push({ phase: 'transport_end', attempts: modelTransport ? 1 : 0, errors: incomplete ? 1 : 0,
    complete: !incomplete, pendingForkRebind: false, incompleteRequestIds: [] });
  let previous = null;
  return bodies.map((value, index) => {
    const body = { version: 1, sequence: index + 1, previousSha256: previous, clockId: runId, monotonicNs: String(index + 1), ...value };
    const row = { ...body, eventSha256: sha(JSON.stringify(body)) }; previous = row.eventSha256; return row;
  });
}

async function admissionStopArtifacts(envelope, plan, slot, runId, options) {
  const root = join(plan.execution.environment_root, 'raw', runId + '-admission'); await mkdir(root, { recursive: true });
  const add = async (id, value, jsonl = false) => {
    const path = join(root, id + (jsonl ? '.jsonl' : '.json')), bytes = jsonl ? value.map(row => JSON.stringify(row)).join('\n') + '\n' : JSON.stringify(value, null, 2) + '\n';
    await writeFile(path, bytes); const artifact = { id, path, sha256: sha(bytes), bytes: Buffer.byteLength(bytes), kind: jsonl ? 'jsonl' : 'json' };
    envelope.input.artifacts.push(artifact); return artifact;
  };
  const expectedRef = plan.execution.conditions[slot.condition_id].expectations[slot.case_id], expected = await read(expectedRef.path);
  const observed = structuredClone(expected); Object.assign(observed.projection.git, { bytes: 200, realpath: '/synthetic/apple-git', sha256: '2'.repeat(64), version: 'git version 2.39.5' });
  if (options.extraGitDrift) observed.projection.git.path = '/synthetic/other-path';
  const paths = ['/git/bytes', '/git/realpath', '/git/sha256', '/git/version'];
  await add('candidate-observed', observed);
  await add('admission-comparison', { expected_file: expectedRef,
    differences: paths.map(path => ({ path, expected: expected.projection.git[path.slice(5)], actual: observed.projection.git[path.slice(5)] })) });
  await add('collection-launcher-result', { runtime_check: { status: 'unchanged' }, frozen_artifacts: 'passed' });
  await add('collection-runtime-result', { status: 'admission_rejected',
    correlation: { run_id: runId, episode_id: runId, candidate_id: slot.condition_id, task_id: slot.case_id },
    error: { code: 'BENCHMARK_ADMISSION_MISMATCH', details: { differences: paths } }, requests: [], turns: [],
    budget: { requests: 0, attempts: 0, tools: 0, input_tokens: 0, output_tokens: 0, tokens: 0, usage_unknown: Boolean(options.unknownZero) } });
  await add('events', [
    { sequence: 1, run_id: runId, type: 'transport_reconciliation', data: { complete: true, model_http_requests: 0, guarded_fetch_attempts: 0 } },
    { sequence: 2, run_id: runId, type: 'runtime_end', data: {} },
  ], true);
  await add('transport', transportRows(runId, options), true);
}

async function confirmationCaptureInputs(protocol, execution, source) {
  execution.conditions = {}; const captured = new Map();
  const bindings = protocol.corpus.cases.map(item => ({ id: item.id, protocol_case: item, events: [], variant: { content_sha256: item.content_sha256 } }));
  execution.case_bindings_file = join(execution.control_root, 'case-bindings.json'); await save(execution.case_bindings_file, bindings);
  execution.case_bindings_sha256 = (await reference(execution.case_bindings_file)).sha256;
  execution.models_file = join(execution.control_root, 'models.json'); await save(execution.models_file, { controlled_fixture: true });
  execution.models_sha256 = (await reference(execution.models_file)).sha256;
  for (const [index, condition] of protocol.conditions.entries()) {
    const runId = protocol.id + '-capture-m0-e' + index + '-c0', runRoot = join(execution.environment_root, 'runs', runId), runtimeRoot = join(runRoot, 'benchmark/runtime');
    await mkdir(runtimeRoot, { recursive: true });
    const expectation = source ? await read(Object.values(source.execution.conditions[condition.id].expectations)[0].path) : {
      kind: 'benchmark-pi-sdk-expectation', projection: { mode: index === 0 ? 'broker' : 'native',
        git: { path: '/synthetic/git', bytes: 100, realpath: '/synthetic/git250', sha256: '1'.repeat(64), version: 'git version 2.50.1' } }, request_contract: { fixture: true } };
    const path = join(execution.control_root, runId + '.expectation.json'); await save(path, expectation);
    const ref = await reference(path), actualExpectation = join(runtimeRoot, 'candidate-expectation.json'); await save(actualExpectation, expectation);
    const observedPath = join(runtimeRoot, 'candidate-observed.json'); await save(observedPath, expectation);
    const transportPath = join(runtimeRoot, 'transport.jsonl'); await writeFile(transportPath, transportRows(runId).map(row => JSON.stringify(row)).join('\n') + '\n');
    const resultPath = join(runtimeRoot, 'episode-result.json'); await save(resultPath, { status: 'captured',
      correlation: { run_id: runId, episode_id: runId, candidate_id: condition.id, task_id: protocol.corpus.cases[0].id },
      budget: { requests: 0, attempts: 0, tools: 0, input_tokens: 0, output_tokens: 0, tokens: 0, usage_unknown: false },
      paths: { result: resultPath, expectation: actualExpectation }, artifacts: [
        { id: 'candidate-observed', ...await reference(observedPath) }, { id: 'transport', ...await reference(transportPath) } ] });
    await save(join(runRoot, 'result.json'), { status: 'passed', run_id: runId, build_id: 'fixture-build', runtime_check: { status: 'unchanged' }, frozen_artifacts: 'passed' });
    execution.conditions[condition.id] = { build_id: 'fixture-build', mode: index === 0 ? 'broker' : 'native',
      expectations: Object.fromEntries(protocol.corpus.cases.map(item => [item.id, ref])) };
    const environment = protocol.environments.find(item => item.id === condition.environment_id);
    const observer = environment.pi.extensions.find(item => item.role === 'observer'); assert.ok(observer);
    observer.path = join(runRoot, 'subject-runtime/benchmark/runtime/episode-runner.mjs');
    environment.manifest_sha256 = fingerprint({ ...environment, manifest_sha256: null }); captured.set(condition.id, ref);
    condition.environment_sha256 = environment.manifest_sha256;
  }
  return captured;
}

async function partialConfirmationFixture({ stopOptions = {} } = {}) {
  const base = await acceptedExtensionFixture(), { f, stopped, inputs, historyInputs } = base;
  const parent = await prepareApprovedCampaignHistoryExtension({ ...inputs, history: await readAcceptedHistoryExtension(historyInputs) });
  const parentPath = join(f.owner, 'accepted66.json'); await save(parentPath, parent); const parentReference = await reference(parentPath);
  const oldExpansion = await read(f.historyPlans.at(-1));
  const followup = await prepare({ ...stopped, approval: parentReference }, { id: 'approved-followup', role: UNSTARTED_FOLLOWUP, protocol: oldExpansion.protocol,
    selection: { source_plan_sha256: oldExpansion.plan_sha256, slot_ids: oldExpansion.slots.slice(21).map(slot => slot.slot_id) } });
  await writeClosedPlan(followup.plan, { startOrdinal: 67 }); const afterFollowup = await successor({ ...stopped, approval: parentReference }, followup, 6);
  const own = await prepare(afterFollowup, { id: 'approved-confirmation', role: 'acceptance', phase: 'confirmation',
    protocol: fixtureProtocol('original-own', { modelCount: 1, routing: true, caseCount: 10 }),
    prepareExecution: async (p, execution) => { p.policies.decision.mode = 'acceptance'; p.policies.decision.quality_delta_min = -0.03; await confirmationCaptureInputs(p, execution); } });
  await writeClosedPlan(own.plan, { startOrdinal: 78, count: 3, resultOptions: index => index === 2
    ? { attempts: [], valid: false, stop: true, admissionStop: stopOptions } : {} });
  const ledgerPath = join(own.plan.execution.control_root, 'ledger.jsonl'), rows = (await readFile(ledgerPath, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  rows.at(-1).reason = 'subject_requested_stop'; await writeFile(ledgerPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const after = { ...await successor(afterFollowup, own, 7), count: 80 }, terminal = rows.filter(row => row.type === 'episode_completed').at(-1);
  const id = 'continued-own17', sourceRef = await reference(join(own.plan.execution.control_root, 'plan.json'));
  const proposal = { version: 1, kind: 'public-own-partial-stop-next-decision-draft', status: 'awaiting_user_decision_and_explicit_contract_implementation',
    approved: false, user_approval: null, execution_authority: null, execution_ready: false,
    physical_history: { physical: 80, completed: 80, execution_unresolved: 0, effective_unknown_usage_runs: 5, original_completion_unknown_usage_runs: 5 },
    budget: { retained_physical: 80, own_remaining: 17, engineering_remaining: 42, requested_future: 59, approved_total_ceiling: 139, hard_limit: 144,
      unallocated: 5, additional_budget: 0, retry_reservations: 0 },
    allocation_transition: { parent_accepted_history: 66, additional_closed: 14, fully_consumed_allocation: { id: 'approved-followup', reservations: 11 },
      partial_original_allocation: { id: 'approved-confirmation', original_limit: 20, spent: 3, never_started_to_transfer: 17 } },
    stop: { run_id: terminal.run_id, slot_id: terminal.slot_id, physical_ordinal: 80, source_order: 2, runtime_status: 'admission_rejected', validity: 'invalid',
      stop_batch: true, reason_code: 'BENCHMARK_ADMISSION_MISMATCH', usage_unknown: false, retry_allowed: false, model_http_requests: 0, guarded_fetch_attempts: 0,
      reconciliation_complete: true, other_http_requests: 0, expected_git_version: '2.50.1', observed_git_version: '2.39.5' },
    own: { original_scope_id: own.amendment.id, original_experiment_id: own.plan.id, original_phase: 'confirmation', original_scientific_slots: 20,
      original_selected_slots: 20, already_started: 3, unstarted: 17, proposed_scope_id: id, proposed_experiment_id: id,
      excluded_started_slots: own.plan.slots.slice(0, 3).map(slot => ({ source_order: slot.order, slot_id: slot.slot_id,
        run_id: own.plan.id + '-' + String(slot.order + 1).padStart(3, '0'), must_never_retry: true })),
      remaining_slots: own.plan.slots.slice(3).map(({ order, ...slot }, index) => ({ ...slot, source_order: order, prospective_selected_order: index, operator_id: 'fixture-operator', cold_precommitted: index < 7 })) },
    cold: { remaining_within_own17: 7 },
    engineering: { entries: parent.allocations.slice(2).map((item, index) => ({ allocation_id: item.id, work_index: item.work_index, selected_reservations: item.reservation_limit,
      proposed_predecessor_scope_id: index ? parent.allocations[index + 1].id : id })) },
    model_condition: { variant: own.plan.protocol.models[0].routing.model_variant, parameters: own.plan.protocol.models[0].parameters },
    window: { existing: own.plan.protocol.models[0].backend.window, proposed_change: { maximum_new_windows: 1, duration_hours: 24, automatic_renewal: false } },
    future_stop_policy: { new_core_stop_blocks_dispatch: true, new_unknown_usage_blocks_dispatch: true, automatic_retry: false, automatic_route_switch: false, automatic_budget_extension: false },
    source_refs: [{ id: 'current-authority3', sha256: parentReference.sha256 }, { id: 'original-own-plan', sha256: sourceRef.sha256 }, { id: 'original-own-closed-ledger', sha256: (await reference(ledgerPath)).sha256 }] };
  const proposalPath = join(f.owner, 'partial-proposal.json'); await save(proposalPath, proposal);
  const draft = join(f.owner, 'partial-decision.md'); await writeFile(draft, 'Retain original3 and execute only the original17, then42. No retry, new blind study or additional budget.\n');
  const proposalRef = await reference(proposalPath), draftRef = await reference(draft), checkpoint = join(f.owner, 'stopped80-checkpoint.json');
  await save(checkpoint, { publicDecisionBinding: { json_sha256: proposalRef.sha256, markdown_sha256: draftRef.sha256, public_commit: '3'.repeat(40) },
    physicalReservations: 80, closedReservations: 80, paidActive: false, newCoreStop: { runId: terminal.run_id } });
  const decision = { version: 1, kind: 'user-approved-partial-confirmation-continuation-decision', approved: true, source: 'current-user-message', user_message: 'Accept',
    approval_observed_at: '2026-11-24T01:00:00Z', accepted_at: '2026-11-24T01:00:00Z', timestamp_semantics: 'Synthetic fixture timestamp',
    authorization_scope: 'Original17 then42 only', accepted_proposal: proposalRef, accepted_reviewable_draft: draftRef,
    accepted_public_commit: '3'.repeat(40), accepted_public_url: 'https://example.invalid/synthetic', parent_authorization: parentReference,
    stopped80_checkpoint: await reference(checkpoint), accepted_history_reservations: 80, approved_remaining_reservations: 59,
    total_reservation_ceiling: 139, max_scheduled_episodes: 144, unallocated_headroom: 5, additional_reservations: 0,
    remaining_sequence: [{ id, source_allocation_id: own.amendment.id, source_order_first: 3, source_order_last: 19, reservation_limit: 17, cold_positions_subset: 7 },
      ...parent.allocations.slice(2).map(({ id, reservation_limit }) => ({ id, reservation_limit }))],
    retained_stop_run_id: terminal.run_id, retained_stop_usage: 'known_zero_model_requests_and_tokens', retained_effective_unknown_token_episodes: 5,
    retained_original_unknown_token_episodes: 5, retained_stop_remains_invalid: true, future_core_stop_policy: 'stop', future_unknown_usage_policy: 'stop',
    model_parameters_unchanged: { model: proposal.model_condition.variant, ...proposal.model_condition.parameters },
    new_model_window_permission: { conditional_on_need_after_preparation: true, maximum_new_windows: 1, duration_hours: 24, created: false, actual_start: null, actual_end: null, automatic_renewal: false },
    cold_operator_policy: 'Continue original fixture operator', provider_diagnosis_authorized: true, execution_ready: false, authority_created: false, required_before_dispatch: ['Verify exact history'] };
  const decisionPath = join(f.owner, 'partial-user-decision.json'); await save(decisionPath, decision);
  const nextInputs = { id: 'partial-confirmation-authority', parentAuthorization: parentReference, userApproval: await reference(decisionPath), predecessor: after.predecessor };
  return { base, parent, parentReference, own, after, proposal, proposalPath, decision, inputs: nextInputs,
    historyInputs: { ...nextInputs, planFiles: after.historyPlans, pilotLedgerRoot: f.pilot }, id };
}

test('partial confirmation retains original3 and scientific20, transfers exact17 and closes the original59 in order', async t => {
  const f = await partialConfirmationFixture();
  const originalFiles = [f.parentReference.path, f.inputs.userApproval.path, f.proposalPath,
    ...f.after.historyPlans, ...f.after.historyPlans.map(path => join(path.slice(0, -'plan.json'.length), 'ledger.jsonl')),
    ...Array.from({ length: 80 }, (_, index) => join(f.after.pilot, String(index + 1).padStart(3, '0') + '.json'))];
  const originalBytes = await Promise.all(originalFiles.map(async path => [path, await readFile(path)]));
  await assert.rejects(readFiniteCampaignHistory({ planFiles: f.after.historyPlans, pilotLedgerRoot: f.after.pilot, prospectiveAuthorization: f.parentReference }), /ORIGINAL_CORE_STOP/);
  await assert.rejects(readAcceptedHistoryExtension(f.historyInputs), /DECISION_SHAPE|kind|PARTIAL/);
  const history = await readAcceptedConfirmationContinuation(f.historyInputs);
  const value = await prepareApprovedCampaignConfirmationContinuation({ ...f.inputs, history });
  assert.equal(value.version, 4); assert.equal(value.history.scheduled_episodes, 80); assert.equal(value.new_reservation_ceiling, 59);
  assert.deepEqual(value.history.unknown_usage_run_ids, f.parent.history.unknown_usage_run_ids);
  assert.deepEqual(value.history.episodes.slice(0, 66), f.parent.history.episodes);
  assert.equal(value.history.episodes.at(-1).admission, 'invalid'); assert.equal(value.history.episodes.at(-1).budget_usage.model_requests, 0);
  assert.deepEqual(value.allocations.slice(1), f.parent.allocations.slice(2)); assert.deepEqual(value.revision.consumed_allocations, ['approved-followup']);
  assert.equal(value.revision.partial_allocation.spent, 3); assert.equal(value.revision.partial_allocation.remaining, 17);
  assert.equal(value.revision.model_window.mode, 'retained_original');
  const path = join(f.after.owner, 'partial-authority.json'); await save(path, value); const ref = await reference(path);
  const checked = await readApprovedCampaign(ref); assert.equal(checked.retainedAliasStop.retained.ordinal, 51);
  let serial = 0;
  const rejectAuthority = async change => {
    const invalid = structuredClone(value); await change(invalid); invalid.authorization_sha256 = fingerprint({ ...invalid, authorization_sha256: null });
    const path = join(f.after.owner, 'partial-bad-' + serial++ + '.json'); await save(path, invalid); await assert.rejects(readApprovedCampaign(await reference(path)));
  };
  const rejectDecision = async change => {
    const invalid = structuredClone(f.decision); change(invalid); const path = join(f.after.owner, 'partial-decision-bad-' + serial++ + '.json'); await save(path, invalid);
    await rejectAuthority(async authority => { authority.revision.user_approval = await reference(path); });
  };
  await t.test('decision, source prefix, allocations, known-zero counts and one-window bounds fail closed', async () => {
    for (const change of [value => { value.approved = false; }, value => { value.accepted_reviewable_draft.sha256 = '0'.repeat(64); },
      value => { value.parent_authorization = f.base.parentReference; }, value => { value.approved_remaining_reservations++; },
      value => { value.remaining_sequence[0].source_order_first = 2; }, value => { value.retained_effective_unknown_token_episodes++; },
      value => { value.new_model_window_permission.maximum_new_windows = 2; }]) await rejectDecision(change);
    for (const change of [value => { delete value.revision.user_approval; }, value => { value.history.episodes[0].admission = 'invalid'; },
      value => { value.allocations[0].reservation_limit++; }, value => { value.allocations.reverse(); },
      value => { value.revision.next_allocation_id = value.allocations[1].id; }, value => { value.revision.partial_allocation.selection.slot_ids.reverse(); },
      value => { value.revision.retained_stop.run_id = 'another-stop'; }]) await rejectAuthority(change);
    const renewed = await prepareApprovedCampaignConfirmationContinuation({ ...f.inputs, history,
      modelWindow: { start: '2026-11-24T02:00:00Z', end: '2026-11-25T02:00:00Z' } });
    assert.equal(renewed.revision.model_window.mode, 'single_new_24h');
    for (const modelWindow of [{ start: '2026-11-24T00:00:00Z', end: '2026-11-25T00:00:00Z' }, { start: '2026-11-24T02:00:00Z', end: '2026-11-26T02:00:00Z' }])
      await assert.rejects(prepareApprovedCampaignConfirmationContinuation({ ...f.inputs, history, modelWindow }), /WINDOW/);
    await assert.rejects(readAcceptedConfirmationContinuation({ ...f.historyInputs, parentAuthorization: ref }), /PARENT_VERSION/);
  });
  await t.test('partial or open source ledgers and historical leases never become accepted history', async () => {
    const ownLedger = join(f.own.plan.execution.control_root, 'ledger.jsonl'), bytes = await readFile(ownLedger);
    const rows = bytes.toString().trimEnd().split('\n').map(JSON.parse);
    for (const invalidRows of [rows.slice(0, -1), rows.filter(row => !(row.type === 'episode_completed' && row.run_id.endsWith('-003')))]) {
      try {
        await writeFile(ownLedger, invalidRows.map((row, index) => JSON.stringify({ ...row, seq: index + 1 })).join('\n') + '\n');
        await assert.rejects(readAcceptedConfirmationContinuation(f.historyInputs), /OPEN_SCOPE|PARTIAL_SCOPE/);
      } finally { await writeFile(ownLedger, bytes); }
    }
    const legacy = join(f.after.pilot, 'scope-' + f.own.amendment.id + '.lease.json'); await save(legacy, { fixture: true });
    try { await assert.rejects(readApprovedCampaign(ref), /ACTIVE_LEASE/); }
    finally { await rename(legacy, join(f.after.owner, 'retired-own-lease.json')); }
    const lease = join(f.after.pilot, 'campaign.lease.json'); await save(lease, { fixture: 'prospective later scope' });
    try {
      assert.deepEqual((await readApprovedCampaign(ref)).value, value);
      await assert.rejects(readAcceptedConfirmationContinuation(f.historyInputs), /ACTIVE_LEASE/);
    } finally { await rename(lease, join(f.after.owner, 'retired-later-lease.json')); }
  });
  const current = { ...f.after, approval: ref }, selection = value.revision.partial_allocation.selection;
  const continuation = await prepare(current, { id: f.id, role: CONFIRMATION_CONTINUATION, phase: 'confirmation', protocol: f.own.plan.protocol, selection,
    prepareExecution: (p, e) => confirmationCaptureInputs(p, e, f.own.plan) });
  assert.equal(continuation.plan.slots.length, 17); assert.equal(declaredSchedule(continuation.plan.protocol).length, 20);
  await t.test('startup captures retain full20 while dispatch selects17, and stateful fixture replay is forbidden', () => {
    const cases = continuation.plan.protocol.corpus.cases.map(item => ({ id: item.id, events: [] }));
    const full = startupCaptureSchedule(continuation.plan.protocol, cases); assert.equal(full.length, 20);
    const excluded = f.own.plan.slots[0];
    assert.equal(captureBindingsForCase({ binding: { id: excluded.case_id, events: [] }, conditionId: excluded.condition_id, slots: full, slotBindings: new Map() }).length, 1);
    assert.equal(captureBindingsForCase({ binding: { id: excluded.case_id, events: [] }, conditionId: excluded.condition_id, slots: continuation.plan.slots, slotBindings: new Map() }).length, 0);
    assert.throws(() => startupCaptureSchedule(continuation.plan.protocol, cases, {}), /STATEFUL_FIXTURE/);
    cases[0].events.push({ id: 'stateful' }); assert.throws(() => startupCaptureSchedule(continuation.plan.protocol, cases), /STATEFUL_FIXTURE/);
  });
  await t.test('replay, new blind claim, changed model, scoring, full denominator and foreign captures are rejected', async () => {
    const reject = async change => {
      const p = structuredClone(continuation.plan.protocol), e = structuredClone(continuation.plan.execution), setup = { campaign_scope: structuredClone(continuation.input) };
      delete e.campaign_scope; await change(p, e, setup); sealProtocol(p);
      await assert.rejects(async () => prepareFiniteCampaign({ setup, protocol: p, execution: e, slots: scheduleProtocol(p) }));
    };
    for (const change of [
      p => { p.policies.campaign.selection.slot_ids[0] = f.own.plan.slots[2].slot_id; },
      p => { p.policies.campaign.selection.slot_ids.reverse(); },
      p => { p.phase = 'pilot'; }, p => { p.policies.campaign.role = 'acceptance'; delete p.policies.campaign.selection; },
      p => { p.models[0].routing.reported_model_ids.push('unapproved'); }, p => { p.models[0].parameters.maxTokens = 4097; },
      p => { p.models[0].backend.window.end = '2026-11-26T00:00:00Z'; }, p => { p.policies.decision.quality_delta_min = -0.5; },
      p => { p.corpus.cases[0].content_sha256 = 'f'.repeat(64); }, p => { p.pairs.pop(); },
      (_p, e) => { e.conditions = structuredClone(f.own.plan.execution.conditions); },
      (_p, e) => { delete e.conditions[Object.keys(e.conditions)[0]].expectations[f.own.plan.slots[0].case_id]; },
      (_p, e) => { e.instrumentation.runtime_sha256 = ['b'.repeat(64)]; },
    ]) await reject(change);
  });
  await assert.rejects(runBatch({ plan: f.own.plan, executeEpisode: () => assert.fail('The retained invalid source must never resume') }), /ORIGINAL_CORE_STOP/);
  await writeClosedPlan(continuation.plan, { startOrdinal: 81, count: 16 });
  let after = await successor(current, continuation, 8);
  await assert.rejects(prepare(after, { id: 'approved-code', role: 'acceptance', protocol: fixtureProtocol('code', { modelCount: 1, routing: true, caseCount: 12 }) }), /PREDECESSOR_INCOMPLETE/);
  await writeClosedPlan(continuation.plan, { startOrdinal: 81, prefixCount: 16 }); after.count = 97;
  await assert.rejects(prepare(after, { id: 'approved-scale-0', role: 'acceptance', protocol: fixtureProtocol('scale', { modelCount: 1, routing: true, caseCount: 1 }) }), /ALLOCATION_ORDER/);
  await assert.rejects(prepare({ ...after, predecessor: current.predecessor }, { id: 'approved-code', role: 'acceptance', protocol: fixtureProtocol('code', { modelCount: 1, routing: true, caseCount: 12 }) }), /ALLOCATION_ORDER|NEXT_ALLOCATION/);
  for (const [index, allocation] of value.allocations.slice(1).entries()) {
    const scope = await prepare(after, { id: allocation.id, role: 'acceptance', protocol: fixtureProtocol(allocation.id, { modelCount: 1, routing: true, caseCount: allocation.reservation_limit / 2 }) });
    await writeClosedPlan(scope.plan, { startOrdinal: after.count + 1 }); after = await successor(after, scope, 9 + index);
    if (index === 6) {
      assert.equal((await verifyFiniteCampaignScope(scope.plan)).history.scheduled_episodes, 131);
      await assert.rejects(verifyFiniteCampaignScope(scope.plan, { forReservation: true }), /scope is complete/);
      const completed = await runBatch({ plan: scope.plan, executeEpisode: () => assert.fail('The exact original139 ceiling is complete') });
      assert.equal(completed.scheduled, 8); assert.equal(completed.completed, 8);
    }
  }
  assert.equal(after.count, 139); assert.equal((await readdir(f.after.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 139);
  assert.deepEqual((await readApprovedCampaign(ref)).value, value, 'Later closed reservations do not rewrite the bound80');
  for (const [path, bytes] of originalBytes) assert.deepEqual(await readFile(path), bytes);
});

test('partial confirmation cannot accept model transport, unknown zero, incomplete transport or other Git drift', async t => {
  for (const stopOptions of [{ modelTransport: true }, { unknownZero: true }, { incomplete: true }, { extraGitDrift: true }]) {
    await t.test(Object.keys(stopOptions)[0], async () => {
      const f = await partialConfirmationFixture({ stopOptions });
      await assert.rejects(readAcceptedConfirmationContinuation(f.historyInputs));
      assert.equal((await readdir(f.after.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 80);
    });
  }
});

test('partial confirmation still blocks a newly observed stop before the next dispatcher callback', async t => {
  for (const [name, resultOptions, failure] of [
    ['stop', { attempts: [50], valid: false, stop: true }, /ORIGINAL_CORE_STOP/],
    ['unknown without stop flag', { attempts: [null], valid: false, stop: false }, /ORIGINAL_UNKNOWN_USAGE/],
    ['core invalid without stop flag', { attempts: [50], valid: false, stop: false }, /CORE_INVALID/],
  ]) await t.test(name, async () => {
  const f = await partialConfirmationFixture(), history = await readAcceptedConfirmationContinuation(f.historyInputs);
  const value = await prepareApprovedCampaignConfirmationContinuation({ ...f.inputs, history });
  const path = join(f.after.owner, 'future-stop-authority.json'); await save(path, value); const ref = await reference(path);
  const continuation = await prepare({ ...f.after, approval: ref }, { id: f.id, role: CONFIRMATION_CONTINUATION, phase: 'confirmation',
    protocol: f.own.plan.protocol, selection: value.revision.partial_allocation.selection, prepareExecution: (p, e) => confirmationCaptureInputs(p, e, f.own.plan) });
  let calls = 0;
  const first = await runBatch({ plan: continuation.plan, maximumNewEpisodes: 1, executeEpisode: async ({ slot, runId }) => {
    calls++; return resultFor(continuation.plan, slot, runId, resultOptions);
  } });
  assert.equal(calls, 1); assert.equal(first.last.type, 'batch_closed'); assert.equal(first.completed, 1);
  await assert.rejects(runBatch({ plan: continuation.plan, executeEpisode: () => assert.fail('A future stop cannot inherit the accepted80 exception') }), failure);
  assert.equal((await readdir(f.after.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 81);
  assert.deepEqual((await readApprovedCampaign(ref)).value, value);
  await assert.rejects(readAcceptedConfirmationContinuation(f.historyInputs), /BOUNDARY_ADVANCED|REGISTRY_ADVANCED/);
  });
});
