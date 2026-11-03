import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyRetainedSourceProof } from './notion-skill-retained-proof.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const scope = 'a'.repeat(64), libraryId = 'library-proof-fixture';
const recordsDataSourceId = '11111111-2222-4333-8444-555555555555';
const owner = '22222222-2222-4333-8444-555555555555';
const otherOwner = '33333333-2222-4333-8444-555555555555';
const expected = { scope, libraryId, recordsDataSourceId };
function seal(record) {
  record.record_id = record.entity_id = 'bundle-' + hash(canonical(record.payload));
  record.operation_id = 'retain-' + record.record_id;
  record.hash = hash(canonical({ version: 1, operation_id: record.operation_id, payload: record.payload }));
  return record;
}
function fixture() {
  const source = 'retained zip bytes', checksum = hash(source);
  const payload = { version: 1, kind: 'retained_bundle', library_id: libraryId, skill_page_id: owner, entrypoint: 'SKILL.md',
    files: [{ path: 'SKILL.md', sha256: hash('main'), bytes: 4 }, { path: 'references/guide.md', sha256: hash('guide'), bytes: 5 }],
    archive: { format: 'zip', sha256: checksum, bytes: source.length, chunks: [{ object_id: 'chunk-' + checksum, sha256: checksum, bytes: source.length }] } };
  const record = seal({ page_id: '44444444-2222-4333-8444-555555555555', kind: 'source', skill_page_id: owner, payload });
  return { version: 1, kind: 'retained-source-ownership', status: 'verified', scope, library_id: libraryId, records_data_source_id: recordsDataSourceId, records: [record] };
}

test('verifies source metadata without creating consumption and returns a detached result', () => {
  const proof = fixture(), records = verifyRetainedSourceProof(proof, expected);
  assert.deepEqual(records, proof.records); assert.notEqual(records[0], proof.records[0]);
  proof.records[0].payload.files[0].path = '../escape';
  assert.equal(records[0].payload.files[0].path, 'SKILL.md');
});

test('scope, library, Records data source and completed-proof status must match independently', () => {
  for (const [field, value] of [['version', 2], ['kind', 'other'], ['status', 'unknown'], ['scope', 'b'.repeat(64)], ['library_id', 'library-other'], ['records_data_source_id', otherOwner]]) {
    const proof = fixture(); proof[field] = value;
    assert.throws(() => verifyRetainedSourceProof(proof, expected), undefined, field);
  }
});

test('both checksums, the exact retain operation and the owner binding are required', () => {
  for (const mutate of [
    r => { r.hash = '0'.repeat(64); }, r => { r.entity_id = 'bundle-' + '0'.repeat(64); },
    r => { r.operation_id = 'unrelated'; }, r => { r.skill_page_id = otherOwner; },
    r => { r.payload.skill_page_id = r.skill_page_id = otherOwner; r.hash = hash(canonical({ version: 1, operation_id: r.operation_id, payload: r.payload })); },
  ]) { const proof = fixture(); mutate(proof.records[0]); assert.throws(() => verifyRetainedSourceProof(proof, expected)); }
});

test('rehashing cannot hide unsafe paths, incomplete layouts, wrong hashes or unsupported fields', () => {
  for (const mutate of [
    p => { p.files[0].path = '../SKILL.md'; }, p => { p.files.reverse(); }, p => { p.entrypoint = 'missing.md'; },
    p => { p.files[0].bytes = -1; }, p => { p.files[0].sha256 = 'bad'; }, p => { p.archive.bytes++; },
    p => { p.archive.chunks[0].object_id = 'chunk-' + '0'.repeat(64); }, p => { p.archive.chunks[0].bytes = 0; },
    p => { p.archive.sha256 = '0'.repeat(64); }, p => { p.files[0].extra = 'not canonical source metadata'; },
  ]) { const proof = fixture(); mutate(proof.records[0].payload); seal(proof.records[0]); assert.throws(() => verifyRetainedSourceProof(proof, expected)); }
});

test('duplicate facts and physical-page conflicts fail while distinct historical bundles of one owner remain valid', () => {
  const duplicate = fixture(); duplicate.records.push(structuredClone(duplicate.records[0]));
  assert.throws(() => verifyRetainedSourceProof(duplicate, expected));
  const history = fixture(), next = structuredClone(history.records[0]);
  next.payload.files[0].sha256 = hash('new main'); seal(next); history.records.push(next);
  assert.throws(() => verifyRetainedSourceProof(history, expected), /physical source page/);
  next.page_id = '55555555-2222-4333-8444-555555555555';
  assert.equal(verifyRetainedSourceProof(history, expected).length, 2);
  const originalId = history.records[0].record_id;
  next.payload.skill_page_id = next.skill_page_id = otherOwner; seal(next);
  const records = verifyRetainedSourceProof(history, expected);
  assert.notEqual(records[1].record_id, originalId, 'Fully rehashed ownership is a different bundle, requiring its own actual receipt observation');
});

test('dense JSON and the complete 64 KiB source envelope limit are enforced before use', () => {
  const sparse = fixture(); delete sparse.records[0].payload.archive.chunks[0];
  assert.throws(() => verifyRetainedSourceProof(sparse, expected));
  const accessor = fixture(); Object.defineProperty(accessor.records[0], 'hash', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.throws(() => verifyRetainedSourceProof(accessor, expected), /JSON data properties/);
  const large = fixture(); large.records[0].payload.files[1].path = 'references/' + 'x'.repeat(65536); seal(large.records[0]);
  assert.throws(() => verifyRetainedSourceProof(large, expected), /64 KiB/);
});
