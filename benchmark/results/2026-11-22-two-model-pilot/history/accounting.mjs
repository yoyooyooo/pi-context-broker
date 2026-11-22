import assert from 'node:assert/strict';

const known = fact => fact?.status === 'known' ? fact.value : null;

export function deriveAccounting({ current, retained, currentAnalysis, currentManifest, retainedManifest, reservations }) {
  const groups = [
    { name: 'retained-invalid', input: retained, manifest: retainedManifest },
    { name: 'current-plan', input: current, manifest: currentManifest },
  ];
  const episodes = new Map();
  for (const group of groups) group.input.episodes.forEach((episode, index) => {
    assert.ok(!episodes.has(episode.identity.run_id), 'A physical run cannot be counted twice');
    episodes.set(episode.identity.run_id, { episode, group, index });
  });
  assert.equal(reservations.length, episodes.size, 'Every retained reservation needs its own episode');
  const rows = reservations.map(({ ordinal, receipt, source_sha256 }) => {
    const item = episodes.get(receipt.run_id);
    assert.ok(item, 'Reservation has no matching retained episode');
    const { episode, group, index } = item;
    assert.equal(receipt.experiment_id, episode.identity.experiment_id);
    const m = episode.measurements;
    return {
      ordinal, run_id: receipt.run_id, experiment_id: receipt.experiment_id,
      condition_id: episode.identity.condition_id, case_id: episode.identity.case_id,
      reservation_sha256: source_sha256, package: group.name,
      source_episode_sha256: group.manifest.source_episode_sha256[index],
      public_episode_sha256: episode.episode_sha256,
      validity: episode.admission.status, outcome: episode.result.outcome,
      actual_model_http_requests: known(m.actual_attempts),
      known_input_subtotal: m.input_total.known_subtotal,
      input_tokens_complete: known(m.input_total.value),
      known_output_subtotal: m.output_total.known_subtotal,
      output_tokens_complete: known(m.output_total.value),
      currency_cost: known(m.cost),
      duration_ms: known(episode.timing.duration_ms),
    };
  }).sort((a, b) => a.ordinal - b.ordinal);
  assert.equal(new Set(rows.map(r => r.ordinal)).size, rows.length);
  const sumKnown = name => rows.reduce((sum, row) => sum + row[name], 0);
  const sumComplete = name => rows.every(row => typeof row[name] === 'number') ?
    Number(sumKnown(name).toFixed(6)) : null;
  const valid = current.episodes.filter(e => e.admission.status === 'valid');
  const unresolved = currentAnalysis.completeness.unresolved_slots;
  return {
    schema_version: 1, kind: 'benchmark-blocked-pilot-accounting',
    scope: 'Shared reservation accounting across distinct plans; no pooled quality estimate',
    current_plan: {
      planned_slots: currentAnalysis.completeness.planned_slots,
      recorded_episodes: current.episodes.length,
      valid_episodes: valid.length,
      invalid_episodes: current.episodes.length - valid.length,
      missing_slots: unresolved.filter(slot => slot.run_ids.length === 0).length,
      unresolved_slots_without_valid_result: unresolved.length,
      verified_successes: valid.filter(e => e.result.verified_success === true).length,
      valid_unknown_outcomes: valid.filter(e => e.result.outcome === 'unknown').length,
    },
    shared_pilot: {
      reserved_episodes: rows.length,
      episodes_with_actual_model_send: rows.filter(row => row.actual_model_http_requests > 0).length,
      actual_model_http_requests: sumComplete('actual_model_http_requests'),
      known_input_subtotal: sumKnown('known_input_subtotal'),
      complete_input_tokens: sumComplete('input_tokens_complete'),
      known_output_subtotal: sumKnown('known_output_subtotal'),
      complete_output_tokens: sumComplete('output_tokens_complete'),
      complete_currency_cost: null,
      currency_cost_reason: 'Verified pricing is unavailable; one sent request also lacks provider usage',
      summed_observed_episode_duration_ms: sumComplete('duration_ms'),
      maximum_scheduled_episodes: current.protocol.policies.pilot.max_scheduled_episodes,
      route_gate_prefix_episodes: current.protocol.policies.pilot.route_gate_episodes,
      route_gate_status: 'blocked',
    },
    episodes: rows,
    exclusions: [
      'A reanalysis of existing raw evidence is not another model execution or reservation',
      'The retained zero-send invalid episode is not a current-plan valid sample',
      'Missing and invalid planned units receive no verified success credit',
      'A known subtotal is not a complete token total or a monetary charge',
    ],
  };
}
