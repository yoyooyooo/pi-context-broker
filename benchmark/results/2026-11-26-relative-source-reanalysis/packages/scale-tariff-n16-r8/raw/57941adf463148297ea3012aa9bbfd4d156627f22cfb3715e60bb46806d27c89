import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** Passive Node/Undici diagnostics. The original fetch, request, response and stream
 * are never replaced or consumed. HTTP entity bytes are not TCP/TLS wire bytes.
 * The selected Pi provider must actually use this transport; the driver verifies
 * that its payload hashes have matching observed request bodies. */
export function observeProviderTransport(api, settings) {
  const { diagnostics, fs, crypto, path, output, checkoutRoot, clockId } = settings;
  const root = fs.realpathSync(checkoutRoot), parent = fs.realpathSync(path.dirname(output));
  const relative = path.relative(root, parent);
  if (!path.isAbsolute(output) || relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))
    throw new Error('PROVIDER_EVIDENCE_MUST_BE_OUTSIDE_CHECKOUT');
  const fd = fs.openSync(output, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  fs.fchmodSync(fd, 0o600);
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  let sequence = 0, previous = null, nextRequest = 0, closed = false, errors = 0, modelOrigin, modelPath, modelApi, selectedModel;
  const rows = new Map(), active = new Set(), subscriptions = [];
  const record = (phase, data = {}) => {
    const row = { version: 1, sequence: ++sequence, previousSha256: previous, clockId,
      monotonicNs: process.hrtime.bigint().toString(), phase, ...data };
    row.eventSha256 = hash(JSON.stringify(row)); previous = row.eventSha256;
    fs.writeSync(fd, JSON.stringify(row) + '\n');
  };
  const field = (headers, name) => {
    const decode = value => ArrayBuffer.isView(value)
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8') : String(value);
    const pairs = Array.isArray(headers)
      ? Array.from({ length: Math.floor(headers.length / 2) }, (_, index) => [headers[index * 2], headers[index * 2 + 1]])
      : Object.entries(headers ?? {});
    const values = pairs.filter(([key]) => decode(key).toLowerCase() === name)
      .flatMap(([, value]) => (Array.isArray(value) ? value : [value]).map(item => decode(item).toLowerCase()));
    return values.length === 0 ? undefined : new Set(values).size === 1 ? values[0] : 'conflicting-header-values';
  };
  // Retain only a short line prefix and capped counters, never response text.
  // A complete blank-line-delimited event must contain exactly one DONE data
  // field. Oversized/nonterminal events are discarded and the next event starts
  // fresh; an oversized event itself can never supply a completion proof.
  const completionScanner = () => {
    let prefix = '', lineBytes = 0, eventBytes = 0, invalid = false, dataLines = 0, doneData = false, doneEvents = 0, skipLf = false;
    const lineEnd = () => {
      if (lineBytes === 0) {
        if (!invalid && dataLines === 1 && doneData) doneEvents = Math.min(2, doneEvents + 1);
        eventBytes = 0; invalid = false; dataLines = 0; doneData = false;
      } else if (lineBytes <= 16 && (prefix === 'data:[DONE]' || prefix === 'data: [DONE]')) {
        dataLines = Math.min(2, dataLines + 1); doneData = true;
      } else if (!prefix.startsWith(':')) invalid = true;
      prefix = ''; lineBytes = 0;
    };
    return {
      push(chunk) {
        for (const byte of chunk) {
          if (skipLf) { skipLf = false; if (byte === 10) continue; }
          eventBytes = Math.min(65537, eventBytes + 1);
          if (eventBytes > 65536) invalid = true;
          if (byte === 10 || byte === 13) { lineEnd(); skipLf = byte === 13; }
          else { if (lineBytes < 16) prefix += String.fromCharCode(byte); lineBytes = Math.min(17, lineBytes + 1); }
        }
      },
      proof: () => ({ method: 'bounded-sse-data-done-v1', doneEvents }),
    };
  };
  // Responses has a JSON terminal, not Chat Completions' [DONE] marker.
  // Buffer at most one bounded SSE event in memory, project only identifiers and
  // usage, then discard its text. Malformed/oversized events fail closed.
  const responsesScanner = () => {
    const limit = 1048576, decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let lineChunks = [], lineBytes = 0, eventBytes = 0, data = [], eventName = null, skipLf = false, firstLine = true;
    let invalid = false, terminalEvents = 0, doneEvents = 0, response = null, observedId = null, observedModel = null;
    const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,255}$/u.test(value);
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const dispatch = () => {
      if (!data.length) { eventName = null; eventBytes = 0; return; }
      const encoded = data.join('\n'); data = [];
      if (encoded === '[DONE]') {
        doneEvents++;
        if (terminalEvents !== 1 || doneEvents !== 1) invalid = true;
      } else {
        let event;
        try { event = JSON.parse(encoded); } catch { invalid = true; return; }
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string'
          || eventName !== null && eventName !== event.type) { invalid = true; return; }
        const terminal = ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type);
        if (terminal) terminalEvents++;
        if (response !== null || doneEvents || event.type === 'error') { invalid = true; return; }
        if (event.type === 'response.created' || event.type === 'response.in_progress' || terminal) {
          const value = event.response;
          if (!value || typeof value !== 'object' || !identifier(value.id)
            || observedId !== null && value.id !== observedId
            || value.model !== undefined && (!identifier(value.model) || observedModel !== null && value.model !== observedModel)) {
            invalid = true; return;
          }
          observedId = value.id;
          if (value.model !== undefined) observedModel = value.model;
          if (terminal) {
            if (event.type !== 'response.completed' || value.status !== 'completed' || !identifier(value.model)) {
              invalid = true; return;
            }
            const usage = value.usage;
            response = { id: value.id, model: value.model, status: value.status, usage: {
              input_tokens: count(usage?.input_tokens), output_tokens: count(usage?.output_tokens),
              total_tokens: count(usage?.total_tokens),
              input_tokens_details: { cached_tokens: usage?.input_tokens_details?.cached_tokens === undefined ? null : count(usage.input_tokens_details.cached_tokens),
                cache_write_tokens: usage?.input_tokens_details?.cache_write_tokens === undefined ? null : count(usage.input_tokens_details.cache_write_tokens) },
              output_tokens_details: { reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens === undefined ? null : count(usage.output_tokens_details.reasoning_tokens) },
              optional_fields_valid: ['input_tokens_details', 'output_tokens_details'].every(key => usage?.[key] == null
                || typeof usage[key] === 'object' && !Array.isArray(usage[key]))
                && [['input_tokens_details', 'cached_tokens'], ['input_tokens_details', 'cache_write_tokens'],
                ['output_tokens_details', 'reasoning_tokens']].every(([group, key]) => usage?.[group]?.[key] === undefined || count(usage[group][key]) !== null),
            } };
          }
        }
      }
      eventName = null; eventBytes = 0;
    };
    const lineEnd = () => {
      let line;
      try { line = decoder.decode(Buffer.concat(lineChunks, lineBytes)); } catch { invalid = true; }
      lineChunks = []; lineBytes = 0;
      if (invalid) return;
      if (firstLine) { firstLine = false; if (line.startsWith('\uFEFF')) line = line.slice(1); }
      if (line === '') { dispatch(); return; }
      if (line.startsWith(':')) return;
      const colon = line.indexOf(':'), name = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (name === 'data') data.push(value);
      else if (name === 'event') {
        if (eventName !== null) invalid = true;
        eventName = value;
      }
    };
    const append = bytes => {
      eventBytes += bytes.length;
      if (eventBytes > limit) { invalid = true; lineChunks = []; data = []; return; }
      if (bytes.length) { lineChunks.push(Buffer.from(bytes)); lineBytes += bytes.length; }
    };
    return {
      push(value) {
        if (invalid) return;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        let start = 0;
        for (let i = 0; i < chunk.length; i++) {
          const byte = chunk[i];
          if (skipLf) { skipLf = false; if (byte === 10) { start = i + 1; continue; } }
          if (byte !== 10 && byte !== 13) continue;
          append(chunk.subarray(start, i)); eventBytes++;
          if (eventBytes > limit) invalid = true;
          if (invalid) return;
          lineEnd(); start = i + 1; skipLf = byte === 13;
          if (invalid) return;
        }
        append(chunk.subarray(start));
      },
      proof() {
        const complete = !invalid && terminalEvents === 1 && response !== null && lineBytes === 0 && data.length === 0 && eventName === null;
        lineChunks = []; data = [];
        return { method: 'bounded-openai-responses-sse-v1', complete, terminalEvents, doneEvents, response };
      },
    };
  };
  const register = (name, handle) => {
    const callback = event => {
      if (closed) return;
      try { handle(event); }
      catch { errors++; try { record('observer_error', { channel: name }); } catch {} }
    };
    diagnostics.subscribe('undici:request:' + name, callback);
    subscriptions.push(['undici:request:' + name, callback]);
  };
  record('transport_start', { method: 'node-undici-diagnostics-channel', coverage: 'this-process-undici-only',
    node: process.versions.node, undici: process.versions.undici ?? null, wireBytes: null,
    bodyMethod: 'request-body-chunks-and-response-entity-chunks-before-fetch-decompression' });
  register('create', ({ request }) => {
    const id = ++nextRequest, origin = String(request.origin), now = process.hrtime.bigint();
    const row = { id, started: now, requestBytes: 0, responseBytes: 0, requestHash: crypto.createHash('sha256'),
      responseHash: crypto.createHash('sha256'), sent: false, headers: false, encoding: null, status: null,
      // Each supported OpenAI API has one exact POST route. Same-origin MCP
      // traffic remains independent. Unsupported APIs retain conservative
      // origin-wide accounting rather than guessing a route.
      category: modelOrigin && origin === modelOrigin && (!modelPath || request.method === 'POST' && new URL(String(request.path), origin).pathname === modelPath) ? 'model' : 'other',
      originSha256: hash(origin),
      modelApi, contentType: null, completion: null };
    rows.set(request, row); active.add(request);
    record('request_start', { id, category: row.category, method: request.method, originSha256: row.originSha256,
      pathSha256: hash(String(request.path)), declaredRequestBodyBytes: Number.isSafeInteger(request.contentLength) && request.contentLength >= 0 ? request.contentLength : null });
  });
  register('bodyChunkSent', ({ request, chunk }) => {
    const row = rows.get(request); if (!row) throw new Error('UNOBSERVED_REQUEST');
    row.requestBytes += Buffer.byteLength(chunk); row.requestHash.update(chunk);
  });
  register('bodySent', ({ request }) => {
    const row = rows.get(request); if (!row) throw new Error('UNOBSERVED_REQUEST');
    row.sent = true;
    record('request_sent', { id: row.id, requestBodyBytes: row.requestBytes, requestBodySha256: row.requestHash.digest('hex') });
  });
  register('headers', ({ request, response }) => {
    const row = rows.get(request); if (!row) throw new Error('UNOBSERVED_REQUEST');
    row.headers = true; row.status = response.statusCode;
    const encoding = field(response.headers, 'content-encoding');
    row.encoding = encoding === undefined || encoding === 'identity' ? 'identity'
      : ['gzip', 'br', 'deflate', 'zstd'].includes(encoding) ? encoding : 'other';
    const contentType = field(response.headers, 'content-type');
    row.contentType = contentType === undefined ? null : contentType.split(';', 1)[0].trim() === 'text/event-stream' ? 'text/event-stream' : 'other';
    if (row.category === 'model' && row.modelApi === 'openai-completions' && row.status >= 200 && row.status < 300
      && row.encoding === 'identity' && row.contentType === 'text/event-stream') row.completion = completionScanner();
    if (row.category === 'model' && row.modelApi === 'openai-responses' && row.status >= 200 && row.status < 300
      && row.encoding === 'identity' && row.contentType === 'text/event-stream') row.completion = responsesScanner();
    record('response_headers', { id: row.id, status: row.status, contentEncoding: row.encoding, contentType: row.contentType });
  });
  register('bodyChunkReceived', ({ request, chunk }) => {
    const row = rows.get(request); if (!row) throw new Error('UNOBSERVED_REQUEST');
    row.responseBytes += Buffer.byteLength(chunk); row.responseHash.update(chunk);
    row.completion?.push(chunk);
  });
  const finishRequest = (request, error) => {
    const row = rows.get(request); if (!row || !active.delete(request)) throw new Error('UNOBSERVED_REQUEST');
    record('request_end', { id: row.id, category: row.category, status: row.status, outcome: error ? 'failure' : 'completed',
      durationMs: Number(process.hrtime.bigint() - row.started) / 1e6, requestSent: row.sent,
      requestBodyBytes: row.sent ? row.requestBytes : null,
      responseEntityBytes: row.headers ? row.responseBytes : null,
      decodedResponseBytes: row.headers && row.encoding === 'identity' ? row.responseBytes : null,
      responseEntitySha256: row.responseHash.digest('hex'), contentEncoding: row.encoding,
      modelApi: row.modelApi ?? null, contentType: row.contentType, sseCompletion: row.completion?.proof() ?? null,
      errorName: error ? (['AbortError', 'Error', 'TypeError', 'TimeoutError'].includes(error.name) ? error.name : 'OtherError') : null,
      errorCode: error ? (/^[A-Z0-9_]{1,80}$/i.test(error.code ?? '') ? error.code : 'UNCLASSIFIED') : null });
  };
  register('trailers', ({ request }) => finishRequest(request));
  register('error', ({ request, error }) => finishRequest(request, error));
  const finish = () => {
    if (closed) return;
    try {
      detach();
      for (const [name, callback] of subscriptions) diagnostics.unsubscribe(name, callback);
      record('transport_end', { errors, complete: errors === 0 && active.size === 0 && !pendingForkRebind, attempts: rows.size, pendingForkRebind,
        incompleteRequestIds: [...active].map(request => rows.get(request).id), selectedModel,
        retryWaitMs: null, queueWaitMs: null, wireBytes: null,
        waitMethod: 'SDK-application-waits-not-observable-through-undici' });
    } finally { closed = true; fs.closeSync(fd); }
  };
  const selectModel = ctx => {
    const model = ctx.model;
    selectedModel = model ? hash(String(model.provider) + '/' + String(model.id)) : null;
    const endpoint = model?.baseUrl ? new URL(model.baseUrl) : undefined;
    modelOrigin = endpoint?.origin;
    modelApi = ['openai-completions', 'openai-responses'].includes(model?.api) ? model.api : model?.api ? 'other' : null;
    // Pi's OpenAI client appends the selected API route to baseURL, preserving its
    // path prefix. Query values remain opaque and are only hashed on requests.
    modelPath = endpoint && ['openai-completions', 'openai-responses'].includes(modelApi)
      ? endpoint.pathname.replace(/\/$/u, '') + (modelApi === 'openai-responses' ? '/responses' : '/chat/completions') : undefined;
  };
  const handlers = [], unsubscribers = [], seenApis = new WeakSet();
  let boundApi, binding = 0, pendingForkRebind = false;
  const on = (name, handle) => handlers.push([name, handle]);
  const detach = () => {
    boundApi = undefined;
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  };
  const bind = nextApi => {
    if (closed) throw new Error('PROVIDER_OBSERVER_CLOSED');
    if (boundApi === nextApi) return;
    if (binding && (!pendingForkRebind || seenApis.has(nextApi))) throw new Error('PROVIDER_OBSERVER_REBIND_WITHOUT_FORK');
    const prior = binding; boundApi = nextApi; seenApis.add(nextApi); binding++; pendingForkRebind = false;
    for (const [name, handle] of handlers) {
      const unsubscribe = nextApi.on(name, (event, context) => {
        if (closed || boundApi !== nextApi) return;
        handle(event, context);
      });
      if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe);
    }
    if (prior) record('observer_rebind', { reason: 'fork', binding });
  };
  on('session_start', (_event, ctx) => {
    try {
      selectModel(ctx);
      record('model_selected', { modelSha256: selectedModel, originSha256: modelOrigin ? hash(modelOrigin) : null,
        endpointPathSha256: modelPath ? hash(modelPath) : null,
        endpointMethod: modelPath ? modelApi === 'openai-responses' ? 'openai-responses-route' : 'openai-chat-completions-route' : 'conservative-origin' });
    } catch { errors++; record('observer_error', { channel: 'session_start' }); }
  });
  on('before_provider_request', (_event, ctx) => {
    try { selectModel(ctx); }
    catch { modelApi = null; errors++; record('observer_error', { channel: 'before_provider_request' }); }
  });
  on('session_shutdown', event => {
    const reason = ['quit', 'reload', 'new', 'resume', 'fork'].includes(event?.reason) ? event.reason : 'unknown';
    record('session_shutdown', { reason, binding,
      targetSessionFileSha256: typeof event?.targetSessionFile === 'string' ? hash(event.targetSessionFile) : null });
    if (reason === 'fork') { pendingForkRebind = true; detach(); }
    else finish();
  });
  bind(api);
  return { bind, finish };
}

/** The caller binds this terminal and assistant message to one exact request.
 * HTTP failure remains a failure in the transport ledger. Only the proved SSE
 * protocol terminal can establish a separate application completion. */
export function providerApplicationCompletion(end, message) {
  if (end?.category !== 'model' || !Number.isInteger(end.status) || end.status < 200 || end.status >= 300) return null;
  if (message?.api === 'openai-responses' && end.modelApi !== 'openai-responses') return null;
  // The cost observer distinguishes absent raw metadata from invalid values it redacts.
  // Unknown stays null; an old null without that observation cannot prove validity.
  if (!(message?.responseModelStatus === 'unreported' && message.responseModel === null
    || message?.responseModelStatus === 'reported' && typeof message.responseModel === 'string' && message.responseModel.trim())) return null;
  if (end.modelApi === 'openai-responses') {
    const proof = end.sseCompletion, response = proof?.response, usage = response?.usage;
    const natural = value => Number.isSafeInteger(value) && value >= 0;
    const optional = value => value === null || natural(value);
    if (end.contentEncoding !== 'identity' || end.contentType !== 'text/event-stream'
      || proof?.method !== 'bounded-openai-responses-sse-v1' || proof.complete !== true || proof.terminalEvents !== 1
      || ![0, 1].includes(proof.doneEvents) || response?.status !== 'completed'
      || !['id', 'model'].every(key => typeof response[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,255}$/u.test(response[key]))
      || !['input_tokens', 'output_tokens', 'total_tokens'].every(key => natural(usage?.[key]))
      || usage.total_tokens <= 0 || usage.total_tokens !== usage.input_tokens + usage.output_tokens
      || usage.optional_fields_valid !== true
      || ![usage.input_tokens_details?.cached_tokens, usage.input_tokens_details?.cache_write_tokens,
        usage.output_tokens_details?.reasoning_tokens].every(optional)) return null;
    // Pi 1.6 subtracts cache reads/writes from input; absent optional detail
    // fields have defined zero defaults, retained as null in the raw projection.
    const cacheRead = usage.input_tokens_details.cached_tokens ?? 0, cacheWrite = usage.input_tokens_details.cache_write_tokens ?? 0;
    const reasoning = usage.output_tokens_details.reasoning_tokens ?? 0;
    if (cacheRead + cacheWrite > usage.input_tokens || reasoning > usage.output_tokens) return null;
    const expected = { input: usage.input_tokens - cacheRead - cacheWrite, output: usage.output_tokens,
      cacheRead, cacheWrite, reasoning, totalTokens: usage.total_tokens };
    if (message?.role !== 'assistant' || message.api !== 'openai-responses' || message.responseId !== response.id
      || message.rawStopReason !== 'completed' || !['stop', 'toolUse'].includes(message.stopReason)
      || !['provider', 'model'].every(key => typeof message[key] === 'string' && message[key].trim())
      || message.responseModelStatus === 'reported' && message.responseModel !== response.model
      || !Object.entries(expected).every(([key, value]) => message.usage?.[key] === value)) return null;
    if (end.outcome === 'completed') return 'responses-completed';
    return end.outcome === 'failure' && end.errorName === 'AbortError' && end.errorCode === 20
      ? 'responses-completed-before-http-cancel' : null;
  }
  if (end.outcome === 'completed') return 'http-complete';
  if (end.outcome !== 'failure' || end.errorName !== 'AbortError' || end.errorCode !== 20
    || end.modelApi !== 'openai-completions' || end.contentEncoding !== 'identity' || end.contentType !== 'text/event-stream'
    || end.sseCompletion?.method !== 'bounded-sse-data-done-v1' || end.sseCompletion.doneEvents !== 1) return null;
  if (message?.role !== 'assistant' || !['stop', 'toolUse'].includes(message.stopReason)
    || !['provider', 'model'].every(key => typeof message[key] === 'string' && message[key].trim())
    || !['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(key => Number.isFinite(message.usage?.[key]) && message.usage[key] >= 0)
    || message.usage.totalTokens <= 0) return null;
  return 'sse-done-before-http-cancel';
}

export function providerTransportExtensionSource(settings) {
  return "import diagnostics from 'node:diagnostics_channel';\nimport fs from 'node:fs';\nimport crypto from 'node:crypto';\nimport path from 'node:path';\n"
    + 'const settings = ' + JSON.stringify(settings) + ';\n'
    + "const registry = globalThis[Symbol.for('context-broker.provider-transport-observers.v1')] ??= new Map();\n"
    + 'export default api => {\n'
    + '  const key = path.resolve(settings.output), identity = JSON.stringify(settings), prior = registry.get(key);\n'
    + '  if (prior) {\n'
    + "    if (prior.identity !== identity) throw new Error('PROVIDER_OBSERVER_SETTINGS_CHANGED');\n"
    + '    prior.observer.bind(api);\n'
    + '  } else {\n'
    + '    const observer = (' + observeProviderTransport.toString() + ')(api, {diagnostics,fs,crypto,path,...settings});\n'
    + '    registry.set(key, {identity, observer});\n'
    + '  }\n};\n';
}

export async function readProviderTransport(file) {
  const buffer = await readFile(file), text = buffer.toString('utf8');
  if (!text || !text.endsWith('\n')) throw new Error('PROVIDER_TRACE_TRUNCATED');
  const require = condition => { if (!condition) throw new Error('PROVIDER_TRACE_INVALID'); };
  let events;
  try { events = text.trimEnd().split('\n').map(JSON.parse); }
  catch { throw new Error('PROVIDER_TRACE_INVALID'); }
  require(events.length >= 2 && events[0]?.phase === 'transport_start' && events.at(-1)?.phase === 'transport_end');
  const clock = events[0].clockId, requests = new Map();
  require(typeof clock === 'string' && clock.length > 0);
  let previous = null, lastTime = -1n, observerErrors = 0, pendingFork = false, binding = 1;
  for (const [index, event] of events.entries()) {
    require(event && typeof event === 'object' && !Array.isArray(event));
    require(event.version === 1 && event.sequence === index + 1 && event.previousSha256 === previous && event.clockId === clock);
    require(typeof event.monotonicNs === 'string' && /^\d+$/.test(event.monotonicNs) && BigInt(event.monotonicNs) >= lastTime);
    const { eventSha256, ...body } = event;
    require(eventSha256 === createHash('sha256').update(JSON.stringify(body)).digest('hex'));
    previous = eventSha256; lastTime = BigInt(event.monotonicNs);
    switch (event.phase) {
      case 'transport_start': require(index === 0); break;
      case 'transport_end': require(index === events.length - 1); break;
      case 'model_selected': break;
      case 'session_shutdown':
        require(['quit', 'reload', 'new', 'resume', 'fork', 'unknown'].includes(event.reason));
        if (event.reason === 'fork') { require(!pendingFork && event.binding === binding); pendingFork = true; }
        break;
      case 'observer_rebind':
        require(pendingFork && event.reason === 'fork' && event.binding === binding + 1);
        pendingFork = false; binding = event.binding;
        break;
      case 'observer_error': observerErrors++; break;
      case 'request_start':
        require(Number.isSafeInteger(event.id) && event.id === requests.size + 1 && !requests.has(event.id));
        requests.set(event.id, { ended: false, category: event.category });
        break;
      case 'request_sent':
      case 'response_headers':
      case 'request_end': {
        const request = requests.get(event.id);
        require(request && !request.ended);
        if (event.phase === 'request_end') {
          require(['completed', 'failure'].includes(event.outcome) && event.category === request.category);
          request.ended = true;
        }
        break;
      }
      default: require(false);
    }
  }
  const end = events.at(-1), open = [...requests].filter(([, request]) => !request.ended).map(([id]) => id);
  require(end.attempts === requests.size && end.errors === observerErrors);
  require(Array.isArray(end.incompleteRequestIds) && end.incompleteRequestIds.length === open.length
    && new Set(end.incompleteRequestIds).size === open.length && end.incompleteRequestIds.every(id => open.includes(id)));
  // A captured HTTP failure is a valid terminal observation. Only observer errors
  // or requests without a terminal make the trace incomplete.
  require(end.pendingForkRebind === undefined ? !pendingFork : end.pendingForkRebind === pendingFork);
  require(end.complete === (observerErrors === 0 && open.length === 0 && !pendingFork));
  return events;
}

