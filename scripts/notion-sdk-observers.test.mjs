import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { observeOwnedObjectReads, assertCatalogCancellationBoundary, waitForSdkOperations } from './notion-sdk-observers.mjs';

test('owned read observer preserves returned bytes, errors, callbacks and restores the actual APIs', async () => {
  const bytes = Buffer.from('original bytes'), absent = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const read = path => { if (path.endsWith('missing')) throw absent; return bytes; };
  const fs = { readFile(path, callback) { try { callback(null, read(path)); } catch (error) { callback(error); } }, readFileSync: read };
  const fsPromises = { async readFile(path) { return read(path); } };
  const original = { ...fs, promise: fsPromises.readFile }, events = [];
  const observer = observeOwnedObjectReads({ fs, fsPromises, objects: '/owned/objects', record: event => events.push(event), hash: bytes => createHash('sha256').update(bytes).digest('hex') });
  assert.equal(fs.readFileSync('/owned/objects/abc'), bytes);
  assert.equal(await fsPromises.readFile('/owned/objects/abc'), bytes);
  await new Promise((resolve, reject) => fs.readFile('/owned/objects/abc', (error, result) => { if (error) reject(error); else { assert.equal(result, bytes); resolve(); } }));
  assert.throws(() => fs.readFileSync('/owned/objects/missing'), error => error === absent);
  await assert.rejects(fsPromises.readFile('/owned/objects/missing'), error => error === absent);
  fs.readFileSync('/other/path');
  assert.deepEqual(observer.finish(), { reads: 5, pending_reads: 0, errors: 0 });
  assert.equal(events.filter(event => event.event === 'start').length, 5);
  assert.equal(events.filter(event => event.event === 'end' && event.code === 'ENOENT').length, 2);
  for (const event of events.filter(event => event.event === 'end' && event.code === null)) assert.equal(event.bytes, bytes.length);
  assert.equal(fs.readFile, original.readFile); assert.equal(fs.readFileSync, original.readFileSync); assert.equal(fsPromises.readFile, original.promise);
});

test('catalog cancellation requires the same process and exact native boundary interval', () => {
  const start = { operation: 'list', observer_pid: 1, monotonic_ns: '100' }, end = { ...start, monotonic_ns: '200' };
  const good = { type: 'session_shutdown', pid: 1, monotonic_ns: '150' };
  assert.equal(assertCatalogCancellationBoundary(start, end, [good]), good);
  for (const changed of [{ pid: 2 }, { monotonic_ns: '201' }, { monotonic_ns: '99' }, { type: 'agent_end' }])
    assert.throws(() => assertCatalogCancellationBoundary(start, end, [{ ...good, ...changed }]));
  assert.throws(() => assertCatalogCancellationBoundary({ ...start, operation: 'consume' }, { ...end, operation: 'consume' }, [good]));
});

const sdkEvent = (event, id, pid = 42) => JSON.stringify({ kind: 'context-broker.notion-sdk',
  observer_pid: pid, pid, event, id, operation: 'library-selection' });
async function sdkLog(text) {
  const directory = await mkdtemp(join(tmpdir(), 'current-sdk-settle-test-'));
  const path = join(directory, 'sdk.jsonl'); await writeFile(path, text);
  return path;
}

test('SDK EOF readiness rejects equal counts with different operation IDs', async () => {
  const path = await sdkLog(sdkEvent('start', 'a') + '\n' + sdkEvent('end', 'b') + '\n');
  await assert.rejects(waitForSdkOperations(path, 42), error => {
    assert.equal(error.code, 'CURRENT_SDK_SETTLE_INVALID');
    assert.equal(error.receipt.start_count, error.receipt.end_count);
    assert.deepEqual(error.receipt.pending_ids, ['a']);
    assert.deepEqual(error.receipt.errors.map(row => row.code), ['end_without_start']);
    return true;
  });
});

test('SDK EOF timeout retains exact pending IDs and cannot borrow another Pi completion', async () => {
  const path = await sdkLog([sdkEvent('start', 'a'), sdkEvent('start', 'a', 99), sdkEvent('end', 'a', 99)].join('\n') + '\n');
  await assert.rejects(waitForSdkOperations(path, 42, { timeoutMs: 1 }), error => {
    assert.equal(error.code, 'CURRENT_SDK_SETTLE_TIMEOUT');
    assert.equal(error.receipt.observer_pid, 42);
    assert.deepEqual(error.receipt.pending_ids, ['a']);
    assert.equal(error.receipt.start_count, 1); assert.equal(error.receipt.end_count, 0);
    assert.deepEqual(error.receipt.errors, []);
    assert.match(error.receipt.observed_sha256, /^[a-f0-9]{64}$/);
    return true;
  });
});

test('SDK EOF readiness waits for the final newline even when the tail is valid JSON', async () => {
  const path = await sdkLog([sdkEvent('start', 'a'), sdkEvent('end', 'a'), sdkEvent('start', 'late')].join('\n'));
  await assert.rejects(waitForSdkOperations(path, 42, { timeoutMs: 1 }), error => {
    assert.equal(error.code, 'CURRENT_SDK_SETTLE_TIMEOUT');
    assert.deepEqual(error.receipt.pending_ids, []);
    assert.equal(error.receipt.start_count, 1); assert.equal(error.receipt.end_count, 1);
    assert.ok(error.receipt.partial_tail_bytes > 0);
    return true;
  });
  await appendFile(path, '\n' + sdkEvent('end', 'late') + '\n');
  const settled = await waitForSdkOperations(path, 42);
  assert.equal(settled.status, 'settled'); assert.equal(settled.partial_tail_bytes, 0);
  assert.deepEqual(settled.start_ids, ['a', 'late']); assert.deepEqual(settled.end_ids, ['a', 'late']);
  assert.deepEqual(settled.pending_ids, []);
});
