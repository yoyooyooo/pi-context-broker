import assert from 'node:assert/strict';

export const FINITE = 'benchmark-finite-campaign';
export const PROSPECTIVE = 'benchmark-prospective-cohort';
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const known = value => value?.status === 'known' ? value.value : null;

// Authoritative private readers validate the source contract first. These small
// projections are shared with offline replay; they never read files or run code.
export function publicationScope(plan) {
  const finite = plan.protocol.policies.campaign, execution = plan.execution.campaign_scope;
  if (finite || execution) {
    assert.equal(finite?.kind, FINITE); assert.equal(execution?.kind, FINITE);
    assert.equal(plan.protocol.policies.pilot?.scope, undefined); assert.equal(plan.execution.pilot_scope, undefined);
    assert.equal(finite.role, execution.role); assert.equal(finite.id, execution.id);
    assert.ok(['route_gate_only', 'acceptance'].includes(execution.role));
    assert.ok(['pilot', 'confirmation'].includes(plan.protocol.phase));
    return { kind: FINITE, registration: execution };
  }
  assert.equal(plan.protocol.policies.pilot?.scope?.kind, PROSPECTIVE);
  assert.ok(plan.execution.pilot_scope); assert.equal(plan.protocol.phase, 'pilot');
  assert.ok(['gate', 'expansion'].includes(plan.execution.pilot_scope.role));
  return { kind: PROSPECTIVE, registration: plan.execution.pilot_scope };
}

export function projectScopeAmendment({ plan, amendment, reference }) {
  const contract = publicationScope(plan);
  assert.equal(amendment.kind, contract.kind); assert.equal(amendment.id, contract.registration.id);
  const common = { id: amendment.id, source_sha256: reference.sha256, amendment_sha256: amendment.amendment_sha256,
    source_kind: contract.kind, reservation_limit: amendment.reservation_limit, history_exemption: amendment.history_exemption,
    history_reservations: amendment.history.reservations.map(row => ({ ordinal: row.ordinal, source_sha256: row.reference.sha256 })) };
  if (contract.kind === FINITE) return { kind: 'public-finite-campaign-amendment', ...common,
    role: contract.registration.role, model_count: amendment.model_conditions.length,
    plan: { experiment_id: plan.id, phase: plan.protocol.phase, purpose: plan.protocol.purpose,
      scheduled_episodes: amendment.plan.scheduled_episodes, slots: plan.slots,
      source_protocol_sha256: amendment.plan.protocol_sha256, source_execution_sha256: amendment.plan.execution_sha256,
      source_slots_sha256: amendment.plan.slots_sha256 },
    private_verification: 'readFiniteCampaignAmendment + assertFiniteCampaignPlan; failed or incomplete current results are retained without execution admission' };
  return { kind: 'public-cohort-amendment', ...common, model_count: amendment.model_count,
    gate: { experiment_id: amendment.gate.experiment_id, case_ids: amendment.gate.case_ids, scheduled_episodes: amendment.gate.scheduled_episodes },
    expansion: { experiment_id: amendment.expansion.experiment_id, case_ids: amendment.expansion.case_ids, scheduled_episodes: amendment.expansion.scheduled_episodes },
    private_verification: 'readPilotScopeAmendment + assertScopePlan; not a claim that a failed current gate passed' };
}

export function scopePhases(scope) {
  if (scope.kind === 'public-finite-campaign-amendment') {
    assert.equal(scope.source_kind, FINITE); assert.ok(['route_gate_only', 'acceptance'].includes(scope.role));
    assert.ok(['pilot', 'confirmation'].includes(scope.plan.phase));
    assert.ok(Number.isSafeInteger(scope.reservation_limit) && scope.reservation_limit > 0 && scope.history_reservations.length + scope.reservation_limit <= 144);
    assert.equal(scope.reservation_limit, scope.plan.scheduled_episodes);
    assert.equal(scope.plan.slots.length, scope.plan.scheduled_episodes);
    assert.ok(typeof scope.plan.purpose === 'string' && scope.plan.purpose.length);
    if (scope.role === 'route_gate_only') {
      assert.equal(scope.plan.phase, 'pilot'); assert.equal(scope.plan.purpose, 'native_calibration');
      assert.equal(scope.reservation_limit, 8); assert.equal(scope.model_count, 1);
    }
    return [{ role: scope.role, ...scope.plan }];
  }
  assert.equal(scope.kind, 'public-cohort-amendment');
  assert.equal(scope.reservation_limit, scope.gate.scheduled_episodes + scope.expansion.scheduled_episodes);
  return ['gate', 'expansion'].map(role => ({ role, phase: 'pilot', ...scope[role] }));
}

export function bindDescriptorScope(descriptor, input, scope) {
  assert.ok(scope, 'Owning scope projection is missing');
  assert.equal(descriptor.scope_id, scope.id);
  assert.equal(descriptor.scope_kind, scope.source_kind);
  assert.equal(descriptor.source_amendment_file_sha256, scope.source_sha256);
  assert.equal(descriptor.scope_amendment_sha256, scope.amendment_sha256);
  assert.equal(descriptor.phase, input.protocol.phase); assert.equal(descriptor.purpose, input.protocol.purpose);
  const phases = scopePhases(scope), declared = phases.find(value => value.role === descriptor.role);
  assert.ok(declared); assert.equal(descriptor.experiment_id, declared.experiment_id);
  assert.equal(descriptor.phase, declared.phase); assert.equal(descriptor.slots.length, declared.scheduled_episodes);
  if (scope.kind === 'public-finite-campaign-amendment') {
    assert.equal(descriptor.purpose, declared.purpose);
    assert.equal(scope.model_count, input.protocol.models.length);
    if (scope.role === 'route_gate_only') {
      const cases = [...new Set(descriptor.slots.map(row => row.case_id))], conditions = [...new Set(descriptor.slots.map(row => row.condition_id))];
      assert.equal(cases.length, 4); assert.equal(conditions.length, 2);
      for (const id of cases) assert.deepEqual(descriptor.slots.filter(row => row.case_id === id).map(row => row.condition_id).sort(), [...conditions].sort());
    }
    assert.equal(descriptor.source_protocol_sha256, declared.source_protocol_sha256);
    assert.deepEqual(descriptor.slots, declared.slots, 'Finite plan cannot reorder its public slot projection');
  }
  return declared;
}

export function episodeAccounting(episode) {
  const m = episode.measurements;
  return { model_requests: known(m.actual_attempts), input_tokens: known(m.input_total.value),
    output_tokens: known(m.output_total.value), duration_ms: known(episode.timing.duration_ms),
    known_model_requests: m.known_actual_attempts, known_input_tokens: m.input_total.known_subtotal,
    known_output_tokens: m.output_total.known_subtotal };
}
const coreAdmission = episode => ({ status: episode.admission.status,
  completeness: Object.fromEntries(['attempts', 'tools', 'interventions'].map(key => [key, episode.admission.completeness[key]])) });
export function projectFiniteOriginal({ original, originalEpisode, effective, effectiveEpisode }) {
  assert.equal(original.run_id, effective.run_id); assert.equal(original.slot_id, effective.slot_id);
  assert.equal(original.result.episode_sha256, originalEpisode.episode_sha256);
  assert.equal(effective.result.episode_sha256, effectiveEpisode.episode_sha256);
  const before = episodeAccounting(originalEpisode), after = episodeAccounting(effectiveEpisode);
  const budget = ({ model_requests, input_tokens, output_tokens, duration_ms }) => ({ model_requests, input_tokens, output_tokens, duration_ms });
  assert.deepEqual(original.result.budget_usage, budget(before), 'Original controller usage disagrees with retained evidence');
  assert.deepEqual(effective.result.budget_usage, budget(after), 'Effective controller usage disagrees with retained evidence');
  assert.deepEqual(before, after, 'Finite analysis revision cannot replace original physical usage');
  assert.deepEqual(coreAdmission(originalEpisode), coreAdmission(effectiveEpisode), 'Finite analysis revision cannot replace original core admission');
  assert.equal(original.result.stop_batch, effective.result.stop_batch, 'Finite analysis revision cannot erase original stop');
  assert.equal(original.result.stop_reason ?? null, effective.result.stop_reason ?? null, 'Finite analysis revision cannot change original stop reason');
  return { source_episode_sha256: original.result.episode_sha256, core: coreAdmission(originalEpisode), accounting: before,
    stop_batch: Boolean(original.result.stop_batch), stop_reason: original.result.stop_reason ?? null,
    source_availability: 'retained_original_and_raw_verified' };
}

export function verifyFiniteOriginalProjection(completion, episode) {
  const original = completion.original_observation; assert.ok(original, 'Finite original observation projection is missing');
  assert.ok(digest(original.source_episode_sha256)); assert.equal(original.source_availability, 'retained_original_and_raw_verified');
  assert.deepEqual(original.accounting, episodeAccounting(episode), 'Finite public usage differs from original observation');
  assert.deepEqual(original.core, coreAdmission(episode), 'Finite public core differs from original observation');
  assert.equal(completion.stop_batch, original.stop_batch); assert.equal(completion.stop_reason, original.stop_reason);
  assert.equal(completion.original_episode_sha256 ?? completion.episode_sha256, original.source_episode_sha256);
}

export function projectBudgetDecision({ value, reference, routeIntent, routeIntentReference }) {
  assert.equal(value.version, 1); assert.equal(value.kind, 'benchmark-finite-budget-decision-draft');
  assert.equal(value.status, 'prospective_allocation_not_registered_not_realized');
  assert.equal(value.superseded_unfrozen_proposals.intent.sha256, routeIntentReference.sha256);
  assert.equal(value.superseded_unfrozen_proposals.intent.path, routeIntentReference.path);
  assert.equal(value.shared_cap, 144); assert.equal(value.historical_prefix_reservations, routeIntent.existing_reservations);
  const result = { kind: 'public-finite-campaign-budget-intent', source_sha256: reference.sha256,
    route_intent_source_sha256: routeIntentReference.sha256, source_status: value.status,
    historical_prefix_reservations: value.historical_prefix_reservations, shared_cap: value.shared_cap,
    original_unknown_run_ids: value.original_unknown_run_ids,
    total_projected_cumulative: value.total_projected_cumulative, unallocated_reservations: value.unallocated_reservations,
    allocations: value.allocations.map(({ id, episodes, status, design, scope_id, setup }) =>
      ({ id, episodes, status, ...(design ? { design } : {}), ...(scope_id ? { scope_id } : {}),
        ...(setup ? { source_setup_sha256: setup.sha256, setup_evidence: 'draft_only_not_a_registered_plan' } : {}) })),
    own_version_confirmation: value.own_version_confirmation ? Object.fromEntries(['phase', 'purpose', 'reference', 'candidate', 'no_winner_selection',
      'preselected_source_tuple_is_not_new_result', 'own_version_subset_episodes_in_twenty', 'additional_own_version_episodes', 'candidate_provenance_limit']
      .filter(key => value.own_version_confirmation[key] !== undefined).map(key => [key, value.own_version_confirmation[key]])) : null,
    stable_public_anchor: value.stable_public_anchor, known_product_limit: value.known_product_limit,
    acceptance_claim_limits: value.acceptance_claim_limits,
    statement: 'Prospective design only. Actual registration, phase, purpose, coverage and counts come from each retained plan and the complete shared reservation inventory.' };
  verifyBudgetProjection(result, routeIntentReference.sha256);
  return result;
}
export function verifyBudgetProjection(value, routeIntentSha) {
  assert.equal(value.kind, 'public-finite-campaign-budget-intent'); assert.ok(digest(value.source_sha256));
  assert.equal(value.route_intent_source_sha256, routeIntentSha); assert.equal(value.source_status, 'prospective_allocation_not_registered_not_realized');
  assert.equal(value.shared_cap, 144); assert.ok(Number.isSafeInteger(value.historical_prefix_reservations));
  assert.equal(new Set(value.allocations.map(row => row.id)).size, value.allocations.length);
  assert.ok(value.allocations.every(row => Number.isSafeInteger(row.episodes) && row.episodes >= 0 && typeof row.status === 'string'));
  assert.equal(value.total_projected_cumulative, value.historical_prefix_reservations + value.allocations.reduce((n, row) => n + row.episodes, 0));
  assert.equal(value.unallocated_reservations, 144 - value.total_projected_cumulative);
  assert.ok(value.unallocated_reservations >= 0);
}
