import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const known = value => value?.status === 'known' ? value.value : null;
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
function projectObservedGroups(groups) {
  const rows=[],scopes=[];
  for(const g of groups) {
    const episodes=g.input.episodes,valid=episodes.filter(e=>e.admission.status==='valid');
    rows.push(...episodes.map(usageRow));
    scopes.push({scope_id:g.scope_id,source_plan_sha256:g.source_plan_sha256,source_ledger_sha256:g.source_ledger_sha256,
      scientific_slots:g.analysis.completeness.planned_slots,dispatch_slots:g.dispatch_slots,actual_runs:episodes.length,
      admission_valid:valid.length,admission_invalid:episodes.length-valid.length,verified_success:valid.filter(e=>e.result.verified_success===true).length,
      valid_business_unknown:valid.filter(e=>e.result.outcome==='unknown').length,last_reason:g.last_reason,
      package:g.path,public_analysis_sha256:g.analysis.analysis_sha256,usage:summarizeUsage(episodes.map(usageRow))});
  }
  return {actual_new_observations:rows.length,scopes,usage:summarizeUsage(rows)};
}
const root=dirname(fileURLToPath(import.meta.url)),read=async p=>JSON.parse(await readFile(join(root,p)));
const manifest=await read('release-manifest.json'),checkpoint=await read('checkpoint.json'),lineage=await read('own20-lineage.json'),groups=[];
for(const d of manifest.packages){assert.match(d.path,/^packages\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);groups.push({...d,input:await read(d.path+'/analysis-input.json'),analysis:await read(d.path+'/analysis.json')});}
const observed=projectObservedGroups(groups);assert.deepEqual(checkpoint.new_observations,observed);assert.equal(observed.actual_new_observations,manifest.actual_new_observations);
assert.equal(checkpoint.accounting.physical_reservations,89+observed.actual_new_observations);assert.equal(manifest.physical_reservations,checkpoint.accounting.physical_reservations);assert.ok(manifest.physical_reservations<=139);assert.deepEqual(checkpoint.linked_history,manifest.linked_history);
assert.equal(lineage.rows.length,20);assert.equal(lineage.scientific_denominator,20);const own=groups[0];assert.equal(own.scientific_slots,20);assert.equal(own.dispatch_slots,8);assert.equal(lineage.current_primary_inputs,own.input.episodes.length);
for(let i=0;i<12;i++){assert.equal(lineage.rows[i].state,'linked_observation');assert.equal(lineage.rows[i].linked_public_observation.release_url,manifest.linked_history.url);}
const added=lineage.rows.slice(12).filter(r=>r.state==='closed_observation');assert.equal(added.length,own.input.episodes.length);const bytes=await readFile(join(root,own.path,'analysis-input.json')),sha=createHash('sha256').update(bytes).digest('hex');
for(const [i,row] of added.entries()){const e=own.input.episodes[i],r=row.public_episode_reference;assert.equal(row.run_id,e.identity.run_id);assert.equal(row.case_id,e.identity.case_id);assert.equal(row.condition_id,e.identity.condition_id);assert.deepEqual(row.admission,e.admission);assert.deepEqual(row.result,e.result);assert.deepEqual(row.usage,usageRow(e));assert.equal(row.source_episode_sha256,e.identity.public_projection.source_episode_sha256);assert.equal(r.public_episode_sha256,e.episode_sha256);assert.equal(r.public_file,own.path+'/analysis-input.json');assert.equal(r.public_file_sha256,sha);assert.equal(r.pointer,'/episodes/'+i);}
console.log(JSON.stringify({status:'verified',actual_new_observations:observed.actual_new_observations,physical_reservations:manifest.physical_reservations,packages:groups.length,usage:observed.usage,model_requests:0,scope:'public package statistics, incremental counts/costs and new Own lineage; prior89 remains linked'}));
