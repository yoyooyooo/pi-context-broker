import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateDifferences, normalizeCandidate } from './episode-evidence.mjs';
import { createEpisodeBudget, EpisodeStop, guardedFetch, providerUsage } from './episode-policy.mjs';
import { brokerDiagnosticsProjection, catalogCandidateReferences, finishEpisodeRequest, requestContract, reserveEpisodeRequest } from './episode-runner.mjs';

const limits = { wallTimeMs: 60000, maxModelRequests: 3, maxToolCalls: 4, maxHttpAttempts: 3, maxInputTokens: 300000, maxOutputTokens: 16000, maxTotalTokens: 316000 };
const usage = (input, output) => providerUsage('openai-completions', { usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } });

test('reported-model mismatch accounts the complete response before blocking the next SDK request', () => {
  const budget = createEpisodeBudget(limits), routing = { mode: 'auto-route', model_variant: 'grok-4.7', reported_model_ids: ['grok/grok-4.7'] };
  budget.request(); budget.attempt();
  let currentRequest = { id: 'r1', accounted: false, usage: usage(100, 30), assistant: { stop_reason: 'toolUse' },
    attempts: [{ id: 'a1', response_ref: { artifact_id: 'events', line: 1 }, reported_model_observations: [
      { value: 'grok/grok-4.6', field: '/data/event/model', ref: { artifact_id: 'events', line: 2 } }] }] }, stop;
  const request = currentRequest, recorded = [];
  const args = { request, budget, routing, record: (type, value) => recorded.push({ type, value: structuredClone(value) }), onStop: error => { stop ??= error; } };
  finishEpisodeRequest(args); finishEpisodeRequest(args);
  assert.deepEqual([budget.state.input_tokens, budget.state.output_tokens, budget.state.tokens], [100, 30, 130]);
  assert.equal(recorded[0].type, 'request_usage_accounted'); assert.equal(recorded[0].value.budget.tokens, 130);
  assert.equal(stop.code, 'BENCHMARK_REPORTED_MODEL_MISMATCH');
  assert.throws(() => reserveEpisodeRequest({ budget, captureOnly: false, priorStop: stop,
    clearRequest: () => { currentRequest = undefined; }, onStop() {} }), { code: 'BENCHMARK_REPORTED_MODEL_MISMATCH' });
  assert.equal(currentRequest, undefined); assert.equal(request.assistant.stop_reason, 'toolUse');
  assert.equal(budget.state.requests, 1); assert.equal(budget.state.attempts, 1);
});

test('reported-model missing is separate from a network failure and never requires a pre-send label', () => {
  const routing = { mode: 'fixed-route', model_variant: 'gpt-6.2-sol', reported_model_ids: ['imile-win-gpt/gpt-6.2-sol'] };
  for (const [attempt, expected] of [[{ response_ref: { artifact_id: 'events', line: 1 }, status: 200 }, 'BENCHMARK_REPORTED_MODEL_MISSING'],
    [{ error_ref: { artifact_id: 'events', line: 2 } }, 'BENCHMARK_REPORTED_MODEL_UNAVAILABLE_AFTER_PROVIDER_ERROR']]) {
    const budget = createEpisodeBudget(limits); let stop;
    finishEpisodeRequest({ request: { id: 'r', attempts: [{ id: 'a', ...attempt }], usage: usage(5, 7) }, budget, routing,
      record() {}, onStop: error => { stop = error; } });
    assert.equal(stop.code, expected); assert.equal(budget.state.tokens, 12);
  }
  const budget = createEpisodeBudget(limits);
  finishEpisodeRequest({ request: { id: 'capture', attempts: [] }, budget, routing, captureOnly: true,
    record() { assert.fail('capture has no completed model response'); }, onStop() { assert.fail('capture needs no server label'); } });
  assert.equal(budget.state.tokens, 0);
});

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

test('SDK error normalization cannot erase a local cap or overwrite the last sent request', async () => {
  const budget = createEpisodeBudget({ ...limits, maxModelRequests: 2 });
  const requests = [], sdkErrors = [];
  let currentRequest, terminalError, boundRequest, sends = 0;
  async function sdkRound() {
    try {
      const sequence = reserveEpisodeRequest({ budget, captureOnly: false,
        clearRequest: () => { currentRequest = undefined; boundRequest = null; },
        onStop: error => { terminalError ??= error; } });
      currentRequest = { id: 'request-' + sequence, assistant: null }; requests.push(currentRequest); boundRequest = currentRequest.id;
      budget.attempt(); sends++; budget.usage(usage(100, 10));
      currentRequest.assistant = { stop_reason: 'toolUse', error: null };
    } catch (error) {
      // The SDK reports a rejected stream call as an assistant message_end.
      const normalized = { stop_reason: 'error', error: error.message }; sdkErrors.push(normalized);
      if (currentRequest) currentRequest.assistant = normalized;
    }
  }
  await sdkRound(); await sdkRound(); const last = structuredClone(requests[1]); await sdkRound();
  assert.equal(sends, 2); assert.equal(requests.length, 2); assert.deepEqual(requests[1], last);
  assert.equal(currentRequest, undefined); assert.equal(boundRequest, null);
  assert.ok(terminalError instanceof EpisodeStop); assert.equal(terminalError.code, 'BENCHMARK_REQUEST_LIMIT');
  assert.equal(sdkErrors[0].error, 'BENCHMARK_REQUEST_LIMIT');
  assert.deepEqual([budget.state.input_tokens, budget.state.output_tokens, budget.state.usage_unknown], [200, 20, false]);
  assert.throws(() => budget.available(), { code: 'BENCHMARK_REQUEST_LIMIT' });
});

test('provider text does not manufacture a local guard; missing usage remains its own stop', () => {
  const budget = createEpisodeBudget(limits); let localStop, currentRequest = 'old-request';
  const sequence = reserveEpisodeRequest({ budget, captureOnly: false,
    clearRequest: () => { currentRequest = undefined; }, onStop: error => { localStop = error; } });
  const providerError = new Error('BENCHMARK_REQUEST_LIMIT');
  assert.equal(sequence, 1); assert.equal(providerError.message, 'BENCHMARK_REQUEST_LIMIT');
  assert.equal(localStop, undefined); assert.equal(budget.state.stop, null); assert.equal(currentRequest, undefined);
  budget.usage(null);
  assert.throws(() => reserveEpisodeRequest({ budget, captureOnly: false, clearRequest() {}, onStop: error => { localStop = error; } }),
    { code: 'BENCHMARK_USAGE_UNKNOWN' });
  assert.equal(localStop.code, 'BENCHMARK_USAGE_UNKNOWN'); assert.equal(budget.state.requests, 1);
});

test('capture reservation clears identity without consuming a paid request', () => {
  const budget = createEpisodeBudget(limits); let cleared = false, stopped = false;
  assert.equal(reserveEpisodeRequest({ budget, captureOnly: true,
    clearRequest: () => { cleared = true; }, onStop: () => { stopped = true; } }), 1);
  assert.equal(cleared, true); assert.equal(stopped, false); assert.equal(budget.state.requests, 0); assert.equal(budget.state.attempts, 0);
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

function candidateFixture(byte = 1) {
  const ref = 'sr:C' + Buffer.alloc(16, byte).toString('base64url');
  const locator = { type: 'shared_skill', database_id: 'db', data_source_id: 'source', page_id: 'page', library_id: 'library', skill_id: 'skill' };
  const identity = { source: 'notion', scope: 'a'.repeat(64), id: 'shared_skill:library:skill', kind: 'skill', locator,
    ref: 'skill://shared_skill%3Alibrary%3Askill' };
  const record = { id: identity.id, kind: identity.kind, locator, name: 'same-name', description: 'Original catalog body',
    entrypoint: 'SKILL.md', ref: identity.ref + '/SKILL.md', enabled: true };
  const shortRefs = { bindings: new Map([[ref, { kind: 'candidate', identity }]]) };
  const catalogs = { observed: true, catalogs: [{ facets: [{ facet: 'catalog', ok: true, value: { scope: identity.scope, records: [record] } }] }] };
  return { ref, identity, record, shortRefs, catalogs };
}

const catalogText = (ref, body = 'Original catalog body') => '<ntn-skills-view-catalog>\n<catalog-cards>\n<group kind="skill" source="notion">\n'
  + '<card name="same-name" location="' + ref + '">' + body + '</card>\n</group>\n</catalog-cards>\n</ntn-skills-view-catalog>';
function catalogPayload(ref, api, prompt = 'task') {
  const key = api === 'openai-responses' ? 'input' : 'messages', type = api === 'openai-responses' ? 'input_text' : 'text';
  return { model: 'declared-model', [key]: [{ role: 'system', content: 'Exact stable guidance' },
    { role: 'user', content: [{ type, text: catalogText(ref) }] }, { role: 'user', content: prompt }],
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }], max_tokens: 4096 };
}

test('request catalog locations canonicalize only observed current-branch candidates without changing raw payloads', () => {
  const first = candidateFixture(1), second = candidateFixture(2);
  for (const api of ['openai-completions', 'openai-responses']) {
    const a = catalogPayload(first.ref, api, 'probe'), b = catalogPayload(second.ref, api), before = JSON.stringify(b);
    const expected = requestContract(a, api, 'probe', {}, catalogCandidateReferences(first));
    const observed = requestContract(b, api, 'task', {}, catalogCandidateReferences(second));
    assert.deepEqual(expected, observed);
    assert.equal(JSON.stringify(b), before, 'Canonical comparison must not edit the actual serializer payload');
    assert.ok(JSON.stringify(observed).includes('benchmark-candidate:'));
    assert.ok(!JSON.stringify(observed).includes(first.ref)); assert.ok(!JSON.stringify(observed).includes(second.ref));
  }
});

test('an unobserved, mismatched or out-of-catalog short handle cannot be normalized into admission', () => {
  const f = candidateFixture(), refs = catalogCandidateReferences(f), api = 'openai-completions';
  assert.throws(() => requestContract(catalogPayload(candidateFixture(3).ref, api), api, 'task', {}, refs), /REFERENCE_UNOBSERVED/);
  const misplaced = catalogPayload(f.ref, api); misplaced.messages[0].content += ' ' + f.ref;
  assert.throws(() => requestContract(misplaced, api, 'task', {}, refs), /REFERENCE_OUTSIDE_LOCATION/);
  const wrongIdentity = candidateFixture(); wrongIdentity.shortRefs.bindings.get(wrongIdentity.ref).identity = { ...wrongIdentity.identity, id: 'another-owner' };
  assert.throws(() => catalogCandidateReferences(wrongIdentity), /IDENTITY_MISMATCH/);
  const wrongScope = candidateFixture(); wrongScope.catalogs.catalogs[0].facets[0].value.scope = 'b'.repeat(64);
  assert.throws(() => catalogCandidateReferences(wrongScope), /IDENTITY_MISMATCH/);
});

test('same-name owner changes and changed catalog bodies remain contract differences', () => {
  const f = candidateFixture(), api = 'openai-completions', refs = catalogCandidateReferences(f);
  const expected = requestContract(catalogPayload(f.ref, api), api, 'task', {}, refs);
  const other = candidateFixture(2);
  other.identity.id = other.record.id = 'shared_skill:library:other';
  other.identity.locator.skill_id = 'other'; other.identity.ref = 'skill://shared_skill%3Alibrary%3Aother'; other.record.ref = other.identity.ref + '/SKILL.md';
  assert.ok(candidateDifferences(expected, requestContract(catalogPayload(other.ref, api), api, 'task', {}, catalogCandidateReferences(other))).length);
  const changedCatalog = candidateFixture(); changedCatalog.record.description = 'Changed independently observed body';
  assert.ok(candidateDifferences(expected, requestContract(catalogPayload(changedCatalog.ref, api), api, 'task', {}, catalogCandidateReferences(changedCatalog))).length);
  for (const change of [
    payload => { payload.messages[1].content[0].text = catalogText(f.ref, 'Changed visible body'); },
    payload => { payload.messages[0].content = 'Changed instructions'; },
    payload => { payload.tools[0].function.parameters.type = 'string'; },
    payload => { payload.model = 'changed-model'; },
    payload => { payload.max_tokens = 8192; },
  ]) {
    const payload = catalogPayload(f.ref, api); change(payload);
    assert.ok(candidateDifferences(expected, requestContract(payload, api, 'task', {}, refs)).length);
  }
});
