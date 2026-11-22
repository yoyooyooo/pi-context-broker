import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canonicalJson, fingerprint, validateEnvironmentManifest, validateProtocol } from './protocol.mjs';
import { createPreregistrationTemplate } from './templates/preregistration.mjs';
import metricDictionary from './metrics.json' with { type: 'json' };
import environmentSchema from './schemas/environment-manifest.schema.json' with { type: 'json' };
import protocolSchema from './schemas/protocol.schema.json' with { type: 'json' };
import { METRIC_ENTRIES } from './analysis/metrics.mjs';

const digest = label => fingerprint({ synthetic_test_identity: label });
const clone = value => structuredClone(value);
function seal(value) {
  for (const environment of value.environments)
    environment.manifest_sha256 = fingerprint({ ...environment, manifest_sha256: null });
  for (const condition of value.conditions) {
    const environment = value.environments.find(item => item.id === condition.environment_id);
    if (environment) condition.environment_sha256 = fingerprint({ ...environment, manifest_sha256: null });
  }
  value.protocol_sha256 = fingerprint({ ...value, protocol_sha256: null });
  return value;
}

/* Synthetic policies prove the validator, not an authorized experiment budget. */
function frozenFixture() {
  const value = createPreregistrationTemplate();
  Object.assign(value, { id: 'synthetic-test-experiment', status: 'frozen', phase: 'pilot', registered_at: '2026-11-22T00:00:00Z' });
  for (const environment of value.environments) {
    environment.status = 'frozen';
    environment.build.id = 'synthetic-build';
    environment.build.receipt_sha256 = digest('build-receipt');
    for (const [name, identity] of Object.entries({ cli: environment.build.cli, broker: environment.build.broker })) {
      identity.commit = '1'.repeat(40);
      for (const key of Object.keys(identity)) if (key !== 'commit') identity[key] = digest(name + key);
    }
    for (const [name, runtime] of Object.entries(environment.runtime)) {
      runtime.version = { node: '26.13.1', pi: '1.6.0', bun: '1.4.4' }[name];
      runtime.entry = '/synthetic-maintained/' + name;
      runtime.sha256 = digest(name);
    }
    environment.pi.entry = environment.runtime.pi.entry;
    for (const key of ['config_sha256', 'catalog_sha256', 'guidance_sha256', 'injection_sha256', 'return_contract_sha256', 'error_contract_sha256']) environment.pi[key] = digest(key);
    for (const extension of environment.pi.extensions) extension.sha256 = digest(extension.id);
  }
  const model = value.models[0];
  model.id = 'synthetic-model-a'; model.family = 'synthetic-family';
  model.adapter.verification = 'verified'; model.adapter.evidence_sha256 = digest('adapter-test-receipt');
  value.conditions.forEach(condition => { condition.model_id = model.id; });
  const p = value.policies;
  p.budgets[0].episode = { max_duration_ms: 60_000, max_model_requests: 8, max_input_tokens: 50_000, max_output_tokens: 10_000, max_http_attempts: 32, max_retries: 2 };
  p.budgets[0].batch = { max_episodes: 144, max_model_requests: 1200, max_input_tokens: 1_000_000, max_output_tokens: 1_000_000, max_duration_ms: 3_600_000, max_concurrency: 2 };
  p.ordering.concurrency = 1; p.reruns.max_episodes = 0;
  p.statistics.interval_method = 'synthetic-paired-cluster-test-method';
  p.statistics.boundary_method = 'insufficient-evidence-until-coverage-validated';
  p.statistics.multiple_comparisons = 'synthetic-prespecified-family-policy';
  Object.assign(p.decision, { absolute_quality_required: 0.8, unassisted_quality_required: 0.75, input_ratio_max: 1.10, capped_time_ratio_max: 1.15 });
  Object.assign(p.evidence, { observer_version: 'synthetic-observer-1', normalizer_version: 'synthetic-normalizer-1', scoring_version: 'synthetic-scoring-1' });
  return seal(value);
}
function assertValid(value, options = { stage: 'execute' }) {
  const result = validateProtocol(value, options);
  assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
  assert.deepEqual(result.errors, []);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  return result;
}
function assertCode(value, code, options = { stage: 'execute' }) {
  const result = validateProtocol(value, options);
  assert.equal(result.valid, false);
  assert(result.errors.some(error => error.code === code), JSON.stringify(result.errors, null, 2));
  for (const error of result.errors) { assert.equal(typeof error.path, 'string'); assert.equal(typeof error.message, 'string'); }
}
function modelComparison(purpose = 'model_evolution') {
  const value = frozenFixture(); value.purpose = purpose; value.allowed_changes = ['model'];
  value.environments = [value.environments[0]];
  value.corpus.capabilities[0].environment_ids = [value.environments[0].id];
  const second = clone(value.models[0]);
  Object.assign(second, { id: 'brand-new-model-config', route: 'configurable/future-model', api: 'future-verified-api-v7' });
  second.adapter.id = 'future-api-adapter'; second.adapter.evidence_sha256 = digest('future-verified-receipt');
  if (purpose === 'model_crosssection') second.family = 'another-family';
  value.models.push(second);
  value.conditions[1].model_id = second.id; value.conditions[1].environment_id = value.environments[0].id;
  return seal(value);
}
function interactionFixture() {
  const value = frozenFixture(); value.purpose = 'model_environment_interaction'; value.allowed_changes.push('model');
  const second = { ...clone(value.models[0]), id: 'synthetic-model-b', route: 'other/route' };
  value.models.push(second);
  const added = value.conditions.map(c => ({ ...clone(c), id: c.id + '-other-model', model_id: second.id }));
  value.conditions.push(...added);
  value.pairs.push({ ...clone(value.pairs[0]), id: 'pair-other-model', condition_ids: added.map(c => c.id) });
  value.policies.ordering.condition_order = value.conditions.map(c => c.id);
  return seal(value);
}

test('canonical JSON is order-stable, pure, and binds array order', () => {
  assert.equal(canonicalJson({ z: 3, a: [true, null, { y: 'x', b: 1 }] }), '{"a":[true,null,{"b":1,"y":"x"}],"z":3}');
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
  assert.notEqual(fingerprint([1, 2]), fingerprint([2, 1]));
});
test('non-JSON values and cycles return structured invalid results', () => {
  const cycle = {}; cycle.self = cycle; const sparse = []; sparse[1] = 1;
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), () => {}, cycle, sparse, { field: undefined }]) {
    assert.throws(() => canonicalJson(value), TypeError);
    assert.equal(validateProtocol(value).valid, false);
    assert.equal(validateEnvironmentManifest(value).valid, false);
  }
});
test('committed template is deterministic, draft, and cannot authorize execution', () => {
  const value = createPreregistrationTemplate();
  assert.deepEqual(value, JSON.parse(readFileSync(new URL('./templates/preregistration.draft.json', import.meta.url), 'utf8')));
  assertValid(value, { stage: 'phase0' }); assertCode(value, 'unfrozen_execution');
  assert.equal(value.policies.budgets[0].episode.max_input_tokens, null);
  assert.equal(value.policies.decision.absolute_quality_required, null);
});
test('schemas use only deliberately implemented JSON Schema keywords', () => {
  const supported = new Set(['$schema', '$id', '$ref', 'description', 'type', 'properties', 'required', 'additionalProperties', 'items',
    'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'const', 'enum', 'anyOf']);
  function check(schema) {
    for (const key of Object.keys(schema)) assert(supported.has(key), key);
    Object.values(schema.properties ?? {}).forEach(check); if (schema.items) check(schema.items); schema.anyOf?.forEach(check);
  }
  check(environmentSchema); check(protocolSchema);
});
test('different tools and guidance retain one common business contract', () => {
  const value = frozenFixture(); value.allowed_changes.push('guidance');
  value.environments[0].pi.guidance_sha256 = digest('new-interface-guidance');
  value.environments[0].pi.tools[0].parameters.properties.nullable = { type: ['string', 'null'], default: null };
  assertValid(seal(value)); assert.equal(value.pairs.length, 1);
});
test('native can be A and loads an explicit root without Broker', () => {
  const value = frozenFixture(); value.purpose = 'native_calibration';
  value.allowed_changes = ['pi_mode', 'extensions', 'tools', 'native_root', 'sources'];
  const native = value.environments[0]; native.pi.mode = 'native';
  native.pi.extensions = native.pi.extensions.filter(e => e.role !== 'broker');
  native.pi.native_root = { path: '${RUN_ROOT}/skills', content_sha256: value.corpus.content_sha256 };
  native.pi.sources = [{ id: 'native-corpus', kind: 'native', content_sha256: value.corpus.content_sha256 }];
  assertValid(seal(value));
});
test('same-family model evolution is configuration-based', () => { assertValid(modelComparison()); });
test('cross-family models and future verified APIs require no fixed model enum', () => { assertValid(modelComparison('model_crosssection')); });
test('finite model-by-environment interaction uses four declared cells and two pairs', () => {
  const value = interactionFixture(); assertValid(value); assert.equal(value.conditions.length, 4); assert.equal(value.pairs.length, 2);
});
test('unselected materials do not force a full model/environment/case matrix', () => {
  const value = frozenFixture();
  value.corpus.cases.push({ ...clone(value.corpus.cases[0]), id: 'unselected-case', material_id: 'other-material', cluster_id: 'other-cluster', family: 'unselected-family' });
  assertValid(seal(value)); assert.equal(value.pairs.length * 2, 2);
});
test('additional capability assessments keep unsupported outside the common denominator', () => {
  const value = frozenFixture();
  value.corpus.capabilities.push({ id: 'new-capability', scope: 'added', environment_ids: ['candidate'] });
  const extra = { ...clone(value.corpus.cases[0]), id: 'new-capability-case', family: 'additional-family', material_id: 'additional-material', cluster_id: 'additional-cluster', capability_ids: ['new-capability'] };
  value.corpus.cases.push(extra); value.conditions.forEach(c => c.case_ids.push(extra.id));
  value.assessments = value.conditions.map((c, i) => ({ id: 'scope-assessment-' + i, case_id: extra.id, condition_id: c.id, repeat: 0, seed: 0, expected_support: i === 0 ? 'supported' : 'unsupported' }));
  assertValid(seal(value)); assert.equal(value.policies.statistics.family_weights.length, 1);
});
test('opaque backend identity remains unknown within an explicit route window', () => {
  const value = frozenFixture(); assert.equal(value.models[0].backend.identity, null); assertValid(value);
});
test('Code Mode can be the declared experimental change', () => {
  const value = frozenFixture(); value.environments[1].policies.code_mode = 'off'; value.conditions[1].code_mode = 'off';
  value.allowed_changes.push('code_mode'); assertValid(seal(value));
});

const negatives = [
  ['unknown top-level field', v => { v.silent_option = true; }, 'schema_unknown_field'],
  ['wrong schema version', v => { v.schema_version = 2; }, 'schema_const'],
  ['missing SDK identity', v => { delete v.environments[0].build.cli.sdk_sha256; }, 'schema_required'],
  ['unresolved frozen SDK digest', v => { v.environments[0].build.cli.sdk_sha256 = null; }, 'unresolved_policy'],
  ['duplicate model identity', v => { v.models.push(clone(v.models[0])); }, 'duplicate_identity'],
  ['unknown model reference', v => { v.conditions[0].model_id = 'missing-model'; }, 'unknown_reference'],
  ['wrong corpus digest', v => { v.conditions[0].corpus_sha256 = digest('wrong-corpus'); }, 'corpus_mismatch'],
  ['changed permission scope', v => { v.conditions[0].authorization_sha256 = digest('different-permission'); }, 'fairness_mismatch'],
  ['changed initial state', v => { v.conditions[0].initial_state_sha256 = digest('different-initial-state'); }, 'fairness_mismatch'],
  ['different model in environment pair', v => { const m = clone(v.models[0]); m.id = 'other'; v.models.push(m); v.conditions[1].model_id = m.id; }, 'environment_comparison_model'],
  ['undeclared prompt change', v => { v.environments[0].pi.injection_sha256 = digest('changed-injection'); }, 'undeclared_change'],
  ['wrong active tool', v => { v.environments[0].pi.active_tools.push('undeclared-tool'); }, 'unknown_tool'],
  ['duplicate declared tool', v => { v.environments[0].pi.tools.push(clone(v.environments[0].pi.tools[0])); }, 'duplicate_identity'],
  ['Code Mode different from manifest', v => { v.conditions[0].code_mode = 'off'; }, 'code_mode_mismatch'],
  ['missing budget', v => { v.policies.budgets[0].episode.max_input_tokens = null; }, 'unresolved_policy'],
  ['missing absolute quality threshold', v => { v.policies.decision.absolute_quality_required = null; }, 'unresolved_policy'],
  ['missing interval boundary policy', v => { v.policies.statistics.boundary_method = null; }, 'unresolved_policy'],
  ['missing multiplicity policy', v => { v.policies.statistics.multiple_comparisons = null; }, 'unresolved_policy'],
  ['unverified API adapter', v => { v.models[0].adapter.verification = 'unverified'; v.models[0].adapter.evidence_sha256 = null; }, 'unverified_adapter'],
  ['reported backend without identity', v => { v.models[0].backend.observability = 'reported'; }, 'reported_identity_missing'],
  ['opaque backend claiming fixed identity', v => { v.models[0].backend.identity = 'pretend-fixed-version'; }, 'opaque_identity_claim'],
  ['missing evidence requirement', v => { v.policies.evidence.required = v.policies.evidence.required.filter(x => x !== 'usage'); }, 'missing_evidence_contract'],
  ['edited metric dictionary identity', v => { v.metrics.dictionary_sha256 = digest('different-dictionary'); }, 'metric_dictionary_mismatch'],
  ['unknown metric formula', v => { v.metrics.primary.push('invented-score'); }, 'unknown_metric'],
  ['quality replaced by efficiency', v => { v.metrics.primary = v.metrics.primary.filter(x => x !== 'verified_quality'); }, 'quality_metric_required'],
  ['unbalanced family weights', v => { v.policies.statistics.family_weights[0].weight = 0.5; }, 'weight_sum'],
  ['weight for absent task family', v => { v.policies.statistics.family_weights.push({ family: 'absent', weight: 0.5 }); }, 'weight_scope_mismatch'],
  ['unknown outcomes given success credit', v => { v.policies.statistics.quality_unknown_credit = 1; }, 'schema_const'],
  ['invalid attempts excluded from budget', v => { v.policies.reruns.count_invalid = false; }, 'schema_const'],
  ['silent model fallback', v => { v.policies.model_fallback = 'automatic'; }, 'schema_const'],
  ['hidden auxiliary model', v => { v.policies.auxiliary_model_ids = [v.models[0].id]; }, 'schema_items'],
  ['paid periodic scheduling', v => { v.policies.scheduled_paid_runs = true; }, 'schema_const'],
  ['unpriced route invents money', v => { v.policies.budgets[0].monetary.currency = 'USD'; }, 'unpriced_cost_claim'],
  ['priced route lacks evidence', v => { v.policies.budgets[0].monetary.policy = 'priced'; }, 'unresolved_policy'],
  ['reruns exceed pilot cap', v => { v.policies.reruns.max_episodes = 143; }, 'pilot_episode_limit'],
  ['pilot budget exceeds 144', v => { v.policies.budgets[0].batch.max_episodes = 145; }, 'pilot_episode_limit'],
  ['episode exceeds launcher maximum', v => { v.policies.budgets[0].episode.max_duration_ms = 3_600_001; }, 'schema_type'],
  ['excess concurrency', v => { v.policies.ordering.concurrency = 3; }, 'concurrency_limit'],
  ['batch smaller than one episode', v => { v.policies.budgets[0].batch.max_input_tokens = 1; }, 'budget_inconsistent'],
  ['duplicate scheduled episode', v => { v.pairs.push({ ...clone(v.pairs[0]), id: 'duplicate-schedule' }); }, 'duplicate_episode'],
  ['native calibration with two Brokers', v => { v.purpose = 'native_calibration'; }, 'native_calibration_modes'],
  ['unfrozen execution', v => { v.status = 'draft'; }, 'unfrozen_execution'],
  ['Phase 0 cannot authorize paid tasks', v => { v.phase = 'phase0'; }, 'unfrozen_execution'],
  ['confirmation uses development material', v => { v.phase = 'confirmation'; }, 'confirmation_split'],
  ['pilot exposes unseen confirmation material', v => { v.corpus.cases[0].split = 'confirmation'; }, 'confirmation_exposed'],
  ['unbounded tuning', v => { v.models[0].adoption.mode = 'tuned'; }, 'tuning_unbounded'],
  ['promised capability removed on one side', v => { v.corpus.capabilities[0].environment_ids = ['candidate']; }, 'common_capability_scope'],
];
for (const [name, mutate, code] of negatives) test('rejects ' + name, () => {
  const value = frozenFixture(); mutate(value); assertCode(seal(value), code);
});

test('editing sealed parameters invalidates the earlier protocol fingerprint', () => {
  const value = frozenFixture(); value.models[0].parameters.temperature = 0.2; assertCode(value, 'fingerprint_mismatch');
});
test('condition must bind the updated content, not an old manifest hash', () => {
  const value = frozenFixture(); value.environments[0].pi.guidance_sha256 = digest('new-guidance');
  value.environments[0].manifest_sha256 = fingerprint({ ...value.environments[0], manifest_sha256: null });
  value.protocol_sha256 = fingerprint({ ...value, protocol_sha256: null });
  assertCode(value, 'environment_mismatch');
});
test('renaming build, commit and receipt alone does not create a different candidate', () => {
  const value = frozenFixture(); const reference = clone(value.environments[0]);
  Object.assign(reference, { id: 'reference', paired_environment_id: 'another-pair' });
  Object.assign(reference.build, { id: 'another-build-id', receipt_sha256: digest('another-receipt') });
  reference.build.broker.commit = '2'.repeat(40); value.environments[1] = reference; value.allowed_changes = ['build'];
  assertCode(seal(value), 'no_candidate_change');
});
test('model comparisons fix environment and evolution fixes family', () => {
  const wrong = frozenFixture(); wrong.purpose = 'model_crosssection'; wrong.allowed_changes = ['model'];
  assertCode(seal(wrong), 'model_comparison_environment');
  const family = modelComparison(); family.models[1].family = 'another-family'; assertCode(seal(family), 'model_family_mismatch');
});
test('interaction requires all four cells and matched case/repeat/seed', () => {
  const missing = interactionFixture(); missing.conditions.pop(); assertCode(seal(missing), 'interaction_grid');
  const unpaired = interactionFixture(); unpaired.pairs[1].seed = 1; assertCode(seal(unpaired), 'interaction_pairing');
});
test('common tasks cannot be dropped on one side or moved into assessments', () => {
  const value = frozenFixture();
  const extra = { ...clone(value.corpus.cases[0]), id: 'second-case', material_id: 'second-material', cluster_id: 'second-cluster' };
  value.corpus.cases.push(extra); value.conditions[0].case_ids.push(extra.id);
  value.assessments.push({ id: 'unpaired-common', case_id: extra.id, condition_id: value.conditions[0].id, repeat: 0, seed: 0, expected_support: 'supported' });
  assertCode(seal(value), 'fixed_denominator_mismatch'); assertCode(value, 'common_assessment');
});
test('native manifest rejects Broker extensions and missing native root', () => {
  const value = frozenFixture().environments[0]; value.pi.mode = 'native';
  value.manifest_sha256 = fingerprint({ ...value, manifest_sha256: null });
  const result = validateEnvironmentManifest(value, { stage: 'execute' });
  assert.equal(result.valid, false);
  assert(result.errors.some(e => e.code === 'native_broker_loaded'));
  assert(result.errors.some(e => e.code === 'native_root_required'));
});
test('runtime entry and frozen endpoint digests are bound', () => {
  const value = frozenFixture().environments[0]; value.runtime.pi.entry = '/other/pi'; value.runtime.node.sha256 = null;
  value.manifest_sha256 = fingerprint({ ...value, manifest_sha256: null });
  const result = validateEnvironmentManifest(value, { stage: 'execute' });
  assert.equal(result.valid, false);
  assert(result.errors.some(e => e.code === 'pi_entry_mismatch'));
  assert(result.errors.some(e => e.code === 'unresolved_policy'));
});
test('dictionary names formulas, evidence, missing behavior and implemented analysis contracts', () => {
  assert.equal(new Set(metricDictionary.metrics.map(m => m.id)).size, metricDictionary.metrics.length);
  for (const metric of metricDictionary.metrics) {
    assert(metric.formula.length > 0); assert(metric.evidence.length > 0);
    assert.match(metric.analysis_entry, /^metric:.*\/v1$/); assert(metric.missing.length > 0);
  }
  assert.equal(metricDictionary.implementation_status, 'implemented');
  for (const metric of metricDictionary.metrics) assert.equal(METRIC_ENTRIES[metric.analysis_entry]?.id, metric.id);
});
test('validation leaves input unchanged and rejects unsupported stages', () => {
  const value = frozenFixture(); const before = clone(value); assertValid(value); assert.deepEqual(value, before);
  assertCode(value, 'invalid_stage', { stage: 'almost-execute' });
});

test('model ID and verification receipt renaming do not create an actual model change', () => {
  const value = modelComparison();
  value.models[1] = { ...clone(value.models[0]), id: value.models[1].id };
  value.models[1].adapter.id = 'different-adapter-label';
  value.models[1].adapter.evidence_sha256 = digest('new-receipt-for-same-adapter');
  assertCode(seal(value), 'model_condition_same');
});
test('alias windows can express temporally limited model evolution without a known backend version', () => {
  const value = modelComparison();
  value.models[1] = { ...clone(value.models[0]), id: value.models[1].id };
  value.models[1].backend.window = { start: '2026-11-23T00:00:00Z', end: '2026-11-24T00:00:00Z' };
  assertValid(seal(value));
});
test('equivalent timestamp spellings are not a different model condition', () => {
  const value = modelComparison();
  value.models[1] = { ...clone(value.models[0]), id: value.models[1].id };
  value.models[1].backend.window.start = '2026-11-22T00:00:00.000Z';
  value.models[1].backend.window.end = '2026-11-23T00:00:00.000Z';
  assertCode(seal(value), 'model_condition_same');
});
test('model interaction rejects two renamed copies of the same actual model', () => {
  const value = interactionFixture();
  value.models[1] = { ...clone(value.models[0]), id: value.models[1].id };
  assertCode(seal(value), 'model_condition_same');
});
for (const field of ['initial_state_sha256', 'authorization_sha256']) {
  test('interaction fixes ' + field + ' across model groups, not only within pairs', () => {
    const value = interactionFixture();
    value.conditions.slice(2).forEach(condition => { condition[field] = digest('other-model-' + field); });
    assertCode(seal(value), 'interaction_fairness');
  });
}
test('interaction fixes the same budget policy across both model groups', () => {
  const value = interactionFixture();
  const otherBudget = clone(value.policies.budgets[0]);
  otherBudget.id = 'different-model-budget';
  otherBudget.episode.max_duration_ms = 30_000;
  value.policies.budgets.push(otherBudget);
  value.conditions.slice(2).forEach(condition => { condition.budget_id = otherBudget.id; });
  assertCode(seal(value), 'interaction_fairness');
});
test('interaction fixes environment role orientation and contemporaneous windows', () => {
  const reversed = interactionFixture();
  reversed.pairs[1].condition_ids.reverse();
  assertCode(seal(reversed), 'interaction_orientation');
  const window = interactionFixture();
  window.models[1].backend.window = { start: '2026-11-23T00:00:00Z', end: '2026-11-24T00:00:00Z' };
  assertCode(seal(window), 'interaction_window');
});
test('execution randomization does not silently reverse comparison roles', () => {
  const value = frozenFixture();
  value.pairs.push({ ...clone(value.pairs[0]), id: 'second-repeat', repeat: 1, condition_ids: [...value.pairs[0].condition_ids].reverse() });
  assertCode(seal(value), 'pair_orientation');
});
for (const field of ['return_contract_sha256', 'error_contract_sha256']) {
  test('frozen environment requires its own ' + field, () => {
    const value = frozenFixture();
    value.environments[0].pi[field] = null;
    assertCode(seal(value), 'unresolved_policy');
  });
  test('change in ' + field + ' must be an explicitly registered variable', () => {
    const value = frozenFixture();
    value.environments[0].pi[field] = digest('different-contract');
    assertCode(seal(value), 'undeclared_change');
    value.allowed_changes.push(field.replace('_sha256', ''));
    assertValid(seal(value));
  });
}
function tunedConfirmationFixture() {
  const value = frozenFixture();
  value.phase = 'confirmation';
  const development = value.corpus.cases[0];
  const confirmation = { ...clone(development), id: 'confirmation-case', material_id: 'confirmation-material',
    split: 'confirmation', content_sha256: digest('independent-confirmation-business-material'),
    prompt_sha256: digest('independent-confirmation-prompt') };
  value.corpus.cases.push(confirmation);
  value.conditions.forEach(condition => { condition.case_ids = [confirmation.id]; });
  value.pairs[0].case_id = confirmation.id;
  value.models[0].adoption = { mode: 'tuned', development_budget_id: value.policies.budgets[0].id,
    development_material_ids: [development.material_id], confirmation_material_ids: [confirmation.material_id] };
  return seal(value);
}
test('independent confirmation material can share method and cluster with development', () => {
  const value = tunedConfirmationFixture();
  assert.equal(value.corpus.cases[0].cluster_id, value.corpus.cases[1].cluster_id);
  assertValid(value);
});
test('renaming development material does not make it unseen confirmation', () => {
  const value = tunedConfirmationFixture();
  for (const key of ['content_sha256', 'prompt_sha256', 'contract_sha256', 'initial_state_sha256', 'authorization_sha256'])
    value.corpus.cases[1][key] = value.corpus.cases[0][key];
  assertCode(seal(value), 'tuning_material_reused');
  assertCode(value, 'tuning_material_tuple_reused');
});
test('changed wording alone cannot hide identical developed business content', () => {
  const value = tunedConfirmationFixture();
  value.corpus.cases[1].content_sha256 = value.corpus.cases[0].content_sha256;
  assertCode(seal(value), 'tuning_material_reused');
});
test('unsafe integer counters and symbol-bearing arrays cannot lose identity in JSON', () => {
  const value = frozenFixture();
  value.pairs[0].seed = Number.MAX_SAFE_INTEGER + 1;
  assertCode(seal(value), 'schema_type');
  const array = [1]; array[Symbol('hidden')] = 2;
  assert.throws(() => fingerprint(array), TypeError);
});
