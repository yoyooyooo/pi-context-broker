import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const count = values => Object.fromEntries([...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map())].sort());
const digest = value => assert.match(value, /^[a-f0-9]{64}$/);

function usage(rows, side) {
  const total = { known_model_requests: 0, complete_episode_input_fields: 0, complete_episode_output_fields: 0,
    known_attempt_input_lower_bound: 0, known_attempt_output_lower_bound: 0, known_duration_ms: 0, unknown_usage_ordinals: [] };
  for (const row of rows) {
    const value = row[side].usage;
    for (const [key, number] of Object.entries(value)) assert.ok(number === null || Number.isFinite(number) && number >= 0, 'INVALID_USAGE:' + key);
    for (const key of ['known_model_requests', 'known_input_subtotal', 'known_output_subtotal']) assert.ok(Number.isSafeInteger(value[key]));
    total.known_model_requests += value.known_model_requests;
    total.complete_episode_input_fields += value.complete_input_tokens ?? 0;
    total.complete_episode_output_fields += value.complete_output_tokens ?? 0;
    total.known_attempt_input_lower_bound += value.known_input_subtotal;
    total.known_attempt_output_lower_bound += value.known_output_subtotal;
    total.known_duration_ms += value.duration_ms ?? 0;
    if ([value.actual_model_requests, value.complete_input_tokens, value.complete_output_tokens, value.duration_ms].includes(null))
      total.unknown_usage_ordinals.push(row.ordinal);
    assert.equal(value.currency_cost, null);
  }
  return total;
}

export function recomputeCensus(census) {
  assert.equal(census.version, 1); assert.equal(census.kind, 'retained-benchmark-evidence-comparison-census');
  assert.equal(census.model_requests, 0); assert.equal(census.cross_stratum_pooling, false);
  assert.equal(census.historical_primary_statistics_replaced, false);
  assert.equal(census.rows.length, census.historical_release.observations);
  const strata = new Map(census.strata.map(item => [item.id, item])); assert.equal(strata.size, census.strata.length);
  const runIds = new Set(), changes = [], recovered = [], resources = [], selections = [], clarification = [], unknownResources = [];
  for (const [index, row] of census.rows.entries()) {
    assert.equal(row.ordinal, index + 1); assert.ok(!runIds.has(row.observation_id)); runIds.add(row.observation_id);
    const stratum = strata.get(row.stratum_id); assert.ok(stratum);
    for (const side of ['original', 'reanalysis']) {
      digest(row[side].collector.source_sha256); digest(row[side].episode_sha256);
      assert.equal(row[side].normalizer_version, stratum.normalizer[side]);
      assert.ok(['valid', 'invalid'].includes(row[side].admission));
      assert.ok(['pass', 'fail', 'unknown', 'not_applicable'].includes(row[side].outcome));
    }
    assert.deepEqual(row.reanalysis.collector, census.reanalysis_collector);
    assert.equal(row.original.admission, row.reanalysis.admission, 'ORIGINAL_ADMISSION_CHANGED');
    assert.equal(row.original.business_status, row.reanalysis.business_status, 'ORIGINAL_BUSINESS_CHANGED');
    assert.deepEqual(row.original.usage, row.reanalysis.usage, 'ORIGINAL_USAGE_CHANGED');
    if (row.original.admission === 'invalid') assert.equal(row.reanalysis.outcome, 'not_applicable');
    if (row.original.outcome === 'fail') assert.equal(row.reanalysis.outcome, 'fail', 'ORIGINAL_FAILURE_CHANGED');
    if (row.original.outcome === 'unknown' && row.reanalysis.outcome === 'pass') recovered.push(row.ordinal);
    const before = new Map(row.original.contracts.map(item => [item.id, item])), after = new Map(row.reanalysis.contracts.map(item => [item.id, item]));
    assert.equal(before.size, row.original.contracts.length); assert.equal(after.size, row.reanalysis.contracts.length);
    assert.deepEqual([...before.keys()].sort(), [...after.keys()].sort());
    for (const [id, old] of before) {
      const next = after.get(id); assert.equal(old.kind, next.kind); assert.equal(old.oracle_sha256, next.oracle_sha256);
      assert.equal(old.critical, next.critical);
      if (old.status === 'fail') assert.equal(next.status, 'fail', 'ORIGINAL_CONTRACT_FAILURE_CHANGED');
      if (old.kind === 'clarification') { assert.equal(old.status, next.status, 'UNOBSERVED_CLARIFICATION_RECLASSIFIED'); if (next.status === 'unknown') clarification.push(row.ordinal); }
      if (old.status !== next.status) {
        changes.push({ ordinal: row.ordinal, id, kind: old.kind, before: old.status, after: next.status });
        if (old.kind === 'resources' && next.status === 'pass') resources.push(row.ordinal);
        if (old.kind === 'selection' && next.status === 'pass') selections.push(row.ordinal);
      }
      if (old.kind === 'resources' && next.status === 'unknown') unknownResources.push({ ordinal: row.ordinal, contract: id,
        boundaries: row.evidence_boundaries.map(item => item.code) });
    }
    for (const field of ['original_episode_file_sha256', 'reanalysis_input_file_sha256', 'reanalysis_file_sha256', 'reanalysis_readback_file_sha256']) digest(row.references[field]);
    assert.equal(row.references.reanalysis_file_sha256, stratum.analysis.file_sha256);
    assert.equal(row.references.reanalysis_input_file_sha256, stratum.analysis.input_file_sha256);
    assert.match(row.references.reanalysis_input_locator.pointer, /^\/episodes\/\d+$/);
    for (const boundary of row.evidence_boundaries) if (boundary.code === 'opaque_or_failed_tool_observation') {
      assert.ok(Array.isArray(boundary.tools) && boundary.tools.length > 0, 'OPAQUE_TOOL_METADATA_MISSING');
      for (const tool of boundary.tools) {
        assert.ok(typeof tool.name === 'string' && tool.name.length > 0, 'OPAQUE_TOOL_NAME_MISSING');
        assert.ok(typeof tool.status === 'string' && typeof tool.execution === 'string', 'OPAQUE_TOOL_STATUS_MISSING');
        digest(tool.tool_id_sha256);
        assert.ok(tool.analysis_input_locator.pointer.startsWith(row.references.reanalysis_input_locator.pointer + '/tools/'));
      }
    }
  }
  for (const stratum of strata.values()) {
    const rows = census.rows.filter(row => row.stratum_id === stratum.id);
    assert.equal(rows.length, stratum.observations); assert.ok(rows.length <= stratum.planned_scientific_slots);
    assert.equal(stratum.normalizer.explicit_new_analysis_stratum, stratum.normalizer.original !== stratum.normalizer.reanalysis);
    digest(stratum.analysis.semantic_sha256); digest(stratum.original_plan_file_sha256);
  }
  const oldUsage = usage(census.rows, 'original'), newUsage = usage(census.rows, 'reanalysis');
  assert.deepEqual(oldUsage, newUsage);
  const reported = census.historical_reported_subtotal;
  assert.equal(oldUsage.known_model_requests, reported.model_requests);
  assert.equal(oldUsage.complete_episode_input_fields, reported.input_tokens);
  assert.equal(oldUsage.complete_episode_output_fields, reported.output_tokens);
  assert.ok(Math.abs(oldUsage.known_duration_ms - reported.duration_ms) < 0.000001);
  const normalizeCounts = count(census.rows.map(row => row.original.normalizer_version + ' -> ' + row.reanalysis.normalizer_version));
  return { version: 1, kind: 'retained-benchmark-census-recomputed-summary', observations: census.rows.length, analysis_strata: strata.size,
    original_collector_versions: count(census.rows.map(row => row.original.collector.version)),
    normalizer_strata: normalizeCounts, original_outcomes: count(census.rows.map(row => row.original.outcome)),
    reanalysis_outcomes: count(census.rows.map(row => row.reanalysis.outcome)), admission: count(census.rows.map(row => row.original.admission)),
    business_status: count(census.rows.map(row => row.original.business_status)),
    original_contracts: count(census.rows.flatMap(row => row.original.contracts.map(item => item.kind + ':' + item.status))),
    reanalysis_contracts: count(census.rows.flatMap(row => row.reanalysis.contracts.map(item => item.kind + ':' + item.status))),
    contract_changes: count(changes.map(row => row.kind + ':' + row.before + '>' + row.after)), changed_contracts: changes,
    recovered_outcome_ordinals: recovered, recovered_resource_ordinals: [...new Set(resources)], recovered_selection_ordinals: [...new Set(selections)],
    clarification_unknown_ordinals: [...new Set(clarification)], remaining_unknown_resources: unknownResources,
    evidence_boundaries: count(census.rows.flatMap(row => row.evidence_boundaries.map(item => item.code))),
    usage: oldUsage, historical_reported_subtotal: reported,
    partial_usage_addition: { input_tokens: oldUsage.known_attempt_input_lower_bound - oldUsage.complete_episode_input_fields,
      output_tokens: oldUsage.known_attempt_output_lower_bound - oldUsage.complete_episode_output_fields },
    original_admission_business_usage_and_failures_preserved: true, model_requests: 0, private_graders_replayed: false,
    cross_stratum_pooling: false, historical_primary_statistics_replaced: false,
    scope: 'Arithmetic and consistency of the included comparison census; external source fingerprints are references, not reproduced private evidence.' };
}

export async function replayCensus({ root, output, manifestSha256 }) {
  const manifestBytes = await readFile(join(root, 'manifest.json'));
  assert.equal(sha(manifestBytes), manifestSha256, 'PUBLIC_MANIFEST_CHANGED');
  const manifest = JSON.parse(manifestBytes); assert.equal(manifest.kind, 'benchmark-public-evidence-comparison-census');
  assert.equal(manifest.manifest_sha256, sha(JSON.stringify({ ...manifest, manifest_sha256: null })));
  const names = (await readdir(root)).sort(); assert.deepEqual(names, [...manifest.files.map(item => item.path), 'manifest.json'].sort());
  for (const item of manifest.files) {
    assert.match(item.path, /^[A-Za-z0-9._-]+$/); const path = join(root, item.path), stat = await lstat(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink()); const bytes = await readFile(path);
    assert.equal(bytes.length, item.bytes); assert.equal(sha(bytes), item.sha256, 'PUBLIC_FILE_CHANGED:' + item.path);
  }
  const census = JSON.parse(await readFile(join(root, 'census.json'))), expected = JSON.parse(await readFile(join(root, 'summary.json')));
  const result = recomputeCensus(census); assert.deepEqual(result, expected, 'PUBLIC_CENSUS_SUMMARY_CHANGED');
  assert.ok(isAbsolute(output) && resolve(output) === output); await mkdir(output);
  await writeFile(join(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return { status: 'verified', observations: result.observations, analysis_strata: result.analysis_strata,
    manifest_sha256: manifestSha256, summary_sha256: sha(await readFile(join(output, 'summary.json'))),
    model_requests: 0, private_graders_replayed: false, external_raw_replayed: false, source_observations_reexecuted: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, 'manifest-sha256': { type: 'string' } } });
  const result = await replayCensus({ root: dirname(fileURLToPath(import.meta.url)), output: values.out, manifestSha256: values['manifest-sha256'] });
  console.log(JSON.stringify(result));
}
