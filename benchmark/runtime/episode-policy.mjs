import assert from 'node:assert/strict';

export class EpisodeStop extends Error {
  constructor(code, details = {}) { super(code); this.name = 'EpisodeStop'; this.code = code; this.details = details; }
}

const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const field = (object, path) => path.reduce((value, key) => value?.[key], object);

/** Preserve absent fields. Pi's normalized all-zero usage is not evidence of usage. */
export function providerUsage(api, event) {
  let raw, pointer;
  if (api === 'openai-completions' && event?.usage) { raw = event.usage; pointer = '/usage'; }
  else if (api === 'openai-responses' && event?.response?.usage) { raw = event.response.usage; pointer = '/response/usage'; }
  else return null;
  const responses = api === 'openai-responses';
  const read = path => { const value = field(raw, path); return finite(value) ? value : null; };
  const input = read([responses ? 'input_tokens' : 'prompt_tokens']);
  const output = read([responses ? 'output_tokens' : 'completion_tokens']);
  const cacheRead = responses ? read(['input_tokens_details', 'cached_tokens'])
    : read(['prompt_tokens_details', 'cached_tokens']) ?? read(['prompt_cache_hit_tokens']) ?? read(['cached_tokens']);
  const cacheWrite = read([responses ? 'input_tokens_details' : 'prompt_tokens_details', 'cache_write_tokens']);
  const reasoning = read([responses ? 'output_tokens_details' : 'completion_tokens_details', 'reasoning_tokens']) ?? (!responses ? read(['reasoning_tokens']) : null);
  const reportedTotal = read(['total_tokens']);
  const invalidTotal = raw.total_tokens !== undefined && !finite(raw.total_tokens);
  return { raw, pointer, input, output, cache_read: cacheRead, cache_write: cacheWrite, reasoning, reported_total: reportedTotal,
    total: invalidTotal ? null : reportedTotal ?? (input !== null && output !== null ? input + output : null),
    input_semantics: 'includes_cache', output_semantics: 'includes_reasoning',
    total_method: reportedTotal !== null ? 'provider_total_tokens' : input !== null && output !== null ? 'reported_input_plus_output' : 'unavailable',
    complete_for_token_budget: !invalidTotal && input !== null && output !== null && (reportedTotal === null || reportedTotal === input + output),
  };
}

export function inputByteGuard(payload) {
  // This is an explicit conservative preflight, not a tokenizer result. The
  // actual provider input count is checked independently on receipt.
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  return { method: 'serialized-utf8-bytes-times-four-plus-4096', serialized_bytes: bytes, estimated_tokens: bytes * 4 + 4096, precision: 'conservative_heuristic_not_tokenizer_or_proven_upper_bound' };
}

export function outputTokenCap(api, payload) {
  if (api === 'openai-responses') return payload?.max_output_tokens;
  if (api === 'openai-completions') return payload?.max_completion_tokens ?? payload?.max_tokens;
  return undefined;
}

export function createEpisodeBudget(limits) {
  for (const key of ['wallTimeMs', 'maxModelRequests', 'maxToolCalls', 'maxHttpAttempts', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens']) {
    assert.ok(Number.isSafeInteger(limits?.[key]) && limits[key] > 0, 'BENCHMARK_LIMIT_REQUIRED: ' + key);
  }
  const started = performance.now();
  const state = { requests: 0, attempts: 0, tools: 0, input_tokens: 0, output_tokens: 0, tokens: 0, usage_unknown: false, stop: null };
  const reject = (code, details) => { state.stop ??= { code, details }; throw new EpisodeStop(code, details); };
  const available = () => {
    if (state.stop) throw new EpisodeStop(state.stop.code, state.stop.details);
    if (performance.now() - started >= limits.wallTimeMs) reject('BENCHMARK_WALL_LIMIT', {});
    if (state.usage_unknown) reject('BENCHMARK_USAGE_UNKNOWN', {});
  };
  return {
    state, limits, available, reject,
    request() { available(); if (state.requests >= limits.maxModelRequests) reject('BENCHMARK_REQUEST_LIMIT', {}); return ++state.requests; },
    payload(api, payload) {
      available(); const cap = outputTokenCap(api, payload), input = inputByteGuard(payload);
      const remainingInput = limits.maxInputTokens - state.input_tokens, remainingOutput = limits.maxOutputTokens - state.output_tokens;
      if (!Number.isSafeInteger(cap) || cap <= 0 || cap > remainingOutput) reject('BENCHMARK_OUTPUT_CAP_UNENFORCED', { observed: cap ?? null, remaining_output: remainingOutput });
      if (input.estimated_tokens > remainingInput) reject('BENCHMARK_INPUT_PREFLIGHT_LIMIT', { ...input, remaining_input: remainingInput });
      if (state.tokens + input.estimated_tokens + cap > limits.maxTotalTokens) reject('BENCHMARK_TOTAL_PREFLIGHT_LIMIT', { consumed: state.tokens, input, output_cap: cap });
      return input;
    },
    outputCap(requested) { available(); const remaining = limits.maxOutputTokens - state.output_tokens; if (remaining < 16) reject('BENCHMARK_OUTPUT_LIMIT', { remaining }); return Math.min(requested, remaining); },
    attempt() { available(); if (state.attempts >= limits.maxHttpAttempts) reject('BENCHMARK_HTTP_ATTEMPT_LIMIT', {}); return ++state.attempts; },
    tool() { available(); if (state.tools >= limits.maxToolCalls) reject('BENCHMARK_TOOL_LIMIT', {}); return ++state.tools; },
    usage(usage) {
      if (!usage?.complete_for_token_budget || !finite(usage.total)) { state.usage_unknown = true; return; }
      state.input_tokens += usage.input; state.output_tokens += usage.output;
      state.tokens += usage.total;
      if (state.input_tokens > limits.maxInputTokens) state.stop ??= { code: 'BENCHMARK_INPUT_LIMIT', details: { observed: state.input_tokens } };
      if (state.output_tokens > limits.maxOutputTokens) state.stop ??= { code: 'BENCHMARK_OUTPUT_LIMIT', details: { observed: state.output_tokens } };
      if (state.tokens > limits.maxTotalTokens) state.stop ??= { code: 'BENCHMARK_TOTAL_LIMIT', details: { observed: state.tokens } };
    },
  };
}

/** Injected through Pi's public StreamOptions.fetch; leaves the response unread. */
export function guardedFetch({ fetch: underlying = globalThis.fetch, request, model, budget, admitted, record }) {
  const base = new URL(model.baseUrl);
  return async (input, init) => {
    if (!admitted()) throw new EpisodeStop('BENCHMARK_NOT_ADMITTED');
    if (request.attempts.length > 0) {
      record('provider_retry_blocked', { request_id: request.id, prior_attempt_ids: request.attempts.map(attempt => attempt.id), declared_provider_retries: 0 }, { request_id: request.id });
      throw new EpisodeStop('BENCHMARK_UNDECLARED_PROVIDER_RETRY');
    }
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const prefix = base.pathname.replace(/\/$/, '');
    if (url.origin !== base.origin || !(url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) throw new EpisodeStop('BENCHMARK_PROVIDER_ENDPOINT_DRIFT');
    const attempt = { id: request.id + '/attempt-' + budget.attempt(), request_id: request.id, sequence: request.attempts.length + 1, sent: null };
    request.attempts.push(attempt); request.current_attempt_id = attempt.id;
    attempt.start_ref = record('http_attempt_start', { attempt_id: attempt.id, request_id: request.id, method: init?.method ?? input?.method ?? 'GET', url_origin: url.origin, url_path: url.pathname, redirects: 'error' }, { request_id: request.id });
    try {
      const response = await underlying(input, { ...init, redirect: 'error' });
      attempt.status = response.status;
      const identifiers = Object.fromEntries(['x-request-id', 'request-id', 'openai-processing-ms', 'cf-ray'].map(name => [name, response.headers.get(name)]).filter(([, value]) => value !== null));
      attempt.response_ref = record('http_response_headers', { attempt_id: attempt.id, status: response.status, content_type: response.headers.get('content-type'), content_encoding: response.headers.get('content-encoding'), response_identifiers: identifiers }, { request_id: request.id });
      return response;
    } catch (error) {
      attempt.error_ref = record('http_fetch_error', { attempt_id: attempt.id, name: error?.name ?? null, message: String(error?.message ?? error), code: error?.code ?? null }, { request_id: request.id });
      throw error;
    }
  };
}
