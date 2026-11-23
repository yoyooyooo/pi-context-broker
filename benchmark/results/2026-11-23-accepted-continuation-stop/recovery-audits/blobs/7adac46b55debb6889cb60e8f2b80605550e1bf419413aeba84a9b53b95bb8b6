import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fingerprint } from './protocol.mjs';
import { readEvidenceBundle } from './evidence/store.mjs';
import { assertZeroSendInvalid, verifyZeroSendRepair } from './resumption.mjs';
import { assertScopePlan, readPilotScopeAmendment, readScopeCompletedResults, verifyPilotScope, scopeModelIdentity, scopeEnvironmentIdentity } from './pilot-scope.mjs';
import { isProspectiveCohort, assertCohortModelEvidence } from './prospective-cohort.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const modelGateIdentity = model => fingerprint({ provider: model.provider, route: model.route,
  api: model.api, parameters: model.parameters, adapter: model.adapter });
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const reference = async path => ({ path, sha256: sha(await readFile(path)) });
async function verified(ref) {
  const bytes = await readFile(ref.path); assert.equal(sha(bytes), ref.sha256, 'Gate source changed'); return JSON.parse(bytes);
}

function assertCore(episode) {
  assert.equal(episode.admission.status, 'valid', 'A core-invalid run cannot satisfy the route gate');
  for (const key of ['attempts', 'tools', 'interventions']) assert.equal(episode.admission.completeness[key], 'complete');
  assert.equal(episode.measurements.actual_attempts.status, 'known');
  assert.ok(episode.measurements.actual_attempts.value > 0, 'A zero-model probe is not a real route observation');
  for (const key of ['input_total', 'output_total']) assert.equal(episode.measurements[key].value.status, 'known');
  assert.equal(episode.timing.duration_ms.status, 'known');
  assert.ok(episode.attempts.filter(attempt => attempt.sent).every(attempt => attempt.adapter.verified));
}

/** Verify underlying files again; the word "passed" in a receipt is never sufficient. */
export async function verifyGateReference({ reference, environmentRoot }) {
  assert.ok(isAbsolute(reference.path));
  const bytes = await readFile(reference.path);
  assert.equal(sha(bytes), reference.sha256, 'Route gate receipt changed');
  const gate = JSON.parse(bytes);
  if (gate.kind === 'benchmark-cohort-gate') {
    assert.equal(gate.version, 1); assert.equal(gate.status, 'passed'); assert.equal(gate.core_evidence, 'complete');
    return verifyScopeGate(gate, environmentRoot);
  }
  assert.ok([1, 2, 3].includes(gate.version)); assert.equal(gate.kind, 'benchmark-route-gate');
  assert.equal(gate.status, 'passed'); assert.equal(gate.core_evidence, 'complete');
  if (gate.version === 3) return verifyScopeGate(gate, environmentRoot);
  assert.ok(Array.isArray(gate.episode_evidence) && gate.episode_evidence.length >= 24);
  assert.equal(new Set(gate.episode_evidence.map(item => item.run_id)).size, gate.episode_evidence.length);
  if (gate.version === 2) return verifyContinuationGate(gate, environmentRoot);
  for (const item of gate.episode_evidence) {
    const bundle = await readEvidenceBundle({ directory: item.directory, rawRoot: environmentRoot });
    assert.equal(bundle.episode.identity.run_id, item.run_id);
    assert.equal(bundle.episode.episode_sha256, item.episode_sha256);
    assertCore(bundle.episode);
  }
  return gate;
}

/** Business failures remain admissible: this gate certifies apparatus and accounting only. */
export async function writeRouteGate({ plan, status, outputFile }) {
  assert.ok(isAbsolute(outputFile));
  assert.equal(plan.protocol.phase, 'pilot');
  assert.equal(status.plan_sha256, plan.plan_sha256);
  assert.equal(status.unresolved_runs.length, 0);
  if (plan.execution.pilot_scope) return writeScopeGate({ plan, status, outputFile });
  if (plan.execution.resumption) return writeContinuationGate({ plan, status, outputFile });
  const required = plan.protocol.policies.pilot.route_gate_episodes;
  assert.equal(required, 24);
  assert.equal(plan.slots.length, required, 'The initial gate must be a separately frozen 24-episode batch');
  assert.equal(status.scheduled, required); assert.equal(status.completed, required);
  const evidence = [], coverage = new Map();
  for (const item of status.episodes) {
    assert.equal(item.result.stop_batch, false, 'A stopped core observation cannot satisfy the gate');
    const bundle = await readEvidenceBundle({ directory: item.result.normalized_directory, rawRoot: plan.execution.environment_root });
    const episode = bundle.episode;
    assertCore(episode);
    assert.equal(episode.episode_sha256, item.result.episode_sha256);
    const slot = plan.slots.find(slot => slot.slot_id === item.slot_id);
    assert.ok(slot); assert.equal(episode.identity.condition_id, slot.condition_id); assert.equal(episode.identity.case_id, slot.case_id);
    coverage.set(slot.condition_id, (coverage.get(slot.condition_id) ?? 0) + 1);
    evidence.push({ run_id: item.run_id, directory: item.result.normalized_directory, episode_sha256: episode.episode_sha256 });
  }
  assert.equal(plan.protocol.models.length, 3);
  assert.deepEqual([...new Set(plan.protocol.models.map(model => model.api))].sort(), ['openai-completions', 'openai-responses']);
  assert.deepEqual(plan.protocol.environments.map(environment => environment.pi.mode).sort(), ['broker', 'native']);
  for (const condition of plan.protocol.conditions) assert.equal(coverage.get(condition.id), condition.case_ids.length);
  const gate = { version: 1, kind: 'benchmark-route-gate', status: 'passed', core_evidence: 'complete',
    scope: 'actual route, maintained SDK, loading, transport and usage evidence; no quality acceptance implied',
    plan_sha256: plan.plan_sha256, protocol_sha256: plan.protocol.protocol_sha256, scheduled_episodes: status.scheduled,
    observer_version: plan.protocol.policies.evidence.observer_version,
    instrumentation: plan.execution.instrumentation,
    model_conditions: plan.protocol.models.map(modelGateIdentity),
    pi_sdk_sha256: [...new Set(plan.protocol.environments.map(environment => environment.runtime.pi.sha256))],
    condition_coverage: Object.fromEntries(coverage), episode_evidence: evidence,
    created_at: new Date().toISOString() };
  const bytes = JSON.stringify(gate, null, 2) + '\n';
  await writeFile(outputFile, bytes, { flag: 'wx', mode: 0o600 });
  const reference = { path: outputFile, sha256: sha(bytes) };
  await verifyGateReference({ reference, environmentRoot: plan.execution.environment_root });
  return { status: 'passed', reference, model_requests: 0, scheduled_episodes: status.scheduled };
}

async function verifyScopeGate(gate, environmentRoot) {
  const amendment = await readPilotScopeAmendment(gate.amendment);
  assert.equal(amendment.environment_root, environmentRoot); assert.equal(gate.scope_id, amendment.id);
  const cohort = isProspectiveCohort(amendment), required = amendment.gate.scheduled_episodes;
  assert.equal(gate.kind, cohort ? 'benchmark-cohort-gate' : 'benchmark-route-gate');
  assert.equal(gate.version, cohort ? 1 : 3);
  assert.equal(gate.scheduled_episodes, required); assert.equal(gate.episode_evidence.length, required);
  assert.deepEqual(gate.history_accounting, amendment.history);
  const plan = await verified(gate.current_plan);
  assert.equal(plan.plan_sha256, fingerprint({ ...plan, plan_sha256: null }));
  assertScopePlan(plan, amendment); assert.equal(plan.execution.pilot_scope.role, 'gate');
  assert.deepEqual(plan.execution.pilot_scope.amendment, gate.amendment);
  assert.deepEqual(gate.instrumentation, amendment.instrumentation);
  assert.equal(gate.observer_version, amendment.observer_version);
  const effective = await readScopeCompletedResults(plan);
  assert.deepEqual(gate.analysis_revision ?? null, effective.analysis_revision);
  const coverage = new Map(), seen = new Set(), ordinals = new Set(), slots = new Set();
  for (const item of gate.episode_evidence) {
    assert.ok(!seen.has(item.run_id)); seen.add(item.run_id);
    assert.ok(!ordinals.has(item.pilot_ordinal)); ordinals.add(item.pilot_ordinal);
    assert.ok(item.pilot_ordinal > amendment.history.scheduled_episodes && item.pilot_ordinal <= 144);
    assert.equal(item.reservation.path, join(amendment.pilot_ledger_root, String(item.pilot_ordinal).padStart(3, '0') + '.json'));
    const reservation = await verified(item.reservation);
    assert.equal(reservation.run_id, item.run_id); assert.equal(reservation.experiment_id, plan.id);
    assert.equal(reservation.scope_amendment_sha256, amendment.amendment_sha256);
    assert.deepEqual(reservation.plan, gate.current_plan);
    const slot = plan.slots.find(slot => slot.slot_id === reservation.slot_id); assert.ok(slot);
    assert.ok(!slots.has(slot.slot_id), 'Scope gate repeats a scheduled slot'); slots.add(slot.slot_id);
    const events = effective.completed.filter(row => row.run_id === item.run_id);
    assert.equal(events.length, 1); assert.equal(events[0].slot_id, slot.slot_id); assert.equal(events[0].result.stop_batch, false);
    assert.equal(events[0].result.normalized_directory, item.directory); assert.equal(events[0].result.episode_sha256, item.episode_sha256);
    const provenance = events[0].revision_provenance;
    assert.deepEqual(item.analysis_revision ?? null, provenance?.analysis_revision ?? null);
    assert.equal(item.original_episode_sha256, provenance?.original_episode_sha256);
    assert.equal(item.original_directory, provenance?.original_directory);
    const { episode } = await readEvidenceBundle({ directory: item.directory, rawRoot: environmentRoot });
    assertCore(episode); assert.equal(episode.episode_sha256, item.episode_sha256);
    assert.equal(episode.identity.run_id, item.run_id); assert.equal(episode.identity.experiment_id, plan.id);
    assert.equal(episode.identity.condition_id, slot.condition_id); assert.equal(episode.identity.case_id, slot.case_id);
    const condition = plan.protocol.conditions.find(condition => condition.id === slot.condition_id);
    const environment = plan.protocol.environments.find(environment => environment.id === condition.environment_id);
    const model = plan.protocol.models.find(model => model.id === condition.model_id);
    assert.equal(episode.identity.model_id, model.id); assert.equal(episode.identity.environment_sha256, environment.manifest_sha256);
    if (cohort) assertCohortModelEvidence(episode, model);
    assert.equal(episode.identity.build_id, environment.build.id);
    const files = episode.identity.analysis_implementation.files.map(({ artifact_id, ...file }) => file);
    assert.deepEqual(files, gate.instrumentation.collector_files);
    const key = scopeModelIdentity(model) + '/' + scopeEnvironmentIdentity(environment);
    coverage.set(key, (coverage.get(key) ?? 0) + 1);
  }
  assert.equal(coverage.size, cohort ? amendment.model_count * 2 : 4);
  for (const count of coverage.values()) assert.equal(count, amendment.gate.minimum_valid_real_per_condition);
  assert.deepEqual(Object.fromEntries(coverage), gate.condition_coverage);
  assert.deepEqual(gate.model_conditions, amendment.model_conditions);
  assert.deepEqual(gate.environment_conditions, amendment.environment_conditions);
  return gate;
}

async function writeScopeGate({ plan, status, outputFile }) {
  assert.equal(plan.execution.pilot_scope.role, 'gate');
  const amendment = await verifyPilotScope(plan);
  const cohort = isProspectiveCohort(amendment), required = amendment.gate.scheduled_episodes;
  const effective = await readScopeCompletedResults(plan);
  assert.deepEqual(status.analysis_revision ?? null, effective.analysis_revision);
  assert.equal(status.scheduled, required); assert.equal(status.completed, required); assert.equal(status.not_dispatched.length, 0);
  const currentPlan = await reference(join(plan.execution.control_root, 'plan.json'));
  const evidence = [], coverage = new Map();
  for (const item of status.episodes) {
    assert.equal(item.result.stop_batch, false);
    const recorded = effective.completed.filter(event => event.run_id === item.run_id);
    assert.equal(recorded.length, 1); assert.equal(recorded[0].slot_id, item.slot_id);
    assert.deepEqual(item.result, recorded[0].result, 'Scope gate status differs from registered analysis');
    const slot = plan.slots.find(slot => slot.slot_id === item.slot_id); assert.ok(slot);
    const condition = plan.protocol.conditions.find(condition => condition.id === slot.condition_id);
    const environment = plan.protocol.environments.find(environment => environment.id === condition.environment_id);
    const model = plan.protocol.models.find(model => model.id === condition.model_id);
    const key = scopeModelIdentity(model) + '/' + scopeEnvironmentIdentity(environment);
    coverage.set(key, (coverage.get(key) ?? 0) + 1);
    let reservation;
    for (let ordinal = amendment.history.scheduled_episodes + 1; ordinal <= 144; ordinal++) {
      const path = join(amendment.pilot_ledger_root, String(ordinal).padStart(3, '0') + '.json');
      let value; try { value = await read(path); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
      if (value.run_id === item.run_id) { reservation = { pilot_ordinal: ordinal, reservation: await reference(path) }; break; }
    }
    assert.ok(reservation, 'Scope gate observation has no shared reservation');
    evidence.push({ ...reservation, run_id: item.run_id, directory: item.result.normalized_directory, episode_sha256: item.result.episode_sha256,
      ...(recorded[0].revision_provenance ?? {}) });
  }
  const gate = { version: cohort ? 1 : 3, kind: cohort ? 'benchmark-cohort-gate' : 'benchmark-route-gate', status: 'passed', core_evidence: 'complete',
    scope: cohort ? 'current cohort apparatus and accounting only; historical observations excluded; no business-quality acceptance'
      : 'prospective two-model apparatus coverage; original first24 remains incomplete; no business-quality acceptance',
    scope_id: amendment.id, amendment: plan.execution.pilot_scope.amendment, current_plan: currentPlan,
    scheduled_episodes: required, observer_version: amendment.observer_version, instrumentation: amendment.instrumentation,
    ...(effective.analysis_revision ? { analysis_revision: effective.analysis_revision } : {}),
    model_conditions: amendment.model_conditions, environment_conditions: amendment.environment_conditions,
    condition_coverage: Object.fromEntries(coverage), episode_evidence: evidence,
    history_accounting: amendment.history, created_at: new Date().toISOString() };
  await verifyScopeGate(gate, plan.execution.environment_root);
  const bytes = JSON.stringify(gate, null, 2) + '\n'; await writeFile(outputFile, bytes, { flag: 'wx', mode: 0o600 });
  return { status: 'passed', reference: { path: outputFile, sha256: sha(bytes) }, model_requests: 0, scheduled_episodes: required,
    scope_id: amendment.id, ...(cohort ? {} : { legacy_first24: 'incomplete_not_satisfied' }), historical_usage: amendment.history.total_usage_status };
}

async function verifyContinuationGate(gate, environmentRoot) {
  assert.equal(gate.scheduled_episodes, 24); assert.equal(gate.episode_evidence.length, 24);
  const current = await verified(gate.current_plan), resumption = current.execution.resumption;
  assert.ok(resumption); assert.equal(current.plan_sha256, fingerprint({ ...current, plan_sha256: null }));
  assert.deepEqual(gate.policy, resumption.gate_policy);
  let expectedInstrumentation = current.execution.instrumentation;
  if (gate.analysis_revision) {
    const { verifyAnalysisRevision } = await import('./revision.mjs');
    const revision = await verifyAnalysisRevision({ reference: gate.analysis_revision, plan: current });
    expectedInstrumentation = revision.instrumentation;
  }
  assert.deepEqual(gate.instrumentation, expectedInstrumentation);
  assert.equal(gate.policy.minimum_valid_real_per_model_mode, 3);
  const repair = await verifyZeroSendRepair({ reference: resumption.repair, environmentRoot });
  const coverage = new Map(); let retained = 0;
  for (const [index, item] of gate.episode_evidence.entries()) {
    assert.equal(item.pilot_ordinal, index + 1);
    assert.equal(item.reservation.path, join(current.execution.pilot_ledger_root, String(index + 1).padStart(3, '0') + '.json'));
    const reservation = await verified(item.reservation), owner = await verified(item.plan);
    assert.equal(owner.plan_sha256, fingerprint({ ...owner, plan_sha256: null }));
    assert.equal(reservation.run_id, item.run_id); assert.equal(reservation.experiment_id, owner.id);
    const slot = owner.slots.find(slot => slot.slot_id === reservation.slot_id); assert.ok(slot);
    const bundle = await readEvidenceBundle({ directory: item.directory, rawRoot: environmentRoot }), episode = bundle.episode;
    assert.equal(episode.episode_sha256, item.episode_sha256); assert.equal(episode.identity.run_id, item.run_id);
    assert.equal(episode.identity.experiment_id, owner.id); assert.equal(episode.identity.case_id, slot.case_id);
    assert.equal(episode.identity.condition_id, slot.condition_id);
    if (item.kind === 'retained_zero_send_invalid') {
      assert.equal(item.run_id, repair.run_id); assert.equal(item.pilot_ordinal, 1);
      await assertZeroSendInvalid({ episode, runtime: await verified(repair.prior_runtime), shared: await verified(repair.prior_shared) });
      retained++; continue;
    }
    assert.equal(item.kind, 'current_valid_real'); assert.equal(owner.plan_sha256, current.plan_sha256);
    assertCore(episode);
    const condition = current.protocol.conditions.find(condition => condition.id === slot.condition_id);
    const environment = current.protocol.environments.find(environment => environment.id === condition.environment_id);
    const model = current.protocol.models.find(model => model.id === condition.model_id);
    assert.equal(episode.identity.environment_sha256, environment.manifest_sha256);
    assert.equal(episode.identity.build_id, environment.build.id);
    const collectorFiles = episode.identity.analysis_implementation.files.map(({ artifact_id, ...file }) => file);
    assert.deepEqual(collectorFiles, gate.instrumentation.collector_files);
    const key = modelGateIdentity(model) + '/' + environment.manifest_sha256;
    coverage.set(key, (coverage.get(key) ?? 0) + 1);
  }
  assert.equal(retained, 1); assert.equal(coverage.size, 6);
  for (const count of coverage.values()) assert.ok(count >= 3, 'A current model/environment route lacks actual coverage');
  assert.deepEqual(Object.fromEntries(coverage), gate.condition_coverage);
  assert.deepEqual(gate.model_conditions, current.protocol.models.map(modelGateIdentity));
  assert.deepEqual(gate.pi_sdk_sha256, [...new Set(current.protocol.environments.map(environment => environment.runtime.pi.sha256))]);
  return gate;
}

async function writeContinuationGate({ plan, status, outputFile }) {
  const resumption = plan.execution.resumption;
  assert.equal(status.scheduled, 23); assert.equal(status.completed, 23);
  assert.equal(status.not_dispatched.length, 1);
  assert.equal(status.not_dispatched[0].prior_run_id, resumption.prior_run_id);
  const repair = await verifyZeroSendRepair({ reference: resumption.repair, environmentRoot: plan.execution.environment_root });
  const prior = await verified(resumption.prior_plan);
  const priorLedger = (await readFile(join(dirname(resumption.prior_plan.path), 'ledger.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const priorItem = priorLedger.find(event => event.type === 'episode_completed' && event.run_id === repair.run_id);
  assert.ok(priorItem);
  const currentPlanRef = await reference(join(plan.execution.control_root, 'plan.json'));
  let instrumentation = plan.execution.instrumentation;
  if (status.analysis_revision) {
    const { verifyAnalysisRevision } = await import('./revision.mjs');
    const revision = await verifyAnalysisRevision({ reference: status.analysis_revision, plan });
    instrumentation = revision.instrumentation;
  }
  const evidence = [], coverage = new Map();
  for (let ordinal = 1; ordinal <= 24; ordinal++) {
    const path = join(plan.execution.pilot_ledger_root, String(ordinal).padStart(3, '0') + '.json'), reservation = await read(path);
    const previous = reservation.run_id === repair.run_id;
    const item = previous ? priorItem : status.episodes.find(item => item.run_id === reservation.run_id);
    assert.ok(item, 'Every reservation in the first 24 must have a complete retained result');
    const bundle = await readEvidenceBundle({ directory: item.result.normalized_directory, rawRoot: plan.execution.environment_root });
    if (!previous) {
      assertCore(bundle.episode);
      const slot = plan.slots.find(slot => slot.slot_id === item.slot_id), condition = plan.protocol.conditions.find(condition => condition.id === slot.condition_id);
      const environment = plan.protocol.environments.find(environment => environment.id === condition.environment_id);
      const model = plan.protocol.models.find(model => model.id === condition.model_id);
      const key = modelGateIdentity(model) + '/' + environment.manifest_sha256;
      coverage.set(key, (coverage.get(key) ?? 0) + 1);
    }
    evidence.push({ pilot_ordinal: ordinal, reservation: await reference(path), run_id: item.run_id,
      plan: previous ? resumption.prior_plan : currentPlanRef, kind: previous ? 'retained_zero_send_invalid' : 'current_valid_real',
      directory: item.result.normalized_directory, episode_sha256: bundle.episode.episode_sha256 });
  }
  assert.equal(prior.id, (await read(resumption.prior_plan.path)).id);
  const gate = { version: 2, kind: 'benchmark-route-gate', status: 'passed', core_evidence: 'complete',
    scope: 'complete accounting of shared reservations 001–024; current actual route coverage; no quality acceptance',
    current_plan: currentPlanRef, policy: resumption.gate_policy, repair: resumption.repair,
    scheduled_episodes: 24, current_valid_real_episodes: 23, retained_invalid_zero_send_episodes: 1,
    observer_version: plan.protocol.policies.evidence.observer_version,
    instrumentation, ...(status.analysis_revision ? { analysis_revision: status.analysis_revision } : {}),
    model_conditions: plan.protocol.models.map(modelGateIdentity),
    pi_sdk_sha256: [...new Set(plan.protocol.environments.map(environment => environment.runtime.pi.sha256))],
    condition_coverage: Object.fromEntries(coverage), episode_evidence: evidence, created_at: new Date().toISOString() };
  await verifyContinuationGate(gate, plan.execution.environment_root);
  const bytes = JSON.stringify(gate, null, 2) + '\n'; await writeFile(outputFile, bytes, { flag: 'wx', mode: 0o600 });
  return { status: 'passed', reference: { path: outputFile, sha256: sha(bytes) }, model_requests: 0,
    scheduled_episodes: 24, current_valid_real_episodes: 23, retained_invalid_zero_send_episodes: 1 };
}
