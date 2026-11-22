import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fingerprint } from './protocol.mjs';
import { createPreregistrationTemplate } from './templates/preregistration.mjs';
import { freezeBatchPlan, runBatch } from './batch.mjs';
import { snapshotModels } from './models.mjs';
import { ensureRemoteParent } from './remote.mjs';

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
test('post-registration budget edits fail before any dispatcher is called', async () => {
  const p = await plan(); p.protocol.policies.budgets[0].episode.max_model_requests++;
  await assert.rejects(runBatch({ plan: p, executeEpisode: async () => { throw new Error('must not run'); } }), /modified/);
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
