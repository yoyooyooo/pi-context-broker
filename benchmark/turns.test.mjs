import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEpisodeTurns } from './evidence/turns.mjs';

const fact = value => value === null ? { status: 'unknown', reason: 'missing usage', refs: [] }
  : { status: 'known', value, precision: 'reported', refs: [] };
const tick = n => String(BigInt(n) * 1000000n);
async function fixture(mutate = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'benchmark-turn-view-'));
  const events = [];
  const event = (type, time, turn_id, data = {}) => events.push({ type, turn_id,
    request_id: data.request_id ?? null, sequence: events.length + 1, monotonic_ns: tick(time), data });
  event('runtime_start', 0, null, { started_monotonic_ns: tick(0) });
  event('user_turn_start', 10, 'turn-1');
  event('model_request_start', 11, 'turn-1', { request_id: 'request-1', capture_only: false });
  event('user_turn_end', 30, 'turn-1');
  event('user_turn_start', 40, 'turn-2');
  event('model_request_start', 41, 'turn-2', { request_id: 'request-2', capture_only: false });
  event('user_turn_end', 60, 'turn-2');
  const attempts = [100, 150, 80].map((input, i) => ({ id: 'attempt-' + (i + 1), request_id: i < 2 ? 'request-1' : 'request-2',
    sent: true, seq: i, full_input: fact(input), full_output: fact(10),
    usage: { cache_read: fact(i === 0 ? null : 50), cache_write: fact(null) } }));
  const content = '{"answer":42}\n', sha256 = createHash('sha256').update(content).digest('hex');
  const grade = { contracts: [{ id: 'business-output', kind: 'artifact-json', critical: true, status: 'pass', evidence_ids: ['final-a'] },
    { id: 'resource', kind: 'resources', critical: true, status: 'pass', evidence_ids: [] }],
    readback_refs: [{ kind: 'artifact', evidence_id: 'final-a', path: 'output/first.json', sha256 }] };
  const readback = { evidence: { artifacts: [
    { evidence_id: 'initial-a', turn_id: 'turn-1', path: 'output/first.json', sha256, content },
    { evidence_id: 'final-a', turn_id: 'turn-2', path: 'output/first.json', sha256, content },
  ], resource_reads: [{ turn_id: 'turn-1', skill_id: 'skill-a', path: 'SKILL.md', sha256: 'b'.repeat(64), kind: 'native' }] } };
  const runtime = { timing: { started_monotonic_ns: tick(0), ended_monotonic_ns: tick(65) },
    turns: [{ id: 'turn-1', prompt: 'Write the result to output/first.json.', workspace_manifest_ref: { artifact_id: 'turn-1-workspace' } },
      { id: 'turn-2', prompt: 'Calculate the second result.', workspace_manifest_ref: { artifact_id: 'turn-2-workspace' } }],
    requests: [{ id: 'request-1', turn_id: 'turn-1' }, { id: 'request-2', turn_id: 'turn-2' }],
    notion: { coverage: { sdk: 'complete', owned_http: 'complete' }, operations: [
      { source_request_id: 'sdk:1:start', turn_id: null, stage: 'prepare', operation: 'list', status: 'completed', metrics_complete: true, http_attempts: 3 },
    ] } };
  const episode = { identity: { episode_id: 'episode' }, episode_sha256: 'c'.repeat(64),
    admission: { completeness: { attempts: 'complete', tools: 'complete', interventions: 'complete' } }, attempts,
    tools: [{ id: 'read', turn_id: 'turn-1', parent_id: null, execution: 'observed' },
      { id: 'write', turn_id: 'turn-2', parent_id: null, execution: 'observed' }], contracts: structuredClone(grade.contracts),
    timing: { duration_ms: fact(65) }, artifacts: [] };
  const workspaces = { 'turn-1-workspace': { files: [{ path: 'output/first.json', sha256 }] },
    'turn-2-workspace': { files: [{ path: 'output/first.json', sha256 }] } };
  mutate({ events, episode, grade, readback, runtime, workspaces });
  for (const [id, value] of Object.entries({ events, 'collection-runtime-result': runtime, 'collection-grade': grade, 'collection-readback': readback, ...workspaces })) {
    const bytes = id === 'events' ? value.map(JSON.stringify).join('\n') + '\n' : JSON.stringify(value);
    const path = join(root, id + (id === 'events' ? '.jsonl' : '.json'));
    await writeFile(path, bytes);
    episode.artifacts.push({ id, path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes) });
  }
  return { root, episode, read: () => readEpisodeTurns(episode, { root }) };
}

test('turn projection includes retries and startup in elapsed prefixes without regrading an episode contract', async () => {
  const f = await fixture(), original = JSON.stringify(f.episode), view = await f.read();
  assert.equal(view.status, 'available');
  assert.deepEqual(view.rows.map(row => row.marginal.input_tokens.value), [250, 80]);
  assert.deepEqual(view.rows.map(row => row.cumulative.input_tokens.value), [250, 330]);
  assert.deepEqual(view.rows.map(row => row.marginal.provider_attempts.value), [2, 1]);
  assert.deepEqual(view.rows.map(row => row.marginal.model_requests_started), [1, 1]);
  assert.deepEqual(view.rows.map(row => row.timing.user_turn_duration_ms.value), [20, 20]);
  assert.deepEqual(view.rows.map(row => row.timing.elapsed_from_episode_start_ms.value), [30, 60]);
  assert.equal(view.startup_ms.value, 10); assert.equal(view.postlude_ms.value, 5);
  assert.equal(view.rows[0].business_artifacts[0].status, 'pass');
  assert.equal(view.rows[1].business_artifacts.length, 0);
  assert.equal(view.rows[0].resource_reads.length, 1);
  assert.match(view.quality_scope, /resource and selection contracts remain episode-scoped/);
  assert.equal(view.source_operations.rows[0].start_context_turn_id, null);
  assert.equal(view.source_operations.rows[0].http_attempts.value, 3);
  assert.equal(view.rows[0].marginal.cache_read_tokens.status, 'unknown');
  assert.equal(view.rows[0].marginal.cache_read_tokens.known_subtotal, 50);
  assert.equal(view.rows[0].marginal.uncached_input_tokens.status, 'unknown');
  assert.equal(view.rows[1].marginal.uncached_input_tokens.value, 30);
  assert.equal(JSON.stringify(f.episode), original);
});

test('missing attempt usage stays unknown in every later cumulative prefix', async () => {
  const f = await fixture(({ episode }) => { episode.attempts[0].full_input = fact(null); });
  const view = await f.read();
  assert.equal(view.rows[0].marginal.input_tokens.status, 'unknown');
  assert.equal(view.rows[0].marginal.input_tokens.known_subtotal, 150);
  assert.equal(view.rows[1].cumulative.input_tokens.status, 'unknown');
  assert.equal(view.rows[1].cumulative.input_tokens.known_subtotal, 230);
});

test('unknown send and partial exact token components are retained without treating them as complete usage', async () => {
  const f = await fixture(({ episode }) => {
    episode.attempts[0].sent = null;
    episode.attempts[1].full_input = fact(null); episode.attempts[1].known_input_subtotal = 110;
  });
  const view = await f.read();
  assert.equal(view.first_input_tokens.status, 'unknown');
  assert.equal(view.rows[0].marginal.provider_attempts.status, 'unknown');
  assert.equal(view.rows[0].marginal.input_tokens.status, 'unknown');
  assert.equal(view.rows[1].cumulative.input_tokens.known_subtotal, 190);
});

test('unattributed attempts are retained and prevent a complete cumulative claim', async () => {
  const f = await fixture(({ episode }) => { episode.attempts[0].request_id = 'missing-request'; });
  const view = await f.read();
  assert.equal(view.status, 'partial');
  assert.deepEqual(view.unattributed.attempt_ids, ['attempt-1']);
  assert.equal(view.unattributed.usage.input_tokens.value, 100);
  assert.equal(view.rows[0].marginal.input_tokens.status, 'unknown');
  assert.equal(view.rows[0].marginal.input_tokens.known_subtotal, 150);
  assert.equal(view.rows[1].cumulative.input_tokens.status, 'unknown');
});

test('an open final turn keeps observed subtotals without a completed prefix', async () => {
  const f = await fixture(({ events }) => { events.pop(); });
  const view = await f.read();
  assert.equal(view.status, 'partial'); assert.equal(view.rows[1].completed, false);
  assert.equal(view.rows[1].marginal.input_tokens.status, 'unknown');
  assert.equal(view.rows[1].timing.elapsed_from_episode_start_ms.status, 'unknown');
});

test('duplicate and inconsistent turn or request identities are refused', async () => {
  for (const mutate of [
    ({ events }) => { events.push(structuredClone(events[1])); },
    ({ events }) => { events.push(structuredClone(events[2])); },
    ({ events }) => { events[2].turn_id = 'turn-2'; },
    ({ runtime }) => { runtime.requests[0].turn_id = 'turn-2'; },
    ({ events }) => { events[3].monotonic_ns = tick(5); },
  ]) {
    const f = await fixture(mutate); await assert.rejects(f.read, /duplicate|outside|differs|reversed/);
  }
});

test('later passing output cannot prove the earlier turn when bytes changed or the prompt binding is ambiguous', async () => {
  const changed = await fixture(({ readback }) => { readback.evidence.artifacts[0].sha256 = 'd'.repeat(64); });
  assert.equal((await changed.read()).rows[0].business_artifacts[0].status, 'unknown');
  const ambiguous = await fixture(({ runtime }) => { runtime.turns[1].prompt += ' Read output/first.json.'; });
  assert.equal((await ambiguous.read()).rows[0].business_artifacts.length, 0);
  const workspaceChanged = await fixture(({ workspaces }) => { workspaces['turn-1-workspace'].files[0].sha256 = 'd'.repeat(64); });
  assert.equal((await workspaceChanged.read()).rows[0].business_artifacts[0].status, 'unknown');
  const contentChanged = await fixture(({ readback }) => { readback.evidence.artifacts[0].content = 'changed'; });
  assert.equal((await contentChanged.read()).rows[0].business_artifacts[0].status, 'unknown');
});

test('missing source and changed original bytes cannot fabricate a turn view', async () => {
  const missing = await fixture(); missing.episode.artifacts = missing.episode.artifacts.filter(row => row.id !== 'events');
  assert.equal((await missing.read()).status, 'unavailable');
  const changed = await fixture();
  const path = changed.episode.artifacts.find(row => row.id === 'events').path;
  await writeFile(path, (await readFile(path, 'utf8')) + '\n');
  await assert.rejects(changed.read, /hash or size mismatch/);
});
