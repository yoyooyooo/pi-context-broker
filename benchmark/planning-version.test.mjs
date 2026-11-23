import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fingerprint } from './protocol.mjs';
import { createPreregistrationTemplate } from './templates/preregistration.mjs';
import { boundedBudget, comparisonEnvironmentPairs, comparisonPairs, preregisterComparison } from './planning.mjs';
import { freezeBatchPlan, validateBatchPlan, scheduleProtocol } from './batch.mjs';
import { EVIDENCE_VERSION, normalizeEpisode } from './evidence/normalize.mjs';
import { ANALYSIS_VERSION, scoreExperiment } from './analysis/compare.mjs';
import { exampleEnvelope } from './analysis/fixtures.mjs';

// Synthetic in-memory observations only; these tests never execute a model or write run state.
function comparisonInputs() {
  const draft = createPreregistrationTemplate(), hash = fingerprint({ synthetic: 'planning-version' });
  for (const environment of draft.environments) {
    environment.status = 'frozen'; environment.build.id = 'synthetic'; environment.build.receipt_sha256 = hash;
    for (const artifact of [environment.build.cli, environment.build.broker])
      for (const key of Object.keys(artifact)) artifact[key] = key === 'commit' ? '1'.repeat(40) : hash;
    for (const [name, runtime] of Object.entries(environment.runtime))
      Object.assign(runtime, { entry: '/synthetic/' + name, version: '1.0.0', sha256: hash });
    environment.pi.entry = environment.runtime.pi.entry;
    for (const key of Object.keys(environment.pi)) if (key.endsWith('_sha256')) environment.pi[key] = hash;
    for (const extension of environment.pi.extensions) extension.sha256 = hash;
    environment.manifest_sha256 = fingerprint({ ...environment, manifest_sha256: null });
  }
  Object.assign(draft.models[0].adapter, { verification: 'verified', evidence_sha256: hash });
  return { id: 'planning-version', phase: 'regression', purpose: draft.purpose,
    environments: draft.environments, models: draft.models, corpus: draft.corpus,
    cases: draft.corpus.cases.map(protocol_case => ({ id: protocol_case.id, protocol_case })),
    budget: boundedBudget({ id: 'version-budget', episodes: 2, durationMs: 1000, requests: 2,
      inputTokens: 1000, outputTokens: 1000, batchDurationMs: 10000 }),
    decision: { ...draft.policies.decision, absolute_quality_required: 0.8, unassisted_quality_required: 0.8,
      input_ratio_max: 1.1, capped_time_ratio_max: 1.15 },
    allowedChanges: draft.allowed_changes, registeredAt: '2026-11-23T00:00:00Z' };
}

function freeze(protocol) {
  return freezeBatchPlan({ protocol, registeredAt: protocol.registered_at,
    execution: { environment_root: '/synthetic/planning-version', control_root: '/synthetic/planning-version/' + protocol.id } });
}

function observedEpisodes(plan) {
  return plan.slots.map(slot => {
    const { input } = exampleEnvelope({ condition: slot.condition_id, caseId: slot.case_id, repeat: slot.repeat });
    input.identity.experiment_id = plan.protocol.id;
    return normalizeEpisode(input).episode;
  });
}

function freezeObject(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeObject(child);
    Object.freeze(value);
  }
  return value;
}

test('explicit two-environment orientation preserves the complete legacy protocol and schedule', () => {
  const input = comparisonInputs(), original = preregisterComparison(input);
  const explicit = preregisterComparison({ ...input, environmentPairs: [[0, 1]] });
  assert.deepEqual(explicit, original);
  assert.deepEqual(scheduleProtocol(explicit), scheduleProtocol(original));
});

test('four environments require two disjoint, complete candidate/reference orientations', () => {
  const cases = [{ id: 'case-a' }, { id: 'case-b' }], models = [{ id: 'model' }];
  const pairs = comparisonPairs({ models, cases, environmentCount: 4, environmentPairs: [[0, 1], [2, 3]], orderingSeed: 19 });
  assert.equal(pairs.length, 4);
  for (const item of cases) assert.deepEqual(pairs.filter(pair => pair.case_id === item.id).map(pair => pair.condition_ids),
    [['m0-e0', 'm0-e1'], ['m0-e2', 'm0-e3']]);
  const slots = scheduleProtocol({ pairs, assessments: [], policies: { ordering: { seed: 19 } } });
  assert.equal(slots.length, 8); assert.equal(new Set(slots.map(slot => slot.slot_id)).size, 8);
  for (const invalid of [undefined, [[0, 1]], [[0, 1], [1, 2]], [[0, 1], [2, 4]], [[0, 1, 2], [3]]])
    assert.throws(() => comparisonEnvironmentPairs(4, invalid));
  assert.throws(() => comparisonEnvironmentPairs(3, [[0, 1]]));
});

test('four-condition registration retains fresh free/off cells as independent frozen samples', () => {
  const input = comparisonInputs();
  const off = input.environments.map(environment => {
    const copy = structuredClone(environment); copy.id += '-off'; copy.policies.code_mode = 'off';
    copy.manifest_sha256 = fingerprint({ ...copy, manifest_sha256: null }); return copy;
  });
  const budget = boundedBudget({ id: 'four-cell-budget', episodes: 4, durationMs: 1000, requests: 2,
    inputTokens: 1000, outputTokens: 1000, batchDurationMs: 10000 });
  const protocol = preregisterComparison({ ...input, environments: [...input.environments, ...off],
    environmentPairs: [[0, 1], [2, 3]], budget });
  const plan = freeze(protocol); validateBatchPlan(plan);
  assert.equal(plan.slots.length, 4); assert.equal(protocol.conditions.length, 4);
  assert.deepEqual(protocol.pairs.map(pair => pair.condition_ids), [['m0-e0', 'm0-e1'], ['m0-e2', 'm0-e3']]);
  assert.deepEqual(protocol.conditions.slice(2).map(condition => condition.code_mode), ['off', 'off']);
});

test('new frozen comparisons score observations from the actual normalizer and scorer versions', () => {
  const plan = freeze(preregisterComparison(comparisonInputs()));
  const episodes = observedEpisodes(plan);
  const analysis = scoreExperiment({ protocol: plan.protocol, episodes });
  assert.equal(plan.protocol.policies.evidence.normalizer_version, EVIDENCE_VERSION);
  assert.equal(plan.protocol.policies.evidence.scoring_version, ANALYSIS_VERSION);
  assert.deepEqual(analysis.normalizer_versions, [plan.protocol.policies.evidence.normalizer_version]);
  assert.equal(analysis.scoring_version, plan.protocol.policies.evidence.scoring_version);
  assert.equal(analysis.completeness.valid_slots, plan.slots.length);
  assert.deepEqual(analysis.completeness.unresolved_slots, []);
  assert.equal(analysis.cost_ledger.actual_runs, plan.slots.length);
});

test('registering a new comparison preserves an older frozen plan and its normalizer boundary', () => {
  const args = comparisonInputs();
  const previous = preregisterComparison({ ...args, id: 'prior-frozen-version' });
  Object.assign(previous.policies.evidence, { normalizer_version: '1.0.0', scoring_version: '1.0.0' });
  previous.protocol_sha256 = fingerprint({ ...previous, protocol_sha256: null });
  const frozen = freezeObject(freeze(previous)), before = JSON.stringify(frozen);
  const replacement = freeze(preregisterComparison({ ...args, id: 'replacement-version' }));
  validateBatchPlan(frozen);
  assert.equal(JSON.stringify(frozen), before);
  assert.notEqual(replacement.plan_sha256, frozen.plan_sha256);
  assert.equal(frozen.protocol.policies.evidence.normalizer_version, '1.0.0');
  assert.equal(frozen.protocol.policies.evidence.scoring_version, '1.0.0');
  assert.throws(() => scoreExperiment({ protocol: frozen.protocol, episodes: observedEpisodes(frozen) }),
    /Different normalizer semantics require a separate explicit analysis stratum/);
  assert.equal(JSON.stringify(frozen), before);
});
