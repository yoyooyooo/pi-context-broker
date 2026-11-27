import assert from 'node:assert/strict';
import test from 'node:test';
import { BASELINE_DIAGNOSTIC, fingerprint, validateProtocol } from './protocol.mjs';
import { createPreregistrationTemplate } from './templates/preregistration.mjs';
import { declaredSchedule } from './campaign-selection.mjs';

const digest = label => fingerprint({ synthetic_diagnostic: label });
const relativeThresholds = ['quality_delta_min', 'input_ratio_max', 'capped_time_ratio_max', 'efficiency_ratio_max'];
const comparativeMetrics = ['input_ratio', 'time_ratio', 'version_transition',
  'model_environment_interaction', 'code_mode_interaction', 'cost_frontier'];

function seal(value) {
  for (const environment of value.environments)
    environment.manifest_sha256 = fingerprint({ ...environment, manifest_sha256: null });
  for (const condition of value.conditions) {
    const environment = value.environments.find(item => item.id === condition.environment_id);
    if (environment) condition.environment_sha256 = environment.manifest_sha256;
  }
  value.protocol_sha256 = fingerprint({ ...value, protocol_sha256: null });
  return value;
}

// Synthetic identities prove validation and scheduling, never a live grant or run.
function diagnosticFixture() {
  const value = createPreregistrationTemplate();
  Object.assign(value, { id: 'diagnostic-protocol-test', status: 'frozen', phase: 'development',
    purpose: BASELINE_DIAGNOSTIC, registered_at: '2026-11-27T00:00:00Z', allowed_changes: [] });
  value.environments = value.environments.slice(0, 1);
  const environment = value.environments[0];
  environment.status = 'frozen'; environment.build.id = 'diagnostic-synthetic-build';
  environment.build.receipt_sha256 = digest('build');
  for (const [name, identity] of Object.entries({ cli: environment.build.cli, broker: environment.build.broker })) {
    identity.commit = '1'.repeat(40);
    for (const key of Object.keys(identity)) if (key !== 'commit') identity[key] = digest(name + key);
  }
  for (const [name, runtime] of Object.entries(environment.runtime)) {
    runtime.version = { node: '26.13.1', pi: '1.6.0', bun: '1.4.4' }[name];
    runtime.entry = '/synthetic-maintained/' + name; runtime.sha256 = digest(name);
  }
  environment.pi.entry = environment.runtime.pi.entry;
  for (const key of ['config_sha256', 'catalog_sha256', 'guidance_sha256', 'injection_sha256', 'return_contract_sha256', 'error_contract_sha256'])
    environment.pi[key] = digest(key);
  for (const extension of environment.pi.extensions) extension.sha256 = digest(extension.id);
  value.corpus.capabilities.forEach(capability => { capability.environment_ids = [environment.id]; });
  value.conditions = value.conditions.slice(0, 1);
  value.pairs = [];
  const condition = value.conditions[0], model = value.models[0], item = value.corpus.cases[0];
  model.id = 'synthetic-diagnostic-model'; model.family = 'synthetic-diagnostic-family';
  model.route = 'fixed/' + model.id;
  model.routing = { mode: 'fixed-route', model_variant: model.id, reported_model_ids: [model.route] };
  model.adapter.verification = 'verified'; model.adapter.evidence_sha256 = digest('adapter');
  model.backend.window = { mode: 'standing', start: value.registered_at, end: null };
  condition.model_id = model.id;
  value.assessments = [{ id: 'baseline-case-r0', condition_id: condition.id, case_id: item.id,
    repeat: 0, seed: 7, expected_support: 'supported' }];
  const policy = value.policies;
  policy.campaign = { version: 1, kind: 'benchmark-standing-campaign', id: 'synthetic-attempt',
    role: 'task_continuation', authorization_id: 'synthetic-grant', work_plan_id: 'synthetic-work-plan',
    work_item_id: 'synthetic-baseline', planned_episodes: 1, resource_policy: { mode: 'unbounded' },
    condition_epoch: { id: 'synthetic-epoch', started_at: value.registered_at,
      authorization: { path: '/synthetic/grant.json', sha256: digest('grant') } } };
  policy.budgets[0].mode = 'unbounded'; policy.budgets[0].batch.max_concurrency = 1;
  policy.ordering.concurrency = 1; policy.ordering.condition_order = [condition.id];
  policy.pilot.max_scheduled_episodes = null; policy.pilot.route_gate_episodes = null;
  policy.reruns.max_episodes = null;
  Object.assign(policy.statistics, { interval_method: 'weighted-cluster-hoeffding-v1',
    boundary_method: 'hoeffding-no-degenerate-bootstrap-v1', multiple_comparisons: 'bonferroni-primary-family-v1' });
  Object.assign(policy.decision, { absolute_quality_required: 0.9, unassisted_quality_required: 0.9 });
  Object.assign(policy.evidence, { observer_version: 'synthetic-observer', normalizer_version: 'synthetic-normalizer',
    scoring_version: 'synthetic-scorer' });
  policy.analysis = { capped_time_horizon_ms: 60000 };
  value.metrics.primary = ['verified_quality', 'unassisted_quality'];
  value.metrics.secondary = ['known_failure', 'evidence_coverage', 'input_first', 'input_peak', 'input_total'];
  return seal(value);
}

function assertValid(value) {
  const result = validateProtocol(seal(value), { stage: 'execute' });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  return value;
}
function assertCode(value, code) {
  const result = validateProtocol(seal(value), { stage: 'execute' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === code), JSON.stringify(result.errors));
}
function twoCasesAndRepeats() {
  const value = diagnosticFixture(), first = value.corpus.cases[0], condition = value.conditions[0];
  const second = { ...structuredClone(first), id: 'second-case', family: 'second-family',
    material_id: 'second-material', cluster_id: 'second-cluster', content_sha256: digest('second-content') };
  value.corpus.cases.push(second); condition.case_ids.push(second.id);
  value.policies.statistics.family_weights = [{ family: first.family, weight: 0.25 }, { family: second.family, weight: 0.75 }];
  value.assessments = value.corpus.cases.flatMap(item => [0, 1].map(repeat => ({
    id: item.id + '-r' + repeat, case_id: item.id, condition_id: condition.id, repeat,
    seed: 7 + repeat, expected_support: 'supported' })));
  value.policies.campaign.planned_episodes = value.assessments.length;
  return seal(value);
}

test('a standing baseline diagnosis freezes exactly one supported common-task observation', () => {
  const value = assertValid(diagnosticFixture());
  assert.equal(BASELINE_DIAGNOSTIC, 'baseline_diagnostic');
  assert.deepEqual(declaredSchedule(value), [{ slot_id: 'baseline-case-r0', assessment_id: 'baseline-case-r0',
    case_id: value.corpus.cases[0].id, condition_id: value.conditions[0].id, repeat: 0, seed: 7, order: 0 }]);
  assert.deepEqual(value.pairs, []);
});

test('diagnostic weights and repeat coverage use the complete assessment cases', () => {
  const value = assertValid(twoCasesAndRepeats());
  assert.equal(declaredSchedule(value).length, 4);
  const missing = structuredClone(value); missing.assessments.pop(); missing.policies.campaign.planned_episodes--;
  assertCode(missing, 'baseline_diagnostic_repeats');
  const gap = structuredClone(value); gap.assessments.forEach(item => { item.repeat++; });
  assertCode(gap, 'baseline_diagnostic_repeats');
  const weights = structuredClone(value); weights.policies.statistics.family_weights = [{ family: value.corpus.cases[0].family, weight: 1 }];
  assertCode(weights, 'weight_scope_mismatch');
  const duplicate = structuredClone(value); duplicate.assessments.push({ ...duplicate.assessments[0], id: 'duplicated-unit' });
  duplicate.policies.campaign.planned_episodes++;
  assertCode(duplicate, 'duplicate_episode');
});

test('diagnostic material remains development or pilot without exposing unselected confirmation', () => {
  for (const phase of ['development', 'pilot']) for (const split of ['development', 'pilot']) {
    const value = diagnosticFixture(); value.phase = phase; value.corpus.cases[0].split = split; assertValid(value);
  }
  const hidden = diagnosticFixture();
  hidden.corpus.cases.push({ ...structuredClone(hidden.corpus.cases[0]), id: 'unselected-confirmation',
    material_id: 'unselected-confirmation-material', split: 'confirmation', content_sha256: digest('unselected-confirmation') });
  assertValid(hidden);
  for (const phase of ['phase0', 'confirmation', 'regression', 'screening']) {
    const value = diagnosticFixture(); value.phase = phase; assertCode(value, 'baseline_diagnostic_phase');
  }
  for (const split of ['confirmation', 'regression']) {
    const value = diagnosticFixture(); value.corpus.cases[0].split = split; assertCode(value, 'baseline_diagnostic_material');
  }
});

test('diagnostic observations cannot gain comparison or adoption claims', () => {
  for (const field of relativeThresholds) {
    const value = diagnosticFixture(); value.policies.decision[field] = 0.5; assertCode(value, 'baseline_diagnostic_decision');
  }
  const acceptance = diagnosticFixture(); acceptance.policies.decision.mode = 'acceptance';
  assertCode(acceptance, 'baseline_diagnostic_decision');
  const changed = diagnosticFixture(); changed.allowed_changes = ['tools']; assertCode(changed, 'baseline_diagnostic_comparison');
  for (const metric of comparativeMetrics) for (const key of ['primary', 'secondary']) {
    const value = diagnosticFixture(); value.metrics[key].push(metric); assertCode(value, 'baseline_diagnostic_metrics');
  }
  const interaction = diagnosticFixture(); interaction.policies.analysis.interactions = [{ id: 'invented-interaction',
    kind: 'model_environment', condition_ids: ['a', 'b', 'c', 'd'] }];
  assertCode(interaction, 'baseline_diagnostic_interaction');
  const tuned = diagnosticFixture(); tuned.models[0].adoption.mode = 'tuned'; assertCode(tuned, 'baseline_diagnostic_adoption');
  const confirmation = diagnosticFixture(); confirmation.models[0].adoption.confirmation_material_ids = ['unseen-material'];
  assertCode(confirmation, 'baseline_diagnostic_adoption');
});

test('diagnostic execution still requires standing authorization, complete known evidence and immutable identity', () => {
  const noStanding = diagnosticFixture(); delete noStanding.policies.campaign; assertCode(noStanding, 'baseline_diagnostic_standing');
  const bounded = diagnosticFixture(); delete bounded.policies.budgets[0].mode; assertCode(bounded, 'standing_resource_policy');
  const cap = diagnosticFixture(); cap.policies.budgets[0].episode.max_input_tokens = 1; assertCode(cap, 'unbounded_resource_limits');
  const schedule = diagnosticFixture(); schedule.policies.campaign.planned_episodes = 2; assertCode(schedule, 'standing_schedule');
  const evidence = diagnosticFixture(); evidence.policies.evidence.required.pop(); assertCode(evidence, 'missing_evidence_contract');
  const identity = diagnosticFixture(); identity.conditions[0].corpus_sha256 = digest('other-corpus'); assertCode(identity, 'corpus_mismatch');
  const adapter = diagnosticFixture(); adapter.models[0].adapter.verification = 'unverified'; assertCode(adapter, 'unverified_adapter');
});

test('diagnostic shape refuses empty, unsupported or additional conditions', () => {
  const empty = diagnosticFixture(); empty.assessments = []; assertCode(empty, 'baseline_diagnostic_schedule');
  const unsupported = diagnosticFixture(); unsupported.assessments[0].expected_support = 'unsupported';
  assertCode(unsupported, 'baseline_diagnostic_schedule');
  for (const key of ['environments', 'models', 'conditions']) {
    const value = diagnosticFixture(); value[key].push({ ...structuredClone(value[key][0]), id: 'second-' + key });
    assertCode(value, 'baseline_diagnostic_condition');
  }
  const pair = diagnosticFixture(); pair.pairs.push({ id: 'fake-aa', case_id: pair.corpus.cases[0].id,
    condition_ids: [pair.conditions[0].id, pair.conditions[0].id], repeat: 1, seed: 1 });
  assertCode(pair, 'baseline_diagnostic_schedule');
  const missing = twoCasesAndRepeats(); missing.assessments = missing.assessments.filter(item => item.case_id !== 'second-case');
  missing.policies.campaign.planned_episodes = missing.assessments.length;
  assertCode(missing, 'unscheduled_case');
});

test('the explicit diagnostic purpose does not loosen ordinary comparison shape or common-task pairing', () => {
  for (const purpose of ['environment_iteration', 'native_calibration', 'model_evolution', 'model_crosssection', 'model_environment_interaction']) {
    const value = diagnosticFixture(); value.purpose = purpose;
    assertCode(value, 'schema_items');
    assertCode(value, 'common_assessment');
  }
});
