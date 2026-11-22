import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fingerprint } from './protocol.mjs';
import { buildCorpus, writeCorpus } from './corpus/index.mjs';
import { bindMaterializedCases, prepareCases, preregisterComparison } from './planning.mjs';
import { snapshotModels, verifiedModelConditions, resolveModelCredential } from './models.mjs';
import { environmentFromCapture } from './manifest.mjs';
import { freezeBatchPlan, validateBatchPlan, scheduleProtocol } from './batch.mjs';
import { runSubject } from './execute.mjs';
import { executionImplementation, verifyExecutionImplementation, instrumentationIdentity } from './implementation.mjs';
import { prepareZeroSendResumption } from './resumption.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = async (path, value) => {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await readFile(path, 'utf8'), bytes, 'Existing configuration differs: ' + path); }
};
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

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
  if (materialization) {
    cases = await bindMaterializedCases({ cases, materialization });
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
  const models = verifiedModelConditions({ registry, adapterReceipts, parameters: setup.models.parameters, window: setup.models.window });
  const credential = { source_file: setup.models.source_file, provider: setup.models.provider, api_key_env: registry.api_key_env };
  const runtime = setup.runtime;
  assert.ok(runtime && isAbsolute(runtime.node) && isAbsolute(runtime.pi) && isAbsolute(runtime.bun));
  const secrets = await resolveModelCredential({ sourceFile: credential.source_file, provider: credential.provider, apiKeyEnv: credential.api_key_env });
  const previous = Object.fromEntries(Object.keys(secrets).map(key => [key, process.env[key]]));
  Object.assign(process.env, secrets);
  const cells = models.flatMap((model, mi) => setup.candidates.flatMap((candidate, ei) => cases.map((binding, ci) => ({ model, candidate, binding, mi, ei, ci }))));
  // Natural prompts and task files are bound separately and checked on every run.
  // Identical startup inputs share a frozen expectation; every actual first payload
  // still has to match it before transport. No observation is fabricated by substitution.
  const groups = new Map();
  for (const cell of cells) {
    const key = fingerprint({ model: cell.model, candidate: cell.candidate, runtime,
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
      const job = jobs[index], id = setup.id + '-capture-m' + job.mi + '-e' + job.ei + '-c' + job.ci;
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
      expectationSet: selected.map(result => ({ model_id: result.model.id, case_id: result.binding.id, sha256: result.expectation.sha256 })),
      corpusSha256: corpus.publicCorpus.content_sha256, sourceKind: candidate.source_kind, codeMode: candidate.code_mode });
    await save(join(root, candidate.id + '.manifest.json'), value); return value;
  }));
  const protocol = preregisterComparison({ id: setup.id, phase: setup.phase, purpose: setup.purpose, environments, models,
    corpus: corpus.publicCorpus, cases, repetitions: setup.repetitions ?? 1, budget: setup.budget, decision: setup.decision,
    analysis: setup.analysis, allowedChanges: setup.allowed_changes, orderingSeed: setup.ordering_seed });
  const conditions = Object.fromEntries(protocol.conditions.map(condition => {
    const ei = environments.findIndex(environment => environment.id === condition.environment_id), candidate = setup.candidates[ei];
    const selected = expanded.filter(result => result.ei === ei && result.model.id === condition.model_id);
    return [condition.id, { build_id: candidate.build_id, mode: candidate.mode, ...(candidate.notion_entry ? { notion_entry: candidate.notion_entry } : {}),
      expectations: Object.fromEntries(selected.map(result => [result.binding.id, result.expectation])) }];
  }));
  const execution = { environment_root: setup.environment_root, control_root: root, runtime, conditions,
    implementation: await executionImplementation(),
    case_bindings_file: bindingsFile, case_bindings_sha256: sha(await readFile(bindingsFile)),
    models_file: modelsFile, models_sha256: registry.sha256, model_base_url: registry.base_url, credential,
    adapter_evidence_file: setup.models.adapter_evidence_file,
    ...(setup.pilot_ledger_root ? { pilot_ledger_root: setup.pilot_ledger_root } : {}), ...(setup.route_gate ? { route_gate: setup.route_gate } : {}) };
  const resumption = await prepareZeroSendResumption({ setup, protocol, captures: results, currentSchedule: scheduleProtocol(protocol) });
  if (resumption) execution.resumption = resumption;
  execution.instrumentation = await instrumentationIdentity(execution);
  const plan = freezeBatchPlan({ protocol, execution });
  await save(join(root, 'plan.json'), plan);
  await save(join(root, 'configuration-proof.json'), { version: 1, setup_sha256: fingerprint(setup), plan_sha256: plan.plan_sha256,
    status: 'ready', capture_count: results.length, covered_case_conditions: expanded.length, actual_model_requests: 0,
    capture_scope: 'shared-identical-startup-inputs; every episode independently verifies public-input bytes and actual startup/final-request contracts',
    capture_refs: results.map(result => ({ run_id: result.raw.run_id, case_ids: result.members.map(member => member.binding.id), expectation: result.expectation })) });
  return { status: 'ready', plan: join(root, 'plan.json'), plan_sha256: plan.plan_sha256, scheduled_episodes: plan.slots.length,
    no_model_captures: results.length, actual_model_requests: 0 };
}
