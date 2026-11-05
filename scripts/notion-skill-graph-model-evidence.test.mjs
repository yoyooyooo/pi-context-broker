import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { graphSourceViews, observeGraphSdk, graphSourceAccounting } from './notion-skill-graph-model-evidence.mjs';
import { observeGraphGate, GRAPH_GATE_TOOLS } from './notion-skill-graph-model.mjs';
import { parseNativeReference } from '../packages/context-broker/src/native-reference.ts';
import { safeRequestMetrics } from './notion-default-context.mjs';
import { systemTempRoot } from './verification-paths.mjs';
import { registerHooks } from 'node:module';

// Run the existing projection compiler and validator, resolving its TS sibling
// exactly as Pi's extension loader does. No copied batch-proof implementation.
const projectionUrl = new URL('../packages/context-broker/src/resource-read-projection.ts', import.meta.url).href;
const projectionImports = registerHooks({ resolve(specifier, context, next) {
  return next(specifier === './native-reference' && context.parentURL === projectionUrl ? './native-reference.ts' : specifier, context);
} });
const { compileResourceRead, validateResourceReadProjection } = await import(projectionUrl);
projectionImports.deregister();

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const lines = async file => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const emptyMetrics = { trace_enabled: true, total_requests: 0, trace_dropped: 0, trace: [] };

function sourceFixture(owner = 'root', resources = [{ path: 'guide.md', content: 'Complete resource bytes.\n' }]) {
  const body = '# Complete source\nUse the resource when needed.\n', resource = resources[0].content;
  const scope = 'a'.repeat(64), snapshot = 's_' + hash(body), version = hash('version-controlled');
  const id = 'shared_skill:library-controlled:' + owner, uuid = '11111111-2222-4333-8444-555555555555';
  const rootRef = 'skill://' + encodeURIComponent(id) + '/SKILL.md';
  const record = { id, ref: rootRef, kind: 'skill', entrypoint: 'SKILL.md', name: 'Root', alias: 'root', description: 'Controlled complete source', enabled: true,
    locator: { type: 'shared_skill', library_id: 'library-controlled', skill_id: owner, database_id: uuid, data_source_id: uuid, page_id: uuid }, default_context: true };
  const ref = (name, file) => 'skill://' + encodeURIComponent(id) + '/' + name + '?snapshot=' + snapshot + '&file_id=' + file;
  const files = [{ path: 'SKILL.md', bytes: Buffer.byteLength(body), sha256: hash(body), ref: ref('SKILL.md', 'file-main') },
    ...resources.map((file, index) => ({ path: file.path, bytes: Buffer.byteLength(file.content), sha256: hash(file.content), ref: ref(file.path, index ? 'file-resource-' + index : 'file-guide') }))];
  const bindings = files.map((file, index) => ({ path: file.path, file_id: index ? index === 1 ? 'file-guide' : 'file-resource-' + (index - 1) : 'file-main', page_id: uuid }));
  const binding = { scope, record, snapshot_id: snapshot, version_id: version, body_sha256: hash(body), ref: files[0].ref };
  const node = { id, state: 'prepared', record, path: 'SKILL.md', ref: files[0].ref, content: body, bytes: Buffer.byteLength(body), body_sha256: hash(body), binding, files, required: [], candidates: [], references: [] };
  const manifest = { complete: true, scope, snapshot_id: snapshot, version_id: version, record, entrypoint: 'SKILL.md',
    files: files.map(({ ref, ...file }) => file), file_bindings: bindings };
  const entry = { id, manifest, manifest_sha256: hash(canonical(manifest)), source_body: { kind: 'verified_snapshot_entry', ref: node.ref,
    path: node.path, bytes: node.bytes, sha256: node.body_sha256, range: { start: 1, end: body.split('\n').length, total_lines: body.split('\n').length }, has_more: false },
    materialization: { status: 'entry_ready', paths: ['SKILL.md'] }, projection: { status: 'identity', compiler: 'source-identity/v1',
      source_body_sha256: hash(body), projection_sha256: hash(body), relations_sha256: hash('relations'), bytes: node.bytes } };
  const value = { version: 1, status: 'ready', preparation: { status: 'ready', purpose: 'inspect', scope, roots: [{ id }], nodes: [node], required: [] }, entries: [entry] };
  return { body, resource, scope, snapshot, version, id, rootRef, record, files, bindings, binding, node, manifest, entry, value };
}

test('one read.paths call proves every complete resource from the selected SDK manifest and one actual provider tool output', async () => {
  const resources = [{ path: 'guide.md', content: 'First complete resource.\n' }, { path: 'notes.md', content: 'Quoted "evidence"\r\n雪\n' }];
  const fixture = sourceFixture('batch', resources), root = await mkdtemp(path.join(await systemTempRoot(), 'graph-sdk-batch-'));
  const cache = path.join(root, 'cache'), responses = path.join(root, 'responses'), output = path.join(root, 'observer.jsonl');
  await mkdir(responses); await mkdir(cache); await writeFile(output, '');
  const receipt = (operation, value) => ({ transport: 'sdk', requestId: operation, operation, status: 'completed', resultObserved: true, value });
  await save(path.join(responses, 'consume.json'), receipt('consume', fixture.value));
  const tree = path.join(cache, 'scopes', fixture.scope, 'records', hash(fixture.id), 'entries', fixture.snapshot);
  await mkdir(path.join(tree, 'tree'), { recursive: true }); await writeFile(path.join(tree, 'tree/SKILL.md'), fixture.body);
  await save(path.join(tree, '.broker-entry.json'), { version: 1, projection: 'entry', id: fixture.id, scope: fixture.scope,
    snapshot_id: fixture.snapshot, version_id: fixture.version, entrypoint: 'SKILL.md', ref: fixture.node.ref, manifest_complete: true,
    files: fixture.files, file_bindings: fixture.bindings });
  const selection = { scope: fixture.scope, owner: fixture.id, snapshot_id: fixture.snapshot, version_id: fixture.version };
  const batch = { version: 1, status: 'ready', selection, manifest: fixture.manifest, manifest_sha256: fixture.entry.manifest_sha256,
    files: resources.map((file, index) => ({ ...fixture.files[index + 1], requested_ref: fixture.files[index + 1].ref,
      file_id: fixture.bindings[index + 1].file_id, encoding: 'utf8', content: file.content })) };
  const handlers = new Map(), originalFetch = globalThis.fetch;
  const refs = batch.files.map(file => file.ref), shortRefs = ['sr:R' + 'C'.repeat(22), 'sr:R' + 'D'.repeat(22)], selected = 'sr:S' + 'B'.repeat(22);
  const identity = { source: 'notion', scope: fixture.scope, id: fixture.id, kind: 'skill', locator: fixture.record.locator, ref: 'skill://' + encodeURIComponent(fixture.id) };
  const shortEvent = (ref, target) => ({ type: 'custom', customType: 'context-broker-short-ref', data: { version: 1, ref, target } });
  const branch = [shortEvent(selected, { kind: 'selected', identity, snapshot_id: fixture.snapshot, version_id: fixture.version,
    body_sha256: hash(fixture.body), entrypoint: 'SKILL.md', ref: fixture.node.ref, file_id: 'file-main' }),
    ...batch.files.map((file, index) => shortEvent(shortRefs[index], { kind: 'resource', owner: selected,
      path: file.path, ref: file.ref, bytes: file.bytes, sha256: file.sha256, file_id: file.file_id }))];
  const ctx = { model: { provider: 'controlled', id: 'fake' }, sessionManager: { getBranch: () => branch } };
  try {
    observeGraphGate({ on: (event, handler) => handlers.set(event, handler), setActiveTools: async () => {} },
      { fs, crypto, path, sourceMode: 'sdk', parseNativeReference, validateResourceReadProjection, cwd: root, responses, cache, output,
        rootRef: fixture.rootRef, model: 'controlled/fake', prompt: 'controlled task' });
    const invoke = (id, input) => {
      handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: input }] } }, ctx);
      return handlers.get('tool_call')({ toolName: 'read', toolCallId: id, input }, ctx);
    };
    assert.equal(invoke('undiscovered', { paths: refs }).block, true);
    const tools = GRAPH_GATE_TOOLS.map(name => ({ type: 'function', function: { name } }));
    handlers.get('before_provider_request')({ payload: { tools, messages: [{ role: 'user', content: fixture.body + '\n' + refs.join('\n') }] } }, ctx);
    for (const [id, paths] of [['unknown', [refs[0], refs[1].replace('notes.md', 'unseen.md')]],
      ['wrong-owner', [refs[0], refs[1].replace(encodeURIComponent(fixture.id), 'another')]],
      ['wrong-pin', [refs[0], refs[1].replace(fixture.snapshot, 's_' + 'd'.repeat(64))]],
      ['duplicate', [refs[0], refs[0]]], ['main', [fixture.node.ref]], ['empty', []]]) {
      assert.equal(invoke(id, { paths }).block, true, id);
    }
    assert.equal(invoke('mixed', { paths: refs, path: refs[0] }).block, true);
    assert.equal(invoke('paged', { paths: refs, limit: 1 }).block, true);
    assert.equal(invoke('complete', { paths: refs }), undefined, 'A discovered immutable resource batch must remain a legal read entrance');
    assert.equal(invoke('short-handles', { paths: shortRefs }), undefined, 'The same discovered immutable resources support branch-bound short refs');
    await save(path.join(responses, 'batch.json'), receipt('read-resources', batch));
    const compiled = compileResourceRead({ toolCallId: 'complete', batch, modelRefs: refs, maxContextBytes: 10000 });
    const details = { ...compiled.details, contextBrokerResourceSource: { source_id: 'notion', result: batch } };
    handlers.get('tool_result')({ toolName: 'read', toolCallId: 'complete', ...compiled, details, isError: false }, ctx);
    const content = compiled.content[0].text;
    handlers.get('before_provider_request')({ payload: { tools, messages: [{ role: 'tool', tool_call_id: 'complete', content }] } }, ctx);
    const events = await lines(output), complete = events.filter(event => event.phase === 'tool-result' && event.toolCallId === 'complete');
    assert.equal(complete.length, 2); assert.ok(complete.every(event => event.complete && event.resourceBatchProof?.deliveryVerified));
    assert.equal(new Set(complete.map(event => event.callSequence)).size, 1);
    assert.equal(events.filter(event => event.phase === 'tool-call' && event.toolCallId === 'complete').length, 1);
    const delivered = events.filter(event => event.phase === 'provider-request').at(-1).toolResults;
    assert.equal(delivered.length, 1); assert.equal(delivered[0].exactToolOutputCopies, 1);
    assert.deepEqual(delivered[0].records.map(file => file.sha256).sort(), resources.map(file => hash(file.content)).sort());
    const shortCompiled = compileResourceRead({ toolCallId: 'short-handles', batch, modelRefs: shortRefs, maxContextBytes: 10000 });
    handlers.get('tool_result')({ toolName: 'read', toolCallId: 'short-handles', ...shortCompiled,
      details: { ...shortCompiled.details, contextBrokerResourceSource: { source_id: 'notion', result: batch } }, isError: false }, ctx);
    assert.equal((await lines(output)).filter(event => event.phase === 'tool-result' && event.toolCallId === 'short-handles' && event.complete).length, 2);
    for (const [id, mutate] of [
      ['details-only', result => { result.content = [{ type: 'text', text: 'Resources loaded.' }]; }],
      ['partial', result => { result.content[0].text = result.content[0].text.replace('First complete resource.', 'First'); }],
      ['wrong-proof-owner', result => { result.details.contextBrokerResource.selection.owner = 'another'; }],
      ['wrong-proof-pin', result => { result.details.contextBrokerResource.selection.snapshot_id = 's_' + 'f'.repeat(64); }],
      ['nested', result => { result.parentToolCallId = 'codemode'; }],
      ['unobserved-source', result => { result.details.contextBrokerResourceSource.result.files[0].content = 'forged'; }],
    ]) {
      assert.equal(invoke(id, { paths: refs }), undefined);
      const result = compileResourceRead({ toolCallId: id, batch, modelRefs: refs, maxContextBytes: 10000 });
      result.details.contextBrokerResourceSource = { source_id: 'notion', result: structuredClone(batch) }; mutate(result);
      handlers.get('tool_result')({ toolName: 'read', toolCallId: id, ...result, isError: false }, ctx);
      assert.ok((await lines(output)).some(event => event.phase === 'tool-result' && event.toolCallId === id && !event.complete), id);
      assert.equal((await lines(output)).some(event => event.phase === 'tool-result' && event.toolCallId === id && event.complete), false, id);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('SDK evidence views bind original complete bodies and manifests without inventing CLI operations', () => {
  const fixture = sourceFixture(), receipt = { transport: 'sdk', requestId: 'observed-consume', operation: 'consume', status: 'completed', resultObserved: true, value: fixture.value };
  const original = JSON.stringify(receipt), views = graphSourceViews([receipt]);
  assert.equal(views.preparations.length, 1); assert.equal(views.entries.length, 1);
  assert.equal(views.entries[0].operation, 'consume'); assert.equal(views.entries[0].requestId, receipt.requestId);
  assert.equal(views.entries[0].value.content, fixture.body); assert.equal(Object.hasOwn(views.entries[0], 'command'), false);
  assert.equal(JSON.stringify(receipt), original);
  for (const mutate of [value => { value.entries.pop(); }, value => { value.entries[0].manifest.scope = 'another'; },
    value => { value.entries[0].manifest_sha256 = 'b'.repeat(64); }, value => { value.preparation.nodes[0].content += 'truncated'; },
    value => { value.entries[0].source_body.has_more = true; }, value => { value.entries[0].source_body.range.start = 2; },
    value => { value.entries[0].materialization.paths = []; }]) {
    const changed = structuredClone(receipt); mutate(changed.value); assert.throws(() => graphSourceViews([changed]));
  }
  assert.equal(graphSourceViews([{ ...receipt, resultObserved: false }]).entries.length, 0);
});

test('SDK observer retains actual return values and one complete metric receipt per invocation', async () => {
  const root = await mkdtemp(path.join(await systemTempRoot(), 'graph-sdk-observer-'));
  const responses = path.join(root, 'responses'), ledger = path.join(root, 'source.jsonl'); await mkdir(responses); await writeFile(ledger, '');
  const observer = observeGraphSdk({ channel, fs, paths: { ledger, responses, outputRoot: root }, safeMetrics: safeRequestMetrics });
  const fixture = sourceFixture();
  const publish = (id, operation, value) => {
    channel('context-broker.notion-sdk').publish({ version: 1, event: 'start', id, operation, pid: process.pid });
    channel('context-broker.notion-sdk-result').publish({ version: 1, id, operation, value });
    channel('context-broker.notion-sdk').publish({ version: 1, event: 'end', id, operation, pid: process.pid, status: 'completed', sdk_started: true, metrics_observed: true, request_metrics: emptyMetrics });
  };
  publish('catalog', 'list', { scope: fixture.scope, records: [fixture.record] });
  publish('consumption', 'consume', fixture.value); observer.close();
  const receipts = await Promise.all(['catalog', 'consumption'].map(async id => JSON.parse(await readFile(path.join(responses, id + '.json'), 'utf8'))));
  assert.deepEqual(receipts[1].value, fixture.value);
  const events = await lines(ledger), accounting = graphSourceAccounting(events, receipts, { sourceMode: 'sdk', requireConsumption: true });
  assert.deepEqual(accounting.sdk_calls, { list: 1, consume: 1, read: 0, 'read-resources': 0 }); assert.equal(accounting.actual_http_attempts, 0);
  assert.throws(() => graphSourceAccounting([], receipts, { sourceMode: 'sdk' }), /missing source observer/);
  assert.throws(() => graphSourceAccounting(events, receipts.map(item => ({ ...item, metrics: null })), { sourceMode: 'sdk' }), /metrics/);
  assert.throws(() => graphSourceAccounting([...events, { phase: 'alternate-child-api', source: true }], receipts, { sourceMode: 'sdk' }), /CLI child/);
  assert.throws(() => graphSourceAccounting(events.filter(event => event.phase !== 'sdk-end'), receipts, { sourceMode: 'sdk' }), /must finish/);
});

test('Pi observer admits a discovered short ref before execution and verifies SDK main, native directory and fixed resource at the provider', async () => {
  const fixture = sourceFixture(), root = await mkdtemp(path.join(await systemTempRoot(), 'graph-sdk-native-'));
  const cache = path.join(root, 'cache'), responses = path.join(root, 'responses'), output = path.join(root, 'observer.jsonl');
  await Promise.all([cache, responses].map(directory => mkdir(directory))); await writeFile(output, '');
  const candidate = 'sr:C' + 'A'.repeat(22), selected = 'sr:S' + 'B'.repeat(22), resourceRef = 'sr:R' + 'C'.repeat(22);
  const identity = { source: 'notion', scope: fixture.scope, id: fixture.id, kind: 'skill', locator: fixture.record.locator, ref: 'skill://' + encodeURIComponent(fixture.id) };
  const branch = [{ type: 'custom', customType: 'context-broker-short-ref', data: { version: 1, ref: candidate, target: { kind: 'candidate', identity } } }];
  const ctx = { model: { provider: 'controlled', id: 'fake' }, sessionManager: { getBranch: () => branch } };
  const rawReceipt = (operation, value) => ({ transport: 'sdk', requestId: operation, operation, status: 'completed', resultObserved: true, value });
  await save(path.join(responses, 'list.json'), rawReceipt('list', { scope: fixture.scope, records: [fixture.record] }));
  const handlers = new Map(), originalFetch = globalThis.fetch;
  try {
    observeGraphGate({ on: (event, handler) => handlers.set(event, handler), setActiveTools: async () => {} },
      { fs, crypto, path, sourceMode: 'sdk', parseNativeReference, cwd: root, responses, cache, output, rootRef: fixture.rootRef, model: 'controlled/fake', prompt: 'controlled task' });
    await handlers.get('session_start')({}, ctx);
    handlers.get('before_agent_start')({ prompt: 'controlled task', systemPrompt: '<skill><name>notion-root</name><description>' + fixture.record.description + '</description><location>' + candidate + '</location></skill>' }, ctx);
    const invoke = (id, input) => {
      handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: input }] } }, ctx);
      return handlers.get('tool_call')({ toolName: 'read', toolCallId: id, input }, ctx);
    };
    assert.equal(invoke('main', { path: candidate }), undefined, 'Metadata identity authorizes the native request before source acquisition');
    const prior = sourceFixture('parent');
    prior.value.preparation.nodes.push({ id: fixture.id, state: 'candidate', record: fixture.record });
    await save(path.join(responses, '0-prior-consume.json'), rawReceipt('consume', prior.value));
    await save(path.join(responses, 'consume.json'), rawReceipt('consume', fixture.value));
    const tree = path.join(cache, 'scopes', fixture.scope, 'records', hash(fixture.id), 'entries', fixture.snapshot);
    await mkdir(path.join(tree, 'tree'), { recursive: true }); await writeFile(path.join(tree, 'tree/SKILL.md'), fixture.body);
    await save(path.join(tree, '.broker-entry.json'), { version: 1, projection: 'entry', id: fixture.id, scope: fixture.scope,
      snapshot_id: fixture.snapshot, version_id: fixture.version, entrypoint: 'SKILL.md', ref: fixture.node.ref, manifest_complete: true,
      files: fixture.files, file_bindings: fixture.bindings });
    branch.push({ type: 'custom', customType: 'context-broker-short-ref', data: { version: 1, ref: selected, target: { kind: 'selected', identity,
      snapshot_id: fixture.snapshot, version_id: fixture.version, body_sha256: hash(fixture.body), entrypoint: 'SKILL.md', ref: fixture.node.ref, file_id: 'file-main' } } },
      { type: 'custom', customType: 'context-broker-short-ref', data: { version: 1, ref: resourceRef, target: { kind: 'resource', owner: selected,
        path: 'guide.md', ref: fixture.files[1].ref, bytes: fixture.files[1].bytes, sha256: fixture.files[1].sha256, file_id: 'file-guide' } } });
    const directory = { files: fixture.files, required: [], candidates: [], references: [] };
    const modelDirectory = { ...directory, files: fixture.files.map((file, index) => ({ path: file.path, bytes: file.bytes, ref: index ? resourceRef : selected })) };
    const content = fixture.body + '\n\n<skill-directory>\n' + JSON.stringify({ ref: selected, directory: modelDirectory }) + '\n</skill-directory>';
    handlers.get('tool_result')({ toolName: 'read', toolCallId: 'main', content: [{ type: 'text', text: content }], details: { contextBrokerRead: {
      version: 3, toolCallId: 'main', snapshotId: fixture.snapshot, bodySha256: hash(fixture.body), bytes: Buffer.byteLength(fixture.body), binding: fixture.binding,
      delivery: { start: 0, end: fixture.body.length, encoding: 'raw' }, directory } } }, ctx);
    assert.equal(invoke('guide', { path: resourceRef }), undefined);
    await save(path.join(responses, 'read.json'), { ...rawReceipt('read', { record: fixture.record, scope: fixture.scope, snapshot_id: fixture.snapshot,
      version_id: fixture.version, path: 'guide.md', ref: fixture.files[1].ref, bytes: fixture.files[1].bytes, sha256: fixture.files[1].sha256,
      entrypoint_sha256: hash(fixture.body), file_bindings: fixture.bindings }), outputEvidence: { path: path.join(cache, 'already-produced'),
      content: fixture.resource, bytes: fixture.files[1].bytes, sha256: fixture.files[1].sha256 } });
    handlers.get('tool_result')({ toolName: 'read', toolCallId: 'guide', content: [{ type: 'text', text: fixture.resource }] }, ctx);
    const tools = GRAPH_GATE_TOOLS.map(name => ({ type: 'function', function: { name } }));
    handlers.get('before_provider_request')({ payload: { tools, messages: [{ role: 'tool', tool_call_id: 'main', content }, { role: 'tool', tool_call_id: 'guide', content: fixture.resource }] } }, ctx);
    const events = await lines(output);
    assert.equal(events.find(event => event.phase === 'catalog').skills[0].provenance.source, 'verified-notion-metadata');
    for (const id of ['main', 'guide']) assert.equal(events.find(event => event.phase === 'tool-result' && event.toolCallId === id)?.complete, true, JSON.stringify(events.filter(event => event.phase === 'tool-result')));
    assert.deepEqual(events.find(event => event.phase === 'provider-request').contents.map(item => item.sha256).sort(), [hash(fixture.body), hash(fixture.resource)].sort());
    branch.push({ ...branch[1], data: { ...branch[1].data, target: { ...branch[1].data.target, snapshot_id: 's_' + 'd'.repeat(64) } } });
    assert.equal(invoke('wrong-branch', { path: selected }).block, true, 'A conflicting persisted binding never authorizes a read');
  } finally { globalThis.fetch = originalFetch; }
});
