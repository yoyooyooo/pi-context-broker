import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fingerprint, validateProtocol } from './protocol.mjs';
import { readCampaignHistory } from './campaign-history.mjs';
import { isProspectiveCohort, assertCohortModelEvidence, scopeModelIdentity, scopeEnvironmentIdentity } from './prospective-cohort.mjs';
import { assertScopePlan, readPilotScopeAmendment, readScopeCompletedResults } from './pilot-scope.mjs';
import { readEvidenceBundle } from './evidence/store.mjs';
import { scheduleProtocol as expectedSchedule, declaredSchedule, UNSTARTED_FOLLOWUP, assertFollowupSelection } from './campaign-selection.mjs';
import { readApprovedCampaign, approvedCampaignBinding, assertApprovedCampaignBinding } from './approved-campaign.mjs';

export const FINITE_CAMPAIGN = 'benchmark-finite-campaign';
export const isFiniteCampaign = value => value?.kind === FINITE_CAMPAIGN;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safe = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const sorted = values => [...values].sort();
const usageKeys = ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms'];
const knownUsage = value => usageKeys.every(key => Number.isFinite(value?.[key]) && value[key] >= 0);
const canonicalPath = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path;
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const exactKeys = (value, keys, message) => { assert.ok(value && typeof value === 'object' && !Array.isArray(value), message); assert.deepEqual(sorted(Object.keys(value)), sorted(keys), message); };
const withoutScope = execution => { const { campaign_scope: ignored, ...value } = execution; return value; };

async function fileBytes(path) {
  assert.ok(canonicalPath(path), 'FINITE_CANONICAL_PATH_REQUIRED');
  const first = await lstat(path); assert.ok(first.isFile() && !first.isSymbolicLink(), 'FINITE_REGULAR_FILE_REQUIRED');
  assert.equal(await realpath(path), path, 'FINITE_PATH_SYMLINK');
  const bytes = await readFile(path), last = await lstat(path);
  for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(first[field], last[field], 'FINITE_FILE_CHANGED_DURING_READ');
  return bytes;
}
async function verified(reference) {
  assert.ok(hash(reference?.sha256), 'FINITE_REFERENCE_REQUIRED');
  const bytes = await fileBytes(reference.path); assert.equal(sha(bytes), reference.sha256, 'FINITE_REFERENCED_BYTES_CHANGED');
  if (reference.bytes !== undefined) assert.equal(bytes.length, reference.bytes);
  return JSON.parse(bytes);
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.fail('FINITE_ACTIVE_LEASE: ' + path);
}
async function noLeases(execution) {
  for (const key of ['environment_root', 'control_root', 'pilot_ledger_root'])
    assert.equal(await realpath(execution[key]), execution[key], 'FINITE_ROOT_SYMLINK');
  await absent(join(execution.pilot_ledger_root, 'campaign.lease.json'));
  await absent(join(execution.control_root, 'lease.json'));
  assert.ok(!(await readdir(execution.pilot_ledger_root)).some(name => /^scope-.+\.lease\.json$/.test(name)), 'FINITE_LEGACY_LEASE_ACTIVE');
}

export function finiteCampaignPolicy(input, { scheduledEpisodes } = {}) {
  if (!input) return undefined;
  assert.equal(input.kind, FINITE_CAMPAIGN); assert.ok(safe(input.id));
  assert.ok(['route_gate_only', 'acceptance', UNSTARTED_FOLLOWUP].includes(input.role), 'FINITE_ROLE');
  assert.ok(Number.isSafeInteger(scheduledEpisodes) && scheduledEpisodes > 0 && scheduledEpisodes <= 144, 'FINITE_SCHEDULE_COUNT');
  if (input.role === 'route_gate_only') assert.equal(scheduledEpisodes, 8, 'FINITE_GATE_REQUIRES_EIGHT');
  if (input.role === UNSTARTED_FOLLOWUP) {
    assertFollowupSelection(input.selection); assert.equal(input.selection.slot_ids.length, scheduledEpisodes, 'FOLLOWUP_SELECTION_COUNT');
  } else assert.equal(input.selection, undefined, 'FOLLOWUP_SELECTION_ROLE_REQUIRED');
  return { version: 1, kind: FINITE_CAMPAIGN, id: input.id, role: input.role, reservation_limit: scheduledEpisodes,
    max_scheduled_episodes: 144, history_quality: 'excluded_retained_in_campaign_costs', new_unknown_usage: 'stop_scope',
    ...(input.role === UNSTARTED_FOLLOWUP ? { selection: structuredClone(input.selection) } : {}) };
}

function assertProtocolExecution({ protocol, execution, slots }) {
  const validation = validateProtocol(protocol, { stage: 'execute' }); assert.ok(validation.valid, JSON.stringify(validation.errors));
  assert.ok(isFiniteCampaign(protocol.policies.campaign), 'FINITE_POLICY_REQUIRED');
  assert.equal(protocol.policies.pilot.scope, undefined, 'FINITE_LEGACY_POLICY_MIXED');
  assert.equal(execution.pilot_scope, undefined, 'FINITE_LEGACY_SCOPE_MIXED');
  assert.equal(execution.resumption, undefined, 'FINITE_RESUMPTION_MIXED');
  assert.ok(['pilot', 'confirmation'].includes(protocol.phase), 'FINITE_PHASE');
  assert.equal(protocol.policies.pilot.max_scheduled_episodes, 144);
  for (const key of ['environment_root', 'control_root', 'pilot_ledger_root']) assert.ok(canonicalPath(execution[key]), 'FINITE_ROOT_REQUIRED');
  assert.ok(inside(execution.environment_root, execution.control_root), 'FINITE_CONTROL_OUTSIDE_OWNER');
  assert.deepEqual(slots, expectedSchedule(protocol), 'FINITE_SCHEDULE_CHANGED');
  assert.equal(new Set(slots.map(slot => slot.slot_id)).size, slots.length, 'FINITE_DUPLICATE_SLOT');
  const policy = finiteCampaignPolicy(protocol.policies.campaign, { scheduledEpisodes: slots.length });
  assert.deepEqual(protocol.policies.campaign, policy, 'FINITE_POLICY_CHANGED');
  assert.equal(protocol.policies.reruns.max_episodes, 0, 'FINITE_RERUN_FORBIDDEN');
  assert.equal(protocol.policies.ordering.concurrency, 1); assert.equal(protocol.policies.budgets.length, 1);
  const budget = protocol.policies.budgets[0]; assert.equal(budget.batch.max_episodes, slots.length, 'FINITE_BATCH_COUNT_CHANGED');
  assert.equal(budget.episode.max_retries, 0, 'FINITE_RETRY_FORBIDDEN'); assert.equal(budget.batch.max_concurrency, 1);
  assert.ok(protocol.models.every(model => model.routing), 'FINITE_ROUTING_REQUIRED');
  if (policy.role === UNSTARTED_FOLLOWUP) assert.equal(protocol.phase, 'pilot', 'FOLLOWUP_PILOT_ONLY');
  if (policy.role === 'route_gate_only') {
    assert.equal(protocol.phase, 'pilot'); assert.equal(protocol.purpose, 'native_calibration');
    assert.equal(protocol.models.length, 1); assert.equal(protocol.environments.length, 2); assert.equal(protocol.conditions.length, 2);
    assert.deepEqual(sorted(protocol.environments.map(environment => environment.pi.mode)), ['broker', 'native']);
    assert.equal(protocol.corpus.cases.length, 4); assert.equal(protocol.assessments.length, 0); assert.equal(protocol.pairs.length, 4);
    assert.ok(slots.every(slot => slot.repeat === 0));
    const caseIds = sorted(protocol.corpus.cases.map(item => item.id));
    for (const condition of protocol.conditions) {
      assert.deepEqual(sorted(condition.case_ids), caseIds);
      assert.deepEqual(sorted(slots.filter(slot => slot.condition_id === condition.id).map(slot => slot.case_id)), caseIds);
    }
  }
  return policy;
}

function planBinding(protocol, execution, slots) {
  return { experiment_id: protocol.id, control_root: execution.control_root, phase: protocol.phase,
    protocol_sha256: protocol.protocol_sha256, execution_sha256: fingerprint(withoutScope(execution)),
    slots_sha256: fingerprint(slots), scheduled_episodes: slots.length, slots: structuredClone(slots) };
}

function assertHistoryBoundary(value) {
  const history = value.history, exemption = value.history_exemption;
  assert.ok(history && Array.isArray(history.plans) && Array.isArray(history.episodes) && Array.isArray(history.reservations));
  assert.equal(history.episodes.length, history.scheduled_episodes); assert.equal(history.reservations.length, history.scheduled_episodes);
  exactKeys(exemption, ['scheduled_episodes', 'unknown_usage_run_ids', 'checkpoint_sha256'], 'FINITE_HISTORY_EXEMPTION_SHAPE');
  assert.equal(exemption.scheduled_episodes, 13, 'FINITE_ORIGINAL_HISTORY_THIRTEEN_ONLY');
  assert.ok(hash(exemption.checkpoint_sha256)); assert.equal(exemption.unknown_usage_run_ids.length, 3, 'FINITE_ORIGINAL_THREE_UNKNOWNS_ONLY');
  assert.equal(new Set(exemption.unknown_usage_run_ids).size, 3);
  const approved = value.version === 2 ? assertApprovedCampaignBinding(value.prospective_authorization) : null;
  const boundary = approved?.history_boundary ?? exemption;
  assert.deepEqual(history.unknown_usage_run_ids, boundary.unknown_usage_run_ids, 'FINITE_NEW_UNKNOWN_CANNOT_BECOME_HISTORY');
  assert.ok(history.scheduled_episodes >= boundary.scheduled_episodes
    && history.scheduled_episodes + value.reservation_limit <= (approved?.campaign_limit ?? 144), 'FINITE_CAMPAIGN_CAP');
  for (const episode of history.episodes.slice(boundary.scheduled_episodes)) {
    assert.equal(episode.core_evidence, 'complete', 'FINITE_NEW_CORE_FAILURE_CANNOT_BECOME_HISTORY');
    assert.equal(episode.stop_batch, false, 'FINITE_NEW_CORE_STOP_CANNOT_BECOME_HISTORY');
  }
}

function assertShape(value) {
  exactKeys(value, ['version', 'kind', 'id', 'role', 'authorization', 'registered_at', 'predecessor', 'environment_root', 'pilot_ledger_root',
    'max_scheduled_episodes', 'reservation_limit', 'history', 'history_exemption', 'model_conditions', 'environment_conditions', 'models_sha256',
    'instrumentation', 'observer_version', 'plan', 'amendment_sha256',
    ...(value.version === 2 ? ['prospective_authorization'] : []), ...(value.role === UNSTARTED_FOLLOWUP ? ['selection'] : [])], 'FINITE_AMENDMENT_SHAPE');
  assert.ok([1, 2].includes(value.version)); assert.equal(value.kind, FINITE_CAMPAIGN); assert.ok(safe(value.id));
  if (value.role === UNSTARTED_FOLLOWUP) assert.equal(value.version, 2, 'FOLLOWUP_APPROVAL_REQUIRED');
  assert.equal(value.amendment_sha256, fingerprint({ ...value, amendment_sha256: null }), 'FINITE_AMENDMENT_CHANGED');
  assert.ok(typeof value.authorization === 'string' && value.authorization.trim()); assert.ok(Number.isFinite(Date.parse(value.registered_at)));
  assert.ok(canonicalPath(value.environment_root) && canonicalPath(value.pilot_ledger_root)); assert.equal(value.max_scheduled_episodes, 144);
  finiteCampaignPolicy(value, { scheduledEpisodes: value.reservation_limit });
  exactKeys(value.predecessor, ['registration', 'amendment'], 'FINITE_PREDECESSOR_SHAPE');
  for (const reference of Object.values(value.predecessor)) assert.ok(canonicalPath(reference.path) && hash(reference.sha256));
  exactKeys(value.plan, ['experiment_id', 'control_root', 'phase', 'protocol_sha256', 'execution_sha256', 'slots_sha256', 'scheduled_episodes', 'slots'], 'FINITE_PLAN_BINDING_SHAPE');
  assert.ok(safe(value.plan.experiment_id)); assert.ok(canonicalPath(value.plan.control_root) && inside(value.environment_root, value.plan.control_root));
  assert.ok(['pilot', 'confirmation'].includes(value.plan.phase));
  for (const key of ['protocol_sha256', 'execution_sha256', 'slots_sha256']) assert.ok(hash(value.plan[key]));
  assert.equal(value.plan.scheduled_episodes, value.reservation_limit); assert.equal(value.plan.slots.length, value.reservation_limit);
  assert.equal(value.plan.slots_sha256, fingerprint(value.plan.slots));
  assertHistoryBoundary(value);
}

export function assertFiniteCampaignPlan(plan, amendment) {
  assertShape(amendment); assert.equal(plan.version, 1); assert.equal(plan.kind, 'benchmark-batch-plan');
  assert.equal(plan.plan_sha256, fingerprint({ ...plan, plan_sha256: null }), 'FINITE_PLAN_CHANGED');
  assert.equal(plan.id, plan.protocol.id);
  const policy = assertProtocolExecution(plan), registration = plan.execution.campaign_scope;
  exactKeys(registration, ['version', 'kind', 'id', 'role', 'amendment'], 'FINITE_EXECUTION_SCOPE_SHAPE');
  assert.equal(registration.version, 1); assert.equal(registration.kind, FINITE_CAMPAIGN);
  assert.equal(registration.id, amendment.id); assert.equal(registration.role, amendment.role);
  assert.equal(policy.id, amendment.id); assert.equal(policy.role, amendment.role); assert.equal(policy.reservation_limit, amendment.reservation_limit);
  assert.deepEqual(policy.selection, amendment.selection, 'FOLLOWUP_SELECTION_CHANGED');
  assert.equal(registration.amendment.path, join(amendment.plan.control_root, 'finite-campaign-amendment.json')); assert.ok(hash(registration.amendment.sha256));
  assert.deepEqual(planBinding(plan.protocol, plan.execution, plan.slots), amendment.plan, 'FINITE_PLAN_BINDING_CHANGED');
  assert.equal(plan.execution.environment_root, amendment.environment_root); assert.equal(plan.execution.pilot_ledger_root, amendment.pilot_ledger_root);
  assert.deepEqual(sorted(plan.protocol.models.map(scopeModelIdentity)), amendment.model_conditions);
  assert.deepEqual(sorted(plan.protocol.environments.map(scopeEnvironmentIdentity)), amendment.environment_conditions);
  assert.equal(plan.execution.models_sha256, amendment.models_sha256); assert.deepEqual(plan.execution.instrumentation, amendment.instrumentation);
  assert.equal(plan.protocol.policies.evidence.observer_version, amendment.observer_version);
  return amendment;
}

async function shallowFinite(reference) {
  const value = await verified(reference); assertShape(value);
  assert.equal(reference.path, join(value.plan.control_root, 'finite-campaign-amendment.json'));
  return value;
}

async function materialIdentities(protocol, execution) {
  let bindings = [];
  if (execution.case_bindings_file) {
    const bytes = await fileBytes(execution.case_bindings_file);
    assert.equal(sha(bytes), execution.case_bindings_sha256, 'FINITE_MATERIAL_BINDINGS_CHANGED');
    bindings = JSON.parse(bytes); assert.ok(Array.isArray(bindings));
  }
  return protocol.corpus.cases.map(item => {
    const binding = bindings.find(value => value.id === item.id);
    if (execution.case_bindings_file) { assert.ok(binding, 'FINITE_MATERIAL_BINDING_MISSING'); assert.deepEqual(binding.protocol_case, item); }
    const values = [ ['material_id', item.material_id], ['content', item.content_sha256],
      ['business_tuple', fingerprint(Object.fromEntries(['content_sha256', 'prompt_sha256', 'contract_sha256', 'initial_state_sha256', 'authorization_sha256'].map(key => [key, item[key]])))] ];
    if (binding) {
      if (hash(binding.variant?.content_sha256)) values.push(['canonical_variant', binding.variant.content_sha256]);
      if (hash(binding.public_case?.content_sha256)) values.push(['canonical_public_case', binding.public_case.content_sha256]);
      const pc = binding.public_case;
      if (pc && Array.isArray(pc.attachments)) values.push(['public_business_tuple', fingerprint({
        attachments: pc.attachments.map(file => ({ path: file.path, sha256: file.sha256, encoding: file.encoding ?? null })).sort((a, b) => a.path.localeCompare(b.path)),
        prompt_sha256: pc.prompt_sha256, contract_sha256: pc.contract_sha256,
        initial_state_sha256: pc.initial_state_sha256, authorization_sha256: pc.authorization_sha256 })]);
    }
    return values.map(([kind, value]) => kind + ':' + value);
  }).flat();
}

// Detect known exposure from owned historical protocol/binding identities. This
// is not a claim about unknown training data, unseen content elsewhere, or OS
// isolation; seal/open and subject-visible material audits remain separate.
async function assertConfirmationUnexposed(protocol, execution, history) {
  if (protocol.phase !== 'confirmation') return;
  const current = new Set(await materialIdentities(protocol, execution));
  for (const entry of history.plans) {
    const plan = await verified(entry.plan);
    const identities = await materialIdentities(plan.protocol, plan.execution);
    assert.ok(!identities.some(value => current.has(value)), 'FINITE_CONFIRMATION_KNOWN_MATERIAL_EXPOSURE');
  }
}

async function assertHistoricalPlan(plan) {
  assert.equal(plan?.version, 1); assert.equal(plan.kind, 'benchmark-batch-plan');
  assert.equal(plan.plan_sha256, fingerprint({ ...plan, plan_sha256: null }), 'FINITE_HISTORY_PLAN_CHANGED');
  const validation = validateProtocol(plan.protocol, { stage: 'execute' }); assert.ok(validation.valid, JSON.stringify(validation.errors));
  assert.equal(plan.id, plan.protocol.id); assert.equal(plan.protocol.policies.pilot.max_scheduled_episodes, 144);
  if (plan.protocol.policies.campaign || plan.execution.campaign_scope) {
    assert.ok(isFiniteCampaign(plan.protocol.policies.campaign) && isFiniteCampaign(plan.execution.campaign_scope), 'FINITE_HISTORY_TYPED_SCOPE_REQUIRED');
    const amendment = await shallowFinite(plan.execution.campaign_scope.amendment);
    assertFiniteCampaignPlan(plan, amendment); await assertConfirmationUnexposed(plan.protocol, plan.execution, amendment.history);
    if (amendment.version === 2) await assertAuthorizedProtocol(plan.protocol, plan.execution, plan.slots, amendment,
      await readApprovedCampaign(amendment.prospective_authorization.reference));
  } else assert.equal(plan.protocol.phase, 'pilot', 'FINITE_HISTORY_UNREGISTERED_NONPILOT');
}


// The original observed stop and usage are never erased by a later same-raw
// analysis revision. Only the retained first thirteen observations are exempt.
async function assertOriginalCompleted({ plan, event, ordinal, hasRevision }) {
  if (ordinal <= 13) return;
  const result = event.result;
  assert.equal(result.stop_batch, false, 'FINITE_ORIGINAL_CORE_STOP');
  assert.ok(knownUsage(result.budget_usage), 'FINITE_ORIGINAL_UNKNOWN_USAGE');
  if (!hasRevision) return; // The ordinary result check will read these same bytes.
  const { episode } = await readEvidenceBundle({ directory: result.normalized_directory, rawRoot: plan.execution.environment_root });
  assert.equal(episode.episode_sha256, result.episode_sha256, 'FINITE_ORIGINAL_EVIDENCE_CHANGED');
  const slot = plan.slots.find(item => item.slot_id === event.slot_id); assert.ok(slot);
  assert.equal(episode.identity.run_id, event.run_id); assert.equal(episode.identity.experiment_id, plan.id);
  assert.equal(episode.identity.case_id, slot.case_id); assert.equal(episode.identity.condition_id, slot.condition_id);
  assert.equal(episode.admission.status, 'valid', 'FINITE_ORIGINAL_CORE_INVALID');
  for (const key of ['attempts', 'tools', 'interventions']) assert.equal(episode.admission.completeness[key], 'complete', 'FINITE_ORIGINAL_CORE_INCOMPLETE');
  assert.equal(episode.measurements.actual_attempts.status, 'known'); assert.ok(episode.measurements.actual_attempts.value > 0);
  assert.equal(episode.measurements.input_total.value.status, 'known'); assert.equal(episode.measurements.output_total.value.status, 'known'); assert.equal(episode.timing.duration_ms.status, 'known');
  assert.ok(episode.attempts.filter(attempt => attempt.sent).every(attempt => attempt.adapter.verified));
  const condition = plan.protocol.conditions.find(item => item.id === slot.condition_id), environment = plan.protocol.environments.find(item => item.id === condition.environment_id);
  assert.equal(episode.identity.model_id, condition.model_id); assert.equal(episode.identity.environment_sha256, environment.manifest_sha256); assert.equal(episode.identity.build_id, environment.build.id);
  assertCohortModelEvidence(episode, plan.protocol.models.find(item => item.id === condition.model_id));
  assert.deepEqual(result.budget_usage, { model_requests: episode.measurements.actual_attempts.value, input_tokens: episode.measurements.input_total.value.value,
    output_tokens: episode.measurements.output_total.value.value, duration_ms: episode.timing.duration_ms.value }, 'FINITE_ORIGINAL_USAGE_MISMATCH');
}

/** Historical gate/publication readers can verify original observations without
 * assuming this scope is still the latest campaign suffix. */
export async function verifyFiniteOriginalResults(plan, rows, { analysisRevisionReference } = {}) {
  assert.ok(isFiniteCampaign(plan.protocol.policies.campaign) && isFiniteCampaign(plan.execution.campaign_scope), 'FINITE_TYPED_SCOPE_REQUIRED');
  const hasRevision = Boolean(analysisRevisionReference || rows.some(row => row.type === 'analysis_revision_applied'));
  const completed = rows.filter(row => row.type === 'episode_completed');
  for (const event of completed) await assertOriginalCompleted({ plan, event, ordinal: 14, hasRevision });
  return { status: 'verified', original_completed: completed.length };
}

async function originalLedger(plan) {
  let bytes;
  try { bytes = await fileBytes(join(plan.execution.control_root, 'ledger.jsonl')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  assert.ok(!bytes.length || bytes.at(-1) === 10, 'FINITE_INCOMPLETE_LEDGER');
  return bytes.toString('utf8').split('\n').filter(Boolean).map((line, index) => { const row = JSON.parse(line); assert.equal(row.seq, index + 1); return row; });
}

export async function readFiniteCampaignHistory({ prospectiveAuthorization, ...options }) {
  const authorized = prospectiveAuthorization ? await readApprovedCampaign(prospectiveAuthorization) : null;
  const history = await readCampaignHistory({ ...options, assertPlan: assertHistoricalPlan,
    assertOriginalCompleted: input => authorized && input.ordinal <= authorized.value.history.scheduled_episodes
      ? undefined : assertOriginalCompleted(input),
    assertModelEvidence: (episode, model, plan) => {
      if (isFiniteCampaign(plan.protocol.policies.campaign) || isProspectiveCohort(plan.protocol.policies.pilot.scope)) assertCohortModelEvidence(episode, model);
    } });
  if (authorized) assertPrefix(history, authorized.value.history);
  return history;
}

function assertPrefix(current, expected) {
  assert.ok(current.scheduled_episodes >= expected.scheduled_episodes);
  for (const key of ['reservations', 'episodes']) assert.deepEqual(current[key].slice(0, expected.scheduled_episodes), expected[key], 'FINITE_HISTORY_PREFIX_CHANGED');
  for (const entry of expected.plans) assert.deepEqual(current.plans.find(item => item.plan.path === entry.plan.path), entry, 'FINITE_HISTORY_OWNER_CHANGED');
}
async function predecessorRegistration(value, predecessor) {
  const ref = value.predecessor.registration; assert.equal(dirname(ref.path), value.pilot_ledger_root);
  assert.ok(/^scope-registration(?:-\d{3})?\.json$/.test(ref.path.split(sep).at(-1)));
  const registration = await verified(ref); assert.equal(registration.id, predecessor.id);
  assert.deepEqual(registration.amendment, value.predecessor.amendment, 'FINITE_PREDECESSOR_REGISTRATION_CHANGED');
}
async function assertPredecessorComplete(value, predecessor, authorized = null) {
  assert.notEqual(value.id, predecessor.id); assert.equal(value.pilot_ledger_root, predecessor.pilot_ledger_root);
  assert.ok(isFiniteCampaign(predecessor) || isProspectiveCohort(predecessor), 'FINITE_CLOSED_FINITE_PREDECESSOR_REQUIRED');
  assert.deepEqual(value.history_exemption, predecessor.history_exemption, 'FINITE_HISTORY_EXEMPTION_CHANGED');
  assertPrefix(value.history, predecessor.history);
  const approvedTransition = authorized && fingerprint(value.predecessor) === fingerprint(authorized.value.predecessor);
  if (approvedTransition) assert.deepEqual(value.history, authorized.value.history, 'APPROVAL_INITIAL_HISTORY_CHANGED');
  else {
    assert.equal(value.history.scheduled_episodes, predecessor.history.scheduled_episodes + predecessor.reservation_limit, 'FINITE_PREDECESSOR_INCOMPLETE');
    if (authorized) assert.deepEqual(value.prospective_authorization.reference, predecessor.prospective_authorization?.reference, 'APPROVAL_LINEAGE_CHANGED');
  }
  const phases = isFiniteCampaign(predecessor) ? [predecessor.plan] : [predecessor.gate, predecessor.expansion];
  const owners = new Map();
  for (const phase of phases) {
    const path = join(phase.control_root, 'plan.json'), entry = value.history.plans.find(item => item.plan.path === path);
    assert.ok(entry, 'FINITE_PREDECESSOR_PLAN_MISSING'); const plan = await verified(entry.plan);
    if (isFiniteCampaign(predecessor)) { assertFiniteCampaignPlan(plan, predecessor); assert.deepEqual(plan.execution.campaign_scope.amendment, value.predecessor.amendment); }
    else { assertScopePlan(plan, predecessor); assert.deepEqual(plan.execution.pilot_scope.amendment, value.predecessor.amendment); }
    const episodes = value.history.episodes.filter(item => item.experiment_id === phase.experiment_id);
    if (approvedTransition) assert.ok(episodes.length <= phase.scheduled_episodes, 'APPROVAL_PREDECESSOR_PLAN_OVERFLOW');
    else assert.equal(episodes.length, phase.scheduled_episodes, 'FINITE_PREDECESSOR_PLAN_INCOMPLETE');
    assert.equal(plan.slots.length, phase.scheduled_episodes); owners.set(plan.id, { plan, reference: entry.plan });
  }
  for (const [index, entry] of value.history.reservations.slice(predecessor.history.scheduled_episodes).entries()) {
    const reservation = await verified(entry.reference), owner = owners.get(reservation.experiment_id);
    assert.ok(owner, 'FINITE_PREDECESSOR_FOREIGN_PLAN');
    assert.equal(reservation.scope_id, predecessor.id); assert.equal(reservation.scope_amendment_sha256, predecessor.amendment_sha256);
    assert.equal(reservation.plan_sha256, owner.plan.plan_sha256); assert.deepEqual(reservation.plan, owner.reference);
    const role = isFiniteCampaign(predecessor) ? owner.plan.execution.campaign_scope.role : owner.plan.execution.pilot_scope.role;
    assert.equal(reservation.scope_role, role, 'FINITE_PREDECESSOR_ROLE_CHANGED');
    if (isFiniteCampaign(predecessor)) {
      assert.equal(reservation.scope_kind, FINITE_CAMPAIGN);
      assert.equal(reservation.slot_id, predecessor.plan.slots[index].slot_id, 'FINITE_PREDECESSOR_RESERVATION_ORDER');
    }
    assert.ok(owner.plan.slots.some(slot => slot.slot_id === reservation.slot_id));
  }
  if (approvedTransition) for (const { plan } of owners.values()) {
    const actual = [];
    for (const entry of value.history.reservations.slice(predecessor.history.scheduled_episodes)) {
      const reservation = await verified(entry.reference); if (reservation.experiment_id === plan.id) actual.push(reservation.slot_id);
    }
    assert.deepEqual(actual, plan.slots.slice(0, actual.length).map(slot => slot.slot_id), 'APPROVAL_PREDECESSOR_EXECUTION_PREFIX');
  }
}

async function authorizedScope(value, context) {
  if (value.version !== 2) return null;
  const binding = value.prospective_authorization;
  if (!context.authorized) context.authorized = await readApprovedCampaign(binding.reference);
  const authorized = context.authorized;
  assert.deepEqual(binding, approvedCampaignBinding(binding.reference, authorized.value, binding.allocation_id), 'APPROVAL_BINDING_CHANGED');
  if (context.reference) assert.deepEqual(binding.reference, context.reference, 'APPROVAL_LINEAGE_CHANGED');
  else context.reference = binding.reference;
  const allocation = authorized.value.allocations.find(item => item.id === binding.allocation_id);
  assert.equal(value.id, allocation.id, 'APPROVAL_SCOPE_ID_CHANGED'); assert.equal(value.role, allocation.role, 'APPROVAL_SCOPE_ROLE_CHANGED');
  assert.ok(value.reservation_limit <= allocation.reservation_limit, 'APPROVAL_ALLOCATION_LIMIT');
  assert.equal(value.environment_root, authorized.value.environment_root); assert.equal(value.pilot_ledger_root, authorized.value.pilot_ledger_root);
  assertPrefix(value.history, authorized.value.history);
  assert.ok(!context.allocations.has(allocation.id), 'APPROVAL_ALLOCATION_REUSED'); context.allocations.add(allocation.id);
  return authorized;
}

async function assertAuthorizedProtocol(protocol, execution, slots, value, authorized) {
  if (!authorized) return;
  const allocation = authorized.value.allocations.find(item => item.id === value.prospective_authorization.allocation_id);
  const work = authorized.proposal.work[allocation.work_index];
  if (work.route) {
    assert.equal(protocol.models.length, 1);
    assert.equal(protocol.models[0].provider + '/' + protocol.models[0].route, work.route, 'APPROVAL_ROUTE_CHANGED');
  }
  if (value.role !== UNSTARTED_FOLLOWUP) return;
  const candidates = [];
  for (const item of authorized.value.history.plans) {
    const plan = await verified(item.plan); if (plan.plan_sha256 === value.selection.source_plan_sha256) candidates.push(plan);
  }
  assert.equal(candidates.length, 1, 'FOLLOWUP_SOURCE_PLAN_MISSING');
  const source = candidates[0];
  assert.equal(source.execution.pilot_scope?.amendment.sha256, authorized.value.predecessor.amendment.sha256, 'FOLLOWUP_SOURCE_NOT_STOPPED_SCOPE');
  const observed = new Set(authorized.value.history.episodes.filter(item => item.experiment_id === source.id).map(item => item.run_id));
  const unstarted = source.slots.filter(slot => !observed.has(source.id + '-' + String(slot.order + 1).padStart(3, '0')));
  assert.deepEqual(value.selection.slot_ids, unstarted.map(slot => slot.slot_id), 'FOLLOWUP_MUST_USE_EXACT_UNSTARTED_SUFFIX');
  assert.deepEqual(slots, unstarted.map((slot, order) => ({ ...slot, order })), 'FOLLOWUP_SOURCE_SLOTS_CHANGED');
  assert.deepEqual(declaredSchedule(protocol), source.slots, 'FOLLOWUP_SCIENTIFIC_DESIGN_CHANGED');
  assert.deepEqual(protocol.corpus, source.protocol.corpus, 'FOLLOWUP_BUSINESS_MATERIAL_CHANGED');
  assert.deepEqual(protocol.pairs, source.protocol.pairs, 'FOLLOWUP_COMPARISON_DESIGN_CHANGED');
  assert.deepEqual(protocol.assessments, source.protocol.assessments, 'FOLLOWUP_ASSESSMENTS_CHANGED');
  assert.deepEqual(protocol.policies.statistics, source.protocol.policies.statistics, 'FOLLOWUP_STATISTICAL_DENOMINATOR_CHANGED');
  for (const condition of protocol.conditions) {
    const original = source.protocol.conditions.find(item => item.id === condition.id); assert.ok(original, 'FOLLOWUP_CONDITION_MISSING');
    const before = source.protocol.models.find(item => item.id === original.model_id), after = protocol.models.find(item => item.id === condition.model_id);
    assert.equal(after.routing.model_variant, before.routing.model_variant, 'FOLLOWUP_MODEL_VARIANT_CHANGED');
    assert.deepEqual(after.parameters, before.parameters, 'FOLLOWUP_MODEL_PARAMETERS_CHANGED');
    const oldEnvironment = source.protocol.environments.find(item => item.id === original.environment_id);
    const newEnvironment = protocol.environments.find(item => item.id === condition.environment_id);
    assert.equal(newEnvironment.pi.mode, oldEnvironment.pi.mode, 'FOLLOWUP_MODE_CHANGED');
    assert.deepEqual(newEnvironment.build, oldEnvironment.build, 'FOLLOWUP_SUBJECT_BUILD_CHANGED');
    assert.deepEqual(condition.case_ids, original.case_ids, 'FOLLOWUP_CONDITION_CASES_CHANGED');
  }
  // New route/API/window identities remain explicit in this new protocol. They
  // are not asserted equivalent to the stopped experiment's model condition.
}

// Walk immutable amendment links once. The outer history read verifies all raw
// observations once; historical owner validation never recurses into this walk.
async function readLineage(reference, seen = new Set(), context = { allocations: new Set() }) {
  assert.ok(!seen.has(reference.path), 'FINITE_PREDECESSOR_CYCLE'); seen.add(reference.path);
  const preview = await verified(reference);
  if (!isFiniteCampaign(preview)) {
    const value = await readPilotScopeAmendment(reference);
    assert.ok(isProspectiveCohort(value), 'FINITE_PROSPECTIVE_PREDECESSOR_REQUIRED');
    assert.equal(value.history_exemption.scheduled_episodes, 13, 'FINITE_ORIGINAL_HISTORY_THIRTEEN_ONLY');
    return value;
  }
  const value = await shallowFinite(reference), predecessor = await readLineage(value.predecessor.amendment, seen, context);
  const authorized = await authorizedScope(value, context);
  await predecessorRegistration(value, predecessor); await assertPredecessorComplete(value, predecessor, authorized);
  return value;
}

export async function verifyFiniteCampaign(value) {
  assertShape(value);
  const context = { allocations: new Set() }, predecessor = await readLineage(value.predecessor.amendment, new Set(), context);
  const authorized = await authorizedScope(value, context);
  await predecessorRegistration(value, predecessor); await assertPredecessorComplete(value, predecessor, authorized);
  await readFiniteCampaignHistory({ planFiles: value.history.plans.map(item => item.plan.path), pilotLedgerRoot: value.pilot_ledger_root, expected: value.history,
    ...(authorized ? { prospectiveAuthorization: value.prospective_authorization.reference } : {}) });
  return value;
}
export async function readFiniteCampaignAmendment(reference) {
  return verifyFiniteCampaign(await shallowFinite(reference));
}

/** Read-only preparation; configure owns the immutable amendment/plan writes. */
export async function prepareFiniteCampaign({ setup, protocol, execution, slots, predecessor }) {
  const input = setup.campaign_scope; assert.ok(input && !execution.campaign_scope);
  const policy = assertProtocolExecution({ protocol, execution, slots });
  assert.deepEqual(policy, finiteCampaignPolicy(input, { scheduledEpisodes: slots.length }));
  await noLeases(execution);
  const context = { allocations: new Set() }, previous = await readLineage(input.predecessor.amendment, new Set(), context);
  if (predecessor) assert.deepEqual(previous, predecessor, 'FINITE_VERIFIED_PREDECESSOR_CHANGED');
  const approved = input.prospective_authorization ? await readApprovedCampaign(input.prospective_authorization) : null;
  const prospective = approved ? approvedCampaignBinding(input.prospective_authorization, approved.value, input.allocation_id) : null;
  if (previous.version === 2 && isFiniteCampaign(previous)) assert.ok(prospective, 'APPROVAL_LINEAGE_REQUIRED');
  const history = await readFiniteCampaignHistory({ planFiles: input.history_plan_files, pilotLedgerRoot: execution.pilot_ledger_root,
    ...(approved ? { prospectiveAuthorization: input.prospective_authorization } : {}) });
  const value = { version: approved ? 2 : 1, kind: FINITE_CAMPAIGN, id: input.id, role: input.role, authorization: input.authorization,
    registered_at: protocol.registered_at, predecessor: structuredClone(input.predecessor), environment_root: execution.environment_root,
    pilot_ledger_root: execution.pilot_ledger_root, max_scheduled_episodes: 144, reservation_limit: slots.length, history,
    history_exemption: structuredClone(previous.history_exemption), model_conditions: sorted(protocol.models.map(scopeModelIdentity)),
    environment_conditions: sorted(protocol.environments.map(scopeEnvironmentIdentity)), models_sha256: execution.models_sha256,
    instrumentation: structuredClone(execution.instrumentation), observer_version: protocol.policies.evidence.observer_version,
    plan: planBinding(protocol, execution, slots), amendment_sha256: null,
    ...(prospective ? { prospective_authorization: prospective } : {}),
    ...(input.role === UNSTARTED_FOLLOWUP ? { selection: structuredClone(input.selection) } : {}) };
  value.amendment_sha256 = fingerprint(value); assertShape(value);
  const authorized = await authorizedScope(value, context);
  await predecessorRegistration(value, previous); await assertPredecessorComplete(value, previous, authorized);
  await assertAuthorizedProtocol(protocol, execution, slots, value, authorized);
  await assertConfirmationUnexposed(protocol, execution, history); await noLeases(execution);
  return value;
}

async function reservations(root) {
  assert.equal(await realpath(root), root, 'FINITE_LEDGER_SYMLINK');
  const names = (await readdir(root)).filter(name => /^\d{3}\.json$/.test(name)).sort();
  assert.ok(names.length <= 144, 'FINITE_CAMPAIGN_CAP'); const entries = [];
  for (const [index, name] of names.entries()) {
    assert.equal(name, String(index + 1).padStart(3, '0') + '.json', 'FINITE_RESERVATION_GAP');
    const path = join(root, name), bytes = await fileBytes(path);
    entries.push({ ordinal: index + 1, reference: { path, sha256: sha(bytes) }, value: JSON.parse(bytes) });
  }
  assert.equal(new Set(entries.map(item => item.value.run_id)).size, entries.length, 'FINITE_DUPLICATE_RESERVED_RUN');
  return entries;
}

export function finiteCampaignReservationFields(plan, amendment, planReference) {
  assertFiniteCampaignPlan(plan, amendment);
  assert.equal(planReference.path, join(plan.execution.control_root, 'plan.json')); assert.ok(hash(planReference.sha256));
  return { scope_id: amendment.id, scope_amendment_sha256: amendment.amendment_sha256, scope_kind: FINITE_CAMPAIGN,
    plan: planReference, plan_sha256: plan.plan_sha256, scope_role: amendment.role };
}

/** Rechecked before each reservation. An in-flight same-plan observation may be
 * reconciled, but cannot justify a new reservation until its evidence completes. */
export async function verifyFiniteCampaignScope(plan, options = {}) {
  const registration = plan.execution.campaign_scope;
  if (!registration) { assert.equal(plan.protocol.policies.campaign, undefined); return null; }
  const amendment = await readFiniteCampaignAmendment(registration.amendment); assertFiniteCampaignPlan(plan, amendment);
  if (amendment.version === 2) await assertAuthorizedProtocol(plan.protocol, plan.execution, plan.slots, amendment,
    await readApprovedCampaign(amendment.prospective_authorization.reference));
  await assertConfirmationUnexposed(plan.protocol, plan.execution, amendment.history);
  const all = await reservations(amendment.pilot_ledger_root);
  assert.deepEqual(all.slice(0, amendment.history.scheduled_episodes).map(({ ordinal, reference }) => ({ ordinal, reference })), amendment.history.reservations, 'FINITE_HISTORY_RESERVATION_CHANGED');
  const current = all.slice(amendment.history.scheduled_episodes);
  assert.ok(current.length <= amendment.reservation_limit, 'FINITE_RESERVATION_LIMIT');
  const planPath = join(plan.execution.control_root, 'plan.json'), planBytes = await fileBytes(planPath);
  assert.deepEqual(JSON.parse(planBytes), plan, 'FINITE_CURRENT_PLAN_CHANGED'); const planReference = { path: planPath, sha256: sha(planBytes) };
  const expectedFields = finiteCampaignReservationFields(plan, amendment, planReference);
  await verifyFiniteOriginalResults(plan, await originalLedger(plan), options);
  const effective = await readScopeCompletedResults(plan, options), { rows, completed } = effective;
  assert.ok(!rows.some(row => row.type === 'episode_not_dispatched'), 'FINITE_SKIPPED_SLOT');
  const starts = rows.filter(row => row.type === 'episode_started');
  assert.equal(new Set(starts.map(row => row.run_id)).size, starts.length, 'FINITE_DUPLICATE_START');
  assert.equal(new Set(completed.map(row => row.run_id)).size, completed.length, 'FINITE_DUPLICATE_RESULT');
  assert.deepEqual(starts.map(row => row.slot_id), plan.slots.slice(0, starts.length).map(slot => slot.slot_id), 'FINITE_EXECUTION_ORDER_CHANGED');
  assert.equal(starts.length, current.length, 'FINITE_ORPHAN_RESERVATION');
  assert.ok(completed.every(row => starts.some(start => start.run_id === row.run_id && start.slot_id === row.slot_id)), 'FINITE_UNSTARTED_RESULT');
  const reservedSlots = new Set(); let unresolved = false;
  for (const [index, { value: reservation }] of current.entries()) {
    assert.equal(reservation.slot_id, plan.slots[index].slot_id, 'FINITE_RESERVATION_ORDER_CHANGED');
    for (const [key, value] of Object.entries(expectedFields)) assert.deepEqual(reservation[key], value, 'FINITE_FOREIGN_RESERVATION');
    assert.equal(reservation.experiment_id, plan.id);
    const slot = plan.slots.find(item => item.slot_id === reservation.slot_id); assert.ok(slot, 'FINITE_UNKNOWN_SLOT');
    assert.ok(!reservedSlots.has(slot.slot_id), 'FINITE_DUPLICATE_RESERVED_SLOT'); reservedSlots.add(slot.slot_id);
    assert.equal(reservation.run_id, plan.id + '-' + String(slot.order + 1).padStart(3, '0'), 'FINITE_RUN_ID_CHANGED');
    const start = starts.find(row => row.run_id === reservation.run_id); assert.ok(start); assert.equal(start.slot_id, slot.slot_id);
    const event = completed.find(row => row.run_id === reservation.run_id);
    if (!event) { unresolved = true; continue; }
    assert.equal(event.slot_id, slot.slot_id); assert.equal(event.result.stop_batch, false, 'FINITE_RETAINED_CORE_STOP');
    const result = event.result; assert.ok(knownUsage(result.budget_usage), 'FINITE_UNKNOWN_NEW_USAGE');
    const { episode } = await readEvidenceBundle({ directory: result.normalized_directory, rawRoot: amendment.environment_root });
    assert.equal(episode.episode_sha256, result.episode_sha256, 'FINITE_NEW_EVIDENCE_CHANGED');
    const condition = plan.protocol.conditions.find(item => item.id === slot.condition_id), environment = plan.protocol.environments.find(item => item.id === condition.environment_id);
    assert.equal(episode.identity.run_id, reservation.run_id); assert.equal(episode.identity.experiment_id, plan.id);
    assert.equal(episode.identity.case_id, slot.case_id); assert.equal(episode.identity.condition_id, slot.condition_id);
    assert.equal(episode.identity.model_id, condition.model_id); assert.equal(episode.identity.environment_sha256, environment.manifest_sha256); assert.equal(episode.identity.build_id, environment.build.id);
    assertCohortModelEvidence(episode, plan.protocol.models.find(item => item.id === condition.model_id));
    assert.equal(episode.admission.status, 'valid', 'FINITE_NEW_CORE_INVALID');
    for (const key of ['attempts', 'tools', 'interventions']) assert.equal(episode.admission.completeness[key], 'complete', 'FINITE_NEW_CORE_INCOMPLETE');
    assert.equal(episode.measurements.actual_attempts.status, 'known'); assert.ok(episode.measurements.actual_attempts.value > 0, 'FINITE_NO_REAL_SEND');
    assert.equal(episode.measurements.input_total.value.status, 'known'); assert.equal(episode.measurements.output_total.value.status, 'known'); assert.equal(episode.timing.duration_ms.status, 'known');
    assert.ok(episode.attempts.filter(attempt => attempt.sent).every(attempt => attempt.adapter.verified));
    assert.deepEqual(result.budget_usage, { model_requests: episode.measurements.actual_attempts.value, input_tokens: episode.measurements.input_total.value.value,
      output_tokens: episode.measurements.output_total.value.value, duration_ms: episode.timing.duration_ms.value }, 'FINITE_NEW_USAGE_MISMATCH');
  }
  if (options.forReservation) {
    assert.equal(unresolved, false, 'FINITE_UNRESOLVED_PREVIOUS_EXECUTION');
    if (current.length === amendment.reservation_limit) throw Object.assign(new Error('The finite campaign scope is complete'), { code: 'COHORT_CAP' });
  }
  return amendment;
}
