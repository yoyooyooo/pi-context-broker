import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { observeOwnedObjectReads, assertCatalogCancellationBoundary } from './notion-sdk-observers.mjs';

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
