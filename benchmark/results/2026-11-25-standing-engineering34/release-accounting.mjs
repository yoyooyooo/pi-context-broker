import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const known=value=>value?.status==='known'?value.value:null;
function episodeAccounting(episode) {
  const m = episode.measurements;
  return { model_requests: known(m.actual_attempts), input_tokens: known(m.input_total.value),
    output_tokens: known(m.output_total.value), duration_ms: known(episode.timing.duration_ms),
    known_model_requests: m.known_actual_attempts, known_input_tokens: m.input_total.known_subtotal,
    known_output_tokens: m.output_total.known_subtotal };
}
function summarizeUsage(rows) {
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
function usageRow(episode) {
  const a = episodeAccounting(episode);
  for (const key of ['model_requests','input_tokens','output_tokens','duration_ms'])
    assert.ok(a[key] === null || Number.isFinite(a[key]) && a[key] >= 0, 'INVALID_ORIGINAL_USAGE');
  for (const key of ['known_model_requests','known_input_tokens','known_output_tokens'])
    assert.ok(Number.isFinite(a[key]) && a[key] >= 0, 'INVALID_KNOWN_USAGE_SUBTOTAL');
  return { run_id: episode.identity.run_id, known_model_http_requests: a.known_model_requests, actual_model_http_requests: a.model_requests,
    known_input_subtotal: a.known_input_tokens, complete_input_tokens: a.input_tokens,
    known_output_subtotal: a.known_output_tokens, complete_output_tokens: a.output_tokens, duration_ms: a.duration_ms, currency_cost: null };
}
function assertOriginalCollector(episodes, collector) {
  assert.deepEqual(Object.keys(collector ?? {}).sort(), ['source_sha256', 'version'], 'BOUND_COLLECTOR_REQUIRED');
  assert.match(collector.version, /^\d+\.\d+\.\d+$/); assert.match(collector.source_sha256, /^[a-f0-9]{64}$/);
  for (const episode of episodes) {
    assert.equal(episode.identity.collector_version, collector.version, 'ORIGINAL_COLLECTOR_VERSION_CHANGED');
    assert.equal(episode.identity.collector_source_sha256, collector.source_sha256, 'ORIGINAL_COLLECTOR_SOURCE_CHANGED');
  }
}
function projectObservedGroups(groups) {
  const rows = [], scopes = [];
  for (const group of groups) {
    const episodes = group.input.episodes, valid = episodes.filter(episode => episode.admission.status === 'valid');
    assertOriginalCollector(episodes, group.collector);
    rows.push(...episodes.map(usageRow));
    scopes.push({ scope_id: group.scope_id, work_item_id: group.work_item_id, source_plan_sha256: group.source_plan_sha256,
      source_ledger_sha256: group.source_ledger_sha256, collector: group.collector, scientific_slots: group.analysis.completeness.planned_slots,
      dispatch_slots: group.dispatch_slots, actual_runs: episodes.length, admission_valid: valid.length, admission_invalid: episodes.length - valid.length,
      verified_success: valid.filter(episode => episode.result.verified_success === true).length,
      business_pass: valid.filter(episode => episode.business.status === 'pass').length,
      full_contract_pass: valid.filter(episode => episode.result.outcome === 'pass').length,
      full_contract_unknown: valid.filter(episode => episode.result.outcome === 'unknown').length, last_reason: group.last_reason,
      package: group.path, public_analysis_sha256: group.analysis.analysis_sha256, usage: summarizeUsage(episodes.map(usageRow)) });
  }
  return { actual_new_observations: rows.length, scopes, usage: summarizeUsage(rows) };
}
function assertPublicRelease({ manifest, checkpoint, lineage, groups }) {
  assert.equal(manifest.kind, 'standing-benchmark-public-release'); assert.equal(checkpoint.kind, 'standing-benchmark-public-checkpoint');
  assert.equal(lineage.kind, 'standing-benchmark-original-slot-lineage');
  assert.deepEqual(manifest.resource_policy, { mode: 'unbounded' }); assert.deepEqual(checkpoint.resource_policy, manifest.resource_policy);
  assert.deepEqual(checkpoint.collector, manifest.collector); assert.deepEqual(lineage.collector, manifest.collector);
  assert.equal(checkpoint.per_batch_user_approval_required, false); assert.equal(checkpoint.cross_condition_pooling, false);
  assert.equal(checkpoint.full_history_currency_cost, null); assert.equal(checkpoint.full_history_usage_complete, false);
  const observed = projectObservedGroups(groups); assert.ok(observed.actual_new_observations > 0);
  assert.deepEqual(checkpoint.new_observations, observed); assert.equal(manifest.actual_new_observations, observed.actual_new_observations);
  assert.ok(Number.isSafeInteger(checkpoint.accounting.prior_physical_reservations));
  assert.equal(checkpoint.accounting.physical_reservations, checkpoint.accounting.prior_physical_reservations + observed.actual_new_observations);
  assert.equal(manifest.physical_reservations, checkpoint.accounting.physical_reservations);
  assert.deepEqual(manifest.linked_history, checkpoint.linked_history); assert.deepEqual(lineage.condition_epoch, checkpoint.condition_epoch);
  assert.equal(lineage.groups.length, groups.length); const runIds = new Set(); let ordinal = checkpoint.accounting.prior_physical_reservations;
  for (const [index, group] of groups.entries()) {
    assert.deepEqual(group.collector, manifest.collector, 'PUBLIC_SCOPE_COLLECTOR_CHANGED');
    assert.equal(group.completed, group.input.episodes.length); assert.equal(group.scientific_slots, group.analysis.completeness.planned_slots);
    assert.equal(group.dispatch_slots, group.scientific_slots); assert.equal(group.input.protocol.policies.campaign.kind, 'benchmark-standing-campaign');
    assert.deepEqual(group.input.protocol.policies.campaign.resource_policy, { mode: 'unbounded' });
    for (const model of group.input.protocol.models) assert.deepEqual(model.backend.window, { mode: 'standing', start: checkpoint.condition_epoch.started_at, end: null });
    const linked = lineage.groups[index]; assert.equal(linked.scope_id, group.scope_id); assert.equal(linked.work_item_id, group.work_item_id);
    assert.equal(linked.rows.length, group.scientific_slots); assert.equal(linked.completed, group.completed);
    for (const [order, row] of linked.rows.entries()) {
      assert.equal(row.order, order); const episode = group.input.episodes[order];
      if (!episode) { assert.equal(row.state, 'unstarted'); continue; }
      assert.equal(row.state, 'closed_observation'); assert.equal(row.physical_ordinal, ++ordinal);
      assert.equal(row.run_id, episode.identity.run_id); assert.equal(episode.identity.experiment_id, group.input.protocol.id);
      assert.equal(row.case_id, episode.identity.case_id); assert.equal(row.condition_id, episode.identity.condition_id);
      assert.equal(row.source_episode_sha256, episode.identity.public_projection.source_episode_sha256);
      assert.equal(row.public_episode_sha256, episode.episode_sha256); assert.deepEqual(row.admission, episode.admission);
      assert.deepEqual(row.result, episode.result); assert.deepEqual(row.usage, usageRow(episode));
      assert.ok(!runIds.has(row.run_id)); runIds.add(row.run_id);
    }
  }
  assert.equal(ordinal, manifest.physical_reservations); return observed;
}
const root=dirname(fileURLToPath(import.meta.url)),read=async p=>JSON.parse(await readFile(join(root,p)));
const manifest=await read('release-manifest.json'),checkpoint=await read('checkpoint.json'),lineage=await read('standing-lineage.json'),groups=[];
for(const descriptor of manifest.packages){assert.match(descriptor.path,/^packages\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);groups.push({...descriptor,input:await read(descriptor.path+'/analysis-input.json'),analysis:await read(descriptor.path+'/analysis.json')});}
const observed=assertPublicRelease({manifest,checkpoint,lineage,groups});
console.log(JSON.stringify({status:'verified',actual_new_observations:observed.actual_new_observations,physical_reservations:manifest.physical_reservations,packages:groups.length,usage:observed.usage,model_requests:0,scope:'public original-slot lineage and resource accounting; prior results linked separately, without regrading or cross-condition pooling'}));
