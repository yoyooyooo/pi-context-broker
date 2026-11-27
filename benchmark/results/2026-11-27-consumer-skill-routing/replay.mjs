import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { toCsv } from '../../analysis/report.mjs';

// Arithmetic over the reviewed public projection only. This does not regrade
// private answers, validate source delivery, or replay the original episodes.
const directory = dirname(fileURLToPath(import.meta.url));
const input = JSON.parse(await readFile(join(directory, 'observations.json'), 'utf8'));
assert.equal(input.schema_version, 1);
assert.equal(input.kind, 'ah1336-anonymous-observations');
assert.equal(input.epoch, 'ordinary-development-v2');
assert.equal(input.route_epoch, 'route01');
assert.equal(input.slots.length, 24);
assert.equal(input.pairs.length, 12);
const factors = ['G', 'T', 'S'];
const cases = ['case01', 'case02'];
const tau = 240000;
const sum = values => values.reduce((a, b) => a + b, 0);
const knownNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const mean = values => values.every(knownNumber) ? sum(values) / values.length : null;
const ratio = (candidate, baseline) => candidate === null || baseline === null || baseline === 0 ? null : candidate / baseline;
const ratioStatus = (candidate, baseline) => candidate === null || baseline === null ? 'unknown' : baseline === 0 ? 'undefined_zero_baseline' : 'known';
const valid = row => row.validity === 'valid';
const key = row => `${row.factor}/${row.arm}/${row.case_alias}/${row.repeat}`;
const unique = new Set();
const slotAliases = new Set();
const runAliases = new Set();
const stopCodes = new Set(['NONE','NOT_STARTED_INPUT_ADMISSION','NOT_STARTED_BATCH_STOP','NOT_STARTED_WINDOW','NOT_STARTED_CAPACITY','NOT_STARTED_NO_ADMISSION','BENCHMARK_WALL_LIMIT','BENCHMARK_BUDGET_LIMIT','APPARATUS_INVALID','BENCHMARK_ADMISSION_MISMATCH','COLLECTION_UNRESOLVED']);
for (const row of input.slots) {
  assert.ok(factors.includes(row.factor));
  assert.equal(row.epoch, input.epoch);
  assert.equal(row.route_epoch, input.route_epoch);
  assert.match(row.slot_alias, /^[GTS]-[0-9]{2}$/);
  assert.ok(stopCodes.has(row.stop_code));
  assert.equal(typeof row.provider_started, 'boolean');
  if (row.run_alias !== null) {
    assert.match(row.run_alias, /^run[0-9]{2}$/);
    assert.ok(!runAliases.has(row.run_alias)); runAliases.add(row.run_alias);
  }
  assert.ok(['B0', row.factor].includes(row.arm));
  assert.ok(cases.includes(row.case_alias));
  assert.ok([0, 1].includes(row.repeat));
  assert.equal(row.cluster_alias, 'cluster01');
  assert.equal(row.slot_weight, 0.25);
  assert.ok(!unique.has(key(row))); unique.add(key(row));
  assert.ok(!slotAliases.has(row.slot_alias)); slotAliases.add(row.slot_alias);
  assert.ok(['not_started', 'terminal'].includes(row.slot_state));
  assert.ok(['not_started', 'valid', 'invalid', 'unresolved'].includes(row.validity));
  assert.ok(['not_started', 'pass', 'fail', 'unknown'].includes(row.business_status));
  assert.ok(['unresolved', 'pass', 'fail', 'unknown'].includes(row.verified_outcome));
  if (valid(row)) { assert.equal(row.slot_state, 'terminal'); assert.ok(['pass','fail','unknown'].includes(row.verified_outcome)); assert.notEqual(row.business_status, 'not_started'); }
  if (row.slot_state === 'terminal') { assert.notEqual(row.validity, 'not_started'); assert.notEqual(row.run_alias, null); }
  for (const name of ['input_complete','output_complete','attempts_complete','usage_complete']) assert.equal(typeof row[name], 'boolean');
  assert.equal(row.usage_complete, row.input_complete && row.output_complete && row.attempts_complete);
  if (row.input_complete) { assert.ok(knownNumber(row.input_total)); assert.equal(row.input_total, row.input_known_subtotal); }
  if (row.output_complete) { assert.ok(knownNumber(row.output_total)); assert.equal(row.output_total, row.output_known_subtotal); }
  if (row.attempts_complete) { assert.ok(knownNumber(row.actual_attempts)); assert.equal(row.actual_attempts, row.known_actual_attempts); }
  for (const name of ['actual_attempts','known_actual_attempts','logical_requests']) if (row[name] !== null) assert.ok(Number.isInteger(row[name]) && row[name] >= 0);
  for (const name of ['input_known_subtotal', 'output_known_subtotal', 'known_actual_attempts']) assert.ok(knownNumber(row[name]));
  for (const name of ['input_total', 'output_total', 'logical_requests', 'actual_attempts', 'observed_elapsed_ms', 'time_to_success_ms']) assert.ok(row[name] === null || knownNumber(row[name]));
  if (row.slot_state === 'not_started') {
    assert.equal(row.validity, 'not_started');
    assert.equal(row.business_status, 'not_started');
    assert.equal(row.verified_outcome, 'unresolved');
    assert.equal(row.run_alias, null);
    assert.equal(row.observed_elapsed_ms, null);
    assert.equal(row.time_to_success_ms, null);
    assert.equal(row.provider_started, false);
    for (const name of ['actual_attempts','logical_requests','input_total','output_total']) assert.ok(row[name] === null || row[name] === 0);
    assert.equal(row.known_actual_attempts, 0);
    assert.equal(row.input_known_subtotal, 0);
    assert.equal(row.output_known_subtotal, 0);
  }
  const capped = !valid(row) ? null : row.verified_outcome === 'pass'
    ? knownNumber(row.time_to_success_ms) ? Math.min(tau, row.time_to_success_ms) : null
    : tau;
  assert.equal(row.scorer_capped_ms, capped);
  assert.equal(row.scorer_capped_basis, capped === null ? 'unresolved' : row.verified_outcome === 'pass' ? 'verified_success_time' : 'nonpass_penalty');
  assert.equal(row.observed_elapsed_capped_ms, row.observed_elapsed_ms === null ? null : Math.min(tau, row.observed_elapsed_ms));
  assert.equal(row.currency_status, 'unknown');
  assert.equal(row.amount, null);
}
for (const factor of factors) for (const arm of ['B0', factor]) for (const case_alias of cases) for (const repeat of [0, 1]) {
  assert.ok(unique.has(key({factor, arm, case_alias, repeat})));
}
const pairKeys = new Set();
for (const pair of input.pairs) {
  assert.ok(factors.includes(pair.factor)); assert.ok(cases.includes(pair.case_alias)); assert.ok([0, 1].includes(pair.repeat));
  assert.equal(pair.pair_alias, `${pair.factor}-${pair.case_alias}-r${pair.repeat}`);
  if (pair.baseline_detour_alias !== null) assert.match(pair.baseline_detour_alias, /^detour[0-9]{2}$/);
  assert.ok(['complete','unknown'].includes(pair.review_status));
  const pairKey = `${pair.factor}/${pair.case_alias}/${pair.repeat}`;
  assert.ok(!pairKeys.has(pairKey)); pairKeys.add(pairKey);
  assert.ok([true, false, null].includes(pair.route_gain));
  assert.ok([true, false, null].includes(pair.new_critical_regression));
  assert.ok([true, false, null].includes(pair.full_journey_evidence_complete));
}
const summaries = factors.map(factor => {
  const rows = input.slots.filter(row => row.factor === factor);
  const arm = label => {
    const group = rows.filter(row => row.arm === label);
    const count = fn => group.filter(fn).length;
    return {
      arm: label, planned: 4, started: count(row => row.slot_state !== 'not_started'),
      never_started: count(row => row.slot_state === 'not_started'), valid: count(valid),
      invalid: count(row => row.validity === 'invalid'), without_valid_observation: count(row => !valid(row)),
      valid_business_pass: count(row => valid(row) && row.business_status === 'pass'),
      valid_business_fail: count(row => valid(row) && row.business_status === 'fail'),
      valid_business_unknown: count(row => valid(row) && row.business_status === 'unknown'),
      verified_pass: count(row => valid(row) && row.verified_outcome === 'pass'),
      verified_fail: count(row => valid(row) && row.verified_outcome === 'fail'),
      verified_unknown: count(row => valid(row) && row.verified_outcome === 'unknown'),
      quality: group.every(valid) ? mean(group.map(row => row.verified_outcome === 'pass' ? 1 : 0)) : null,
      input_mean: group.every(row => valid(row) && row.input_complete) ? mean(group.map(row => row.input_total)) : null,
      scorer_capped_mean_ms: group.every(valid) ? mean(group.map(row => row.scorer_capped_ms)) : null,
      input_known_subtotal: sum(group.map(row => row.input_known_subtotal)),
      output_known_subtotal: sum(group.map(row => row.output_known_subtotal)),
      known_actual_attempts: sum(group.map(row => row.known_actual_attempts)),
      all_usage_complete: group.every(row => row.usage_complete),
    };
  };
  const baseline = arm('B0'), candidate = arm(factor);
  const paired = input.pairs.filter(pair => pair.factor === factor).map(pair => {
    const get = label => rows.find(row => row.arm === label && row.case_alias === pair.case_alias && row.repeat === pair.repeat);
    const b = get('B0'), c = get(factor);
    const assessed = valid(b) && valid(c) && ['pass', 'fail'].includes(b.business_status) && ['pass', 'fail'].includes(c.business_status);
    const business_gain = assessed ? c.business_status === 'pass' && b.business_status === 'fail' : null;
    if (pair.route_gain === true) {
      assert.ok(valid(b) && valid(c)); assert.equal(b.business_status, 'pass'); assert.equal(c.business_status, 'pass');
      assert.equal(pair.full_journey_evidence_complete, true); assert.equal(pair.review_status, 'complete');
      assert.ok(typeof pair.baseline_detour_alias === 'string' && pair.baseline_detour_alias.length > 0);
    }
    return {pair_alias: pair.pair_alias, factor: pair.factor, case_alias: pair.case_alias, repeat: pair.repeat,
      new_critical_regression: pair.new_critical_regression, route_gain: pair.route_gain,
      baseline_detour_alias: pair.baseline_detour_alias, full_journey_evidence_complete: pair.full_journey_evidence_complete,
      review_status: pair.review_status, business_gain};
  });
  const repeated = cases.map(case_alias => {
    const two = paired.filter(pair => pair.case_alias === case_alias);
    assert.equal(two.length, 2);
    return {case_alias, business_gain_both_repeats: two.every(pair => pair.business_gain === true),
      route_gain_both_repeats: two.every(pair => pair.route_gain === true) && two[0].baseline_detour_alias === two[1].baseline_detour_alias};
  });
  const input_ratio = ratio(candidate.input_mean, baseline.input_mean);
  const time_ratio = ratio(candidate.scorer_capped_mean_ms, baseline.scorer_capped_mean_ms);
  return {factor, direction: `${factor}/B0`, baseline, candidate,
    quality_delta: candidate.quality === null || baseline.quality === null ? null : candidate.quality - baseline.quality,
    input_ratio, input_ratio_status: ratioStatus(candidate.input_mean, baseline.input_mean),
    scorer_capped_time_ratio: time_ratio, scorer_capped_time_ratio_status: ratioStatus(candidate.scorer_capped_mean_ms, baseline.scorer_capped_mean_ms),
    input_absolute_mean_difference: candidate.input_mean === null || baseline.input_mean === null ? null : candidate.input_mean - baseline.input_mean,
    scorer_capped_absolute_mean_difference_ms: candidate.scorer_capped_mean_ms === null || baseline.scorer_capped_mean_ms === null ? null : candidate.scorer_capped_mean_ms - baseline.scorer_capped_mean_ms,
    input_explanation_threshold_exceeded: input_ratio === null ? null : input_ratio > 1.10,
    time_explanation_threshold_exceeded: time_ratio === null ? null : time_ratio > 1.15,
    pairs: paired, repeated_gain: repeated,
    screening_checks: {candidate_four_valid_business_passes: candidate.valid_business_pass === 4,
      known_new_critical_regressions: paired.filter(pair => pair.new_critical_regression === true).length,
      unresolved_critical_pairs: paired.filter(pair => pair.new_critical_regression === null).length,
      repeatable_gain_present: repeated.some(row => row.business_gain_both_repeats || row.route_gain_both_repeats),
      complete_cost_comparison: input_ratio !== null && time_ratio !== null},
  };
});
const output = {schema_version: 1, kind: 'ah1336-public-arithmetic', planned_slots: 24, material_clusters: 1,
  comparison_direction: 'candidate divided by its own B0; quality is candidate minus its own B0',
  factors: summaries,
  ordinary_actual_cost: {input_known_subtotal: sum(input.slots.map(row => row.input_known_subtotal)),
    output_known_subtotal: sum(input.slots.map(row => row.output_known_subtotal)),
    known_actual_attempts: sum(input.slots.map(row => row.known_actual_attempts)),
    all_usage_complete: input.slots.every(row => row.usage_complete)},
  limitations: 'Arithmetic only. Cost explanations and adoption are reviewed conclusions, not inferred from token or tool counts. Private semantic evidence is not replayed.'};
const serialized = JSON.stringify(output, null, 2) + '\n';
if (process.argv.includes('--write')) {
  await writeFile(join(directory, 'arithmetic.json'), serialized);
  const columns = ['slot_alias','factor','arm','case_alias','repeat','slot_state','validity','business_status','verified_outcome','actual_attempts','input_total','output_total','observed_elapsed_ms','scorer_capped_ms','stop_code'];
  await writeFile(join(directory, 'slots.csv'), toCsv(input.slots, columns));
  console.log('Wrote arithmetic.json and slots.csv from the 24 public slots.');
} else {
  assert.equal(await readFile(join(directory, 'arithmetic.json'), 'utf8'), serialized);
  console.log('Verified public arithmetic for 24 planned slots and 12 pairs.');
}
