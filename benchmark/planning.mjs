import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { BASELINE_DIAGNOSTIC, fingerprint, validateProtocol } from './protocol.mjs';
import { EVIDENCE_VERSION } from './evidence/normalize.mjs';
import { ANALYSIS_VERSION } from './analysis/compare.mjs';
import { createPreregistrationTemplate } from './templates/preregistration.mjs';
import { bindPublicCaseToFixture, materializeLocal, planCaseVariant, validateCorpus } from './corpus/index.mjs';
import { inventoryPublicInputs } from './subject.mjs';
import { isStandingCampaign } from './standing-campaign.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

/** The scientific case identity, before physical material names are bound. */
export function protocolCaseForVariant({ variant, publicCase, oracle }) {
  return { id: variant.id, family: publicCase.family, material_id: publicCase.material_id,
    cluster_id: publicCase.cluster_id, split: publicCase.split, content_sha256: variant.content_sha256,
    prompt_sha256: fingerprint(publicCase.turns), contract_sha256: fingerprint(oracle),
    initial_state_sha256: publicCase.initial_state_sha256, authorization_sha256: publicCase.authorization_sha256,
    capability_ids: publicCase.required_capabilities };
}

/** Generate reusable public projections while retaining each oracle outside the repository and subject. */
export async function prepareCases({ corpus, selections, root }) {
  validateCorpus(corpus); assert.ok(isAbsolute(root));
  await mkdir(root, { recursive: true });
  const bindings = [];
  for (const selection of selections) {
    const selected = planCaseVariant({ ...corpus, ...selection });
    const variantRoot = join(root, selected.variant.id);
    await mkdir(variantRoot, { recursive: true });
    const material = await materializeLocal({ publicCorpus: corpus.publicCorpus, targetRoot: join(variantRoot, 'material'), ...selection });
    const inputRoot = join(variantRoot, 'inputs');
    await mkdir(inputRoot, { recursive: true });
    for (const file of selected.publicCase.attachments) {
      const target = join(inputRoot, file.path), bytes = Buffer.from(file.content, file.encoding);
      await mkdir(dirname(target), { recursive: true });
      try { await writeFile(target, bytes, { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(sha(await readFile(target)), file.sha256); }
    }
    const oraclePath = join(variantRoot, 'oracle.json');
    try { await save(oraclePath, selected.oracle); }
    catch (error) { if (error.code !== 'EEXIST') throw error; assert.deepEqual(JSON.parse(await readFile(oraclePath, 'utf8')), selected.oracle); }
    const publicCase = selected.publicCase;
    const binding = { id: selected.variant.id, base_case_id: publicCase.id, variant: selected.variant,
      public_case: publicCase, oracle_path: oraclePath, oracle_sha256: sha(await readFile(oraclePath)),
      input_root: inputRoot, input_inventory_sha256: sha(JSON.stringify(await inventoryPublicInputs(inputRoot))),
      skills_root: join(material.target_root, '.agents/skills'), skill_inventory: material.inventory.filter(file => file.skill_id),
      events: selected.events, clarification: selected.clarification,
      protocol_case: protocolCaseForVariant(selected) };
    try { await save(join(variantRoot, 'binding.json'), binding); }
    catch (error) { if (error.code !== 'EEXIST') throw error; assert.deepEqual(JSON.parse(await readFile(join(variantRoot, 'binding.json'), 'utf8')), binding); }
    bindings.push(binding);
  }
  return bindings;
}

/** Bind both consumers to the same independently observed Notion bytes and public names. */
export async function bindMaterializedCases({ cases, materialization }) {
  const proofBytes = await readFile(materialization.materialization_proof.path);
  assert.equal(sha(proofBytes), materialization.materialization_proof.sha256, 'Material parity proof changed');
  const proof = JSON.parse(proofBytes);
  assert.equal(proof.status, 'passed'); assert.equal(proof.parity.status, 'valid');
  assert.equal(proof.visibility.status, 'valid'); assert.equal(proof.entry, materialization.entry);
  assert.equal(proof.catalog.candidates, materialization.catalog_skill_ids.length); assert.equal(proof.catalog.exhaustive, true);
  const files = proof.files.filter(file => file.skill_id);
  for (const file of files) assert.equal(sha(await readFile(file.path)), file.sha256, 'Observed native equivalent changed');
  const fixtureBindings = JSON.parse(await readFile(materialization.fixture_bindings_path, 'utf8'));
  const mapping = Object.fromEntries(Object.entries(materialization.identity_map).map(([id, value]) => [id, { object_id: value.object_id, name: value.logical_name }]));
  return cases.map(binding => {
    assert.ok(materialization.case_ids.includes(binding.base_case_id), 'Case is outside the proven shared catalog binding');
    assert.deepEqual([...binding.public_case.catalog.skill_ids].sort(), [...materialization.catalog_skill_ids].sort());
    const bound = bindPublicCaseToFixture({ publicCase: binding.public_case, skillMapping: mapping, bindings: fixtureBindings });
    return { ...binding, public_case: bound.publicCase, identity_map: bound.identity_map,
      ...(materialization.source_contract ? { source_contract: materialization.source_contract } : {}),
      materialization_proof: materialization.materialization_proof, skills_root: materialization.native_skill_root,
      skill_inventory: files, notion_entry: materialization.entry,
      protocol_case: { ...binding.protocol_case, prompt_sha256: fingerprint(bound.publicCase.turns),
        content_sha256: fingerprint({ canonical_variant: binding.protocol_case.content_sha256, materialization: materialization.materialization_proof.sha256 }),
        initial_state_sha256: fingerprint({ inputs: binding.input_inventory_sha256, skills: files.map(file => ({ skill_id: file.skill_id, path: file.resource_path, sha256: file.sha256, mode: file.mode })) }) } };
  });
}

/** Use the same canonical pairs for pre-registration fixture ownership and the
 * final protocol. Physical material bindings never add or remove a sample. */
export function comparisonEnvironmentPairs(environmentCount = 2, declared) {
  assert.ok([2, 4].includes(environmentCount), 'A comparison names two environments or two explicit environment pairs');
  const pairs = declared ?? (environmentCount === 2 ? [[0, 1]] : null);
  assert.ok(Array.isArray(pairs) && pairs.length === environmentCount / 2, 'Four environments require two explicit comparison orientations');
  assert.ok(pairs.every(pair => Array.isArray(pair) && pair.length === 2
    && pair.every(index => Number.isSafeInteger(index) && index >= 0 && index < environmentCount)), 'Invalid environment pair');
  assert.deepEqual(pairs.flat().toSorted((a, b) => a - b), Array.from({ length: environmentCount }, (_, index) => index),
    'Every environment must belong to exactly one comparison pair');
  return pairs.map(pair => [...pair]);
}

export function comparisonPairs({ models, cases, repetitions = 1, orderingSeed = 0, environmentCount = 2, environmentPairs }) {
  assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0);
  const orientations = comparisonEnvironmentPairs(environmentCount, environmentPairs);
  const pairs = [];
  for (let mi = 0; mi < models.length; mi++) for (const item of cases) for (let repeat = 0; repeat < repetitions; repeat++)
    for (const [pairIndex, orientation] of orientations.entries())
      pairs.push({ id: 'm' + mi + (orientations.length === 1 ? '' : '-p' + pairIndex) + '-' + item.id + '-r' + repeat, case_id: item.id,
        condition_ids: orientation.map(index => 'm' + mi + '-e' + index), repeat, seed: orderingSeed + repeat });
  return pairs;
}

/** Use the existing assessment slots for a single baseline, never a fabricated pair. */
export function plannedStudyDesign({ purpose, models, cases, repetitions = 1, orderingSeed = 0,
  environmentCount = 2, environmentPairs }) {
  if (purpose !== BASELINE_DIAGNOSTIC) return { pairs: comparisonPairs({ models, cases, repetitions,
    orderingSeed, environmentCount, environmentPairs }), assessments: [] };
  assert.equal(environmentCount, 1, 'A baseline diagnostic names one environment');
  assert.equal(models.length, 1, 'A baseline diagnostic names one model');
  assert.ok(environmentPairs === undefined || Array.isArray(environmentPairs) && environmentPairs.length === 0,
    'A baseline diagnostic has no comparison pairs');
  assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0);
  assert.ok(Number.isSafeInteger(orderingSeed) && orderingSeed >= 0);
  assert.ok(cases.length > 0 && cases.every(item => ['development', 'pilot'].includes(item.protocol_case.split)),
    'A baseline diagnostic selects development or pilot cases only');
  return { pairs: [], assessments: cases.flatMap(item => Array.from({ length: repetitions }, (_, repeat) => ({
    id: 'm0-e0--' + item.id + '--r' + repeat, case_id: item.id, condition_id: 'm0-e0',
    repeat, seed: orderingSeed + repeat, expected_support: 'supported',
  }))) };
}

/** Freeze the declared comparison or descriptive baseline, never a speculative future matrix. */
export function preregisterComparison({ id, phase, purpose, environments, models, corpus, cases, repetitions = 1,
  budget, decision, analysis, pilotScope, campaignScope, environmentPairs, allowedChanges, orderingSeed = 0, registeredAt = new Date().toISOString() }) {
  const design = plannedStudyDesign({ purpose, models, cases, repetitions, orderingSeed,
    environmentCount: environments.length, environmentPairs });
  assert.ok(!(pilotScope && campaignScope), 'A comparison cannot mix legacy pilot and finite campaign scopes');
  assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0);
  assert.ok(models.length > 0 && cases.length > 0);
  assert.ok(budget && decision, 'Explicit resource and absolute quality policies are required');
  const value = createPreregistrationTemplate();
  Object.assign(value, { id, status: 'frozen', phase, purpose, registered_at: registeredAt, allowed_changes: allowedChanges,
    environments, models, pairs: [], assessments: [] });
  const capabilities = [...new Set(cases.flatMap(item => item.protocol_case.capability_ids))];
  value.corpus = { id: corpus.id, version: corpus.version, content_sha256: corpus.content_sha256, license: corpus.license,
    capabilities: capabilities.map(id => ({ id, scope: 'common', environment_ids: environments.map(e => e.id) })),
    cases: cases.map(item => item.protocol_case) };
  const state = fingerprint(cases.map(item => ({ id: item.id, initial: item.protocol_case.initial_state_sha256 })));
  const permissions = fingerprint(cases.map(item => ({ id: item.id, authorization: item.protocol_case.authorization_sha256 })));
  value.conditions = models.flatMap((model, mi) => environments.map((environment, ei) => ({ id: 'm' + mi + '-e' + ei,
    environment_id: environment.id, environment_sha256: environment.manifest_sha256, model_id: model.id,
    corpus_id: corpus.id, corpus_sha256: corpus.content_sha256, case_ids: cases.map(item => item.id),
    initial_state_sha256: state, authorization_sha256: permissions, budget_id: budget.id, code_mode: environment.policies.code_mode })));
  Object.assign(value, design);
  if (purpose === BASELINE_DIAGNOSTIC) {
    const comparative = new Set(['input_ratio', 'time_ratio', 'version_transition',
      'model_environment_interaction', 'code_mode_interaction', 'cost_frontier']);
    for (const key of ['primary', 'secondary']) value.metrics[key] = value.metrics[key].filter(id => !comparative.has(id));
  }
  value.policies.budgets = [budget];
  value.policies.ordering = { method: 'balanced', seed: orderingSeed, concurrency: 1, condition_order: value.conditions.map(c => c.id) };
  const families = [...new Set(cases.map(item => item.protocol_case.family))];
  value.policies.statistics = { ...value.policies.statistics, interval_method: 'weighted-cluster-hoeffding-v1',
    boundary_method: 'hoeffding-no-degenerate-bootstrap-v1', multiple_comparisons: 'bonferroni-primary-family-v1',
    family_weights: families.map(family => ({ family, weight: 1 / families.length })) };
  value.policies.decision = { ...value.policies.decision, ...decision };
  if (analysis !== undefined) value.policies.analysis = structuredClone(analysis);
  if (pilotScope !== undefined) value.policies.pilot.scope = structuredClone(pilotScope);
  if (campaignScope !== undefined) value.policies.campaign = structuredClone(campaignScope);
  const standing = isStandingCampaign(campaignScope);
  value.policies.reruns.max_episodes = standing ? null : 0;
  if (standing) { value.policies.pilot.max_scheduled_episodes = null; value.policies.pilot.route_gate_episodes = null; }
  value.policies.evidence = { ...value.policies.evidence, observer_version: 'benchmark-pi-sdk-1',
    normalizer_version: EVIDENCE_VERSION, scoring_version: ANALYSIS_VERSION };
  value.protocol_sha256 = fingerprint({ ...value, protocol_sha256: null });
  const validation = validateProtocol(value, { stage: 'execute' });
  assert.ok(validation.valid, JSON.stringify(validation.errors));
  return value;
}

export function boundedBudget({ id, episodes, durationMs, requests, inputTokens, outputTokens, batchDurationMs }) {
  for (const value of [episodes, durationMs, requests, inputTokens, outputTokens, batchDurationMs]) assert.ok(Number.isSafeInteger(value) && value > 0);
  return { id, episode: { max_duration_ms: durationMs, max_model_requests: requests, max_input_tokens: inputTokens,
    max_output_tokens: outputTokens, max_http_attempts: requests, max_retries: 0 },
    batch: { max_episodes: episodes, max_model_requests: requests * episodes, max_input_tokens: inputTokens * episodes,
      max_output_tokens: outputTokens * episodes, max_duration_ms: batchDurationMs, max_concurrency: 1 },
    monetary: { policy: 'unpriced', currency: null, max_amount: null, pricing_sha256: null } };
}
