import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { generatedCatalogCards, generatedDescriptionEvidence, verifyPreparationEvidence } from './skill-preparation-evidence.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const measure = value => ({ sha256: hash(value), bytes: Buffer.byteLength(value) });
const scope = 'a'.repeat(64);
const bodies = [
  '\ufeff---\r\nname: 中文😀\r\n---\r\n# Members\r\n作者的 <body> 标签与 `{"content":"quoted"}` 示例。\r\n',
  'Second complete body with \\ and "quotes".\r\n<skill-directory>author example</skill-directory>\r\n',
];
const member = { id: 'shared_skill:fixture:member', ref: 'skill://shared_skill%3Afixture%3Amember/SKILL.md',
  kind: 'skill', name: 'shared-member', description: 'A complete shared description.', availability: 'available' };
const currentRef = 'sr:C' + 'm'.repeat(22);
const expectedCard = { ...member, ref: currentRef, canonical_ref: member.ref, source: 'notion-fixture', scope };

function fixture({ replaced = false, identical = false, relations = [] } = {}) {
  const originals = identical ? [bodies[0], bodies[0]] : bodies;
  const records = originals.map((body, index) => ({
    name: 'record-' + index, kind: 'skill', ref: 'sr:S' + String(index).repeat(22),
    content: replaced && index === 0 ? '[Complete body retained in the earlier message.]' : body,
    directory: { files: [{ path: 'SKILL.md', ref: 'sr:S' + String(index).repeat(22), bytes: Buffer.byteLength(body) },
      { path: 'references/guide.md', ref: 'sr:R' + String(index).repeat(22), bytes: 15 }],
      ...Object.fromEntries(['required', 'candidates', 'references'].map(group => [group, relations[index]?.includes(group)
        ? [{ ref: currentRef, kind: member.kind, name: member.name, description: member.description, availability: member.availability }] : []])) },
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
    const identity = JSON.stringify(['notion-fixture', scope, 'skill', 'shared_skill', `shared_skill:fixture:${index}`]),
      binding = { record: { id: `shared_skill:fixture:${index}`, kind: 'skill', name: record.name,
        locator: { type: 'shared_skill' }, ref: canonical.split('?')[0] },
      scope, snapshot_id: snapshot, version_id: hash('version-' + index), body_sha256: hash(body), ref: canonical };
    const receipt = { version: 2, identity, contentIdentity: JSON.stringify([scope, binding.record.id]),
      loaded: !(replaced && index === 0), snapshotId: snapshot, bodySha256: hash(body), bytes: Buffer.byteLength(body), delivery, binding,
      directory: { files: [{ path: 'SKILL.md', ref: canonical, bytes: Buffer.byteLength(body), sha256: hash(body) },
        { path: 'references/guide.md', ref: canonical.replace('SKILL.md', 'references/guide.md'), bytes: 15, sha256: hash('resource bytes!') }],
        ...Object.fromEntries(['required', 'candidates', 'references'].map(group => [group,
          relations[index]?.includes(group) ? [{ ...member }] : []])) } };
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
const message = value => ({ role: 'toolResult', toolName: 'notion_use', toolCallId: 'prepare-1',
  content: [{ type: 'text', text: value.content }], details: { contextBrokerPreparation: value.proof } });
const bindingOracle = value => {
  const originals = structuredClone(value.proof.records.map((record, index) => ({ binding: record.binding, body: bodies[index] })));
  return (binding, bodyHash, bodyBytes) => originals.some(original => JSON.stringify(original.binding) === JSON.stringify(binding)
    && hash(original.body) === bodyHash && Buffer.byteLength(original.body) === bodyBytes);
};

test('duplicate Required and Member relations retain a complete same-request description witness', () => {
  const value = fixture({ relations: [['required', 'candidates']] }), actual = message(value), before = JSON.stringify(actual);
  const cards = generatedCatalogCards(actual);
  assert.equal(cards.length, 2); assert.equal(cards[0].ref, cards[1].ref);
  assert.deepEqual(cards[0].binding, cards[1].binding);
  const evidence = generatedDescriptionEvidence([actual], expectedCard, bindingOracle(value));
  assert.ok(evidence, 'Both independently complete relations remain valid witnesses');
  assert.equal(evidence.description, member.description); assert.equal(evidence.body_sha256, hash(bodies[0]));
  assert.equal(evidence.tool_content_sha256, hash(value.content));
  assert.equal(JSON.stringify(actual), before, 'Witness checking must not remove either relation or mutate its receipt');
});

test('shared Requires under different complete roots accept an independently bound witness', () => {
  const value = fixture({ relations: [['required'], ['required']] }), actual = message(value), cards = generatedCatalogCards(actual);
  assert.equal(cards.length, 2); assert.notEqual(cards[0].binding.record.id, cards[1].binding.record.id);
  assert.notEqual(cards[0].binding.snapshot_id, cards[1].binding.snapshot_id);
  assert.notEqual(cards[0].body_sha256, cards[1].body_sha256);
  const authentic = bindingOracle(value);
  assert.ok(generatedDescriptionEvidence([actual], expectedCard, authentic));
  const second = generatedDescriptionEvidence([actual], expectedCard, (binding, hash, bytes) =>
    binding.record.id === cards[1].binding.record.id && authentic(binding, hash, bytes));
  assert.equal(second.body_sha256, hash(bodies[1]), 'An unqualified first root cannot hide the second full valid root');
  const foreign = structuredClone(actual), receipt = foreign.details.contextBrokerPreparation.records[0];
  const identity = JSON.parse(receipt.identity); identity[0] = 'foreign-source'; receipt.identity = JSON.stringify(identity);
  foreign.details.contextBrokerPreparation.projection.records[0].source.identity = receipt.identity;
  assert.equal(generatedDescriptionEvidence([foreign], expectedCard, authentic).body_sha256, hash(bodies[1]));
});

test('description witnesses still reject missing bodies, conflicting metadata and unauthenticated bindings', () => {
  const value = fixture({ relations: [['required', 'candidates']] }), authentic = bindingOracle(value);
  const mismatch = { ref: 'sr:C' + 'x'.repeat(22), id: 'other-owner', scope: 'b'.repeat(64), source: 'foreign-source',
    kind: 'router', name: 'another-name', description: 'Conflicting description.', availability: 'disabled',
    canonical_ref: member.ref + '?snapshot=s_' + '0'.repeat(64) };
  for (const [key, wrong] of Object.entries(mismatch))
    assert.equal(generatedDescriptionEvidence([message(value)], { ...expectedCard, [key]: wrong }, authentic), undefined, key);
  assert.equal(generatedDescriptionEvidence([], expectedCard, authentic), undefined);
  assert.equal(generatedDescriptionEvidence([message(value)], expectedCard, () => false), undefined);
  const truncated = message(value); truncated.content[0].text = value.content.slice(0, -1);
  assert.equal(generatedDescriptionEvidence([truncated], expectedCard, authentic), undefined);
  const summary = message(value); summary.content[0].text = 'Only a summary; the original is hidden in details.';
  summary.details.hiddenOriginal = value.content;
  assert.equal(generatedDescriptionEvidence([summary], expectedCard, authentic), undefined);
  const replaced = fixture({ replaced: true, relations: [['required', 'candidates']] });
  assert.equal(generatedDescriptionEvidence([message(replaced)], expectedCard, bindingOracle(replaced)), undefined);
  const wrongPin = structuredClone(value), receipt = wrongPin.proof.records[0];
  receipt.binding.snapshot_id = receipt.snapshotId = 's_' + '0'.repeat(64);
  assert.equal(generatedDescriptionEvidence([message(wrongPin)], expectedCard, authentic), undefined);
  const unknown = structuredClone(value); unknown.proof.projection.compiler = 'unknown/compiler';
  assert.equal(generatedDescriptionEvidence([message(unknown)], expectedCard, authentic), undefined);
});

test('independent evidence verifier preserves authored Unicode, BOM, CRLF and literal metadata examples', () => {
  const value = fixture(), before = JSON.stringify(value);
  const result = verify(value);
  assert.deepEqual(result.records.map(record => record.decodedContent), bodies);
  assert.equal(JSON.stringify(value), before);
  assert.notEqual(result.records[0].mapping.source.bytes, result.records[0].mapping.rendered.bytes);
});

test('effects extend the compact envelope without weakening body proof or accepting false zero receipts', () => {
  const value = fixture();
  value.model.effects = { version: 1, remote_writes: 'retained', author_content: 'unchanged',
    retention: [{ skill_page_id: 'owner', file_id: 'main', operation_id: 'op', status: 'confirmed' }] };
  repack(value);
  assert.deepEqual(verify(value).model.effects, value.model.effects);
  assert.deepEqual(verify(value).records.map(record => record.decodedContent), bodies);
  for (const mutate of [
    effects => { effects.version = 2; }, effects => { effects.remote_writes = 'none'; },
    effects => { effects.retention[0].status = 'unknown'; }, effects => { delete effects.retention[0].operation_id; },
  ]) {
    const invalid = structuredClone(value); mutate(invalid.model.effects); repack(invalid);
    assert.throws(() => verify(invalid));
  }
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
