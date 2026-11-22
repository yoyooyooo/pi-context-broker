import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fingerprint } from './protocol.mjs';
import { createPreregistrationTemplate } from './templates/preregistration.mjs';
import { freezeBatchPlan, runBatch } from './batch.mjs';
import { snapshotModels } from './models.mjs';
import { ensureRemoteParent } from './remote.mjs';
import { preregisterComparison } from './planning.mjs';

// These identities exist only to test the controller. No synthetic test result is a Benchmark score.
function protocol() {
  const p = createPreregistrationTemplate(), h = fingerprint({ synthetic: true });
  Object.assign(p, { id: 'synthetic-orchestration', status: 'frozen', phase: 'regression', registered_at: '2026-11-22T00:00:00Z' });
  for (const e of p.environments) {
    e.status = 'frozen'; e.build.id = 'synthetic'; e.build.receipt_sha256 = h;
    for (const item of [e.build.cli, e.build.broker]) for (const key of Object.keys(item)) item[key] = key === 'commit' ? '1'.repeat(40) : h;
    for (const [name, runtime] of Object.entries(e.runtime)) Object.assign(runtime, { entry: '/synthetic/' + name, version: '1.0.0', sha256: h });
    e.pi.entry = e.runtime.pi.entry;
    for (const key of Object.keys(e.pi)) if (key.endsWith('_sha256')) e.pi[key] = h;
    e.pi.extensions.forEach(x => { x.sha256 = h; });
    e.manifest_sha256 = fingerprint({ ...e, manifest_sha256: null });
  }
  p.models[0].adapter.verification = 'verified'; p.models[0].adapter.evidence_sha256 = h;
  for (const condition of p.conditions) condition.environment_sha256 = p.environments.find(e => e.id === condition.environment_id).manifest_sha256;
  const budget = p.policies.budgets[0];
  budget.episode = { max_duration_ms: 1000, max_model_requests: 2, max_input_tokens: 1000, max_output_tokens: 1000, max_http_attempts: 2, max_retries: 0 };
  budget.batch = { max_episodes: 2, max_model_requests: 4, max_input_tokens: 2000, max_output_tokens: 2000, max_duration_ms: 10000, max_concurrency: 1 };
  p.policies.ordering.concurrency = 1; p.policies.reruns.max_episodes = 0;
  Object.assign(p.policies.statistics, { interval_method: 'weighted-cluster-hoeffding-v1', boundary_method: 'hoeffding-no-degenerate-bootstrap-v1', multiple_comparisons: 'bonferroni-primary-family-v1' });
  Object.assign(p.policies.decision, { absolute_quality_required: 0.8, unassisted_quality_required: 0.8, input_ratio_max: 1.1, capped_time_ratio_max: 1.15 });
  Object.assign(p.policies.evidence, { observer_version: 'test-1', normalizer_version: '1', scoring_version: '1' });
  p.protocol_sha256 = fingerprint({ ...p, protocol_sha256: null }); return p;
}
async function plan() {
  const root = await mkdtemp(join(tmpdir(), 'benchmark-controller-evidence-'));
  return freezeBatchPlan({ protocol: protocol(), execution: { environment_root: root, control_root: join(root, 'batch') } });
}
const knownResult = () => ({ status: 'completed', budget_usage: { model_requests: 1, input_tokens: 30, output_tokens: 10, duration_ms: 50 } });

test('comparison registration freezes optional analysis policy before execution', () => {
  const p = protocol();
  const analysis = { success_budgets: { time_ms: [0, 500, 1000], input_tokens: [0, 500, 1000] } };
  const args = { id: p.id, phase: p.phase, purpose: p.purpose, environments: p.environments, models: p.models,
    corpus: p.corpus, cases: p.corpus.cases.map(protocol_case => ({ id: protocol_case.id, protocol_case })),
    budget: p.policies.budgets[0], decision: p.policies.decision, allowedChanges: p.allowed_changes, registeredAt: p.registered_at };
  const frozen = preregisterComparison({ ...args, analysis });
  assert.deepEqual(frozen.policies.analysis, analysis);
  analysis.success_budgets.time_ms.push(2000);
  assert.deepEqual(frozen.policies.analysis.success_budgets.time_ms, [0, 500, 1000]);
  assert.equal(frozen.protocol_sha256, fingerprint({ ...frozen, protocol_sha256: null }));
  assert.equal(Object.hasOwn(preregisterComparison(args).policies, 'analysis'), false);
  assert.throws(() => preregisterComparison({ ...args, analysis: { success_budgets: { input_tokens: [100, 10] } } }), /increasing/);
});

test('partial batch resume executes each scheduled slot exactly once', async () => {
  const p = await plan(), calls = [];
  const executeEpisode = async ({ runId }) => { calls.push(runId); return knownResult(); };
  const first = await runBatch({ plan: p, executeEpisode, maximumNewEpisodes: 1 });
  assert.equal(first.completed, 1);
  const second = await runBatch({ plan: p, executeEpisode });
  assert.equal(second.completed, 2); assert.equal(calls.length, 2); assert.equal(new Set(calls).size, 2);
  await runBatch({ plan: p, executeEpisode }); assert.equal(calls.length, 2);
});
test('unknown execution is retained and resume cannot silently rerun it', async () => {
  const p = await plan(); let calls = 0;
  const executeEpisode = async () => { calls++; throw new Error('lost terminal receipt after possible send'); };
  const first = await runBatch({ plan: p, executeEpisode }); assert.equal(first.unresolved_runs.length, 1);
  const next = await runBatch({ plan: p, executeEpisode });
  assert.equal(next.completed, 0); assert.equal(calls, 1); assert.equal(next.last.reason, 'unresolved_previous_execution');
});
test('incomplete cost observation stops enlargement and cannot become free', async () => {
  const p = await plan(); let calls = 0;
  const result = await runBatch({ plan: p, executeEpisode: async () => { calls++; return { budget_usage: { model_requests: 1, duration_ms: 1 } }; } });
  assert.equal(calls, 1); assert.equal(result.last.reason, 'unknown_budget_usage');
});

test('a retained core stop remains stopped on a later invocation even when its usage is complete', async () => {
  const p = await plan(); let calls = 0;
  const executeEpisode = async () => { calls++; return { ...knownResult(), stop_batch: true, stop_reason: 'controller_unknown_write' }; };
  const first = await runBatch({ plan: p, executeEpisode });
  assert.equal(first.last.reason, 'controller_unknown_write'); assert.equal(calls, 1);
  const resumed = await runBatch({ plan: p, executeEpisode });
  assert.equal(resumed.last.reason, 'controller_unknown_write'); assert.equal(resumed.last.new_episodes, 0);
  assert.equal(calls, 1); assert.equal(resumed.completed, 1);
});
test('post-registration budget edits fail before any dispatcher is called', async () => {
  const p = await plan(); p.protocol.policies.budgets[0].episode.max_model_requests++;
  await assert.rejects(runBatch({ plan: p, executeEpisode: async () => { throw new Error('must not run'); } }), /modified/);
});

test('the pilot first-24 gate cannot be bypassed with a different ledger or a symlink', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-pilot-ledger-binding-')));
  const p = protocol(); p.phase = 'pilot'; p.protocol_sha256 = fingerprint({ ...p, protocol_sha256: null });
  const frozenLedger = join(root, 'pilot-ledger'); await mkdir(frozenLedger);
  for (let i = 1; i <= 24; i++) await writeFile(join(frozenLedger, String(i).padStart(3, '0') + '.json'), JSON.stringify({ reserved: i }));
  const frozen = freezeBatchPlan({ protocol: p, execution: { environment_root: root, control_root: join(root, 'batch'), pilot_ledger_root: frozenLedger } });
  let dispatched = 0;
  const executeEpisode = async () => { dispatched++; return knownResult(); };
  await assert.rejects(runBatch({ plan: frozen, pilotLedgerRoot: join(root, 'empty-alternate'), executeEpisode }), /differs from the frozen plan/);
  await assert.rejects(readFile(join(frozen.execution.control_root, 'lease.json')), { code: 'ENOENT' });
  const result = await runBatch({ plan: frozen, executeEpisode });
  assert.equal(result.last.reason, 'route_gate_pending'); assert.equal(dispatched, 0);
  assert.equal((await readdir(frozenLedger)).length, 24);
  const empty = join(root, 'empty'); await mkdir(empty);
  const alias = join(root, 'alias'); await symlink(empty, alias);
  const aliased = freezeBatchPlan({ protocol: p, execution: { environment_root: root, control_root: join(root, 'aliased-batch'), pilot_ledger_root: alias } });
  await assert.rejects(runBatch({ plan: aliased, executeEpisode }), /cannot be a symlink/);
  assert.equal(dispatched, 0); assert.deepEqual(await readdir(empty), []);
  assert.throws(() => freezeBatchPlan({ protocol: p, execution: { environment_root: root, control_root: join(root, 'undeclared') } }), /must freeze/);
});
test('selected model snapshot excludes credentials and unrelated routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'benchmark-model-evidence-')), sourceFile = join(root, 'source.json'), outputFile = join(root, 'models.json');
  await writeFile(sourceFile, JSON.stringify({ providers: { p: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'SECRET-SHOULD-NOT-BE-COPIED', models: [
    { id: 'wanted', maxTokens: 1000, contextWindow: 10000 }, { id: 'unrelated', maxTokens: 1000, contextWindow: 10000 }] } } }));
  await snapshotModels({ sourceFile, provider: 'p', modelIds: ['wanted'], outputFile });
  const text = await readFile(outputFile, 'utf8'); assert.ok(!text.includes('SECRET-SHOULD')); assert.ok(!text.includes('unrelated'));
  assert.equal(JSON.parse(text).providers.p.apiKey, 'BENCHMARK_MAGPIE_KEY');
});
test('ambiguous Notion creation is reconciled, never blindly retried', async () => {
  const controlDir = await mkdtemp(join(tmpdir(), 'benchmark-remote-evidence-'));
  const projectPageId = '1'.repeat(32), pageId = '2'.repeat(32), scopeId = 'synthetic-scope'; let post = 0, visible = false;
  const fetchImpl = async (url, options) => {
    if (options.method === 'POST') { post++; throw new Error('response lost after possible creation'); }
    let value;
    if (url.includes('/children')) value = { results: visible ? [{ id: pageId, type: 'child_page', child_page: { title: 'Synthetic · synthetic-scope' } }] : [], has_more: false };
    else value = { id: url.endsWith(pageId) ? pageId : projectPageId, object: 'page', archived: false, in_trash: false, parent: { page_id: projectPageId }, url: 'https://example.invalid/fixture' };
    return new Response(JSON.stringify(value), { status: 200 });
  };
  const args = { projectPageId, scopeId, title: 'Synthetic', controlDir, token: 'synthetic-token', fetchImpl };
  await assert.rejects(ensureRemoteParent(args), /response lost/);
  await assert.rejects(ensureRemoteParent(args), /previous create/); assert.equal(post, 1);
  visible = true; const result = await ensureRemoteParent(args); assert.equal(result.page_id, pageId); assert.equal(post, 1);
  assert.ok((await readdir(controlDir)).some(name => name.startsWith('create-attempt-')));
});
