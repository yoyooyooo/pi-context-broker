import test from 'node:test';
import assert from 'node:assert/strict';
import * as diagnostics from 'node:diagnostics_channel';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createSecureServer } from 'node:http2';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { observeProviderTransport, readProviderTransport } from './skill-consumption-provider.mjs';
import * as providerObserver from './skill-consumption-provider.mjs';

function forkApi() {
  const handlers = new Map(); let disposed = false;
  return { handlers, api: { on(name, callback) {
    assert.equal(disposed, false); const group = handlers.get(name) ?? new Set(); group.add(callback); handlers.set(name, group);
    return () => { group.delete(callback); if (!group.size) handlers.delete(name); };
  } }, emit(name, event = {}, context) {
    for (const callback of [...(handlers.get(name) ?? [])]) assert.equal(callback(event, context), undefined);
  }, dispose() { disposed = true; handlers.clear(); } };
}

test('serialized transport observer rebinds after real fork reason without duplicate diagnostics or request IDs', async () => {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'provider-fork-')), output = path.join(base, 'transport.jsonl');
  const extension = path.join(base, 'observer.mjs'), settings = { output, checkoutRoot: process.cwd(), clockId: 'fork-test' };
  fs.writeFileSync(extension, providerObserver.providerTransportExtensionSource(settings));
  const old = forkApi(), next = forkApi(), first = await import(pathToFileURL(extension).href + '?first');
  first.default(old.api); first.default(old.api);
  const context = { model: { provider: 'fixture', id: 'before', baseUrl: 'https://before.invalid', api: 'openai-completions' } };
  old.emit('session_start', { reason: 'startup' }, context);
  const emit = (name, value) => diagnostics.channel('undici:request:' + name).publish(value);
  const started = () => {
    const request = { origin: context.model.baseUrl, method: 'POST', path: '/chat/completions' };
    emit('create', { request }); emit('bodyChunkSent', { request, chunk: Buffer.from('body') }); emit('bodySent', { request });
    return request;
  };
  const ended = request => {
    emit('headers', { request, response: { statusCode: 200, headers: [] } });
    emit('bodyChunkReceived', { request, chunk: Buffer.from('reply') }); emit('trailers', { request });
  };
  const request = started(), prefix = fs.readFileSync(output), inode = fs.statSync(output).ino;
  const staleSelect = [...old.handlers.get('before_provider_request')][0];
  old.emit('session_shutdown', { type: 'session_shutdown', reason: 'fork', targetSessionFile: '/private/target.jsonl' });
  assert.equal(old.handlers.size, 0); old.dispose();
  ended(request); // An already observed transport may close while the new API loads.
  assert.equal(fs.readFileSync(output, 'utf8').includes('transport_end'), false);
  const second = await import(pathToFileURL(extension).href + '?reloaded'); second.default(next.api); second.default(next.api);
  context.model = { ...context.model, id: 'after', baseUrl: 'https://after.invalid' };
  next.emit('session_start', { reason: 'fork' }, context);
  staleSelect({}, { model: { provider: 'wrong', id: 'stale', baseUrl: 'https://stale.invalid' } });
  ended(started()); next.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' });
  const rows = await readProviderTransport(output);
  assert.equal(fs.statSync(output).ino, inode); assert.ok(fs.readFileSync(output).subarray(0, prefix.length).equals(prefix));
  assert.deepEqual(rows.filter(row => row.phase === 'request_start').map(row => [row.id, row.category]), [[1, 'model'], [2, 'model']]);
  assert.equal(rows.filter(row => row.phase === 'transport_start').length, 1);
  assert.equal(rows.filter(row => row.phase === 'observer_rebind').length, 1);
  assert.equal(rows.filter(row => row.phase === 'transport_end').length, 1);
  assert.equal(rows.at(-1).attempts, 2); assert.equal(rows.at(-1).complete, true);
  assert.equal(rows.at(-1).selectedModel, crypto.createHash('sha256').update('fixture/after').digest('hex'));
  const finalBytes = fs.readFileSync(output); emit('create', { request: {} });
  assert.ok(fs.readFileSync(output).equals(finalBytes));
  assert.equal(finalBytes.includes(Buffer.from('/private/target.jsonl')), false);
  assert.throws(() => second.default(forkApi().api), /CLOSED/);
  const missing = rows.filter(row => row.phase !== 'observer_rebind'), changed = path.join(base, 'missing-rebind.jsonl');
  fs.writeFileSync(changed, reseal(missing).map(row => JSON.stringify(row)).join('\n') + '\n');
  await assert.rejects(() => readProviderTransport(changed), /PROVIDER_TRACE_INVALID/);
});

test('transport subscriptions and unfinished requests survive a fork and cannot seal as complete without rebind', async () => {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'provider-fork-missing-')), output = path.join(base, 'transport.jsonl');
  const callbacks = new Map(), old = forkApi(), next = forkApi(); let subscriptions = 0, unsubscriptions = 0;
  const observer = observeProviderTransport(old.api, { fs, crypto, path, output, checkoutRoot: process.cwd(), clockId: 'fork-missing',
    diagnostics: { subscribe(name, callback) { subscriptions++; callbacks.set(name, callback); },
      unsubscribe(name, callback) { assert.equal(callbacks.get(name), callback); unsubscriptions++; callbacks.delete(name); } } });
  assert.throws(() => observer.bind(next.api), /REBIND_WITHOUT_FORK/);
  old.emit('session_shutdown', { reason: 'fork', targetSessionFile: '/private/target.jsonl' });
  assert.equal(unsubscriptions, 0); assert.throws(() => observer.bind(old.api), /REBIND_WITHOUT_FORK/);
  observer.bind(next.api); assert.equal(subscriptions, 7); assert.equal(unsubscriptions, 0);
  callbacks.get('undici:request:create')({ request: { origin: 'https://fixture.invalid', path: '/', method: 'POST' } });
  next.emit('session_shutdown', { reason: 'fork' }); observer.finish();
  const rows = await readProviderTransport(output);
  assert.equal(rows.at(-1).complete, false); assert.equal(rows.at(-1).pendingForkRebind, true);
  assert.deepEqual(rows.at(-1).incompleteRequestIds, [1]); assert.equal(unsubscriptions, 7);
});

test('passive provider diagnostics preserve fetch, exact request and decoded response while counting HTTP entities', async t => {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'consumption-provider-test-'));
  const hooks = new Map(), output = path.join(base, 'transport.jsonl'), originalFetch = globalThis.fetch;
  const payload = JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: '完整输入' }] });
  const reply = '原始响应\n'.repeat(24), zipped = gzipSync(reply);
  let received;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received = { body: Buffer.concat(chunks).toString(), auth: request.headers.authorization };
    response.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain', 'content-length': zipped.length });
    response.end(zipped);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = 'http://127.0.0.1:' + server.address().port;
  const observer = observeProviderTransport({ on(name, handle) { hooks.set(name, handle); } },
    { diagnostics, fs, crypto, path, output, checkoutRoot: process.cwd(), clockId: 'test' });
  t.after(observer.finish);
  assert.equal(hooks.get('session_start')({}, { model: { provider: 'fixture', id: 'model', baseUrl: url } }), undefined);
  assert.equal(globalThis.fetch, originalFetch);
  const response = await fetch(url + '/completions?private-query', { method: 'POST', headers: { authorization: 'Bearer secret-marker' }, body: payload });
  assert.equal(await response.text(), reply);
  observer.finish();
  assert.deepEqual(received, { body: payload, auth: 'Bearer secret-marker' });
  const rows = await readProviderTransport(output), sent = rows.find(row => row.phase === 'request_sent'), end = rows.find(row => row.phase === 'request_end');
  assert.equal(sent.requestBodyBytes, Buffer.byteLength(payload));
  assert.equal(sent.requestBodySha256, crypto.createHash('sha256').update(payload).digest('hex'));
  assert.equal(end.responseEntityBytes, zipped.length);
  assert.equal(end.decodedResponseBytes, null);
  assert.equal(end.contentEncoding, 'gzip');
  assert.equal(end.category, 'model');
  assert.equal(rows.at(-1).complete, true);
  assert.equal(rows.at(-1).retryWaitMs, null);
  assert.equal(globalThis.fetch, originalFetch);
  const raw = fs.readFileSync(output, 'utf8');
  for (const secret of [payload, reply, 'secret-marker', 'private-query', url]) assert.equal(raw.includes(secret), false);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
});

test('observation failure and unfinished requests remain incomplete without replacing requests or inventing zero bytes', async () => {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'consumption-provider-failure-'));
  const callbacks = new Map(), output = path.join(base, 'transport.jsonl');
  const observer = observeProviderTransport({ on() {} },
    { diagnostics: { subscribe(name, callback) { callbacks.set(name, callback); }, unsubscribe() {} },
      fs, crypto, path, output, checkoutRoot: process.cwd(), clockId: 'test' });
  callbacks.get('undici:request:create')({ request: { origin: 'https://private.example', path: '/secret', method: 'POST' } });
  callbacks.get('undici:request:bodySent')({ request: {} });
  observer.finish();
  const rows = await readProviderTransport(output);
  assert.equal(rows.at(-1).complete, false);
  assert.equal(rows.at(-1).errors, 1);
  assert.deepEqual(rows.at(-1).incompleteRequestIds, [1]);
  assert.equal(rows.some(row => row.phase === 'request_end'), false);
  assert.equal(rows.find(row => row.phase === 'request_start').declaredRequestBodyBytes, null);
  assert.throws(() => observeProviderTransport({ on() {} },
    { diagnostics, fs, crypto, path, output: path.join(base, 'rejected.jsonl'), checkoutRoot: base, clockId: 'test' }),
    /OUTSIDE_CHECKOUT/);
});

function terminalTrace(output) {
  const callbacks = new Map(), hooks = new Map();
  const observer = observeProviderTransport({ on(name, callback) { hooks.set(name, callback); } },
    { diagnostics: { subscribe(name, callback) { callbacks.set(name, callback); }, unsubscribe() {} },
      fs, crypto, path, output, checkoutRoot: process.cwd(), clockId: 'reader-test' });
  hooks.get('session_start')({}, { model: { provider: 'fixture', id: 'model', baseUrl: 'https://fixture.invalid' } });
  const emit = (name, event) => callbacks.get('undici:request:' + name)(event);
  for (const failure of [true, false]) {
    const request = { origin: 'https://fixture.invalid', path: '/chat/completions', method: 'POST' };
    emit('create', { request }); emit('bodySent', { request });
    emit('headers', { request, response: { statusCode: 200, headers: [] } });
    if (failure) emit('error', { request, error: { code: 20 } });
    else emit('trailers', { request });
  }
  observer.finish();
  return fs.readFileSync(output, 'utf8').trimEnd().split('\n').map(JSON.parse);
}

// Resealing separates structural/lifecycle rejection from ordinary hash damage.
function reseal(rows) {
  let previous = null;
  return rows.map((row, index) => {
    const { eventSha256, ...body } = row;
    const next = { ...body, sequence: index + 1, previousSha256: previous };
    previous = crypto.createHash('sha256').update(JSON.stringify(next)).digest('hex');
    return { ...next, eventSha256: previous };
  });
}

test('reader verifies complete lines, boundaries, clock, counts and one terminal per request while retaining code-20 failures', async t => {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'consumption-provider-reader-'));
  const original = path.join(base, 'original.jsonl'), trace = terminalTrace(original);
  const observed = await readProviderTransport(original);
  assert.equal(observed.at(-1).complete, true); assert.equal(observed.at(-1).errors, 0);
  assert.equal(observed.find(row => row.phase === 'request_end').errorCode, 20);
  assert.equal(observed.find(row => row.phase === 'request_end').outcome, 'failure');
  const changed = (phase, update) => trace.map(row => row.phase === phase ? { ...row, ...update } : row);
  const duplicate = trace.flatMap(row => row.phase === 'request_end' && row.id === 2 ? [row, row] : [row]);
  const cases = [
    ['missing-paired-request-lines', trace.filter(row => row.id !== 2)],
    ['missing-paired-lines-resealed', reseal(trace.filter(row => row.id !== 2))],
    ['duplicate-terminal-resealed', reseal(duplicate)],
    ['changed-payload', changed('request_sent', { requestBodyBytes: 99 })],
    ['wrong-clock-resealed', reseal(changed('model_selected', { clockId: 'another-clock' }))],
    ['backward-clock-resealed', reseal(changed('request_end', { monotonicNs: '0' }))],
    ['wrong-attempt-count-resealed', reseal(changed('transport_end', { attempts: 3 }))],
    ['missing-transport-start', reseal(trace.slice(1))],
    ['missing-transport-end', trace.slice(0, -1)],
    ['unfinished-marked-complete', reseal(trace.filter(row => row.phase !== 'request_end' || row.id !== 2))],
  ];
  for (const [name, rows] of cases) await t.test(name, async () => {
    const file = path.join(base, name + '.jsonl');
    // Every malformed fixture still ends with a complete JSON line and newline.
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    await assert.rejects(() => readProviderTransport(file), /PROVIDER_TRACE_/);
  });
});

function protocolTrace(directory, name, { chunks, api = 'openai-completions', status = 200,
  contentType = 'text/event-stream; charset=utf-8', encoding = 'identity', model = true,
  error = { name: 'AbortError', code: 20 } } = {}) {
  const callbacks = new Map(), hooks = new Map(), output = path.join(directory, name + '.jsonl');
  const observer = observeProviderTransport({ on(event, callback) { hooks.set(event, callback); } },
    { diagnostics: { subscribe(event, callback) { callbacks.set(event, callback); }, unsubscribe() {} },
      fs, crypto, path, output, checkoutRoot: process.cwd(), clockId: 'protocol-test' });
  const context = { model: { provider: 'fixture', id: 'model', api, baseUrl: 'https://fixture.invalid' } };
  hooks.get('session_start')({}, context);
  hooks.get('before_provider_request')?.({ payload: {} }, context);
  const request = { origin: model ? 'https://fixture.invalid' : 'https://other.invalid', path: '/chat/completions', method: 'POST' };
  const emit = (event, fields = {}) => callbacks.get('undici:request:' + event)({ request, ...fields });
  emit('create'); emit('bodySent');
  emit('headers', { response: { statusCode: status, headers: ['content-type', contentType, 'content-encoding', encoding] } });
  for (const chunk of chunks) emit('bodyChunkReceived', { chunk: Buffer.from(chunk) });
  if (error) emit('error', { error }); else emit('trailers');
  observer.finish();
  return { output, rows: fs.readFileSync(output, 'utf8').trimEnd().split('\n').map(JSON.parse) };
}

const normalProtocolReply = () => ({ role: 'assistant', provider: 'fixture', model: 'model',
  responseModel: 'controlled/actual-route', responseModelStatus: 'reported', stopReason: 'stop',
  usage: { input: 17, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 22 } });

test('SSE protocol targets preserve HTTP failure and distinguish DONE cancellation from finish and usage without DONE', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'consumption-provider-sse-'));
  const finished = 'data: {"choices":[{"finish_reason":"stop"}],"usage":{"total_tokens":22},"text":"private-body-secret"}\n\n';
  const cases = [
    ['immediate-eof', [finished, 'data: [DONE]\n\n'], null, 'http-complete'],
    ['done-http-open', [finished, 'data: [DO', 'NE]\n', '\n'], { name: 'AbortError', code: 20 }, 'sse-done-before-http-cancel'],
    ['finish-usage-without-done', [finished], { name: 'AbortError', code: 20 }, null],
    ['before-finish', ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'], { name: 'AbortError', code: 20 }, null],
  ];
  assert.equal(typeof providerObserver.providerApplicationCompletion, 'function');
  for (const [name, chunks, error, expected] of cases) {
    const { output, rows } = protocolTrace(directory, name, { chunks, error }), end = rows.find(row => row.phase === 'request_end');
    assert.equal(end.outcome, error ? 'failure' : 'completed', name);
    assert.equal(end.errorCode, error ? 20 : null, name);
    assert.equal(end.errorName, error ? 'AbortError' : null, name);
    assert.equal(providerObserver.providerApplicationCompletion(end, normalProtocolReply()), expected, name);
    assert.equal(fs.readFileSync(output, 'utf8').includes('private-body-secret'), false);
    assert.equal(rows.at(-1).complete, true, 'An observed HTTP failure still has a closed observer lifecycle');
  }
});

test('SSE completion accepts an unreported response model without inventing one', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'consumption-provider-unknown-model-'));
  const end = protocolTrace(directory, 'done', { chunks: ['data: [DONE]\n\n'] }).rows.find(row => row.phase === 'request_end');
  for (const stopReason of ['stop', 'toolUse']) {
    const reply = { ...normalProtocolReply(), stopReason, responseModel: null, responseModelStatus: 'unreported' };
    const before = structuredClone(reply);
    assert.equal(providerObserver.providerApplicationCompletion(end, reply), 'sse-done-before-http-cancel');
    assert.deepEqual(reply, before, 'An absent response model remains unknown');
  }
});

test('SSE completion requires an independent complete single data event across byte and line boundaries', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'consumption-provider-sse-framing-'));
  const cases = [
    ['lf', ['data:[DONE]\n\n'], true],
    ['crlf-bytewise', [...Buffer.from('data: [DONE]\r\n\r\n')].map(byte => Buffer.from([byte])), true],
    ['cr', ['data: [DONE]\r\r'], true],
    ['comments', [': keepalive\ndata: [DONE]\n\n'], true],
    ['truncated-event', ['data: [DONE]\n'], false],
    ['truncated-line', ['data: [DONE]'], false],
    ['json-string', ['data: {"text":"data: [DONE]\\n\\n"}\n\n'], false],
    ['multiple-data', ['data: [DONE]\ndata:\n\n'], false],
    ['multiple-events', ['data: [DONE]\n\ndata: [DONE]\n\n'], false],
    ['event-field', ['event: error\ndata: [DONE]\n\n'], false],
    ['long-line', ['data: [DONE]' + ' '.repeat(100000) + '\n\n'], false],
    ['long-prior-event', ['data: ' + 'x'.repeat(100000) + '\n\ndata: [DONE]\n\n'], true],
    ['event-overflow', [(': keepalive\n').repeat(10000) + 'data: [DONE]\n\n'], false],
  ];
  for (const [name, chunks, accepted] of cases) {
    const { rows } = protocolTrace(directory, name, { chunks }), end = rows.find(row => row.phase === 'request_end');
    assert.equal(end.sseCompletion?.method, 'bounded-sse-data-done-v1', name);
    assert.equal(end.sseCompletion.doneEvents === 1, accepted, name);
    assert.ok(Buffer.byteLength(JSON.stringify(end)) < 1200, 'No unbounded body/event data enters the trace');
  }
});

test('SSE application completion rejects unsupported transport, error, API and assistant evidence', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'consumption-provider-sse-gates-'));
  assert.equal(typeof providerObserver.providerApplicationCompletion, 'function');
  let sequence = 0;
  for (const changed of [{ api: 'openai-responses' }, { status: 503 }, { model: false }, { encoding: 'gzip' },
    { encoding: 'unknown' }, { contentType: 'application/json' }, { error: { name: 'Error', code: 20 } },
    { error: { name: 'AbortError', code: '20' } }, { error: { name: 'AbortError', code: 'ECONNRESET' } },
    { error: { name: 'secret-header-value with spaces', code: 20 } }]) {
    const { rows } = protocolTrace(directory, 'gate-' + sequence++, { chunks: ['data: [DONE]\n\n'], ...changed });
    const end = rows.find(row => row.phase === 'request_end');
    assert.equal(providerObserver.providerApplicationCompletion(end, normalProtocolReply()), null, JSON.stringify(changed));
    assert.equal(JSON.stringify(rows).includes('secret-header-value'), false);
  }
  const end = protocolTrace(directory, 'valid', { chunks: ['data: [DONE]\n\n'] }).rows.find(row => row.phase === 'request_end');
  for (const mutate of [reply => { reply.stopReason = 'length'; }, reply => { reply.stopReason = 'aborted'; },
    reply => { reply.stopReason = 'error'; }, reply => { delete reply.stopReason; }, reply => { reply.role = 'toolResult'; },
    reply => { delete reply.provider; }, reply => { delete reply.model; },
    ...['', ' ', 1, false, {}, [], null].map(value => reply => { reply.responseModel = value; }),
    reply => { delete reply.responseModelStatus; }, reply => { reply.responseModelStatus = 'invalid'; },
    reply => { reply.responseModelStatus = 'unreported'; },
    reply => { reply.usage.input = null; }, reply => { reply.usage.totalTokens = 0; }]) {
    const reply = normalProtocolReply(); mutate(reply);
    assert.equal(providerObserver.providerApplicationCompletion(end, reply), null);
  }
  const toolUse = normalProtocolReply(); toolUse.stopReason = 'toolUse';
  assert.equal(providerObserver.providerApplicationCompletion(end, toolUse), 'sse-done-before-http-cancel');
  const legacy = { category: 'model', status: 200, outcome: 'failure', errorCode: 20 };
  assert.equal(providerObserver.providerApplicationCompletion(legacy, normalProtocolReply()), null, 'Old evidence without protocol proof stays failed');
});



test('OpenAI API route separates same-origin MCP traffic while retaining exact request evidence', async t => {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'provider-endpoint-')), output = path.join(base, 'transport.jsonl');
  const hooks = new Map(), originalFetch = globalThis.fetch, payload = '{"model":"fixture","messages":[]}';
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the real request without modifying it. */ }
    response.writeHead(request.url === '/mcp' ? request.method === 'GET' ? 405 : 202 : 200);
    response.end('actual reply');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const observer = observeProviderTransport({ on(event, callback) { hooks.set(event, callback); } },
    { diagnostics, fs, crypto, path, output, checkoutRoot: process.cwd(), clockId: 'endpoint-test' });
  t.after(observer.finish);
  hooks.get('session_start')({}, { model: { provider: 'fixture', id: 'model', api: 'openai-completions', baseUrl: origin + '/v1/' } });
  for (const [route, method] of [['/v1/chat/completions?opaque=private-query', 'POST'], ['/mcp', 'POST'], ['/mcp', 'GET'],
    ['/v1/chat/completions-other', 'POST']]) {
    const response = await fetch(origin + route, { method, ...(method === 'POST' ? { body: payload } : {}) });
    assert.equal(await response.text(), 'actual reply');
  }
  observer.finish();
  const rows = await readProviderTransport(output), starts = rows.filter(row => row.phase === 'request_start');
  assert.deepEqual(starts.map(row => row.category), ['model', 'other', 'other', 'other']);
  assert.deepEqual(rows.filter(row => row.phase === 'request_end').map(row => row.status), [200, 202, 405, 200]);
  assert.equal(rows.find(row => row.phase === 'request_sent' && row.id === starts[0].id).requestBodySha256,
    crypto.createHash('sha256').update(payload).digest('hex'));
  const selected = rows.find(row => row.phase === 'model_selected');
  assert.equal(selected.endpointPathSha256, crypto.createHash('sha256').update('/v1/chat/completions').digest('hex'));
  assert.equal(selected.endpointMethod, 'openai-chat-completions-route');
  assert.equal(rows.at(-1).complete, true); assert.equal(globalThis.fetch, originalFetch);
  const raw = fs.readFileSync(output, 'utf8');
  for (const secret of [payload, 'private-query', origin]) assert.equal(raw.includes(secret), false);
});

test('unsupported provider APIs keep conservative accounting and cannot hide unmatched same-origin requests', async () => {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'provider-unknown-endpoint-')), output = path.join(base, 'transport.jsonl');
  const callbacks = new Map(), hooks = new Map();
  const observer = observeProviderTransport({ on(event, callback) { hooks.set(event, callback); } },
    { diagnostics: { subscribe(event, callback) { callbacks.set(event, callback); }, unsubscribe() {} },
      fs, crypto, path, output, checkoutRoot: process.cwd(), clockId: 'unknown-api' });
  hooks.get('session_start')({}, { model: { provider: 'future', id: 'model', api: 'unknown-protocol', baseUrl: 'https://future.invalid/api' } });
  const request = { origin: 'https://future.invalid', path: '/unrecognized', method: 'POST' };
  callbacks.get('undici:request:create')({ request });
  callbacks.get('undici:request:bodySent')({ request });
  callbacks.get('undici:request:error')({ request, error: { name: 'Error', code: 'ECONNRESET' } });
  observer.finish();
  const rows = await readProviderTransport(output);
  assert.equal(rows.find(row => row.phase === 'request_start').category, 'model');
  assert.equal(rows.find(row => row.phase === 'model_selected').endpointMethod, 'conservative-origin');
  assert.equal(rows.find(row => row.phase === 'request_end').errorCode, 'ECONNRESET');
});

const responsesReply = () => ({ ...normalProtocolReply(), api: 'openai-responses',
  responseId: 'resp_fixture', rawStopReason: 'completed',
  usage: { input: 16, output: 5, cacheRead: 3, cacheWrite: 1, totalTokens: 25, reasoning: 2 } });
const responsesTerminal = (changes = {}) => ({ id: 'resp_fixture', model: 'controlled/actual-route', status: 'completed',
  usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25,
    input_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 }, output_tokens_details: { reasoning_tokens: 2 } },
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'private-response-body-中文' }] }], ...changes });
const responsesEvent = (type, response) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, response }) + '\n\n';

function responsesTrace(directory, name, { chunks, headers = { 'Content-Type': 'text/event-stream; charset=utf-8' },
  route = '/v1/responses', method = 'POST', error = null } = {}) {
  const callbacks = new Map(), hooks = new Map(), output = path.join(directory, name + '.jsonl');
  const observer = observeProviderTransport({ on(event, callback) { hooks.set(event, callback); } },
    { diagnostics: { subscribe(event, callback) { callbacks.set(event, callback); }, unsubscribe() {} },
      fs, crypto, path, output, checkoutRoot: process.cwd(), clockId: 'responses-test' });
  hooks.get('session_start')({}, { model: { provider: 'fixture', id: 'model', api: 'openai-responses', baseUrl: 'https://fixture.invalid/v1/' } });
  const request = { origin: 'https://fixture.invalid', path: route, method };
  const emit = (event, fields = {}) => callbacks.get('undici:request:' + event)({ request, ...fields });
  emit('create'); emit('bodySent'); emit('headers', { response: { statusCode: 200, headers } });
  for (const chunk of chunks) emit('bodyChunkReceived', { chunk: Buffer.from(chunk) });
  if (error) emit('error', { error }); else emit('trailers');
  observer.finish();
  const rows = fs.readFileSync(output, 'utf8').trimEnd().split('\n').map(JSON.parse);
  return { output, rows, end: rows.find(row => row.phase === 'request_end') };
}

test('Responses terminal independently binds exact API route, response identity, model and usage across H1/H2 header shapes', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'provider-responses-'));
  const wire = responsesEvent('response.created', { id: 'resp_fixture', model: 'controlled/actual-route', status: 'in_progress' })
    + responsesEvent('response.completed', responsesTerminal());
  for (const [name, headers] of [
    ['h1', [Buffer.from('content-type'), Buffer.from('text/event-stream; charset=utf-8')]],
    ['h2', { ':status': 200, 'Content-Type': 'text/event-stream; charset=utf-8' }],
  ]) {
    const { output, rows, end } = responsesTrace(directory, name, { headers, chunks: [...Buffer.from(wire)].map(byte => Buffer.from([byte])) });
    assert.equal(end.modelApi, 'openai-responses');
    assert.equal(rows.find(row => row.phase === 'model_selected').endpointMethod, 'openai-responses-route');
    assert.equal(end.sseCompletion.method, 'bounded-openai-responses-sse-v1');
    assert.equal(end.sseCompletion.complete, true);
    assert.equal(end.sseCompletion.terminalEvents, 1);
    assert.equal(end.sseCompletion.response.id, 'resp_fixture');
    assert.equal(end.sseCompletion.response.model, 'controlled/actual-route');
    assert.equal(end.responseEntityBytes, Buffer.byteLength(wire));
    assert.equal(end.responseEntitySha256, crypto.createHash('sha256').update(wire).digest('hex'));
    assert.equal(providerObserver.providerApplicationCompletion(end, responsesReply()), 'responses-completed');
    assert.equal(fs.readFileSync(output, 'utf8').includes('private-response-body'), false);
  }
  for (const [name, route, method] of [['mcp', '/mcp', 'POST'], ['suffix', '/v1/responses-other', 'POST'],
    ['wrong-method', '/v1/responses', 'GET']]) {
    const { rows, end } = responsesTrace(directory, name, { chunks: [wire], route, method });
    assert.equal(rows.find(row => row.phase === 'request_start').category, 'other', name);
    assert.equal(providerObserver.providerApplicationCompletion(end, responsesReply()), null, name);
  }
});

test('Responses HTTP success, native success and DONE cannot replace an independent valid terminal', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'provider-responses-negative-'));
  const complete = responsesEvent('response.completed', responsesTerminal());
  const cases = [
    ['http-only', ['data: {"type":"response.output_text.delta","delta":"private"}\n\n']],
    ['done-only', ['data: [DONE]\n\n']],
    ['truncated', [complete.trimEnd()]],
    ['duplicate', [complete, complete]],
    ['wrong-id', [responsesEvent('response.created', { id: 'resp_other' }), complete]],
    ['wrong-event-name', [complete.replace('event: response.completed', 'event: response.failed')]],
    ['malformed', ['event: response.completed\ndata: {broken}\n\n', complete]],
    ['midstream-bom-data', [': keepalive\n\n' + complete.replace('data:', '\uFEFFdata:')]],
    ['incomplete', [responsesEvent('response.incomplete', responsesTerminal({ status: 'incomplete' }))]],
    ['failed', [responsesEvent('response.failed', responsesTerminal({ status: 'failed' }))]],
    ['error-after', [complete, 'event: error\ndata: {"type":"error","message":"private"}\n\n']],
    ['oversized', ['data: ' + ' '.repeat(1048577) + '\n\n', complete]],
    ['non-sse', [complete], { 'content-type': 'application/json' }],
    ['compressed', [complete], { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' }],
  ];
  for (const [name, chunks, headers] of cases) {
    const { end } = responsesTrace(directory, name, { chunks, ...(headers ? { headers } : {}) });
    assert.equal(providerObserver.providerApplicationCompletion(end, responsesReply()), null, name);
  }
  const end = responsesTrace(directory, 'good', { chunks: [complete] }).end;
  assert.equal(providerObserver.providerApplicationCompletion({ ...end, modelApi: 'other', sseCompletion: null }, responsesReply()), null,
    'Old origin-only evidence cannot acquire a Responses terminal from the native message');
  for (const [name, change] of [
    ['wrong-native-id', value => { value.responseId = 'resp_wrong'; }],
    ['wrong-native-status', value => { value.rawStopReason = 'incomplete'; }],
    ['wrong-native-api', value => { value.api = 'openai-completions'; }],
    ['wrong-native-model', value => { value.responseModel = 'different-model'; }],
    ['wrong-native-usage', value => { value.usage.cacheRead++; }],
    ['missing-native-usage', value => { value.usage.totalTokens = null; }],
  ]) {
    const reply = responsesReply(); change(reply);
    assert.equal(providerObserver.providerApplicationCompletion(end, reply), null, name);
  }
  for (const [name, change] of [
    ['missing-id', value => { delete value.id; }],
    ['missing-model', value => { delete value.model; }],
    ['missing-usage', value => { delete value.usage; }],
    ['usage-negative', value => { value.usage.input_tokens = -1; }],
    ['usage-total', value => { value.usage.total_tokens++; }],
    ['usage-cache', value => { value.usage.input_tokens_details.cached_tokens = 21; }],
    ['invalid-detail-object', value => { value.usage.input_tokens_details = 'unknown'; }],
  ]) {
    const response = responsesTerminal(); change(response);
    const bad = responsesTrace(directory, name, { chunks: [responsesEvent('response.completed', response)] }).end;
    assert.equal(providerObserver.providerApplicationCompletion(bad, responsesReply()), null, name);
  }
});

test('Responses completion preserves HTTP failure and accepts only observed terminal before precise consumer cancellation', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'provider-responses-cancel-'));
  let index = 0;
  for (const error of [{ name: 'AbortError', code: 20 }, { name: 'Error', code: 20 }, { name: 'AbortError', code: 'ECONNRESET' }]) {
    const { end } = responsesTrace(directory, 'cancel-' + index++, {
      chunks: [responsesEvent('response.completed', responsesTerminal())], error });
    assert.equal(end.outcome, 'failure');
    assert.equal(providerObserver.providerApplicationCompletion(end, responsesReply()),
      error.name === 'AbortError' && error.code === 20 ? 'responses-completed-before-http-cancel' : null);
  }
});

test('Responses passive loopback preserves retained fetch and stream bytes over real H1/H2 and excludes same-origin MCP', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'provider-responses-loopback-'));
  const selected = createRequire(process.env.NTN_SKILLS_BUILD_ENTRY ?? new URL('../packages/context-broker/package.json', import.meta.url));
  const dependency = createRequire(selected.resolve('@effect/platform-node/package.json'));
  const undiciEntry = fs.realpathSync(dependency.resolve('undici'));
  const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem'), config = path.join(directory, 'cert.cnf');
  fs.writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n', { flag: 'wx', mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', config],
    { timeout: 10000, stdio: 'pipe' });
  const payload = JSON.stringify({ model: 'model', input: [{ role: 'user', content: 'private-request-body' }], stream: true, reasoning: { effort: 'high' } });
  const sockets = new Set(), sessions = new Set(), served = [], replies = {};
  for (const protocol of ['h1', 'h2']) replies[protocol] = responsesEvent('response.created', { id: 'resp_' + protocol, model: 'controlled/actual-route' })
    + responsesEvent('response.completed', responsesTerminal({ id: 'resp_' + protocol }));
  const handle = protocol => async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    served.push({ protocol, path: request.url, method: request.method, body: body.toString('utf8'),
      httpVersion: request.httpVersion, alpn: request.socket.alpnProtocol });
    const model = request.url === '/v1/responses', text = model ? replies[protocol] : 'independent-mcp';
    response.writeHead(200, { 'content-type': model ? 'text/event-stream' : 'text/plain', 'content-encoding': 'identity' });
    const bytes = Buffer.from(text); response.write(bytes.subarray(0, 31)); response.end(bytes.subarray(31));
  };
  const tls = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  const servers = [createHttpsServer(tls, handle('h1')), createSecureServer({ ...tls, allowHTTP1: false, ALPNProtocols: ['h2'] }, handle('h2'))];
  for (const server of servers) {
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('session', session => { sessions.add(session); session.once('close', () => sessions.delete(session)); });
  }
  let child;
  try {
    for (const server of servers) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoints = servers.map((server, index) => ({ protocol: index ? 'h2' : 'h1', origin: 'https://127.0.0.1:' + server.address().port }));
    const extension = path.join(directory, 'observer.mjs'), output = path.join(directory, 'transport.jsonl');
    fs.writeFileSync(extension, providerObserver.providerTransportExtensionSource({ output, checkoutRoot: process.cwd(), clockId: 'real-responses' }), { flag: 'wx', mode: 0o600 });
    const client = path.join(directory, 'client.mjs'), consumerPath = path.join(directory, 'consumer.json');
    const code = [
      "import fs from 'node:fs';import crypto from 'node:crypto';import {createRequire} from 'node:module';",
      "const require=createRequire(import.meta.url),client=require(" + JSON.stringify(undiciEntry) + "),retainedFetch=client.fetch,retainedGlobal=globalThis.fetch;",
      "const endpoints=" + JSON.stringify(endpoints) + ",payload=" + JSON.stringify(payload) + ",hooks=new Map(),results=[];",
      "const extension=await import(" + JSON.stringify(pathToFileURL(extension).href) + ");extension.default({on:(name,callback)=>hooks.set(name,callback)});",
      "if(retainedFetch!==client.fetch||retainedGlobal!==globalThis.fetch)throw Error('Observer replaced fetch during initialization');",
      "const agents=endpoints.map(endpoint=>new client.Agent({allowH2:endpoint.protocol==='h2'}));",
      "try{for(const [index,endpoint] of endpoints.entries()){hooks.get('session_start')({}, {model:{provider:'fixture',id:'model',api:'openai-responses',baseUrl:endpoint.origin+'/v1'}});",
      "for(const route of ['/v1/responses','/mcp']){const response=await retainedFetch(endpoint.origin+route,{method:'POST',body:payload,dispatcher:agents[index]});",
      "const chunks=[];for await(const chunk of response.body)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);results.push({protocol:endpoint.protocol,route,status:response.status,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}}",
      "}finally{await Promise.all(agents.map(agent=>agent.close()));hooks.get('session_shutdown')({reason:'quit'});}",
      "if(retainedFetch!==client.fetch||retainedGlobal!==globalThis.fetch)throw Error('Fetch identity changed');",
      "fs.writeFileSync(" + JSON.stringify(consumerPath) + ",JSON.stringify({node:process.versions.node,builtinUndici:process.versions.undici,selectedUndici:require(" + JSON.stringify(dependency.resolve('undici/package.json')) + ").version,fetchUnchanged:true,selectedFetchUnchanged:true,results})+'\\n',{flag:'wx',mode:0o600});",
    ].join('\n');
    fs.writeFileSync(client, code, { flag: 'wx', mode: 0o600 });
    child = spawn(process.execPath, [client], { cwd: directory, detached: true,
      env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', NODE_EXTRA_CA_CERTS: cert },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
    const closed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} reject(new Error('Owned Responses loopback child timed out')); }, 20000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    assert.equal(closed.code, 0, stderr); assert.equal(closed.signal, null);
    const consumer = JSON.parse(fs.readFileSync(consumerPath, 'utf8')), rows = await readProviderTransport(output);
    assert.equal(consumer.fetchUnchanged, true); assert.equal(consumer.selectedFetchUnchanged, true);
    assert.equal(consumer.results.length, 4); assert.equal(served.length, 4);
    const ends = rows.filter(row => row.phase === 'request_end');
    assert.deepEqual(ends.map(row => row.category), ['model', 'other', 'model', 'other']);
    for (const [index, observed] of consumer.results.entries()) {
      const expected = observed.route === '/v1/responses' ? replies[observed.protocol] : 'independent-mcp';
      assert.equal(observed.status, 200); assert.equal(observed.bytes, Buffer.byteLength(expected));
      assert.equal(observed.sha256, crypto.createHash('sha256').update(expected).digest('hex'));
      assert.equal(served[index].body, payload); assert.equal(served[index].method, 'POST');
      assert.equal(served[index].httpVersion, observed.protocol === 'h2' ? '2.0' : '1.1');
      assert.equal(served[index].alpn, observed.protocol === 'h2' ? 'h2' : 'http/1.1');
      assert.equal(ends[index].responseEntitySha256, observed.sha256);
      assert.equal(ends[index].responseEntityBytes, observed.bytes);
      if (ends[index].category === 'model') assert.equal(providerObserver.providerApplicationCompletion(ends[index],
        { ...responsesReply(), responseId: 'resp_' + observed.protocol }), 'responses-completed');
    }
    const raw = fs.readFileSync(output, 'utf8');
    for (const forbidden of ['private-request-body', 'private-response-body', ...endpoints.map(value => value.origin)])
      assert.equal(raw.includes(forbidden), false);
    assert.equal(rows.at(-1).complete, true);
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    for (const session of sessions) session.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
});
