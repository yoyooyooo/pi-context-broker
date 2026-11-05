import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assertNativeGuidance, assertScopedCommand, assertPreparedHttpRequest, assertResourceHttpRequest, assertResourceBatchProjection, assertResourceReadSchema, resourceRefsFromInspection, resourceTextCopies, bodyCount, reconcile, sourceFinality, observeOwnedObjectReads, assertObjectReadEvidence } from './notion-sdk-pi.mjs';

const command = ['/absolute/node', '/installed/dist/ntn-skills.mjs'];
const database = '11111111-2222-3333-4444-555555555555';
const toolNames = ['read', 'skill_search', 'skill_prepare', 'bash', 'skill_graph'];
const guidance = '<ntn-skills-guidance>Use supplied bodies. Request cli_source only for an intended source.</ntn-skills-guidance>';
const context = () => ({ messages: [
  { role: 'system', content: 'Controlled system instructions.', toolsAdded: toolNames.map(name => ({ name })) },
  { role: 'user', content: guidance },
] });

function scopeFixture() {
  const result = { kind: 'host_cli_scope', command, database, sourceId: 'sdk-fixture', executed: false };
  const content = [{ type: 'text', text: JSON.stringify(result) }];
  const first = context(), second = context();
  second.messages.push({ role: 'toolResult', toolCallId: 'sc05-source-command', content, details: result, isError: false });
  const frames = [
    { type: 'tool_execution_start', toolName: 'skill_graph', toolCallId: 'sc05-source-command', args: { cli_source: 'sdk-fixture' } },
    { type: 'tool_execution_end', toolCallId: 'sc05-source-command', isError: false, result: { content, details: result } },
  ];
  return { captures: [{ context: first }, { context: second }], frames };
}
const expected = { command, database };

function objectReadFixture() {
  const selected = { path: 'SKILL.md', bytes: 4, sha256: 'a'.repeat(64) }, forbidden = { path: 'assets/unselected.bin', bytes: 2 * 1024 * 1024, sha256: 'b'.repeat(64) };
  const observer_pid = 123, id = '123:object:1', api = 'node:fs.readFile';
  const events = [
    { observer_pid, kind: 'object_observer_start', objects: '/owned/objects', coverage: [api, 'node:fs.readFileSync', 'node:fs/promises.readFile'] },
    { observer_pid, kind: 'object_read', event: 'start', id, api, object_sha256: selected.sha256 },
    { observer_pid, kind: 'object_read', event: 'end', id, api, object_sha256: selected.sha256, code: null, bytes: selected.bytes, content_sha256: selected.sha256 },
    { observer_pid, kind: 'object_observer_end', reads: 1, pending_reads: 0, errors: 0 },
  ];
  return { events, selected, forbidden, requiredPid: observer_pid };
}
test('partial entrypoint evidence needs exact returned main bytes from the actual Store read API', () => {
  const value = objectReadFixture(), before = JSON.stringify(value);
  const result = assertObjectReadEvidence(value.events, { selected: [value.selected], forbidden: [value.forbidden], requiredPid: value.requiredPid });
  assert.equal(result.reads, 1); assert.equal(result.forbidden_object_reads, 0);
  assert.equal(JSON.stringify(value), before);
  for (const mutate of [
    value => { value.events = []; },
    value => { value.events.splice(1, 2); },
    value => { value.events[2].content_sha256 = 'c'.repeat(64); },
    value => { value.events[2].bytes--; },
    value => { value.events[2].code = 'ENOENT'; },
    value => { value.events[1].api = value.events[2].api = 'node:fs.readFileSync'; },
    value => { value.events[2].id = 'unpaired'; },
    value => { value.events.pop(); },
    value => { value.events.at(-1).pending_reads = 1; },
    value => { value.events.at(-1).errors = 1; },
    value => { value.requiredPid++; },
    value => { value.events.splice(3, 0, { ...value.events[1], id: 'unselected', object_sha256: value.forbidden.sha256 },
      { ...value.events[2], id: 'unselected', object_sha256: value.forbidden.sha256, bytes: value.forbidden.bytes, content_sha256: value.forbidden.sha256 }); },
  ]) {
    const sample = objectReadFixture(); mutate(sample);
    assert.throws(() => assertObjectReadEvidence(sample.events, { selected: [sample.selected], forbidden: [sample.forbidden], requiredPid: sample.requiredPid }));
  }
});

test('owned object observation preserves callback, promise and sync results and original errors', async () => {
  const bytes = Buffer.from('main'), hash = value => createHash('sha256').update(value).digest('hex');
  const path = '/owned/objects/' + hash(bytes), options = { signal: new AbortController().signal };
  const originalError = Object.assign(new Error('original I/O error'), { code: 'ENOENT' });
  const receiver = {}, resultToken = {}, events = [];
  let fail = false;
  const fs = {
    readFile(input, passedOptions, callback) {
      assert.equal(input, path); assert.equal(passedOptions, options);
      queueMicrotask(() => callback.call(receiver, fail ? originalError : null, fail ? undefined : bytes));
      return resultToken;
    },
    readFileSync(input) { assert.equal(input, path); if (fail) throw originalError; return bytes; },
  };
  const fsPromises = { async readFile(input) { assert.equal(input, path); if (fail) throw originalError; return bytes; } };
  const original = { callback: fs.readFile, sync: fs.readFileSync, promise: fsPromises.readFile };
  const probe = observeOwnedObjectReads({ fs, fsPromises, objects: '/owned/objects', hash,
    record: fields => events.push({ observer_pid: process.pid, ...fields }) });
  await new Promise((resolve, reject) => {
    assert.equal(fs.readFile(path, options, function(error, actual) {
      try { assert.equal(this, receiver); assert.equal(error, null); assert.equal(actual, bytes); resolve(); } catch (error) { reject(error); }
    }), resultToken);
  });
  assert.equal(fs.readFileSync(path), bytes); assert.equal(await fsPromises.readFile(path), bytes);
  fail = true;
  await new Promise((resolve, reject) => fs.readFile(path, options, function(error, actual) {
    try { assert.equal(this, receiver); assert.equal(error, originalError); assert.equal(actual, undefined); resolve(); } catch (error) { reject(error); }
  }));
  assert.throws(() => fs.readFileSync(path), error => error === originalError);
  await assert.rejects(fsPromises.readFile(path), error => error === originalError);
  assert.deepEqual(probe.finish(), { reads: 6, pending_reads: 0, errors: 0 });
  assert.equal(fs.readFile, original.callback); assert.equal(fs.readFileSync, original.sync); assert.equal(fsPromises.readFile, original.promise);
  const result = assertObjectReadEvidence(events, { selected: [{ path: 'SKILL.md', bytes: bytes.length, sha256: hash(bytes) }], requiredPid: process.pid });
  assert.equal(result.reads, 6);
  assert.equal(events.filter(event => event.kind === 'object_read' && event.event === 'end' && event.code === 'ENOENT').length, 3);
});

function resourceFixture(state = 'source') {
  const hash = value => createHash('sha256').update(value).digest('hex');
  const snapshot = { scope: 'scope', record: { id: 'shared_skill:fixture:resources' }, snapshot_id: 's_' + 'a'.repeat(64), version_id: 'b'.repeat(64) };
  const source = [
    ['references/utf8.txt', 'UTF-8 完整 😀.\n', 'utf8'],
    ['references/bom.txt', '\ufeffBOM\r\n完整正文.\r\n', 'utf8'],
    ['references/empty.txt', '', 'utf8'],
    ['assets/binary.bin', Buffer.from([0, 255, 1, 2, 128, 13, 10]).toString('base64'), 'base64'],
  ];
  const files = source.map(([path, content, encoding], index) => {
    const bytes = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8'), file_id = 'resource-' + index;
    return { ref: 'skill://' + encodeURIComponent(snapshot.record.id) + '/' + path + '?snapshot=' + snapshot.snapshot_id + '&file_id=' + file_id,
      path, file_id, bytes: bytes.length, sha256: hash(bytes), encoding, content };
  });
  const model = { status: 'ready', files: files.map(file => file.encoding === 'base64'
    ? { kind: 'binary', ref: file.ref, path: file.path, bytes: file.bytes, sha256: file.sha256, output: '/owned/cache/' + file.path }
    : { kind: 'text', ref: file.ref, path: file.path, content: state === 'replaced' && file.content.length ? 'Already available.' : file.content }) };
  const text = JSON.stringify(model);
  const proof = { version: 2, toolCallId: 'resources-' + state, loaded: false,
    selection: { scope: snapshot.scope, owner: snapshot.record.id, snapshot_id: snapshot.snapshot_id, version_id: snapshot.version_id },
    files: files.map(({ content: original, ...file }, index) => {
      const visible = model.files[index], binary = file.encoding === 'base64', replaced = state === 'replaced' && original.length > 0;
      const prefix = '"content":', serialized = JSON.stringify(visible), offset = text.indexOf(serialized), property = serialized.indexOf(prefix);
      const start = offset + property + prefix.length + 1;
      return { ...file, requested_ref: file.ref, index, model_ref: file.ref, loaded: false, delivered_complete_text: !binary && !replaced,
        state: binary ? 'binary' : replaced ? 'replaced' : 'source',
        ...(binary ? { output: visible.output } : { delivery: { start, end: start + JSON.stringify(visible.content).length - 2, encoding: 'json' } }) };
    }),
    projection: { version: 1, compiler: 'context-broker/resource-read/v1', rendered: { sha256: hash(text), bytes: Buffer.byteLength(text) },
      ...(state === 'replaced' ? { derived: { reason: 'deduplicate', parentSha256: 'c'.repeat(64) } } : {}) },
  };
  return { batch: { files, snapshot }, message: { role: 'toolResult', toolName: 'read', toolCallId: proof.toolCallId, isError: false,
    content: [{ type: 'text', text }], structuredContent: model, details: { contextBrokerResource: proof } } };
}

test('resource evidence verifies actual UTF-8, BOM/CRLF, zero-length spans and binary materialization metadata', () => {
  const { batch, message } = resourceFixture(), before = JSON.stringify(message);
  const result = assertResourceBatchProjection(message, { batch });
  assert.equal(result.files.length, 4);
  assert.equal(result.files[2].delivery.start, result.files[2].delivery.end);
  assert.equal(result.files[2].delivered_complete_text, true);
  assert.equal(result.files[3].delivered_complete_text, false);
  assert.equal(result.files[3].delivery, undefined);
  assert.equal(JSON.stringify(message), before);
});

test('resource evidence rejects partial sets, forged identity, wrong spans and leaking binary content', () => {
  for (const mutate of [
    value => { value.message.content[0].text += ' '; },
    value => { value.message.structuredContent.files.pop(); },
    value => { value.message.details.contextBrokerResource.toolCallId = 'another-call'; },
    value => { value.message.details.contextBrokerResource.loaded = true; },
    value => { value.message.details.contextBrokerResource.selection.owner = 'foreign-owner'; },
    value => { value.message.details.contextBrokerResource.selection.scope = 'foreign-scope'; },
    value => { value.message.details.contextBrokerResource.selection.snapshot_id = 's_' + 'd'.repeat(64); },
    value => { value.message.details.contextBrokerResource.files[0].file_id = 'another-file'; },
    value => { value.message.details.contextBrokerResource.files[0].sha256 = '0'.repeat(64); },
    value => { value.message.details.contextBrokerResource.files[0].delivery.start++; },
    value => { value.message.details.contextBrokerResource.files[2].delivery.end++; },
    value => { value.message.details.contextBrokerResource.files[3].delivered_complete_text = true; },
    value => { value.message.details.contextBrokerResource.files[3].content = 'not a text delivery'; },
    value => { value.message.details.contextBrokerRead = { loaded: true }; },
  ]) {
    const value = resourceFixture(); mutate(value);
    assert.throws(() => assertResourceBatchProjection(value.message, { batch: value.batch }));
  }
  const forged = resourceFixture(), model = forged.message.structuredContent;
  model.files[0].content = 'A fabricated replacement';
  forged.message.content[0].text = JSON.stringify(model);
  const receipt = forged.message.details.contextBrokerResource;
  receipt.projection.rendered = { bytes: Buffer.byteLength(forged.message.content[0].text), sha256: createHash('sha256').update(forged.message.content[0].text).digest('hex') };
  receipt.files[0].sha256 = createHash('sha256').update(model.files[0].content).digest('hex');
  receipt.files[0].bytes = Buffer.byteLength(model.files[0].content);
  assert.throws(() => assertResourceBatchProjection(forged.message, { batch: forged.batch }), 'Self-consistent fabricated receipts cannot replace independent source bytes');
});

test('resource provider repeats replace only nonempty text and preserve empty and binary facts', () => {
  const first = resourceFixture(), repeated = resourceFixture('replaced');
  const result = assertResourceBatchProjection(repeated.message, { batch: repeated.batch, state: 'replaced' });
  assert.deepEqual(result.files.map(file => file.state), ['replaced', 'replaced', 'source', 'binary']);
  const context = { messages: [first.message, repeated.message] };
  assert.equal(resourceTextCopies(context, first.batch.files[0]), 1);
  assert.equal(resourceTextCopies(context, first.batch.files[2]), 2);
  assert.equal(bodyCount(context, first.batch.files[0].content), 1);
  const missingParent = resourceFixture('replaced'); delete missingParent.message.details.contextBrokerResource.projection.derived;
  assert.throws(() => assertResourceBatchProjection(missingParent.message, { batch: missingParent.batch, state: 'replaced' }));
});

function resourceSchemaContext() {
  const value = context(), paths = { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string' } };
  value.messages[0].toolsAdded.find(tool => tool.name === 'read').parameters = { type: 'object', properties: { path: { type: 'string' }, paths }, oneOf: [
    { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], not: { required: ['paths'] } },
    { type: 'object', properties: { paths }, required: ['paths'], additionalProperties: false },
  ] };
  return value;
}
test('actual provider schema must express a bounded paths branch exclusive with native path', () => {
  assert.equal(assertResourceReadSchema(resourceSchemaContext()).paths_supported, true);
  for (const mutate of [
    schema => { delete schema.oneOf; },
    schema => { schema.oneOf[0].not.required = ['unrelated']; },
    schema => { schema.oneOf[1].additionalProperties = true; },
    schema => { schema.oneOf[1].properties.offset = { type: 'number' }; },
    schema => { schema.properties.paths.items.type = 'number'; },
    schema => { schema.properties.paths.minItems = 0; },
  ]) {
    const value = resourceSchemaContext(); mutate(value.messages[0].toolsAdded.find(tool => tool.name === 'read').parameters);
    assert.throws(() => assertResourceReadSchema(value));
  }
});

function inspectedResourceFixture() {
  const paths = ['references/utf8.txt', 'references/bom.txt', 'references/empty.txt', 'assets/binary.bin'];
  const files = paths.map((path, index) => ({ path, ref: 'sr:R' + String(index + 1).repeat(22) }));
  const root = 'sr:S' + 'a'.repeat(22);
  return { paths, prepared: { status: 'ready', purpose: 'inspect', roots: [root], records: [{ name: 'resources', ref: root,
    directory: { files: [...files, { path: 'SKILL.md', ref: root }, { path: 'unselected.txt', ref: 'sr:R' + 'z'.repeat(22) }] } }] } };
}
test('short resource handles come from one actual inspected owner in explicit requested path order', () => {
  const { prepared, paths } = inspectedResourceFixture(), order = [paths[1], paths[3], paths[0], paths[2]];
  const before = JSON.stringify(prepared);
  assert.deepEqual(resourceRefsFromInspection(prepared, 'resources', order), [2, 4, 1, 3].map(index => 'sr:R' + String(index).repeat(22)));
  assert.equal(JSON.stringify(prepared), before);
});
test('short handle selection rejects missing or duplicate files, foreign owners, main handles and non-inspection results', () => {
  for (const mutate of [
    value => { value.prepared.purpose = 'use'; },
    value => { value.prepared.records[0].name = 'another-owner'; },
    value => { value.prepared.roots.push(value.prepared.roots[0]); },
    value => { value.prepared.records[0].directory.files.shift(); },
    value => { value.prepared.records[0].directory.files.push({ ...value.prepared.records[0].directory.files[0] }); },
    value => { value.prepared.records[0].directory.files[0].ref = value.prepared.roots[0]; },
    value => { value.prepared.records[0].directory.files[1].ref = value.prepared.records[0].directory.files[0].ref; },
    value => { value.paths.push(value.paths[0]); },
  ]) {
    const value = inspectedResourceFixture(); mutate(value);
    assert.throws(() => resourceRefsFromInspection(value.prepared, 'resources', value.paths));
  }
});

test('body evidence counts only visible content, including JSON bodies, never details or tool schemas', () => {
  const body = '\ufeff中文😀\r\n<body>author text</body>\\"quoted"\r\n';
  const input = { messages: [{ role: 'system', content: 'System', toolsAdded: [{ name: 'x', description: body }] },
    { role: 'toolResult', content: [{ type: 'text', text: JSON.stringify({ records: [{ content: body }] }) }], details: { hiddenBody: body } }] };
  assert.equal(bodyCount(input, body), 1);
  input.messages[1].content = [{ type: 'text', text: 'Only a summary.' }];
  assert.equal(bodyCount(input, body), 0);
  const jsonBody = '{"content":"this entire JSON document is the source"}';
  assert.equal(bodyCount({ messages: [{ role: 'toolResult', content: [{ type: 'text', text: JSON.stringify({ content: jsonBody }) }] }] }, jsonBody), 1);
  assert.equal(bodyCount({ messages: [{ role: 'toolResult', content: jsonBody }] }, jsonBody), 1);
});

function httpFixture() {
  const content = JSON.stringify({ ok: true, records: [{ content: 'An author may mention {"details":"literal source example"}.' }] });
  const context = { messages: [{ role: 'toolResult', toolName: 'skill_prepare', toolCallId: 'prepare-1',
    content: [{ type: 'text', text: content }], details: { contextBrokerPreparation: { machineProof: 'host-only-proof' } }, isError: false }] };
  const payload = { model: 'local-fixture', messages: [{ role: 'tool', tool_call_id: 'prepare-1', content }] };
  return { context, payload, body: Buffer.from(JSON.stringify(payload)) };
}
test('actual serialized tool content is paired by toolCallId and kept separate from host details', () => {
  const value = httpFixture(), before = JSON.stringify(value);
  const result = assertPreparedHttpRequest(value.payload, value.body, value.context);
  assert.equal(result.payload_matches_http, true); assert.equal(result.details_in_tool_messages, false);
  assert.equal(result.delivered.length, 1); assert.ok(result.delivered[0].host_details_bytes > 0);
  assert.equal(value.body.includes('host-only-proof'), false);
  assert.equal(JSON.stringify(value), before);
});
test('resource serializer evidence uses actual emitted text, including empty resource content, without exposing the byte proof', () => {
  const { batch, message } = resourceFixture();
  const context = { messages: [message] }, payload = { model: 'local-fixture', messages: [{ role: 'tool', tool_call_id: message.toolCallId, content: message.content[0].text }] };
  const body = Buffer.from(JSON.stringify(payload));
  assertResourceBatchProjection(message, { batch });
  const result = assertResourceHttpRequest(payload, body, context);
  assert.equal(result.payload_matches_http, true); assert.equal(result.delivered.length, 1);
  assert.equal(body.includes('contextBrokerResource'), false);
  const leaked = structuredClone(payload); leaked.messages[0].details = message.details;
  assert.throws(() => assertResourceHttpRequest(leaked, Buffer.from(JSON.stringify(leaked)), context));
  const partial = structuredClone(payload); partial.messages[0].content = 'Only one resource.';
  assert.throws(() => assertResourceHttpRequest(partial, Buffer.from(JSON.stringify(partial)), context));
});
test('capture objects, wrong HTTP bytes, missing tool calls and leaked proof fields fail serializer evidence', () => {
  const capture = httpFixture();
  assert.throws(() => assertPreparedHttpRequest({ context: capture.context }, Buffer.from(JSON.stringify({ context: capture.context })), capture.context));
  const changedBytes = httpFixture();
  assert.throws(() => assertPreparedHttpRequest(changedBytes.payload, Buffer.concat([changedBytes.body, Buffer.from('\n')]), changedBytes.context));
  for (const mutate of [
    payload => { payload.messages[0].content = 'A summary replaces the full tool result'; },
    payload => { payload.messages[0].tool_call_id = 'another-call'; },
    payload => { payload.messages.push({ ...payload.messages[0] }); },
    payload => { payload.messages[0].details = { leaked: true }; },
    payload => { payload.messages[0].graph_lock = { leaked: true }; },
  ]) {
    const value = httpFixture(); mutate(value.payload);
    assert.throws(() => assertPreparedHttpRequest(value.payload, Buffer.from(JSON.stringify(value.payload)), value.context));
  }
});

test('native-guidance evidence checks only host guidance and preserves complete author text', () => {
  const input = context();
  input.messages.push({ role: 'user', content: `Author body: <cli>${command[1]}</cli> <read-args>read REF</read-args>` });
  const before = JSON.stringify(input);
  assert.equal(assertNativeGuidance(input, command[1]).legacy_cli_templates, false);
  assert.equal(JSON.stringify(input), before);
  for (const bad of ['<cli source="fixture">node</cli>', '<read-args>read REF</read-args>', command[1]]) {
    const stale = context();
    stale.messages[1].content = `<ntn-skills-guidance>${bad}</ntn-skills-guidance>`;
    assert.throws(() => assertNativeGuidance(stale, command[1]));
  }
});

test('missing actual capabilities and duplicate or missing host guidance cannot pass', () => {
  const noPrepare = context(); noPrepare.messages[0].toolsAdded = noPrepare.messages[0].toolsAdded.filter(tool => tool.name !== 'skill_prepare');
  assert.throws(() => assertNativeGuidance(noPrepare, command[1]), /Actual provider/);
  const duplicate = context(); duplicate.messages.push({ role: 'user', content: guidance });
  assert.throws(() => assertNativeGuidance(duplicate, command[1]), /one current host guidance/);
  const missing = context(); missing.messages = missing.messages.filter(message => message.role === 'system');
  assert.throws(() => assertNativeGuidance(missing, command[1]), /one current host guidance/);
});

test('Pi transcript capabilities apply system removals then additions and ignore user declarations', () => {
  const changed = context();
  changed.messages.push({ role: 'system', content: '', toolsRemoved: [{ name: 'read' }, { name: 'bash' }], toolsAdded: [{ name: 'read', description: 'replacement' }] });
  changed.messages.push({ role: 'user', content: 'Not a system declaration.', toolsAdded: [{ name: 'bash' }] });
  assert.equal(assertNativeGuidance(changed, command[1]).tools.includes('bash'), false);
  changed.messages.push({ role: 'system', content: '', toolsRemoved: [{ name: 'read' }] });
  changed.tools = [{ name: 'read' }];
  assert.throws(() => assertNativeGuidance(changed, command[1]), /Actual provider must expose read/);
});

test('scoped command requires one real graph query and verbatim exact source receipt', () => {
  const { captures, frames } = scopeFixture();
  const before = JSON.stringify({ captures, frames });
  const verified = assertScopedCommand(captures, frames, expected);
  assert.equal(verified.receipt_delivered_verbatim, true);
  assert.equal(verified.model_bash_calls, 0);
  assert.deepEqual(verified.command, command);
  assert.equal(JSON.stringify({ captures, frames }), before);
});

test('pre-injected executable, missing bash, another query or a bash call fails the scoped route', () => {
  const preInjected = scopeFixture();
  preInjected.captures[0].context.messages.push({ role: 'user', content: command[1] });
  assert.throws(() => assertScopedCommand(preInjected.captures, preInjected.frames, expected), /First provider request/);
  const missingBash = scopeFixture();
  missingBash.captures[0].context.messages[0].toolsAdded = missingBash.captures[0].context.messages[0].toolsAdded.filter(tool => tool.name !== 'bash');
  assert.throws(() => assertScopedCommand(missingBash.captures, missingBash.frames, expected));
  const wrongQuery = scopeFixture(); wrongQuery.frames[0].args.cli_source = 'other-source';
  assert.throws(() => assertScopedCommand(wrongQuery.captures, wrongQuery.frames, expected));
  const extraBash = scopeFixture();
  extraBash.frames.push({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'extra', args: { command: 'true' } });
  assert.throws(() => assertScopedCommand(extraBash.captures, extraBash.frames, expected), /no bash or body read/);
});

test('wrong source, database, command or missing receipt content cannot be treated as a scoped result', () => {
  for (const changed of [{ sourceId: 'other-source' }, { database: 'other-database' }, { command: ['node', '/other/cli'] }, { executed: true }]) {
    const fixture = scopeFixture();
    const message = fixture.captures[1].context.messages.at(-1);
    message.content = [{ type: 'text', text: JSON.stringify({ ...message.details, ...changed }) }];
    assert.throws(() => assertScopedCommand(fixture.captures, fixture.frames, expected));
  }
  const missing = scopeFixture(); missing.captures[1].context.messages.pop();
  assert.throws(() => assertScopedCommand(missing.captures, missing.frames, expected), /Public tool result/);
  const altered = scopeFixture(); altered.frames[1].result.content = [{ type: 'text', text: '{"different":true}' }];
  assert.throws(() => assertScopedCommand(altered.captures, altered.frames, expected), /complete exact tool receipt/);
});

function observed(fields) {
  let previous = null;
  return fields.map((item, index) => {
    const payload = { version: 1, observer_pid: 42, sequence: index + 1, monotonic_ns: String(index + 1), previous_sha256: previous, ...item };
    previous = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return { ...payload, sha256: previous };
  });
}
const lifecycle = [{ event: 'spawn', pid: 42 }, { event: 'close', pid: 42, code: 0, signal: null }];
const catalog = [
  { kind: 'observer_start', exec_path: command[0] },
  { kind: 'child_start', id: '42:1', bundled: true, operation: 'list', argv: [command[1], 'list'] },
  { kind: 'child_close', id: '42:1', code: 0, signal: null, request_metrics: { complete: true, total_requests: 0 } },
  { kind: 'observer_end', code: 0, active_sdk: 0, active_children: 0 },
];

test('metadata-only scope does not weaken the existing mandatory SDK transport assertion', () => {
  assert.throws(() => reconcile(observed(catalog), lifecycle), /empty SDK observation/);
  const scope = reconcile(observed(catalog), lifecycle, { bodyTransportRequired: false });
  assert.equal(scope.default_body_transport, 'not_applicable_metadata_query');
  assert.equal(scope.sdk_calls, 0);
  assert.equal(scope.source_children_closed, 1);
  const doctor = structuredClone(catalog); doctor[1].operation = 'ctl'; doctor[1].argv = [command[1], 'ctl', 'doctor'];
  assert.throws(() => reconcile(observed(doctor), lifecycle, { bodyTransportRequired: false }), /background catalog\/identity/);
  assert.throws(() => reconcile(observed(catalog.filter(item => item.kind !== 'child_close')), lifecycle, { bodyTransportRequired: false }));
});

const childTerminal = [
  { kind: 'observer_start', observer_pid: 42, parent_pid: 10 },
  { kind: 'child_start', observer_pid: 42, id: '42:1' },
  { kind: 'child_spawn', observer_pid: 42, id: '42:1', child_pid: 43 },
  { kind: 'observer_start', observer_pid: 43, parent_pid: 42 },
  { kind: 'observer_end', observer_pid: 43, code: 0, active_sdk: 0, active_children: 0 },
  { kind: 'child_close', observer_pid: 42, id: '42:1', child_pid: 43, code: 0, signal: null },
];
const hostEnd = { kind: 'observer_end', observer_pid: 42, code: 0, active_sdk: 0, active_children: 0 };

test('source drain before EOF does not wait on host exit; final sealing does', () => {
  assert.equal(sourceFinality(childTerminal, 42).complete, true);
  assert.equal(sourceFinality(childTerminal, 42, { hostClosed: true }).complete, false);
  assert.equal(sourceFinality([...childTerminal, hostEnd], 42, { hostClosed: true }).complete, true);
  assert.equal(sourceFinality([], 42, { hostClosed: true }).complete, false);
});

test('PID identity alone, a missing close, or a child lacking its observed end cannot seal', () => {
  for (const missing of ['child_spawn', 'child_close']) {
    assert.equal(sourceFinality(childTerminal.filter(event => event.kind !== missing), 42).complete, false);
  }
  assert.equal(sourceFinality(childTerminal.filter(event => !(event.kind === 'observer_end' && event.observer_pid === 43)), 42).complete, false);
  const wrongParent = structuredClone(childTerminal); wrongParent[3].parent_pid = 99;
  assert.equal(sourceFinality(wrongParent, 42).complete, false);
  const wrongClose = structuredClone(childTerminal); wrongClose[5].child_pid = 99;
  assert.equal(sourceFinality(wrongClose, 42).complete, false);
});

test('late child exit after a stopped host never supplies its missing parent close', () => {
  const stopped = childTerminal.filter(event => !['child_close', 'observer_end'].includes(event.kind));
  stopped.push({ ...hostEnd, code: 143, active_children: 1 });
  assert.equal(sourceFinality(stopped, 42, { hostClosed: true }).complete, false);
  stopped.push(childTerminal[4]);
  const final = sourceFinality(stopped, 42, { hostClosed: true });
  assert.equal(final.complete, false);
  assert.ok(final.pending.some(item => item.kind === 'child_close'));
  assert.ok(final.pending.some(item => item.kind === 'observer_end' && item.pid === 42));
});

test('an unfinished SDK call or unmatched observer remains unresolved even after known children close', () => {
  const events = [...childTerminal, { kind: 'sdk', event: 'start', observer_pid: 42, id: 'sdk-1' }];
  assert.equal(sourceFinality(events, 42).complete, false);
  events.push({ kind: 'sdk', event: 'end', observer_pid: 42, id: 'sdk-1' });
  assert.equal(sourceFinality(events, 42).complete, true);
  events.push({ kind: 'observer_start', observer_pid: 44, parent_pid: 42 }, { ...hostEnd, observer_pid: 44 });
  assert.equal(sourceFinality(events, 42).complete, false);
});
