import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fingerprint, validateProtocol } from './protocol.mjs';
import { readEvidenceBundle } from './evidence/store.mjs';
import { verifyAnalysisRevision } from './revision.mjs';
import { verifyCollectionRecoveryResults } from './collection-recovery.mjs';

export const PROSPECTIVE_COHORT = 'benchmark-prospective-cohort';
export const isProspectiveCohort = value => value?.kind === PROSPECTIVE_COHORT;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = values => [...values].sort();
const safe = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const usageKeys = ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms'];
const knownUsage = usage => usageKeys.every(key => Number.isFinite(usage?.[key]) && usage[key] >= 0);
const reference = async path => ({ path, sha256: sha(await readFile(path)) });
const read = async path => JSON.parse(await readFile(path, 'utf8'));

/** Keep the legacy shape unchanged when no routing contract was registered. */
export const scopeModelIdentity = model => fingerprint({ provider: model.provider, route: model.route, api: model.api,
  parameters: model.parameters, adapter: model.adapter, backend: model.backend,
  ...(model.routing ? { routing: model.routing } : {}) });

export const scopeEnvironmentIdentity = environment => fingerprint({ build: environment.build, runtime: environment.runtime,
  paired_environment_id: environment.paired_environment_id, policies: environment.policies,
  pi: { mode: environment.pi.mode, entry_kind: environment.pi.entry_kind, entry: environment.pi.entry,
    config_sha256: environment.pi.config_sha256,
    extensions: environment.pi.extensions.map(({ id, role, sha256 }) => ({ id, role, sha256 })),
    tools: environment.pi.tools, active_tools: environment.pi.active_tools,
    source_kinds: environment.pi.sources.map(source => source.kind).sort(),
    return_contract_sha256: environment.pi.return_contract_sha256, error_contract_sha256: environment.pi.error_contract_sha256 } });

/** Legacy bundles remain readable, but new cohort evidence must carry the exact
 * policy whose raw provider-event observations the evidence store verifies. */
export function assertCohortModelEvidence(episode, model) {
  assert.ok(model.routing, 'COHORT_ROUTING_CONTRACT_REQUIRED');
  assert.deepEqual(episode.identity.model_routing, model.routing, 'COHORT_MODEL_ROUTING_MISMATCH');
  assert.equal(episode.identity.model_route, model.route, 'COHORT_REQUESTED_ROUTE_MISMATCH');
  assert.equal(episode.identity.model_api, model.api, 'COHORT_MODEL_API_MISMATCH');
  assert.equal(episode.identity.model_provider, model.provider, 'COHORT_MODEL_PROVIDER_MISMATCH');
  for (const attempt of episode.attempts) {
    assert.ok(typeof attempt.sent === 'boolean', 'COHORT_MODEL_SEND_UNKNOWN');
    assert.equal(attempt.reported_model?.status, attempt.sent ? 'matched' : 'not_sent', 'COHORT_REPORTED_MODEL_NOT_MATCHED');
  }
}

export function prospectiveCohortPolicy(input, modelCount) {
  assert.ok(safe(input.id)); assert.ok(['gate', 'expansion'].includes(input.role));
  assert.ok(Number.isSafeInteger(modelCount) && modelCount > 0 && modelCount * 24 <= 144, 'COHORT_MODEL_COUNT');
  return { version: 1, kind: PROSPECTIVE_COHORT, id: input.id, role: input.role, model_count: modelCount,
    gate_episodes: modelCount * 8, minimum_valid_real_per_condition: 4, reservation_limit: modelCount * 24,
    history_quality: 'excluded_retained_in_campaign_costs', new_unknown_usage: 'stop_scope' };
}

function planIdentity(plan) {
  assert.equal(plan?.version, 1); assert.equal(plan.kind, 'benchmark-batch-plan');
  assert.equal(plan.plan_sha256, fingerprint({ ...plan, plan_sha256: null }), 'COHORT_HISTORY_PLAN_CHANGED');
  const validation = validateProtocol(plan.protocol, { stage: 'execute' });
  assert.ok(validation.valid, JSON.stringify(validation.errors));
  assert.equal(plan.id, plan.protocol.id); assert.equal(plan.protocol.phase, 'pilot');
  assert.equal(plan.protocol.policies.pilot.max_scheduled_episodes, 144);
}

async function readClosedLedger(path) {
  const bytes = await readFile(path);
  assert.ok(bytes.length > 0 && bytes.at(-1) === 10, 'COHORT_HISTORY_INCOMPLETE_LEDGER');
  const rows = bytes.toString('utf8').trimEnd().split('\n').map((line, i) => {
    const row = JSON.parse(line); assert.equal(row.seq, i + 1, 'COHORT_HISTORY_LEDGER_SEQUENCE'); return row;
  });
  assert.equal(rows.at(-1).type, 'batch_closed', 'COHORT_HISTORY_OPEN_BATCH');
  return rows;
}

async function noLease(path) {
  try { await readFile(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.fail('COHORT_HISTORY_LEASE_REQUIRES_RECONCILIATION: ' + path);
}

/** Freeze completed observations in their own environment, including unknown
 * sends and registered same-raw analysis. No old observation earns new credit. */
export async function readCohortHistory({ planFiles, pilotLedgerRoot, expected }) {
  assert.ok(isAbsolute(pilotLedgerRoot) && resolve(pilotLedgerRoot) === pilotLedgerRoot);
  assert.equal(await realpath(pilotLedgerRoot), pilotLedgerRoot, 'COHORT_HISTORY_LEDGER_SYMLINK');
  const names = (await readdir(pilotLedgerRoot)).filter(name => /^\d{3}\.json$/.test(name)).sort();
  assert.ok(names.length <= 144, 'PILOT_CAP');
  for (const [index, name] of names.entries()) assert.equal(name, String(index + 1).padStart(3, '0') + '.json', 'COHORT_HISTORY_RESERVATION_GAP');
  const count = expected?.scheduled_episodes ?? names.length;
  assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= names.length, 'COHORT_HISTORY_MISSING');
  const selected = await Promise.all(names.slice(0, count).map(async (name, index) => {
    const path = join(pilotLedgerRoot, name); return { ordinal: index + 1, reference: await reference(path), value: await read(path) };
  }));
  assert.equal(new Set(selected.map(item => item.value.run_id)).size, count, 'COHORT_HISTORY_DUPLICATE_RUN');
  assert.ok(Array.isArray(planFiles)); assert.equal(new Set(planFiles).size, planFiles.length, 'COHORT_HISTORY_DUPLICATE_PLAN');
  const plans = [], owners = new Map();
  for (const path of [...planFiles].sort()) {
    assert.ok(isAbsolute(path)); const plan = await read(path); planIdentity(plan);
    assert.equal(path, join(plan.execution.control_root, 'plan.json'));
    assert.equal(plan.execution.pilot_ledger_root, pilotLedgerRoot, 'COHORT_HISTORY_FOREIGN_LEDGER');
    assert.ok(isAbsolute(plan.execution.environment_root)); assert.ok(!owners.has(plan.id), 'COHORT_HISTORY_DUPLICATE_PLAN');
    await noLease(join(plan.execution.control_root, 'lease.json'));
    const ledgerPath = join(plan.execution.control_root, 'ledger.jsonl'), rows = await readClosedLedger(ledgerPath);
    const starts = rows.filter(row => row.type === 'episode_started'), completed = rows.filter(row => row.type === 'episode_completed');
    assert.ok(starts.length > 0, 'COHORT_HISTORY_UNUSED_PLAN');
    assert.equal(starts.length, completed.length, 'COHORT_HISTORY_UNRESOLVED');
    assert.equal(new Set(starts.map(row => row.run_id)).size, starts.length);
    assert.equal(new Set(starts.map(row => row.slot_id)).size, starts.length, 'COHORT_HISTORY_DUPLICATE_SLOT');
    assert.equal(new Set(completed.map(row => row.run_id)).size, completed.length);
    assert.ok(starts.every(row => completed.some(item => item.run_id === row.run_id && item.slot_id === row.slot_id)), 'COHORT_HISTORY_UNRESOLVED');
    const applied = rows.filter(row => row.type === 'analysis_revision_applied');
    assert.ok(applied.length <= 1, 'COHORT_HISTORY_REVISION_CHAIN_UNSUPPORTED');
    const revisionReference = applied[0]?.reference ?? null;
    const revision = revisionReference ? await verifyAnalysisRevision({ reference: revisionReference, plan }) : null;
    const recovery = await verifyCollectionRecoveryResults(plan, completed);
    const item = { plan: await reference(path), ledger: await reference(ledgerPath), analysis_revision: revisionReference,
      ...(recovery ? { collection_recovery: recovery.reference } : {}) };
    plans.push(item); owners.set(plan.id, { plan, starts, completed, revision, reference: item.plan });
  }
  const episodes = [], subtotal = Object.fromEntries(usageKeys.map(key => [key, 0]));
  for (const item of selected) {
    const reservation = item.value, owner = owners.get(reservation.experiment_id);
    assert.ok(owner, 'COHORT_HISTORY_PLAN_MISSING');
    if (reservation.plan) { assert.deepEqual(reservation.plan, owner.reference); assert.equal(reservation.plan_sha256, owner.plan.plan_sha256); }
    const events = owner.completed.filter(row => row.run_id === reservation.run_id); assert.equal(events.length, 1, 'COHORT_HISTORY_RESULT_MISSING');
    const event = events[0]; assert.equal(event.slot_id, reservation.slot_id);
    const slot = owner.plan.slots.find(slot => slot.slot_id === reservation.slot_id); assert.ok(slot, 'COHORT_HISTORY_UNKNOWN_SLOT');
    const replacement = owner.revision?.replacements.find(row => row.run_id === reservation.run_id);
    if (replacement) assert.equal(replacement.original_episode_sha256, event.result.episode_sha256);
    const directory = replacement?.directory ?? event.result.normalized_directory;
    const { episode } = await readEvidenceBundle({ directory, rawRoot: owner.plan.execution.environment_root });
    assert.equal(episode.episode_sha256, replacement?.new_episode_sha256 ?? event.result.episode_sha256);
    assert.equal(episode.identity.run_id, reservation.run_id); assert.equal(episode.identity.experiment_id, owner.plan.id);
    assert.equal(episode.identity.case_id, slot.case_id); assert.equal(episode.identity.condition_id, slot.condition_id);
    const condition = owner.plan.protocol.conditions.find(condition => condition.id === slot.condition_id);
    const environment = owner.plan.protocol.environments.find(environment => environment.id === condition.environment_id);
    const model = owner.plan.protocol.models.find(model => model.id === condition.model_id);
    assert.equal(episode.identity.model_id, condition.model_id); assert.equal(episode.identity.environment_sha256, environment.manifest_sha256);
    assert.equal(episode.identity.build_id, environment.build.id);
    if (isProspectiveCohort(owner.plan.protocol.policies.pilot.scope)) assertCohortModelEvidence(episode, model);
    const usage = { model_requests: episode.measurements.actual_attempts.status === 'known' ? episode.measurements.actual_attempts.value : null,
      input_tokens: episode.measurements.input_total.value.status === 'known' ? episode.measurements.input_total.value.value : null,
      output_tokens: episode.measurements.output_total.value.status === 'known' ? episode.measurements.output_total.value.value : null,
      duration_ms: episode.timing.duration_ms.status === 'known' ? episode.timing.duration_ms.value : null };
    assert.deepEqual(usage, replacement?.budget_usage ?? event.result.budget_usage, 'COHORT_HISTORY_USAGE_MISMATCH');
    for (const key of usageKeys) if (usage[key] !== null) subtotal[key] += usage[key];
    episodes.push({ run_id: reservation.run_id, pilot_ordinal: item.ordinal, experiment_id: owner.plan.id,
      directory, episode_sha256: episode.episode_sha256, admission: episode.admission.status, budget_usage: usage,
      core_evidence: episode.admission.status === 'valid' && ['attempts', 'tools', 'interventions'].every(key => episode.admission.completeness[key] === 'complete')
        && knownUsage(usage) && usage.model_requests > 0 && episode.attempts.filter(attempt => attempt.sent).every(attempt => attempt.adapter.verified)
        ? 'complete' : 'incomplete',
      quality_credit: 'excluded_from_new_scope', stop_batch: replacement ? replacement.stop_batch : Boolean(event.result.stop_batch),
      ...(event.result.collection_recovery ? { collection_recovery: event.result.collection_recovery } : {}),
      ...(replacement ? { analysis_revision: plans.find(item => item.plan.path === owner.reference.path).analysis_revision,
        original_directory: event.result.normalized_directory, original_episode_sha256: event.result.episode_sha256 } : {}) });
  }
  assert.equal([...owners.values()].reduce((sum, owner) => sum + owner.starts.length, 0), count, 'COHORT_HISTORY_UNRESERVED_EPISODE');
  const unknown = episodes.filter(item => !knownUsage(item.budget_usage)).map(item => item.run_id).sort();
  const value = { reservations: selected.map(({ ordinal, reference }) => ({ ordinal, reference })), plans, episodes,
    unknown_usage_run_ids: unknown, known_subtotal: subtotal,
    total_usage: Object.fromEntries(usageKeys.map(key => [key, episodes.every(item => item.budget_usage[key] !== null) ? subtotal[key] : null])),
    total_usage_status: unknown.length ? 'incomplete' : 'known', monetary_status: 'unpriced', scheduled_episodes: count };
  if (expected) assert.deepEqual(value, expected, 'COHORT_HISTORY_CHANGED');
  return value;
}

function assertCaseIds(ids, count) {
  assert.ok(Array.isArray(ids) && ids.length === count, 'COHORT_CASE_COUNT');
  assert.equal(new Set(ids).size, count, 'COHORT_DUPLICATE_CASE'); assert.ok(ids.every(safe), 'COHORT_CASE_ID');
}

function assertCohortShape(value) {
  assert.equal(value.version, 1); assert.equal(value.kind, PROSPECTIVE_COHORT); assert.ok(safe(value.id));
  assert.equal(value.amendment_sha256, fingerprint({ ...value, amendment_sha256: null }), 'COHORT_AMENDMENT_CHANGED');
  assert.ok(typeof value.authorization === 'string' && value.authorization.trim());
  assert.ok(isAbsolute(value.environment_root) && isAbsolute(value.pilot_ledger_root));
  assert.equal(value.max_scheduled_episodes, 144);
  assert.ok(Number.isSafeInteger(value.model_count) && value.model_count > 0);
  assert.equal(value.model_conditions.length, value.model_count); assert.equal(new Set(value.model_conditions).size, value.model_count);
  assert.equal(value.environment_conditions.length, 2); assert.equal(new Set(value.environment_conditions).size, 2);
  assert.equal(value.gate.minimum_valid_real_per_condition, 4); assert.equal(value.gate.scheduled_episodes, value.model_count * 8);
  assert.equal(value.reservation_limit, value.model_count * 24); assert.equal(value.expansion.scheduled_episodes, value.model_count * 16);
  assert.ok(value.history.scheduled_episodes + value.reservation_limit <= 144, 'COHORT_EXCEEDS_CAMPAIGN_CAP');
  assertCaseIds(value.gate.case_ids, 4); assertCaseIds(value.expansion.case_ids, 8);
  assert.ok(value.gate.case_ids.every(id => !value.expansion.case_ids.includes(id)), 'COHORT_PHASE_CASE_OVERLAP');
  for (const phase of [value.gate, value.expansion]) {
    assert.ok(safe(phase.experiment_id) && isAbsolute(phase.control_root)); assert.equal(phase.repetitions, 1);
  }
  assert.notEqual(value.gate.experiment_id, value.expansion.experiment_id); assert.notEqual(value.gate.control_root, value.expansion.control_root);
  assert.deepEqual(sorted(value.acknowledged_unknown_run_ids), value.history.unknown_usage_run_ids, 'COHORT_UNKNOWN_ACK_MISMATCH');
  const exemption = value.history_exemption;
  assert.ok(Number.isSafeInteger(exemption?.scheduled_episodes) && exemption.scheduled_episodes >= 0
    && exemption.scheduled_episodes <= value.history.scheduled_episodes, 'COHORT_HISTORY_EXEMPTION');
  assert.deepEqual(value.history.unknown_usage_run_ids, exemption.unknown_usage_run_ids, 'COHORT_NEW_UNKNOWN_CANNOT_BECOME_HISTORY');
  for (const episode of value.history.episodes.slice(exemption.scheduled_episodes)) {
    assert.equal(episode.core_evidence, 'complete', 'COHORT_NEW_CORE_FAILURE_CANNOT_BECOME_HISTORY');
    assert.equal(episode.stop_batch, false, 'COHORT_NEW_CORE_STOP_CANNOT_BECOME_HISTORY');
  }
}

export function assertProspectiveCohortPlan(plan, amendment) {
  assertCohortShape(amendment);
  const policy = plan.protocol.policies.pilot.scope;
  assert.deepEqual(policy, prospectiveCohortPolicy(policy, plan.protocol.models.length), 'COHORT_POLICY_CHANGED');
  assert.equal(policy.model_count, amendment.model_count); assert.equal(policy.reservation_limit, amendment.reservation_limit);
  const phase = amendment[policy.role]; assert.ok(phase);
  assert.equal(plan.id, phase.experiment_id, 'COHORT_PHASE_PLAN_CHANGED');
  assert.equal(plan.execution.control_root, phase.control_root, 'COHORT_PHASE_ROOT_CHANGED');
  assert.equal(plan.slots.length, phase.scheduled_episodes, 'COHORT_PHASE_SCHEDULE_CHANGED');
  assert.deepEqual(sorted(plan.protocol.corpus.cases.map(item => item.id)), sorted(phase.case_ids), 'COHORT_PHASE_CASES_CHANGED');
  assert.deepEqual({ id: plan.protocol.corpus.id, version: plan.protocol.corpus.version, content_sha256: plan.protocol.corpus.content_sha256 }, amendment.corpus,
    'COHORT_CORPUS_CHANGED');
  assert.ok(plan.protocol.models.every(model => model.routing), 'COHORT_ROUTING_CONTRACT_REQUIRED');
  assert.equal(plan.execution.models_sha256, amendment.models_sha256, 'COHORT_MODEL_REGISTRY_CHANGED');
  assert.equal(plan.protocol.policies.reruns.max_episodes, 0, 'COHORT_RERUN_FORBIDDEN');
  assert.ok(plan.slots.every(slot => slot.repeat === 0), 'COHORT_REPEAT_FORBIDDEN');
  assert.equal(plan.protocol.policies.budgets.length, 1);
  assert.deepEqual(plan.protocol.policies.budgets[0].episode, amendment.episode_budget, 'COHORT_EPISODE_BUDGET_CHANGED');
  assert.deepEqual(plan.protocol.allowed_changes, amendment.allowed_changes, 'COHORT_ALLOWED_CHANGES_CHANGED');
  assert.equal(plan.protocol.conditions.length, amendment.model_count * 2);
  assert.deepEqual(sorted(plan.protocol.environments.map(environment => environment.pi.mode)), ['broker', 'native']);
  for (const condition of plan.protocol.conditions) {
    assert.deepEqual(sorted(condition.case_ids), sorted(phase.case_ids));
    assert.equal(plan.slots.filter(slot => slot.condition_id === condition.id).length, phase.case_ids.length);
  }
  if (policy.role === 'gate') assert.deepEqual(plan.slots, amendment.gate.slots, 'COHORT_GATE_SCHEDULE_CHANGED');
}

export async function prepareProspectiveCohort({ setup, protocol, execution, slots, predecessor }) {
  const input = setup.pilot_scope; assert.equal(input.role, 'gate');
  assert.equal(input.kind, PROSPECTIVE_COHORT); assert.ok(predecessor, 'COHORT_PREDECESSOR_REQUIRED');
  const history = await readCohortHistory({ planFiles: input.history_plan_files, pilotLedgerRoot: execution.pilot_ledger_root });
  if (isProspectiveCohort(predecessor)) assert.equal(history.scheduled_episodes,
    predecessor.history.scheduled_episodes + predecessor.reservation_limit, 'COHORT_PREDECESSOR_INCOMPLETE');
  const exemption = isProspectiveCohort(predecessor) ? predecessor.history_exemption
    : { scheduled_episodes: history.scheduled_episodes, unknown_usage_run_ids: history.unknown_usage_run_ids, checkpoint_sha256: fingerprint(history) };
  const value = { version: 1, kind: PROSPECTIVE_COHORT, id: input.id, authorization: input.authorization,
    registered_at: protocol.registered_at, predecessor: input.predecessor,
    acknowledged_unknown_run_ids: sorted(input.acknowledged_unknown_run_ids ?? []),
    environment_root: execution.environment_root, pilot_ledger_root: execution.pilot_ledger_root,
    max_scheduled_episodes: 144, model_count: protocol.models.length, reservation_limit: protocol.models.length * 24, history, history_exemption: exemption,
    model_conditions: sorted(protocol.models.map(scopeModelIdentity)), environment_conditions: sorted(protocol.environments.map(scopeEnvironmentIdentity)),
    models_sha256: execution.models_sha256, instrumentation: execution.instrumentation, observer_version: protocol.policies.evidence.observer_version,
    corpus: { id: protocol.corpus.id, version: protocol.corpus.version, content_sha256: protocol.corpus.content_sha256 },
    episode_budget: protocol.policies.budgets[0].episode, allowed_changes: protocol.allowed_changes,
    gate: { experiment_id: protocol.id, control_root: execution.control_root, case_ids: protocol.corpus.cases.map(item => item.id),
      scheduled_episodes: protocol.models.length * 8, minimum_valid_real_per_condition: 4, repetitions: 1, slots },
    expansion: { ...input.expansion, scheduled_episodes: protocol.models.length * 16, repetitions: 1 }, amendment_sha256: null };
  assert.notEqual(value.id, predecessor.id); assert.equal(value.pilot_ledger_root, predecessor.pilot_ledger_root);
  value.amendment_sha256 = fingerprint(value); assertCohortShape(value); return value;
}

export async function verifyProspectiveCohort(value) {
  assertCohortShape(value);
  await readCohortHistory({ planFiles: value.history.plans.map(item => item.plan.path), pilotLedgerRoot: value.pilot_ledger_root, expected: value.history });
  return value;
}
