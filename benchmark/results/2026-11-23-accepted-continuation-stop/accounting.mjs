import assert from 'node:assert/strict';
import { FINITE, FOLLOWUP, bindDescriptorScope, scopePhases, verifyBudgetProjection, verifyFiniteOriginalProjection,
  historyCore, verifyAcceptedHistoryProjection } from './scope-evidence.mjs';
const unit = slot => JSON.stringify([slot.condition_id, slot.case_id, slot.repeat ?? 0]);

export function summarizeUsage(rows) {
  const subtotal = key => Number(rows.reduce((n, row) => n + (typeof row[key] === 'number' ? row[key] : 0), 0).toFixed(6));
  const complete = key => rows.every(row => typeof row[key] === 'number') ? subtotal(key) : null;
  return { reserved_episodes: rows.length,
    episodes_with_observed_model_send_lower_bound: rows.filter(row => row.known_model_http_requests > 0).length,
    known_model_http_requests: subtotal('known_model_http_requests'), actual_model_http_requests: complete('actual_model_http_requests'),
    known_input_subtotal: subtotal('known_input_subtotal'), complete_input_tokens: complete('complete_input_tokens'),
    known_output_subtotal: subtotal('known_output_subtotal'), complete_output_tokens: complete('complete_output_tokens'),
    complete_currency_cost: null, currency_cost_status: rows.some(row => row.currency_cost === null) ? 'incomplete_or_unpriced' : 'not_aggregated_without_verified_common_currency',
    unknown_usage_run_ids: rows.filter(row => [row.actual_model_http_requests, row.complete_input_tokens, row.complete_output_tokens, row.duration_ms].includes(null)).map(row => row.run_id),
    summed_observed_episode_duration_ms: complete('duration_ms') };
}

// Pure projection shared by private assembly and the independent public replay.
export function deriveReleaseEvidence({ history, groups, reservations, intent, scopes = [], acceptedHistory = null }) {
  const known = fact => fact?.status === 'known' ? fact.value : null;
  const historic = history.accounting.episodes, prefix = historic.length;
  assert.equal(history.manifest.reservations.length, prefix);
  assert.equal(history.accounting.shared_campaign.reserved_episodes, prefix);
  assert.equal(new Set(historic.map(row => row.run_id)).size, prefix);
  assert.equal(new Set(reservations.map(item => item.receipt.run_id)).size, reservations.length, 'Duplicate physical reservation');
  assert.ok(reservations.length >= prefix && reservations.length <= 144);
  const historicalSummary = summarizeUsage(historic);
  for (const key of ['reserved_episodes', 'known_model_http_requests', 'actual_model_http_requests', 'known_input_subtotal',
    'complete_input_tokens', 'known_output_subtotal', 'complete_output_tokens', 'unknown_usage_run_ids'])
    assert.deepEqual(historicalSummary[key], history.accounting.shared_campaign[key], 'Historical accounting changed: ' + key);
  const amendments = scopes.filter(scope => ['public-cohort-amendment', 'public-finite-campaign-amendment'].includes(scope.kind));
  assert.equal(new Set(amendments.map(scope => scope.id)).size, amendments.length, 'Duplicate scope projection');
  assert.ok(scopes.every(scope => ['public-cohort-amendment', 'public-finite-campaign-amendment', 'public-cohort-gate', 'public-finite-route-gate'].includes(scope.kind)), 'Unknown public scope kind');
  const groupIds = new Set(), phaseIds = new Set(), physical = new Map(), perPlan = [], cases = [];
  for (const group of groups) {
    const { descriptor: d, input, analysis, manifest } = group;
    const scope = amendments.find(item => item.id === d.scope_id); bindDescriptorScope(d, input, scope);
    assert.ok(!groupIds.has(d.experiment_id), 'Duplicate owning plan'); groupIds.add(d.experiment_id);
    const phaseId = JSON.stringify([d.scope_id, d.role]); assert.ok(!phaseIds.has(phaseId), 'Only one actual plan per cohort phase'); phaseIds.add(phaseId);
    assert.equal(input.protocol.id, d.experiment_id); assert.equal(input.protocol.protocol_sha256, manifest.public_protocol_sha256);
    assert.equal(analysis.analysis_sha256, manifest.public_analysis_sha256);
    assert.equal(input.episodes.length, manifest.source_episode_sha256.length);
    const scientific = d.analysis_slots ?? d.slots;
    assert.equal(analysis.completeness.planned_slots, scientific.length, 'Scientific denominator changed');
    assert.equal(new Set(scientific.map(unit)).size, scientific.length, 'Duplicate scientific slot');
    assert.ok(d.slots.every(slot => scientific.some(item => unit(item) === unit(slot))), 'Selected slot outside scientific plan');
    if (d.role !== FOLLOWUP) assert.equal(scientific.length, d.slots.length);
    assert.equal(new Set(d.slots.map(slot => slot.slot_id)).size, d.slots.length);
    const started = new Map(d.controller.started.map(row => [row.run_id, row]));
    const completed = new Map(d.controller.completed.map(row => [row.run_id, row]));
    assert.equal(started.size, d.controller.started.length); assert.equal(completed.size, d.controller.completed.length);
    assert.equal(new Set(d.controller.started.map(row => row.slot_id)).size, started.size);
    assert.equal(completed.size, input.episodes.length, 'Every completed run needs its effective normalized result');
    const recovery = d.collection_recovery_source_sha256 ?? null, repaired = d.collection_recovery_repaired_run_ids ?? [];
    assert.equal(new Set(repaired).size, repaired.length);
    if (recovery) assert.ok(/^[a-f0-9]{64}$/.test(recovery)); else assert.equal(repaired.length, 0);
    for (const runId of repaired) assert.ok(started.has(runId), 'Recovery repair lacks its original controller start');
    for (const row of completed.values()) assert.equal(row.collection_recovery_source_sha256 ?? null, recovery, 'Completion recovery differs from its owning plan');
    const observations = new Map();
    for (const [index, episode] of input.episodes.entries()) {
      const runId = episode.identity.run_id, completion = completed.get(runId);
      assert.ok(completion && started.has(runId)); assert.ok(!observations.has(runId));
      assert.equal(completion.episode_sha256, manifest.source_episode_sha256[index]);
      assert.equal(episode.identity.experiment_id, d.experiment_id);
      if (d.scope_kind === FINITE) verifyFiniteOriginalProjection(completion, episode);
      observations.set(runId, { episode, source_episode_sha256: manifest.source_episode_sha256[index], completion });
    }
    for (const [runId, start] of started) {
      assert.ok(!physical.has(runId) && !historic.some(row => row.run_id === runId), 'A physical run appears in multiple scopes');
      const slot = d.slots.find(slot => slot.slot_id === start.slot_id); assert.ok(slot, 'Started run has no frozen slot');
      const observation = observations.get(runId);
      if (observation) {
        assert.equal(observation.episode.identity.case_id, slot.case_id);
        assert.equal(observation.episode.identity.condition_id, slot.condition_id);
        assert.equal(observation.completion.slot_id, slot.slot_id);
      }
      physical.set(runId, { group, slot, observation });
    }
    const valid = input.episodes.filter(episode => episode.admission.status === 'valid');
    const summary = { package: d.path, scope_id: d.scope_id, scope_kind: d.scope_kind, role: d.role,
      phase: d.phase, purpose: d.purpose, experiment_id: d.experiment_id,
      source_plan_sha256: d.source_plan_sha256, analysis_sha256: analysis.analysis_sha256,
      planned_slots: scientific.length, physical_dispatch_slots: d.slots.length,
      reserved_slots: started.size, recorded_episodes: input.episodes.length,
      started_unresolved: started.size - completed.size, unreserved_slots: d.slots.length - started.size,
      valid_episodes: valid.length, invalid_episodes: input.episodes.length - valid.length,
      missing_slots: analysis.completeness.unresolved_slots.filter(slot => slot.run_ids.length === 0).length,
      unresolved_slots_without_valid_result: analysis.completeness.unresolved_slots.length,
      verified_successes: valid.filter(episode => episode.result.verified_success).length,
      valid_fail_outcomes: valid.filter(episode => episode.result.outcome === 'fail').length,
      valid_unknown_outcomes: valid.filter(episode => episode.result.outcome === 'unknown').length,
      stop_reason: d.controller.last_reason, metrics_report: d.path + '/report.md' };
    perPlan.push(summary);
    for (const info of input.protocol.corpus.cases) {
      const selected = input.episodes.filter(episode => episode.identity.case_id === info.id);
      cases.push({ package: d.path, scope_id: d.scope_id, scope_kind: d.scope_kind, role: d.role, phase: d.phase, purpose: d.purpose, case_id: info.id, family: info.family,
        planned_slots: scientific.filter(slot => slot.case_id === info.id).length,
        physical_dispatch_slots: d.slots.filter(slot => slot.case_id === info.id).length,
        recorded_episodes: selected.length, valid_episodes: selected.filter(episode => episode.admission.status === 'valid').length,
        invalid_episodes: selected.filter(episode => episode.admission.status !== 'valid').length });
    }
  }
  for (const group of groups.filter(item => item.descriptor.role === FOLLOWUP)) {
    const d = group.descriptor, scope = amendments.find(item => item.id === d.scope_id), selection = scope.plan.selection;
    const sources = groups.filter(item => item.descriptor.source_plan_sha256 === selection.source_plan_sha256);
    assert.equal(sources.length, 1, 'Followup requires its exact original source plan in this release');
    const source = sources[0].descriptor;
    assert.notEqual(source.experiment_id, d.experiment_id);
    const started = new Set(source.controller.started.map(row => row.slot_id));
    assert.deepEqual(selection.slot_ids, source.slots.filter(slot => !started.has(slot.slot_id)).map(slot => slot.slot_id),
      'Followup must retain the exact originally unstarted selection');
    assert.deepEqual(d.analysis_slots.map(unit), (source.analysis_slots ?? source.slots).map(unit),
      'Followup must retain its original scientific denominator');
  }
  assert.equal(reservations.length - prefix, physical.size, 'Every added reservation needs an owning plan and controller record');
  const rows = reservations.map((item, index) => {
    assert.equal(item.ordinal, index + 1, 'Shared reservation gap');
    const receipt = item.receipt;
    if (index < prefix) {
      const row = historic[index], mapping = history.manifest.reservations[index];
      assert.equal(row.ordinal, item.ordinal); assert.equal(mapping.ordinal, item.ordinal);
      assert.equal(item.source_sha256, mapping.source_sha256); assert.equal(item.source_sha256, row.reservation_source_sha256);
      for (const key of ['run_id', 'experiment_id', 'slot_id']) assert.equal(receipt[key], row[key], 'Historical reservation prefix changed');
      return { ...row, package: null, historical_package: row.package, role: 'linked_history', history_replay: 'linked_not_replayed' };
    }
    const match = physical.get(receipt.run_id); assert.ok(match, 'Missing current reservation result or unresolved record');
    const { group, slot, observation } = match, d = group.descriptor;
    assert.equal(receipt.experiment_id, d.experiment_id); assert.equal(receipt.slot_id, slot.slot_id);
    assert.equal(receipt.source_plan_file_sha256, d.source_plan_file_sha256); assert.equal(receipt.plan_sha256, d.source_plan_sha256);
    assert.equal(receipt.scope_id, d.scope_id); assert.equal(receipt.scope_role, d.role);
    assert.equal(receipt.scope_amendment_sha256, d.scope_amendment_sha256);
    if (d.scope_kind === FINITE) {
      const scope = amendments.find(value => value.id === d.scope_id); assert.equal(receipt.scope_kind, FINITE);
      assert.equal(item.ordinal, scope.history_reservations.length + d.slots.findIndex(value => value.slot_id === slot.slot_id) + 1, 'Finite ordinal does not match the exact registered slot');
    } else assert.equal(receipt.scope_kind, undefined, 'Legacy reservations cannot acquire a finite kind');
    const base = { ordinal: item.ordinal, run_id: receipt.run_id, experiment_id: d.experiment_id, slot_id: slot.slot_id,
      package: d.path, role: d.role, scope_kind: d.scope_kind, phase: d.phase, purpose: d.purpose, scope_id: d.scope_id, condition_id: slot.condition_id, case_id: slot.case_id,
      reservation_source_sha256: item.source_sha256 };
    base.source_plan_file_sha256 = d.source_plan_file_sha256;
    base.source_ledger_sha256 = d.controller.source_ledger_sha256 ?? null;
    if (!observation) return { ...base, state: 'started_unresolved', source_episode_sha256: null, public_episode_sha256: null,
      admission: 'unresolved', outcome: 'unknown', business_outcome: 'unknown', verified_success: false, critical_failures: [],
      known_model_http_requests: 0, actual_model_http_requests: null, known_input_subtotal: 0, complete_input_tokens: null,
      known_output_subtotal: 0, complete_output_tokens: null, currency_cost: null, duration_ms: null,
      stop_batch: true, stop_reason: 'unresolved_execution',
       evidence_availability: { normalized: 'not_established', raw: 'not_inferred_from_missing_completion' }, known_subtotal_scope: 'No normalized usage established; zero is only an observed lower bound' };
    const { episode, source_episode_sha256, completion } = observation, m = episode.measurements;
    for (const n of [m.known_actual_attempts, m.input_total.known_subtotal, m.output_total.known_subtotal]) assert.ok(Number.isFinite(n) && n >= 0);
    return { ...base, state: 'completed', source_episode_sha256, public_episode_sha256: episode.episode_sha256,
      admission: episode.admission.status, outcome: episode.result.outcome, business_outcome: episode.business.status,
      core_evidence: historyCore(episode),
      verified_success: episode.result.verified_success, critical_failures: episode.result.critical_failures,
      known_model_http_requests: m.known_actual_attempts, actual_model_http_requests: known(m.actual_attempts),
      known_input_subtotal: m.input_total.known_subtotal, complete_input_tokens: known(m.input_total.value),
      known_output_subtotal: m.output_total.known_subtotal, complete_output_tokens: known(m.output_total.value),
      currency_cost: known(m.cost), duration_ms: known(episode.timing.duration_ms),
      stop_batch: completion.stop_batch, stop_reason: completion.stop_reason,
      analysis_revision_source_sha256: completion.analysis_revision_source_sha256 ?? null,
      original_episode_sha256: completion.original_episode_sha256 ?? null,
      collection_recovery_source_sha256: completion.collection_recovery_source_sha256 ?? null,
      collection_recovery_originally_unresolved: (d.collection_recovery_repaired_run_ids ?? []).includes(receipt.run_id),
      evidence_availability: { normalized: 'available_verified', raw: 'available_verified' },
      ...(completion.original_observation ? { original_observation: completion.original_observation } : {}) };
  });
  const acceptedOrdinals = acceptedHistory
    ? verifyAcceptedHistoryProjection(acceptedHistory, rows, reservations, prefix) : new Set();
  const byRun = new Map(rows.map(row => [row.run_id, row]));
  for (const scope of scopes) {
    if (['public-cohort-amendment', 'public-finite-campaign-amendment'].includes(scope.kind)) {
      for (const [index, entry] of scope.history_reservations.entries()) {
        assert.equal(entry.ordinal, index + 1, 'Scope history must be the full reservation prefix');
        assert.equal(reservations[index]?.source_sha256, entry.source_sha256);
        if (scope.kind === 'public-finite-campaign-amendment' && index >= prefix && !acceptedOrdinals.has(index + 1)) {
          const prior = rows[index]; assert.equal(prior.state, 'completed'); assert.equal(prior.stop_batch, false, 'Finite history cannot exempt a new original stop');
          assert.ok([prior.actual_model_http_requests, prior.complete_input_tokens, prior.complete_output_tokens, prior.duration_ms].every(Number.isFinite), 'Finite history cannot exempt new unknown usage');
          assert.equal(prior.core_evidence, 'complete', 'Finite history cannot exempt incomplete core evidence');
        }
      }
      assert.ok(scope.history_reservations.length >= prefix);
      assert.equal(scope.history_exemption.scheduled_episodes, prefix, 'The original historical exception is immutable');
      assert.deepEqual(scope.history_exemption.unknown_usage_run_ids, historicalSummary.unknown_usage_run_ids);
    } else if (['public-cohort-gate', 'public-finite-route-gate'].includes(scope.kind)) {
      const owner = amendments.find(value => value.id === scope.scope_id); assert.ok(owner);
      const finite = scope.kind === 'public-finite-route-gate';
      assert.equal(owner.kind, finite ? 'public-finite-campaign-amendment' : 'public-cohort-amendment');
      assert.equal(scope.scheduled_episodes, finite ? owner.plan.scheduled_episodes : owner.gate.scheduled_episodes);
      if (finite) assert.equal(owner.role, 'route_gate_only');
      assert.equal(scope.status, 'passed'); assert.equal(scope.episode_evidence.length, scope.scheduled_episodes);
      assert.equal(new Set(scope.episode_evidence.map(row => row.run_id)).size, scope.scheduled_episodes);
      for (const item of scope.episode_evidence) {
        const row = byRun.get(item.run_id); assert.ok(row && row.role !== 'linked_history');
        assert.equal(row.source_episode_sha256, item.source_episode_sha256); assert.equal(row.admission, 'valid');
        if (finite) {
          assert.equal(row.stop_batch, false); assert.ok(row.actual_model_http_requests > 0);
          assert.ok([row.actual_model_http_requests, row.complete_input_tokens, row.complete_output_tokens, row.duration_ms].every(Number.isFinite));
        }
        assert.equal(row.scope_id, scope.scope_id); assert.equal(row.ordinal, item.pilot_ordinal);
        assert.equal(row.reservation_source_sha256, item.reservation_source_sha256);
        assert.ok(groups.some(group => group.descriptor.source_plan_file_sha256 === scope.current_plan_source_sha256 && group.descriptor.path === row.package));
      }
    }
  }
  assert.equal(intent.kind, 'public-model-continuation-intent');
  if (intent.budget_decision) {
    verifyBudgetProjection(intent.budget_decision, intent.source_sha256);
    assert.equal(intent.budget_decision.historical_prefix_reservations, prefix);
    assert.deepEqual(intent.budget_decision.original_unknown_run_ids, historicalSummary.unknown_usage_run_ids);
  }
  const newRows = rows.slice(prefix);
  const cohorts = amendments.map(scope => {
    const phases = scopePhases(scope).map(declared => {
      const plan = perPlan.find(row => row.scope_id === scope.id && row.role === declared.role);
      if (plan) assert.equal(plan.experiment_id, declared.experiment_id);
      const scientificCount = declared.scientific_slots?.length ?? declared.scheduled_episodes;
      return { role: declared.role, phase: declared.phase, purpose: plan?.purpose ?? declared.purpose ?? null,
        experiment_id: declared.experiment_id, predeclared_slots: scientificCount, physical_dispatch_slots: declared.scheduled_episodes,
        actual_frozen_slots: plan?.physical_dispatch_slots ?? 0, recorded_episodes: plan?.recorded_episodes ?? 0,
        valid_episodes: plan?.valid_episodes ?? 0, pending_valid_results: scientificCount - (plan?.valid_episodes ?? 0),
        state: plan ? 'actual_plan_included' : 'predeclared_without_actual_plan_in_this_release' };
    });
    const scopeRows = newRows.filter(row => row.scope_id === scope.id);
    return { scope_id: scope.id, scope_kind: scope.source_kind, model_count: scope.model_count, predeclared_slots: scope.reservation_limit,
      scientific_planned_slots: phases.reduce((n, row) => n + row.predeclared_slots, 0),
      reserved_slots: scopeRows.length, unreserved_predeclared_slots: scope.reservation_limit - scopeRows.length,
      retained_stop_run_ids: scopeRows.filter(row => row.stop_batch).map(row => row.run_id),
      retained_unknown_usage_run_ids: summarizeUsage(scopeRows).unknown_usage_run_ids,
      actual_frozen_slots: phases.reduce((n, row) => n + row.actual_frozen_slots, 0), phases,
      claim_scope: scope.kind === 'public-finite-campaign-amendment' && scope.role === 'route_gate_only'
        ? 'route/apparatus/accounting only; no expansion or business-quality acceptance'
        : 'the actual declared phase and purpose; no pooled quality acceptance',
      gate_proof: scopes.find(item => ['public-cohort-gate', 'public-finite-route-gate'].includes(item.kind) && item.scope_id === scope.id)?.source_sha256 ?? null };
  });
  const unacceptedRows = rows.slice(acceptedHistory?.scheduled_episodes ?? prefix);
  return { accounting: { version: 1, kind: 'benchmark-cohort-campaign-accounting', history_status: 'linked_not_replayed',
    per_plan: perPlan, historical_prefix: historicalSummary, current_plans: summarizeUsage(newRows),
    shared_campaign: { ...summarizeUsage(rows), maximum_scheduled_episodes: 144 }, episodes: rows,
    limitations: ['History is linked to its independent pinned replay, not replayed by this package.',
      'Historical, failed, unknown and unresolved reservations remain in physical accounting.',
      'episodes_with_observed_model_send_lower_bound counts episodes with a known request lower bound above zero; unknown complete counts remain null. This new derived field does not replace the linked historical report metric.',
      'Same-raw analysis revisions and registered collection recoveries do not create another reservation.',
      'Scientific planned_slots, frozen physical_dispatch_slots and actual reservations are separate counts; capacities are not pooled samples.',
      'Quality and efficiency are reported separately for each frozen plan.'] },
    coverage: { version: 1, kind: 'benchmark-cohort-separate-plan-coverage', per_plan: perPlan, cohorts, cases,
      historical_quality_credit: 'excluded', actual_frozen_slots: perPlan.reduce((n, row) => n + row.physical_dispatch_slots, 0),
      recorded_new_episodes: newRows.filter(row => row.state === 'completed').length,
      new_reserved_unresolved: newRows.filter(row => row.state === 'started_unresolved').length,
      retained_new_stop_run_ids: newRows.filter(row => row.stop_batch).map(row => row.run_id),
      retained_new_unknown_usage_run_ids: summarizeUsage(newRows).unknown_usage_run_ids,
      accepted_history: acceptedHistory ? { source_sha256: acceptedHistory.source_sha256,
        scheduled_episodes: acceptedHistory.scheduled_episodes, history_checkpoint_sha256: acceptedHistory.history_checkpoint_sha256,
        retained_stop_run_ids: acceptedHistory.retained_stop_run_ids, unknown_usage_run_ids: acceptedHistory.unknown_usage_run_ids,
        total_reservation_ceiling: acceptedHistory.total_reservation_ceiling } : null,
      unaccepted_stop_run_ids: unacceptedRows.filter(row => row.stop_batch).map(row => row.run_id),
      unaccepted_unknown_usage_run_ids: summarizeUsage(unacceptedRows).unknown_usage_run_ids,
      unaccepted_incomplete_core_run_ids: unacceptedRows.filter(row => row.core_evidence !== 'complete').map(row => row.run_id),
      future_dispatch_status: unacceptedRows.some(row => row.stop_batch) || summarizeUsage(unacceptedRows).unknown_usage_run_ids.length
        ? 'blocked_by_retained_new_stop_or_unknown' : unacceptedRows.some(row => row.core_evidence !== 'complete')
          ? 'blocked_by_unaccepted_incomplete_core' : 'not_certified_by_publication',
      intent_source_sha256: intent.source_sha256, original_route_intent_new_maximum: intent.new_executable_maximum,
      prospective_budget: intent.budget_decision ?? null,
      budget_claim: 'Route intent and budget allocations are source declarations; actual registration and execution are reported per plan and reservation.',
      unregistered_intent_models: intent.models.filter(model => !groups.some(group => group.input.protocol.models.some(actual => actual.route === model.route))),
      quality_policy: 'No pooled quality or efficiency statistic across plans or cohorts; pending slots retain their original denominator.' } };
}
