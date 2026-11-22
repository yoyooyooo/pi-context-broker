import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateDifferences, normalizeCandidate } from './episode-evidence.mjs';
import { createEpisodeBudget, guardedFetch, providerUsage } from './episode-policy.mjs';
import { brokerDiagnosticsProjection, requestContract } from './episode-runner.mjs';

const limits = { wallTimeMs: 60000, maxModelRequests: 3, maxToolCalls: 4, maxHttpAttempts: 3, maxInputTokens: 300000, maxOutputTokens: 16000, maxTotalTokens: 316000 };
const usage = (input, output) => providerUsage('openai-completions', { usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } });

test('raw usage retains missing fields and does not borrow normalized Pi zeros', () => {
  assert.equal(providerUsage('openai-completions', {}), null);
  const result = usage(100, 30);
  assert.equal(result.cache_read, null); assert.equal(result.cache_write, null); assert.equal(result.reasoning, null);
  assert.equal(result.input, 100); assert.equal(result.total, 130);
  assert.equal(result.input_semantics, 'includes_cache'); assert.equal(result.output_semantics, 'includes_reasoning');
  assert.equal(providerUsage('openai-responses', { response: { usage: { input_tokens: 100, output_tokens: 30, total_tokens: 131 } } }).complete_for_token_budget, false);
  assert.equal(providerUsage('openai-completions', { usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: -1 } }).complete_for_token_budget, false);
});

test('cache and reasoning fields remain subsets of the reported total', () => {
  const result = providerUsage('openai-responses', { response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 130 } } });
  assert.deepEqual([result.input, result.output, result.cache_read, result.cache_write, result.reasoning, result.total], [100, 30, 20, 10, 5, 130]);
  assert.equal(result.complete_for_token_budget, true);
});

test('an unreported first usage prevents the next request', () => {
  const budget = createEpisodeBudget(limits); budget.request(); budget.usage(null);
  assert.throws(() => budget.request(), { code: 'BENCHMARK_USAGE_UNKNOWN' });
  assert.equal(budget.state.requests, 1); assert.equal(budget.state.tokens, 0); assert.equal(budget.state.usage_unknown, true);
});

test('input and output are cumulative episode budgets and output cap shrinks', () => {
  const budget = createEpisodeBudget({ ...limits, maxInputTokens: 100, maxOutputTokens: 100 });
  budget.usage(usage(60, 80)); assert.equal(budget.outputCap(50), 20);
  budget.usage(usage(50, 10));
  assert.throws(() => budget.request(), { code: 'BENCHMARK_INPUT_LIMIT' });
  assert.deepEqual([budget.state.input_tokens, budget.state.output_tokens, budget.state.tokens], [110, 90, 200]);
});

test('payload guard checks remaining output and labels its input heuristic', () => {
  const budget = createEpisodeBudget(limits); budget.usage(usage(100, 15000));
  assert.throws(() => budget.payload('openai-completions', { max_tokens: 1001, messages: [] }), { code: 'BENCHMARK_OUTPUT_CAP_UNENFORCED' });
  const other = createEpisodeBudget(limits);
  const estimate = other.payload('openai-responses', { max_output_tokens: 1000, input: [] });
  assert.equal(estimate.precision, 'conservative_heuristic_not_tokenizer_or_proven_upper_bound');
});

test('fetch guard rejects before actual transport and numbers individual attempts', async () => {
  const budget = createEpisodeBudget({ ...limits, maxHttpAttempts: 1 }), request = { id: 'r1', attempts: [] }, events = [];
  let calls = 0, admitted = false;
  const send = guardedFetch({ request, model: { baseUrl: 'https://example.test/v1' }, budget, admitted: () => admitted, record: (type, data) => { events.push({ type, data }); return { artifact_id: 'events', line: events.length }; }, fetch: async () => { calls++; return new Response('ok', { headers: { 'x-request-id': 'receipt-1' } }); } });
  await assert.rejects(send('https://example.test/v1/responses'), { code: 'BENCHMARK_NOT_ADMITTED' });
  admitted = true;
  await assert.rejects(send('https://other.test/v1/responses'), { code: 'BENCHMARK_PROVIDER_ENDPOINT_DRIFT' });
  const response = await send('https://example.test/v1/responses', { method: 'POST' }); assert.equal(await response.text(), 'ok');
  await assert.rejects(send('https://example.test/v1/responses'), { code: 'BENCHMARK_UNDECLARED_PROVIDER_RETRY' });
  const second = guardedFetch({ request: { id: 'r2', attempts: [] }, model: { baseUrl: 'https://example.test/v1' }, budget, admitted: () => admitted, record: () => ({}), fetch: async () => { calls++; return new Response('unexpected'); } });
  await assert.rejects(second('https://example.test/v1/responses'), { code: 'BENCHMARK_HTTP_ATTEMPT_LIMIT' });
  assert.equal(calls, 1); assert.equal(request.attempts.length, 1); assert.equal(request.attempts[0].sent, null);
  assert.equal(events[1].data.response_identifiers['x-request-id'], 'receipt-1');
});

test('path normalization preserves schema, guidance and array order', () => {
  const a = normalizeCandidate({ path: '/run-a/file', tools: [{ name: 'read', schema: { type: 'object' } }] }, { RUN: '/run-a' });
  const b = normalizeCandidate({ path: '/run-b/file', tools: [{ name: 'read', schema: { type: 'string' } }] }, { RUN: '/run-b' });
  assert.equal(a.path, b.path); assert.equal(candidateDifferences(a, b)[0].path, '/tools');
});

test('Broker human path abbreviation cannot create a false cross-run difference', () => {
  const diagnostic = suffix => [{ type: 'info', message: 'context-broker roots: 1/1 exists, 16 raw skills\nok       16 custom               ~/Documents/code/pe...' + suffix + '/skills/selected' }];
  assert.deepEqual(brokerDiagnosticsProjection(diagnostic('-capture')), brokerDiagnosticsProjection(diagnostic('-execute')));
  assert.equal(brokerDiagnosticsProjection(diagnostic('-capture'))[0].roots[0].skill_count, 16);
  assert.notDeepEqual(brokerDiagnosticsProjection(diagnostic('-capture')), brokerDiagnosticsProjection([{ type: 'info', message: 'context-broker roots: 1/1 exists, 15 raw skills\nok       15 custom               ~/Documents/code/pe...-execute/skills/selected' }]));
});

test('final request contract removes only the exact public user input', () => {
  const make = prompt => ({ model: 'm', max_tokens: 100, messages: [{ role: 'system', content: 'strict guidance' }, { role: 'user', content: prompt }, { role: 'user', content: 'Broker routing guidance' }], tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] });
  const a = requestContract(make('probe'), 'openai-completions', 'probe', {}), b = requestContract(make('natural question'), 'openai-completions', 'natural question', {});
  assert.deepEqual(a, b); assert.equal(a.messages.length, 2);
  const changed = make('natural question'); changed.messages[2].content = 'wrong guidance';
  assert.ok(candidateDifferences(a, requestContract(changed, 'openai-completions', 'natural question', {})).length);
  assert.throws(() => requestContract(make('probe'), 'openai-completions', 'missing prompt', {}), /NOT_UNIQUELY_LOCATED/);
});
