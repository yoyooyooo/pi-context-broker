import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completedEpisodeRecord } from './controller.mjs';

const successfulRaw = () => ({ status: 'completed', root: '/owned/run',
  shared: { runtime_check: { status: 'unchanged' }, frozen_artifacts: 'passed' },
  turn_control_verification: { status: 'absent', required: false }, stop_batch: false });
const collected = () => ({ stored: { directory: '/owned/normalized' }, bundle: { episode: { episode_sha256: 'a'.repeat(64) } },
  budget_usage: { requests: 4, input_tokens: 23621, output_tokens: 769 }, stop_batch: false, stop_reason: null });

test('a lost launcher acknowledgement retains complete evidence and costs while stopping the batch', () => {
  const raw = { ...successfulRaw(), stop_batch: true, dispatch_error: { name: 'Error', message: 'owned launcher acknowledgement lost' } };
  const facts = collected(), result = completedEpisodeRecord(raw, facts);
  assert.equal(result.status, 'completed');
  assert.equal(result.stop_batch, true);
  assert.equal(result.stop_reason, 'subject_dispatch_error');
  assert.deepEqual(result.budget_usage, facts.budget_usage);
  assert.equal(result.episode_sha256, facts.bundle.episode.episode_sha256);
});

test('missing, unknown and stopped turn control cannot be hidden by a completed child', () => {
  const reference = { path: '/owned/control/result.json', sha256: 'b'.repeat(64) };
  for (const verification of [
    { required: true, status: 'unavailable', result: null, receipt: null, reason: 'missing' },
    { required: true, status: 'verified', result: { status: 'stopped', reason: 'UNKNOWN_WRITE' }, receipt: reference },
  ]) {
    const facts = collected(), result = completedEpisodeRecord({ ...successfulRaw(), turn_control_verification: verification }, facts);
    assert.equal(result.stop_batch, true);
    assert.equal(result.stop_reason, 'turn_control_unverified_or_stopped');
    assert.deepEqual(result.budget_usage, facts.budget_usage);
    assert.deepEqual(result.turn_control.receipt, verification.receipt);
  }
  const retainedStop = completedEpisodeRecord({ ...successfulRaw(), turn_control: { status: 'stopped', reason: 'RETENTION_FAILED' },
    turn_control_verification: { required: true, status: 'verified', result: { status: 'completed' }, receipt: reference } }, collected());
  assert.equal(retainedStop.stop_batch, true);
  assert.equal(retainedStop.stop_reason, 'RETENTION_FAILED');
});

test('verified completion and legacy single-turn results preserve collector stop decisions', () => {
  assert.equal(completedEpisodeRecord(successfulRaw(), collected()).stop_batch, false);
  const completed = { ...successfulRaw(), turn_control_verification: { required: true, status: 'verified', result: { status: 'completed' }, receipt: { path: '/owned/result', sha256: 'c'.repeat(64) } } };
  assert.equal(completedEpisodeRecord(completed, collected()).stop_batch, false);
  assert.equal(completedEpisodeRecord(completed, { ...collected(), stop_batch: true, stop_reason: 'usage_unknown' }).stop_reason, 'usage_unknown');
  assert.equal(completedEpisodeRecord({ ...completed, shared: { runtime_check: { status: 'drifted' }, frozen_artifacts: 'passed' } }, collected()).stop_batch, true);
});

function requestLimitFixture() {
  const known = value => ({ status: 'known', value });
  const episodeBudget = { max_model_requests: 2, max_http_attempts: 2, max_retries: 0,
    max_input_tokens: 1000, max_output_tokens: 100, max_duration_ms: 60000 };
  const completeness = { attempts: 'complete', tools: 'complete', interventions: 'complete' };
  const requests = [0, 1].map(index => {
    const id = 'request-' + (index + 1), input = 40 + 20 * index, output = 3 + 4 * index;
    return { id, sequence: index + 1, accounted: true,
      usage: { complete_for_token_budget: true, input, output, total: input + output },
      attempts: [{ id: id + '/attempt', request_id: id, transport_id: index + 1, sent: true, status: 200,
        transport_end: { category: 'model', status: 200, requestSent: true, outcome: 'failure',
          errorName: 'AbortError', errorCode: 20, modelApi: 'openai-completions', contentEncoding: 'identity',
          contentType: 'text/event-stream', sseCompletion: { method: 'bounded-sse-data-done-v1', doneEvents: 1 } } }] };
  });
  const usage = { model_requests: 2, input_tokens: 100, output_tokens: 10, duration_ms: 123.4 };
  const raw = { ...successfulRaw(), status: 'failed', stop_batch: true,
    shared: { ...successfulRaw().shared, spawned: true, exit_code: 1, signal: null, timed_out: false },
    episode: { status: 'failed', admission: { status: 'accepted_before_task' }, requests,
      error: { code: 'BENCHMARK_PROVIDER_TERMINAL_ERROR', details: { assistant: { stop_reason: 'error', error: 'BENCHMARK_REQUEST_LIMIT' } } },
      budget: { requests: 2, attempts: 2, input_tokens: 100, output_tokens: 10, tokens: 110,
        usage_unknown: false, stop: { code: 'BENCHMARK_REQUEST_LIMIT', details: {} } },
      timing: { duration_ms: 123.4 }, coverage: { ...completeness },
      completion: { agent_settled: true, cleanup: { abort_settled: true, shutdown_emitted: true, dispose_called: true } } } };
  const facts = { ...collected(), validity: 'valid', budget_usage: usage,
    bundle: { episode: { episode_sha256: 'a'.repeat(64), admission: { status: 'valid', completeness },
      result: { outcome: 'fail', verified_success: false }, selection: { status: 'unknown' },
      timing: { duration_ms: known(123.4) },
      measurements: { actual_attempts: known(2), input_total: { value: known(100) }, output_total: { value: known(10) } },
      attempts: requests.map(request => ({ id: request.attempts[0].id, request_id: request.id,
        transport_id: request.attempts[0].transport_id, sent: true, adapter: { verified: true },
        full_input: known(request.usage.input), full_output: known(request.usage.output) })) } } };
  return { raw, facts, episodeBudget };
}

test('a frozen local request cap remains a failed episode with unchanged metering and unknown selection', () => {
  const { raw, facts, episodeBudget } = requestLimitFixture(), before = structuredClone({ raw, facts });
  const result = completedEpisodeRecord(raw, facts, { episodeBudget });
  assert.equal(result.stop_batch, false); assert.equal(result.stop_reason, null); assert.equal(result.status, 'failed');
  assert.deepEqual(result.budget_usage, facts.budget_usage); assert.equal(result.episode_sha256, facts.bundle.episode.episode_sha256);
  assert.deepEqual({ raw, facts }, before);
  assert.equal(facts.bundle.episode.result.outcome, 'fail'); assert.equal(facts.bundle.episode.selection.status, 'unknown');
  assert.equal(completedEpisodeRecord(raw, facts).stop_batch, true, 'No frozen limit means no exemption');
});

test('provider text, incomplete evidence and other controller stops cannot become local budget completion', async t => {
  const cases = [
    ['provider-spoofed limit text', f => { f.raw.episode.budget.stop = null; }],
    ['authentication error', f => { f.raw.episode.error.details.assistant.error = '401 expired key'; }],
    ['another local limit', f => { f.raw.episode.budget.stop.code = 'BENCHMARK_WALL_LIMIT'; }],
    ['not at frozen request cap', f => { f.episodeBudget.max_model_requests = 3; }],
    ['extra actual send', f => { f.raw.episode.requests.push(structuredClone(f.raw.episode.requests[1])); }],
    ['unknown normalized usage', f => { f.facts.bundle.episode.measurements.input_total.value = { status: 'unknown' }; }],
    ['unknown budget usage', f => { f.facts.budget_usage.input_tokens = null; }],
    ['unknown runtime usage', f => { f.raw.episode.budget.usage_unknown = true; }],
    ['raw usage differs', f => { f.raw.episode.requests[1].usage.input++; }],
    ['raw request not sent', f => { f.raw.episode.requests[1].attempts[0].sent = false; }],
    ['normalized request not sent', f => { f.facts.bundle.episode.attempts[1].sent = null; }],
    ['usage adapter unverified', f => { f.facts.bundle.episode.attempts[1].adapter.verified = false; }],
    ['missing SSE DONE', f => { f.raw.episode.requests[1].attempts[0].transport_end.sseCompletion.doneEvents = 0; }],
    ['other HTTP failure', f => { f.raw.episode.requests[1].attempts[0].transport_end.errorCode = 21; }],
    ['HTTP authentication status', f => { f.raw.episode.requests[1].attempts[0].transport_end.status = 401; }],
    ['frozen token budget exceeded', f => { f.episodeBudget.max_input_tokens = 99; }],
    ['runtime cleanup incomplete', f => { f.raw.episode.completion.cleanup.abort_settled = false; }],
    ['timed out launcher', f => { f.raw.shared.timed_out = true; }],
    ['core evidence incomplete', f => { f.facts.bundle.episode.admission.completeness.attempts = 'partial'; }],
    ['invalid collection', f => { f.facts.validity = 'invalid'; }],
    ['collector stop', f => { f.facts.stop_batch = true; f.facts.stop_reason = 'unknown_actual_usage'; }],
    ['dispatch acknowledgement error', f => { f.raw.dispatch_error = { message: 'lost acknowledgement' }; }],
    ['runtime drift', f => { f.raw.shared.runtime_check.status = 'drifted'; }],
    ['frozen artifact drift', f => { f.raw.shared.frozen_artifacts = 'failed'; }],
    ['unverified turn control', f => { f.raw.turn_control_verification = { required: true, status: 'unavailable' }; }],
    ['stopped turn control', f => { f.raw.turn_control = { status: 'stopped', reason: 'UNKNOWN_WRITE' }; }],
  ];
  for (const [name, change] of cases) await t.test(name, () => {
    const fixture = requestLimitFixture(); change(fixture);
    const before = structuredClone({ raw: fixture.raw, facts: fixture.facts });
    assert.equal(completedEpisodeRecord(fixture.raw, fixture.facts, { episodeBudget: fixture.episodeBudget }).stop_batch, true);
    assert.deepEqual({ raw: fixture.raw, facts: fixture.facts }, before);
  });
});
