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
  let sequence = 0, previous = null, nextRequest = 0, closed = false, errors = 0, modelOrigin, modelApi, selectedModel;
  const rows = new Map(), active = new Set(), subscriptions = [];
  const record = (phase, data = {}) => {
    const row = { version: 1, sequence: ++sequence, previousSha256: previous, clockId,
      monotonicNs: process.hrtime.bigint().toString(), phase, ...data };
    row.eventSha256 = hash(JSON.stringify(row)); previous = row.eventSha256;
    fs.writeSync(fd, JSON.stringify(row) + '\n');
  };
  const field = (headers, name) => {
    for (let i = 0; i + 1 < (headers?.length ?? 0); i += 2)
      if (String(headers[i]).toLowerCase() === name) return String(headers[i + 1]).toLowerCase();
    return undefined;
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
      category: modelOrigin && origin === modelOrigin ? 'model' : 'other', originSha256: hash(origin),
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
      for (const [name, callback] of subscriptions) diagnostics.unsubscribe(name, callback);
      record('transport_end', { errors, complete: errors === 0 && active.size === 0, attempts: rows.size,
        incompleteRequestIds: [...active].map(request => rows.get(request).id), selectedModel,
        retryWaitMs: null, queueWaitMs: null, wireBytes: null,
        waitMethod: 'SDK-application-waits-not-observable-through-undici' });
    } finally { closed = true; fs.closeSync(fd); }
  };
  const selectModel = ctx => {
    const model = ctx.model;
    selectedModel = model ? hash(String(model.provider) + '/' + String(model.id)) : null;
    modelOrigin = model?.baseUrl ? new URL(model.baseUrl).origin : undefined;
    modelApi = model?.api === 'openai-completions' ? 'openai-completions' : model?.api ? 'other' : null;
  };
  api.on('session_start', (_event, ctx) => {
    try {
      selectModel(ctx);
      record('model_selected', { modelSha256: selectedModel, originSha256: modelOrigin ? hash(modelOrigin) : null });
    } catch { errors++; record('observer_error', { channel: 'session_start' }); }
  });
  api.on('before_provider_request', (_event, ctx) => {
    try { selectModel(ctx); }
    catch { modelApi = null; errors++; record('observer_error', { channel: 'before_provider_request' }); }
  });
  api.on('session_shutdown', finish);
  return { finish };
}

/** The caller binds this terminal and assistant message to one exact request.
 * HTTP failure remains a failure in the transport ledger. Only the proved SSE
 * protocol terminal can establish a separate application completion. */
export function providerApplicationCompletion(end, message) {
  if (end?.category !== 'model' || !Number.isInteger(end.status) || end.status < 200 || end.status >= 300) return null;
  if (end.outcome === 'completed') return 'http-complete';
  if (end.outcome !== 'failure' || end.errorName !== 'AbortError' || end.errorCode !== 20
    || end.modelApi !== 'openai-completions' || end.contentEncoding !== 'identity' || end.contentType !== 'text/event-stream'
    || end.sseCompletion?.method !== 'bounded-sse-data-done-v1' || end.sseCompletion.doneEvents !== 1) return null;
  if (message?.role !== 'assistant' || !['stop', 'toolUse'].includes(message.stopReason)
    || !['provider', 'model', 'responseModel'].every(key => typeof message[key] === 'string' && message[key].trim())
    || !['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(key => Number.isFinite(message.usage?.[key]) && message.usage[key] >= 0)
    || message.usage.totalTokens <= 0) return null;
  return 'sse-done-before-http-cancel';
}

export function providerTransportExtensionSource(settings) {
  return "import diagnostics from 'node:diagnostics_channel';\nimport fs from 'node:fs';\nimport crypto from 'node:crypto';\nimport path from 'node:path';\n"
    + 'export default api => { (' + observeProviderTransport.toString() + ')(api, {diagnostics,fs,crypto,path,...' + JSON.stringify(settings) + '}); };\n';
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
  let previous = null, lastTime = -1n, observerErrors = 0;
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
  require(end.complete === (observerErrors === 0 && open.length === 0));
  return events;
}

