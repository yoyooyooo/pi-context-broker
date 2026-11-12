import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const fixtureProviderId = 'context-broker-e2e';
export const fixtureModelId = 'fake';
export const fixtureApiKey = 'fixture-no-secret';
export const inProcessApi = 'context-broker-e2e-api';
export const httpBaseUrlEnv = 'CTX_MOCK_PROVIDER_BASE_URL';

export const defaultLimits = Object.freeze({
  maxRequests: 32,
  maxBodyBytes: 16 * 1024 * 1024,
  requestTimeoutMs: 30_000,
  holdTimeoutMs: 120_000,
  maxInFlight: 1,
});

const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(part => part?.type === 'text' || typeof part?.text === 'string').map(part => part.text ?? '').join('\n')
  : '';

export function assertLoopbackBaseUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('MOCK_PROVIDER_LOOPBACK_REQUIRED'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname.replace(/\/$/u, '') !== '/v1')
    throw new Error('MOCK_PROVIDER_LOOPBACK_REQUIRED');
  return url;
}

export async function holdPlannedResponse(options, hook) {
  const planPath = process.env.SC10_PI_TOOL_PLAN;
  if (!JSON.parse(readFileSync(planPath, 'utf8')).holdResponse) return false;
  hook('response_held');
  const aborted = () => hook('signal_aborted');
  options.signal.addEventListener('abort', aborted, { once: true });
  const deadline = Date.now() + defaultLimits.holdTimeoutMs;
  try {
    if (options.signal.aborted) aborted();
    while (JSON.parse(readFileSync(planPath, 'utf8')).holdResponse) {
      if (Date.now() >= deadline) throw new Error('MOCK_PROVIDER_HOLD_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally { options.signal.removeEventListener('abort', aborted); }
  return true;
}

function assistantMessage(usageText = 'OK') {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: usageText }],
    api: inProcessApi,
    provider: fixtureProviderId,
    model: fixtureModelId,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

export function createInProcessStream({ model, context, options, requestId, selectCall, observe = () => {}, hold = async () => false }) {
  const captureFile = process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE;
  if (!captureFile) throw new Error('Missing isolated provider context capture path');
  let current = context;
  let providerRequestPromise;
  const emit = phase => observe({
    requestId, phase, pid: process.pid, aborted: Boolean(options?.signal?.aborted), monotonicNs: process.hrtime.bigint().toString(),
  });
  function request() {
    return providerRequestPromise ??= (async () => {
      options?.signal?.throwIfAborted();
      if (typeof options?.onPayload !== 'function' || typeof options?.onResponse !== 'function') throw new Error('PUBLIC_PROVIDER_HOOKS_REQUIRED');
      emit('payload_start');
      const payload = await options.onPayload({ model: model.id, context: current }, model);
      emit('payload_end');
      options?.signal?.throwIfAborted();
      if (payload?.context) current = payload.context;
      appendFileSync(captureFile, JSON.stringify({ requestId, model: model.id, context: current, capturedAtNs: process.hrtime.bigint().toString() }) + '\n');
      const held = await hold(options, emit);
      await options.onResponse({ status: 200, headers: { 'x-fixture': 'deterministic' } }, model);
      if (held) emit('response_callback');
      emit('response_end');
      options?.signal?.throwIfAborted();
    })();
  }
  const output = assistantMessage();
  output.api = model.api;
  output.provider = model.provider;
  output.model = model.id;
  const events = [
    { type: 'start', partial: output },
    { type: 'text_start', contentIndex: 0, partial: output },
    { type: 'text_delta', contentIndex: 0, delta: 'OK', partial: output },
    { type: 'text_end', contentIndex: 0, content: 'OK', partial: output },
    { type: 'done', reason: 'stop', message: output },
  ];
  let sent = false, call, prepared = false;
  async function prepareOutput() {
    await request();
    if (!prepared) {
      call = selectCall(current);
      if (call) { output.content = [call]; output.stopReason = 'toolUse'; }
      prepared = true;
    }
    return output;
  }
  return {
    push() {},
    end() {},
    result: prepareOutput,
    async *[Symbol.asyncIterator]() {
      if (sent) return;
      sent = true;
      await prepareOutput();
      if (call) {
        yield { type: 'start', partial: output };
        yield { type: 'toolcall_start', contentIndex: 0, partial: output };
        yield { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: output };
        yield { type: 'done', reason: 'toolUse', message: output };
      } else for (const event of events) yield event;
    },
  };
}

export function contextFromCompletionRequest(body) {
  const names = new Map();
  const messages = [];
  for (const message of body?.messages ?? []) {
    if (message.role === 'system' || message.role === 'developer') {
      messages.push({ role: 'system', content: textOf(message.content) });
    } else if (message.role === 'user') {
      messages.push({ role: 'user', content: textOf(message.content) });
    } else if (message.role === 'assistant') {
      const content = [];
      const text = textOf(message.content);
      if (text) content.push({ type: 'text', text });
      for (const toolCall of message.tool_calls ?? []) {
        const name = toolCall.function?.name ?? toolCall.custom?.name ?? '';
        let args = {};
        const raw = toolCall.function?.arguments ?? toolCall.custom?.input;
        if (typeof raw === 'string' && raw) {
          try { args = JSON.parse(raw); }
          catch { args = {}; }
        } else if (raw && typeof raw === 'object') args = raw;
        if (toolCall.id && name) names.set(toolCall.id, name);
        content.push({ type: 'toolCall', id: toolCall.id ?? '', name, arguments: args });
      }
      messages.push({ role: 'assistant', content });
    } else if (message.role === 'tool') {
      messages.push({
        role: 'toolResult',
        toolCallId: message.tool_call_id,
        toolName: message.name ?? names.get(message.tool_call_id),
        content: textOf(message.content),
      });
    }
  }
  const tools = (body?.tools ?? []).filter(tool => tool?.type === 'function' && tool.function?.name).map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
  if (tools.length) messages.push({ role: 'system', content: '', toolsAdded: tools });
  return { messages };
}

export function createMockControl() {
  const waiters = new Set();
  const state = { mode: 'run', error: 'MOCK_PROVIDER_ERROR' };
  const wake = mode => { for (const waiter of waiters) waiter(mode); waiters.clear(); };
  return {
    hold() { state.mode = 'hold'; },
    release() { state.mode = 'run'; wake('run'); },
    fail(error = 'MOCK_PROVIDER_ERROR') { state.mode = 'error'; state.error = error; wake('error'); },
    cancel() { state.mode = 'cancel'; wake('cancel'); },
    interrupt() { state.mode = 'interrupt'; wake('interrupt'); },
    get mode() { return state.mode; },
    get error() { return state.error; },
    async gate(signal, onHeld) {
      if (state.mode !== 'hold') return state.mode;
      onHeld?.();
      return new Promise(resolve => {
        const finish = mode => { signal?.removeEventListener('abort', onAbort); waiters.delete(finish); resolve(mode); };
        const onAbort = () => finish('abort');
        waiters.add(finish);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) finish('abort');
        else if (state.mode !== 'hold') finish(state.mode);
      });
    },
  };
}

function sse(payload) { return `data: ${JSON.stringify(payload)}\n\n`; }

function writeToolSse(response, call, modelId, record) {
  const chunk = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: modelId };
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  record.sse = [];
  const emit = value => { const bytes = sse(value); record.sse.push(bytes); response.write(bytes); };
  if (!call) {
    emit({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] });
    emit({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  } else {
    const args = JSON.stringify(call.arguments ?? {});
    emit({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }, finish_reason: null }] });
    emit({ ...chunk, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
    emit({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  }
  record.sse.push('data: [DONE]\n\n');
  response.end(record.sse.at(-1));
}

function writeJson(response, status, message) {
  const body = JSON.stringify({ error: { message, type: 'mock_provider_error' } });
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' });
  response.end(body);
}

export function startLoopbackMock({ selectCall, observe = () => {}, onBody, control = createMockControl(), limits = {} } = {}) {
  if (typeof selectCall !== 'function') throw new Error('MOCK_PROVIDER_SELECT_REQUIRED');
  const bound = { ...defaultLimits, ...limits };
  for (const key of ['maxRequests', 'maxBodyBytes', 'requestTimeoutMs', 'holdTimeoutMs', 'maxInFlight']) {
    if (!Number.isSafeInteger(bound[key]) || bound[key] <= 0) throw new Error('MOCK_PROVIDER_LIMIT_INVALID');
  }
  const requests = [];
  const sockets = new Set();
  let accepted = 0, inFlight = 0, tail = Promise.resolve(), closed = false;
  const server = createServer((request, response) => {
    // Invalid traffic is bounded too; no request bytes or credentials are kept.
    if (requests.length >= bound.maxRequests * 2 + 8) {
      request.resume();
      return writeJson(response, 429, 'MOCK_PROVIDER_EVIDENCE_LIMIT');
    }
    const remote = request.socket?.remoteAddress;
    const started = process.hrtime.bigint().toString();
    const record = { method: request.method, path: request.url, remote, started, phase: 'open' };
    requests.push(record);
    observe({ phase: 'open', request: record });
    const fail = (status, message, phase = 'error') => {
      record.phase = phase; record.status = status; record.error = message;
      observe({ phase, request: record });
      if (!response.headersSent && !response.writableEnded) writeJson(response, status, message);
      else if (!response.writableEnded) response.destroy();
    };
    if (closed) return fail(503, 'MOCK_PROVIDER_CLOSED');
    if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1') return fail(403, 'MOCK_PROVIDER_REMOTE_REJECTED');
    const host = request.headers.host ?? '';
    const address = server.address();
    if (!address || typeof address !== 'object' || host !== `127.0.0.1:${address.port}`) return fail(421, 'MOCK_PROVIDER_HOST_REJECTED');
    const authorization = request.headers.authorization;
    if (authorization !== undefined && authorization !== `Bearer ${fixtureApiKey}`) return fail(401, 'MOCK_PROVIDER_AUTH_REJECTED');
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return fail(request.method === 'POST' ? 404 : 405, 'MOCK_PROVIDER_ROUTE_REJECTED');
    if (accepted >= bound.maxRequests) return fail(429, 'MOCK_PROVIDER_REQUEST_LIMIT');
    accepted += 1;
    const chunks = [];
    let bytes = 0, overflow = false, settled = false;
    const receive = AbortSignal.timeout(bound.requestTimeoutMs);
    const onReceiveAbort = () => { if (settled) return; overflow = true; request.destroy(); };
    if (receive.aborted) onReceiveAbort();
    else receive.addEventListener('abort', onReceiveAbort, { once: true });
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > bound.maxBodyBytes) { overflow = true; request.destroy(); }
      else chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      receive.removeEventListener('abort', onReceiveAbort);
      if (overflow || request.aborted) {
        record.phase = 'cancelled'; record.bytes = bytes; record.status = null;
        observe({ phase: 'cancelled', request: record });
        return;
      }
      record.bytes = bytes;
      const body = Buffer.concat(chunks);
      tail = tail.then(async () => { await onBody?.(record, body); return handle(body); }).catch(error => {
        record.phase = 'error'; record.error = 'MOCK_PROVIDER_ERROR';
        observe({ phase: 'error', request: record, message: error?.message });
        if (!response.headersSent) writeJson(response, 500, 'MOCK_PROVIDER_ERROR');
      });
    });
    request.on('error', () => { if (record.phase === 'open') { record.phase = 'cancelled'; observe({ phase: 'cancelled', request: record }); } });
    async function handle(body) {
      if (inFlight >= bound.maxInFlight) return fail(429, 'MOCK_PROVIDER_INFLIGHT_LIMIT');
      inFlight += 1;
      const client = new AbortController();
      const socket = request.socket;
      const onDisconnect = () => { if (!response.headersSent && !response.writableEnded) client.abort(); };
      socket?.on('close', onDisconnect);
      response.on('close', onDisconnect);
      const holdTimer = setTimeout(() => client.abort(), bound.holdTimeoutMs);
      try {
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); }
        catch { return fail(400, 'MOCK_PROVIDER_BODY_INVALID'); }
        record.bodySha256 = createHash('sha256').update(body).digest('hex');
        const decision = await control.gate(client.signal, () => { record.phase = 'held'; observe({ phase: 'held', request: record }); });
        if (decision === 'abort' || decision === 'cancel' || client.signal.aborted) {
          record.phase = 'cancelled'; record.status = null;
          observe({ phase: 'cancelled', request: record });
          if (!response.writableEnded) response.destroy();
          return;
        }
        if (decision === 'error' || control.mode === 'error') return fail(500, control.error || 'MOCK_PROVIDER_ERROR');
        if (decision === 'interrupt') {
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          record.sse = [sse({ id: 'interrupted', object: 'chat.completion.chunk', created: 1, model: fixtureModelId,
            choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }] })];
          response.write(record.sse[0]);
          record.status = 200; record.phase = 'stream-held';
          control.hold();
          await control.gate(client.signal);
          record.phase = 'stream-interrupted'; record.error = 'MOCK_STREAM_INTERRUPTED';
          response.destroy();
          return;
        }
        const context = contextFromCompletionRequest(parsed);
        let call;
        try { call = selectCall(context); }
        catch (error) {
          const code = typeof error?.message === 'string' && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : 'MOCK_PROVIDER_SELECT_FAILED';
          return fail(500, code);
        }
        record.phase = 'responded';
        record.status = 200;
        record.call = call ? { id: call.id, name: call.name, arguments: call.arguments } : null;
        record.contextMessages = context.messages.length;
        record.visibleToolText = context.messages.filter(message => message.role === 'toolResult').map(message => textOf(message.content)).join('\n');
        observe({ phase: 'responded', request: record });
        writeToolSse(response, call, typeof parsed.model === 'string' ? parsed.model : fixtureModelId, record);
      } finally {
        clearTimeout(holdTimer);
        socket?.off('close', onDisconnect);
        response.off('close', onDisconnect);
        inFlight -= 1;
      }
    }
  });
  server.maxConnections = bound.maxRequests + bound.maxInFlight;
  server.headersTimeout = bound.requestTimeoutMs;
  server.requestTimeout = bound.requestTimeoutMs;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const ready = new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return ready.then(() => {
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('MOCK_PROVIDER_BIND_FAILED');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    assertLoopbackBaseUrl(baseUrl);
    return {
      baseUrl,
      url: baseUrl,
      port: address.port,
      requests,
      control,
      async close() {
        closed = true;
        control.cancel();
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      },
    };
  });
}

const modelLiteral = `{ id: ${JSON.stringify(fixtureModelId)}, name: "Fixture", input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000, maxTokens: 4096 }`;

export function renderInProcessWrapper({ helperUrl, driverUrl }) {
  if (!helperUrl || !driverUrl) throw new Error('MOCK_PROVIDER_WRAPPER_TARGET_REQUIRED');
  return `import { appendFileSync } from 'node:fs';
import { channel } from 'node:diagnostics_channel';
import { createInProcessStream, holdPlannedResponse } from ${JSON.stringify(helperUrl)};
import { selectProviderCall } from ${JSON.stringify(driverUrl)};

export function selectCall(context, plan) {
  return plan === undefined ? selectProviderCall(context) : selectProviderCall(context, plan);
}

export function observe(event) {
  appendFileSync(process.env.SC10_PI_PROVIDER_HOOKS, JSON.stringify({
    requestId: event.requestId, phase: event.phase, pid: event.pid, aborted: event.aborted, monotonic_ns: event.monotonicNs,
  }) + '\\n', { mode: 0o600 });
  if (event.phase === 'payload_start' && process.env.SC06_PI_CATALOG_RELEASE === 'provider')
    channel('context-broker.verify-sdk-initialization-release').publish({ pid: process.pid, boundary: 'provider' });
}

export function control(options, hook) {
  return holdPlannedResponse(options, hook);
}

let nextRequest = 0;
function stream(model, context, options) {
  const requestId = String(process.pid) + ':' + String(++nextRequest);
  return createInProcessStream({ model, context, options, requestId, selectCall, observe, hold: control });
}

export default function provider(pi) {
  pi.registerProvider(${JSON.stringify(fixtureProviderId)}, {
    name: "Context Broker E2E Fixture", api: ${JSON.stringify(inProcessApi)},
    apiKey: ${JSON.stringify(fixtureApiKey)}, baseUrl: "http://127.0.0.1",
    streamSimple: stream,
    models: [${modelLiteral}],
  });
}
`;
}

export function renderHttpWrapper({ helperUrl, serializerUrl }) {
  if (!helperUrl || !serializerUrl) throw new Error('MOCK_PROVIDER_WRAPPER_TARGET_REQUIRED');
  return `import { streamSimple } from ${JSON.stringify(serializerUrl)};
import { assertLoopbackBaseUrl } from ${JSON.stringify(helperUrl)};

export function observe(event) {
  return event;
}

export default function provider(pi) {
  const baseUrl = assertLoopbackBaseUrl(process.env[${JSON.stringify(httpBaseUrlEnv)}]).href.replace(/\\/$/u, '');
  pi.registerProvider(${JSON.stringify(fixtureProviderId)}, {
    name: "Context Broker E2E Fixture", api: "openai-completions",
    apiKey: ${JSON.stringify(fixtureApiKey)}, baseUrl,
    streamSimple,
    models: [{ id: ${JSON.stringify(fixtureModelId)}, name: "Fixture", reasoning: false, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000, maxTokens: 4096 }],
  });
}
`;
}

export function wrapperUrl(path) { return pathToFileURL(path).href; }
