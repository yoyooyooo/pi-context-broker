import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fingerprint } from './protocol.mjs';
import { buildCorpus, writeCorpus } from './corpus/index.mjs';
import { buildStoreDiagnosticCorpus, STORE_FIRST_USE_GENERATOR } from './diagnostic-corpus.mjs';
import { readCorpusSnapshot } from './corpus/snapshot.mjs';
import { bindMaterializedCases, comparisonEnvironmentPairs, comparisonPairs, prepareCases, preregisterComparison } from './planning.mjs';
import { prepareEpisodeFixtures, readEpisodeFixtureBindings, validateEpisodeFixturePolicy } from './fixture-dispatch.mjs';
import { snapshotModels, verifiedModelConditions, resolveModelCredential } from './models.mjs';
import { environmentFromCapture } from './manifest.mjs';
import { freezeBatchPlan, validateBatchPlan, scheduleProtocol } from './batch.mjs';
import { runSubject, verifyTurnRuntimeBuild } from './execute.mjs';
import { executionImplementation, verifyExecutionImplementation, instrumentationIdentity } from './implementation.mjs';
import { prepareZeroSendResumption } from './resumption.mjs';
import { pilotScopePolicy } from './pilot-scope.mjs';
import { prepareCampaignScope, verifyCampaignScope } from './campaign-dispatch.mjs';
import { finiteCampaignPolicy } from './finite-campaign.mjs';
import { prepareMaterialOwnership, verifyMaterialOwnership } from './material-ownership.mjs';
import { CONFIRMATION_CONTINUATION, ENGINEERING_WINDOW_CONTINUATION, declaredSchedule } from './campaign-selection.mjs';
import { readApprovedCampaign } from './approved-campaign.mjs';
import { assertObserverRepairSetup } from './campaign-observer-repair-continuation.mjs';
import { ENGINEERING_WINDOW_DRAFT, assertEngineeringWindowSetup, isEngineeringContinuationAuthority } from './campaign-engineering-window-continuation.mjs';
import { ENGINEERING_PREFLIGHT_REPAIR_DRAFT } from './campaign-engineering-preflight-repair.mjs';
import { assertStandingSetup, standingCampaignPolicy } from './standing-campaign.mjs';

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
  if (candidate.mode === 'broker') assert.equal(run.remote.library, binding.notion_entry);
  else { assert.equal(run.remote.library, null); assert.equal(run.pi_launch.native_corpus.source, binding.skills_root); }
}

/** Owned clean diagnostic arms need their own capture even with no state events. */
export function captureBindingsForCase({ binding, conditionId, slots, slotBindings }) {
  const scheduled = slots.filter(slot => slot.case_id === binding.id && slot.condition_id === conditionId);
  if (!scheduled.length) return [];
  const owned = scheduled.filter(slot => slotBindings.has(slot.slot_id));
  if (!owned.length) {
    assert.equal(binding.events.length, 0, 'Stateful capture requires its owned slot fixture');
    return [{ binding }];
  }
  assert.equal(owned.length, scheduled.length, 'Capture materializations must cover every scheduled repeat');
  return scheduled.map(slot => ({ slot, binding: slotBindings.get(slot.slot_id).binding }));
}

/** A continuation retains the full original startup-condition mapping even
 * though dispatch owns only the unstarted suffix. These are zero-model captures,
 * not retries of the original completed slots. Stateful copies are excluded. */
export function startupCaptureSchedule(protocol, cases, episodeFixtures) {
  if (![CONFIRMATION_CONTINUATION, ENGINEERING_WINDOW_CONTINUATION].includes(protocol.policies.campaign?.role)) return scheduleProtocol(protocol);
  assert.equal(episodeFixtures, undefined, 'CONFIRMATION_CONTINUATION_STATEFUL_FIXTURE_FORBIDDEN');
  assert.ok(cases.every(binding => binding.events.length === 0), 'CONFIRMATION_CONTINUATION_STATEFUL_FIXTURE_FORBIDDEN');
  return declaredSchedule(protocol);
}

/** Resolve public inputs, prove no-model loading, then freeze the concrete executable comparison. */
export async function configureComparison(setup, { onProgress = () => {} } = {}) {
  assert.equal(setup.version, 1);
  assert.ok(isAbsolute(setup.environment_root) && isAbsolute(setup.control_root));
  assert.ok(Array.isArray(setup.candidates));
  const environmentPairs = comparisonEnvironmentPairs(setup.candidates.length, setup.environment_pairs);
  if (setup.candidates.length !== 2) assert.ok(setup.campaign_scope || setup.standing, 'Four candidates require an explicit campaign design');
  assert.ok([setup.pilot_scope, setup.campaign_scope, setup.standing].filter(Boolean).length <= 1, 'A setup cannot mix scope contracts');
  assert.ok(setup.budget && setup.decision && setup.models && setup.corpus);
  const standing = setup.standing ? await assertStandingSetup(setup) : null;
  if (setup.campaign_scope?.prospective_authorization) {
    const reference = setup.campaign_scope.prospective_authorization;
    const bytes = await readFile(reference.path); assert.equal(sha(bytes), reference.sha256);
    const preview = JSON.parse(bytes);
    assert.notEqual(preview.kind, ENGINEERING_WINDOW_DRAFT, 'ENGINEERING_WINDOW_DRAFT_NOT_DISPATCHABLE');
    assert.notEqual(preview.kind, ENGINEERING_PREFLIGHT_REPAIR_DRAFT, 'ENGINEERING_PREFLIGHT_REPAIR_DRAFT_NOT_DISPATCHABLE');
    if (preview.version === 6) await assertObserverRepairSetup(setup, await readApprovedCampaign(reference));
    if ([7, 8].includes(preview.version)) await assertEngineeringWindowSetup(setup, await readApprovedCampaign(reference));
    if (setup.campaign_scope.role === ENGINEERING_WINDOW_CONTINUATION) assert.ok(isEngineeringContinuationAuthority(preview), 'ENGINEERING_WINDOW_AUTHORITY_REQUIRED');
  }
  else assert.notEqual(setup.campaign_scope?.role, ENGINEERING_WINDOW_CONTINUATION, 'ENGINEERING_WINDOW_APPROVAL_REQUIRED');
  const snapshot = await readCorpusSnapshot(setup);
  const root = setup.control_root;
  await mkdir(root, { recursive: true });
  await save(join(root, 'setup.json'), setup);
  let existing;
  try { existing = await readJson(join(root, 'plan.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    validateBatchPlan(existing);
    const proof = await readJson(join(root, 'configuration-proof.json'));
    assert.equal(proof.setup_sha256, fingerprint(setup)); assert.equal(proof.plan_sha256, existing.plan_sha256);
    if (snapshot) assert.deepEqual(existing.execution.corpus_snapshot, setup.corpus.snapshot);
    await verifyExecutionImplementation(existing.execution.implementation);
    if (existing.execution.pilot_scope || existing.execution.campaign_scope || existing.execution.standing_scope) await verifyCampaignScope(existing);
    const bindings = await readJson(existing.execution.case_bindings_file);
    assert.equal(sha(await readFile(existing.execution.case_bindings_file)), existing.execution.case_bindings_sha256);
    if (proof.material_original_bindings) {
      const bytes = await readFile(proof.material_original_bindings.path);
      assert.equal(sha(bytes), proof.material_original_bindings.sha256);
      const originals = JSON.parse(bytes);
      for (const item of proof.material_ownership) {
        const original = originals.find(binding => binding.id === item.case_id);
        assert.equal(fingerprint(original), item.original_binding_sha256);
        const projected = await verifyMaterialOwnership({ binding: original, reference: item.reference,
          environmentRoot: setup.environment_root });
        assert.deepEqual(projected.binding, bindings.find(binding => binding.id === item.case_id));
      }
    }
    await readEpisodeFixtureBindings({ id: existing.id, registration: existing.execution.episode_fixtures,
      environmentRoot: setup.environment_root, controlRoot: root, cases: bindings, slots: existing.slots,
      candidates: existing.execution.conditions, runtime: existing.execution.runtime, ...(snapshot ? { corpus: snapshot } : {}) });
    return { status: 'ready', plan: join(root, 'plan.json'), plan_sha256: existing.plan_sha256,
      scheduled_episodes: existing.slots.length, no_model_captures: proof.capture_count, actual_model_requests: 0, reused: true };
  }
  const materialization = setup.materialization_binding_file ? await readJson(setup.materialization_binding_file) : null;
  if (setup.corpus.generator !== undefined) assert.equal(setup.corpus.generator, STORE_FIRST_USE_GENERATOR, 'Unknown explicit corpus generator');
  const corpus = snapshot ?? (materialization ? { publicCorpus: await readJson(materialization.public_corpus_path), control: await readJson(materialization.control_path) }
    : (setup.corpus.generator === STORE_FIRST_USE_GENERATOR ? buildStoreDiagnosticCorpus : buildCorpus)(
      { seed: setup.corpus.seed, split: setup.corpus.split, materialVersion: setup.corpus.material_version }));
  if (setup.corpus.generator !== undefined) assert.equal(corpus.publicCorpus.provenance.generator, setup.corpus.generator);
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
  // Imported evidence must already have an owned, verified closure before any
  // startup capture or provider execution. Shared material keeps one native root.
  const materialOwnership = [];
  let materialOriginalBindings = null;
  if (cases.some(binding => binding.materialization_proof)) {
    const originalFile = join(root, 'material-original-case-bindings.json');
    await save(originalFile, cases);
    materialOriginalBindings = { path: originalFile, sha256: sha(await readFile(originalFile)) };
    const projectedCases = [];
    for (const binding of cases) {
      if (!binding.materialization_proof) { projectedCases.push(binding); continue; }
      const materialId = fingerprint({ materialization_proof: binding.materialization_proof,
        skills_root: binding.skills_root, skill_inventory: binding.skill_inventory });
      const projected = await prepareMaterialOwnership({ binding,
        directory: join(root, 'material-ownership', materialId), environmentRoot: setup.environment_root });
      materialOwnership.push({ case_id: binding.id, original_binding_sha256: fingerprint(binding), reference: projected.reference });
      projectedCases.push(projected.binding);
    }
    cases = projectedCases;
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
  const schedule = { pairs: comparisonPairs({ models, cases, repetitions: setup.repetitions ?? 1,
    orderingSeed: setup.ordering_seed ?? 0, environmentCount: setup.candidates.length, environmentPairs }),
  assessments: [], policies: { ordering: { seed: setup.ordering_seed ?? 0 },
    ...(standing ? { campaign: standingCampaignPolicy(standing, { scheduledEpisodes: standing.item.planned_episodes }) }
      : setup.campaign_scope ? { campaign: setup.campaign_scope } : {}) } };
  const scheduled = scheduleProtocol(schedule), captureSlots = startupCaptureSchedule(schedule, cases, setup.episode_fixtures);
  const candidatesByCondition = Object.fromEntries(models.flatMap((_model, mi) => setup.candidates.map((candidate, ei) => ['m' + mi + '-e' + ei, candidate])));
  const prepared = await prepareEpisodeFixtures({ id: setup.id, environmentRoot: setup.environment_root, controlRoot: root,
    corpus, cases, slots: scheduled, candidates: candidatesByCondition, runtime, policy: setup.episode_fixtures });
  const secrets = await resolveModelCredential({ sourceFile: credential.source_file, provider: credential.provider, apiKeyEnv: credential.api_key_env });
  const previous = Object.fromEntries(Object.keys(secrets).map(key => [key, process.env[key]]));
  Object.assign(process.env, secrets);
  const cells = models.flatMap((model, mi) => setup.candidates.flatMap((candidate, ei) => cases.flatMap((binding, ci) => {
    return captureBindingsForCase({ binding, conditionId: 'm' + mi + '-e' + ei, slots: captureSlots, slotBindings: prepared.slots })
      .map(actual => ({ model, candidate: { ...candidate,
        ...(actual.slot && candidate.mode === 'broker' ? { notion_entry: actual.binding.notion_entry } : {}) },
      binding: actual.binding, mi, ei, ci, ...(actual.slot ? { slot: actual.slot } : {}) }));
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
        assert.equal(launch.runtime_config.limits.mode ?? 'bounded', setup.budget.mode ?? 'bounded', 'Retained capture resource policy changed');
      } catch (error) { if (error.code !== 'ENOENT') throw error; raw = null; }
      if (!raw) raw = await runSubject({ environmentRoot: setup.environment_root, buildId: job.candidate.build_id, mode: job.candidate.mode,
        binding: job.binding, model: { ...job.model, baseUrl: registry.base_url }, modelsFile, runtime,
        controlRoot: root, runId: id, conditionId: 'm' + job.mi + '-e' + job.ei, budget: setup.budget.episode, budgetMode: setup.budget.mode ?? 'bounded',
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
    analysis: setup.analysis, pilotScope: pilotScopePolicy(setup.pilot_scope, { modelCount: models.length }),
    campaignScope: standing ? standingCampaignPolicy(standing, { scheduledEpisodes: scheduled.length })
      : setup.campaign_scope ? finiteCampaignPolicy(setup.campaign_scope, { scheduledEpisodes: scheduled.length }) : undefined,
    environmentPairs, allowedChanges: setup.allowed_changes, orderingSeed: setup.ordering_seed });
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
    ...(snapshot ? { corpus_snapshot: structuredClone(setup.corpus.snapshot) } : {}),
    ...(prepared.registration ? { episode_fixtures: prepared.registration } : {}),
    ...(standing ? { pilot_ledger_root: standing.ledgerRoot }
      : setup.pilot_ledger_root ? { pilot_ledger_root: setup.pilot_ledger_root } : {}), ...(setup.route_gate ? { route_gate: setup.route_gate } : {}) };
  const resumption = await prepareZeroSendResumption({ setup, protocol, captures: results, currentSchedule: scheduleProtocol(protocol) });
  if (resumption) execution.resumption = resumption;
  execution.instrumentation = await instrumentationIdentity(execution);
  const scope = await prepareCampaignScope({ setup, protocol, execution, slots: scheduleProtocol(protocol), captures: results });
  if (scope) execution[scope.field] = scope.registration;
  const plan = freezeBatchPlan({ protocol, execution });
  await save(join(root, 'plan.json'), plan);
  await save(join(root, 'configuration-proof.json'), { version: 1, setup_sha256: fingerprint(setup), plan_sha256: plan.plan_sha256,
    status: 'ready', capture_count: results.length, covered_case_conditions: expanded.length, actual_model_requests: 0,
    ...([CONFIRMATION_CONTINUATION, ENGINEERING_WINDOW_CONTINUATION].includes(setup.campaign_scope?.role) ? { capture_design_slots: captureSlots.length, selected_dispatch_slots: scheduled.length } : {}),
    capture_scope: 'shared-identical-startup-inputs; every episode independently verifies public-input bytes and actual startup/final-request contracts',
    material_original_bindings: materialOriginalBindings, material_ownership: materialOwnership,
    frozen_slot_materializations: prepared.slots.size,
    capture_refs: results.map(result => ({ run_id: result.raw.run_id, case_ids: result.members.map(member => member.binding.id),
      ...(result.slot ? { slot_id: result.slot.slot_id, materialization: prepared.slots.get(result.slot.slot_id).ref } : {}), expectation: result.expectation })) });
  return { status: 'ready', plan: join(root, 'plan.json'), plan_sha256: plan.plan_sha256, scheduled_episodes: plan.slots.length,
    no_model_captures: results.length, actual_model_requests: 0 };
}
