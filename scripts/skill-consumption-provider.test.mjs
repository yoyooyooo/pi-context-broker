import test from 'node:test';
import assert from 'node:assert/strict';
import * as diagnostics from 'node:diagnostics_channel';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { observeProviderTransport, readProviderTransport } from './skill-consumption-provider.mjs';
import * as providerObserver from './skill-consumption-provider.mjs';

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
    const request = { origin: 'https://fixture.invalid', path: '/completions', method: 'POST' };
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
  const request = { origin: model ? 'https://fixture.invalid' : 'https://other.invalid', path: '/completions', method: 'POST' };
  const emit = (event, fields = {}) => callbacks.get('undici:request:' + event)({ request, ...fields });
  emit('create'); emit('bodySent');
  emit('headers', { response: { statusCode: status, headers: ['content-type', contentType, 'content-encoding', encoding] } });
  for (const chunk of chunks) emit('bodyChunkReceived', { chunk: Buffer.from(chunk) });
  if (error) emit('error', { error }); else emit('trailers');
  observer.finish();
  return { output, rows: fs.readFileSync(output, 'utf8').trimEnd().split('\n').map(JSON.parse) };
}

const normalProtocolReply = () => ({ role: 'assistant', provider: 'fixture', model: 'model',
  responseModel: 'controlled/actual-route', stopReason: 'stop',
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
    reply => { delete reply.provider; }, reply => { delete reply.model; }, reply => { delete reply.responseModel; },
    reply => { reply.usage.input = null; }, reply => { reply.usage.totalTokens = 0; }]) {
    const reply = normalProtocolReply(); mutate(reply);
    assert.equal(providerObserver.providerApplicationCompletion(end, reply), null);
  }
  const toolUse = normalProtocolReply(); toolUse.stopReason = 'toolUse';
  assert.equal(providerObserver.providerApplicationCompletion(end, toolUse), 'sse-done-before-http-cancel');
  const legacy = { category: 'model', status: 200, outcome: 'failure', errorCode: 20 };
  assert.equal(providerObserver.providerApplicationCompletion(legacy, normalProtocolReply()), null, 'Old evidence without protocol proof stays failed');
});

