import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fingerprint } from './protocol.mjs';
import { readEvidenceBundle, verifyArtifactFiles } from './evidence/store.mjs';
import { readProviderTransport } from '../scripts/skill-consumption-provider.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const reference = async path => ({ path, sha256: sha(await readFile(path)) });
async function verified(ref) {
  const bytes = await readFile(ref.path); assert.equal(sha(bytes), ref.sha256, 'Repair evidence changed'); return JSON.parse(bytes);
}
function differences(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap(key => differences(a[key], b[key], path + '/' + key));
  }
  return [path];
}
function withoutQueryLease(projection) {
  const result = structuredClone(projection);
  for (const catalog of result.notion_catalogs.catalogs) for (const facet of catalog.facets)
    if (facet.facet === 'directory' && facet.value?.view_query) {
      delete facet.value.view_query.id; delete facet.value.view_query.expires_at;
    }
  return result;
}

export async function assertZeroSendInvalid({ episode, runtime, shared, rejection = 'startup_admission', environmentRoot }) {
  assert.equal(episode.admission.status, 'invalid');
  assert.equal(runtime.status, 'admission_rejected');
  assert.ok(['startup_admission', 'final_request_contract'].includes(rejection));
  assert.equal(runtime.error.code, rejection === 'startup_admission' ? 'BENCHMARK_ADMISSION_MISMATCH' : 'BENCHMARK_FINAL_REQUEST_CONTRACT_DRIFT');
  assert.equal(shared.runtime_check.status, 'unchanged'); assert.equal(shared.frozen_artifacts, 'passed');
  for (const key of ['attempts', 'tools', 'interventions']) assert.equal(episode.admission.completeness[key], 'complete');
  assert.equal(episode.measurements.actual_attempts.status, 'known'); assert.equal(episode.measurements.actual_attempts.value, 0);
  for (const key of ['input_total', 'output_total']) {
    assert.equal(episode.measurements[key].value.status, 'known'); assert.equal(episode.measurements[key].value.value, 0);
  }
  assert.equal(episode.timing.duration_ms.status, 'known');
  if (rejection === 'startup_admission') {
    assert.equal(runtime.requests.length, 0); assert.equal(runtime.turns.length, 0);
  } else {
    assert.ok(environmentRoot);
    assert.equal(runtime.correlation.run_id, episode.identity.run_id); assert.equal(runtime.correlation.episode_id, episode.identity.episode_id);
    assert.equal(runtime.correlation.candidate_id, episode.identity.condition_id); assert.equal(runtime.correlation.task_id, episode.identity.case_id);
    assert.equal(shared.run_id, episode.identity.run_id); assert.equal(shared.build_id, episode.identity.build_id);
    assert.equal(runtime.requests.length, 1); assert.equal(runtime.turns.length, 1);
    assert.equal(runtime.requests[0].attempts.length, 0); assert.equal(runtime.requests[0].accounted, true);
    assert.equal(runtime.requests[0].usage, null); assert.equal(runtime.turns[0].final_text, null);
    assert.equal(episode.attempts.length, 0); assert.equal(episode.tools.length, 0);
    for (const key of ['attempts', 'tools', 'input_tokens', 'output_tokens', 'tokens']) assert.equal(runtime.budget[key], 0);
    const artifacts = await verifyArtifactFiles(runtime.artifacts, { root: environmentRoot });
    const admission = JSON.parse(artifacts.get('admission-comparison').bytes);
    const catalog = JSON.parse(artifacts.get('first-request-catalog-comparison').bytes);
    const contract = JSON.parse(artifacts.get('first-request-contract-comparison').bytes);
    assert.deepEqual(admission.differences, [], 'The original startup admission must have passed');
    assert.deepEqual(catalog.differences, [], 'The original canonical catalog must have matched');
    assert.deepEqual(contract.differences.map(item => item.path), ['/messages'], 'Only the observed final-message contract rejection is repairable');
    const transport = await readProviderTransport(artifacts.get('transport').path);
    assert.equal(transport.at(-1).complete, true);
    assert.ok(!transport.some(event => event.phase === 'request_start' && event.category === 'model'), 'A model HTTP attempt is not a zero-send repair');
  }
  assert.equal(runtime.budget.usage_unknown, false);
}

/** This narrow repair never changes the admission or outcome of the rejected run. */
export async function verifyZeroSendRepair({ reference: ref, environmentRoot }) {
  const proof = await verified(ref);
  assert.equal(proof.version, 1); assert.equal(proof.kind, 'benchmark-query-lease-admission-repair');
  const priorPlan = await verified(proof.prior_plan), runtime = await verified(proof.prior_runtime), shared = await verified(proof.prior_shared);
  assert.equal(priorPlan.plan_sha256, proof.prior_plan.plan_sha256);
  assert.equal(priorPlan.plan_sha256, fingerprint({ ...priorPlan, plan_sha256: null }));
  const bundle = await readEvidenceBundle({ directory: proof.prior_bundle.directory, rawRoot: environmentRoot });
  assert.equal(bundle.episode.episode_sha256, proof.prior_bundle.episode_sha256);
  assert.equal(bundle.episode.identity.run_id, proof.run_id);
  await assertZeroSendInvalid({ episode: bundle.episode, runtime, shared });
  const expected = await verified(proof.prior_expectation), observed = await verified(proof.prior_observed);
  const actualDiff = differences(expected.projection, observed.projection);
  assert.deepEqual(actualDiff, proof.difference_paths);
  assert.equal(actualDiff.length, 2);
  assert.ok(actualDiff.every(path => /^\/notion_catalogs\/catalogs\/\d+\/facets\/\d+\/value\/view_query\/(id|expires_at)$/.test(path)));
  assert.deepEqual(withoutQueryLease(expected.projection), withoutQueryLease(observed.projection));
  const beforeBuild = await verified(proof.before_build), afterBuild = await verified(proof.after_build);
  assert.equal(beforeBuild.build_id, proof.before_build.id); assert.equal(afterBuild.build_id, proof.after_build.id);
  assert.notEqual(beforeBuild.build_id, afterBuild.build_id);
  assert.equal(beforeBuild.packages.cli.files.find(file => file.path === 'dist/sdk.js').sha256,
    afterBuild.packages.cli.files.find(file => file.path === 'dist/sdk.js').sha256, 'Repair must not change the selected product SDK');
  const observerBytes = await readFile(proof.after_observer.path);
  assert.equal(sha(observerBytes), proof.after_observer.sha256);
  const cells = new Set();
  for (const capture of proof.captures) {
    const expectation = await verified(capture.expectation), result = await verified(capture.runtime), parent = await verified(capture.shared);
    const actualArtifacts = await verifyArtifactFiles(result.artifacts, { root: environmentRoot });
    const observation = JSON.parse(actualArtifacts.get('candidate-observed').bytes);
    assert.deepEqual(observation.projection, expectation.projection, 'Expectation must be the actual captured candidate');
    const transport = await readProviderTransport(actualArtifacts.get('transport').path);
    assert.equal(transport.at(-1).complete, true);
    assert.ok(!transport.some(event => event.phase === 'request_start' && event.category === 'model'), 'No-model capture contains actual model transport');
    assert.equal(result.status, 'captured'); assert.equal(result.budget.attempts, 0); assert.equal(result.budget.tools, 0);
    assert.equal(parent.runtime_check.status, 'unchanged'); assert.equal(parent.frozen_artifacts, 'passed');
    assert.equal(expectation.projection.build.sha256, proof.after_build.sha256);
    assert.ok(capture.model_id.endsWith('/' + expectation.projection.model.id));
    const module = expectation.projection.visibility.projection.files.find(file => file.path === 'benchmark/runtime/episode-notion.mjs');
    assert.equal(module.sha256, proof.after_observer.sha256);
    if (expectation.projection.mode === 'broker') assert.deepEqual(expectation.projection.notion_catalogs,
      withoutQueryLease(observed.projection).notion_catalogs, 'New capture changed semantic catalog evidence');
    cells.add(capture.model_id + '/' + expectation.projection.mode);
  }
  assert.equal(cells.size, 6, 'Repair requires all three routes in both current conditions at zero sends');
  return proof;
}

export async function prepareZeroSendResumption({ setup, protocol, captures, currentSchedule }) {
  const request = setup.resume_after_zero_send;
  if (!request) return null;
  const prior = await read(request.plan_file);
  assert.equal(prior.plan_sha256, request.plan_sha256);
  assert.equal(prior.execution.pilot_ledger_root, setup.pilot_ledger_root);
  assert.deepEqual(currentSchedule, prior.slots, 'Continuation must preserve every original slot identity, order and seed');
  const ledger = (await readFile(join(dirname(request.plan_file), 'ledger.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const starts = ledger.filter(event => event.type === 'episode_started'), completed = ledger.filter(event => event.type === 'episode_completed');
  assert.equal(starts.length, 1); assert.equal(completed.length, 1);
  const item = completed[0]; assert.equal(item.run_id, request.run_id); assert.equal(item.slot_id, prior.slots[0].slot_id);
  const currentPair = protocol.pairs.find(pair => pair.id === prior.slots[0].pair_id);
  assert.ok(currentPair && currentPair.case_id === prior.slots[0].case_id);
  assert.deepEqual(protocol.models, prior.protocol.models, 'Route settings must remain unchanged during apparatus repair');
  const priorCandidate = prior.execution.conditions[item.condition_id];
  const firstCurrent = captures.find(capture => capture.candidate.mode === 'broker');
  assert.ok(firstCurrent);
  const root = item.result.run_root;
  const expectedRef = priorCandidate.expectations[item.case_id];
  const expected = await read(expectedRef.path), observedPath = join(root, 'benchmark/runtime/candidate-observed.json'), observed = await read(observedPath);
  const beforePath = join(setup.environment_root, 'builds', priorCandidate.build_id, 'build.json');
  const afterPath = join(setup.environment_root, 'builds', firstCurrent.candidate.build_id, 'build.json');
  const proof = { version: 1, kind: 'benchmark-query-lease-admission-repair', run_id: item.run_id,
    prior_plan: { ...await reference(request.plan_file), plan_sha256: prior.plan_sha256 },
    prior_runtime: await reference(join(root, 'benchmark/runtime/episode-result.json')),
    prior_shared: await reference(join(root, 'result.json')),
    prior_bundle: { directory: item.result.normalized_directory, episode_sha256: item.result.episode_sha256 },
    prior_expectation: expectedRef, prior_observed: await reference(observedPath),
    difference_paths: differences(expected.projection, observed.projection),
    before_build: { ...await reference(beforePath), id: priorCandidate.build_id },
    after_build: { ...await reference(afterPath), id: firstCurrent.candidate.build_id },
    after_observer: await reference(join(setup.environment_root, 'builds', firstCurrent.candidate.build_id, 'source/broker/benchmark/runtime/episode-notion.mjs')),
    captures: await Promise.all(captures.map(async capture => ({ model_id: capture.model.id, mode: capture.candidate.mode,
      expectation: capture.expectation, runtime: await reference(capture.raw.result_path),
      shared: await reference(join(capture.raw.root, 'result.json')) }))),
    classification: 'prior invalid retained; complete zero model sends; no business success or new observation inferred',
  };
  const path = join(setup.control_root, 'zero-send-repair.json'), bytes = JSON.stringify(proof, null, 2) + '\n';
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await readFile(path, 'utf8'), bytes); }
  const repair = { path, sha256: sha(bytes) };
  await verifyZeroSendRepair({ reference: repair, environmentRoot: setup.environment_root });
  return { version: 1, kind: 'benchmark-zero-send-resumption', prior_plan: proof.prior_plan, prior_run_id: item.run_id,
    excluded_slot_ids: [item.slot_id], repair,
    gate_policy: { version: 2, scope: 'shared-pilot-reservations-001-through-024', scheduled: 24,
      minimum_valid_real_per_model_mode: 3, prior_zero_send_invalid: [item.run_id],
      interpretation: 'apparatus coverage only; no quality or reliability acceptance',
      remaining_order: 'original deterministic schedule with only the named already-scheduled slot retained externally' } };
}
