import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { verifySessionReceipts } from './notion-skill-graph.mjs';
import { deliveryEvidence } from './notion-skill-graph-session.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const measure = value => ({ sha256: hash(value), bytes: Buffer.byteLength(value) });
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => JSON.stringify(key) + ':' + canonical(child)).join(',') + '}';

// Independent captured-shape fixtures, not production compiler output. Rebuild
// only the declared rendered hashes when testing loss of the original source.
function rendered(message) {
  const content = message.content[0].text, model = JSON.parse(content), proof = message.details.contextBrokerPreparation;
  if (proof.projection) proof.projection.rendered = measure(content);
  let cursor = content.indexOf('"records":[');
  for (const [index, record] of model.records.entries()) {
    const serialized = JSON.stringify(record), offset = content.indexOf(serialized, cursor);
    const start = offset + serialized.indexOf('"content":' + JSON.stringify(record.content)) + '"content":"'.length;
    const encoded = JSON.stringify(record.content).slice(1, -1), delivery = { start, end: start + encoded.length, encoding: 'json' };
    proof.records[index].delivery = delivery;
    if (proof.projection) Object.assign(proof.projection.records[index], { delivery: { ...delivery }, rendered: measure(encoded) });
    cursor = offset + serialized.length;
  }
}

function fixture({ version = 2, sameIdentityAcrossScopes = false } = {}) {
  const nodes = [0, 1].map(index => {
    const scope = (index ? 'b' : 'a').repeat(64), id = 'shared_skill:' + (sameIdentityAcrossScopes ? 'same' : index);
    const body = '\ufeff# Author 🧭\r\n<body>literal</body> "content" \\ ' + (sameIdentityAcrossScopes ? 'same' : index) + '\r\n';
    const snapshot = 's_' + hash(sameIdentityAcrossScopes ? 'same snapshot' : 'snapshot ' + index);
    const ref = 'skill://' + encodeURIComponent(id) + '/SKILL.md?snapshot=' + snapshot + '&file_id=main-' + index;
    const record = { id, kind: 'skill', name: '原始内容 ' + index, alias: 'source-' + index, description: 'Source oracle', entrypoint: 'SKILL.md',
      ref: 'skill://' + encodeURIComponent(id) + '/SKILL.md', default_context: false,
      locator: { type: 'shared_skill', database_id: 'database', data_source_id: 'source', library_id: 'library', skill_id: id, page_id: 'page-' + index } };
    const binding = { record, scope, snapshot_id: snapshot, version_id: hash('version ' + index), body_sha256: hash(body), ref };
    return { id, scope, record, body, content: body, snapshot_id: snapshot, bytes: Buffer.byteLength(body), body_sha256: hash(body), binding,
      modelRef: 'sr:S' + (index ? 'c' : 'd').repeat(22), directory: { files: [{ path: 'SKILL.md', ref, bytes: Buffer.byteLength(body), sha256: hash(body) }], required: [], candidates: [], references: [] } };
  });
  const graphs = nodes.map(node => {
    const vector = { version: 1, kind: 'observed_version_vector', purpose: 'use', scope: node.scope, roots: [node.id], required: [], bindings: [node.binding] };
    return { scope: node.scope, roots: [node.id], graph_lock: { ...vector, sha256: hash(canonical(vector)) },
      budget: { maxNodes: 64, maxDepth: 16, maxInstructionBytes: 1048576, maxContextBytes: 262144 },
      usage: { prepared_nodes: 1, instruction_bytes: node.bytes, context_bytes: node.bytes, max_depth: 0 } };
  });
  const records = nodes.map(node => ({ version: 2, identity: JSON.stringify(['notion', 'owned', node.scope, 'skill', node.id]), contentIdentity: JSON.stringify([node.scope, node.id]),
    loaded: true, snapshotId: node.snapshot_id, bodySha256: node.body_sha256, bytes: node.bytes, binding: node.binding, directory: node.directory }));
  const modelRecords = nodes.map(node => version === 2 ? { name: node.record.name, kind: node.record.kind, ref: node.modelRef, content: node.body,
    directory: { files: [{ path: 'SKILL.md', ref: node.modelRef, bytes: node.bytes }], required: [], candidates: [], references: [] } }
    : { id: node.id, scope: node.scope, ref: node.binding.ref, snapshot_id: node.snapshot_id, version_id: node.binding.version_id,
      body_sha256: node.body_sha256, bytes: node.bytes, content: node.body, directory: node.directory });
  const model = { ok: true, status: 'ready', purpose: 'use', ...(version === 2 ? { roots: nodes.map(node => node.modelRef) } : { graphs }), records: modelRecords };
  const content = JSON.stringify(model);
  const projection = { version: 1, compiler: 'context-broker/skill-prepare/v1', sourceProjection: 'source-identity/v1', rendered: measure(content), records: records.map((record, index) =>
    ({ index, ref: modelRecords[index].ref, source: { identity: record.identity, sha256: record.bodySha256, bytes: record.bytes }, state: 'source' })) };
  const message = { role: 'toolResult', toolName: 'skill_prepare', toolCallId: 'stage:0', isError: false, content: [{ type: 'text', text: content }],
    details: { contextBrokerPreparation: { version, toolCallId: 'stage:0', purpose: 'use', records, graphs, ...(version === 2 ? { projection } : {}) } } };
  rendered(message);
  return { message, nodes };
}

function verifyBoth(value) {
  return [verifySessionReceipts([value.message], value.nodes), deliveryEvidence([value.message], value.nodes, 'stage')];
}

test('existing graph and session callers verify v2 projection against their independent source nodes', () => {
  const value = fixture(), before = JSON.stringify(value);
  for (const result of verifyBoth(value)) {
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(record => record.body_sha256), value.nodes.map(node => node.body_sha256));
  }
  assert.equal(JSON.stringify(value), before);
});

test('legacy v1 preparation remains valid but cannot carry a compiled projection', () => {
  const legacy = fixture({ version: 1 });
  for (const result of verifyBoth(legacy)) assert.equal(result.length, 2);
  const downgraded = fixture(); downgraded.message.details.contextBrokerPreparation.version = 1;
  assert.throws(() => verifyBoth(downgraded), /legacy version-one/);
  assert.throws(() => deliveryEvidence([downgraded.message], downgraded.nodes, 'stage'), /legacy version-one/);
});

test('unknown compiler and unsupported outer evidence versions are never treated as complete', () => {
  const compiler = fixture(); compiler.message.details.contextBrokerPreparation.projection.compiler = 'unreviewed/v99';
  assert.throws(() => verifyBoth(compiler), /Unknown preparation compiler/);
  assert.throws(() => deliveryEvidence([compiler.message], compiler.nodes, 'stage'), /Unknown preparation compiler/);
  const version = fixture(); version.message.details.contextBrokerPreparation.version = 99;
  assert.throws(() => verifyBoth(version), /Unknown preparation receipt version/);
  assert.throws(() => deliveryEvidence([version.message], version.nodes, 'stage'), /Unknown preparation receipt version/);
});

test('whole projection, encoded spans and exact source bytes have independent failure checks', () => {
  for (const mutate of [
    proof => { proof.projection.rendered.sha256 = '0'.repeat(64); },
    proof => { proof.projection.rendered.bytes++; },
    proof => { proof.projection.records[0].rendered.sha256 = '0'.repeat(64); },
    proof => { proof.projection.records[0].delivery.start++; },
    proof => { proof.projection.records[0].source.sha256 = '0'.repeat(64); },
  ]) {
    const value = fixture(); mutate(value.message.details.contextBrokerPreparation);
    assert.throws(() => verifySessionReceipts([value.message], value.nodes));
    assert.throws(() => deliveryEvidence([value.message], value.nodes, 'stage'));
  }
  const partial = fixture(), model = JSON.parse(partial.message.content[0].text);
  model.records[0].content = model.records[0].content.slice(0, -6);
  partial.message.content[0].text = JSON.stringify(model); rendered(partial.message);
  assert.throws(() => verifyBoth(partial), /Complete source body hash/);
  assert.throws(() => deliveryEvidence([partial.message], partial.nodes, 'stage'), /Complete source body hash/);
});

test('receipt ownership cannot be forged by a wrong tool, call ID, failed result or user message', () => {
  for (const mutate of [
    message => { message.toolName = 'read'; },
    message => { message.details.contextBrokerPreparation.toolCallId = 'different'; },
    message => { message.isError = true; },
  ]) {
    const value = fixture(); mutate(value.message);
    assert.throws(() => verifySessionReceipts([value.message], value.nodes));
    assert.throws(() => deliveryEvidence([value.message], value.nodes, 'stage'));
  }
  const user = fixture(); user.message.role = 'user';
  assert.throws(() => verifySessionReceipts([user.message], user.nodes), /actual tool result/);
  assert.deepEqual(deliveryEvidence([user.message], user.nodes, 'stage'), []);
});

test('equal record IDs and snapshot labels in different scopes stay independent', () => {
  const value = fixture({ sameIdentityAcrossScopes: true });
  for (const result of verifyBoth(value)) assert.deepEqual(result.map(record => record.scope), value.nodes.map(node => node.scope));
  const onlyFirst = structuredClone(value.message), model = JSON.parse(onlyFirst.content[0].text), group = onlyFirst.details.contextBrokerPreparation;
  model.records = model.records.slice(0, 1); model.roots = model.roots.slice(0, 1);
  group.records = group.records.slice(0, 1); group.graphs = group.graphs.slice(0, 1); group.projection.records = group.projection.records.slice(0, 1);
  onlyFirst.content[0].text = JSON.stringify(model); rendered(onlyFirst);
  assert.throws(() => verifySessionReceipts([onlyFirst], value.nodes), /Session needs a verified/);
  assert.equal(deliveryEvidence([onlyFirst], value.nodes, 'stage').length, 1);
});

test('a replaced record does not count as a new complete source delivery', () => {
  const value = fixture(), group = value.message.details.contextBrokerPreparation, model = JSON.parse(value.message.content[0].text);
  group.projection.derived = { reason: 'deduplicate', parentSha256: group.projection.rendered.sha256 };
  group.projection.records[0].state = 'replaced'; group.records[0].loaded = false;
  model.records[0].content = 'The verified body already exists in this provider context.';
  value.message.content[0].text = JSON.stringify(model); rendered(value.message);
  const remaining = [value.nodes[1]];
  assert.equal(verifySessionReceipts([value.message], remaining).length, 1);
  assert.equal(deliveryEvidence([value.message], remaining, 'stage').length, 1);
  assert.throws(() => verifySessionReceipts([value.message], value.nodes), /Session needs a verified/);
  group.records[0].loaded = true;
  assert.throws(() => deliveryEvidence([value.message], remaining, 'stage'), /replaced span/);
});

test('native version-three prefixes verify complete source bytes without including the directory footer', () => {
  const value = fixture(), node = value.nodes[0], source = value.message.details.contextBrokerPreparation.records[0];
  const proof = { ...source, version: 3, toolCallId: 'stage:1', delivery: { start: 0, end: node.body.length, encoding: 'raw' } };
  delete proof.loaded;
  const message = { role: 'toolResult', toolName: 'read', toolCallId: 'stage:1', isError: false,
    content: [{ type: 'text', text: node.body + '\n<skill-directory>fixed refs</skill-directory>' }], details: { contextBrokerRead: proof } };
  assert.equal(verifySessionReceipts([message], [node]).length, 1);
  assert.equal(deliveryEvidence([message], [node], 'stage').length, 1);
  proof.delivery.start = 1;
  assert.throws(() => verifySessionReceipts([message], [node]));
  assert.throws(() => deliveryEvidence([message], [node], 'stage'));
});
