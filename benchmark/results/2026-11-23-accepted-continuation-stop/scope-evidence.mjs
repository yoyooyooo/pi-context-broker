import assert from 'node:assert/strict';

export const FINITE = 'benchmark-finite-campaign';
export const PROSPECTIVE = 'benchmark-prospective-cohort';
export const FOLLOWUP = 'unstarted_followup';
export const ORIGINAL_COLLECTOR = Object.freeze({ version: '1.1.0',
  source_sha256: '3e55859024ccfb009853b18f412f515ee712dbc19ea5a5925110c99d58681d15' });
export function assertOriginalCollector(episodes) {
  for (const episode of episodes) {
    assert.equal(episode.identity.collector_version, ORIGINAL_COLLECTOR.version, 'Primary publication keeps collector1.1 observations');
    assert.equal(episode.identity.collector_source_sha256, ORIGINAL_COLLECTOR.source_sha256, 'Primary collector source changed');
  }
}
export const ACCEPTED_HISTORY_IDENTITY = Object.freeze({
  source_sha256: 'bfb9a3973d50623ef168fb6a2f9c1962eec035de06f4fcca6f29034d186d55b9',
  authorization_sha256: '929cd314e0bd63daf240991c60049e52412f30c29c41eeb14d697857a8d5ab59',
  history_checkpoint_sha256: '44942a05680966e0fdaf4939c76b2d450477bdc97cde32726b9207ef06c1c3a0',
});
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const known = value => value?.status === 'known' ? value.value : null;
const sameKeys = (value, expected, message) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), message);
const unit = slot => JSON.stringify([slot.condition_id, slot.case_id, slot.repeat ?? 0]);

// Authoritative private readers validate the source contract first. These small
// projections are shared with offline replay; they never read files or run code.
export function publicationScope(plan) {
  const finite = plan.protocol.policies.campaign, execution = plan.execution.campaign_scope;
  if (finite || execution) {
    assert.equal(finite?.kind, FINITE); assert.equal(execution?.kind, FINITE);
    assert.equal(plan.protocol.policies.pilot?.scope, undefined); assert.equal(plan.execution.pilot_scope, undefined);
    assert.equal(finite.role, execution.role); assert.equal(finite.id, execution.id);
    assert.ok(['route_gate_only', 'acceptance', FOLLOWUP].includes(execution.role));
    assert.ok(['pilot', 'confirmation'].includes(plan.protocol.phase));
    return { kind: FINITE, registration: execution };
  }
  assert.equal(plan.protocol.policies.pilot?.scope?.kind, PROSPECTIVE);
  assert.ok(plan.execution.pilot_scope); assert.equal(plan.protocol.phase, 'pilot');
  assert.ok(['gate', 'expansion'].includes(plan.execution.pilot_scope.role));
  return { kind: PROSPECTIVE, registration: plan.execution.pilot_scope };
}

export function projectScopeAmendment({ plan, amendment, reference, analysisPlan }) {
  const contract = publicationScope(plan);
  assert.equal(amendment.kind, contract.kind); assert.equal(amendment.id, contract.registration.id);
  const common = { id: amendment.id, source_sha256: reference.sha256, amendment_sha256: amendment.amendment_sha256,
    source_kind: contract.kind, reservation_limit: amendment.reservation_limit, history_exemption: amendment.history_exemption,
    history_reservations: amendment.history.reservations.map(row => ({ ordinal: row.ordinal, source_sha256: row.reference.sha256 })) };
  if (contract.kind === FINITE) return { kind: 'public-finite-campaign-amendment', ...common,
    role: contract.registration.role, model_count: amendment.model_conditions.length,
    plan: { experiment_id: plan.id, phase: plan.protocol.phase, purpose: plan.protocol.purpose,
      scheduled_episodes: amendment.plan.scheduled_episodes, slots: plan.slots,
      ...(contract.registration.role === FOLLOWUP ? { selection: structuredClone(amendment.selection),
        scientific_slots: structuredClone(analysisPlan.slots) } : {}),
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
    assert.equal(scope.source_kind, FINITE); assert.ok(['route_gate_only', 'acceptance', FOLLOWUP].includes(scope.role));
    assert.ok(['pilot', 'confirmation'].includes(scope.plan.phase));
    assert.ok(Number.isSafeInteger(scope.reservation_limit) && scope.reservation_limit > 0 && scope.history_reservations.length + scope.reservation_limit <= 144);
    assert.equal(scope.reservation_limit, scope.plan.scheduled_episodes);
    assert.equal(scope.plan.slots.length, scope.plan.scheduled_episodes);
    assert.ok(typeof scope.plan.purpose === 'string' && scope.plan.purpose.length);
    if (scope.role === 'route_gate_only') {
      assert.equal(scope.plan.phase, 'pilot'); assert.equal(scope.plan.purpose, 'native_calibration');
      assert.equal(scope.reservation_limit, 8); assert.equal(scope.model_count, 1);
    }
    if (scope.role === FOLLOWUP) {
      assert.equal(scope.plan.phase, 'pilot');
      const selection = scope.plan.selection;
      sameKeys(selection, ['source_plan_sha256', 'slot_ids'], 'Followup selection shape');
      assert.ok(digest(selection.source_plan_sha256));
      assert.deepEqual(selection.slot_ids, scope.plan.slots.map(slot => slot.slot_id), 'Followup selected slot order changed');
      assert.equal(new Set(selection.slot_ids).size, selection.slot_ids.length);
      assert.ok(Array.isArray(scope.plan.scientific_slots) && scope.plan.scientific_slots.length > scope.plan.slots.length,
        'Followup retains the larger original scientific denominator');
      const scientific = scope.plan.scientific_slots.map(unit);
      assert.equal(new Set(scientific).size, scientific.length);
      assert.ok(scope.plan.slots.every(slot => scientific.includes(unit(slot))), 'Followup selection outside scientific plan');
    } else {
      assert.equal(scope.plan.selection, undefined); assert.equal(scope.plan.scientific_slots, undefined);
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
    if (scope.role === FOLLOWUP) {
      assert.deepEqual(input.protocol.policies.campaign.selection, declared.selection, 'Followup source selection changed');
      assert.equal(input.protocol.policies.campaign.role, FOLLOWUP);
      assert.deepEqual(descriptor.analysis_slots, declared.scientific_slots, 'Followup scientific slot projection changed');
    }
  }
  return declared;
}

export function historyCore(episode) {
  const usage = episodeAccounting(episode);
  assert.ok(Array.isArray(episode.attempts), 'Original attempts are required for core projection');
  return episode.admission.status === 'valid'
    && ['attempts', 'tools', 'interventions'].every(key => episode.admission.completeness[key] === 'complete')
    && [usage.model_requests, usage.input_tokens, usage.output_tokens, usage.duration_ms].every(Number.isFinite)
    && usage.model_requests > 0 && episode.attempts.filter(attempt => attempt.sent).every(attempt => attempt.adapter.verified)
    ? 'complete' : 'incomplete';
}

// Called only after the private readApprovedCampaign reader has verified this exact source.
// The public copy verifies the resulting projection; it cannot reauthenticate private originals.
export function projectAcceptedHistory({ verified, reference, reservations }) {
  const value = verified.value;
  assert.equal(value.version, 3); assert.equal(value.revision.kind, 'accepted-history-extension');
  assert.equal(reference.sha256, ACCEPTED_HISTORY_IDENTITY.source_sha256);
  assert.equal(value.authorization_sha256, ACCEPTED_HISTORY_IDENTITY.authorization_sha256);
  assert.equal(value.history_checkpoint_sha256, ACCEPTED_HISTORY_IDENTITY.history_checkpoint_sha256);
  assert.equal(value.history.scheduled_episodes, 66); assert.equal(value.max_scheduled_episodes, 144);
  assert.equal(value.total_reservation_ceiling, 139); assert.equal(value.new_reservation_ceiling, 73);
  assert.equal(value.history.episodes.length, 66); assert.equal(value.history.reservations.length, 66);
  const episodes = value.history.episodes.map((episode, index) => {
    const reservation = reservations[index], source = value.history.reservations[index];
    assert.equal(source.ordinal, index + 1); assert.equal(episode.pilot_ordinal, index + 1);
    assert.equal(reservation?.ordinal, index + 1); assert.equal(reservation.source_sha256, source.reference.sha256);
    assert.equal(reservation.receipt.run_id, episode.run_id); assert.equal(reservation.receipt.experiment_id, episode.experiment_id);
    return { ordinal: index + 1, run_id: episode.run_id, experiment_id: episode.experiment_id,
      slot_id: reservation.receipt.slot_id, reservation_source_sha256: source.reference.sha256,
      source_episode_sha256: episode.episode_sha256, admission: episode.admission,
      budget_usage: structuredClone(episode.budget_usage), core_evidence: episode.core_evidence, stop_batch: episode.stop_batch };
  });
  const stop = value.revision.retained_stop;
  return { version: 1, kind: 'public-accepted-campaign-history', ...ACCEPTED_HISTORY_IDENTITY,
    scheduled_episodes: 66, original_linked_history: 13, maximum_scheduled_episodes: 144,
    total_reservation_ceiling: 139, remaining_reservation_ceiling: 73,
    parent_authorization_source_sha256: value.revision.parent_authorization.sha256,
    user_approval_source_sha256: value.revision.user_approval.sha256,
    episodes, unknown_usage_run_ids: [...value.history.unknown_usage_run_ids],
    retained_stop_run_ids: episodes.filter(row => row.stop_batch).map(row => row.run_id),
    retained_stop: { ordinal: stop.ordinal, run_id: stop.run_id, source_slot_id: stop.source_slot_id, allocation_id: stop.allocation_id,
      source_plan_sha256: stop.source_plan.sha256, source_ledger_sha256: stop.source_ledger.sha256,
      reservation_source_sha256: stop.reservation.sha256, episode_file_sha256: stop.episode.sha256,
      episode_sha256: stop.episode_sha256, runtime_result_sha256: stop.runtime_result.sha256 },
    verification_scope: 'Exact authority3 verified privately with original evidence; public replay compares bound66 projections. Linked original13 snapshots do not expose core or stop fields. No later stop is accepted.' };
}

export function verifyAcceptedHistoryProjection(accepted, rows, reservations, prefix) {
  sameKeys(accepted, ['version', 'kind', ...Object.keys(ACCEPTED_HISTORY_IDENTITY), 'scheduled_episodes', 'original_linked_history',
    'maximum_scheduled_episodes', 'total_reservation_ceiling', 'remaining_reservation_ceiling',
    'parent_authorization_source_sha256', 'user_approval_source_sha256', 'episodes', 'unknown_usage_run_ids',
    'retained_stop_run_ids', 'retained_stop', 'verification_scope'], 'Accepted history shape');
  assert.equal(accepted.version, 1); assert.equal(accepted.kind, 'public-accepted-campaign-history');
  for (const [key, value] of Object.entries(ACCEPTED_HISTORY_IDENTITY)) assert.equal(accepted[key], value, 'Wrong accepted authority identity');
  assert.equal(prefix, 13); assert.equal(accepted.original_linked_history, prefix);
  assert.equal(accepted.scheduled_episodes, 66); assert.equal(accepted.episodes.length, 66);
  assert.equal(accepted.maximum_scheduled_episodes, 144); assert.equal(accepted.total_reservation_ceiling, 139);
  assert.equal(accepted.remaining_reservation_ceiling, 73); assert.ok(rows.length >= 66 && rows.length <= 139);
  assert.equal(accepted.parent_authorization_source_sha256, '58866ae25dfa7575f2027051a845a4c4228a471c05ad4cabf354fe1e1112d357');
  assert.equal(accepted.user_approval_source_sha256, 'a909b5a0ac8f2157bf28b30aa6e4047d580fdaa973c83c19b3954cd6e7285aa9');
  const unknown = [];
  for (const [index, expected] of accepted.episodes.entries()) {
    sameKeys(expected, ['ordinal', 'run_id', 'experiment_id', 'slot_id', 'reservation_source_sha256',
      'source_episode_sha256', 'admission', 'budget_usage', 'core_evidence', 'stop_batch'], 'Accepted episode shape');
    assert.equal(expected.ordinal, index + 1); assert.ok(digest(expected.source_episode_sha256));
    assert.ok(['complete', 'incomplete'].includes(expected.core_evidence)); assert.equal(typeof expected.stop_batch, 'boolean');
    const actual = rows[index];
    for (const key of ['ordinal', 'run_id', 'experiment_id', 'slot_id', 'reservation_source_sha256',
      'source_episode_sha256', 'admission']) assert.deepEqual(actual[key], expected[key], 'Accepted history changed: ' + key);
    assert.equal(reservations[index].source_sha256, expected.reservation_source_sha256);
    sameKeys(expected.budget_usage, ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms'], 'Accepted usage shape');
    for (const [source, target] of [['model_requests', 'actual_model_http_requests'], ['input_tokens', 'complete_input_tokens'],
      ['output_tokens', 'complete_output_tokens'], ['duration_ms', 'duration_ms']]) {
      assert.ok(expected.budget_usage[source] === null || Number.isFinite(expected.budget_usage[source]) && expected.budget_usage[source] >= 0);
      assert.equal(actual[target], expected.budget_usage[source], 'Accepted history usage changed');
    }
    if (Object.values(expected.budget_usage).some(value => value === null)) unknown.push(expected.run_id);
    if (index >= prefix) {
      assert.equal(actual.state, 'completed', 'Accepted history cannot be unresolved');
      assert.equal(actual.stop_batch, expected.stop_batch, 'Accepted history stop changed');
      assert.equal(actual.core_evidence, expected.core_evidence, 'Accepted history core changed');
    }
  }
  assert.equal(unknown.length, 5);
  assert.deepEqual([...accepted.unknown_usage_run_ids].sort(), unknown.sort(), 'Accepted unknown list changed');
  assert.deepEqual(accepted.retained_stop_run_ids, accepted.episodes.filter(row => row.stop_batch).map(row => row.run_id), 'Accepted stop list changed');
  const stop = accepted.retained_stop, terminal = accepted.episodes.at(-1), actual = rows[65];
  sameKeys(stop, ['ordinal', 'run_id', 'source_slot_id', 'allocation_id', 'source_plan_sha256', 'source_ledger_sha256',
    'reservation_source_sha256', 'episode_file_sha256', 'episode_sha256', 'runtime_result_sha256'], 'Accepted terminal stop shape');
  assert.equal(stop.ordinal, 66); assert.equal(stop.run_id, terminal.run_id); assert.equal(stop.source_slot_id, terminal.slot_id);
  assert.equal(stop.episode_sha256, terminal.source_episode_sha256); assert.equal(stop.reservation_source_sha256, terminal.reservation_source_sha256);
  assert.equal(actual.scope_id, stop.allocation_id); assert.equal(terminal.stop_batch, true); assert.equal(terminal.admission, 'invalid');
  assert.equal(terminal.budget_usage.model_requests, 2); assert.equal(terminal.budget_usage.input_tokens, null); assert.equal(terminal.budget_usage.output_tokens, null);
  for (const [key, value] of Object.entries({
    source_plan_sha256: '413d6a7f4a09360563bac4fc27ccccf1441dbc052bc01b90c6255be3adb72c8e',
    source_ledger_sha256: 'aa279d9f43aa6b60e56e53c8e555c876ae5a32e63671e259a8d5d4f0c85417ed',
    reservation_source_sha256: 'fb2200c7e900ef49095610e108d7f3d8b707950c481d3fcd41f343f88430238d',
    episode_file_sha256: '9889f926f6b6f3da9b26dabd037e229d6ef33dcd36e614c2b47372892824c4eb',
    episode_sha256: '51d389cf5f23b1a135f0e9f464b76feafe7d8e5186c10d4764bb57873f2ccf6c',
    runtime_result_sha256: '720b47bfac0052079be5233e919fea6728c4e214887174632962ff1eaa5113b7',
  })) assert.equal(stop[key], value, 'Wrong accepted terminal source: ' + key);
  assert.equal(actual.source_plan_file_sha256, stop.source_plan_sha256);
  assert.equal(actual.source_ledger_sha256, stop.source_ledger_sha256);
  assert.equal(actual.original_observation?.source_episode_sha256, stop.episode_sha256);
  return new Set(accepted.episodes.map(row => row.ordinal));
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
