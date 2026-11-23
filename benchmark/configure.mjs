import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fingerprint } from './protocol.mjs';
import { buildCorpus, writeCorpus } from './corpus/index.mjs';
import { bindMaterializedCases, comparisonPairs, prepareCases, preregisterComparison } from './planning.mjs';
import { prepareEpisodeFixtures, readEpisodeFixtureBindings, validateEpisodeFixturePolicy } from './fixture-dispatch.mjs';
import { snapshotModels, verifiedModelConditions, resolveModelCredential } from './models.mjs';
import { environmentFromCapture } from './manifest.mjs';
import { freezeBatchPlan, validateBatchPlan, scheduleProtocol } from './batch.mjs';
import { runSubject, verifyTurnRuntimeBuild } from './execute.mjs';
import { executionImplementation, verifyExecutionImplementation, instrumentationIdentity } from './implementation.mjs';
import { prepareZeroSendResumption } from './resumption.mjs';
import { pilotScopePolicy, preparePilotScope, verifyPilotScope } from './pilot-scope.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = async (path, value) => {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await readFile(path, 'utf8'), bytes, 'Existing configuration differs: ' + path); }
};
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

/** Each slot capture must belong to its exact physical material binding. */
export function verifyRetainedSlotCapture({ launch, run, binding, candidate, conditionId }) {
  assert.equal(launch.input_root, binding.input_root);
  assert.equal(launch.input_inventory_sha256, binding.input_inventory_sha256);
  assert.deepEqual(launch.runtime_config.turns, binding.public_case.turns.map(({ id, prompt }) => ({ id, prompt })));
  assert.equal(launch.runtime_config.correlation.candidate_id, conditionId);
  assert.equal(launch.runtime_config.correlation.task_id, binding.id);
  assert.equal(run.build_id, candidate.build_id); assert.equal(run.pi_launch.mode, candidate.mode);
  if (candidate.mode === 'broker') assert.equal(run.remote.entry, binding.notion_entry);
  else { assert.equal(run.remote.entry, null); assert.equal(run.pi_launch.native_corpus.source, binding.skills_root); }
}

/** Resolve public inputs, prove no-model loading, then freeze the concrete executable comparison. */
export async function configureComparison(setup, { onProgress = () => {} } = {}) {
  assert.equal(setup.version, 1);
  assert.ok(isAbsolute(setup.environment_root) && isAbsolute(setup.control_root));
  assert.ok(Array.isArray(setup.candidates) && setup.candidates.length === 2);
  assert.ok(setup.budget && setup.decision && setup.models && setup.corpus);
  const root = setup.control_root;
  await mkdir(root, { recursive: true });
  await save(join(root, 'setup.json'), setup);
  let existing;
  try { existing = await readJson(join(root, 'plan.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    validateBatchPlan(existing);
    const proof = await readJson(join(root, 'configuration-proof.json'));
    assert.equal(proof.setup_sha256, fingerprint(setup)); assert.equal(proof.plan_sha256, existing.plan_sha256);
    await verifyExecutionImplementation(existing.execution.implementation);
    if (existing.execution.pilot_scope) await verifyPilotScope(existing);
    const bindings = await readJson(existing.execution.case_bindings_file);
    assert.equal(sha(await readFile(existing.execution.case_bindings_file)), existing.execution.case_bindings_sha256);
    await readEpisodeFixtureBindings({ id: existing.id, registration: existing.execution.episode_fixtures,
      environmentRoot: setup.environment_root, controlRoot: root, cases: bindings, slots: existing.slots,
      candidates: existing.execution.conditions, runtime: existing.execution.runtime });
    return { status: 'ready', plan: join(root, 'plan.json'), plan_sha256: existing.plan_sha256,
      scheduled_episodes: existing.slots.length, no_model_captures: proof.capture_count, actual_model_requests: 0, reused: true };
  }
  const materialization = setup.materialization_binding_file ? await readJson(setup.materialization_binding_file) : null;
  const corpus = materialization ? { publicCorpus: await readJson(materialization.public_corpus_path), control: await readJson(materialization.control_path) }
    : buildCorpus({ seed: setup.corpus.seed, split: setup.corpus.split, materialVersion: setup.corpus.material_version });
  assert.equal(corpus.publicCorpus.seed, setup.corpus.seed); assert.equal(corpus.publicCorpus.split, setup.corpus.split);
  assert.equal(corpus.publicCorpus.version, setup.corpus.material_version);
  if (materialization) assert.equal(corpus.publicCorpus.content_sha256, materialization.public_sha256);
  await writeCorpus({ corpus, publicRoot: join(root, 'corpus-public'), controlRoot: join(root, 'corpus-private') });
  let cases = await prepareCases({ corpus, selections: setup.corpus.selections, root: join(root, 'cases') });
  // Stateful preparation can allocate remote objects. Reject an older subject
  // implementation before that work, even though capture itself sends no model request.
  const turnRuntimeBuilds = [];
  for (const buildId of new Set(setup.candidates.map(candidate => candidate.build_id))) {
    for (const binding of cases) {
      const proof = await verifyTurnRuntimeBuild({ environmentRoot: setup.environment_root, buildId, binding });
      if (proof.required) { turnRuntimeBuilds.push(proof); break; }
    }
  }
  if (turnRuntimeBuilds.length) await save(join(root, 'turn-runtime-builds.json'), turnRuntimeBuilds);
  validateEpisodeFixturePolicy(setup.episode_fixtures, { required: cases.some(binding => binding.events.length > 0) });
  if (materialization) {
    const shared = await bindMaterializedCases({ cases: cases.filter(binding => !binding.events.length), materialization });
    cases = cases.map(binding => shared.find(item => item.id === binding.id) ?? binding);
    for (const candidate of setup.candidates) if (candidate.mode === 'broker') assert.equal(candidate.notion_entry, materialization.entry);
  }
  const bindingsFile = join(root, 'case-bindings.json'); await save(bindingsFile, cases);
  const modelsFile = join(root, 'models.json');
  const registry = await snapshotModels({ sourceFile: setup.models.source_file, provider: setup.models.provider,
    modelIds: setup.models.ids, outputFile: modelsFile, apiKeyEnv: setup.models.api_key_env });
  await save(join(root, 'model-registry.json'), registry);
  const proofBytes = await readFile(setup.models.adapter_evidence_file), proof = JSON.parse(proofBytes);
  assert.equal(proof.kind, 'controlled-http-maintained-pi-adapter-proof'); assert.equal(proof.status, 'passed');
  for (const file of [proof.pi_manifest, proof.sdk_entry, ...proof.source_modules]) assert.equal(sha(await readFile(file.path)), file.sha256, 'Verified adapter module changed');
  const adapterReceipts = [...new Set(registry.models.map(model => model.api))].map(api => ({ api, id: 'maintained-pi-' + api,
    version: '1.0.0', status: 'passed', sha256: sha(proofBytes) }));
  const models = verifiedModelConditions({ registry, adapterReceipts, parameters: setup.models.parameters, window: setup.models.window,
    ...(setup.models.routing ? { routing: setup.models.routing } : {}) });
  const credential = { source_file: setup.models.source_file, provider: setup.models.provider, api_key_env: registry.api_key_env };
  const runtime = setup.runtime;
  assert.ok(runtime && isAbsolute(runtime.node) && isAbsolute(runtime.pi) && isAbsolute(runtime.bun));
  const scheduled = scheduleProtocol({ pairs: comparisonPairs({ models, cases, repetitions: setup.repetitions ?? 1,
    orderingSeed: setup.ordering_seed ?? 0 }), assessments: [], policies: { ordering: { seed: setup.ordering_seed ?? 0 } } });
  const candidatesByCondition = Object.fromEntries(models.flatMap((_model, mi) => setup.candidates.map((candidate, ei) => ['m' + mi + '-e' + ei, candidate])));
  const prepared = await prepareEpisodeFixtures({ id: setup.id, environmentRoot: setup.environment_root, controlRoot: root,
    corpus, cases, slots: scheduled, candidates: candidatesByCondition, runtime, policy: setup.episode_fixtures });
  const secrets = await resolveModelCredential({ sourceFile: credential.source_file, provider: credential.provider, apiKeyEnv: credential.api_key_env });
  const previous = Object.fromEntries(Object.keys(secrets).map(key => [key, process.env[key]]));
  Object.assign(process.env, secrets);
  const cells = models.flatMap((model, mi) => setup.candidates.flatMap((candidate, ei) => cases.flatMap((binding, ci) => {
    if (!binding.events.length) return [{ model, candidate, binding, mi, ei, ci }];
    return scheduled.filter(slot => slot.case_id === binding.id && slot.condition_id === 'm' + mi + '-e' + ei).map(slot => {
      const actual = prepared.slots.get(slot.slot_id); assert.ok(actual);
      return { model, candidate: { ...candidate, ...(candidate.mode === 'broker' ? { notion_entry: actual.binding.notion_entry } : {}) },
        binding: actual.binding, mi, ei, ci, slot };
    });
  })));
  // Natural prompts and task files are bound separately and checked on every run.
  // Identical startup inputs share a frozen expectation; every actual first payload
  // still has to match it before transport. No observation is fabricated by substitution.
  const groups = new Map();
  for (const cell of cells) {
    const key = fingerprint({ model: cell.model, candidate: cell.candidate, runtime,
      ...(cell.slot ? { slot_id: cell.slot.slot_id } : {}),
      skills_root: cell.candidate.mode === 'native' || !cell.candidate.notion_entry ? cell.binding.skills_root : null });
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(cell);
  }
  const jobs = [...groups.values()].map(members => ({ ...members[0], members }));
  const results = new Array(jobs.length); let cursor = 0;
  const concurrency = setup.capture_concurrency ?? 2;
  assert.ok(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 3);
  const worker = async () => {
    for (;;) {
      const index = cursor++; if (index >= jobs.length) return;
      const job = jobs[index], id = job.slot ? setup.id + '-capture-slot-' + String(job.slot.order + 1).padStart(3, '0')
        : setup.id + '-capture-m' + job.mi + '-e' + job.ei + '-c' + job.ci;
      const captureFile = join(root, id + '.capture.json');
      let raw;
      try {
        raw = await readJson(captureFile);
        assert.equal(raw.run_id, id);
        assert.deepEqual(await readJson(join(raw.root, 'result.json')), raw.shared, 'Retained capture parent receipt changed');
        assert.deepEqual(await readJson(raw.result_path), raw.episode, 'Retained capture runtime receipt changed');
        const launch = await readJson(join(root, id + '.launch.json'));
        assert.equal(launch.input_inventory_sha256, job.binding.input_inventory_sha256);
        assert.equal(launch.runtime_config.mode, job.candidate.mode);
        assert.equal(launch.runtime_config.model.id, job.model.route);
        assert.deepEqual(launch.runtime_config.runtime, runtime);
      } catch (error) { if (error.code !== 'ENOENT') throw error; raw = null; }
      if (!raw) raw = await runSubject({ environmentRoot: setup.environment_root, buildId: job.candidate.build_id, mode: job.candidate.mode,
        binding: job.binding, model: { ...job.model, baseUrl: registry.base_url }, modelsFile, runtime,
        controlRoot: root, runId: id, conditionId: 'm' + job.mi + '-e' + job.ei, budget: setup.budget.episode,
        codeMode: job.candidate.code_mode, captureOnly: true, credential, notionEntry: job.candidate.notion_entry });
      await save(captureFile, raw);
      assert.equal(raw.status, 'captured', 'No-model capture failed: ' + id);
      assert.equal(raw.shared.status, 'passed');
      assert.equal(raw.episode.budget.attempts, 0); assert.equal(raw.episode.budget.tools, 0);
      if (job.slot) verifyRetainedSlotCapture({ launch: await readJson(join(root, id + '.launch.json')),
        run: await readJson(join(raw.root, 'run.json')), binding: job.binding,
        candidate: job.candidate, conditionId: 'm' + job.mi + '-e' + job.ei });
      const path = join(root, id + '.expectation.json');
      try { await copyFile(raw.episode.paths.expectation, path, 1); }
      catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(sha(await readFile(path)), sha(await readFile(raw.episode.paths.expectation))); }
      await chmod(path, 0o400);
      results[index] = { ...job, raw, expectation: { path, sha256: sha(await readFile(path)) } };
      onProgress({ type: 'capture_completed', id, completed: results.filter(Boolean).length, total: jobs.length });
    }
  };
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
    const rejected = outcomes.find(outcome => outcome.status === 'rejected'); if (rejected) throw rejected.reason;
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  const runtimeIdentity = projection => ({ node: projection.node, node_version: projection.node_version, bun: projection.bun, pi: projection.pi,
    ...(projection.git ? { git: projection.git } : {}) });
  const captured = await Promise.all(results.map(result => readJson(result.expectation.path)));
  if (!setup.allowed_changes.includes('runtime')) for (const value of captured) assert.deepEqual(runtimeIdentity(value.projection), runtimeIdentity(captured[0].projection), 'Runtime changed during no-model setup');
  const expanded = results.flatMap(result => result.members.map(member => ({ ...member, raw: result.raw, expectation: result.expectation })));
  const environments = await Promise.all(setup.candidates.map(async (candidate, ei) => {
    const selected = expanded.filter(result => result.ei === ei), first = selected[0];
    const value = await environmentFromCapture({ id: candidate.id, environmentRoot: setup.environment_root,
      buildId: candidate.build_id, expectationFile: first.expectation.path, runResultFile: join(first.raw.root, 'result.json'),
      expectationSet: selected.map(result => ({ model_id: result.model.id, case_id: result.binding.id,
        ...(result.slot ? { slot_id: result.slot.slot_id, materialization_sha256: prepared.slots.get(result.slot.slot_id).ref.sha256 } : {}),
        sha256: result.expectation.sha256 })),
      corpusSha256: corpus.publicCorpus.content_sha256, sourceKind: candidate.source_kind, codeMode: candidate.code_mode });
    await save(join(root, candidate.id + '.manifest.json'), value); return value;
  }));
  const protocol = preregisterComparison({ id: setup.id, phase: setup.phase, purpose: setup.purpose, environments, models,
    corpus: corpus.publicCorpus, cases, repetitions: setup.repetitions ?? 1, budget: setup.budget, decision: setup.decision,
    analysis: setup.analysis, pilotScope: pilotScopePolicy(setup.pilot_scope, { modelCount: models.length }), allowedChanges: setup.allowed_changes, orderingSeed: setup.ordering_seed });
  assert.deepEqual(scheduleProtocol(protocol), scheduled, 'Fixture ownership differs from the final frozen comparison schedule');
  const conditions = Object.fromEntries(protocol.conditions.map(condition => {
    const ei = environments.findIndex(environment => environment.id === condition.environment_id), candidate = setup.candidates[ei];
    const selected = expanded.filter(result => result.ei === ei && result.model.id === condition.model_id);
    return [condition.id, { build_id: candidate.build_id, mode: candidate.mode, ...(candidate.notion_entry ? { notion_entry: candidate.notion_entry } : {}),
      expectations: Object.fromEntries(selected.map(result => [result.slot?.slot_id ?? result.binding.id, result.expectation])) }];
  }));
  const execution = { environment_root: setup.environment_root, control_root: root, runtime, conditions,
    implementation: await executionImplementation(),
    case_bindings_file: bindingsFile, case_bindings_sha256: sha(await readFile(bindingsFile)),
    models_file: modelsFile, models_sha256: registry.sha256, model_base_url: registry.base_url, credential,
    adapter_evidence_file: setup.models.adapter_evidence_file,
    ...(prepared.registration ? { episode_fixtures: prepared.registration } : {}),
    ...(setup.pilot_ledger_root ? { pilot_ledger_root: setup.pilot_ledger_root } : {}), ...(setup.route_gate ? { route_gate: setup.route_gate } : {}) };
  const resumption = await prepareZeroSendResumption({ setup, protocol, captures: results, currentSchedule: scheduleProtocol(protocol) });
  if (resumption) execution.resumption = resumption;
  execution.instrumentation = await instrumentationIdentity(execution);
  const scope = await preparePilotScope({ setup, protocol, execution, slots: scheduleProtocol(protocol), captures: results });
  if (scope) execution.pilot_scope = scope;
  const plan = freezeBatchPlan({ protocol, execution });
  await save(join(root, 'plan.json'), plan);
  await save(join(root, 'configuration-proof.json'), { version: 1, setup_sha256: fingerprint(setup), plan_sha256: plan.plan_sha256,
    status: 'ready', capture_count: results.length, covered_case_conditions: expanded.length, actual_model_requests: 0,
    capture_scope: 'shared-identical-startup-inputs; every episode independently verifies public-input bytes and actual startup/final-request contracts',
    frozen_slot_materializations: prepared.slots.size,
    capture_refs: results.map(result => ({ run_id: result.raw.run_id, case_ids: result.members.map(member => member.binding.id),
      ...(result.slot ? { slot_id: result.slot.slot_id, materialization: prepared.slots.get(result.slot.slot_id).ref } : {}), expectation: result.expectation })) });
  return { status: 'ready', plan: join(root, 'plan.json'), plan_sha256: plan.plan_sha256, scheduled_episodes: plan.slots.length,
    no_model_captures: results.length, actual_model_requests: 0 };
}
