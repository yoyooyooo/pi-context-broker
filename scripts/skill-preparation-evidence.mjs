import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, expected, message) {
  assert.ok(object(value), message);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), message);
}
function measure(value, text, message) {
  keys(value, ['sha256', 'bytes'], message);
  assert.equal(value.sha256, hash(text), message);
  assert.equal(value.bytes, Buffer.byteLength(text), message);
}

/** Verify captured tool content independently of the production compiler.
 * Source authenticity still requires each caller's original source oracle.
 * A derived parent's hash is a link, not proof that the parent was observed. */
export function verifyPreparationEvidence(content, proof, toolCallId) {
  assert.ok(typeof content === 'string' && content.length > 0, 'Preparation content is missing');
  assert.ok(typeof toolCallId === 'string' && toolCallId.length > 0, 'Preparation tool call is missing');
  const model = JSON.parse(content);
  assert.equal(content, JSON.stringify(model), 'Preparation projection must use its deterministic JSON encoding');
  keys(model, ['ok', 'status', 'purpose', 'roots', 'records'], 'Only compact preparation fields are model-visible');
  assert.equal(model.ok, true); assert.equal(model.status, 'ready');
  assert.ok(['use', 'inspect'].includes(model.purpose));
  assert.ok(Array.isArray(model.roots) && model.roots.length > 0 && model.roots.length <= 64);
  assert.ok(Array.isArray(model.records) && model.records.length > 0);
  assert.equal(proof?.version, 2, 'Only the frozen v2 preparation evidence is accepted');
  assert.equal(proof.toolCallId, toolCallId); assert.equal(proof.purpose, model.purpose);
  assert.ok(Array.isArray(proof.records) && proof.records.length === model.records.length);
  assert.ok(Array.isArray(proof.graphs) && proof.graphs.length > 0, 'Canonical graph proofs must remain in details');
  const projection = proof.projection;
  keys(projection, ['version', 'compiler', 'sourceProjection', 'rendered', 'records', ...(projection?.derived === undefined ? [] : ['derived'])], 'Projection evidence is versioned');
  assert.equal(projection.version, 1);
  assert.equal(projection.compiler, 'context-broker/skill-prepare/v1', 'Unknown preparation compiler');
  assert.equal(projection.sourceProjection, 'source-identity/v1', 'Author bytes remain source identity projection');
  measure(projection.rendered, content, 'Complete projection hash and byte count');
  assert.ok(Array.isArray(projection.records) && projection.records.length === model.records.length);
  if (projection.derived !== undefined) {
    keys(projection.derived, ['reason', 'parentSha256'], 'Derived projection link');
    assert.ok(['deduplicate', 'supersede'].includes(projection.derived.reason));
    assert.match(projection.derived.parentSha256, /^[a-f0-9]{64}$/u);
  }
  const seen = new Set();
  let cursor = content.indexOf('"records":[');
  const records = model.records.map((record, index) => {
    keys(record, ['name', 'kind', 'ref', 'content', ...(record?.directory === undefined ? [] : ['directory'])], 'Machine proof fields must stay in details');
    for (const key of ['name', 'kind', 'ref', 'content']) assert.equal(typeof record[key], 'string');
    assert.ok(record.ref.length > 0 && !seen.has(record.ref), 'Prepared references must be unique'); seen.add(record.ref);
    const receipt = proof.records[index], mapping = projection.records[index];
    assert.equal(receipt?.version, 2); assert.ok(typeof receipt.identity === 'string' && receipt.identity.length > 0);
    assert.ok(object(receipt.binding) && object(receipt.binding.record), 'The full selected source binding remains available');
    assert.equal(receipt.binding.snapshot_id, receipt.snapshotId);
    assert.equal(receipt.binding.body_sha256, receipt.bodySha256);
    assert.match(receipt.bodySha256, /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0);
    keys(mapping, ['index', 'ref', 'source', 'rendered', 'delivery', 'state'], 'Each source has an explicit rendered span');
    assert.equal(mapping.index, index); assert.equal(mapping.ref, record.ref);
    keys(mapping.source, ['identity', 'sha256', 'bytes'], 'Source identity and exact original bytes');
    assert.deepEqual(mapping.source, { identity: receipt.identity, sha256: receipt.bodySha256, bytes: receipt.bytes });
    const serialized = JSON.stringify(record), offset = content.indexOf(serialized, cursor);
    assert.ok(offset >= cursor, 'The span belongs to its own serialized record');
    const property = serialized.indexOf('"content":' + JSON.stringify(record.content));
    assert.ok(property >= 0);
    const start = offset + property + '"content":"'.length;
    const encoded = JSON.stringify(record.content).slice(1, -1);
    assert.deepEqual(mapping.delivery, { start, end: start + encoded.length, encoding: 'json' });
    assert.equal(content.slice(start, start + encoded.length), encoded);
    measure(mapping.rendered, encoded, 'Rendered record hash is the encoded JSON span');
    const decodedContent = JSON.parse('"' + encoded + '"');
    assert.equal(decodedContent, record.content); cursor = offset + serialized.length;
    if (mapping.state === 'source') {
      assert.equal(receipt.loaded, true); assert.deepEqual(receipt.delivery, mapping.delivery);
      assert.equal(hash(decodedContent), mapping.source.sha256, 'Complete source body hash');
      assert.equal(Buffer.byteLength(decodedContent), mapping.source.bytes, 'Complete source body bytes');
    } else {
      assert.equal(mapping.state, 'replaced', 'Unknown record projection state');
      assert.equal(receipt.loaded, false, 'A replaced span does not prove another source delivery');
      assert.ok(projection.derived, 'Replaced spans require an observed-parent link');
      assert.notEqual(hash(decodedContent), mapping.source.sha256, 'A replacement cannot masquerade as the original source span');
    }
    const directory = receipt.directory;
    assert.equal(record.directory === undefined, directory === undefined, 'Every canonical directory remains represented');
    if (directory !== undefined) {
      keys(record.directory, ['files', 'required', 'candidates', 'references'], 'Keep every directory group');
      for (const group of ['files', 'required', 'candidates', 'references']) {
        assert.ok(Array.isArray(directory[group]) && Array.isArray(record.directory[group]));
        assert.equal(record.directory[group].length, directory[group].length, 'Keep every directory row');
        for (let i = 0; i < directory[group].length; i++) {
          const canonical = directory[group][i], projected = record.directory[group][i];
          const fields = group === 'files' ? ['path', 'ref', 'bytes'] : ['ref', 'kind', 'name', 'description', 'availability'];
          keys(projected, fields, 'Directory projection contains only public reading fields');
          assert.ok(typeof projected.ref === 'string' && projected.ref.length > 0);
          for (const key of fields.filter(key => key !== 'ref')) assert.deepEqual(projected[key], canonical[key]);
        }
      }
    }
    return { model: record, receipt, mapping, decodedContent };
  });
  assert.ok(model.roots.every(ref => typeof ref === 'string' && seen.has(ref)), 'Every root has a prepared model record');
  if (projection.derived) assert.ok(records.some(record => record.mapping.state === 'replaced'), 'A derived result must identify its changed records');
  return { model, projection, records };
}
