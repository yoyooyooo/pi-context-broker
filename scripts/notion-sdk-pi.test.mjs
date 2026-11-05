import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile as callbackReadFile } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { systemTempRoot } from './verification-paths.mjs';
import { resolveInstalledPiSerializer, observeSdkInitialization } from './notion-sdk-pi.mjs';
import { validateLiveInput, selectLiveProviderCall, liveSourceMetrics } from './notion-sdk-pi.mjs';
import { assertNativeGuidance, assertScopedCommand, assertPreparedHttpRequest, assertResourceHttpRequest, assertResourceBatchProjection, assertResourceReadSchema, resourceRefsFromNative, resourceTextCopies, bodyCount, reconcile, sourceFinality, observeOwnedObjectReads, assertObjectReadEvidence, assertProviderHttpRequest, assertProviderToolSequence, assertSearchProjection, assertDefaultViewProjection, assertDollarProjection, assertNativeProjection, resourceScalarCalls, selectScalarProviderCall, assertResourceScalarResult, resourceScalarSelectedFixture, assertResourceScalarSession, assertResourceScalarCost, selectNativeRepeatCall, assertNativeRepeatProjection, assertScalarReadObjectIntervals } from './notion-sdk-pi.mjs';

const command = ['/absolute/node', '/installed/dist/ntn-skills.mjs'];
const database = '11111111-2222-3333-4444-555555555555';
const toolNames = ['read', 'notion_list', 'notion_use', 'bash', 'notion_ctl'];
const guidance = '<ntn-skills-guidance>Use supplied bodies. Request cli_source only for an intended source.</ntn-skills-guidance>';
const context = () => ({ messages: [
  { role: 'system', content: 'Controlled system instructions.', toolsAdded: toolNames.map(name => ({ name })) },
  { role: 'user', content: guidance },
] });

const liveInput = () => {
  const file = path => ({ path, sha256: 'a'.repeat(64) });
  return { version: 1, kind: 'live_notion_sdk', host: file('/owned/pi'), artifact: file('/owned/broker.tgz'),
    source: { id: 'mini-live', database }, oracle: { catalog: file('/original/catalog.json'), use: file('/original/use.json'),
      resource: { ...file('/original/resource.md'), logical_path: 'playbooks/pause-safely.md' } },
    sentinels: [file('/daily/settings.json')] };
};
test('live input requires explicit local identities and never accepts source overrides or duplicate sentinels', () => {
  const input = liveInput(), before = structuredClone(input);
  assert.equal(validateLiveInput(input), input); assert.deepEqual(input, before);
  for (const mutate of [
    value => { value.kind = 'offline'; },
    value => { value.version = 2; },
    value => { value.host.path = 'pi'; },
    value => { value.artifact.sha256 = 'unknown'; },
    value => { value.source.command = ['some-cli']; },
    value => { value.source.database = 'inferred'; },
    value => { value.oracle.resource.logical_path = '../escape'; },
    value => { value.oracle.resource.logical_path = '/absolute'; },
    value => { value.oracle.use.path = 'relative'; },
    value => { value.sentinels = []; },
    value => { value.sentinels.push(value.sentinels[0]); },
    value => { value.oracle.auth = '/private/token'; },
  ]) { const value = liveInput(); mutate(value); assert.throws(() => validateLiveInput(value)); }
});
test('live provider selects only actual model-visible directory and resource references', () => {
  const plan = { mode: 'live-consume', source: 'mini-live', owner: 'poteto-mode', resource_path: 'playbooks/pause-safely.md' };
  const captured = { messages: [] };
  assert.deepEqual(selectLiveProviderCall(captured, plan), { type: 'toolCall', id: 'live-list', name: 'notion_list',
    arguments: { query: plan.owner, source: plan.source, limit: 20 } });
  const record = { name: plan.owner, source: plan.source, availability: 'available', ref: 'sr:C' + 'a'.repeat(22) };
  const result = (id, value) => ({ role: 'toolResult', toolCallId: id, isError: false,
    content: [{ type: 'text', text: JSON.stringify(value) }], details: { misleading_ref: 'skill://other/SKILL.md' } });
  captured.messages.push(result('live-list', { records: [record], has_more: false }));
  assert.deepEqual(selectLiveProviderCall(captured, plan).arguments, { ref: record.ref });
  const ref = 'sr:R' + 'b'.repeat(22);
  captured.messages.push(result('live-use', { records: [{ name: plan.owner, directory: { files: [{ path: plan.resource_path, ref }] } }] }));
  assert.deepEqual(selectLiveProviderCall(captured, plan), { type: 'toolCall', id: 'live-resource', name: 'read', arguments: { path: ref } });
  captured.messages.push(result('live-resource', {}));
  assert.equal(selectLiveProviderCall(captured, plan), null);
  const ambiguous = structuredClone(captured);
  ambiguous.messages[0].content[0].text = JSON.stringify({ records: [record, record], has_more: false });
  assert.throws(() => selectLiveProviderCall(ambiguous, plan), /NOT_UNIQUE/u);
  ambiguous.messages[0].content[0].text = JSON.stringify({ records: [record], has_more: true });
  assert.throws(() => selectLiveProviderCall(ambiguous, plan), /NOT_UNIQUE/u);
  const missing = structuredClone(captured);
  missing.messages[1].content[0].text = JSON.stringify({ records: [{ name: plan.owner, directory: { files: [] } }] });
  assert.throws(() => selectLiveProviderCall(missing, plan), /RESOURCE_NOT_UNIQUE/u);
});
test('live source metrics preserve attempts, bytes, writes and unknowns without treating absence as zero', () => {
  const events = [{ kind: 'sdk', event: 'end', id: 'sdk1', operation: 'consume', status: 'completed', metrics_observed: true,
    request_metrics: { complete: true, total_requests: 3, trace: [
      { event: 'attempt', request_kind: 'notion_metadata', body_kind: null, request_bytes: 3, response_bytes: 5 },
      { event: 'attempt', request_kind: 'notion_body', body_kind: 'retained_body', request_bytes: 7, response_bytes: 11 },
      { event: 'attempt', request_kind: 'notion_write', body_kind: null, request_bytes: 13, response_bytes: 17 },
    ] } }];
  const result = liveSourceMetrics(events);
  assert.equal(result.attempts, 3); assert.equal(result.request_bytes, 23); assert.equal(result.response_bytes, 33);
  assert.deepEqual(result.categories, { notion_metadata: 1, notion_body: 1, notion_write: 1, provider: 0 });
  assert.equal(result.body_kinds.retained_body, 1);
  assert.throws(() => liveSourceMetrics([]));
  const incomplete = structuredClone(events); incomplete[0].request_metrics.complete = false;
  assert.throws(() => liveSourceMetrics(incomplete));
  const missingTrace = structuredClone(events); missingTrace[0].request_metrics.total_requests++;
  assert.throws(() => liveSourceMetrics(missingTrace), /every actual HTTP attempt/u);
  const unknown = structuredClone(events); unknown[0].request_metrics.trace[0].response_bytes = null;
  assert.equal(liveSourceMetrics(unknown).response_bytes, null);
  unknown[0].request_metrics.trace[0].request_kind = 'unobserved';
  assert.throws(() => liveSourceMetrics(unknown));
});

async function serializerFixture(t, { nested = false, name = '@earendil-works/pi-ai', version = '1.4.0', exported = true } = {}) {
  const root = await mkdtemp(join(await systemTempRoot(), 'pi-serializer-resolution-'));
  t.after(() => console.log('Serializer resolution fixture retained: ' + root));
  const piRoot = join(root, 'node_modules/@earendil-works/pi-coding-agent');
  const apiRoot = join(nested ? piRoot : root, 'node_modules/@earendil-works/pi-ai');
  const modulePath = join(apiRoot, 'lib/serializer.mjs'), packagePath = join(apiRoot, 'package.json');
  await mkdir(piRoot, { recursive: true }); await mkdir(dirname(modulePath), { recursive: true });
  await writeFile(join(piRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.4.0', type: 'module' }));
  await writeFile(packagePath, JSON.stringify({ name, version, type: 'module', exports: {
    [exported ? './api/openai-completions' : '.']: { import: './lib/serializer.mjs' },
  } }));
  await writeFile(modulePath, 'throw new Error("Resolution must not execute the serializer");\n');
  return { piRoot, modulePath: await realpath(modulePath), packagePath: await realpath(packagePath) };
}

for (const nested of [false, true]) test(`installed Pi serializer resolves ${nested ? 'nested' : 'hoisted'} import-only exports`, async t => {
  const fixture = await serializerFixture(t, { nested });
  const identity = await resolveInstalledPiSerializer(fixture.piRoot, '1.4.0');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(identity.resolution.base, await realpath(fixture.piRoot));
  assert.equal(identity.serializer.path, fixture.modulePath);
  assert.equal(identity.serializer.sha256, sha(await readFile(fixture.modulePath)));
  assert.deepEqual(identity.api_package, { name: '@earendil-works/pi-ai', version: '1.4.0', path: fixture.packagePath,
    sha256: sha(await readFile(fixture.packagePath)) });
});

for (const [options, error] of [
  [{ version: '1.3.0' }, /must match the installed Pi version/u],
  [{ name: 'different-package' }, /must belong to pi-ai/u],
  [{ exported: false }, /ERR_PACKAGE_PATH_NOT_EXPORTED/u],
]) test(`installed Pi serializer rejects ${JSON.stringify(options)}`, async t => {
  const fixture = await serializerFixture(t, options);
  await assert.rejects(resolveInstalledPiSerializer(fixture.piRoot, '1.4.0'), error);
});

function scopeFixture() {
  const result = { kind: 'host_cli_scope', command, database, sourceId: 'sdk-fixture', executed: false };
  const content = [{ type: 'text', text: JSON.stringify(result) }];
  const discovery = [{ type: 'text', text: 'Loaded 1 tool. They are available from your next call:\n- notion_ctl: Inspect Notion maintenance metadata.' }];
  const first = context();
  first.messages[0].toolsAdded = first.messages[0].toolsAdded.filter(tool => tool.name !== 'notion_ctl');
  first.messages[0].toolsAdded.push({ name: 'tool_search', description: 'Find deferred tools.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } } });
  const second = structuredClone(first);
  second.messages.push({ role: 'toolResult', toolName: 'tool_search', toolCallId: 'sc05-discover-control', content: discovery,
    details: { loaded: ['notion_ctl'] }, isError: false });
  second.messages.push({ role: 'system', content: '', toolsAdded: [{ name: 'notion_ctl', description: 'Inspect Notion maintenance metadata.',
    parameters: { type: 'object', properties: { cli_source: { type: 'string' } } } }] });
  const third = structuredClone(second);
  third.messages.push({ role: 'toolResult', toolName: 'notion_ctl', toolCallId: 'sc05-source-command', content, details: result, isError: false });
  const frames = [
    { type: 'tool_execution_start', toolName: 'tool_search', toolCallId: 'sc05-discover-control', args: { query: 'Notion CLI source database scope', limit: 1 } },
    { type: 'tool_execution_end', toolName: 'tool_search', toolCallId: 'sc05-discover-control', isError: false, result: { content: discovery, details: { loaded: ['notion_ctl'] } } },
    { type: 'tool_execution_start', toolName: 'notion_ctl', toolCallId: 'sc05-source-command', args: { cli_source: 'sdk-fixture' } },
    { type: 'tool_execution_end', toolName: 'notion_ctl', toolCallId: 'sc05-source-command', isError: false, result: { content, details: result } },
  ];
  return { captures: [{ context: first }, { context: second }, { context: third }], frames };
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

function scalarFixture() {
  const { batch } = resourceFixture(), digest = value => createHash('sha256').update(value).digest('hex');
  batch.main = 'Scalar main must not be read.\n'; batch.refs = batch.files.map(file => file.ref); batch.name = 'resources';
  batch.snapshot.entrypoint = 'SKILL.md';
  Object.assign(batch.snapshot.record, { kind: 'skill', name: batch.name, alias: batch.name, description: 'Controlled scalar source',
    entrypoint: 'SKILL.md', ref: 'skill://' + encodeURIComponent(batch.snapshot.record.id) + '/SKILL.md', default_context: false });
  const unselected = 'Unselected scalar file.\n';
  batch.unselected = [{ path: 'references/unselected.txt', file_id: 'unselected', content: unselected, bytes: Buffer.byteLength(unselected), sha256: digest(unselected) }];
  batch.snapshot.files = [{ path: 'SKILL.md', bytes: Buffer.byteLength(batch.main), sha256: digest(batch.main) },
    ...[...batch.files, ...batch.unselected].map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))];
  batch.snapshot.file_bindings = [{ path: 'SKILL.md', file_id: 'main' }, ...[...batch.files, ...batch.unselected].map(({ path, file_id }) => ({ path, file_id }))];
  const calls = resourceScalarCalls(batch);
  const messages = calls.map(call => ({ role: 'toolResult', toolName: 'read', toolCallId: call.id, isError: false,
    content: [{ type: 'text', text: call.expectedText }], structuredContent: call.expectedText,
    details: { contextBrokerResource: { version: 1, toolCallId: call.id, id: batch.snapshot.record.id, scope: batch.snapshot.scope,
      snapshot_id: batch.snapshot.snapshot_id, version_id: batch.snapshot.version_id, ref: call.file.ref, path: call.file.path,
      file_id: call.file.file_id, bytes: call.file.bytes, sha256: call.file.sha256, loaded: false, delivered_complete_text: call.completeText } } }));
  return { batch, calls, messages };
}

test('fixed scalar plan starts with read and preserves native pagination, BOM, binary and empty text', () => {
  const { batch, calls, messages } = scalarFixture(), before = JSON.stringify(batch);
  assert.deepEqual(calls.map(call => call.id), ['sc14-utf8', 'sc14-page', 'sc14-bom', 'sc14-binary', 'sc14-empty']);
  assert.deepEqual(calls[1].args, { path: batch.refs[1], offset: 2, limit: 1 });
  assert.equal(calls[1].expectedText, '完整正文.\r\n\n[1 more lines in file. Use offset=3 to continue.]');
  assert.equal(calls[2].expectedText, '\ufeffBOM\r\n完整正文.\r\n');
  assert.equal(calls[3].expectedText, '\0\ufffd\u0001\u0002\ufffd\r\n'); assert.equal(calls[4].expectedText, '');
  assert.deepEqual(calls.map(call => call.completeText), [true, false, true, false, true]);
  const context = { messages: [] };
  for (const [index, call] of calls.entries()) {
    assert.deepEqual(selectScalarProviderCall(context, calls), { type: 'toolCall', id: call.id, name: 'read', arguments: call.args });
    context.messages.push(messages[index]);
  }
  assert.equal(selectScalarProviderCall(context, calls), null);
  const refs = batch.refs.map((_, index) => 'sr:R' + String(index).repeat(22));
  assert.deepEqual(resourceScalarCalls(batch, refs).map(call => call.args.path), [refs[0], refs[1], refs[1], refs[3], refs[2]]);
  assert.equal(JSON.stringify(batch), before);
  assert.throws(() => selectScalarProviderCall({ messages: [{ ...messages[0], isError: true }] }, calls));
});

function scalarReadIntervalsFixture(readsPerCall = 1) {
  const { calls } = scalarFixture(), requiredPid = 123, events = [];
  const add = event => events.push({ observer_pid: requiredPid, sequence: events.length + 1, ...event });
  add({ kind: 'object_observer_start' });
  for (const [index, call] of calls.entries()) {
    const id = '123:sdk:' + index;
    add({ kind: 'sdk', operation: 'read', event: 'start', id });
    for (let read = 0; read < readsPerCall; read++) {
      const object = { kind: 'object_read', id: '123:object:' + index + ':' + read, api: 'node:fs.readFile', object_sha256: call.file.sha256 };
      add({ ...object, event: 'start' });
      add({ ...object, event: 'end', code: null, bytes: call.file.bytes, content_sha256: call.file.sha256 });
    }
    add({ kind: 'sdk', operation: 'read', event: 'end', id, status: 'completed' });
  }
  add({ kind: 'object_observer_end', pending_reads: 0 });
  return { events, calls, requiredPid };
}

test('scalar object intervals attribute one or two actual reads per call, including repeated paths and empty objects', () => {
  for (const count of [1, 2]) {
    const value = scalarReadIntervalsFixture(count), before = JSON.stringify(value);
    const result = assertScalarReadObjectIntervals(value.events, value);
    assert.equal(result.sdk_reads, value.calls.length); assert.equal(result.object_reads, count * value.calls.length);
    assert.deepEqual(result.intervals.map(interval => interval.tool_call_id), value.calls.map(call => call.id));
    for (const [index, interval] of result.intervals.entries()) {
      assert.equal(interval.object_reads, count); assert.equal(interval.returned_object_bytes, count * value.calls[index].file.bytes);
      assert.equal(interval.object_sha256, value.calls[index].file.sha256); assert.equal(interval.path, value.calls[index].file.path);
      assert.deepEqual(interval.arguments, value.calls[index].args);
    }
    assert.equal(result.intervals[1].path, result.intervals[2].path);
    assert.equal(result.intervals.at(-1).returned_object_bytes, 0);
    assert.equal(result.intervals.at(-1).object_reads, count, 'An empty object still needs an observed read');
    assert.equal(JSON.stringify(value), before);
  }
});

test('scalar object intervals reject reads crossing a call boundary, outside every call, or absent from a call', () => {
  const renumber = value => value.events.forEach((event, index) => { event.sequence = index + 1; });
  const crossed = scalarReadIntervalsFixture(), objectEnd = crossed.events.splice(3, 1)[0];
  crossed.events.splice(4, 0, objectEnd); renumber(crossed);
  assert.throws(() => assertScalarReadObjectIntervals(crossed.events, crossed), /same SDK interval/);
  const outside = scalarReadIntervalsFixture(), extra = structuredClone(outside.events.slice(2, 4));
  for (const event of extra) event.id = '123:object:outside';
  outside.events.splice(1, 0, ...extra); renumber(outside);
  assert.throws(() => assertScalarReadObjectIntervals(outside.events, outside), /outside the measured SDK read intervals/);
  const absent = scalarReadIntervalsFixture(); absent.events.splice(2, 2); renumber(absent);
  assert.throws(() => assertScalarReadObjectIntervals(absent.events, absent), /Every SDK read must actually read/);
  const overlap = scalarReadIntervalsFixture(), secondStart = overlap.events.splice(5, 1)[0];
  overlap.events.splice(4, 0, secondStart); renumber(overlap);
  assert.throws(() => assertScalarReadObjectIntervals(overlap.events, overlap), /without overlap/);
});

test('scalar object intervals reject incomplete, duplicated, foreign or byte-inconsistent observations', () => {
  for (const [label, mutate] of [
    ['missing SDK end', value => { value.events.splice(4, 1); }],
    ['missing object end', value => { value.events.splice(3, 1); }],
    ['unmatched object end', value => { value.events[3].id = 'unmatched'; }],
    ['duplicate SDK id', value => { value.events[5].id = value.events[8].id = value.events[1].id; }],
    ['duplicate object id', value => { value.events[6].id = value.events[7].id = value.events[2].id; }],
    ['foreign SDK PID', value => { value.events[1].observer_pid++; }],
    ['foreign object PID', value => { value.events[3].observer_pid++; }],
    ['out-of-order observation', value => { value.events[3].sequence = value.events[2].sequence; }],
    ['missing sequence', value => { delete value.events[3].sequence; }],
    ['failed SDK call', value => { value.events[4].status = 'failed'; }],
    ['different object', value => { value.events[2].object_sha256 = value.events[3].object_sha256 = value.calls[1].file.sha256; }],
    ['wrong returned bytes', value => { value.events[3].bytes++; }],
    ['wrong returned hash', value => { value.events[3].content_sha256 = '0'.repeat(64); }],
    ['failed object read', value => { value.events[3].code = 'EIO'; }],
    ['different Store API', value => { value.events[2].api = value.events[3].api = 'node:fs/promises.readFile'; }],
  ]) {
    const value = scalarReadIntervalsFixture(); mutate(value);
    assert.throws(() => assertScalarReadObjectIntervals(value.events, value), label);
  }
});

test('scalar receipts bind exact native results and reject forged identity, full-text and activation claims', () => {
  const value = scalarFixture();
  for (const [index, message] of value.messages.entries()) assert.equal(assertResourceScalarResult(message,
    { batch: value.batch, call: value.calls[index] }).loaded, false);
  for (const mutate of [
    value => { value.messages[1].content[0].text = value.batch.files[1].content; },
    value => { value.messages[1].structuredContent = 'Changed structured output'; },
    value => { value.messages[1].details.contextBrokerResource.id = 'foreign'; },
    value => { value.messages[1].details.contextBrokerResource.scope = 'foreign'; },
    value => { value.messages[1].details.contextBrokerResource.snapshot_id = 's_' + '0'.repeat(64); },
    value => { value.messages[1].details.contextBrokerResource.file_id = 'main'; },
    value => { value.messages[1].details.contextBrokerResource.ref = value.batch.refs[0]; },
    value => { value.messages[1].details.contextBrokerResource.bytes--; },
    value => { value.messages[1].details.contextBrokerResource.sha256 = '0'.repeat(64); },
    value => { value.messages[1].details.contextBrokerResource.delivered_complete_text = true; },
    value => { value.messages[1].details.contextBrokerResource.loaded = true; },
    value => { value.messages[1].details.contextBrokerRead = { loaded: true }; },
  ]) {
    const sample = scalarFixture(); mutate(sample);
    assert.throws(() => assertResourceScalarResult(sample.messages[1], { batch: sample.batch, call: sample.calls[1] }));
  }
});

test('short-reference seed is owner/file metadata and cannot hide main delivery or activation', () => {
  const { batch } = scalarFixture(), selected = resourceScalarSelectedFixture(batch, '/owned/unmaterialized');
  assert.equal(Object.hasOwn(selected, 'body'), false); assert.deepEqual(selected.entryManifest.materialized_paths, []);
  assert.equal(selected.preparationBinding.body_sha256, batch.snapshot.files[0].sha256);
  assert.deepEqual(selected.entryManifest.files.slice(1, 5).map(file => file.ref), batch.refs);
  const entries = [{ type: 'custom', customType: 'context-broker-short-ref', data: { target: { kind: 'selected' } } },
    ...batch.files.map(file => ({ type: 'custom', customType: 'context-broker-short-ref', data: { target: { kind: 'resource', path: file.path } } })),
    { type: 'message', message: { role: 'user', content: 'Declared metadata-only setup.' } }];
  const before = JSON.stringify(entries);
  const state = assertResourceScalarSession(entries, { batch, setupOnly: true });
  assert.equal(state.main_deliveries, 0); assert.equal(state.active_entries, 0); assert.equal(state.short_resource_bindings, 4);
  assert.equal(JSON.stringify(entries), before);
  for (const extra of [
    { type: 'custom', customType: 'context-broker-active-sources', data: {} },
    { type: 'message', message: { role: 'toolResult', details: { contextBrokerRead: {} }, content: [] } },
    { type: 'message', message: { role: 'user', content: batch.main } },
  ]) assert.throws(() => assertResourceScalarSession([...entries, extra], { batch }));
  const hidden = structuredClone(entries); hidden[0].data.body = batch.main;
  assert.throws(() => assertResourceScalarSession(hidden, { batch, setupOnly: true }));
});

function scalarCostFixture(includeMain = false) {
  const { batch } = scalarFixture(), files = [...batch.files, ...(includeMain ? [batch.snapshot.files[0]] : [])], requiredPid = 123;
  const events = [{ observer_pid: requiredPid, kind: 'object_observer_start', objects: '/owned/objects',
    coverage: ['node:fs.readFile', 'node:fs.readFileSync', 'node:fs/promises.readFile'] }];
  for (const [index, file] of files.entries()) {
    const fields = { observer_pid: requiredPid, kind: 'object_read', id: '123:' + index, api: 'node:fs.readFile', object_sha256: file.sha256 };
    events.push({ ...fields, event: 'start' }, { ...fields, event: 'end', code: null, bytes: file.bytes, content_sha256: file.sha256 });
  }
  events.push({ observer_pid: requiredPid, kind: 'object_observer_end', reads: files.length, pending_reads: 0, errors: 0 });
  const materialized = files.map(file => ({ path: 'entry/' + file.path, bytes: file.bytes, sha256: file.sha256 }));
  materialized.push({ path: 'scopes/' + 'c'.repeat(64) + '/indexes/generation/' + 'd'.repeat(64) + '/SKILL.md',
    bytes: 74, sha256: 'e'.repeat(64) });
  const observations = { sdk_calls: 6, sdk_lists: 1, sdk_body_calls: 5, sdk_reads: includeMain ? 4 : 5, sdk_consumes: includeMain ? 1 : 0, sdk_resource_batches: 0 };
  return { batch, events, materialized, observations, requiredPid };
}
test('scalar baseline retains redundant main costs while direct mode forbids them', () => {
  const direct = scalarCostFixture(), baseline = scalarCostFixture(true);
  assert.equal(assertResourceScalarCost(direct.events, direct.materialized, direct.observations, direct).expectation, 'direct_scalar_verified');
  const measured = assertResourceScalarCost(baseline.events, baseline.materialized, baseline.observations, { ...baseline, expectDirect: false });
  assert.equal(measured.expectation, 'baseline_observation_only'); assert.equal(measured.sdk_consumes, 1);
  assert.equal(measured.main.object_reads, 1); assert.equal(measured.main.returned_object_bytes, baseline.batch.snapshot.files[0].bytes);
  assert.equal(measured.main.materialized_files.length, 1);
  assert.equal(measured.metadata_index_files.length, 1, 'Discovery metadata stubs are reported separately from prepared main bodies');
  assert.throws(() => assertResourceScalarCost(baseline.events, baseline.materialized, baseline.observations, baseline));
  const hiddenMain = scalarCostFixture(); hiddenMain.materialized.at(-1).sha256 = hiddenMain.batch.snapshot.files[0].sha256;
  assert.throws(() => assertResourceScalarCost(hiddenMain.events, hiddenMain.materialized, hiddenMain.observations, hiddenMain),
    'A complete main body hash is forbidden even inside a metadata index');
  for (const mutate of [
    value => { value.materialized[0].sha256 = '0'.repeat(64); },
    value => { value.events = []; },
    value => { value.events[2].bytes--; },
    value => { value.materialized.push({ ...value.batch.unselected[0], path: 'entry/' + value.batch.unselected[0].path }); },
  ]) {
    const value = scalarCostFixture(true); mutate(value);
    assert.throws(() => assertResourceScalarCost(value.events, value.materialized, value.observations, { ...value, expectDirect: false }));
  }
});

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
  const path = { type: 'string', description: 'Local file path, or a supplied skill:// or sr: reference. Copy issued refs verbatim.' };
  value.messages[0].toolsAdded.find(tool => tool.name === 'read').parameters = { type: 'object', properties: { path, paths }, oneOf: [
    { type: 'object', properties: { path: { ...path } }, required: ['path'], not: { required: ['paths'] } },
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
    schema => { schema.properties.path.description = 'Path to the file to read (relative or absolute)'; },
    schema => { schema.oneOf[0].properties.path.description = 'Path to the file to read (relative or absolute)'; },
    schema => { schema.properties.path.description = 'Use skill:// or sr: references.'; },
    schema => { schema.oneOf[0].properties.path.description = 'Copy a local file path verbatim.'; },
  ]) {
    const value = resourceSchemaContext(); mutate(value.messages[0].toolsAdded.find(tool => tool.name === 'read').parameters);
    assert.throws(() => assertResourceReadSchema(value));
  }
});

function defaultViewFixture() {
  const records = ['a', 'b'].map(name => ({ id: 'owner:' + name, name, description: 'Metadata', ref: 'skill://owner-' + name + '/SKILL.md' }));
  const fixture = { default_view: { id: 'view-1', records } };
  const discovery = { records: records.map((record, index) => ({ ...record, description: 'Metadata', source: 'sdk-fixture', in_default_view: true, ref: 'sr:C' + String(index).repeat(22) })) };
  const catalog = '<ntn-skills-view-catalog><view source="sdk-fixture" id="view-1" partial="false">Default</view>'
    + discovery.records.map(record => '<skill><name>' + record.name + '</name><description>Metadata</description><source>sdk-fixture</source><location>' + record.ref + '</location></skill>').join('')
    + '</ntn-skills-view-catalog>';
  const captures = [{ requestId: '1', context: { messages: [{ role: 'system', content: '<ntn-skills-discovery status="pending">Notion metadata is pending; this does not mean the directory is empty.</ntn-skills-discovery>' }] } },
    { requestId: '2', context: { messages: [{ role: 'system', content: catalog }] } }];
  const events = [{ kind: 'sdk_catalog', value: { view: { id: 'view-1' }, view_selection: 'first', count: 2, records,
    coverage: { exhaustive: true, failed_sources: [] } } }];
  return { captures, discovery, events, fixture, bodies: new Map([['a', 'Full private body']]) };
}
test('Default View evidence retains pending startup and proves the ready metadata-only continuation', () => {
  const value = defaultViewFixture();
  const result = assertDefaultViewProjection(value.captures, value.discovery, value.events, value.fixture, value.bodies);
  assert.equal(result.status, 'verified'); assert.equal(result.body_delivery, false);
  assert.deepEqual(result.provider_requests.map(request => request.state), ['pending', 'ready']);
});
test('live Default View matches frozen metadata and actual SDK rows without a discovery tool warmup', () => {
  const value = defaultViewFixture();
  value.captures[1].context.messages[0].content = value.captures[1].context.messages[0].content.replaceAll('sdk-fixture', 'mini-live');
  const result = assertDefaultViewProjection(value.captures, undefined, value.events, value.fixture, value.bodies, { sourceId: 'mini-live' });
  assert.deepEqual(result.provider_requests.map(request => request.state), ['pending', 'ready']);
  value.fixture.default_view.records[0].description = 'Different metadata';
  assert.throws(() => assertDefaultViewProjection(value.captures, undefined, value.events, value.fixture, value.bodies, { sourceId: 'mini-live' }));
});
test('missing, partial, stale, duplicate or body-bearing default directories cannot pass', () => {
  for (const mutate of [
    value => { value.events = []; },
    value => { value.events[0].value.coverage.exhaustive = false; },
    value => { value.events[0].value.records.pop(); },
    value => { value.discovery.records[0].in_default_view = false; },
    value => { value.discovery.records[0].ref = 'sr:C' + 'z'.repeat(22); },
    value => { value.captures.pop(); },
    value => { value.captures[1].context.messages[0].content += 'Full private body'; },
    value => { value.captures[1].context.messages.push({ ...value.captures[1].context.messages[0] }); },
    value => { value.captures[1].context.messages[0].content = value.captures[1].context.messages[0].content.replace('<name>a</name>', '<name>sdk-fixture-a</name>'); },
    value => { value.captures[1].context.messages[0].content = value.captures[1].context.messages[0].content.replace('<source>sdk-fixture</source>', '<source>foreign</source>'); },
    value => { value.captures[1].context.messages[0].content = value.captures[1].context.messages[0].content.replace('<source>sdk-fixture</source>', ''); },
  ]) {
    const value = defaultViewFixture(); mutate(value);
    assert.throws(() => assertDefaultViewProjection(value.captures, value.discovery, value.events, value.fixture, value.bodies));
  }
});

function inspectedResourceFixture() {
  const paths = ['references/utf8.txt', 'references/bom.txt', 'references/empty.txt', 'assets/binary.bin'];
  const files = paths.map((path, index) => ({ path, ref: 'sr:R' + String(index + 1).repeat(22) }));
  const root = 'sr:S' + 'a'.repeat(22);
  const model = { ref: root, directory: { files: [...files, { path: 'SKILL.md', ref: root }, { path: 'unselected.txt', ref: 'sr:R' + 'z'.repeat(22) }] } };
  const message = { role: 'toolResult', toolName: 'read', isError: false, content: '' };
  return { paths, model, message, render() { message.content = 'Complete main body\n<skill-directory>' + JSON.stringify(model) + '</skill-directory>'; return message; } };
}
test('short resource handles come from one actual native read directory in explicit requested path order', () => {
  const value = inspectedResourceFixture(), order = [value.paths[1], value.paths[3], value.paths[0], value.paths[2]];
  const message = value.render(), before = JSON.stringify(message);
  assert.deepEqual(resourceRefsFromNative(message, order), [2, 4, 1, 3].map(index => 'sr:R' + String(index).repeat(22)));
  assert.equal(JSON.stringify(message), before);
});
test('short handle selection rejects missing or duplicate files, main handles, failed reads and ambiguous native directories', () => {
  for (const mutate of [
    value => { value.message.toolName = 'notion_use'; },
    value => { value.message.isError = true; },
    value => { value.model.ref = 'skill://foreign/SKILL.md'; },
    value => { value.model.directory.files.shift(); },
    value => { value.model.directory.files.push({ ...value.model.directory.files[0] }); },
    value => { value.model.directory.files[0].ref = value.model.ref; },
    value => { value.model.directory.files[1].ref = value.model.directory.files[0].ref; },
    value => { value.paths.push(value.paths[0]); },
  ]) {
    const value = inspectedResourceFixture(); mutate(value);
    assert.throws(() => resourceRefsFromNative(value.render(), value.paths));
  }
  const value = inspectedResourceFixture(), message = value.render();
  message.content += message.content;
  assert.throws(() => resourceRefsFromNative(message, value.paths), /DIRECTORY_NOT_UNIQUE/);
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
  const context = { messages: [{ role: 'toolResult', toolName: 'notion_use', toolCallId: 'prepare-1',
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
  const native = { role: 'toolResult', toolName: 'read', toolCallId: 'native-inspection', content: [{ type: 'text', text: 'Complete main' }],
    details: { contextBrokerRead: { toolCallId: 'native-inspection' } } };
  const mixed = { messages: [native, message] }, mixedPayload = { ...payload, messages: [
    { role: 'tool', tool_call_id: native.toolCallId, content: native.content[0].text }, ...payload.messages] };
  assert.equal(assertResourceHttpRequest(mixedPayload, Buffer.from(JSON.stringify(mixedPayload)), mixed).delivered.length, 1);
  assert.throws(() => assertResourceHttpRequest(mixedPayload, Buffer.from(JSON.stringify(mixedPayload)), { messages: [native] }), /actual captured tool result/);
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

function providerHttpFixture() {
  const tool = { name: 'read', description: 'Read an advertised ref', parameters: { type: 'object', properties: { path: { type: 'string' } } } };
  const call = { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'sr:R' + 'x'.repeat(22) } };
  const result = { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: '\ufeffComplete\r\n正文\r\n' }],
    details: { machine: 'retained-only-in-host' }, isError: false };
  const context = { messages: [{ role: 'system', content: 'System', toolsAdded: [tool] }, { role: 'assistant', content: [call] }, result] };
  const payload = { model: 'local-fixture', messages: [{ role: 'system', content: 'System' },
    { role: 'assistant', tool_calls: [{ type: 'function', id: call.id, function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] },
    { role: 'tool', tool_call_id: call.id, content: result.content[0].text }], tools: [{ type: 'function', function: tool }] };
  return { context, payload, body: Buffer.from(JSON.stringify(payload)) };
}

test('every-request HTTP evidence keeps actual schemas, tool content and calls separate from captured details', () => {
  const value = providerHttpFixture(), before = JSON.stringify(value);
  const measured = assertProviderHttpRequest(value.payload, value.body, value.context);
  assert.equal(measured.request_bytes, value.body.length);
  assert.equal(measured.tool_calls[0].arguments.path, 'sr:R' + 'x'.repeat(22));
  assert.equal(measured.tool_results[0].content, '\ufeffComplete\r\n正文\r\n');
  assert.deepEqual(measured.tools_schema, value.payload.tools);
  assert.ok(measured.transcript_capture.host_details_bytes > 0);
  assert.equal(value.body.includes('retained-only-in-host'), false);
  assert.equal(JSON.stringify(value), before);
  const first = providerHttpFixture(); first.context.messages.splice(1); first.payload.messages.splice(1);
  const empty = assertProviderHttpRequest(first.payload, Buffer.from(JSON.stringify(first.payload)), first.context);
  assert.deepEqual(empty.tool_calls, []); assert.deepEqual(empty.tool_results, []);
});

test('empty native text remains empty in capture while installed Pi serializer placeholder bytes are counted', () => {
  const value = providerHttpFixture(); value.context.messages.at(-1).content[0].text = '';
  value.payload.messages.at(-1).content = '(no tool output)';
  const before = JSON.stringify(value.context), body = Buffer.from(JSON.stringify(value.payload));
  const result = assertProviderHttpRequest(value.payload, body, value.context);
  assert.equal(result.tool_results[0].captured_content_bytes, 0);
  assert.equal(result.tool_results[0].serializer_empty_result_placeholder, true);
  assert.equal(result.tool_results[0].content_bytes, Buffer.byteLength('(no tool output)'));
  assert.equal(result.tool_content_bytes, Buffer.byteLength('(no tool output)'));
  assert.equal(JSON.stringify(value.context), before);
  value.payload.messages.at(-1).content = '';
  assert.throws(() => assertProviderHttpRequest(value.payload, Buffer.from(JSON.stringify(value.payload)), value.context));
});

test('every-request HTTP evidence rejects missing or changed schemas, arguments, results and leaked host fields', () => {
  for (const mutate of [
    value => { value.payload.tools = []; },
    value => { value.payload.messages[1].tool_calls[0].function.arguments = '{"path":"preseeded-oracle"}'; },
    value => { value.payload.messages[1].tool_calls[0].id = 'wrong-call'; },
    value => { value.payload.messages.pop(); },
    value => { value.payload.messages.push({ ...value.payload.messages.at(-1) }); },
    value => { value.payload.messages.at(-1).content = 'Incomplete'; },
    value => { value.payload.messages.at(-1).details = value.context.messages.at(-1).details; },
  ]) {
    const value = providerHttpFixture(); mutate(value);
    assert.throws(() => assertProviderHttpRequest(value.payload, Buffer.from(JSON.stringify(value.payload)), value.context));
  }
  const value = providerHttpFixture();
  assert.throws(() => assertProviderHttpRequest(value.payload, Buffer.concat([value.body, Buffer.from('\n')]), value.context));
});

function lifecycleBranchFixture() {
  const bodies = new Map(['a', 'b', 'c', 'base'].map(name => [name, 'Instructions for ' + name + '.\n']));
  const snapshots = [...bodies].map(([name, body], index) => ({ scope: 'fixture-scope', record: { id: 'source:' + name, name },
    snapshot_id: 's_' + String(index).repeat(64), version_id: createHash('sha256').update(body).digest('hex') }));
  const bindings = snapshots.map(snapshot => ({ record: snapshot.record, scope: snapshot.scope, snapshot_id: snapshot.snapshot_id,
    version_id: snapshot.version_id, body_sha256: snapshot.version_id, ref: 'skill://' + snapshot.record.name + '/SKILL.md?snapshot=' + snapshot.snapshot_id }));
  const refs = snapshots.map((snapshot, index) => ({ type: 'custom', customType: 'context-broker-short-ref', data: {
    ref: 'sr:S' + String(index).repeat(22), target: { kind: 'selected', identity: { id: snapshot.record.id, scope: snapshot.scope },
      snapshot_id: snapshot.snapshot_id, version_id: snapshot.version_id, body_sha256: snapshot.version_id } } }));
  const active = { type: 'custom', customType: 'context-broker-active-sources', data: {
    graphs: [{ scope: snapshots[0].scope, roots: snapshots.slice(0, 3).map(snapshot => snapshot.record.id), bindings }],
    sources: snapshots.map((snapshot, index) => ({ snapshotId: snapshot.snapshot_id, bodySha256: snapshot.version_id,
      bytes: Buffer.byteLength(bodies.get(snapshot.record.name)), record: { ...snapshot.record, source: 'notion', sourceScope: snapshot.scope,
        snapshotId: snapshot.snapshot_id, versionId: snapshot.version_id, preparationBinding: bindings[index] } })) } };
  return { entries: [...refs, active], snapshots, bodies, selected: true };
}

test('native branch evidence distinguishes preparation from actual activation and checks every fixed pin', async () => {
  const { assertLifecycleBranch } = await import('./notion-sdk-pi.mjs');
  const value = lifecycleBranchFixture(), before = JSON.stringify(value.entries);
  assert.equal(assertLifecycleBranch(value.entries, value).pins.length, 4);
  assert.equal(JSON.stringify(value.entries), before);
  assert.throws(() => assertLifecycleBranch(value.entries, { ...value, selected: false }));
  assert.deepEqual(assertLifecycleBranch([], { ...value, selected: false }).pins, []);
  const prepared = value.entries.slice(0, 1).concat(value.entries[3]);
  const cancelled = assertLifecycleBranch(prepared, { ...value, selected: false, preparedNames: ['a', 'base'] });
  assert.equal(cancelled.active_entries, 0); assert.equal(cancelled.selected_handles, 2);
  assert.throws(() => assertLifecycleBranch(prepared, { ...value, selected: false }));
  assert.throws(() => assertLifecycleBranch(prepared, { ...value, selected: false, preparedNames: ['a', 'b'] }));
  assert.throws(() => assertLifecycleBranch(prepared, value));
});

test('branch evidence rejects missing Requires, changed scopes, pins, body proofs and stale handles', async () => {
  const { assertLifecycleBranch } = await import('./notion-sdk-pi.mjs');
  for (const mutate of [
    value => { value.entries.at(-1).data.sources.pop(); },
    value => { value.entries.at(-1).data.sources[0].snapshotId = 'foreign'; },
    value => { value.entries.at(-1).data.sources[0].record.versionId = 'foreign'; },
    value => { value.entries.at(-1).data.sources[0].record.sourceScope = 'foreign'; },
    value => { value.entries.at(-1).data.sources[0].bytes++; },
    value => { value.entries.at(-1).data.sources[0].bodySha256 = 'foreign'; },
    value => { value.entries.at(-1).data.graphs[0].bindings.pop(); },
    value => { value.entries.at(-1).data.graphs[0].roots.reverse(); },
    value => { value.entries[0].data.target.identity.scope = 'foreign'; },
    value => { value.entries[0].data.target.snapshot_id = 'foreign'; },
    value => { value.entries[0].data.ref = 'sr:S-foreign'; },
    value => { value.entries.shift(); },
  ]) {
    const value = lifecycleBranchFixture(); mutate(value);
    assert.throws(() => assertLifecycleBranch(value.entries, value));
  }
});

test('actual SDK restore evidence requires inspect over complete fixed inputs and never certifies model delivery', async () => {
  const { assertLifecycleRestore } = await import('./notion-sdk-pi.mjs');
  const oracle = lifecycleBranchFixture();
  const fixture = () => ({ status: 'ready', delivery: { status: 'not_observed' }, activation: { status: 'not_evaluated' },
    preparation: { purpose: 'inspect', required_closure: [], roots: oracle.snapshots.map(snapshot => ({
      id: snapshot.record.id, readiness: 'ready', target: 'skill://' + snapshot.record.name + '/SKILL.md?snapshot=' + snapshot.snapshot_id,
      ref: 'skill://' + snapshot.record.name + '/SKILL.md?snapshot=' + snapshot.snapshot_id })) },
    entries: oracle.snapshots.map(snapshot => ({ manifest: { record: snapshot.record, scope: snapshot.scope,
      snapshot_id: snapshot.snapshot_id, version_id: snapshot.version_id }, source_body: { has_more: false,
      bytes: Buffer.byteLength(oracle.bodies.get(snapshot.record.name)), sha256: snapshot.version_id } })) });
  const value = fixture(), before = JSON.stringify(value);
  const result = assertLifecycleRestore(value, oracle);
  assert.equal(result.pins.length, 4); assert.equal(result.delivery_claimed_by_sdk, false);
  assert.equal(JSON.stringify(value), before);
  for (const mutate of [
    value => { value.preparation.purpose = 'use'; },
    value => { value.preparation.required_closure.push('new-requirement'); },
    value => { value.preparation.roots[0].target = 'skill://a/SKILL.md'; },
    value => { value.entries[0].manifest.version_id = 'new-version'; },
    value => { value.entries[0].source_body.has_more = true; },
    value => { value.entries[0].source_body.bytes--; },
    value => { value.entries.pop(); },
    value => { value.delivery.status = 'delivered'; },
    value => { value.activation.status = 'active'; },
  ]) {
    const sample = fixture(); mutate(sample); assert.throws(() => assertLifecycleRestore(sample, oracle));
  }
});

function sequenceFixture() {
  const { context } = providerHttpFixture(), call = context.messages[1].content[0], result = context.messages[2];
  const frames = [{ type: 'message_end', message: context.messages[1] },
    { type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments },
    { type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, isError: false, result }];
  return { frames, captures: [{ requestId: 'host:1', context: { messages: [context.messages[0]] } }, { requestId: 'host:2', context }] };
}
test('tool rounds are reconciled from actual RPC assistant messages, executions and following provider captures', () => {
  const value = sequenceFixture(), before = JSON.stringify(value);
  const measured = assertProviderToolSequence(value.captures, value.frames);
  assert.equal(measured.provider_requests, 2); assert.equal(measured.tool_rounds, 1); assert.equal(measured.tool_calls, 1);
  assert.deepEqual(measured.sequence[0].observed_in_provider_requests, ['host:2']);
  assert.equal(JSON.stringify(value), before);
  for (const mutate of [
    value => { value.frames.pop(); },
    value => { value.frames[0] = { type: 'message_end', message: { role: 'assistant', content: [] } }; },
    value => { value.frames[1] = { ...value.frames[1], args: { path: 'not-the-returned-ref' } }; },
    value => { value.captures.pop(); },
  ]) {
    const sample = sequenceFixture(); mutate(sample);
    assert.throws(() => assertProviderToolSequence(sample.captures, sample.frames));
  }
});

test('expected stale-reference errors remain actual counted tool results and require exact explicit call IDs', () => {
  const value = sequenceFixture(), id = value.frames[1].toolCallId;
  value.frames[2].isError = true; value.captures[1].context.messages.at(-1).isError = true;
  const result = assertProviderToolSequence(value.captures, value.frames, { expectedErrors: [id] });
  assert.equal(result.tool_calls, 1); assert.equal(result.sequence[0].is_error, true);
  assert.throws(() => assertProviderToolSequence(value.captures, value.frames));
  assert.throws(() => assertProviderToolSequence(value.captures, value.frames, { expectedErrors: ['absent'] }));
  assert.throws(() => assertProviderToolSequence(value.captures, value.frames, { expectedErrors: [id, id] }));
  value.captures[1].context.messages.at(-1).isError = false;
  assert.throws(() => assertProviderToolSequence(value.captures, value.frames, { expectedErrors: [id] }));
  value.frames[2].isError = false;
  assert.throws(() => assertProviderToolSequence(value.captures, value.frames, { expectedErrors: [id] }));
});

function searchProjectionFixture(compact = true) {
  const full = { ok: true, state: 'known', count: 1, has_more: false, records: [{ id: 'owner', scope: 'scope', ref: 'sr:C' + 'c'.repeat(22),
    kind: 'skill', name: 'a', description: 'Author description', source: 'sdk-fixture', in_default_view: false, availability: 'available' }], failures: [] };
  const model = { ...full, records: full.records.map(({ id, scope, ...record }) => compact ? record : { id, scope, ...record }) };
  return { role: 'toolResult', toolName: 'notion_list', toolCallId: 'search', isError: false, content: [{ type: 'text', text: JSON.stringify(model) }], details: full };
}
test('compact search omits only model id/scope while baseline observation cannot certify the new contract', () => {
  const value = searchProjectionFixture(), before = JSON.stringify(value);
  assert.equal(assertSearchProjection(value, { scope: 'scope' }).compact_contract, 'verified');
  assert.equal(JSON.stringify(value), before);
  const legacy = searchProjectionFixture(false);
  assert.equal(assertSearchProjection(legacy, { expectCompact: false }).compact_contract, 'not_required_for_baseline');
  assert.throws(() => assertSearchProjection(legacy));
  delete value.details.records[0].id;
  assert.throws(() => assertSearchProjection(value), 'The full machine identity must survive in details');
});

function dollarProjectionFixture(compact = true) {
  const bodies = new Map([['a', '\ufeff作者 <instructions>literal source</instructions>\r\n'], ['base', 'Base instructions.\n']]);
  const snapshots = [...bodies.keys()].map(name => ({ record: { name }, entrypoint: 'SKILL.md',
    files: [{ path: 'SKILL.md' }, ...(name === 'a' ? [{ path: 'assets/sample.bin' }] : [])] }));
  const content = [...bodies].map(([name, body]) => {
    const encoded = body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return `<context-broker-record kind="skill" name="${name}" ${compact ? 'ref="sr:S' + name[0].repeat(22) + '"' : 'path="~/cache/main"'}>\n`
      + (compact ? name === 'a' ? '<resources>' + JSON.stringify([{ path: 'assets/sample.bin', ref: 'sr:R' + 'r'.repeat(22) }]) + '</resources>\n' : ''
        : '<instructions>Generic repeated wrapper</instructions>\n<resources>Generic resource guidance</resources>\n<skill-directory>~/cache/' + name + '</skill-directory>\n')
      + '<body>\n' + encoded + '\n</body>\n</context-broker-record>';
  }).join('\n');
  return { bodies, snapshots, context: { messages: [{ role: 'user', content }] } };
}
test('compact dollar checks only generated envelopes and preserves every escaped author byte', () => {
  const value = dollarProjectionFixture(), before = JSON.stringify(value.context);
  assert.equal(assertDollarProjection(value.context, value).compact_contract, 'verified');
  assert.equal(JSON.stringify(value.context), before);
  const baseline = dollarProjectionFixture(false);
  assert.equal(assertDollarProjection(baseline.context, { ...baseline, expectCompact: false }).compact_contract, 'not_required_for_baseline');
  assert.throws(() => assertDollarProjection(baseline.context, baseline));
  value.context.messages[0].content = value.context.messages[0].content.replace('作者', 'Summary');
  assert.throws(() => assertDollarProjection(value.context, value), 'A smaller summary cannot replace complete source bytes');
});

test('dollar resource entries require exact selected paths and copied resource handles instead of cache directories', () => {
  for (const mutate of [
    text => text.replace(/<resources>[\s\S]*?<\/resources>/u, '<skill-directory>/cache/entry</skill-directory>'),
    text => text.replace('assets/sample.bin', 'other-owner.bin'),
    text => text.replace('sr:R', 'sr:S'),
    text => text.replace('"path":"assets/sample.bin"', '"path":"assets/sample.bin","sha256":"machine-proof"'),
  ]) {
    const value = dollarProjectionFixture(); value.context.messages[0].content = mutate(value.context.messages[0].content);
    assert.throws(() => assertDollarProjection(value.context, value));
  }
});

function nativeProjectionFixture(compact = true) {
  const hash = value => createHash('sha256').update(value).digest('hex'), body = '\ufeff正文\r\n', mainRef = 'sr:S' + 'a'.repeat(22), resourceRef = 'sr:R' + 'b'.repeat(22);
  const files = [{ path: 'SKILL.md', ref: 'skill://owner/SKILL.md?snapshot=fixed', bytes: Buffer.byteLength(body), sha256: hash(body) },
    { path: 'asset.bin', ref: 'skill://owner/asset.bin?snapshot=fixed', bytes: 2, sha256: hash(Buffer.from([0, 255])) }];
  const directory = { files, required: [{ id: 'base', ref: 'skill://base/SKILL.md?snapshot=fixed', kind: 'skill', name: 'base', description: 'Base', availability: 'available' }], candidates: [], references: [] };
  const modelDirectory = { ...directory, files: files.map(({ sha256, ...file }, index) => ({ ...(compact ? file : { ...file, sha256 }), ref: index ? resourceRef : mainRef })),
    required: directory.required.map(({ id, ...record }) => compact ? record : { id, ...record }) };
  const snapshot = { record: { id: 'owner' }, scope: 'scope', snapshot_id: 'fixed', version_id: 'version', entrypoint: 'SKILL.md', files: structuredClone(files) };
  const content = body + '\n\n<skill-directory>\n' + JSON.stringify({ ref: mainRef, directory: modelDirectory }) + '\n</skill-directory>';
  const proof = { binding: { record: snapshot.record, scope: snapshot.scope, version_id: snapshot.version_id }, snapshotId: snapshot.snapshot_id,
    bodySha256: hash(body), bytes: Buffer.byteLength(body), ...(compact ? { directory } : {}) };
  return { body, snapshot, message: { role: 'toolResult', toolName: 'read', toolCallId: 'native', isError: false, content: [{ type: 'text', text: content }], details: { contextBrokerRead: proof } } };
}
test('native compact footer retains direct resource refs and checks full hashes/identity in host details', () => {
  const value = nativeProjectionFixture(), before = JSON.stringify(value);
  const result = assertNativeProjection(value.message, value);
  assert.equal(result.compact_contract, 'verified'); assert.equal(result.full_host_directory, true);
  assert.deepEqual(result.resource_refs, ['sr:R' + 'b'.repeat(22)]); assert.equal(JSON.stringify(value), before);
  const baseline = nativeProjectionFixture(false);
  assert.equal(assertNativeProjection(baseline.message, { ...baseline, expectCompact: false }).compact_contract, 'not_required_for_baseline');
  assert.throws(() => assertNativeProjection(baseline.message, baseline));
  for (const mutate of [
    value => { delete value.message.details.contextBrokerRead.directory.files[0].sha256; },
    value => { value.message.content[0].text = value.message.content[0].text.replace('"bytes":', '"sha256":"leaked","bytes":'); },
    value => { value.message.content[0].text = value.body; },
    value => { value.message.content[0].text = value.message.content[0].text.replace(value.body, 'Shortened body'); },
  ]) {
    const sample = nativeProjectionFixture(); mutate(sample);
    assert.throws(() => assertNativeProjection(sample.message, sample));
  }
});

function nativeRepeatFixture({ expectShort = true, structured = true, splitMain = false } = {}) {
  const { batch, messages } = scalarFixture(), native = nativeProjectionFixture();
  batch.main = native.body;
  Object.assign(batch.snapshot.files[0], { bytes: Buffer.byteLength(batch.main), sha256: createHash('sha256').update(batch.main).digest('hex') });
  const advertisedMainRef = 'sr:S' + 'a'.repeat(22), file = batch.files[0];
  const directory = { ...native.message.details.contextBrokerRead.directory, files: batch.snapshot.files.map(source => {
    const binding = batch.snapshot.file_bindings.find(value => value.path === source.path);
    return { ...source, ref: 'skill://' + encodeURIComponent(batch.snapshot.record.id) + '/' + source.path
      + '?snapshot=' + batch.snapshot.snapshot_id + '&file_id=' + binding.file_id };
  }) };
  const model = { ref: advertisedMainRef, directory: { ...directory,
    files: directory.files.map(({ path, bytes }, index) => ({ path, bytes, ref: index ? 'sr:R' + String(index).repeat(22) : advertisedMainRef })),
    required: directory.required.map(({ id, ...record }) => record) } };
  const footer = '<skill-directory>\n' + JSON.stringify(model) + '\n</skill-directory>';
  const suffix = (splitMain ? '\n' : '\n\n') + footer;
  const mainRef = directory.files[0].ref, resourceRef = model.directory.files.find(value => value.path === file.path).ref;
  const originals = ['sc15-main', 'sc15-resource', 'sc15-main-repeat', 'sc15-resource-repeat'].map((id, index) => {
    const message = structuredClone(index % 2 ? messages[0] : native.message); message.toolCallId = id;
    if (index % 2) message.details.contextBrokerResource.toolCallId = id;
    else {
      message.content = splitMain ? [{ type: 'text', text: batch.main }, { type: 'text', text: footer }]
        : [{ type: 'text', text: batch.main + suffix }];
      Object.assign(message.details.contextBrokerRead, { version: 3, toolCallId: id, loaded: true,
        binding: { record: batch.snapshot.record, scope: batch.snapshot.scope, version_id: batch.snapshot.version_id },
        snapshotId: batch.snapshot.snapshot_id, directory,
        delivery: { start: 0, end: batch.main.length, encoding: 'raw' } });
    }
    return message;
  });
  const projected = structuredClone(originals);
  projected[2].content[0].text = (expectShort ? 'Already loaded.'
    : `The complete Skill entry for snapshot ${batch.snapshot.snapshot_id} is already present in this active context. This successful repeated read verified the same entry bytes; use the existing instructions and their fixed resource directory.`) + (splitMain ? '' : suffix);
  projected[3].content[0].text = expectShort ? 'Already available.'
    : `The complete Skill resource ${file.path} for snapshot ${batch.snapshot.snapshot_id} is already present in this active context. This successful repeated read verified the same resource bytes.`;
  if (expectShort) {
    projected[2].details.contextBrokerRead.loaded = false;
    projected[3].details.contextBrokerResource.delivered_complete_text = false;
  }
  if (!structured) for (const message of projected) delete message.structuredContent;
  const search = { role: 'toolResult', toolName: 'notion_list', toolCallId: 'sc15-search', isError: false,
    content: [{ type: 'text', text: JSON.stringify({ matches: [{ name: batch.name, ref: mainRef }] }) }] };
  const captures = Array.from({ length: 6 }, (_, index) => ({ requestId: index + 1,
    context: { messages: [...context().messages, ...(index ? [structuredClone(search)] : []),
      ...structuredClone(projected.slice(0, Math.max(0, index - 1)))] } }));
  return { batch, originals, captures, model, mainRef, advertisedMainRef, resourceRef, resourcePath: file.path, suffix };
}

test('native repeat selector follows only first-read advertised handles through all four native reads', () => {
  for (const stringContent of [false, true]) {
    const value = nativeRepeatFixture(), state = context();
    if (stringContent) value.originals[0].content = value.originals[0].content[0].text;
    state.messages.push({ role: 'toolResult', toolCallId: 'unrelated', content: [{ type: 'text', text:
      '<skill-directory>' + JSON.stringify({ ref: 'sr:S' + 'z'.repeat(22), directory: { files: [] } }) + '</skill-directory>' }] });
    const refs = [value.mainRef, value.resourceRef, value.advertisedMainRef, value.resourceRef];
    for (const [index, message] of value.originals.entries()) {
      const before = JSON.stringify(state);
      assert.deepEqual(selectNativeRepeatCall(state, value), { type: 'toolCall', id: message.toolCallId, name: 'read', arguments: { path: refs[index] } });
      assert.equal(JSON.stringify(state), before); state.messages.push(message);
    }
    assert.equal(selectNativeRepeatCall(state, value), null);
  }
});

test('native repeat selector rejects missing, ambiguous or invalid advertised handles and failed reads', () => {
  for (const mutate of [
    model => { model.ref = 'skill://owner/SKILL.md'; },
    model => { model.directory.files[1].ref = model.ref; },
    model => { model.directory.files.splice(1, 1); },
    model => { model.directory.files.push(structuredClone(model.directory.files[1])); },
  ]) {
    const value = nativeRepeatFixture(); mutate(value.model);
    value.originals[0].content[0].text = value.batch.main + '<skill-directory>' + JSON.stringify(value.model) + '</skill-directory>';
    assert.throws(() => selectNativeRepeatCall({ messages: [value.originals[0]] }, value), /HANDLES_INVALID/);
  }
  for (const text of ['No directory', '<skill-directory>{</skill-directory>']) {
    const value = nativeRepeatFixture(); value.originals[0].content[0].text = text;
    assert.throws(() => selectNativeRepeatCall({ messages: [value.originals[0]] }, value));
  }
  for (let index = 0; index < 4; index++) {
    const value = nativeRepeatFixture(); value.originals[index].isError = true;
    assert.throws(() => selectNativeRepeatCall({ messages: value.originals.slice(0, index + 1) }, value), /CONTROLLED_REPEAT_.*FAILED/);
  }
});

test('native repeat projection verifies each provider request with omitted or preserved native structured output', () => {
  for (const expectShort of [true, false]) for (const structured of [true, false]) for (const splitMain of [false, true]) {
    const value = nativeRepeatFixture({ expectShort, structured, splitMain }), before = JSON.stringify(value);
    const result = assertNativeRepeatProjection(value.captures, value.originals, { batch: value.batch, expectShort });
    assert.equal(result.expectation, expectShort ? 'short_confirmations_verified' : 'baseline_long_confirmations_recorded');
    assert.equal(result.first_complete_content_preserved, true); assert.equal(result.original_directory_preserved, true);
    assert.deepEqual(result.requests.map(request => request.main_content_copies), [0, 0, 1, 1, 1, 1]);
    assert.deepEqual(result.requests.map(request => request.resource_content_copies), [0, 0, 0, 1, 1, 1]);
    assert.deepEqual(result.requests.at(-1).structured_content_present, structured ? ['sc15-resource', 'sc15-resource-repeat'] : []);
    assert.equal(result.main.native_content_blocks.length, splitMain ? 2 : 1);
    if (splitMain) {
      const repeated = value.captures[5].context.messages.find(message => message.toolCallId === 'sc15-main-repeat');
      assert.equal(value.originals[0].content[0].text, value.batch.main);
      assert.equal(result.main.native_content_blocks[0].bytes, Buffer.byteLength(value.batch.main));
      assert.notEqual(value.batch.main.length, Buffer.byteLength(value.batch.main), 'The source span uses character offsets, not UTF-8 byte length');
      assert.notEqual(result.main.confirmation_bytes, result.main.native_content_blocks[0].bytes);
      assert.equal(repeated.content[0].text, result.main.confirmation);
      assert.deepEqual(repeated.content[1], value.originals[0].content[1]);
    }
    if (expectShort) { assert.equal(result.main.confirmation_bytes, 15); assert.equal(result.resource.confirmation_bytes, 18); }
    else { assert.ok(result.main.confirmation_bytes > 15); assert.ok(result.resource.confirmation_bytes > 18); }
    assert.equal(JSON.stringify(value), before);
    assert.throws(() => assertNativeRepeatProjection(value.captures, value.originals, { batch: value.batch, expectShort: !expectShort }));
  }
});

test('native repeat projection preserves separate directory blocks even when flattened text would match', () => {
  for (const expectShort of [true, false]) for (const id of ['sc15-main', 'sc15-main-repeat']) {
    for (const [label, mutate] of [
      ['changed directory', message => { message.content[1].text = message.content[1].text.replace('references/utf8.txt', 'references/foreign.txt'); }],
      ['missing directory', message => { message.content.pop(); }],
      ['changed directory length', message => { message.content[1].text += '\n'; }],
      ['flattened block boundary', message => { message.content = [{ type: 'text', text: message.content.map(block => block.text).join('\n') }]; }],
    ]) {
      const value = nativeRepeatFixture({ expectShort, splitMain: true });
      const message = value.captures[5].context.messages.find(message => message.toolCallId === id); mutate(message);
      assert.throws(() => assertNativeRepeatProjection(value.captures, value.originals, { batch: value.batch, expectShort }), label);
    }
  }
});

test('native repeat projection rejects lost source, changed directories, forged delivery markers and request drift', () => {
  const at = (value, request, id) => value.captures[request].context.messages.find(message => message.toolCallId === id);
  for (const [label, mutate] of [
    ['missing provider request', value => { value.captures.pop(); }],
    ['raw repeat main shortened', value => { value.originals[2].content[0].text = 'Already loaded.' + value.suffix; }],
    ['raw main incomplete proof', value => { value.originals[2].details.contextBrokerRead.delivery.end--; }],
    ['raw resource changed', value => { value.originals[3].structuredContent = 'Already available.'; }],
    ['first main replaced', value => { at(value, 2, 'sc15-main').content[0].text = 'Already loaded.' + value.suffix; }],
    ['first proof changed', value => { at(value, 2, 'sc15-main').details.contextBrokerRead.bodySha256 = '0'.repeat(64); }],
    ['first structured output changed', value => { at(value, 3, 'sc15-resource').structuredContent = 'Changed'; }],
    ['repeat directory removed', value => { at(value, 4, 'sc15-main-repeat').content[0].text = 'Already loaded.'; }],
    ['repeat main still loaded', value => { at(value, 4, 'sc15-main-repeat').details.contextBrokerRead.loaded = true; }],
    ['repeat resource still complete', value => { at(value, 5, 'sc15-resource-repeat').details.contextBrokerResource.delivered_complete_text = true; }],
    ['repeat source duplicated', value => { at(value, 5, 'sc15-resource-repeat').content[0].text = value.batch.files[0].content; }],
    ['repeat structured output changed', value => { at(value, 5, 'sc15-resource-repeat').structuredContent = 'Already available.'; }],
    ['premature main', value => { value.captures[1].context.messages.push(structuredClone(value.originals[0])); }],
    ['missing result', value => { value.captures[5].context.messages = value.captures[5].context.messages.filter(message => message.toolCallId !== 'sc15-resource-repeat'); }],
    ['duplicate result', value => { value.captures[5].context.messages.push(structuredClone(at(value, 5, 'sc15-resource-repeat'))); }],
    ['failed tool result', value => { at(value, 5, 'sc15-resource-repeat').isError = true; }],
    ['wrong tool', value => { at(value, 5, 'sc15-resource-repeat').toolName = 'notion_use'; }],
    ['unrequested body leaked', value => { value.captures[5].context.messages.push({ role: 'user', content: value.batch.unselected[0].content }); }],
  ]) {
    const value = nativeRepeatFixture(); mutate(value);
    assert.throws(() => assertNativeRepeatProjection(value.captures, value.originals, { batch: value.batch }), label);
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
  const noPrepare = context(); noPrepare.messages[0].toolsAdded = noPrepare.messages[0].toolsAdded.filter(tool => tool.name !== 'notion_use');
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

test('scoped command requires actual deferred discovery before the exact scope receipt', () => {
  const { captures, frames } = scopeFixture();
  const before = JSON.stringify({ captures, frames });
  const verified = assertScopedCommand(captures, frames, expected);
  assert.equal(verified.receipt_delivered_verbatim, true);
  assert.equal(verified.deferred_discovery, 'verified');
  assert.equal(verified.control_absent_before_search, true);
  assert.equal(verified.model_tool_calls, 2);
  assert.equal(verified.model_bash_calls, 0);
  assert.deepEqual(verified.command, command);
  assert.equal(JSON.stringify({ captures, frames }), before);
});

test('pre-exposed control, a loaded detail without schema, or an unobserved search cannot prove discovery', () => {
  for (const mutate of [
    fixture => { fixture.captures[0].context.messages[0].toolsAdded.push({ name: 'notion_ctl' }); },
    fixture => { fixture.captures[1].context.messages.pop(); },
    fixture => { delete fixture.captures[1].context.messages.at(-1).toolsAdded[0].parameters; },
    fixture => { fixture.captures[1].context.messages.at(-2).content = []; },
    fixture => { fixture.frames[1].result.details.loaded = []; },
    fixture => { fixture.frames.splice(0, 2); },
    fixture => { fixture.frames[0].args.query = 'other tool'; },
  ]) {
    const fixture = scopeFixture(); mutate(fixture);
    assert.throws(() => assertScopedCommand(fixture.captures, fixture.frames, expected));
  }
});

test('pre-injected executable, missing bash, another query or a bash call fails the scoped route', () => {
  const preInjected = scopeFixture();
  preInjected.captures[0].context.messages.push({ role: 'user', content: command[1] });
  assert.throws(() => assertScopedCommand(preInjected.captures, preInjected.frames, expected), /First provider request/);
  const missingBash = scopeFixture();
  missingBash.captures[0].context.messages[0].toolsAdded = missingBash.captures[0].context.messages[0].toolsAdded.filter(tool => tool.name !== 'bash');
  assert.throws(() => assertScopedCommand(missingBash.captures, missingBash.frames, expected));
  const wrongQuery = scopeFixture(); wrongQuery.frames[2].args.cli_source = 'other-source';
  assert.throws(() => assertScopedCommand(wrongQuery.captures, wrongQuery.frames, expected));
  const extraBash = scopeFixture();
  extraBash.frames.push({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'extra', args: { command: 'true' } });
  assert.throws(() => assertScopedCommand(extraBash.captures, extraBash.frames, expected), /no bash or body read/);
});

test('wrong source, database, command or missing receipt content cannot be treated as a scoped result', () => {
  for (const changed of [{ sourceId: 'other-source' }, { database: 'other-database' }, { command: ['node', '/other/cli'] }, { executed: true }]) {
    const fixture = scopeFixture();
    const message = fixture.captures[2].context.messages.at(-1);
    message.content = [{ type: 'text', text: JSON.stringify({ ...message.details, ...changed }) }];
    assert.throws(() => assertScopedCommand(fixture.captures, fixture.frames, expected));
  }
  const missing = scopeFixture(); missing.captures[2].context.messages.pop();
  assert.throws(() => assertScopedCommand(missing.captures, missing.frames, expected), /Public tool result/);
  const altered = scopeFixture(); altered.frames[3].result.content = [{ type: 'text', text: '{"different":true}' }];
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
  { kind: 'sdk', event: 'start', id: '42:1', operation: 'list' },
  { kind: 'sdk', event: 'end', id: '42:1', operation: 'list', status: 'completed', sdk_started: true, metrics_observed: true,
    request_metrics: { complete: true, total_requests: 0, trace: [] } },
  { kind: 'observer_end', code: 0, active_sdk: 0, active_children: 0 },
];

test('the initialization cutpoint releases only the original owned read at the native shutdown boundary', async () => {
  const base = await mkdtemp(join(await systemTempRoot(), 'sdk-initialization-probe-'));
  const configPath = join(base, 'config.json'), ordinaryPath = join(base, 'ordinary.txt');
  await writeFile(configPath, '{"owned":true}\n'); await writeFile(ordinaryPath, 'ordinary');
  const io = { readFile: callbackReadFile }, events = [], reached = Promise.withResolvers();
  let release, delivered = false;
  const probe = observeSdkInitialization({ fs: io, configPath, subscribe: handler => { release = handler; },
    record: event => { events.push(event); if (event.kind === 'initialization_held') reached.resolve(); } });
  const result = new Promise((resolve, reject) => io.readFile(configPath, 'utf8', (error, bytes) => {
    delivered = true; if (error) reject(error); else resolve(bytes);
  }));
  await reached.promise;
  assert.equal(delivered, false); assert.equal(probe.pending(), 1);
  assert.equal(await new Promise((resolve, reject) => io.readFile(ordinaryPath, 'utf8', (error, bytes) => error ? reject(error) : resolve(bytes))), 'ordinary');
  assert.equal(delivered, false, 'An unrelated completed read does not release initialization');
  release(); release();
  assert.equal(await result, '{"owned":true}\n'); assert.equal(probe.pending(), 0);
  assert.deepEqual(events.map(event => event.kind), ['initialization_held', 'initialization_shutdown_boundary', 'initialization_released']);
  assert.equal(events.at(-1).callbacks, 1);
  assert.equal(await new Promise((resolve, reject) => io.readFile(configPath, 'utf8', (error, bytes) => error ? reject(error) : resolve(bytes))), '{"owned":true}\n');
});

test('shutdown-only accounting requires one real cancelled list and never claims ready discovery', () => {
  const fields = structuredClone(catalog); fields[2].status = 'cancelled';
  const options = { bodyTransportRequired: false, expectedCatalogOutcome: 'shutdown_cancelled',
    catalogLifecycle: [{ type: 'session_shutdown', pid: 42, monotonic_ns: '2' }] };
  const result = reconcile(observed(fields), lifecycle, options);
  assert.equal(result.sdk_completed_lists, 0); assert.equal(result.sdk_cancelled_lists, 1);
  assert.equal(result.default_catalog_transport, 'not_exercised');
  assert.throws(() => reconcile(observed(fields), lifecycle, { ...options, expectedCatalogOutcome: 'completed' }), /do not establish/);
  assert.throws(() => reconcile(observed(catalog), lifecycle, options));
  assert.throws(() => reconcile(observed(fields), lifecycle, { ...options, catalogLifecycle: [{ type: 'session_tree', pid: 42, monotonic_ns: '2' }] }));
  for (const change of [
    value => { value[2].request_metrics = null; },
    value => { value[2].request_metrics.total_requests = 1; },
    value => { value[3].active_initializations = 1; },
    value => { value.splice(2, 1); },
  ]) { const wrong = structuredClone(fields); change(wrong); assert.throws(() => reconcile(observed(wrong), lifecycle, options)); }
  const pending = structuredClone(catalog); pending[3].observer_pid = pending[0].observer_pid = 42; pending[3].active_initializations = 1;
  assert.equal(sourceFinality(pending, 42, { hostClosed: true }).complete, false);
});

test('metadata-only scope does not weaken the existing mandatory SDK transport assertion', () => {
  assert.throws(() => reconcile(observed(catalog), lifecycle), /empty body SDK observation/);
  const scope = reconcile(observed(catalog), lifecycle, { bodyTransportRequired: false });
  assert.equal(scope.default_body_transport, 'not_applicable_metadata_query');
  assert.equal(scope.sdk_calls, 1); assert.equal(scope.sdk_lists, 1); assert.equal(scope.sdk_body_calls, 0);
  assert.equal(scope.source_children_closed, 0);
  const child = structuredClone(catalog);
  child.splice(1, 0, { kind: 'child_start', id: '42:2', bundled: true, operation: 'list', argv: [command[1], 'list'] },
    { kind: 'child_close', id: '42:2', code: 0, signal: null, request_metrics: { complete: true, total_requests: 0 } });
  assert.throws(() => reconcile(observed(child), lifecycle, { bodyTransportRequired: false }), /must not spawn CLI children/);
  assert.throws(() => reconcile(observed(catalog.filter(item => item.event !== 'end')), lifecycle, { bodyTransportRequired: false }));
});

test('a catalogue interrupted by an actual session boundary retains complete cancellation accounting', () => {
  const fields = [
    { ...catalog[0], monotonic_ns: '10' },
    { ...catalog[1], id: 'cancelled-list', monotonic_ns: '20' },
    { ...catalog[2], id: 'cancelled-list', status: 'cancelled', monotonic_ns: '40', request_metrics: { complete: true, total_requests: 0, trace: [] } },
    { ...catalog[1], id: 'completed-list', monotonic_ns: '50' },
    { ...catalog[2], id: 'completed-list', monotonic_ns: '60', request_metrics: { complete: true, total_requests: 0, trace: [] } },
    { ...catalog[3], monotonic_ns: '70' },
  ];
  const boundary = { type: 'session_tree', pid: 42, monotonic_ns: '30', leaf_id: 'new-branch' };
  const options = { bodyTransportRequired: false, catalogLifecycle: [boundary] };
  const result = reconcile(observed(fields), lifecycle, options);
  assert.equal(result.sdk_cancelled_lists, 1); assert.equal(result.sdk_lists, 2); assert.equal(result.sdk_http, 0);
  assert.deepEqual(result.cancelled_catalogs, [{ id: 'cancelled-list', pid: 42, native_event: 'session_tree', native_monotonic_ns: '30', http_attempts: 0 }]);
  for (const native of [[], [{ ...boundary, pid: 99 }], [{ ...boundary, monotonic_ns: '19' }], [{ ...boundary, type: 'branch_snapshot' }]])
    assert.throws(() => reconcile(observed(fields), lifecycle, { ...options, catalogLifecycle: native }), /actual session boundary/);
  const unknown = structuredClone(fields); unknown[2].request_metrics = null;
  assert.throws(() => reconcile(observed(unknown), lifecycle, options), /complete metrics/);
  const failed = structuredClone(fields); failed[2].status = 'failed';
  assert.throws(() => reconcile(observed(failed), lifecycle, options), /completed/);
  const body = structuredClone(fields); body[1].operation = body[2].operation = 'consume';
  assert.throws(() => reconcile(observed(body), lifecycle, { ...options, bodyTransportRequired: true }), /Only catalogue/);
});

test('cancelled HTTP attempts are counted and cannot hide behind a complete flag or offline mode', () => {
  const fields = [
    { ...catalog[0], monotonic_ns: '10' },
    { ...catalog[1], id: 'cancelled-list', monotonic_ns: '20' },
    { ...catalog[2], id: 'cancelled-list', status: 'cancelled', monotonic_ns: '40', request_metrics: { complete: true, total_requests: 1, trace: [{ event: 'attempt', attempt: 1, outcome: 'cancelled' }] } },
    { ...catalog[1], id: 'completed-list', monotonic_ns: '50' },
    { ...catalog[2], id: 'completed-list', monotonic_ns: '60', request_metrics: { complete: true, total_requests: 0, trace: [] } },
    { ...catalog[3], monotonic_ns: '70' },
  ];
  const options = { bodyTransportRequired: false, sourceMode: 'live', catalogLifecycle: [{ type: 'session_shutdown', pid: 42, monotonic_ns: '30' }] };
  const result = reconcile(observed(fields), lifecycle, options);
  assert.equal(result.sdk_http, 1); assert.equal(result.cancelled_catalogs[0].http_attempts, 1);
  assert.throws(() => reconcile(observed(fields), lifecycle, { ...options, sourceMode: 'offline' }), /stay offline/);
  fields[2].request_metrics.trace = [];
  assert.throws(() => reconcile(observed(fields), lifecycle, options), /every actual HTTP attempt/);
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
