import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fingerprint, validateProtocol } from './protocol.mjs';
import { CONFIRMATION_CONTINUATION, declaredSchedule } from './campaign-selection.mjs';
import { readRegisteredAllocationScopes } from './campaign-history-extension.mjs';
import { readCampaignHistory } from './campaign-history.mjs';
import { assertFiniteCampaignPlan, verifyAuthorizedHistoryPlan, verifyFiniteOriginalResults } from './finite-campaign.mjs';
import { assertCohortModelEvidence, isProspectiveCohort } from './prospective-cohort.mjs';
import { assertRetainedAliasEpisode } from './campaign-alias-revision.mjs';
import { readEvidenceBundle } from './evidence/store.mjs';
import { assertSameConfirmationDesign, assertSameConfirmationModels } from './campaign-confirmation-continuation.mjs';

export const PROVIDER_STOP_REVISION = 'accepted-provider-stop-confirmation-continuation';
const known = value => Number.isFinite(value) && value >= 0;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = values => [...values].sort();
const clean = ref => ({ path: ref.path, sha256: ref.sha256 });
const safe = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const keys = (value, expected) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'PROVIDER_STOP_SHAPE');
  assert.deepEqual(sorted(Object.keys(value)), sorted(expected), 'PROVIDER_STOP_SHAPE');
};
async function file(path) {
  assert.ok(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'PROVIDER_STOP_CANONICAL_PATH');
  const before = await lstat(path); assert.ok(before.isFile() && !before.isSymbolicLink()); assert.equal(await realpath(path), path);
  const bytes = await readFile(path), after = await lstat(path);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(before[key], after[key], 'PROVIDER_STOP_READ_CHANGED');
  return { reference: { path, sha256: sha(bytes) }, bytes };
}
async function verified(ref) {
  keys(ref, ['path', 'sha256']); assert.match(ref.sha256, /^[a-f0-9]{64}$/);
  const value = await file(ref.path); assert.deepEqual(value.reference, ref, 'PROVIDER_STOP_REFERENCE_CHANGED');
  return JSON.parse(value.bytes);
}
async function boundary(root, sequence) {
  const names = await readdir(root);
  assert.ok(!names.some(name => name === 'campaign.lease.json' || /^scope-.+\.lease\.json$/.test(name)), 'PROVIDER_STOP_ACTIVE_LEASE');
  assert.equal(names.filter(name => /^\d{3}\.json$/.test(name)).length, 86, 'PROVIDER_STOP_BOUNDARY_ADVANCED');
  if (sequence !== undefined) assert.equal(names.filter(name => /^scope-registration(?:-\d{3})?\.json$/.test(name)).length, sequence, 'PROVIDER_STOP_REGISTRY_ADVANCED');
}

async function decision(parent, parentReference, userApproval) {
  // This is the explicitly accepted 86 boundary, not a general switch for
  // ignoring future stops or extending the single already-created window.
  assert.equal(parent.version, 4, 'PROVIDER_STOP_PARENT_VERSION');
  assert.ok(inside(parent.environment_root, userApproval.path), 'PROVIDER_STOP_DECISION_OUTSIDE_OWNER');
  const value = await verified(userApproval);
  keys(value, ['version', 'kind', 'approved', 'source', 'user_message', 'recorded_at_utc', 'parent_authorization',
    'stopped_checkpoint', 'route_governance', 'retained_stop', 'accepted_history_reservations', 'approved_remaining_reservations',
    'total_reservation_ceiling', 'max_scheduled_episodes', 'continuation', 'model_window', 'future_stop_policy']);
  assert.equal(value.version, 1); assert.equal(value.kind, 'user-approved-provider-stop-continuation');
  assert.equal(value.approved, true, 'PROVIDER_STOP_EXPLICIT_DECISION_REQUIRED'); assert.equal(value.source, 'current-user-message');
  assert.ok(typeof value.user_message === 'string' && value.user_message.trim());
  assert.ok(Number.isFinite(Date.parse(value.recorded_at_utc)), 'PROVIDER_STOP_DECISION_TIMESTAMP');
  assert.deepEqual(value.parent_authorization, parentReference, 'PROVIDER_STOP_PARENT_CHANGED');
  assert.equal(value.accepted_history_reservations, 86); assert.equal(value.approved_remaining_reservations, 53);
  assert.equal(parent.history.scheduled_episodes, 80); assert.equal(parent.new_reservation_ceiling, 59);
  assert.equal(value.total_reservation_ceiling, 139); assert.equal(parent.total_reservation_ceiling, 139);
  assert.equal(value.max_scheduled_episodes, 144); assert.equal(parent.max_scheduled_episodes, 144);
  keys(value.continuation, ['allocation_id', 'experiment_id']);
  for (const name of Object.values(value.continuation)) assert.ok(safe(name), 'PROVIDER_STOP_NEW_OWNER_REQUIRED');
  assert.ok(!parent.allocations.some(item => item.id === value.continuation.allocation_id), 'PROVIDER_STOP_NEW_OWNER_REQUIRED');
  keys(value.retained_stop, ['run_id', 'source_plan', 'source_ledger']);
  assert.ok(safe(value.retained_stop.run_id));
  keys(value.model_window, ['start', 'end']);
  const { start, end } = parent.revision.model_window;
  assert.deepEqual(value.model_window, { start, end }, 'PROVIDER_STOP_WINDOW_CHANGED');
  assert.ok(Date.parse(value.recorded_at_utc) >= Date.parse(start) && Date.parse(value.recorded_at_utc) < Date.parse(end), 'PROVIDER_STOP_DECISION_OUTSIDE_WINDOW');
  assert.deepEqual(value.future_stop_policy, { core: 'stop', usage_unknown: 'stop', retry: false, renew_window: false }, 'PROVIDER_STOP_FUTURE_GUARDS_CHANGED');
  const checkpoint = await verified(value.stopped_checkpoint), execution = checkpoint.execution;
  assert.equal(checkpoint.kind, 'accepted-continuation-final-durable-checkpoint');
  assert.equal(execution.closed_physical_reservations, 86); assert.equal(execution.unresolved_physical_reservations, 0);
  assert.equal(execution.approved_total_ceiling, 139); assert.equal(execution.hard_limit, 144); assert.equal(execution.unallocated_headroom, 5);
  assert.deepEqual(execution.remaining_accepted_unstarted, { own: 11, code_mode: 24, scale_multiturn: 10, fault: 8, total: 53 });
  assert.deepEqual(execution.shared_new_window_already_used, { starts_at: start, ends_at: end, second_window_authorized: false });
  // Retain the actual route observation; its contents do not attest long-run
  // reliability or replace the model/runtime checks on every future episode.
  await verified(value.route_governance);
  return value;
}

export function assertProviderStopModels(protocol, authorized) {
  assert.equal(authorized.value.version, 5, 'PROVIDER_STOP_AUTHORITY_REQUIRED');
  assertSameConfirmationModels(protocol, authorized.confirmationContinuation.source, authorized.value.revision.model_window);
}

export async function assertProviderStopContinuation(protocol, execution, slots, amendment, authorized) {
  assertProviderStopModels(protocol, authorized);
  await assertSameConfirmationDesign(protocol, execution, slots, amendment, authorized.confirmationContinuation, authorized.value.revision.next_allocation_id);
  const transition = authorized.confirmationContinuation.transition;
  return [transition.scientific_source_plan, transition.source_plan];
}

/** The retained provider error has no reported model label. Preserve that
 * missing observation only for its exact invalid episode, never as a match. */
export function assertRetainedProviderStopEpisode(episode, model, plan, retained) {
  assert.equal(plan.plan_sha256, retained.source_plan_sha256, 'PROVIDER_STOP_PLAN_CHANGED');
  assert.equal(episode.identity.run_id, retained.run_id, 'PROVIDER_STOP_RUN_CHANGED');
  assert.equal(episode.episode_sha256, retained.episode_sha256, 'PROVIDER_STOP_EPISODE_CHANGED');
  const slot = plan.slots.find(item => item.slot_id === retained.source_slot_id); assert.ok(slot);
  const condition = plan.protocol.conditions.find(item => item.id === slot.condition_id);
  const environment = plan.protocol.environments.find(item => item.id === condition.environment_id);
  assert.equal(episode.identity.experiment_id, plan.id); assert.equal(episode.identity.case_id, slot.case_id);
  assert.equal(episode.identity.condition_id, slot.condition_id); assert.equal(episode.identity.model_id, model.id); assert.equal(condition.model_id, model.id);
  assert.equal(episode.identity.environment_sha256, environment.manifest_sha256); assert.equal(episode.identity.build_id, environment.build.id);
  assert.equal(episode.admission.status, 'invalid');
  assert.deepEqual(sorted(episode.admission.reasons), ['reported_model_unavailable_after_provider_error', 'runtime_not_a_business_episode:invalid']);
  for (const key of ['attempts', 'tools', 'interventions']) assert.equal(episode.admission.completeness[key], 'complete');
  assert.deepEqual(episode.identity.model_routing, model.routing);
  for (const [key, value] of [['model_route', model.route], ['model_api', model.api], ['model_provider', model.provider]]) assert.equal(episode.identity[key], value);
  assert.equal(episode.attempts.length, 1); const attempt = episode.attempts[0];
  assert.equal(attempt.sent, true); assert.equal(attempt.adapter.verified, true);
  const reported = attempt.reported_model;
  assert.equal(reported.status, 'missing'); assert.equal(reported.reason, 'reported_model_unavailable_after_provider_error');
  assert.equal(reported.provider_error, true); assert.equal(reported.label_kind, null);
  assert.deepEqual(reported.reported_ids, []); assert.deepEqual(reported.observations, []);
  assert.equal(episode.measurements.actual_attempts.status, 'known'); assert.equal(episode.measurements.actual_attempts.value, 1);
  for (const name of ['input_total', 'output_total']) assert.equal(episode.measurements[name].value.status, 'unknown');
  assert.equal(episode.timing.duration_ms.status, 'known');
}

/** Accept exactly the stopped six of the prior seventeen as immutable history.
 * The old stop/unknown stays invalid; only the eleven never-started slots move. */
export async function readProviderStopHistory({ parent: authorized, parentReference, userApproval, predecessor,
  planFiles, pilotLedgerRoot, expected, currentBoundary = false }) {
  const parent = authorized.value, approval = await decision(parent, parentReference, userApproval);
  assert.equal(pilotLedgerRoot, parent.pilot_ledger_root);
  if (currentBoundary) await boundary(pilotLedgerRoot);
  const scopes = await readRegisteredAllocationScopes(parent, parentReference, predecessor, { partialTerminal: true });
  assert.equal(scopes.length, 1, 'PROVIDER_STOP_SINGLE_PARTIAL_SCOPE');
  const partial = scopes[0], old = partial.plan, source = authorized.confirmationContinuation.source;
  assert.deepEqual(partial.allocation, parent.allocations[0], 'PROVIDER_STOP_ALLOCATION_CHANGED');
  assert.equal(partial.allocation.role, CONFIRMATION_CONTINUATION); assert.equal(partial.allocation.reservation_limit, 17);
  assert.equal(partial.completed.length, 6, 'PROVIDER_STOP_SIX_CLOSED_REQUIRED'); assert.equal(old.slots.length, 17);
  assert.equal(source.slots.length, 20); assert.deepEqual(declaredSchedule(old.protocol), source.slots, 'PROVIDER_STOP_SCIENTIFIC_DESIGN_CHANGED');
  assert.deepEqual(old.slots, source.slots.slice(3).map((slot, order) => ({ ...slot, order })), 'PROVIDER_STOP_SOURCE_SUFFIX_CHANGED');
  assert.deepEqual(partial.planReference, approval.retained_stop.source_plan, 'PROVIDER_STOP_SOURCE_PLAN_CHANGED');
  assert.deepEqual(partial.ledger.reference, approval.retained_stop.source_ledger, 'PROVIDER_STOP_SOURCE_LEDGER_CHANGED');
  assert.equal(partial.ledger.rows.at(-1).reason, 'subject_requested_stop', 'PROVIDER_STOP_CLOSED_STOP_REQUIRED');
  const terminal = partial.completed.at(-1), count = 86;
  assert.equal(terminal.run_id, approval.retained_stop.run_id); assert.equal(terminal.result.status, 'invalid'); assert.equal(terminal.result.stop_batch, true);
  assert.equal(terminal.result.budget_usage.model_requests, 1);
  for (const key of ['input_tokens', 'output_tokens']) assert.equal(terminal.result.budget_usage[key], null, 'PROVIDER_STOP_UNKNOWN_MUST_REMAIN');
  assert.deepEqual(sorted(planFiles), sorted([...parent.history.plans.map(item => item.plan.path), partial.planReference.path]), 'PROVIDER_STOP_PLAN_SET_CHANGED');
  const history = await readCampaignHistory({ planFiles, pilotLedgerRoot, ...(expected ? { expected } : {}),
    assertPlan: async plan => {
      assert.equal(plan.plan_sha256, fingerprint({ ...plan, plan_sha256: null })); assert.equal(validateProtocol(plan.protocol, { stage: 'execute' }).valid, true);
      const path = join(plan.execution.control_root, 'plan.json');
      if (path === partial.planReference.path) await verifyAuthorizedHistoryPlan(plan, partial.amendment, authorized, parentReference);
      else {
        const entry = parent.history.plans.find(item => item.plan.path === path); assert.ok(entry); assert.deepEqual((await file(path)).reference, entry.plan);
        if (plan.execution.campaign_scope) assertFiniteCampaignPlan(plan, await verified(plan.execution.campaign_scope.amendment));
      }
    },
    assertOriginalCompleted: async input => {
      if (input.ordinal <= 80) return;
      assert.equal(input.hasRevision, false, 'PROVIDER_STOP_SOURCE_REINTERPRETED');
      if (input.ordinal === count) { assert.equal(input.plan.plan_sha256, old.plan_sha256); assert.deepEqual(input.event, terminal); }
      else await verifyFiniteOriginalResults(input.plan, [input.event]);
    },
    assertModelEvidence: (episode, model, plan) => {
      if (episode.identity.run_id === terminal.run_id)
        assertRetainedProviderStopEpisode(episode, model, plan, { source_plan_sha256: old.plan_sha256,
          run_id: terminal.run_id, source_slot_id: terminal.slot_id, episode_sha256: terminal.result.episode_sha256 });
      else if (authorized.retainedAliasStop && episode.identity.run_id === authorized.retainedAliasStop.retained.run_id)
        assertRetainedAliasEpisode(episode, model, plan, authorized.retainedAliasStop.retained);
      else if (plan.protocol.policies.campaign || isProspectiveCohort(plan.protocol.policies.pilot.scope)) assertCohortModelEvidence(episode, model);
    } });
  assert.equal(history.scheduled_episodes, count);
  for (const key of ['episodes', 'reservations']) assert.deepEqual(history[key].slice(0, 80), parent.history[key], 'PROVIDER_STOP_PREFIX_CHANGED');
  for (const owner of parent.history.plans) assert.deepEqual(history.plans.find(item => item.plan.path === owner.plan.path), owner, 'PROVIDER_STOP_PREFIX_CHANGED');
  assert.deepEqual(partial.amendment.history, parent.history, 'PROVIDER_STOP_SCOPE_HISTORY_CHANGED');
  assert.deepEqual(partial.amendment.history_exemption, (await verified(parent.predecessor.amendment)).history_exemption);
  for (const [index, slot] of old.slots.slice(0, 6).entries()) {
    const item = history.reservations[80 + index], reservation = await verified(item.reference), observed = history.episodes[80 + index];
    assert.equal(item.ordinal, 81 + index); assert.equal(reservation.run_id, old.id + '-' + String(index + 1).padStart(3, '0'));
    assert.equal(reservation.slot_id, slot.slot_id); assert.equal(reservation.experiment_id, old.id);
    assert.equal(reservation.scope_id, partial.allocation.id); assert.equal(reservation.scope_role, CONFIRMATION_CONTINUATION);
    assert.equal(reservation.scope_kind, 'benchmark-finite-campaign'); assert.equal(reservation.scope_amendment_sha256, partial.amendment.amendment_sha256);
    assert.equal(reservation.plan_sha256, old.plan_sha256); assert.deepEqual(reservation.plan, partial.planReference);
    assert.equal(observed.analysis_revision, undefined); assert.equal(observed.collection_recovery, undefined);
    if (index < 5) { assert.equal(observed.core_evidence, 'complete'); assert.equal(observed.stop_batch, false, 'PROVIDER_STOP_EXTRA_STOP'); }
  }
  const observed = history.episodes.at(-1);
  assert.equal(observed.admission, 'invalid'); assert.equal(observed.stop_batch, true); assert.equal(observed.core_evidence, 'incomplete');
  assert.deepEqual(history.unknown_usage_run_ids, sorted([...parent.history.unknown_usage_run_ids, terminal.run_id]), 'PROVIDER_STOP_UNKNOWN_LIST_CHANGED');
  const { episode } = await readEvidenceBundle({ directory: terminal.result.normalized_directory, rawRoot: parent.environment_root });
  const artifact = episode.artifacts.find(item => item.id === 'collection-runtime-result'); assert.ok(artifact, 'PROVIDER_STOP_RUNTIME_REQUIRED');
  const runtime = await verified(clean(artifact));
  assert.equal(runtime.status, 'invalid'); assert.equal(runtime.error?.code, 'BENCHMARK_REPORTED_MODEL_UNAVAILABLE_AFTER_PROVIDER_ERROR', 'PROVIDER_STOP_PROVIDER_FAILURE_REQUIRED');
  assert.equal(runtime.budget.usage_unknown, true); assert.equal(runtime.budget.requests, 1); assert.equal(runtime.budget.attempts, 1);
  assert.equal(episode.measurements.actual_attempts.status, 'known'); assert.equal(episode.measurements.actual_attempts.value, 1);
  for (const [key, measurement] of [['input_tokens', 'input_total'], ['output_tokens', 'output_total']]) {
    assert.equal(episode.measurements[measurement].value.status, 'unknown');
    assert.equal(runtime.budget[key], episode.measurements[measurement].known_subtotal, 'PROVIDER_STOP_PARTIAL_USAGE_CHANGED');
  }
  assert.ok(known(terminal.result.budget_usage.duration_ms));
  const retained = { source_plan: partial.planReference, source_ledger: partial.ledger.reference, reservation: history.reservations.at(-1).reference,
    episode: (await file(join(observed.directory, 'episode.json'))).reference, episode_sha256: episode.episode_sha256,
    runtime_result: clean(artifact), run_id: terminal.run_id, ordinal: count, source_slot_id: terminal.slot_id, allocation_id: partial.allocation.id };
  const selection = { source_plan_sha256: old.plan_sha256, slot_ids: old.slots.slice(6).map(slot => slot.slot_id) };
  const transition = { source_allocation_id: partial.allocation.id, experiment_id: approval.continuation.experiment_id,
    original_limit: 20, source_limit: 17, source_spent: 6, spent: 9, remaining: 11,
    source_plan: partial.planReference, source_plan_sha256: old.plan_sha256, scientific_source_plan: authorized.confirmationContinuation.transition.source_plan,
    excluded_slot_ids: source.slots.slice(0, 9).map(slot => slot.slot_id), selection };
  assert.ok(!history.episodes.some(item => item.experiment_id === transition.experiment_id), 'PROVIDER_STOP_NEW_EXPERIMENT_REQUIRED');
  assert.notEqual(transition.experiment_id, old.id); assert.notEqual(transition.experiment_id, source.id);
  const allocations = [{ id: approval.continuation.allocation_id, work_index: partial.allocation.work_index,
    role: CONFIRMATION_CONTINUATION, reservation_limit: 11 }, ...structuredClone(parent.allocations.slice(1))];
  assert.equal(allocations.reduce((sum, item) => sum + item.reservation_limit, 0), 53);
  if (currentBoundary) await boundary(pilotLedgerRoot, partial.registration.sequence);
  return { history, allocations, retained, transition, source, modelWindow: structuredClone(parent.revision.model_window), decision: approval };
}
