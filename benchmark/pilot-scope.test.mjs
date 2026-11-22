import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fingerprint, validateProtocol } from './protocol.mjs';
import { createPreregistrationTemplate } from './templates/preregistration.mjs';
import { preregisterComparison } from './planning.mjs';
import { batchStatus, freezeBatchPlan, runBatch, scheduleProtocol } from './batch.mjs';
import { assertManualAuthRejection, pilotScopePolicy, preparePilotScope, readPilotScopeAmendment, readScopeCompletedResults, verifyPilotScope } from './pilot-scope.mjs';
import { verifyGateReference, writeRouteGate } from './gate.mjs';
import { exampleEnvelope } from './analysis/fixtures.mjs';
import { normalizeEpisode, unknown } from './evidence/normalize.mjs';
import { writeEvidenceBundle } from './evidence/store.mjs';
import { executionImplementation } from './implementation.mjs';
import { assertZeroSendInvalid } from './resumption.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const authProvider = 'fixture-provider';
const authFromRoute = 'synthetic-expired/gpt-6.2-sol';
const authToRoute = 'synthetic-replacement/gpt-6.2-sol';
const authOtherRoute = 'synthetic-secondary/grok-4.6';
const authFromId = authProvider + '/' + authFromRoute;
const authToId = authProvider + '/' + authToRoute;
const instrumentation = { version: 1, runtime_sha256: ['a'.repeat(64)], collector_files: [], collector_sha256: fingerprint([]), scope: 'synthetic test only' };
const buildFixture = id => ({ build_id: id, packages: Object.fromEntries(['cli', 'broker'].map(name => [name, { files:
  ['src/index.ts', 'dist/sdk.js', 'package.json'].map(path => ({ path, sha256: fingerprint({ name, path }), bytes: 1 })) }])) });

// Every observation below is an offline fixture. None is a real model score.
function protocol(id, { scope, repetitions = 1, prefix = '', authRoutes = false } = {}) {
  const p = createPreregistrationTemplate(), h = fingerprint({ synthetic_scope_test: true });
  for (const [index, environment] of p.environments.entries()) {
    environment.status = 'frozen'; environment.build.id = 'synthetic'; environment.build.receipt_sha256 = sha(JSON.stringify(buildFixture('synthetic'), null, 2) + '\n');
    for (const item of [environment.build.cli, environment.build.broker]) for (const key of Object.keys(item)) item[key] = key === 'commit' ? '1'.repeat(40) : h;
    for (const [name, runtime] of Object.entries(environment.runtime)) Object.assign(runtime, { entry: '/synthetic/' + name, version: '1.0.0', sha256: h });
    environment.pi.entry = environment.runtime.pi.entry;
    environment.pi.entry_kind = 'pi-sdk';
    for (const key of Object.keys(environment.pi)) if (key.endsWith('_sha256')) environment.pi[key] = h;
    environment.pi.extensions.forEach(item => { item.sha256 = h; });
    if (index === 1) {
      environment.pi.mode = 'native'; environment.pi.extensions = environment.pi.extensions.filter(item => item.role !== 'broker');
      environment.pi.native_root = { path: '/synthetic/native', content_sha256: h };
    }
    environment.manifest_sha256 = fingerprint({ ...environment, manifest_sha256: null });
  }
  p.models[0].adapter.verification = 'verified'; p.models[0].adapter.evidence_sha256 = h; p.models[0].id = 'provider/model-a';
  const models = [p.models[0], { ...structuredClone(p.models[0]), id: 'provider/model-b', route: 'pinned/other-model' }];
  if (authRoutes) models.forEach((model, index) => {
    const route = index === 0 ? authFromRoute : authOtherRoute;
    Object.assign(model, { id: authProvider + '/' + route, provider: authProvider, family: route, route,
      api: index === 0 ? 'openai-completions' : 'openai-responses', parameters: { thinkingLevel: 'medium', maxTokens: 4096 } });
  });
  const cases = Array.from({ length: 4 }, (_, i) => {
    const item = { ...p.corpus.cases[0], id: prefix + 'case-' + i, material_id: prefix + 'material-' + i,
      cluster_id: prefix + 'cluster-' + i, content_sha256: fingerprint({ case: prefix + i }) };
    return { id: item.id, protocol_case: item };
  });
  const budget = structuredClone(p.policies.budgets[0]);
  budget.episode = { max_duration_ms: 1000, max_model_requests: 10, max_input_tokens: 1000, max_output_tokens: 1000, max_http_attempts: 10, max_retries: 0 };
  budget.batch = { max_episodes: 144, max_model_requests: 1440, max_input_tokens: 144000, max_output_tokens: 144000, max_duration_ms: 1440000, max_concurrency: 1 };
  const decision = { ...p.policies.decision, absolute_quality_required: 0.8, unassisted_quality_required: 0.8, input_ratio_max: 1.1, capped_time_ratio_max: 1.15 };
  return preregisterComparison({ id, phase: 'pilot', purpose: 'native_calibration', environments: p.environments, models,
    corpus: p.corpus, cases, repetitions, budget, decision, pilotScope: scope, orderingSeed: authRoutes ? 3 : 0,
    allowedChanges: ['build', 'runtime', 'pi_mode', 'config', 'extensions', 'tools', 'catalog', 'sources', 'native_root',
      'guidance', 'injection', 'return_contract', 'error_contract', 'cache', 'session', 'recovery', 'code_mode'],
    registeredAt: '2026-11-22T10:00:00Z' });
}

async function resultFor(plan, slot, runId, { attempts = [50], valid = true, stop = false, outcome = 'unknown', unknownOutput = false } = {}) {
  const root = plan.execution.environment_root, rawRoot = join(root, 'raw'); await mkdir(rawRoot, { recursive: true });
  const rawPath = join(rawRoot, runId + '.json');
  let envelope = exampleEnvelope({ condition: slot.condition_id, caseId: slot.case_id, episodeId: runId,
    repeat: slot.repeat, attemptInputs: attempts, valid, outcome, rawPath });
  if (unknownOutput) {
    const raw = JSON.parse(envelope.rawText), oldHash = envelope.input.artifacts[0].sha256;
    raw.attempts.forEach(attempt => { attempt.output = null; });
    envelope.rawText = JSON.stringify(raw) + '\n';
    envelope.input = JSON.parse(JSON.stringify(envelope.input).replaceAll(oldHash, sha(envelope.rawText)));
    envelope.input.artifacts[0].bytes = Buffer.byteLength(envelope.rawText);
    envelope.input.attempts.forEach(attempt => { attempt.usage.output = unknown('Synthetic missing auth-rejection usage', attempt.usage.output.refs); });
  }
  const condition = plan.protocol.conditions.find(item => item.id === slot.condition_id);
  const environment = plan.protocol.environments.find(item => item.id === condition.environment_id);
  Object.assign(envelope.input.identity, { run_id: runId, experiment_id: plan.id, model_id: condition.model_id,
    environment_sha256: environment.manifest_sha256, build_id: environment.build.id, analysis_implementation: { files: [] } });
  await writeFile(rawPath, envelope.rawText);
  const bundle = normalizeEpisode(envelope.input), e = bundle.episode;
  const directory = join(root, 'evidence', runId); await writeEvidenceBundle({ directory, bundle, rawRoot: root });
  return { status: valid ? 'completed' : 'invalid', normalized_directory: directory, episode_sha256: e.episode_sha256,
    budget_usage: { model_requests: e.measurements.actual_attempts.value,
      input_tokens: e.measurements.input_total.value.status === 'known' ? e.measurements.input_total.value.value : null,
      output_tokens: e.measurements.output_total.value.status === 'known' ? e.measurements.output_total.value.value : null,
      duration_ms: e.timing.duration_ms.value }, stop_batch: stop, stop_reason: stop ? 'synthetic_core_stop' : null };
}

async function fixture({ authRoutes = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-prospective-scope-'))), pilot = join(root, 'pilot-ledger');
  await mkdir(join(root, 'builds/synthetic'), { recursive: true }); await save(join(root, 'builds/synthetic/build.json'), buildFixture('synthetic'));
  await mkdir(pilot); const oldRoot = join(root, 'original'); await mkdir(oldRoot);
  const old = freezeBatchPlan({ protocol: protocol('original-pilot', { authRoutes }), execution: { environment_root: root, control_root: oldRoot,
    pilot_ledger_root: pilot, instrumentation } });
  const planFile = join(oldRoot, 'plan.json'); await save(planFile, old);
  const rows = [];
  for (let i = 0; i < 3; i++) {
    const runId = 'original-' + (i + 1), slot = old.slots[i];
    await save(join(pilot, String(i + 1).padStart(3, '0') + '.json'), { run_id: runId, experiment_id: old.id, slot_id: slot.slot_id });
    const result = await resultFor(old, slot, runId, { attempts: i === 0 ? [] : i === 1 ? [10, 20, 30, 40] : [null], valid: i === 1, stop: i !== 1 });
    rows.push({ seq: rows.length + 1, type: 'episode_started', run_id: runId, slot_id: slot.slot_id });
    rows.push({ seq: rows.length + 1, type: 'episode_completed', run_id: runId, slot_id: slot.slot_id, result });
  }
  await writeFile(join(oldRoot, 'ledger.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const control = join(root, 'gate'); await mkdir(control);
  const input = { id: 'two-model-scope', role: 'gate', authorization: 'Synthetic test authorization only',
    history_plan_files: [planFile], acknowledged_unknown_run_ids: ['original-3'], gate_episodes: 16, minimum_valid_real_per_condition: 4 };
  const p = protocol('prospective-gate', { scope: pilotScopePolicy(input), authRoutes });
  const execution = { environment_root: root, control_root: control, pilot_ledger_root: pilot, instrumentation };
  execution.pilot_scope = await preparePilotScope({ setup: { pilot_scope: input }, protocol: p, execution, slots: scheduleProtocol(p) });
  const plan = freezeBatchPlan({ protocol: p, execution }); await save(join(control, 'plan.json'), plan);
  return { root, pilot, old, plan, input, authRoutes };
}

async function expansion(f, { gate, id = 'expansion', repetitions = 1 } = {}) {
  const control = join(f.root, id); await mkdir(control);
  const input = { id: f.input.id, role: 'expansion', amendment: f.plan.execution.pilot_scope.amendment };
  const p = protocol(id, { scope: pilotScopePolicy(input), repetitions, prefix: 'new-' });
  const execution = { environment_root: f.root, control_root: control, pilot_ledger_root: f.pilot, instrumentation, ...(gate ? { route_gate: gate } : {}) };
  execution.pilot_scope = await preparePilotScope({ setup: { pilot_scope: input }, protocol: p, execution, slots: scheduleProtocol(p) });
  const plan = freezeBatchPlan({ protocol: p, execution }); await save(join(control, 'plan.json'), plan); return plan;
}

function transportFixture(modelSend = false, authRejection = false) {
  let previous = null;
  const phases = [{ phase: 'transport_start' }, ...(modelSend ? [
    { phase: 'request_start', category: 'model', id: 1 }, { phase: 'request_end', category: 'model', id: 1, outcome: 'completed',
      ...(authRejection ? { status: 200, requestSent: true, modelApi: 'openai-completions', contentType: 'text/event-stream',
        responseEntityBytes: 100, responseEntitySha256: sha('synthetic auth error SSE') } : {}) }] : []),
    { phase: 'transport_end', attempts: modelSend ? 1 : 0, errors: 0, incompleteRequestIds: [], complete: true }];
  return phases.map((phase, index) => {
    const body = { version: 1, sequence: index + 1, previousSha256: previous, clockId: 'synthetic', monotonicNs: String(index), ...phase };
    previous = sha(JSON.stringify(body)); return JSON.stringify({ ...body, eventSha256: previous });
  }).join('\n') + '\n';
}

async function artifact(root, id, value, kind = 'json') {
  const path = join(root, id + (kind === 'jsonl' ? '.jsonl' : '.json'));
  const text = kind === 'jsonl' ? value : JSON.stringify(value) + '\n'; await writeFile(path, text);
  return { id, path, sha256: sha(text), bytes: Buffer.byteLength(text), kind };
}

async function rejectedBeforeSend(plan, slot, runId, { modelSend = false } = {}) {
  const result = await resultFor(plan, slot, runId, { attempts: [], valid: false, stop: true });
  const root = join(plan.execution.environment_root, 'runs', runId), runtimeRoot = join(root, 'benchmark/runtime');
  await mkdir(runtimeRoot, { recursive: true });
  const condition = plan.protocol.conditions.find(item => item.id === slot.condition_id);
  const environment = plan.protocol.environments.find(item => item.id === condition.environment_id);
  const artifacts = await Promise.all([
    artifact(runtimeRoot, 'admission-comparison', { differences: [] }),
    artifact(runtimeRoot, 'first-request-catalog-comparison', { differences: [] }),
    artifact(runtimeRoot, 'first-request-contract-comparison', { differences: [{ path: '/messages', expected: 'sr:C:old', actual: 'sr:C:new' }] }),
    artifact(runtimeRoot, 'transport', transportFixture(modelSend), 'jsonl')]);
  await save(join(runtimeRoot, 'episode-result.json'), { status: 'admission_rejected',
    correlation: { run_id: runId, episode_id: runId, candidate_id: slot.condition_id, task_id: slot.case_id },
    error: { code: 'BENCHMARK_FINAL_REQUEST_CONTRACT_DRIFT' }, requests: [{ attempts: [], accounted: true, usage: null }],
    turns: [{ final_text: null }], budget: { attempts: 0, tools: 0, input_tokens: 0, output_tokens: 0, tokens: 0, usage_unknown: false }, artifacts });
  await save(join(root, 'result.json'), { status: 'failed', run_id: runId, build_id: environment.build.id,
    runtime_check: { status: 'unchanged' }, frozen_artifacts: 'passed' });
  return { ...result, status: 'admission_rejected', run_root: root };
}

async function repairInput(f, { changeBudget = false, changeProduct = false } = {}) {
  const id = 'repaired-scope-gate', control = join(f.root, 'repaired-gate'), buildId = 'synthetic-repair';
  await mkdir(control); await mkdir(join(f.root, 'builds', buildId), { recursive: true });
  const build = buildFixture(buildId); if (changeProduct) build.packages.broker.files[0].sha256 = 'f'.repeat(64);
  await save(join(f.root, 'builds', buildId, 'build.json'), build);
  const p = structuredClone(f.plan.protocol); p.id = id; p.policies.pilot.scope.id = 'repaired-scope';
  for (const environment of p.environments) {
    environment.build.id = buildId; environment.build.receipt_sha256 = sha(await readFile(join(f.root, 'builds', buildId, 'build.json')));
    environment.build.broker.source_sha256 = fingerprint({ repaired_apparatus: true });
    environment.manifest_sha256 = fingerprint({ ...environment, manifest_sha256: null });
  }
  p.conditions.forEach(condition => { condition.environment_sha256 = p.environments.find(item => item.id === condition.environment_id).manifest_sha256; });
  if (changeBudget) p.policies.budgets[0].episode.max_model_requests++;
  p.protocol_sha256 = fingerprint({ ...p, protocol_sha256: null });
  const input = { id: 'repaired-scope', role: 'gate', authorization: 'Synthetic authorized final-request zero-send repair',
    predecessor: { amendment: f.plan.execution.pilot_scope.amendment,
      plan: { path: join(f.plan.execution.control_root, 'plan.json'), sha256: sha(await readFile(join(f.plan.execution.control_root, 'plan.json'))) } },
    zero_send_repair: { run_id: f.plan.id + '-001', reason: 'Synthetic catalog reference serialization repair' },
    acknowledged_unknown_run_ids: ['original-3'], gate_episodes: 16, minimum_valid_real_per_condition: 4 };
  const captures = [];
  for (const model of p.models) for (const environment of p.environments) {
    const captureId = 'capture-' + captures.length, root = join(control, captureId); await mkdir(root);
    const projection = { mode: environment.pi.mode, model: { id: model.id.split('/').at(-1) }, build: { sha256: environment.build.receipt_sha256 } };
    const expectationPath = join(root, 'expectation.json'); await save(expectationPath, { projection });
    const runtimePath = join(root, 'episode-result.json');
    await save(runtimePath, { status: 'captured', correlation: { run_id: captureId }, requests: [{ attempts: [], usage: null }], turns: [], budget: { requests: 0, attempts: 0, tools: 0 },
      artifacts: [await artifact(root, 'candidate-observed', { projection }), await artifact(root, 'transport', transportFixture(), 'jsonl')] });
    await save(join(root, 'result.json'), { status: 'passed', run_id: captureId, build_id: buildId, runtime_check: { status: 'unchanged' }, frozen_artifacts: 'passed' });
    captures.push({ model, candidate: { mode: environment.pi.mode }, raw: { run_id: captureId, root, result_path: runtimePath },
      expectation: { path: expectationPath, sha256: sha(await readFile(expectationPath)) } });
  }
  const execution = { environment_root: f.root, control_root: control, pilot_ledger_root: f.pilot, instrumentation };
  if (f.authRoutes) {
    execution.models_file = join(control, 'models.json'); await save(execution.models_file, authRegistry());
    execution.models_sha256 = sha(await readFile(execution.models_file));
  }
  return { setup: { pilot_scope: input }, protocol: p, execution, slots: scheduleProtocol(p), captures };
}

function authRegistry(replaced = false, replacementRoute = authToRoute) {
  return { providers: { [authProvider]: { baseUrl: 'http://127.0.0.1:3425/v1', api: 'openai-completions', models: [
    { id: replaced ? replacementRoute : authFromRoute,
      name: replaced ? 'Synthetic replacement Sol' : 'Synthetic original Sol', api: 'openai-completions', reasoning: true,
      input: ['text', 'image'], contextWindow: replaced ? 922000 : 1050000, maxTokens: 128000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { id: authOtherRoute, name: 'Synthetic Grok', api: 'openai-responses', reasoning: true,
      input: ['text', 'image'], contextWindow: 256000, maxTokens: 256000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  ] } } };
}

async function rejectedByExpiredAuth(plan, slot, runId, { fakeAuth = false } = {}) {
  const result = await resultFor(plan, slot, runId, { attempts: [null], valid: false, stop: true, unknownOutput: true });
  const root = join(plan.execution.environment_root, 'runs', runId), runtimeRoot = join(root, 'benchmark/runtime');
  await mkdir(runtimeRoot, { recursive: true });
  const condition = plan.protocol.conditions.find(item => item.id === slot.condition_id);
  const environment = plan.protocol.environments.find(item => item.id === condition.environment_id);
  const error = 'Command Code Plan: Your API key has expired. Synthetic retained provider error. (HTTP 401)';
  const events = [
    { type: 'session_event', run_id: runId, candidate_id: slot.condition_id, task_id: slot.case_id, request_id: 'request-1',
      data: { type: 'message_end', message: { model: authFromRoute, api: 'openai-completions',
        stopReason: 'error', content: [], errorMessage: fakeAuth ? 'Synthetic non-authentication provider failure' : error } } },
    { type: 'request_usage_accounted', request_id: 'request-1', data: { raw_usage_observed: false, guarded_fetch_attempts: 1, budget: { usage_unknown: true } } },
  ];
  const artifacts = await Promise.all([
    artifact(runtimeRoot, 'admission-comparison', { differences: [] }),
    artifact(runtimeRoot, 'first-request-catalog-comparison', { differences: [] }),
    artifact(runtimeRoot, 'first-request-contract-comparison', { differences: [] }),
    artifact(runtimeRoot, 'transport', transportFixture(true, true), 'jsonl'),
    artifact(runtimeRoot, 'events', events.map(event => JSON.stringify(event)).join('\n') + '\n', 'jsonl'),
  ]);
  await save(join(runtimeRoot, 'episode-result.json'), { status: 'invalid',
    correlation: { run_id: runId, episode_id: runId, candidate_id: slot.condition_id, task_id: slot.case_id },
    error: { code: 'BENCHMARK_USAGE_UNKNOWN' }, requests: [{ id: 'request-1', usage: null,
      attempts: [{ sent: true, status: 200, transport_id: 1 }], assistant: { stop_reason: 'error', error } }],
    turns: [{ final_text: null }], budget: { requests: 1, attempts: 1, tools: 0, usage_unknown: true }, artifacts });
  await save(join(root, 'result.json'), { status: 'failed', run_id: runId, build_id: environment.build.id,
    runtime_check: { status: 'unchanged' }, frozen_artifacts: 'passed' });
  return { ...result, run_root: root };
}

async function authFixture(options = {}) {
  const f = await fixture({ authRoutes: true });
  await runBatch({ plan: f.plan, maximumNewEpisodes: 1, executeEpisode: ({ plan, slot, runId }) => rejectedBeforeSend(plan, slot, runId) });
  const repair = await repairInput(f); repair.execution.pilot_scope = await preparePilotScope(repair);
  const plan = freezeBatchPlan(repair); await save(join(repair.execution.control_root, 'plan.json'), plan);
  await runBatch({ plan, maximumNewEpisodes: 1, executeEpisode: ({ plan, slot, runId }) => rejectedByExpiredAuth(plan, slot, runId, options) });
  return { ...f, prior: plan };
}

async function manualRouteInput(f, { replacementRoute = authToRoute } = {}) {
  const p = structuredClone(f.prior.protocol), control = join(f.root, 'manual-route-gate'); await mkdir(control);
  p.id = 'manual-route-gate'; p.policies.pilot.scope.id = 'manual-route-scope';
  const oldId = p.models[0].id, model = p.models[0];
  Object.assign(model, { id: authProvider + '/' + replacementRoute, route: replacementRoute, family: replacementRoute });
  p.conditions.forEach(condition => { if (condition.model_id === oldId) condition.model_id = model.id; });
  p.protocol_sha256 = fingerprint({ ...p, protocol_sha256: null });
  const input = { id: 'manual-route-scope', role: 'gate', authorization: 'Synthetic authorized one-time same-variant manual route replacement',
    predecessor: { amendment: f.prior.execution.pilot_scope.amendment,
      plan: { path: join(f.prior.execution.control_root, 'plan.json'), sha256: sha(await readFile(join(f.prior.execution.control_root, 'plan.json'))) } },
    manual_route_replacement: { run_id: f.prior.id + '-001', from_model_id: oldId, to_model_id: model.id, variant: 'gpt-6.2-sol',
      reason: 'Synthetic retained expired-key failure', administrative_hold: 'full_prior_episode_allocation_not_actual_upper_bound' },
    acknowledged_unknown_run_ids: ['original-3', f.prior.id + '-001'], gate_episodes: 16, minimum_valid_real_per_condition: 4 };
  const registry = authRegistry(true, replacementRoute), modelsFile = join(control, 'models.json'); await save(modelsFile, registry);
  const execution = { ...f.prior.execution, control_root: control, models_file: modelsFile, models_sha256: sha(await readFile(modelsFile)) };
  delete execution.pilot_scope;
  const captures = [];
  for (const model of p.models) for (const environment of p.environments) {
    const captureId = 'manual-capture-' + captures.length, root = join(control, captureId); await mkdir(root);
    const provider = registry.providers[model.provider], selected = provider.models.find(item => item.id === model.route);
    const projection = { mode: environment.pi.mode, model: { ...selected, provider: model.provider, baseUrl: provider.baseUrl },
      build: { sha256: environment.build.receipt_sha256 } };
    const expectationPath = join(root, 'expectation.json'); await save(expectationPath, { projection });
    const runtimePath = join(root, 'episode-result.json');
    await save(runtimePath, { status: 'captured', correlation: { run_id: captureId }, requests: [{ attempts: [], usage: null }], turns: [],
      budget: { requests: 0, attempts: 0, tools: 0 }, artifacts: [await artifact(root, 'candidate-observed', { projection }),
        await artifact(root, 'transport', transportFixture(), 'jsonl')] });
    await save(join(root, 'result.json'), { status: 'passed', run_id: captureId, build_id: environment.build.id,
      runtime_check: { status: 'unchanged' }, frozen_artifacts: 'passed' });
    captures.push({ model, candidate: { mode: environment.pi.mode }, raw: { run_id: captureId, root, result_path: runtimePath },
      expectation: { path: expectationPath, sha256: sha(await readFile(expectationPath)) } });
  }
  return { setup: { pilot_scope: input }, protocol: p, execution, slots: scheduleProtocol(p), captures };
}

test('one manual auth-route amendment retains all five reservations and two unknowns, then certifies sixteen fresh observations', async () => {
  const f = await authFixture(), args = await manualRouteInput(f);
  const retainedFiles = ['001.json', '002.json', '003.json', '004.json', '005.json', 'scope-registration.json', 'scope-registration-002.json'];
  const before = await Promise.all(retainedFiles.map(name => readFile(join(f.pilot, name))));
  const priorLedger = await readFile(join(f.prior.execution.control_root, 'ledger.jsonl'));
  args.execution.pilot_scope = await preparePilotScope(args);
  const plan = freezeBatchPlan(args); await save(join(args.execution.control_root, 'plan.json'), plan);
  const amendment = await readPilotScopeAmendment(plan.execution.pilot_scope.amendment);
  assert.equal(amendment.version, 3); assert.equal(amendment.history.scheduled_episodes, 5);
  assert.equal(amendment.history.known_subtotal.model_requests, 6); assert.equal(amendment.history.total_usage_status, 'incomplete');
  assert.deepEqual(amendment.history.unknown_usage_run_ids, ['original-3', f.prior.id + '-001']);
  assert.equal(amendment.history.episodes.at(-1).admission, 'invalid'); assert.equal(amendment.history.episodes.at(-1).stop_batch, true);
  assert.equal(amendment.history.episodes.at(-1).authentication_observation.outer_http_status, 200);
  assert.equal(amendment.history.episodes.at(-1).authentication_observation.reported_auth_status, 401);
  const hold = amendment.history.administrative_holds[0];
  assert.equal(hold.actual_usage, 'unknown'); assert.equal(hold.proven_actual_upper_bound, false);
  assert.deepEqual(hold.allocation, f.prior.protocol.policies.budgets[0].episode);
  const status = await runBatch({ plan, executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId) });
  assert.equal(status.completed, 16);
  const gate = await writeRouteGate({ plan, status, outputFile: join(f.root, 'manual-route-gate.json') });
  assert.equal((await verifyGateReference({ reference: gate.reference, environmentRoot: f.root })).episode_evidence.length, 16);
  assert.equal((await readdir(f.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 21);
  assert.equal(JSON.parse(await readFile(join(f.pilot, 'scope-registration-003.json'))).kind, 'benchmark-manual-auth-route-succession');
  for (const [i, name] of retainedFiles.entries()) assert.deepEqual(await readFile(join(f.pilot, name)), before[i]);
  assert.deepEqual(await readFile(join(f.prior.execution.control_root, 'ledger.jsonl')), priorLedger);
  await assert.rejects(runBatch({ plan: f.prior, executeEpisode: async () => assert.fail('Predecessor remains stopped') }), /OTHER_ACTIVE_AMENDMENT/);
  const repeated = structuredClone(args); repeated.setup.pilot_scope.predecessor = {
    amendment: plan.execution.pilot_scope.amendment, plan: { path: join(plan.execution.control_root, 'plan.json'), sha256: sha(await readFile(join(plan.execution.control_root, 'plan.json'))) } };
  await assert.rejects(preparePilotScope(repeated), /Only one manual route amendment/);
});

test('manual auth-route amendment requires exact declared identities and rejects model, budget, build or context changes', async () => {
  const f = await authFixture(), args = await manualRouteInput(f);
  for (const mutate of [
    value => { value.setup.pilot_scope.manual_route_replacement.variant = 'gpt-6.2-astra'; },
    value => { delete value.setup.pilot_scope.manual_route_replacement.from_model_id; },
    value => { value.setup.pilot_scope.manual_route_replacement.from_model_id = authProvider + '/synthetic-foreign/gpt-6.2-sol'; },
    value => { value.setup.pilot_scope.manual_route_replacement.to_model_id = authProvider + '/synthetic-undeclared/gpt-6.2-sol'; },
    value => { value.setup.pilot_scope.manual_route_replacement.to_model_id = authFromId; },
    value => { value.protocol.models[0].route = 'synthetic-unregistered/gpt-6.2-sol'; },
    value => { value.protocol.models[0].provider = 'another-provider'; },
    value => { value.protocol.models[0].family = 'synthetic-replacement/gpt-6.2-astra'; },
    value => { value.protocol.models[0].api = 'openai-responses'; },
    value => {
      const model = value.protocol.models[0], route = 'synthetic-replacement/gpt-6.2-astra';
      Object.assign(model, { id: authProvider + '/' + route, route, family: route });
      value.setup.pilot_scope.manual_route_replacement.to_model_id = model.id;
      value.protocol.conditions.forEach(condition => { if (condition.model_id === authToId) condition.model_id = model.id; });
    },
    value => {
      const model = value.protocol.models[0]; Object.assign(model, { id: 'another-provider/' + authToRoute, provider: 'another-provider' });
      value.setup.pilot_scope.manual_route_replacement.to_model_id = model.id;
      value.protocol.conditions.forEach(condition => { if (condition.model_id === authToId) condition.model_id = model.id; });
    },
    value => { value.protocol.policies.budgets[0].episode.max_model_requests++; },
    value => { value.protocol.environments[0].build.id = 'different-build'; },
  ]) {
    const bad = structuredClone(args); mutate(bad);
    await assert.rejects(preparePilotScope(bad));
  }
  const registry = authRegistry(true); registry.providers[authProvider].models[0].contextWindow = 1050000;
  await save(args.execution.models_file, registry); args.execution.models_sha256 = sha(await readFile(args.execution.models_file));
  await assert.rejects(preparePilotScope(args));
  assert.equal((await readdir(f.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 5);
  await assert.rejects(readFile(join(f.pilot, 'scope-registration-003.json')), { code: 'ENOENT' });
});

test('manual auth-route amendment rejects automatic route groups even when every declared identity and capture agrees', async () => {
  for (const prefix of ['auto', 'group']) {
    const f = await authFixture(), args = await manualRouteInput(f, { replacementRoute: prefix + '/gpt-6.2-sol' });
    const change = args.setup.pilot_scope.manual_route_replacement, model = args.protocol.models[0];
    assert.equal(change.to_model_id, model.id); assert.equal(model.id, model.provider + '/' + model.route);
    const registry = JSON.parse(await readFile(args.execution.models_file, 'utf8'));
    const selected = registry.providers[model.provider].models.find(item => item.id === model.route); assert.ok(selected);
    for (const capture of args.captures.filter(item => item.model.id === model.id)) {
      const expectation = JSON.parse(await readFile(capture.expectation.path, 'utf8'));
      assert.equal(expectation.projection.model.id, selected.id);
    }
    await assert.rejects(preparePilotScope(args), /PILOT_SCOPE_AUTOMATIC_ROUTE_FORBIDDEN/);
    assert.equal((await readdir(f.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 5);
    await assert.rejects(readFile(join(f.pilot, 'scope-registration-003.json')), { code: 'ENOENT' });
  }
});

test('manual auth-route exception requires retained authentication evidence and cannot absorb an extra unknown reservation', async () => {
  const fake = await authFixture({ fakeAuth: true }), fakeArgs = await manualRouteInput(fake);
  await assert.rejects(preparePilotScope(fakeArgs), /Command Code Plan/);
  const f = await authFixture(), args = await manualRouteInput(f);
  await save(join(f.pilot, '006.json'), { run_id: 'extra-unknown', experiment_id: f.prior.id, slot_id: f.prior.slots[1].slot_id });
  await assert.rejects(preparePilotScope(args), /cannot absorb another new reservation/);
  const rows = (await readFile(join(f.prior.execution.control_root, 'ledger.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const result = rows.find(row => row.type === 'episode_completed').result;
  const read = async path => JSON.parse(await readFile(path, 'utf8'));
  const proof = { episode: await read(join(result.normalized_directory, 'episode.json')),
    runtime: await read(join(result.run_root, 'benchmark/runtime/episode-result.json')), shared: await read(join(result.run_root, 'result.json')),
    environmentRoot: f.root };
  proof.model = f.prior.protocol.models.find(model => model.id === proof.episode.identity.model_id);
  await assertManualAuthRejection(proof);
  await assert.rejects(assertManualAuthRejection({ ...proof, model: undefined }), /ROUTE_MODEL_REQUIRED/);
  await assert.rejects(assertManualAuthRejection({ ...proof, model: { ...proof.model, id: authToId, route: authToRoute, family: authToRoute } }));
  await assert.rejects(assertZeroSendInvalid({ ...proof, rejection: 'final_request_contract' }));
  const changed = proof.runtime.artifacts.find(item => item.id === 'first-request-contract-comparison');
  Object.assign(changed, await artifact(join(result.run_root, 'benchmark/runtime'), changed.id, { differences: [{ path: '/model' }] }));
  await assert.rejects(assertManualAuthRejection(proof));
});

test('the manual scope keeps new unknown usage blocking and rejects an unregistered new registry', async () => {
  const f = await authFixture(), args = await manualRouteInput(f);
  args.execution.pilot_scope = await preparePilotScope(args);
  const plan = freezeBatchPlan(args); await save(join(args.execution.control_root, 'plan.json'), plan);
  const bad = structuredClone(plan); bad.execution.models_sha256 = 'f'.repeat(64);
  await assert.rejects(verifyPilotScope(bad), /ROUTE_REGISTRY_CHANGED/);
  await runBatch({ plan, maximumNewEpisodes: 1, executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId, { attempts: [null] }) });
  await assert.rejects(verifyPilotScope(plan), /UNKNOWN_NEW_USAGE/);
  assert.equal((await readdir(f.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 6);
});

test('a named final-request zero-send rejection creates an append-only successor, retains four reservations and starts a fresh sixteen-observation gate', async () => {
  const f = await fixture();
  await runBatch({ plan: f.plan, maximumNewEpisodes: 1, executeEpisode: ({ plan, slot, runId }) => rejectedBeforeSend(plan, slot, runId) });
  const original = await readFile(join(f.pilot, 'scope-registration.json')), priorLedger = await readFile(join(f.plan.execution.control_root, 'ledger.jsonl'));
  const args = await repairInput(f); args.execution.pilot_scope = await preparePilotScope(args);
  const plan = freezeBatchPlan(args); await save(join(args.execution.control_root, 'plan.json'), plan);
  const amendment = await readPilotScopeAmendment(plan.execution.pilot_scope.amendment);
  assert.equal(amendment.version, 2); assert.equal(amendment.history.scheduled_episodes, 4);
  assert.equal(amendment.history.known_subtotal.model_requests, 5); assert.deepEqual(amendment.history.unknown_usage_run_ids, ['original-3']);
  assert.equal(amendment.history.episodes.at(-1).admission, 'invalid'); assert.equal(amendment.history.episodes.at(-1).stop_batch, true);
  const status = await runBatch({ plan, executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId) });
  assert.equal(status.completed, 16);
  const gate = await writeRouteGate({ plan, status, outputFile: join(f.root, 'repaired-gate.json') });
  assert.equal((await verifyGateReference({ reference: gate.reference, environmentRoot: f.root })).episode_evidence.length, 16);
  assert.equal((await readdir(f.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 20);
  assert.deepEqual(await readFile(join(f.pilot, 'scope-registration.json')), original);
  assert.deepEqual(await readFile(join(f.plan.execution.control_root, 'ledger.jsonl')), priorLedger);
  assert.equal(JSON.parse(await readFile(join(f.pilot, 'scope-registration-002.json'))).sequence, 2);
  await assert.rejects(runBatch({ plan: f.plan, executeEpisode: async () => assert.fail('Old stopped scope must stay stopped') }), /OTHER_ACTIVE_AMENDMENT/);
});

test('zero-send successor rejects a model transport attempt, altered budget and changed product bytes', async () => {
  for (const variant of ['model-send', 'budget', 'product']) {
    const f = await fixture();
    await runBatch({ plan: f.plan, maximumNewEpisodes: 1, executeEpisode: ({ plan, slot, runId }) => rejectedBeforeSend(plan, slot, runId, { modelSend: variant === 'model-send' }) });
    const args = await repairInput(f, { changeBudget: variant === 'budget', changeProduct: variant === 'product' });
    await assert.rejects(preparePilotScope(args), variant === 'model-send' ? /model HTTP attempt/ : variant === 'budget' ? /TASK_OR_MODEL_CHANGED/ : /PRODUCT_BYTES_CHANGED/);
    assert.equal((await readdir(f.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 4);
    await assert.rejects(readFile(join(f.pilot, 'scope-registration-002.json')), { code: 'ENOENT' });
  }
});

test('final-request zero-send mode cannot relax the existing startup-rejection contract', async () => {
  const f = await fixture(), slot = f.plan.slots[0], runId = f.plan.id + '-001';
  const result = await rejectedBeforeSend(f.plan, slot, runId), read = async path => JSON.parse(await readFile(path, 'utf8'));
  const input = { episode: await read(join(result.normalized_directory, 'episode.json')),
    runtime: await read(join(result.run_root, 'benchmark/runtime/episode-result.json')), shared: await read(join(result.run_root, 'result.json')),
    environmentRoot: f.root };
  await assert.rejects(assertZeroSendInvalid(input), /BENCHMARK_ADMISSION_MISMATCH/);
  await assertZeroSendInvalid({ ...input, rejection: 'final_request_contract' });
  input.runtime.budget.usage_unknown = true;
  await assert.rejects(assertZeroSendInvalid({ ...input, rejection: 'final_request_contract' }));
});

test('prospective scope preserves five historical sends and unknown costs, and signs sixteen accounted observations without quality cherry-picking', async () => {
  const f = await fixture(), before = await readFile(join(f.pilot, '003.json'));
  const amendment = await readPilotScopeAmendment(f.plan.execution.pilot_scope.amendment);
  assert.equal(amendment.history.scheduled_episodes, 3); assert.equal(amendment.history.known_subtotal.model_requests, 5);
  assert.equal(amendment.history.total_usage_status, 'incomplete'); assert.deepEqual(amendment.history.unknown_usage_run_ids, ['original-3']);
  let calls = 0;
  const status = await runBatch({ plan: f.plan, executeEpisode: async ({ plan, slot, runId }) => { calls++; return resultFor(plan, slot, runId); } });
  assert.equal(calls, 16); assert.equal(status.completed, 16);
  const receipt = await writeRouteGate({ plan: f.plan, status, outputFile: join(f.root, 'gate.json') });
  const gate = await verifyGateReference({ reference: receipt.reference, environmentRoot: f.root });
  assert.equal(gate.version, 3); assert.equal(gate.scheduled_episodes, 16); assert.equal(gate.history_accounting.total_usage_status, 'incomplete');
  assert.equal((await readdir(f.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 19);
  assert.deepEqual(await readFile(join(f.pilot, '003.json')), before);
  const next = await expansion(f, { gate: receipt.reference });
  await runBatch({ plan: next, maximumNewEpisodes: 1, executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId) });
  assert.equal((await batchStatus(next.execution.control_root)).completed, 1);
});

test('historical byte changes and a foreign ledger are rejected before dispatch', async () => {
  const f = await fixture(); let calls = 0;
  const foreign = structuredClone(f.plan); foreign.execution.pilot_ledger_root = join(f.root, 'alternate');
  foreign.plan_sha256 = fingerprint({ ...foreign, plan_sha256: null });
  await assert.rejects(runBatch({ plan: foreign, executeEpisode: async () => { calls++; } }), /FOREIGN_LEDGER/);
  await writeFile(join(f.pilot, '001.json'), (await readFile(join(f.pilot, '001.json'), 'utf8')) + ' ');
  await assert.rejects(runBatch({ plan: f.plan, executeEpisode: async () => { calls++; } }), /HISTORY_CHANGED/);
  assert.equal(calls, 0);
});

test('no gate means no expansion even below old ordinal 25; new unknown cannot be hidden by another control root', async () => {
  const f = await fixture(), next = await expansion(f); let calls = 0;
  await assert.rejects(runBatch({ plan: next, executeEpisode: async () => { calls++; } }), /GATE_REQUIRED/);
  const status = await runBatch({ plan: f.plan, maximumNewEpisodes: 1,
    executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId, { attempts: [null] }) });
  assert.equal(status.completed, 1);
  await assert.rejects(runBatch({ plan: next, executeEpisode: async () => { calls++; } }), /UNKNOWN_NEW_USAGE/);
  await assert.rejects(runBatch({ plan: f.plan, executeEpisode: async () => { calls++; } }), /UNKNOWN_NEW_USAGE/);
  const legacy = structuredClone(next); delete legacy.execution.pilot_scope; delete legacy.protocol.policies.pilot.scope;
  legacy.protocol.protocol_sha256 = fingerprint({ ...legacy.protocol, protocol_sha256: null }); legacy.plan_sha256 = fingerprint({ ...legacy, plan_sha256: null });
  await assert.rejects(runBatch({ plan: legacy, executeEpisode: async () => { calls++; } }), /REQUIRED_FOR_ACTIVE_CAMPAIGN/);
  const path = join(f.plan.execution.control_root, 'ledger.jsonl');
  const rows = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
  const summary = rows.find(row => row.type === 'episode_completed').result;
  summary.budget_usage.input_tokens = 50; summary.stop_batch = false;
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await assert.rejects(runBatch({ plan: next, executeEpisode: async () => { calls++; } }), /UNKNOWN_NEW_USAGE/);
  assert.equal(calls, 0);
});

test('new core stop, orphan reservation and altered route or scope policy remain blocking', async () => {
  const f = await fixture();
  await runBatch({ plan: f.plan, maximumNewEpisodes: 1,
    executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId, { stop: true }) });
  await assert.rejects(verifyPilotScope(f.plan), /RETAINED_CORE_STOP/);
  const another = await fixture(), record = { run_id: 'orphan', experiment_id: another.plan.id, slot_id: another.plan.slots[0].slot_id,
    scope_id: another.input.id, scope_amendment_sha256: (await readPilotScopeAmendment(another.plan.execution.pilot_scope.amendment)).amendment_sha256,
    plan: { path: join(another.plan.execution.control_root, 'plan.json'), sha256: sha(await readFile(join(another.plan.execution.control_root, 'plan.json'))) },
    plan_sha256: another.plan.plan_sha256 };
  await save(join(another.pilot, '004.json'), record);
  await assert.rejects(verifyPilotScope(another.plan), /ORPHAN_RESERVATION/);
  const bad = structuredClone(f.plan.protocol); bad.policies.pilot.scope.gate_episodes = 24;
  bad.protocol_sha256 = fingerprint({ ...bad, protocol_sha256: null }); assert.equal(validateProtocol(bad, { stage: 'execute' }).valid, false);
  const changed = structuredClone(f.plan); changed.protocol.models[0].route += '-changed';
  await assert.rejects(verifyPilotScope(changed), /MODEL_CHANGED/);
});

test('scope revisions reject a bare replacement, another plan and tampered registration without clearing the original stop', async () => {
  const f = await fixture();
  await runBatch({ plan: f.plan, maximumNewEpisodes: 1,
    executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId, { stop: true }) });
  const path = join(f.plan.execution.control_root, 'ledger.jsonl'), original = await readFile(path), next = await expansion(f);
  const rows = original.toString('utf8').trim().split('\n').map(JSON.parse), completed = rows.find(row => row.type === 'episode_completed');
  await assert.rejects(verifyPilotScope(f.plan, { analysisRevision: { replacements: [{ run_id: completed.run_id, stop_batch: false }] } }),
    /VERIFIED_REVISION_REQUIRED/);
  const priorPlan = join(f.plan.execution.control_root, 'plan.json');
  const claimed = { version: 1, kind: 'benchmark-analysis-revision',
    plan: { path: priorPlan, sha256: sha(await readFile(priorPlan)), plan_sha256: f.plan.plan_sha256 }, replacements: [], revision_sha256: null };
  claimed.revision_sha256 = fingerprint(claimed);
  const claimPath = join(f.plan.execution.control_root, 'unverified-revision.json'); await save(claimPath, claimed);
  const reference = { path: claimPath, sha256: sha(await readFile(claimPath)) };
  await assert.rejects(readScopeCompletedResults(next, { analysisRevisionReference: reference, analysisRevision: claimed }), /ANALYSIS_REVISION_OTHER_PLAN/);
  await writeFile(claimPath, (await readFile(claimPath, 'utf8')) + ' ');
  await assert.rejects(verifyPilotScope(f.plan, { analysisRevisionReference: reference, analysisRevision: claimed }), /ANALYSIS_REVISION_REFERENCE_CHANGED/);
  assert.deepEqual(await readFile(path), original);
  rows.push({ seq: rows.length + 1, type: 'analysis_revision_applied', reference, model_execution: false });
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await assert.rejects(verifyPilotScope(next), /ANALYSIS_REVISION_REFERENCE_CHANGED/);
  assert.equal(rows.find(row => row.type === 'episode_completed').result.stop_batch, true);
  assert.equal((await readdir(f.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 4);
});

test('scope gate refuses analysis provenance that was never registered for its completed observations', async () => {
  const f = await fixture();
  const status = await runBatch({ plan: f.plan, executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId) });
  const receipt = await writeRouteGate({ plan: f.plan, status, outputFile: join(f.root, 'registered-gate.json') });
  const forged = JSON.parse(await readFile(receipt.reference.path));
  forged.episode_evidence[0].analysis_revision = { path: join(f.root, 'unregistered-revision.json'), sha256: 'f'.repeat(64) };
  forged.episode_evidence[0].original_episode_sha256 = forged.episode_evidence[0].episode_sha256;
  forged.episode_evidence[0].original_directory = forged.episode_evidence[0].directory;
  const path = join(f.root, 'forged-revision-gate.json'); await save(path, forged);
  await assert.rejects(verifyGateReference({ reference: { path, sha256: sha(await readFile(path)) }, environmentRoot: f.root }));
  assert.equal((await verifyGateReference({ reference: receipt.reference, environmentRoot: f.root })).episode_evidence.length, 16);
});

test('gate proof survives an expansion interruption and permits same-plan evidence reconciliation with zero new sends', async () => {
  const f = await fixture();
  const status = await runBatch({ plan: f.plan, executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId) });
  const receipt = await writeRouteGate({ plan: f.plan, status, outputFile: join(f.root, 'gate.json') });
  const next = await expansion(f, { gate: receipt.reference }); let retained, calls = 0;
  await runBatch({ plan: next, maximumNewEpisodes: 1, executeEpisode: async ({ plan, slot, runId }) => {
    calls++; retained = await resultFor(plan, slot, runId); throw new Error('synthetic missing acknowledgement');
  } });
  assert.equal((await verifyGateReference({ reference: receipt.reference, environmentRoot: f.root })).version, 3);
  const reconciled = await runBatch({ plan: next, maximumNewEpisodes: 0, reconcileEpisode: async () => retained,
    executeEpisode: async () => { calls++; throw new Error('must not redispatch'); } });
  assert.equal(calls, 1); assert.equal(reconciled.unresolved_runs.length, 0); assert.equal(reconciled.completed, 1);
});

test('the shared 144 cap includes original reservations, prospective gate and bounded expansion', async () => {
  const f = await fixture();
  const status = await runBatch({ plan: f.plan, executeEpisode: ({ plan, slot, runId }) => resultFor(plan, slot, runId) });
  const receipt = await writeRouteGate({ plan: f.plan, status, outputFile: join(f.root, 'gate.json') });
  const next = await expansion(f, { gate: receipt.reference, repetitions: 8 }); let calls = 0;
  const completed = await runBatch({ plan: next, executeEpisode: ({ plan, slot, runId }) => { calls++; return resultFor(plan, slot, runId); } });
  assert.equal(calls, 125); assert.equal(completed.last.reason, 'pilot_cap');
  assert.equal((await readdir(f.pilot)).filter(name => /^\d{3}\.json$/.test(name)).length, 144);
  assert.ok((await executionImplementation()).files.some(file => file.path === 'pilot-scope.mjs'));
});
