import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fingerprint } from './protocol.mjs';
import { createPreregistrationTemplate } from './templates/preregistration.mjs';
import { executionImplementation } from './implementation.mjs';
import { createCollectionRecovery, verifyCollectionRecoveryResults } from './collection-recovery.mjs';
import { executeBatchPlan } from './controller.mjs';
import { verifyStandingPlan, inspectStandingLedger, assertStandingSetup, standingCampaignPolicy, prepareStandingScope,
  reserveStandingEpisode } from './standing-campaign.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = dirname(fileURLToPath(import.meta.url));
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n';
  await writeFile(path, bytes); return { path, sha256: sha(bytes), bytes: Buffer.byteLength(bytes) };
}
async function saveReference(path, value) { const ref = await save(path, value); return { path: ref.path, sha256: ref.sha256 }; }
function transport(runId) {
  let previous = null;
  return [{ phase: 'transport_start' }, { phase: 'transport_end', attempts: 0, errors: 0, complete: true,
    incompleteRequestIds: [], pendingForkRebind: false }].map((fields, index) => {
    const row = { version: 1, sequence: index + 1, previousSha256: previous, clockId: runId, monotonicNs: String(index + 1), ...fields };
    row.eventSha256 = sha(JSON.stringify(row)); previous = row.eventSha256; return JSON.stringify(row);
  }).join('\n') + '\n';
}

// All observations below are synthetic apparatus data. The actual standing,
// ownership, controller, collector, lease and evidence readers run unchanged.
test('standing recovery follows the explicit frozen controller through real validation, collection and the original reservation', async t => {
  const taskRoot = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-standing-closeout-e2e-')));
  t.diagnostic('Retained task-owned fixture: ' + taskRoot);
  const environmentRoot = join(taskRoot, 'environment'), control = join(environmentRoot, 'control');
  const controlRoot = join(control, 'attempt'), ledgerRoot = join(control, 'standing-ledger');
  await mkdir(controlRoot, { recursive: true });
  const oldRoot = join(environmentRoot, 'original-controller'), frozenRoot = join(environmentRoot, 'builds/synthetic/source/broker');
  const implementation = await executionImplementation();
  for (const file of implementation.files) await save(join(oldRoot, 'benchmark', file.path), await readFile(join(source, file.path)));
  const oldControllerPath = join(oldRoot, 'benchmark/controller.mjs');
  await writeFile(oldControllerPath, (await readFile(oldControllerPath)) + '\n// Earlier frozen controller fixture.\n');
  const oldImplementation = await import(pathToFileURL(join(oldRoot, 'benchmark/implementation.mjs')));
  const oldStanding = await import(pathToFileURL(join(oldRoot, 'benchmark/standing-campaign.mjs')));
  const oldBatch = await import(pathToFileURL(join(oldRoot, 'benchmark/batch.mjs')));
  const before = await oldImplementation.executionImplementation();
  await cp(oldRoot, frozenRoot, { recursive: true, errorOnExist: true });
  const authorization = await saveReference(join(control, 'grant.json'), { version: 1, kind: 'user-standing-benchmark-authorization',
    id: 'fixture-grant', approved: true, source: 'current-user-message', user_message: 'Continue this controlled test without quotas.',
    recorded_at_utc: '2000-01-01T00:00:00Z', task: 'Notion Skills Benchmark', authorization_expiry: null,
    per_batch_approval_required: false, resource_policy: { mode: 'unbounded' }, supervised_recovery_authorized: true });
  const historical = await saveReference(join(control, 'historical.json'), { fixture: true });
  const baseline = await saveReference(join(control, 'baseline.json'), { version: 1, kind: 'benchmark-standing-history-baseline', id: 'fixture-baseline',
    environment_root: environmentRoot, ledger_root: join(control, 'historical-ledger'), historical_authorization: historical,
    controller: { source_root: '/synthetic-history', implementation: {} }, observations: 998, registrations: 0, registration_refs: [],
    history: { scheduled_episodes: 998, reservations: Array(998).fill({ fixture: true }), episodes: Array(998).fill({ fixture: true }) },
    published_evidence: [], verified_at: '2000-01-01T00:00:00Z' });
  const epoch = { id: 'fixture-epoch', started_at: '2000-01-01T00:00:00Z', authorization };
  const budget = { id: 'required-budget', mode: 'unbounded', episode: { max_duration_ms: null, max_model_requests: null,
    max_input_tokens: null, max_output_tokens: null, max_http_attempts: null, max_retries: null },
    batch: { max_episodes: null, max_model_requests: null, max_input_tokens: null, max_output_tokens: null, max_duration_ms: null, max_concurrency: 1 },
    monetary: { policy: 'unpriced', currency: null, max_amount: null, pricing_sha256: null } };
  const window = { mode: 'standing', start: epoch.started_at, end: null };
  const template = { version: 1, id: 'template', control_root: join(control, 'template'), environment_root: environmentRoot,
    budget, models: { window } };
  const templateRef = await saveReference(join(control, 'template.json'), template);
  const workPlan = await saveReference(join(control, 'work-plan.json'), { version: 1, kind: 'benchmark-standing-work-plan', id: 'fixture-work',
    task: 'Notion Skills Benchmark', environment_root: environmentRoot, authorization, resource_policy: { mode: 'unbounded' },
    condition_epoch: epoch, controller: { source_root: oldRoot, implementation: before }, baseline,
    entries: [{ id: 'design', setup: templateRef, planned_episodes: 2 }], created_at: epoch.started_at });
  const setup = { ...template, id: 'fixture-closeout', control_root: controlRoot,
    standing: { authorization, work_plan: workPlan, work_item_id: 'design', attempt_id: 'fixture-closeout', ledger_root: ledgerRoot } };
  await save(join(controlRoot, 'setup.json'), setup);
  const context = await oldStanding.assertStandingSetup(setup);
  const p = createPreregistrationTemplate(), h = fingerprint({ synthetic: 'standing closeout' });
  Object.assign(p, { id: setup.id, status: 'frozen', phase: 'pilot', registered_at: '2026-11-22T00:00:00Z' });
  for (const env of p.environments) {
    env.status = 'frozen'; env.build.id = 'synthetic'; env.build.receipt_sha256 = h;
    for (const item of [env.build.cli, env.build.broker]) for (const key of Object.keys(item)) item[key] = key === 'commit' ? '1'.repeat(40) : h;
    for (const [name, runtime] of Object.entries(env.runtime)) Object.assign(runtime, { entry: '/synthetic/' + name, version: '1.0.0', sha256: h });
    env.pi.entry = env.runtime.pi.entry;
    for (const key of Object.keys(env.pi)) if (key.endsWith('_sha256')) env.pi[key] = h;
    env.pi.extensions.forEach(extension => { extension.sha256 = h; });
    env.manifest_sha256 = fingerprint({ ...env, manifest_sha256: null });
  }
  const proof = await save(join(taskRoot, 'foreign/adapter.json'), '{ "synthetic_adapter_proof": true }\n');
  p.models[0].adapter.verification = 'verified'; p.models[0].adapter.evidence_sha256 = proof.sha256;
  p.models[0].backend.window = window;
  p.models[0].routing = { mode: 'auto-route', model_variant: 'grok-4.7', reported_model_ids: ['grok-4.7'] };
  for (const condition of p.conditions) condition.environment_sha256 = p.environments.find(env => env.id === condition.environment_id).manifest_sha256;
  p.policies.budgets = [budget]; p.policies.ordering.concurrency = 1; p.policies.reruns.max_episodes = null;
  p.policies.pilot.max_scheduled_episodes = null; p.policies.pilot.route_gate_episodes = null;
  p.policies.analysis = { capped_time_horizon_ms: 60000 };
  p.policies.campaign = oldStanding.standingCampaignPolicy(context, { scheduledEpisodes: 2 });
  Object.assign(p.policies.statistics, { interval_method: 'weighted-cluster-hoeffding-v1', boundary_method: 'hoeffding-no-degenerate-bootstrap-v1', multiple_comparisons: 'bonferroni-primary-family-v1' });
  Object.assign(p.policies.decision, { absolute_quality_required: 0.8, unassisted_quality_required: 0.8, input_ratio_max: 1.1, capped_time_ratio_max: 1.15 });
  Object.assign(p.policies.evidence, { observer_version: 'test-1', normalizer_version: '1', scoring_version: '1' });
  const oracle = { schema_version: 1, case_id: 'example-case', capability_scope: 'common', required_capabilities: ['example-common-business'],
    contracts: [{ id: 'deliverable', kind: 'artifact-json', path: 'output/result.json', comparison: 'exact', expected: { answer: 7 }, critical: true }] };
  p.corpus.cases[0].contract_sha256 = fingerprint(oracle);
  p.protocol_sha256 = fingerprint({ ...p, protocol_sha256: null });
  const oracleRef = await save(join(controlRoot, 'oracle.json'), oracle), inputRoot = join(controlRoot, 'inputs');
  await mkdir(inputRoot);
  const binding = { id: 'example-case', protocol_case: p.corpus.cases[0], oracle_path: oracleRef.path, oracle_sha256: oracleRef.sha256,
    input_root: inputRoot, input_inventory_sha256: sha('[]'), skill_inventory: [], events: [], clarification: [],
    public_case: { id: 'example-case', title: 'Synthetic closeout fixture', completion: { paths: ['output/result.json'] }, turns: [{ id: 'turn-1', prompt: 'Synthetic closeout fixture' }] } };
  const bindings = await save(join(controlRoot, 'bindings.json'), [binding]), models = await save(join(controlRoot, 'models.json'), { synthetic: true });
  const expectation = await save(join(controlRoot, 'expectation.json'), { projection: {
    visibility: { projection: { files: [] } }, pi: { files: [] }, node: { sha256: h }, bun: { sha256: h } } });
  const execution = { environment_root: environmentRoot, control_root: controlRoot, pilot_ledger_root: ledgerRoot, implementation: before,
    case_bindings_file: bindings.path, case_bindings_sha256: bindings.sha256, models_file: models.path, models_sha256: models.sha256,
    adapter_evidence_file: proof.path, conditions: Object.fromEntries(p.conditions.map(condition => [condition.id,
      { build_id: 'synthetic', mode: 'broker', expectations: { 'example-case': { path: expectation.path, sha256: expectation.sha256 } } }])) };
  execution.instrumentation = await oldImplementation.instrumentationIdentity(execution);
  const slots = oldBatch.scheduleProtocol(p), scope = await oldStanding.prepareStandingScope({ setup, protocol: p, execution, slots });
  execution[scope.field] = scope.registration;
  const plan = oldBatch.freezeBatchPlan({ protocol: p, execution }), planRef = await save(join(controlRoot, 'plan.json'), plan);
  await save(join(ledgerRoot, 'campaign.lease.json'), { id: 'fixture-lease', pid: process.pid, plan_sha256: plan.plan_sha256, scope_id: plan.id, control_root: controlRoot });
  const amendment = await oldStanding.verifyStandingPlan(plan, { activate: true });
  const slot = plan.slots[0], runId = plan.id + '-001', runRoot = join(environmentRoot, 'runs', runId);
  const reservation = await oldStanding.reserveStandingEpisode({ plan, amendment, slot, runId, planReference: { path: planRef.path, sha256: planRef.sha256 } });
  assert.equal(reservation.ordinal, 999);
  await rename(join(ledgerRoot, 'campaign.lease.json'), join(ledgerRoot, 'campaign.lease-retained-fixture.json'));
  const rows = [{ type: 'batch_opened', plan_sha256: plan.plan_sha256 }, { type: 'episode_started', ...slot, run_id: runId, budget_id: budget.id },
    { type: 'episode_unresolved', ...slot, run_id: runId, error: { name: 'AssertionError', message: 'Evidence file escapes the owned environment' } },
    { type: 'batch_closed', reason: 'unresolved_execution_error', new_episodes: 1 }];
  const ledger = await save(join(controlRoot, 'ledger.jsonl'), rows.map((row, index) => JSON.stringify({ version: 1, seq: index + 1, ...row })).join('\n') + '\n');
  await mkdir(join(runRoot, 'workspace'), { recursive: true });
  const runtimeRoot = join(runRoot, 'benchmark/runtime'), artifacts = [];
  for (const [id, filename, bytes, kind] of [
    ['events', 'events.jsonl', JSON.stringify({ version: 1, sequence: 1, type: 'runtime_error', data: { message: 'BENCHMARK_NOTION_STARTUP_PENDING' } }) + '\n', 'jsonl'],
    ['transport', 'transport.jsonl', transport(runId), 'jsonl'], ['session-entries', 'session-entries.json', { entries: [] }, 'json'],
  ]) { const ref = await save(join(runtimeRoot, filename), bytes); artifacts.push({ id, ...ref, realpath: ref.path, kind }); }
  const raw = { version: 1, entry_kind: 'pi-sdk', status: 'invalid', correlation: { run_id: runId, episode_id: runId, candidate_id: slot.condition_id, task_id: slot.case_id },
    admission: { status: 'pending', refs: [] }, requests: [], turns: [], interventions: [],
    error: { name: 'AssertionError', code: 'ERR_ASSERTION', message: 'BENCHMARK_NOTION_STARTUP_PENDING', details: null },
    budget: { requests: 0, attempts: 0, tools: 0, input_tokens: 0, output_tokens: 0, tokens: 0, usage_unknown: false, stop: null },
    coverage: { attempts: 'complete', tools: 'complete', interventions: 'complete', notion_sdk: 'complete', notion_owned_http: 'complete' },
    completion: { agent_settled: false, cleanup: { abort_settled: true, shutdown_emitted: true, dispose_called: true } },
    timing: { duration_ms: 47870.911792 }, artifacts };
  const rawRef = await save(join(runtimeRoot, 'episode-result.json'), raw);
  await save(join(runRoot, 'run.json'), { run_id: runId, root: runRoot, build_id: 'synthetic', build_root: join(environmentRoot, 'builds/synthetic'), pi_launch: { mode: 'broker' } });
  await save(join(runRoot, 'result.json'), { run_id: runId, root: runRoot, build_id: 'synthetic', status: 'failed', exit_code: 1,
    spawned: true, timed_out: false, signal: null, frozen_artifacts: 'passed', runtime_check: { status: 'unchanged' } });
  const partial = await save(join(runRoot, 'benchmark/normalized/partial.json'), { retained: true });
  const reservationBytes = await readFile(join(ledgerRoot, '999.json'));
  await writeFile(oldControllerPath, (await readFile(oldControllerPath)) + '// Mutable checkout advanced after the original plan.\n');
  await assert.rejects(verifyStandingPlan(plan), /STANDING_CONTROLLER_CHANGED/);
  const args = { planFile: planRef.path, frozenController: join(frozenRoot, 'benchmark/cli.mjs'), reason: 'Retain the synthetic invalid startup and project only the unchanged adapter evidence.' };
  const first = await createCollectionRecovery(args);
  const next = await createCollectionRecovery({ ...args, outputFile: join(controlRoot, 'collection-repair-registration-2.json'), supersedes: first.reference.path,
    reason: 'Retain the first unapplied fixture registration and explicitly exercise immutable replacement without a new reservation.' });
  await assert.rejects(verifyStandingPlan(plan, { collectionRecoveryReference: next.reference, maximumNewEpisodes: 1 }), /ZERO_NEW_EPISODES/);
  await assert.rejects(verifyStandingPlan(plan, { collectionRecoveryReference: next.reference, maximumNewEpisodes: 0, forReservation: true }), /CANNOT_RESERVE/);
  await verifyStandingPlan(plan, { collectionRecoveryReference: next.reference, maximumNewEpisodes: 0 });
  await assert.rejects(executeBatchPlan({ plan, collectionRecoveryFile: next.reference.path, maximumNewEpisodes: 1 }), /requires --limit 0/);
  const result = await executeBatchPlan({ plan, collectionRecoveryFile: next.reference.path, maximumNewEpisodes: 0 });
  assert.equal(result.last.new_episodes, 0); assert.deepEqual(result.unresolved_runs, []);
  assert.equal(result.completed, 1); assert.equal(result.episodes[0].result.status, 'invalid');
  assert.equal(result.episodes[0].result.stop_batch, true);
  assert.deepEqual(result.episodes[0].result.budget_usage, { model_requests: 0, input_tokens: 0, output_tokens: 0, duration_ms: 47870.911792 });
  assert.equal((await inspectStandingLedger({ ledgerRoot, baseline })).global_observations, 999);
  assert.deepEqual(await readFile(join(ledgerRoot, '999.json')), reservationBytes);
  for (const ref of [planRef, rawRef, partial, workPlan, proof]) assert.equal(sha(await readFile(ref.path)), ref.sha256);
  assert.equal(sha((await readFile(ledger.path)).subarray(0, ledger.bytes)), ledger.sha256);
  assert.equal((await verifyCollectionRecoveryResults(plan, result.episodes)).reference.path, next.reference.path);
  await verifyStandingPlan(plan, { collectionRecoveryReference: next.reference, maximumNewEpisodes: 0 });

  // A real successor scope may reserve 1000 without invalidating the frozen
  // 999 recovery. Use the public standing guards, not a hand-written append.
  const successorRoot = join(control, 'successor'), successorTemplate = { ...template, id: 'successor-template' };
  const successorTemplateRef = await saveReference(join(control, 'successor-template.json'), successorTemplate);
  const successorWork = await saveReference(join(control, 'successor-work.json'), {
    ...JSON.parse(await readFile(workPlan.path, 'utf8')), id: 'successor-work',
    controller: { source_root: dirname(source), implementation },
    entries: [{ id: 'successor-design', setup: successorTemplateRef, planned_episodes: 2 }] });
  const successorSetup = { ...successorTemplate, id: 'successor', control_root: successorRoot,
    standing: { authorization, work_plan: successorWork, work_item_id: 'successor-design', attempt_id: 'successor', ledger_root: ledgerRoot } };
  await save(join(successorRoot, 'setup.json'), successorSetup);
  const successorContext = await assertStandingSetup(successorSetup), successorProtocol = structuredClone(p);
  successorProtocol.id = 'successor';
  successorProtocol.policies.campaign = standingCampaignPolicy(successorContext, { scheduledEpisodes: 2 });
  successorProtocol.protocol_sha256 = fingerprint({ ...successorProtocol, protocol_sha256: null });
  const successorExecution = { ...execution, control_root: successorRoot, implementation };
  delete successorExecution.standing_scope;
  const successorSlots = oldBatch.scheduleProtocol(successorProtocol);
  const successorScope = await prepareStandingScope({ setup: successorSetup, protocol: successorProtocol,
    execution: successorExecution, slots: successorSlots });
  successorExecution[successorScope.field] = successorScope.registration;
  const successorPlan = oldBatch.freezeBatchPlan({ protocol: successorProtocol, execution: successorExecution });
  const successorPlanRef = await saveReference(join(successorRoot, 'plan.json'), successorPlan);
  await save(join(ledgerRoot, 'campaign.lease.json'), { id: 'successor-lease', pid: process.pid,
    plan_sha256: successorPlan.plan_sha256, scope_id: successorPlan.id, control_root: successorRoot });
  const successorAmendment = await verifyStandingPlan(successorPlan, { activate: true });
  assert.equal((await reserveStandingEpisode({ plan: successorPlan, amendment: successorAmendment,
    slot: successorSlots[0], runId: 'successor-001', planReference: successorPlanRef })).ordinal, 1000);
  await rename(join(ledgerRoot, 'campaign.lease.json'), join(ledgerRoot, 'campaign.lease-retained-successor.json'));
  assert.equal((await inspectStandingLedger({ ledgerRoot, baseline })).global_observations, 1000);
  const verifyHistory = () => verifyCollectionRecoveryResults(plan, result.episodes);
  const retained = await verifyHistory();
  assert.deepEqual(retained.repairs[0].standing_accounting, next.recovery.repairs[0].standing_accounting);
  assert.equal(retained.repairs[0].standing_accounting.last_observation, 999);
  await verifyStandingPlan(plan, { collectionRecoveryReference: next.reference, maximumNewEpisodes: 0 });

  const reservationPath = join(ledgerRoot, '999.json'), baselinePath = join(ledgerRoot, 'ledger-baseline.json');
  for (const path of [reservationPath, baselinePath]) {
    const bytes = await readFile(path);
    await writeFile(path, Buffer.concat([bytes, Buffer.from('\n')]));
    try { await assert.rejects(verifyHistory(), /Original failed raw execution or reservation changed/); }
    finally { await writeFile(path, bytes); }
  }
  await rename(reservationPath, reservationPath + '.missing-test');
  try { await assert.rejects(verifyHistory(), /exactly one existing shared reservation/); }
  finally { await rename(reservationPath + '.missing-test', reservationPath); }
  for (const [name, bytes, error] of [
    ['998.json', JSON.stringify({ run_id: 'inserted-before-prefix' }), /Original failed raw execution or reservation changed/],
    ['0999.json', reservationBytes, /STANDING_NONCANONICAL_ORDINAL/],
    ['1001.json', reservationBytes, /exactly one existing shared reservation/],
  ]) {
    const path = join(ledgerRoot, name); await writeFile(path, bytes);
    try { await assert.rejects(verifyHistory(), error); }
    finally { await rename(path, path + '.rejected-test'); }
  }
  assert.equal((await verifyHistory()).reference.sha256, next.reference.sha256);
  assert.deepEqual(await readFile(reservationPath), reservationBytes);
});
