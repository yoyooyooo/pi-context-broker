import assert from 'node:assert/strict';

export function revisionEpisodeFacts(episode) {
  const known = value => value?.status === 'known' ? value.value : null;
  return { admission: episode.admission.status, result: episode.result, business_status: episode.business.status,
    actual_model_requests: known(episode.measurements.actual_attempts),
    input_tokens: known(episode.measurements.input_total.value), output_tokens: known(episode.measurements.output_total.value),
    duration_ms: known(episode.timing.duration_ms) };
}

export function deriveReleaseEvidence({ groups, reservations, intent, scopeDocuments = [], revisionDocuments = [] }) {
  const known = fact => fact?.status === 'known' ? fact.value : null;
  const physical = new Map(), perPlan = [];
  for (const group of groups) {
    const { descriptor, input, analysis, manifest } = group;
    assert.equal(input.protocol.id, descriptor.experiment_id);
    assert.equal(input.episodes.length, manifest.source_episode_sha256.length);
    assert.equal(analysis.analysis_sha256, manifest.public_analysis_sha256);
    assert.equal(input.protocol.protocol_sha256, manifest.public_protocol_sha256);
    const valid = input.episodes.filter(episode => episode.admission.status === 'valid');
    perPlan.push({
      package: descriptor.path, role: descriptor.role, experiment_id: descriptor.experiment_id,
      analysis_version: analysis.analysis_version, analysis_sha256: analysis.analysis_sha256,
      source_analysis_sha256: manifest.source_analysis_sha256,
      planned_slots: analysis.completeness.planned_slots, recorded_episodes: input.episodes.length,
      valid_episodes: valid.length, invalid_episodes: input.episodes.length - valid.length,
      missing_slots: analysis.completeness.unresolved_slots.filter(slot => slot.run_ids.length === 0).length,
      unresolved_slots_without_valid_result: analysis.completeness.unresolved_slots.length,
      valid_unknown_outcomes: valid.filter(episode => episode.result.outcome === 'unknown').length,
      verified_successes: valid.filter(episode => episode.result.verified_success === true).length,
      valid_fail_outcomes: valid.filter(episode => episode.result.outcome === 'fail').length,
      metrics_report: descriptor.path + '/report.md',
    });
    for (const [index, episode] of input.episodes.entries()) {
      assert.ok(!physical.has(episode.identity.run_id), 'A physical run appears in multiple reports: ' + episode.identity.run_id);
      physical.set(episode.identity.run_id, { group, episode, index });
    }
  }
  assert.equal(new Set(reservations.map(item => item.receipt.run_id)).size, reservations.length, 'Duplicate physical reservation');
  assert.equal(reservations.length, physical.size, 'Every physical reservation must have exactly one supplied normalized result; supply missing retained reports');
  const rows = reservations.map((item, index) => {
    assert.equal(item.ordinal, index + 1, 'Shared reservation gap');
    const match = physical.get(item.receipt.run_id);
    assert.ok(match, 'Reservation has no supplied normalized result: ' + item.receipt.run_id);
    const { group, episode, index: episodeIndex } = match, m = episode.measurements;
    assert.equal(item.receipt.experiment_id, episode.identity.experiment_id);
    if (item.receipt.source_plan_file_sha256) {
      assert.equal(item.receipt.source_plan_file_sha256, group.descriptor.source_plan_file_sha256);
      assert.equal(item.receipt.plan_sha256, group.descriptor.source_plan_sha256);
    }
    if (group.descriptor.slots) {
      const slot = group.descriptor.slots.find(value => value.slot_id === item.receipt.slot_id);
      assert.ok(slot, 'Reservation slot is absent from its actual plan');
      assert.equal(slot.case_id, episode.identity.case_id); assert.equal(slot.condition_id, episode.identity.condition_id);
    }
    assert.ok(Number.isFinite(m.input_total.known_subtotal) && Number.isFinite(m.output_total.known_subtotal));
    assert.ok(Number.isSafeInteger(m.known_actual_attempts) && m.known_actual_attempts >= 0);
    return {
      ordinal: item.ordinal, run_id: episode.identity.run_id, experiment_id: episode.identity.experiment_id,
      slot_id: item.receipt.slot_id, package: group.descriptor.path, role: group.descriptor.role,
      condition_id: episode.identity.condition_id, case_id: episode.identity.case_id,
      reservation_source_sha256: item.source_sha256, reservation_public_sha256: item.public_sha256,
      source_episode_sha256: group.manifest.source_episode_sha256[episodeIndex], public_episode_sha256: episode.episode_sha256,
      admission: episode.admission.status, outcome: episode.result.outcome,
      business_outcome: episode.business?.status ?? null, verified_success: episode.result.verified_success,
      critical_failures: episode.result.critical_failures,
      known_model_http_requests: m.known_actual_attempts, actual_model_http_requests: known(m.actual_attempts),
      known_input_subtotal: m.input_total.known_subtotal, complete_input_tokens: known(m.input_total.value),
      known_output_subtotal: m.output_total.known_subtotal, complete_output_tokens: known(m.output_total.value),
      currency_cost: known(m.cost), duration_ms: known(episode.timing.duration_ms),
    };
  });
  assert.ok(rows.length <= 144);
  const summarize = selected => {
    const subtotal = key => Number(selected.reduce((total, row) => total + (typeof row[key] === 'number' ? row[key] : 0), 0).toFixed(6));
    const complete = key => selected.every(row => typeof row[key] === 'number') ? subtotal(key) : null;
    return {
      reserved_episodes: selected.length, episodes_with_actual_model_send: selected.filter(row => row.actual_model_http_requests > 0).length,
      known_model_http_requests: subtotal('known_model_http_requests'), actual_model_http_requests: complete('actual_model_http_requests'),
      known_input_subtotal: subtotal('known_input_subtotal'), complete_input_tokens: complete('complete_input_tokens'),
      known_output_subtotal: subtotal('known_output_subtotal'), complete_output_tokens: complete('complete_output_tokens'),
      complete_currency_cost: null,
      currency_cost_status: selected.some(row => row.currency_cost === null) ? 'incomplete_or_unpriced' : 'not_aggregated_without_verified_common_currency',
      unknown_usage_run_ids: selected.filter(row => row.actual_model_http_requests === null || row.complete_input_tokens === null || row.complete_output_tokens === null).map(row => row.run_id),
      summed_observed_episode_duration_ms: complete('duration_ms'),
    };
  };
  const byRun = new Map(rows.map(row => [row.run_id, row]));
  const reservationByOrdinal = new Map(reservations.map(item => [item.ordinal, item]));
  for (const value of scopeDocuments) {
    if (value.kind === 'public-route-gate') {
      const owner = groups.find(group => group.descriptor.role === 'admission' && group.descriptor.source_plan_file_sha256 === value.current_plan_source_sha256);
      assert.ok(owner, 'Public gate does not identify the corrected admission plan');
    }
    const observations = value.kind === 'public-pilot-scope-amendment' ? value.history.episodes : value.episode_evidence;
    if (value.kind === 'public-pilot-scope-amendment') for (const item of value.history.reservations)
      assert.equal(reservationByOrdinal.get(item.ordinal)?.source_sha256, item.source_sha256, 'Scope history reservation differs from released source mapping');
    if (value.manual_route_replacement) {
      const repair = byRun.get(value.manual_route_replacement.run_id); assert.ok(repair);
      assert.equal(repair.role, 'retained'); assert.equal(repair.admission, 'invalid'); assert.equal(repair.actual_model_http_requests, 1);
      assert.ok(repair.complete_input_tokens === null || repair.complete_output_tokens === null, 'Retained authentication usage remains unknown');
    }
    if (value.zero_send_repair) {
      const repair = byRun.get(value.zero_send_repair.run_id); assert.ok(repair);
      assert.equal(repair.role, 'retained'); assert.equal(repair.admission, 'invalid');
      assert.equal(repair.actual_model_http_requests, 0, 'The retained repair must be the observed zero-send result');
    }
    for (const item of observations) {
      const row = byRun.get(item.run_id); assert.ok(row, 'Scope source observation has no released normalized result');
      assert.equal(row.source_episode_sha256, item.source_episode_sha256, 'Scope observation differs from the released source episode');
      assert.equal(row.ordinal, item.pilot_ordinal);
      if (item.reservation_source_sha256) assert.equal(reservationByOrdinal.get(row.ordinal).source_sha256, item.reservation_source_sha256);
    }
  }
  const revisionByRun = new Map(), revisionFiles = new Set();
  for (const revision of revisionDocuments) {
    assert.equal(revision.kind, 'public-analysis-revision');
    assert.ok(!revisionFiles.has(revision.source_file_sha256)); revisionFiles.add(revision.source_file_sha256);
    const owner = groups.find(group => group.descriptor.source_plan_file_sha256 === revision.plan_source_file_sha256);
    assert.ok(owner, 'Revision owner is absent from supplied plan reports');
    assert.ok(['admission', 'expansion'].includes(owner.descriptor.role), 'A current-scope revision cannot exclude its run as retained history');
    assert.equal(owner.descriptor.source_plan_sha256, revision.plan_source_sha256);
    assert.equal(revision.registration.source_revision_file_sha256, revision.source_file_sha256);
    assert.equal(revision.registration.model_execution, false);
    assert.deepEqual([...revision.registration.replacement_run_ids].sort(), revision.replacements.map(row => row.run_id).sort());
    for (const replacement of revision.replacements) {
      assert.ok(!revisionByRun.has(replacement.run_id), 'A physical run cannot acquire multiple public revision claims');
      const row = byRun.get(replacement.run_id), match = physical.get(replacement.run_id);
      assert.ok(row && match && match.group === owner);
      assert.equal(row.source_episode_sha256, replacement.new_episode_sha256);
      assert.equal(row.slot_id, replacement.slot_id);
      const parent = match.episode.identity.reanalysis_of;
      assert.equal(typeof parent === 'string' ? parent : parent?.episode_sha256, replacement.original_episode_sha256);
      assert.deepEqual(replacement.original_facts, replacement.revised_facts);
      assert.deepEqual(revisionEpisodeFacts(match.episode), replacement.revised_facts);
      assert.equal(replacement.original_controller.status, 'failed'); assert.equal(replacement.original_controller.stop_batch, true);
      assert.equal(replacement.effective_controller.status, 'failed'); assert.equal(replacement.effective_controller.stop_batch, false);
      assert.equal(replacement.effective_controller.stop_reason, null);
      assert.equal(replacement.stop_classification.kind, 'verified-local-request-limit-before-send');
      assert.equal(replacement.stop_classification.actual_model_requests, row.actual_model_http_requests);
      assert.equal(replacement.stop_classification.max_model_requests, row.actual_model_http_requests);
      assert.deepEqual(replacement.selection_evidence.original_coverage, replacement.selection_evidence.revised_coverage);
      const readback = match.episode.artifacts.find(artifact => artifact.id === 'collection-readback');
      assert.equal(readback?.publication?.source_sha256, replacement.selection_evidence.revised_readback_source_sha256);
      for (const retained of replacement.retained_raw_sources) {
        const artifact = match.episode.artifacts.find(value => value.id === retained.artifact_id);
        const mapping = owner.manifest.raw_mapping.find(value => value.source_sha256 === retained.source_sha256);
        assert.ok(artifact && mapping, 'The registered original raw source is absent from the public package');
        assert.equal(artifact.publication.source_sha256, retained.source_sha256);
        assert.equal(artifact.sha256, mapping.public_sha256);
        assert.equal(artifact.path, mapping.public_path);
      }
      revisionByRun.set(replacement.run_id, { source_revision_file_sha256: revision.source_file_sha256,
        original_episode_sha256: replacement.original_episode_sha256, new_episode_sha256: replacement.new_episode_sha256 });
    }
  }
  for (const gate of scopeDocuments.filter(value => value.kind === 'public-route-gate')) {
    if (gate.analysis_revision_source_sha256) assert.ok(revisionFiles.has(gate.analysis_revision_source_sha256));
    for (const item of gate.episode_evidence) if (item.analysis_revision_source_sha256) {
      const replacement = revisionByRun.get(item.run_id); assert.ok(replacement);
      assert.equal(item.analysis_revision_source_sha256, gate.analysis_revision_source_sha256);
      assert.equal(replacement.source_revision_file_sha256, item.analysis_revision_source_sha256);
      assert.equal(replacement.original_episode_sha256, item.original_episode_sha256);
      assert.equal(replacement.new_episode_sha256, item.source_episode_sha256);
    }
  }
  const newGroups = groups.filter(group => ['admission', 'expansion'].includes(group.descriptor.role));
  assert.equal(new Set(newGroups.map(group => group.descriptor.role)).size, newGroups.length, 'Only one corrected plan per current stage');
  const caseRows = intent.case_family_map.map(expected => {
    const group = newGroups.find(value => value.descriptor.role === expected.stage);
    const declared = group?.descriptor.cases.find(value => value.case_id === expected.case_id);
    if (group) assert.ok(declared, 'Current plan omitted a predeclared case');
    const observed = declared ? group.input.episodes.filter(episode => episode.identity.case_id === declared.protocol_case_id) : [];
    const valid = observed.filter(episode => episode.admission.status === 'valid');
    return {
      case_id: expected.case_id, family: expected.family, stage: expected.stage,
      predeclared_episodes: expected.episode_count, actual_frozen_slots: declared?.planned_slots ?? 0,
      recorded_episodes: observed.length, valid_episodes: valid.length, invalid_episodes: observed.length - valid.length,
      valid_real_episodes: valid.filter(episode => known(episode.measurements.actual_attempts) > 0).length,
      valid_unknown_outcomes: valid.filter(episode => episode.result.outcome === 'unknown').length,
      recorded_conditions: [...new Set(observed.map(episode => episode.identity.condition_id))].sort(),
    };
  });
  for (const group of newGroups) {
    const allowed = intent.case_family_map.filter(item => item.stage === group.descriptor.role).map(item => item.case_id).sort();
    assert.deepEqual(group.descriptor.cases.map(item => item.case_id).sort(), allowed, 'Current plan changed the predeclared case selection');
  }
  const coverage = {
    version: 1, kind: 'benchmark-separate-plan-coverage',
    predeclared: intent.planned_coverage, predeclared_model_routes: intent.models,
    passed_prospective_gate_included: scopeDocuments.some(value => value.kind === 'public-route-gate'),
    expansion_plan_included: newGroups.some(group => group.descriptor.role === 'expansion'),
    current_plan_model_routes: newGroups.map(group => ({ role: group.descriptor.role, package: group.descriptor.path,
      models: group.descriptor.model_conditions })),
    manual_route_replacements: scopeDocuments.filter(value => value.manual_route_replacement).map(value => ({
      scope_id: value.id, source_amendment_sha256: value.original_amendment_sha256,
      from_model_id: value.manual_route_replacement.from_model_id, to_model_id: value.manual_route_replacement.to_model_id,
      variant: value.manual_route_replacement.variant, retained_run_id: value.manual_route_replacement.run_id })),
    actual_frozen_new_slots: caseRows.reduce((sum, row) => sum + row.actual_frozen_slots, 0),
    recorded_new_scope_episodes: caseRows.reduce((sum, row) => sum + row.recorded_episodes, 0),
    cases_with_recorded_episode: caseRows.filter(row => row.recorded_episodes > 0).length,
    families_with_recorded_episode: new Set(caseRows.filter(row => row.recorded_episodes > 0).map(row => row.family)).size,
    cases: caseRows,
    quality_policy: 'Separate plan metrics only; coverage and campaign costs are not a pooled quality or efficiency estimate',
  };
  return {
    accounting: {
      version: 1, kind: 'benchmark-separate-plan-campaign-accounting',
      scope: 'Distinct physical runs and shared reservations; historical and retained repairs have no quality credit in the corrected plans',
      per_plan: perPlan, shared_campaign: { ...summarize(rows), maximum_scheduled_episodes: 144 },
      immutable_history: summarize(rows.filter(row => row.role === 'history')),
      retained_repairs: summarize(rows.filter(row => row.role === 'retained')),
      current_scope: summarize(rows.filter(row => ['admission', 'expansion'].includes(row.role))),
      episodes: rows, same_run_analysis_revisions: [...revisionByRun].map(([run_id, value]) => ({ run_id, ...value, additional_executions: 0 })), legacy_first24: 'incomplete_not_satisfied',
      limitations: ['Unknown historical usage remains unknown after complete new usage', 'Same-raw reanalysis is not another physical execution',
        'Recorded episode durations are not project elapsed time', 'No aggregate quality or efficiency statistic is computed across plans',
        'episodes_with_actual_model_send counts observed positive sends; episodes with unknown send status remain unknown'],
    }, coverage,
  };
}
