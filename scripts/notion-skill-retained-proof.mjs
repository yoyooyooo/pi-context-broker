import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const digest = /^[0-9a-f]{64}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const bundleId = /^bundle-[0-9a-f]{64}$/u;
const CHUNK_BYTES = 32768;

function object(value, keys, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), label + ' must be an object');
  assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(value)), label + ' must be plain JSON');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(typeof key === 'string' && descriptor.enumerable && Object.hasOwn(descriptor, 'value'), label + ' must contain JSON data properties');
  }
  if (keys) assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label + ' fields differ');
  return value;
}

function array(value, maximum, label) {
  assert.ok(Array.isArray(value) && value.length <= maximum, label + ' must be a bounded array');
  assert.deepEqual(Reflect.ownKeys(value), [...Array.from({ length: value.length }, (_, i) => String(i)), 'length'], label + ' must be a dense JSON array');
  for (let i = 0; i < value.length; i++) assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(i)), 'value'), label + ' cannot contain accessors');
  return value;
}

function bytes(value, maximum, minimum, label) {
  assert.ok(Number.isSafeInteger(value) && value >= minimum && value <= maximum, label + ' has an invalid byte length');
}

function path(value) {
  assert.ok(typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0') && !value.startsWith('/') && !/^[a-zA-Z]:/u.test(value), 'File path must be relative POSIX');
  assert.ok(value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'File path must already be normalized');
}

// Matches canonicalSharedJson for the strict JSON structures validated below.
// Object keys use code-unit order; body/path text is never normalized.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

function manifest(value, libraryId, owner, chunkFacts) {
  object(value, ['version', 'kind', 'library_id', 'skill_page_id', 'entrypoint', 'files', 'archive'], 'Retained manifest');
  assert.equal(value.version, 1); assert.equal(value.kind, 'retained_bundle');
  assert.equal(value.library_id, libraryId); assert.equal(value.skill_page_id, owner);
  assert.match(value.skill_page_id, uuid);
  let previous = '', total = 0;
  const files = array(value.files, 10000, 'Manifest files');
  assert.ok(files.length > 0);
  for (const file of files) {
    object(file, ['path', 'sha256', 'bytes'], 'Manifest file');
    path(file.path); assert.ok(file.path > previous, 'File paths must be unique and sorted');
    previous = file.path; assert.match(file.sha256, digest); bytes(file.bytes, 64 * 1024 * 1024, 0, 'File');
    total += file.bytes;
  }
  assert.ok(total <= 128 * 1024 * 1024, 'Manifest file bytes exceed the retained-source limit');
  assert.ok(files.some(file => file.path === value.entrypoint), 'Entrypoint must identify an exact manifest file');
  const archive = object(value.archive, ['format', 'sha256', 'bytes', 'chunks'], 'Archive');
  assert.equal(archive.format, 'zip'); assert.match(archive.sha256, digest);
  bytes(archive.bytes, 32 * 1024 * 1024, 1, 'Archive');
  const chunks = array(archive.chunks, 1024, 'Archive chunks');
  assert.ok(chunks.length > 0);
  let archiveBytes = 0;
  for (const [index, chunk] of chunks.entries()) {
    object(chunk, ['object_id', 'sha256', 'bytes'], 'Archive chunk');
    assert.match(chunk.sha256, digest); assert.equal(chunk.object_id, 'chunk-' + chunk.sha256);
    bytes(chunk.bytes, CHUNK_BYTES, 1, 'Chunk');
    if (index < chunks.length - 1) assert.equal(chunk.bytes, CHUNK_BYTES, 'Only the final chunk may be shorter');
    const previousBytes = chunkFacts.get(chunk.object_id);
    if (previousBytes !== undefined) assert.equal(previousBytes, chunk.bytes, 'One immutable chunk has conflicting byte lengths');
    chunkFacts.set(chunk.object_id, chunk.bytes);
    archiveBytes += chunk.bytes;
  }
  assert.equal(archiveBytes, archive.bytes, 'Chunks must cover the entire archive');
  if (chunks.length === 1) assert.equal(chunks[0].sha256, archive.sha256, 'A one-chunk archive has the same content checksum');
  return value;
}

/** Integrity checks for supplementary source metadata, with no I/O. This does
 * not establish consumption, a downloaded archive, or remote authenticity on
 * its own. The caller must bind each bundle ID to the SAME actual consumer
 * receipt and its owner to an actual successful public read in this scope. */
export function verifyRetainedSourceProof(proof, { scope, libraryId, recordsDataSourceId }) {
  assert.match(scope, digest); assert.match(libraryId, /^library-[a-zA-Z0-9-]{1,80}$/u); assert.match(recordsDataSourceId, uuid);
  object(proof, null, 'Retained source proof');
  assert.equal(proof.version, 1); assert.equal(proof.kind, 'retained-source-ownership'); assert.equal(proof.status, 'verified');
  assert.equal(proof.scope, scope); assert.equal(proof.library_id, libraryId); assert.equal(proof.records_data_source_id, recordsDataSourceId);
  const records = array(proof.records, 80, 'Source records');
  assert.ok(records.length > 0, 'A verified proof must contain a source record');
  const pages = new Set(), bundles = new Set(), chunkFacts = new Map();
  for (const record of records) {
    object(record, ['page_id', 'record_id', 'operation_id', 'kind', 'entity_id', 'hash', 'payload', 'skill_page_id'], 'Source record');
    assert.match(record.page_id, uuid); assert.match(record.skill_page_id, uuid);
    assert.ok(!pages.has(record.page_id), 'One physical source page cannot provide multiple facts'); pages.add(record.page_id);
    assert.equal(record.kind, 'source'); assert.match(record.record_id, bundleId); assert.equal(record.entity_id, record.record_id);
    assert.ok(!bundles.has(record.record_id), 'Duplicate bundle identity or ownership'); bundles.add(record.record_id);
    assert.equal(record.operation_id, 'retain-' + record.record_id); assert.match(record.hash, digest);
    const payload = manifest(record.payload, libraryId, record.skill_page_id, chunkFacts);
    assert.equal('bundle-' + sha(canonical(payload)), record.record_id, 'Manifest does not match the immutable bundle identity');
    const envelope = canonical({ version: 1, operation_id: record.operation_id, payload });
    assert.ok(Buffer.byteLength(envelope) <= 65536, 'Source envelope exceeds 64 KiB');
    assert.equal(sha(envelope), record.hash, 'Source envelope checksum mismatch');
  }
  // Return a detached validation result; later edits to the input cannot change it.
  return structuredClone(records);
}
