import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { fingerprint } from './protocol.mjs';
import { createPreregistrationTemplate } from './templates/preregistration.mjs';
import { freezeBatchPlan } from './batch.mjs';
import { executionImplementation, instrumentationIdentity } from './implementation.mjs';
import { writeEvidenceBundle } from './evidence/store.mjs';
import { createAnalysisRevision, verifyAnalysisRevision } from './revision.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceRoot = dirname(fileURLToPath(import.meta.url));
const json = value => JSON.stringify(value, null, 2) + '\n';
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value);
  await writeFile(path, bytes);
  return { path, sha256: sha(bytes), bytes: Buffer.byteLength(bytes) };
}
function protocol() {
  const p = createPreregistrationTemplate(), h = fingerprint({ synthetic_revision_test: true });
  Object.assign(p, { id: 'synthetic-revision', status: 'frozen', phase: 'regression', registered_at: '2026-11-22T00:00:00Z' });
  for (const e of p.environments) {
    e.status = 'frozen'; e.build.id = 'synthetic'; e.build.receipt_sha256 = h;
    for (const item of [e.build.cli, e.build.broker]) for (const key of Object.keys(item)) item[key] = key === 'commit' ? '1'.repeat(40) : h;
    for (const [name, runtime] of Object.entries(e.runtime)) Object.assign(runtime, { entry: '/synthetic/' + name, version: '1.0.0', sha256: h });
    e.pi.entry = e.runtime.pi.entry;
    for (const key of Object.keys(e.pi)) if (key.endsWith('_sha256')) e.pi[key] = h;
    e.pi.extensions.forEach(x => { x.sha256 = h; }); e.manifest_sha256 = fingerprint({ ...e, manifest_sha256: null });
  }
  p.models[0].adapter.verification = 'verified'; p.models[0].adapter.evidence_sha256 = h;
  for (const c of p.conditions) c.environment_sha256 = p.environments.find(e => e.id === c.environment_id).manifest_sha256;
  p.policies.budgets[0].episode = { max_duration_ms: 1000, max_model_requests: 2, max_input_tokens: 1000, max_output_tokens: 1000, max_http_attempts: 2, max_retries: 0 };
  p.policies.budgets[0].batch = { max_episodes: 2, max_model_requests: 4, max_input_tokens: 2000, max_output_tokens: 2000, max_duration_ms: 10000, max_concurrency: 1 };
  p.policies.ordering.concurrency = 1; p.policies.reruns.max_episodes = 0;
  Object.assign(p.policies.statistics, { interval_method: 'weighted-cluster-hoeffding-v1', boundary_method: 'hoeffding-no-degenerate-bootstrap-v1', multiple_comparisons: 'bonferroni-primary-family-v1' });
  Object.assign(p.policies.decision, { absolute_quality_required: 0.8, unassisted_quality_required: 0.8, input_ratio_max: 1.1, capped_time_ratio_max: 1.15 });
  Object.assign(p.policies.evidence, { observer_version: 'test-1', normalizer_version: '1', scoring_version: '1' });
  p.protocol_sha256 = fingerprint({ ...p, protocol_sha256: null }); return p;
}

// Owned real files and independent raw usage. No HTTP, model, remote fixture or score is produced.
async function fixture({ nextMutation, oldMutation, planMutation, readbackMutation, collectionMutation } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-revision-proof-')));
  const control = join(root, 'control'), runId = 'synthetic-run', runRoot = join(root, 'runs', runId);
  const p = protocol(), condition = p.conditions[0], model = p.models[0], inputRoot = join(control, 'inputs');
  const input = await save(join(inputRoot, 'input/data.json'), { amount: 7 });
  const inputInventory = [{ path: 'input/data.json', sha256: input.sha256, bytes: input.bytes, executable: false }];
  const oracle = await save(join(control, 'private/oracle.json'), { expected: 7, contract: 'synthetic-only' });
  const binding = { id: 'example-case', oracle_path: oracle.path, oracle_sha256: oracle.sha256,
    input_root: inputRoot, input_inventory_sha256: sha(JSON.stringify(inputInventory)), skill_inventory: [],
    public_case: { id: 'example-case', turns: [{ id: 'turn-1', prompt: 'Synthetic controller test' }] } };
  const bindings = await save(join(control, 'bindings.json'), [binding]), models = await save(join(control, 'models.json'), { synthetic: true });
  const expectation = await save(join(control, 'expectation.json'), { projection: {
    visibility: { source_moved_outside_run: true, projection: { files: [{ path: 'benchmark/runtime/episode-test.mjs', sha256: sha('observer'), bytes: 8 }] } },
    pi: { files: [] }, node: { sha256: sha('node') }, bun: { sha256: sha('bun') },
  } });
  const implementation = await executionImplementation();
  const execution = { environment_root: root, control_root: control, implementation,
    case_bindings_file: bindings.path, case_bindings_sha256: bindings.sha256, models_file: models.path, models_sha256: models.sha256,
    conditions: Object.fromEntries(p.conditions.map(c => [c.id, { build_id: 'synthetic', expectations: { 'example-case': { path: expectation.path, sha256: expectation.sha256 } } }])) };
  execution.instrumentation = await instrumentationIdentity(execution);
  if (planMutation) planMutation(execution);
  const plan = freezeBatchPlan({ protocol: p, execution }), slot = plan.slots.find(s => s.condition_id === condition.id);
  const planFile = join(control, 'plan.json'); await save(planFile, plan);
  const baseFiles = [];
  for (const file of implementation.files) {
    const archive = join(control, 'controller-source-original', file.sha256);
    await save(archive, await readFile(join(sourceRoot, file.path)));
    baseFiles.push({ ...file, archive, verified: true });
  }
  await save(join(control, 'original-controller-source-retention.json'), {
    version: 1, kind: 'original-controller-source-retention', complete: true, plan_sha256: plan.plan_sha256, files: baseFiles,
  });
  const raw = [], add = async (id, path, value, kind = 'json') => {
    const artifact = { id, ...await save(path, value), kind }; raw.push(artifact); return artifact;
  };
  const events = await add('events', join(runRoot, 'benchmark/runtime/events.jsonl'), json({
    type: 'provider_stream_event', data: { request_id: 'request-1', attempt_id: 'attempt-1',
      provider: model.provider, model: model.route, api: model.api,
      event: { response: { usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } } },
  }).replaceAll('\n', '') + '\n', 'jsonl');
  await add('request-1-payload', join(runRoot, 'benchmark/runtime/request-1-payload.json'), { model: model.route, input: 'synthetic' });
  await add('transport', join(runRoot, 'benchmark/runtime/transport.jsonl'), '{"phase":"request_sent","id":1}\n', 'jsonl');
  const runtime = { status: 'completed', correlation: { run_id: runId, episode_id: runId },
    timing: { duration_ms: 100 }, requests: [{ id: 'request-1', attempts: [{ id: 'attempt-1', sent: true }] }] };
  const runtimeArtifact = await add('collection-runtime-result', join(runRoot, 'benchmark/runtime/episode-result.json'), runtime);
  const analysisFiles = [];
  for (const [index, file] of execution.instrumentation.collector_files.entries()) {
    const id = 'collection-implementation-' + index;
    await add(id, join(control, 'collector-sources', file.sha256), await readFile(join(sourceRoot, '..', file.path)), 'implementation');
    analysisFiles.push({ ...file, artifact_id: id });
  }
  const analysis = { schema_version: 1, scope: 'collector local static import closure', files: analysisFiles };
  analysis.sha256 = fingerprint(analysis);
  const ref = { artifact_id: 'events', sha256: events.sha256, line: 1 };
  const measured = value => ({ status: 'known', value, refs: [ref], precision: 'reported' });
  const unknown = { status: 'unknown', reason: 'old collector could not associate usage', refs: [ref] };
  const identity = { run_id: runId, episode_id: runId, experiment_id: plan.id, case_id: slot.case_id,
    condition_id: condition.id, environment_id: condition.environment_id, environment_sha256: condition.environment_sha256,
    model_id: model.id, model_route: model.route, pair_id: slot.pair_id, repeat: slot.repeat, seed: slot.seed,
    build_id: 'synthetic', budget_id: condition.budget_id, corpus_id: p.corpus.id, corpus_sha256: p.corpus.content_sha256, phase: p.phase,
    collector_version: 'old-synthetic', collector_source_sha256: analysisFiles.find(file => file.path === 'benchmark/collect.mjs').sha256,
    analysis_implementation: analysis, reanalysis_of: null };
  const attempt = { id: 'attempt-1', request_id: 'request-1', seq: 0, sent: true, transport_id: 1,
    adapter: { verified: true, evidence_sha256: model.adapter.evidence_sha256, input_semantics: 'includes_cache', output_semantics: 'includes_reasoning' },
    full_input: unknown, full_output: unknown };
  const old = { schema_version: 1, kind: 'benchmark-normalized-episode', identity,
    admission: { status: 'valid', completeness: { attempts: 'complete' } }, attempts: [attempt],
    measurements: { actual_attempts: measured(1), input_total: { value: unknown, observed_items: 0, total_items: 1 }, output_total: { value: unknown, observed_items: 0, total_items: 1 } },
    timing: { duration_ms: measured(100) }, artifacts: [], episode_sha256: null };
  const readback = { oracle: { sha256: oracle.sha256, contract_sha256: fingerprint({ contract: 'synthetic-only' }) },
    runtime_result_sha256: runtimeArtifact.sha256, protocol_sha256: p.protocol_sha256 };
  const oldReadback = { id: 'collection-readback', ...await save(join(runRoot, 'benchmark/old/readback.json'), readback), kind: 'json' };
  old.artifacts = [...raw, oldReadback]; if (oldMutation) oldMutation(old);
  old.episode_sha256 = fingerprint({ ...old, episode_sha256: null });
  const oldDirectory = join(runRoot, 'benchmark/old/normalized');
  const journey = { episode_id: runId, admission: { status: 'valid' }, outcome: { outcome: 'unknown', verified_success: false, unassisted_success: null }, tool_tree: [], stages: [], limitations: ['Synthetic proof, not a Benchmark sample'] };
  await writeEvidenceBundle({ directory: oldDirectory, bundle: { episode: old, events: [{ kind: 'synthetic' }], journey }, rawRoot: root });
  const next = structuredClone(old), directory = join(control, 'reanalysis/normalized');
  next.identity.collector_version = 'new-synthetic';
  next.identity.reanalysis_of = { episode_sha256: old.episode_sha256, collector_version: old.identity.collector_version,
    collector_source_sha256: old.identity.collector_source_sha256, analysis_implementation_sha256: old.identity.analysis_implementation.sha256, directory: oldDirectory };
  next.attempts[0].full_input = measured(100); next.attempts[0].full_output = measured(20);
  next.measurements.input_total = { value: measured(100), observed_items: 1, total_items: 1 };
  next.measurements.output_total = { value: measured(20), observed_items: 1, total_items: 1 };
  const newReadback = structuredClone(readback); if (readbackMutation) readbackMutation(newReadback);
  next.artifacts = [...raw, { id: 'collection-readback', ...await save(join(control, 'reanalysis/readback.json'), newReadback), kind: 'json' }];
  if (nextMutation) await nextMutation(next, { root, control, runRoot, save });
  next.episode_sha256 = fingerprint({ ...next, episode_sha256: null });
  await writeEvidenceBundle({ directory, bundle: { episode: next, events: [{ kind: 'synthetic' }], journey }, rawRoot: root });
  const collection = { run_id: runId, episode_sha256: next.episode_sha256, stop_batch: false, validity: 'valid',
    paths: { bundle: directory }, budget_usage: { model_requests: 1, input_tokens: 100, output_tokens: 20, duration_ms: 100 } };
  if (collectionMutation) collectionMutation(collection);
  await save(join(control, 'reanalysis/collection.json'), collection);
  const rows = [
    { seq: 1, type: 'batch_opened', plan_sha256: plan.plan_sha256 },
    { seq: 2, type: 'episode_started', run_id: runId, ...slot },
    { seq: 3, type: 'episode_completed', run_id: runId, ...slot, result: { status: 'completed', run_root: runRoot,
      normalized_directory: oldDirectory, episode_sha256: old.episode_sha256, stop_batch: true,
      budget_usage: { model_requests: 1, input_tokens: null, output_tokens: null, duration_ms: 100 } } },
  ];
  const ledger = join(control, 'ledger.jsonl'); await save(ledger, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { root, control, plan, runId, directory, old, next, ledger, input, oracle,
    args: { planFile, outputFile: join(control, 'revision.json'), replacements: [{ run_id: runId, directory }], reason: 'Synthetic same-raw analysis repair' } };
}
const create = f => createAnalysisRevision(f.args);
async function altered(f, revision, mutate, name) {
  const value = structuredClone(revision); mutate(value);
  value.revision_sha256 = fingerprint({ ...value, revision_sha256: null });
  const ref = await save(join(f.control, name + '.json'), value);
  return { path: ref.path, sha256: ref.sha256 };
}

test('same raw usage is restored once, all old bytes retained, and the new source is readable offline', async () => {
  const f = await fixture(), before = await readFile(f.ledger), result = await create(f);
  const checked = await verifyAnalysisRevision({ reference: result.reference, plan: f.plan });
  assert.deepEqual(checked.replacements[0].budget_usage, { model_requests: 1, input_tokens: 100, output_tokens: 20, duration_ms: 100 });
  assert.equal(checked.replacements[0].status, 'completed'); assert.equal(checked.replacements[0].stop_batch, false);
  assert.ok((await readFile(f.ledger)).equals(before)); assert.equal(checked.replacements[0].original_episode_sha256, f.old.episode_sha256);
  assert.equal(checked.implementation_sources.length, checked.implementation.files.length);
  const isolated = join(f.control, 'offline-verifier');
  for (const file of ['revision.mjs', 'protocol.mjs', 'metrics.json', 'evidence/store.mjs', 'evidence/normalize.mjs',
    'schemas/environment-manifest.schema.json', 'schemas/protocol.schema.json']) {
    await mkdir(dirname(join(isolated, file)), { recursive: true }); await copyFile(join(sourceRoot, file), join(isolated, file));
  }
  await save(join(isolated, 'implementation.mjs'), "export function executionImplementation(){throw Error('live source must not be consulted')}\nexport function instrumentationIdentity(){throw Error('live source must not be consulted')}\n");
  const offline = await import(pathToFileURL(join(isolated, 'revision.mjs')).href);
  assert.equal((await offline.verifyAnalysisRevision({ reference: result.reference, plan: f.plan })).revision_sha256, checked.revision_sha256);
  await assert.rejects(create(f), /EEXIST/);
});

test('appending later ledger rows preserves verification, but another applied revision is rejected', async () => {
  const f = await fixture(), result = await create(f);
  await appendFile(f.ledger, JSON.stringify({ seq: 4, type: 'analysis_revision_applied', reference: result.reference }) + '\n');
  await verifyAnalysisRevision({ reference: result.reference, plan: f.plan });
  await appendFile(f.ledger, JSON.stringify({ seq: 5, type: 'batch_opened', plan_sha256: f.plan.plan_sha256 }) + '\n');
  await verifyAnalysisRevision({ reference: result.reference, plan: f.plan });
  await assert.rejects(create({ ...f, args: { ...f.args, outputFile: join(f.control, 'chain.json') } }), /CHAIN_UNSUPPORTED/);
  const other = await altered(f, result.revision, value => { value.reason = 'another revision'; }, 'other');
  await assert.rejects(verifyAnalysisRevision({ reference: other, plan: f.plan }), /OTHER_REGISTERED_REVISION/);
});

test('unknown usage, absent send truth, and an unverified adapter cannot unlock the next request', async () => {
  for (const mutate of [
    next => { next.attempts[0].full_input = { status: 'unknown', reason: 'missing', refs: [] }; },
    next => { next.attempts[0].sent = null; },
    next => { next.attempts[0].adapter.verified = false; },
  ]) await assert.rejects(create(await fixture({ nextMutation: mutate })));
});

test('a known usage claim must match actual native response bytes, not a lowered aggregate', async () => {
  const f = await fixture({ nextMutation: next => {
    next.attempts[0].full_input.value = 90; next.measurements.input_total.value.value = 90;
  }, collectionMutation: collection => { collection.budget_usage.input_tokens = 90; } });
  await assert.rejects(create(f), /RAW_USAGE_MISMATCH/);
});

test('an added or removed actual request is not an analysis repair', async () => {
  for (const mutate of [
    next => { next.attempts.push({ ...next.attempts[0], id: 'another-attempt' }); },
    next => { next.attempts = []; next.measurements.actual_attempts.value = 0; },
  ]) await assert.rejects(create(await fixture({ nextMutation: mutate })), /ATTEMPTS_CHANGED/);
});

test('changed payload bytes, model identity, or oracle cannot reuse the observed run', async () => {
  await assert.rejects(create(await fixture({ nextMutation: async (next, f) => {
    const a = next.artifacts.find(a => a.id === 'request-1-payload');
    Object.assign(a, await f.save(join(f.control, 'different-payload.json'), { model: 'another' }));
  } })), /RAW_SUBSTRATE_CHANGED/);
  await assert.rejects(create(await fixture({ nextMutation: next => { next.identity.model_id = 'other-model'; } })), /SUBJECT_IDENTITY_CHANGED/);
  await assert.rejects(create(await fixture({ readbackMutation: readback => { readback.oracle.sha256 = 'f'.repeat(64); } })), /ORACLE_CHANGED/);
});

test('frozen material files and original evidence cannot change after revision creation', async () => {
  const f = await fixture(), result = await create(f);
  await writeFile(f.input.path, '{"amount":8}\n');
  await assert.rejects(verifyAnalysisRevision({ reference: result.reference, plan: f.plan }), /PUBLIC_INPUTS_CHANGED/);
  const g = await fixture(), other = await create(g);
  await writeFile(g.oracle.path, '{"expected":8}\n');
  await assert.rejects(verifyAnalysisRevision({ reference: other.reference, plan: g.plan }), /ORACLE_BYTES_CHANGED/);
});

test('resumed budget and runtime identities are recomputed, never accepted as revision overrides', async () => {
  const f = await fixture(), result = await create(f);
  for (const [name, mutate, expected] of [
    ['budget', value => { value.replacements[0].budget_usage.input_tokens = 0; }, /REPLACEMENT_CHANGED/],
    ['runtime', value => { value.instrumentation.runtime_sha256 = ['f'.repeat(64)]; }, /RUNTIME_CHANGED/],
    ['override', value => { value.execution = { budget: 'unlimited' }; }, /UNDECLARED_OVERRIDE/],
  ]) {
    const reference = await altered(f, result.revision, mutate, name);
    await assert.rejects(verifyAnalysisRevision({ reference, plan: f.plan }), expected);
  }
});

test('a source edit outside the bounded repair and exact preparation pair is rejected', async () => {
  for (const path of ['execute.mjs', 'corpus/index.mjs', 'corpus/grader.mjs']) {
    const f = await fixture({ planMutation: execution => {
      const file = execution.implementation.files.find(file => file.path === path); file.sha256 = 'f'.repeat(64);
      execution.implementation.sha256 = fingerprint(execution.implementation.files);
    } });
    await assert.rejects(create(f), /EXECUTION_SOURCE_CHANGED/);
  }
});

test('retained new source bytes and historical ledger prefixes are independently checked', async () => {
  const f = await fixture(), result = await create(f), source = result.revision.implementation_sources[0];
  await chmod(source.source_path, 0o600); await appendFile(source.source_path, '\nchanged\n');
  await assert.rejects(verifyAnalysisRevision({ reference: result.reference, plan: f.plan }), /SOURCE_ARCHIVE_CHANGED/);
  const g = await fixture(), other = await create(g), rows = (await readFile(g.ledger, 'utf8')).trim().split('\n').map(JSON.parse);
  rows[2].result.budget_usage.model_requests = 0; await save(g.ledger, rows.map(JSON.stringify).join('\n') + '\n');
  await assert.rejects(verifyAnalysisRevision({ reference: other.reference, plan: g.plan }), /LEDGER_PREFIX_CHANGED/);
});

test('the collection must acknowledge known cost and the exact observed completion status', async () => {
  await assert.rejects(create(await fixture({ collectionMutation: collection => { collection.stop_batch = true; } })), /STILL_STOPPED/);
  await assert.rejects(create(await fixture({ collectionMutation: collection => { collection.budget_usage.output_tokens = 0; } })), /COLLECTION_BUDGET_MISMATCH/);
});

