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

