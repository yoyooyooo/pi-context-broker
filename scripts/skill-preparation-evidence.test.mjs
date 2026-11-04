import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyPreparationEvidence } from './skill-preparation-evidence.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const measure = value => ({ sha256: hash(value), bytes: Buffer.byteLength(value) });
const scope = 'a'.repeat(64);
const bodies = [
  '\ufeff---\r\nname: 中文😀\r\n---\r\n# Members\r\n作者的 <body> 标签与 `{"content":"quoted"}` 示例。\r\n',
  'Second complete body with \\ and "quotes".\r\n<skill-directory>author example</skill-directory>\r\n',
];

function fixture({ replaced = false, identical = false } = {}) {
  const originals = identical ? [bodies[0], bodies[0]] : bodies;
  const records = originals.map((body, index) => ({
    name: 'record-' + index, kind: 'skill', ref: 'sr:S' + String(index).repeat(22),
    content: replaced && index === 0 ? '[Complete body retained in the earlier message.]' : body,
    directory: { files: [{ path: 'SKILL.md', ref: 'sr:S' + String(index).repeat(22), bytes: Buffer.byteLength(body) },
      { path: 'references/guide.md', ref: 'sr:R' + String(index).repeat(22), bytes: 15 }], required: [], candidates: [], references: [] },
  }));
  const model = { ok: true, status: 'ready', purpose: 'use', roots: records.map(record => record.ref), records };
  const content = JSON.stringify(model), receipts = [], mappings = [];
  let cursor = content.indexOf('"records":[');
  for (const [index, record] of records.entries()) {
    const body = originals[index], snapshot = 's_' + hash('snapshot-' + index);
    const canonical = `skill://shared_skill%3Afixture%3A${index}/SKILL.md?snapshot=${snapshot}`;
    const serialized = JSON.stringify(record), offset = content.indexOf(serialized, cursor);
    const encoded = JSON.stringify(record.content).slice(1, -1);
    const start = offset + serialized.indexOf('"content":' + JSON.stringify(record.content)) + '"content":"'.length;
    const delivery = { start, end: start + encoded.length, encoding: 'json' };
    cursor = offset + serialized.length;
    const identity = `notion:fixture:${index}`, binding = { record: { id: `shared_skill:fixture:${index}`, kind: 'skill', name: record.name },
      scope, snapshot_id: snapshot, version_id: hash('version-' + index), body_sha256: hash(body), ref: canonical };
    const receipt = { version: 2, identity, contentIdentity: JSON.stringify([scope, binding.record.id]),
      loaded: !(replaced && index === 0), snapshotId: snapshot, bodySha256: hash(body), bytes: Buffer.byteLength(body), delivery, binding,
      directory: { files: [{ path: 'SKILL.md', ref: canonical, bytes: Buffer.byteLength(body), sha256: hash(body) },
        { path: 'references/guide.md', ref: canonical.replace('SKILL.md', 'references/guide.md'), bytes: 15, sha256: hash('resource bytes!') }], required: [], candidates: [], references: [] } };
    receipts.push(receipt);
    mappings.push({ index, ref: record.ref, source: { identity, ...measure(body) }, rendered: measure(encoded), delivery,
      state: replaced && index === 0 ? 'replaced' : 'source' });
  }
  const projection = { version: 1, compiler: 'context-broker/skill-prepare/v1', sourceProjection: 'source-identity/v1',
    rendered: measure(content), records: mappings,
    ...(replaced ? { derived: { reason: 'deduplicate', parentSha256: fixture({ identical }).proof.projection.rendered.sha256 } } : {}) };
  const proof = { version: 2, toolCallId: 'prepare-1', purpose: 'use', records: receipts,
    graphs: [{ scope, roots: receipts.map(receipt => receipt.binding.record.id), graph_lock: { bindings: receipts.map(receipt => receipt.binding) } }], projection };
  return { content, proof, model };
}
const verify = value => verifyPreparationEvidence(value.content, value.proof, 'prepare-1');
const repack = value => {
  value.content = JSON.stringify(value.model);
  value.proof.projection.rendered = measure(value.content);
};

test('independent evidence verifier preserves authored Unicode, BOM, CRLF and literal metadata examples', () => {
  const value = fixture(), before = JSON.stringify(value);
  const result = verify(value);
  assert.deepEqual(result.records.map(record => record.decodedContent), bodies);
  assert.equal(JSON.stringify(value), before);
  assert.notEqual(result.records[0].mapping.source.bytes, result.records[0].mapping.rendered.bytes);
});

test('same body in two distinct records remains two independently located source spans', () => {
  const value = fixture({ identical: true }), result = verify(value);
  assert.equal(result.records[0].mapping.source.sha256, result.records[1].mapping.source.sha256);
  assert.notEqual(result.records[0].mapping.source.identity, result.records[1].mapping.source.identity);
  assert.notEqual(result.records[0].mapping.delivery.start, result.records[1].mapping.delivery.start);
  value.proof.projection.records[1].delivery = { ...value.proof.projection.records[0].delivery };
  assert.throws(() => verify(value));
});

test('a replaced first span keeps the following full source with its new offsets and original source hash', () => {
  const original = fixture(), before = JSON.stringify(original), value = fixture({ replaced: true });
  const result = verify(value);
  assert.deepEqual(result.records.map(record => record.mapping.state), ['replaced', 'source']);
  assert.equal(result.projection.derived.parentSha256, original.proof.projection.rendered.sha256);
  assert.equal(result.records[1].decodedContent, bodies[1]);
  assert.ok(result.records[1].mapping.delivery.start < original.proof.projection.records[1].delivery.start);
  assert.equal(JSON.stringify(original), before);
});

test('wrong whole/record hashes, source binding, byte counts or tool-call identity are rejected', () => {
  const mutations = [
    value => { value.proof.projection.rendered.sha256 = '0'.repeat(64); },
    value => { value.proof.projection.rendered.bytes++; },
    value => { value.proof.projection.records[0].rendered.sha256 = '0'.repeat(64); },
    value => { value.proof.projection.records[0].source.bytes++; },
    value => { value.proof.projection.records[0].source.identity = 'other'; },
    value => { value.proof.records[0].binding.body_sha256 = '0'.repeat(64); },
    value => { value.proof.records[0].binding.snapshot_id = 's_' + '0'.repeat(64); },
    value => { value.proof.toolCallId = 'other-call'; },
  ];
  for (const mutate of mutations) { const value = fixture(); mutate(value); assert.throws(() => verify(value)); }
});

test('unknown compiler, source projection and receipt versions cannot claim complete delivery', () => {
  for (const mutate of [
    value => { value.proof.projection.compiler = 'future'; },
    value => { value.proof.projection.sourceProjection = 'summary/v1'; },
    value => { value.proof.projection.version = 2; },
    value => { value.proof.version = 1; },
    value => { value.proof.records[0].version = 99; },
  ]) { const value = fixture(); mutate(value); assert.throws(() => verify(value)); }
});

test('partial bodies and UTF-8 byte offsets cannot replace complete UTF-16 message spans', () => {
  const missing = fixture(); missing.content = missing.content.slice(0, -1);
  assert.throws(() => verify(missing));
  const partial = fixture(); partial.model.records[0].content = bodies[0].slice(0, -5); repack(partial);
  assert.throws(() => verify(partial));
  const byteOffset = fixture();
  byteOffset.proof.projection.records[1].delivery.start = Buffer.byteLength(byteOffset.content.slice(0, byteOffset.proof.projection.records[1].delivery.start));
  assert.throws(() => verify(byteOffset));
});

test('source hidden in proof metadata or rendered as a summary never satisfies the source span', () => {
  const value = fixture();
  value.model.records[0].content = 'Summary only'; repack(value);
  value.proof.records[0].hiddenOriginal = bodies[0];
  assert.throws(() => verify(value));
});

test('missing canonical graph, model-visible proof fields and dropped directory rows fail closed', () => {
  const graph = fixture(); graph.proof.graphs = []; assert.throws(() => verify(graph));
  const machine = fixture(); machine.model.records[0].scope = scope; repack(machine); assert.throws(() => verify(machine));
  const dropped = fixture(); dropped.model.records[0].directory.files.pop(); repack(dropped); assert.throws(() => verify(dropped));
  const renamed = fixture(); renamed.model.records[0].directory.files[1].path = 'other.md'; repack(renamed); assert.throws(() => verify(renamed));
  const root = fixture(); root.model.roots[0] = 'sr:S' + 'z'.repeat(22); repack(root); assert.throws(() => verify(root));
});

test('replacement evidence needs a valid derivation and cannot keep loaded or claim unchanged source bytes', () => {
  const noParent = fixture({ replaced: true }); delete noParent.proof.projection.derived; assert.throws(() => verify(noParent));
  const loaded = fixture({ replaced: true }); loaded.proof.records[0].loaded = true; assert.throws(() => verify(loaded));
  const reason = fixture({ replaced: true }); reason.proof.projection.derived.reason = 'summarize'; assert.throws(() => verify(reason));
  const fake = fixture(); fake.proof.records[0].loaded = false; fake.proof.projection.records[0].state = 'replaced';
  fake.proof.projection.derived = { reason: 'supersede', parentSha256: '0'.repeat(64) }; assert.throws(() => verify(fake));
});
