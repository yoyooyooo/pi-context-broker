import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile as callbackReadFile } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { systemTempRoot } from './verification-paths.mjs';
import { resolveInstalledPiSerializer, observeSdkInitialization, providerSystemText, assertPreflightCatalogProjection, assertNativeCatalogPreserved, publishToolPlan } from './notion-sdk-pi.mjs';
import * as namedSdkProbe from './notion-sdk-pi.mjs';
import { validateLiveInput, selectLiveProviderCall, liveSourceMetrics } from './notion-sdk-pi.mjs';
import { assertNativeGuidance, assertScopedCommand, assertPreparedHttpRequest, assertResourceHttpRequest, assertResourceBatchProjection, assertResourceReadSchema, resourceRefsFromNative, resourceTextCopies, bodyCount, reconcile, sourceFinality, observeOwnedObjectReads, assertObjectReadEvidence, assertProviderHttpRequest, assertProviderToolSequence, assertSearchProjection, assertDefaultViewProjection, assertDollarProjection, assertNativeProjection, resourceScalarCalls, selectScalarProviderCall, assertResourceScalarResult, resourceScalarSelectedFixture, assertResourceScalarSession, assertResourceScalarCost, selectNativeRepeatCall, assertNativeRepeatProjection, assertScalarReadObjectIntervals } from './notion-sdk-pi.mjs';

const command = ['/absolute/node', '/installed/dist/ntn-skills.mjs'];
const database = '11111111-2222-3333-4444-555555555555';
const toolNames = ['read', 'notion_list', 'notion_use', 'bash', 'notion_ctl'];
const guidance = '<ntn-skills-guidance>Use supplied bodies. Request cli_source only for an intended source.</ntn-skills-guidance>';

for (const scenario of ['http-directory', 'http-cache-recovery', 'http-interruption'])
  test(`controlled HTTP entry requires one frozen helper for ${scenario}`, () => {
    assert.equal(typeof namedSdkProbe.controlledHttpOptions, 'function');
    const options = { '--fixture': '/owned/fixture.json', '--scenario': scenario,
      '--source-http-helper': '/frozen/sdk-source-fixture.mjs' };
    assert.deepEqual(namedSdkProbe.controlledHttpOptions(options), {
      scenario, helperPath: '/frozen/sdk-source-fixture.mjs', sourceMode: 'controlled-http' });
    for (const changed of [
      { '--source-http-helper': undefined }, { '--source-http-helper': 'relative.mjs' },
      { '--live-input': '/owned/live.json' }, { '--fixture': undefined },
      { '--warm-directory': 'true' }, { '--expect-short-refs': 'false' },
    ]) assert.throws(() => namedSdkProbe.controlledHttpOptions({ ...options, ...changed }));
  });

test('controlled HTTP entry cannot silently change an existing offline or live route', () => {
  assert.equal(typeof namedSdkProbe.controlledHttpOptions, 'function');
  for (const scenario of [undefined, 'all', 'default-view', 'session-lifecycle']) {
    const options = { '--fixture': '/owned/fixture.json', '--scenario': scenario };
    assert.equal(namedSdkProbe.controlledHttpOptions(options), null);
    assert.throws(() => namedSdkProbe.controlledHttpOptions({ ...options,
      '--source-http-helper': '/frozen/sdk-source-fixture.mjs' }));
  }
});

test('controlled HTTP caller emits the exact planned public call once and retains a declared source error', () => {
  assert.equal(typeof namedSdkProbe.selectControlledHttpCall, 'function');
  const call = { id: 'http-denied-resource', tool: 'read', args: { path: 'skill://owned/references/a.md?snapshot=fixed' }, errorCode: 'ACCESS_DENIED' };
  const context = { messages: [] }, plan = { mode: 'http-call', call };
  assert.deepEqual(namedSdkProbe.selectControlledHttpCall(context, plan), {
    type: 'toolCall', id: call.id, name: call.tool, arguments: call.args });
  context.messages.push({ role: 'toolResult', toolName: 'read', toolCallId: call.id, isError: true,
    content: [{ type: 'text', text: 'context-broker activation failed (ACCESS_DENIED)' }] });
  assert.equal(namedSdkProbe.selectControlledHttpCall(context, plan), null);
  context.messages[0].isError = false; assert.throws(() => namedSdkProbe.selectControlledHttpCall(context, plan));
});

test('controlled HTTP caller cannot accept an undeclared error, another code or an arbitrary tool', () => {
  assert.equal(typeof namedSdkProbe.selectControlledHttpCall, 'function');
  const call = { id: 'http-main', tool: 'read', args: { path: 'skill://owned/SKILL.md' } };
  const context = { messages: [{ role: 'toolResult', toolName: 'read', toolCallId: call.id, isError: true,
    content: [{ type: 'text', text: 'context-broker activation failed (AUTH_REQUIRED)' }] }] };
  assert.throws(() => namedSdkProbe.selectControlledHttpCall(context, { call }));
  assert.throws(() => namedSdkProbe.selectControlledHttpCall(context, { call: { ...call, errorCode: 'ACCESS_DENIED' } }));
  assert.throws(() => namedSdkProbe.selectControlledHttpCall({ messages: [] }, { call: { ...call, tool: 'bash' } }));
});
const context = () => ({ messages: [
  { role: 'system', content: 'Controlled system instructions.', toolsAdded: toolNames.map(name => ({ name })) },
  { role: 'user', content: guidance },
] });

test('tool-plan publication keeps complete prior JSON visible until commit', async t => {
  const root = await mkdtemp(join(await systemTempRoot(), 'sdk-tool-plan-'));
  t.after(() => console.log('Tool-plan fixture retained: ' + root));
  const path = join(root, 'tool-plan.json');
  const previous = { mode: 'complete', holdResponse: true }, next = { mode: 'complete' };
  const previousText = JSON.stringify(previous, null, 2) + '\n';
  await writeFile(path, previousText);
  let opened, release;
  const atWrite = new Promise(resolve => { opened = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const pending = publishToolPlan(path, next, {
    async writeFile(target, value, options) {
      const file = await open(target, options.flag ?? 'w', options.mode);
      opened(target);
      try { await released; await file.writeFile(value); }
      finally { await file.close(); }
    }, rename,
  });
  try {
    const target = await atWrite;
    const visible = await readFile(path, 'utf8');
    t.diagnostic(JSON.stringify({ cutpoint: 'open-before-write', publishedBytes: Buffer.byteLength(visible),
      writerUsesPublishedPath: target === path, writerBytes: (await readFile(target)).length }));
    assert.deepEqual(JSON.parse(visible), previous);
    assert.equal(visible, previousText);
    assert.equal(dirname(target), root);
  } finally { release(); await pending; }
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), next);
  assert.deepEqual(await readdir(root), ['tool-plan.json']);
});

for (const stage of ['write', 'rename']) test(`tool-plan publication preserves the prior plan after ${stage} failure`, async t => {
  const root = await mkdtemp(join(await systemTempRoot(), 'sdk-tool-plan-'));
  t.after(() => console.log('Tool-plan fixture retained: ' + root));
  const path = join(root, 'tool-plan.json'), previous = '{"mode":"complete","holdResponse":true}\n';
  await writeFile(path, previous);
  const failure = Object.assign(new Error('Owned tool-plan publication failure'), { code: 'EIO' });
  const io = {
    async writeFile(target, value, options) {
      if (stage === 'write') { await writeFile(target, value.slice(0, 4), options); throw failure; }
      await writeFile(target, value, options);
    },
    async rename(source, target) {
      if (stage === 'rename') throw failure;
      await rename(source, target);
    },
  };
  await assert.rejects(publishToolPlan(path, { mode: 'complete' }, io), error => error === failure);
  assert.equal(await readFile(path, 'utf8'), previous);
});

function scalePage(count, page) {
  const offset = page * 100, length = Math.min(100, count - offset), more = offset + length < count;
  return { ok: true, state: 'known', count: length, total_count: count, has_more: more,
    next_cursor: more ? `${offset + length}.${'c'.repeat(64)}` : null,
    records: Array.from({ length }, (_, index) => ({ name: `Skill ${offset + index}`, source: 'sdk-fixture',
      ref: 'sr:C' + String(offset + index).padStart(22, '0') })), failures: [] };
}
const scaleCallId = page => page === 0 ? 'sc10-search' : 'sc06-catalog-page-' + (page + 1);
for (const count of [10, 100, 101, 300]) test(`catalog scale follows every returned cursor for ${count} records`, () => {
  const context = { messages: [] }, plan = { mode: 'search', catalog_size: count };
  let cursor;
  for (let page = 0; page < Math.ceil(count / 100); page++) {
    const id = scaleCallId(page), args = { query: '', source: 'sdk-fixture', limit: 100, ...(cursor ? { cursor } : {}) };
    assert.deepEqual(namedSdkProbe.selectProviderCall(context, plan), { type: 'toolCall', id, name: 'notion_list', arguments: args });
    const result = scalePage(count, page);
    context.messages.push({ role: 'toolResult', toolName: 'notion_list', toolCallId: id, isError: false,
      content: [{ type: 'text', text: JSON.stringify(result) }] });
    cursor = result.next_cursor;
  }
  assert.equal(namedSdkProbe.selectProviderCall(context, plan), null);
  assert.equal(context.messages.length + 2, count === 300 ? 5 : count === 101 ? 4 : 3);
});

test('catalog scale follows the actual cursor instead of stopping at the first partial result', () => {
  const page = scalePage(101, 0), context = { messages: [{ role: 'toolResult', toolName: 'notion_list',
    toolCallId: 'sc10-search', isError: false, content: [{ type: 'text', text: JSON.stringify(page) }] }] };
  assert.deepEqual(namedSdkProbe.selectProviderCall(context, { mode: 'search', catalog_size: 101 }),
    { type: 'toolCall', id: 'sc06-catalog-page-2', name: 'notion_list',
      arguments: { query: '', source: 'sdk-fixture', limit: 100, cursor: page.next_cursor } });
});

function catalogScaleFixture(count = 101) {
  const sha = text => createHash('sha256').update(text).digest('hex'), scope = 'a'.repeat(64);
  const snapshots = Array.from({ length: count }, (_, index) => {
    const id = 'shared_skill:scale-library:owner-' + index, body = `UNSELECTED SCALE BODY ${index}\n`, resource = `UNSELECTED SCALE RESOURCE ${index}\n`;
    const record = { id, kind: 'skill', name: `目录 ${index} α 😀`, alias: 'owner-' + index,
      description: `Description ${index}: 中文 😀 "quote" &quot; <tag> & tail\n`, enabled: true, default_context: false,
      entrypoint: 'SKILL.md', ref: 'skill://' + encodeURIComponent(id) + '/SKILL.md',
      locator: { type: 'shared_skill', library_id: 'scale-library', skill_id: 'owner-' + index,
        page_id: '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'), database_id: database,
        data_source_id: '11111111-2222-3333-4444-555555555556' } };
    return { scope, record, snapshot_id: 's_' + sha(body), version_id: sha(body), entrypoint: 'SKILL.md',
      files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(body), sha256: sha(body) },
        { path: 'references/info.txt', bytes: Buffer.byteLength(resource), sha256: sha(resource) }],
      file_bindings: [{ path: 'SKILL.md', file_id: 'main-' + index }, { path: 'references/info.txt', file_id: 'resource-' + index }] };
  });
  const fixture = { version: 1, catalog: true, catalog_size: count, scope, database, snapshots,
    catalog_records: snapshots.map(snapshot => snapshot.record.id), default_view: { id: 'view-1',
      records: snapshots.map(({ record: { id, name, ref } }) => ({ id, name, ref })) } };
  const records = snapshots.map((snapshot, index) => ({ id: snapshot.record.id, scope, kind: snapshot.record.kind,
    name: snapshot.record.name, description: snapshot.record.description, ref: 'sr:C' + String(index).padStart(22, '0'),
    source: 'sdk-fixture', in_default_view: true, availability: 'available' }));
  const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const native = { name: 'catalog-canary', description: 'Native metadata', path: '/owned/native/SKILL.md', marker: 'UNSELECTED_NATIVE_BODY' };
  const section = 'Independent instructions stay unchanged.';
  const nativeSystem = section + '<available_skills><skill><name>' + native.name + '</name><description>' + native.description
    + '</description><location>' + native.path + '</location></skill></available_skills>';
  const catalog = '<ntn-skills-view-catalog><view source="sdk-fixture" id="view-1" partial="false">Default</view>'
    + records.map(record => '<skill><name>' + xml(record.name) + '</name><description>' + xml(record.description)
      + '</description><source>sdk-fixture</source><location>' + record.ref + '</location></skill>').join('') + '</ntn-skills-view-catalog>';
  const system = text => ({ role: 'system', content: nativeSystem + text, toolsAdded: ['read', 'notion_list', 'notion_use'].map(name => ({ name, parameters: { type: 'object' } })) });
  const captures = [{ requestId: '42:1', context: { messages: [system('<ntn-skills-discovery status="pending">Pending</ntn-skills-discovery>')] } }];
  const frames = [], messages = [], entries = records.map((record, index) => ({ type: 'custom', customType: 'context-broker-short-ref',
    data: { ref: record.ref, target: { kind: 'candidate', identity: { source: 'notion', scope, id: record.id, kind: record.kind,
      locator: structuredClone(snapshots[index].record.locator), ref: 'skill://' + encodeURIComponent(record.id) } } } }));
  let cursor;
  for (let page = 0; page < Math.ceil(count / 100); page++) {
    const id = scaleCallId(page), part = records.slice(page * 100, (page + 1) * 100), more = (page + 1) * 100 < count;
    const full = { ok: true, state: 'known', count: part.length, has_more: more, total_count: count,
      next_cursor: more ? `${(page + 1) * 100}.${'c'.repeat(64)}` : null,
      coverage: { exhaustive: true, sources: [{ source: 'sdk-fixture', exhaustive: true }] }, records: part, failures: [] };
    const model = { ...full, records: part.map(({ id, scope, description, ...record }) => record) };
    const message = { role: 'toolResult', toolName: 'notion_list', toolCallId: id, isError: false,
      content: [{ type: 'text', text: JSON.stringify(model) }], details: structuredClone(full) };
    frames.push({ type: 'tool_execution_start', toolName: 'notion_list', toolCallId: id,
      args: { query: '', source: 'sdk-fixture', limit: 100, ...(cursor ? { cursor } : {}) } },
      { type: 'tool_execution_end', toolName: 'notion_list', toolCallId: id, isError: false,
        result: { content: [{ type: 'text', text: JSON.stringify(full) }], details: structuredClone(full) } });
    messages.push(message); entries.push({ type: 'message', message: structuredClone(message) });
    captures.push({ requestId: '42:' + (page + 2), context: { messages: [system(catalog), ...structuredClone(messages)] } });
    cursor = full.next_cursor;
  }
  captures.push({ requestId: '42:' + (captures.length + 1), context: structuredClone(captures.at(-1).context) });
  const events = [{ kind: 'object_observer_start', observer_pid: 42, objects: '/owned/objects',
    coverage: ['node:fs.readFile', 'node:fs.readFileSync', 'node:fs/promises.readFile'] }];
  for (const [index, view] of [false, true].entries()) {
    const id = 'sdk-' + index, record = { observer_pid: 42, id, operation: 'list', source_id: 'sdk-fixture', database };
    const value = { scope, count, records: snapshots.map(snapshot => structuredClone(snapshot.record)),
      coverage: { exhaustive: true, failed_sources: [] }, ...(view ? { view: { id: 'view-1', database_id: database }, view_selection: 'first' } : {}) };
    events.push({ kind: 'sdk', event: 'start', ...record }, { kind: 'sdk_catalog', id, observer_pid: 42, value },
      { kind: 'sdk', event: 'end', ...record, status: 'completed', error_code: null, metrics_observed: true,
        request_metrics: { complete: true, total_requests: 0, trace: [], trace_dropped: 0 } });
  }
  events.push({ kind: 'object_observer_end', observer_pid: 42, reads: 0, pending_reads: 0, errors: 0 });
  const objects = snapshots.flatMap(snapshot => snapshot.files.map(file => ({ ...file, owner: snapshot.record.id })));
  const bodies = new Map(snapshots.map((snapshot, index) => [snapshot.record.name, `UNSELECTED SCALE BODY ${index}\n`]));
  return { fixture, captures, frames, events, entries, objects, bodies, native, section };
}

function combineCatalogEvents(events) {
  const values = events.filter(event => event.kind === 'sdk_catalog');
  assert.equal(values.length, 2);
  return events.filter(event => event.id !== values[1].id).map(event => event.kind === 'sdk_catalog'
    ? { ...event, value: { version: 1, catalog: { ok: true, value: values[0].value }, directory: { ok: true, value: values[1].value } } }
    : event);
}

test('combined catalog evidence preserves one SDK call and both complete directory facets', () => {
  const value = catalogScaleFixture(101);
  value.events = combineCatalogEvents(value.events);
  const before = JSON.stringify(value.events);
  const proof = namedSdkProbe.assertCatalogScaleSource(value.events, value.fixture, value.objects, 42);
  assert.equal(proof.sdk_lists, 1);
  assert.equal(proof.catalog_projections, 2);
  assert.equal(proof.combined_directory, true);
  assert.equal(assertDefaultViewProjection(value.captures, undefined, value.events, value.fixture, value.bodies).status, 'verified');
  assert.equal(JSON.stringify(value.events), before, 'Facet reads must not rewrite the original SDK observation');
});

test('combined catalog failure cannot hide a valid Default View result', () => {
  const value = defaultViewFixture(), directory = value.events[0].value;
  value.events[0].value = { version: 1, catalog: { ok: false, error: { code: 'SHARED_SKILL_ID_CONFLICT', message: 'Unrelated conflict' } }, directory: { ok: true, value: directory } };
  const proof = assertDefaultViewProjection(value.captures, value.discovery, value.events, value.fixture, value.bodies);
  assert.equal(proof.status, 'verified'); assert.equal(proof.sdk_catalog_results, 1);
});

test('combined catalog facets reject unknown contracts, missing outcomes and swapped identities', () => {
  for (const change of [
    value => { value.version = 2; }, value => { delete value.directory; },
    value => { value.directory.value.scope = 'foreign'; },
    value => { value.catalog.value.view = value.directory.value.view; },
    value => { delete value.directory.value.view; },
    value => { value.catalog.ok = false; value.catalog.error = { code: 'DENIED', message: 'Denied' }; },
    value => { value.directory = { ok: false, error: { message: 'No code' } }; },
  ]) {
    const value = catalogScaleFixture(10), events = combineCatalogEvents(value.events);
    change(events.find(event => event.kind === 'sdk_catalog').value);
    assert.throws(() => namedSdkProbe.sdkCatalogObservations(events));
  }
});

function directoryHttpFixture(count = 201, combined = true) {
  const properties = { Name: 'title', Description: 'description', Kind: 'kind', 'Skill ID': 'skill_id', Enabled: 'enabled', 'Default Context': 'default' };
  const fields = Object.values(properties).sort(), ds = '11111111-2222-3333-4444-555555555556';
  const sample = { notion: { library: { skills: { data_source_id: ds, property_ids: properties } },
    skills: Array.from({ length: count }, (_, index) => ({ id: 'raw-' + index, enabled: index !== 1 })) } };
  const requests = [], events = [], pageCount = Math.ceil(count / 100);
  for (let scan = 0; scan < (combined ? 1 : 2); scan++) {
    let bytes = 0;
    for (let page = 0; page < pageCount; page++) {
      const more = page + 1 < pageCount, pageIds = sample.notion.skills.slice(page * 100, (page + 1) * 100).map(row => row.id);
      const payload = JSON.stringify(pageIds); bytes += Buffer.byteLength(payload);
      requests.push({ method: 'POST', path: `/v1/data_sources/${ds}/query`, status: 200, filter_properties: fields,
        body: { page_size: 100, ...(page ? { start_cursor: 'offset-' + page * 100 } : {}) }, page_ids: pageIds,
        returned_properties: fields, has_more: more, next_cursor: more ? 'offset-' + (page + 1) * 100 : null,
        response_bytes_complete: true, decoded_response_bytes: Buffer.byteLength(payload), response_sha256: createHash('sha256').update(payload).digest('hex') });
    }
    const common = { id: 'list-' + scan, observer_pid: 42, operation: 'list' };
    const full = { scope: 'same-scope', records: [] }, directory = { ...full, view: { id: 'default' } };
    events.push({ kind: 'sdk', event: 'start', ...common }, { kind: 'sdk_catalog', id: common.id, observer_pid: 42,
      value: combined ? { version: 1, catalog: { ok: true, value: full }, directory: { ok: true, value: directory } } : scan ? directory : full },
    { kind: 'sdk', event: 'end', ...common, status: 'completed', request_metrics: { complete: true, total_requests: pageCount },
      source_http_terminal: { in_flight: 0, response_bytes: bytes } });
  }
  return { sample, requests, events };
}

for (const count of [101, 201]) test(`combined HTTP metadata proof retains all ${count} raw rows and counts bytes once`, () => {
  const value = directoryHttpFixture(count), before = JSON.stringify(value);
  const proof = namedSdkProbe.assertDirectoryMetadataReuse(value.requests, value.events, { sample: value.sample, hostPid: 42, requireCombined: true });
  assert.equal(proof.pages_per_inventory, Math.ceil(count / 100)); assert.equal(proof.metadata_http_attempts, Math.ceil(count / 100));
  assert.equal(proof.raw_metadata_rows, count); assert.equal(proof.sdk_lists, 1); assert.equal(proof.metadata_reuse, true);
  assert.equal(proof.source_response_bytes, value.requests.reduce((total, request) => total + request.decoded_response_bytes, 0));
  assert.equal(JSON.stringify(value), before);
});

test('legacy two-list HTTP observations remain separate and cannot pass the required reuse gate', () => {
  const value = directoryHttpFixture(201, false), options = { sample: value.sample, hostPid: 42 };
  const proof = namedSdkProbe.assertDirectoryMetadataReuse(value.requests, value.events, options);
  assert.equal(proof.sdk_lists, 2); assert.equal(proof.metadata_http_attempts, 6); assert.equal(proof.metadata_reuse, false);
  assert.throws(() => namedSdkProbe.assertDirectoryMetadataReuse(value.requests, value.events, { ...options, requireCombined: true }));
});

test('combined HTTP metadata proof rejects duplicate scans, missing disabled rows, cursors and unaccounted bytes', () => {
  for (const change of [
    value => { value.requests.push(...structuredClone(value.requests)); },
    value => { value.requests[0].page_ids.splice(1, 1); },
    value => { value.requests.pop(); }, value => { value.requests[1].body.start_cursor = 'offset-200'; },
    value => { value.requests[0].filter_properties.push('payload'); },
    value => { value.requests[0].has_more = false; }, value => { value.requests.at(-1).next_cursor = 'offset-300'; },
    value => { value.requests[0].response_bytes_complete = false; },
    value => { value.requests[0].decoded_response_bytes++; },
    value => { value.events.at(-1).source_http_terminal.response_bytes *= 2; },
    value => { value.events.at(-1).request_metrics.total_requests--; },
  ]) {
    const value = directoryHttpFixture(); change(value);
    assert.throws(() => namedSdkProbe.assertDirectoryMetadataReuse(value.requests, value.events, { sample: value.sample, hostPid: 42, requireCombined: true }));
  }
});

for (const count of [10, 100, 101, 300]) test(`catalog scale binds all ${count} cards across actual pages provider and HTTP text`, () => {
  const value = catalogScaleFixture(count), before = JSON.stringify(value);
  const pages = namedSdkProbe.assertCatalogScalePages(value.captures, value.frames, value.fixture);
  const defaults = assertDefaultViewProjection(value.captures, { records: pages.records }, value.events, value.fixture, value.bodies);
  assert.equal(defaults.provider_requests[0].state, 'pending');
  assert.ok(defaults.provider_requests.slice(1).every(row => row.state === 'ready' && row.records === count));
  assertNativeCatalogPreserved(value.captures, value.native, value.section);
  assert.equal(namedSdkProbe.assertCatalogScaleBindings(pages.records, value.entries, value.fixture).candidates.length, count);
  assert.equal(namedSdkProbe.assertCatalogScaleSource(value.events, value.fixture, value.objects, 42).object_observation.reads, 0);
  const wire = value.captures.map(capture => ({ requestId: capture.requestId,
    context: namedSdkProbe.catalogContextFromHttp({ messages: capture.context.messages.map(message => message.role === 'system' ? message
      : { role: 'tool', tool_call_id: message.toolCallId, content: message.content[0].text }) }, capture.context) }));
  assert.deepEqual(namedSdkProbe.assertCatalogScalePages(wire, value.frames, value.fixture).records, pages.records);
  assert.equal(assertDefaultViewProjection(wire, { records: pages.records }, value.events, value.fixture, value.bodies).provider_requests.at(-1).records, count);
  assert.equal(JSON.stringify(value), before);
});

test('catalog scale is opt-in only for explicit default-view with the complete independent owner set', () => {
  const fixture = catalogScaleFixture(10).fixture, options = { '--fixture': '/owned/fixture.json', '--scenario': 'default-view' };
  assert.deepEqual(namedSdkProbe.catalogScaleOptions(fixture, options), { count: 10, page_size: 100, pages: 1, provider_requests: 3 });
  const ordinary = structuredClone(fixture); delete ordinary.catalog_size;
  assert.equal(namedSdkProbe.catalogScaleOptions(ordinary, { '--scenario': 'all' }), null);
  for (const name of [undefined, 'all', 'dollar', 'native', 'name-references', 'session-lifecycle'])
    assert.throws(() => namedSdkProbe.catalogScaleOptions(fixture, { ...options, '--scenario': name }));
  for (const mutate of [value => { value.catalog_size = 74; }, value => { value.catalog_size = '10'; },
    value => { value.catalog_records[1] = value.catalog_records[0]; }, value => { value.default_view.records.pop(); },
    value => { value.snapshots[0].scope = 'foreign'; }, value => { value.snapshots[0].record.locator.database_id = 'foreign'; },
    value => { value.snapshots[0].record.enabled = false; }, value => { value.distinct_names = true; },
    value => { value.snapshots[0].files.pop(); }, value => { value.snapshots[0].file_bindings.pop(); }]) {
    const bad = structuredClone(fixture); mutate(bad); assert.throws(() => namedSdkProbe.catalogScaleOptions(bad, options));
  }
  for (const option of [{ '--live-input': '/live.json' }, { '--warm-directory': 'true' }, { '--expect-short-refs': 'false' }])
    assert.throws(() => namedSdkProbe.catalogScaleOptions(fixture, { ...options, ...option }));
});

test('catalog scale public pagination rejects missing duplicated foreign or cyclic actual results', () => {
  const page = scalePage(300, 0);
  for (const mutate of [value => { value.has_more = false; }, value => { value.count--; }, value => { value.total_count--; },
    value => { value.records.pop(); }, value => { value.next_cursor = ''; }, value => { value.failures = [{ code: 'DENIED' }]; },
    value => { value.records[0].source = 'foreign'; }, value => { value.records[1].ref = value.records[0].ref; }]) {
    const bad = structuredClone(page); mutate(bad);
    const context = { messages: [{ role: 'toolResult', toolName: 'notion_list', toolCallId: 'sc10-search', content: JSON.stringify(bad) }] };
    assert.throws(() => namedSdkProbe.selectProviderCall(context, { mode: 'search', catalog_size: 300 }));
  }
  const second = scalePage(300, 1); second.next_cursor = page.next_cursor;
  const messages = [page, second].map((result, index) => ({ role: 'toolResult', toolName: 'notion_list', toolCallId: scaleCallId(index), content: JSON.stringify(result) }));
  assert.throws(() => namedSdkProbe.selectProviderCall({ messages }, { mode: 'search', catalog_size: 300 }), /CURSOR_INVALID/);
  assert.throws(() => namedSdkProbe.selectProviderCall({ messages: [messages[0], messages[0]] }, { mode: 'search', catalog_size: 300 }), /RESULT_DUPLICATED/);
  assert.deepEqual(namedSdkProbe.selectProviderCall({ messages: [] }, { mode: 'search' }).arguments, { query: '', source: 'sdk-fixture', limit: 20 });
});

test('catalog scale refuses count-only coverage or metadata and current-reference identity substitutions', () => {
  for (const mutate of [
    value => { value.frames[2].args.cursor = 'invented'; },
    value => { value.frames[1].result.details.total_count--; },
    value => { value.frames[1].result.details.records[0].scope = 'foreign'; },
    value => { value.frames[1].result.details.records[0].source = 'foreign'; },
    value => { value.frames[1].result.details.records[0].id = 'unowned'; },
    value => { value.frames[1].result.details.records[0].description += 'invented'; },
    value => { value.frames[1].result.details.coverage.exhaustive = false; },
    value => { value.captures[1].context.messages.pop(); },
    value => { value.captures.at(-1).context.messages[1].details.records[0].name = 'changed'; },
    value => { value.captures[1].context.messages[0].content = value.section; },
    value => { value.frames[3].result.details.records[0] = structuredClone(value.frames[1].result.details.records[0]); },
  ]) {
    const value = catalogScaleFixture(); mutate(value);
    assert.throws(() => namedSdkProbe.assertCatalogScalePages(value.captures, value.frames, value.fixture));
  }
  for (const mutate of [value => { value.entries[0].data.target.identity.scope = 'foreign'; },
    value => { value.entries[0].data.target.identity.id = 'other'; },
    value => { value.entries[0].data.target.identity.ref += '/SKILL.md'; },
    value => { value.entries[0].data.target.identity.ref += '?snapshot=s_old'; },
    value => { value.entries[0].data.target.identity.locator.page_id = 'foreign'; },
    value => { value.entries[0].data.target.kind = 'selected'; },
    value => { value.entries.shift(); },
    value => { value.entries.push({ type: 'custom', customType: 'context-broker-active-sources', data: { sources: [{}], graphs: [] } }); }]) {
    const value = catalogScaleFixture(10), pages = namedSdkProbe.assertCatalogScalePages(value.captures, value.frames, value.fixture); mutate(value);
    assert.throws(() => namedSdkProbe.assertCatalogScaleBindings(pages.records, value.entries, value.fixture));
  }
});

test('catalog scale zero-body evidence requires completed observers and all independent object hashes', () => {
  for (const mutate of [value => { value.events.shift(); }, value => { value.events.pop(); },
    value => { value.events.at(-1).reads = 1; }, value => { value.events.at(-1).pending_reads = 1; },
    value => { value.events.push({ kind: 'object_read', event: 'start', observer_pid: 42, object_sha256: value.objects.at(-1).sha256 }); },
    value => { value.events.find(event => event.kind === 'sdk_catalog' && !event.value.view).value.records[0].description = 'invented'; },
    value => { value.events.find(event => event.kind === 'sdk' && event.event === 'end').request_metrics.total_requests = 1; },
    value => { value.events.find(event => event.kind === 'sdk' && event.event === 'start').operation = 'consume'; },
  ]) {
    const value = catalogScaleFixture(10); mutate(value);
    assert.throws(() => namedSdkProbe.assertCatalogScaleSource(value.events, value.fixture, value.objects, 42));
  }
});

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

function resourceFixture(state = 'source', effects) {
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
    : { kind: 'text', ref: file.ref, path: file.path, content: state === 'replaced' && file.content.length ? 'Already available.' : file.content }),
    ...(effects === undefined ? {} : { effects }) };
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
    content: [{ type: 'text', text }], structuredContent: model, details: { contextBrokerResource: proof, ...(effects === undefined ? {} : { effects }) } } };
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

test('scalar effects receipts retain exact native spans and reject missing or forged disclosure', () => {
  const value = scalarFixture(), effects = { version: 1, remote_writes: 'none', author_content: 'unchanged', retention: [] };
  for (const [index, message] of value.messages.entries()) {
    const call = value.calls[index];
    message.details.effects = effects;
    Object.assign(message.details.contextBrokerResource, { version: 2, delivery: { start: 0, end: call.expectedText.length, encoding: 'raw' } });
    message.content.push({ type: 'text', text: '\n\n<notion-effects>' + JSON.stringify(effects) + '</notion-effects>' });
    assert.equal(assertResourceScalarResult(message, { batch: value.batch, call }).loaded, false);
    for (const mutate of [
      message => { message.content.pop(); },
      message => { message.details.contextBrokerResource.delivery.end++; },
      message => { message.content[0].text += 'changed'; },
      message => { message.details.effects.remote_writes = 'retained'; },
    ]) {
      const invalid = structuredClone(message); mutate(invalid);
      assert.throws(() => assertResourceScalarResult(invalid, { batch: value.batch, call }));
    }
  }
});

function controlledHttpResourceFixture(withEffects = true) {
  const { batch, calls, messages } = scalarFixture(), call = calls[0], raw = messages[0];
  if (withEffects) {
    const effects = { version: 1, remote_writes: 'unknown', author_content: 'unknown', retention: [] };
    raw.details.effects = effects;
    Object.assign(raw.details.contextBrokerResource, { version: 2, delivery: { start: 0, end: call.expectedText.length, encoding: 'raw' } });
    raw.content.push({ type: 'text', text: '\n\n<notion-effects>' + JSON.stringify(effects) + '</notion-effects>' });
  }
  return { observed: { raw, step: { call: { id: call.id, tool: 'read', args: call.args } }, requests: [] },
    sample: { resource_path: call.file.path, oracle: { cold: { root_id: batch.snapshot.record.id,
      files: batch.snapshot.files, contents: { [call.file.path]: call.expectedText } } } }, binding: batch.snapshot };
}

test('controlled HTTP fixed resource preserves the complete body and exact operation effects', () => {
  for (const withEffects of [false, true]) {
    const value = controlledHttpResourceFixture(withEffects), before = JSON.stringify(value);
    const proof = namedSdkProbe.httpFixedResourceProof(value.observed, value.sample, value.binding);
    assert.equal(proof.snapshot_id, value.binding.snapshot_id);
    assert.equal(proof.path, value.sample.resource_path);
    assert.equal(proof.sha256, value.observed.raw.details.contextBrokerResource.sha256);
    assert.equal(JSON.stringify(value), before);
  }
});

test('controlled HTTP fixed resource rejects changed body, identity, span, disclosure and source requests', () => {
  for (const mutate of [
    value => { value.observed.raw.content[0].text += 'changed'; },
    value => { value.observed.raw.details.contextBrokerResource.file_id = 'foreign'; },
    value => { value.observed.raw.details.contextBrokerResource.scope = 'foreign'; },
    value => { value.observed.raw.details.contextBrokerResource.delivery.end++; },
    value => { value.observed.raw.content.pop(); },
    value => { delete value.observed.raw.details.effects; },
    value => { value.observed.raw.details.effects.remote_writes = 'none'; },
    value => { value.observed.requests.push({ method: 'GET' }); },
  ]) {
    const value = controlledHttpResourceFixture(); mutate(value);
    assert.throws(() => namedSdkProbe.httpFixedResourceProof(value.observed, value.sample, value.binding));
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

test('batch effects are validated against the receipt outside unchanged source spans', () => {
  const effects = { version: 1, remote_writes: 'unknown', author_content: 'unknown', retention: [] };
  for (const state of ['source', 'replaced']) {
    const value = resourceFixture(state, effects);
    assert.deepEqual(assertResourceBatchProjection(value.message, { batch: value.batch, state }).effects, effects);
  }
  for (const mutate of [
    message => { delete message.details.effects; },
    message => { delete message.structuredContent.effects; },
    message => { message.details.effects = { ...effects, remote_writes: 'none', author_content: 'unchanged' }; },
    message => { message.structuredContent.effects.version = 2; },
  ]) {
    const value = resourceFixture('source', structuredClone(effects)); mutate(value.message);
    const text = JSON.stringify(value.message.structuredContent); value.message.content[0].text = text;
    value.message.details.contextBrokerResource.projection.rendered = { sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) };
    assert.throws(() => assertResourceBatchProjection(value.message, { batch: value.batch }));
  }
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
  value.messages[0].toolsAdded.find(tool => tool.name === 'read').parameters = { type: 'object', properties: {
    path, offset: { type: 'number' }, limit: { type: 'number' }, paths,
  } };
  return value;
}
test('actual provider schema exposes native ranges and bounded paths in a supported top-level object', () => {
  const result = assertResourceReadSchema(resourceSchemaContext());
  assert.equal(result.paths_supported, true); assert.equal(result.native_range_options, true);
  assert.equal(result.top_level_object, true); assert.equal(result.validation_boundary, 'tool_execute');
  for (const key of ['path_and_paths_exclusive', 'batch_range_options', 'scalar_branch_ref_guidance']) assert.equal(Object.hasOwn(result, key), false);
  for (const mutate of [
    ...['oneOf', 'anyOf', 'allOf', 'enum', 'const', 'not'].map(key => schema => { schema[key] = []; }),
    schema => { schema.required = ['path']; },
    schema => { schema.required = ['paths']; },
    schema => { schema.properties.offset.type = 'string'; },
    schema => { delete schema.properties.limit; },
    schema => { schema.properties.paths.items.type = 'number'; },
    schema => { schema.properties.paths.minItems = 0; },
    schema => { schema.properties.paths.maxItems = 17; },
    schema => { schema.properties.path.description = 'Path to the file to read (relative or absolute)'; },
    schema => { schema.properties.path.description = 'Use skill:// or sr: references.'; },
    schema => { schema.properties.path.description = 'Copy a local file path verbatim.'; },
  ]) {
    const value = resourceSchemaContext(); mutate(value.messages[0].toolsAdded.find(tool => tool.name === 'read').parameters);
    assert.throws(() => assertResourceReadSchema(value));
  }
});

function defaultViewFixture() {
  const records = ['a', 'b'].map(name => ({ id: 'owner:' + name, kind: 'skill', name, description: 'Metadata', ref: 'skill://owner-' + name + '/SKILL.md' }));
  const fixture = { scope: 'fixture-scope', default_view: { id: 'view-1', records } };
  const discovery = { records: records.map((record, index) => ({ ...record, description: 'Metadata', source: 'sdk-fixture', in_default_view: true, ref: 'sr:C' + String(index).repeat(22) })) };
  const catalog = '<ntn-skills-view-catalog><view source="sdk-fixture" id="view-1" partial="false">Default</view>'
    + discovery.records.map(record => '<skill><name>' + record.name + '</name><description>Metadata</description><source>sdk-fixture</source><location>' + record.ref + '</location></skill>').join('')
    + '</ntn-skills-view-catalog>';
  const captures = [{ requestId: '1', context: { messages: [{ role: 'system', content: '<ntn-skills-discovery status="pending">Notion metadata is pending; this does not mean the directory is empty.</ntn-skills-discovery>' }] } },
    { requestId: '2', context: { messages: [{ role: 'system', content: catalog }] } }];
  const events = [{ kind: 'sdk_catalog', value: { scope: fixture.scope, view: { id: 'view-1' }, view_selection: 'first', count: 2, records,
    coverage: { exhaustive: true, failed_sources: [] } } }];
  return { captures, discovery, events, fixture, bodies: new Map([['a', 'Full private body']]) };
}
test('Default View evidence retains pending startup and proves the ready metadata-only continuation', () => {
  const value = defaultViewFixture();
  const result = assertDefaultViewProjection(value.captures, value.discovery, value.events, value.fixture, value.bodies);
  assert.equal(result.status, 'verified'); assert.equal(result.body_delivery, false);
  assert.deepEqual(result.provider_requests.map(request => request.state), ['pending', 'ready']);
});

function compactDefaultDiscoveryFixture() {
  const value = warmDirectoryFixture();
  value.fixture.snapshots = structuredClone(value.fixture.snapshots);
  value.events = structuredClone(value.events);
  value.fixture.default_view.records = value.fixture.default_view.records.map(({ id, name, ref }) => ({ id, name, ref }));
  const model = JSON.parse(value.message.content[0].text);
  for (const record of model.records) delete record.description;
  value.message.content[0].text = JSON.stringify(model);
  Object.assign(value.message, { role: 'toolResult', toolName: 'notion_list' });
  value.discovery = model;
  value.captures[0].context.messages.push(value.message);
  return value;
}

test('Default View uses independent complete metadata when the same-provider discovery omits descriptions', () => {
  const value = compactDefaultDiscoveryFixture(), before = JSON.stringify(value);
  const result = assertDefaultViewProjection(value.captures, value.discovery, value.events, value.fixture, value.bodies);
  assert.equal(result.status, 'verified');
  assert.equal(result.provider_requests[0].records, 2);
  assert.equal(JSON.stringify(value), before);
  for (const mutate of [
    value => { value.fixture.snapshots[0].record.description = 'Changed frozen metadata'; },
    value => { value.fixture.snapshots[0].scope = 'foreign'; },
    value => { value.fixture.snapshots[0].record.ref = 'skill://different-owner/SKILL.md'; },
    value => { value.fixture.snapshots.push(structuredClone(value.fixture.snapshots[0])); },
    value => { value.events.find(row => row.kind === 'sdk_catalog' && row.value.view).value.records[0].description = 'Different actual SDK metadata'; },
    value => { value.events.find(row => row.kind === 'sdk_catalog' && row.value.view).value.scope = 'foreign'; },
    value => { value.discovery.records[0].description = 'Invented discovery metadata'; },
    value => { value.captures[0].context.messages[0].content = value.captures[0].context.messages[0].content.replace('<description>Metadata</description>', ''); },
  ]) {
    const invalid = compactDefaultDiscoveryFixture(); mutate(invalid);
    assert.throws(() => assertDefaultViewProjection(invalid.captures, invalid.discovery, invalid.events, invalid.fixture, invalid.bodies));
  }
});

test('warm comparison validates omitted discovery descriptions in the corresponding actual provider context', () => {
  const value = compactDefaultDiscoveryFixture(), before = JSON.stringify(value);
  assert.equal(namedSdkProbe.assertWarmDirectoryProjection(value.captures, value.message, value.fixture, value.bodies).status, 'verified');
  assert.equal(JSON.stringify(value), before);
  for (const mutate of [
    value => { value.captures[0].context.messages[0].content = ''; },
    value => { value.captures[0].context.messages[0].content = value.captures[0].context.messages[0].content.replaceAll('Metadata', 'Different'); },
    value => { value.captures[0].context.messages[0].content = value.captures[0].context.messages[0].content.replaceAll('sdk-fixture', 'foreign'); },
    value => { value.captures[0].context.messages[0].content = value.captures[0].context.messages[0].content.replaceAll('sr:C', 'sr:S'); },
  ]) {
    const invalid = compactDefaultDiscoveryFixture(); mutate(invalid);
    assert.throws(() => namedSdkProbe.assertWarmDirectoryProjection(invalid.captures, invalid.message, invalid.fixture, invalid.bodies));
  }
});
test('catalog projection reads current public system sections and retires replaced sections', () => {
  const value = defaultViewFixture();
  for (const capture of value.captures) {
    const text = capture.context.messages[0].content;
    capture.context.messages = [
      { role: 'system', content: 'Native instructions.', sections: { catalog: 'obsolete directory', removed: 'obsolete text', native: 'Native Skill directory.' } },
      { role: 'system', content: '', sections: { catalog: text, removed: null } },
      { role: 'user', content: 'Ordinary request.', details: { sections: { private: 'not model system text' } } },
    ];
  }
  assert.equal(providerSystemText(value.captures[1].context), 'Native instructions.\n\n' + value.captures[1].context.messages[1].sections.catalog + '\n\nNative Skill directory.');
  assert.deepEqual(assertDefaultViewProjection(value.captures, value.discovery, value.events, value.fixture, value.bodies).provider_requests.map(row => row.state), ['pending', 'ready']);
  const forged = structuredClone(value.captures);
  forged[1].context.messages[1].sections.catalog = null;
  forged[1].context.messages[2].content += value.captures[1].context.messages[1].sections.catalog;
  assert.throws(() => assertDefaultViewProjection(forged, value.discovery, value.events, value.fixture, value.bodies), /Missing or incomplete Default View/);
});

test('a data catalog needs an independent native custom-message witness and exact actual provider bytes', () => {
  const value = defaultViewFixture();
  for (const capture of value.captures) {
    const content = capture.context.messages[0].content;
    const native = [{ role: 'system', content: 'Exact safety rules' },
      { role: 'custom', customType: 'context-broker-notion-catalog', content },
      { role: 'user', content: 'Original task' }];
    const observation = { catalogs: namedSdkProbe.captureNativeCatalog(native) };
    capture.context.messages = native.map(message => message.role === 'custom' ? { role: 'user', content: message.content } : message);
    namedSdkProbe.bindNativeCatalog(capture.context, observation);
    assert.equal(providerSystemText(capture.context), 'Exact safety rules');
    assert.ok(namedSdkProbe.providerCatalogText(capture.context).includes(content));
    const wire = structuredClone(capture.context), before = JSON.stringify(wire);
    const mapped = namedSdkProbe.catalogContextFromHttp(wire, capture.context);
    assert.equal(namedSdkProbe.providerCatalogText(mapped), namedSdkProbe.providerCatalogText(capture.context));
    assert.equal(JSON.stringify(wire), before);
    const changed = structuredClone(wire); changed.messages[1].content += ' changed';
    assert.throws(() => namedSdkProbe.catalogContextFromHttp(changed, capture.context));
    const duplicated = structuredClone(wire); duplicated.messages.push(structuredClone(duplicated.messages[1]));
    assert.throws(() => namedSdkProbe.bindNativeCatalog(duplicated, observation));
    assert.deepEqual(namedSdkProbe.captureNativeCatalog(capture.context.messages), [], 'A user tag is not a native origin');
  }
  assert.deepEqual(assertDefaultViewProjection(value.captures, value.discovery, value.events, value.fixture, value.bodies)
    .provider_requests.map(row => row.state), ['pending', 'ready']);
  const unbound = structuredClone(value.captures);
  assert.throws(() => assertDefaultViewProjection(unbound, value.discovery, value.events, value.fixture, value.bodies));
  value.captures[1].context.messages[1].content += ' changed after binding';
  assert.throws(() => namedSdkProbe.providerCatalogText(value.captures[1].context));
});
test('explicit preflight cannot pass with a pending first request or missing selected Required body', () => {
  const sample = () => {
    const value = defaultViewFixture();
    value.bodies = new Map([['a', 'Complete selected a instructions'], ['base', 'Complete Required base instructions'], ['b', 'Unselected b instructions']]);
    const ready = value.captures[1];
    value.captures = ['1', '2', '3'].map(requestId => ({ requestId, context: { messages: [structuredClone(ready.context.messages[0]),
      { role: 'user', content: value.bodies.get('a') + '\n' + value.bodies.get('base') }] } }));
    return value;
  };
  const positive = sample();
  assert.equal(assertPreflightCatalogProjection(positive.captures, positive.discovery, positive.events, positive.fixture, positive.bodies).ready_from_first_provider, true);
  for (const mutate of [
    value => { value.captures[0].context.messages[0] = defaultViewFixture().captures[0].context.messages[0]; },
    value => { value.captures[0].context.messages[1].content = value.bodies.get('a'); },
    value => { value.captures[1].context.messages[1].content += value.bodies.get('b'); },
    value => { value.captures[0].context.messages[0].content += defaultViewFixture().captures[0].context.messages[0].content; },
  ]) {
    const value = sample(); mutate(value);
    assert.throws(() => assertPreflightCatalogProjection(value.captures, value.discovery, value.events, value.fixture, value.bodies));
  }
});
test('Notion catalog projection must preserve native directory, independent section and tool definitions', () => {
  const native = { name: 'catalog-canary', description: 'Native metadata', path: '/owned/native/SKILL.md', marker: 'UNSELECTED_NATIVE_BODY' };
  const section = 'Preserved independent instruction.';
  const sample = () => ['1', '2'].map(requestId => ({ requestId, context: { messages: [{ role: 'system', content: '',
    sections: { native: '<available_skills><skill><name>' + native.name + '</name><description>' + native.description + '</description><location>' + native.path + '</location></skill></available_skills>', independent: section },
    toolsAdded: ['read', 'notion_list', 'notion_use'].map(name => ({ name, description: name, parameters: { type: 'object' } })) }] } }));
  assert.equal(assertNativeCatalogPreserved(sample(), native, section).provider_requests, 2);
  for (const mutate of [
    captures => { delete captures[1].context.messages[0].sections.native; },
    captures => { captures[1].context.messages[0].sections.independent = null; },
    captures => { captures[1].context.messages[0].toolsAdded[0].parameters = { type: 'string' }; },
    captures => { captures[1].context.messages.push({ role: 'user', content: native.marker }); },
  ]) { const captures = sample(); mutate(captures); assert.throws(() => assertNativeCatalogPreserved(captures, native, section)); }
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

function lifecycleCompactionFixture(variant = 'kept') {
  const value = lifecycleBranchFixture(), sha = text => createHash('sha256').update(text).digest('hex');
  const records = [...value.bodies].map(([name, content], index) => ({ name, ref: 'sr:S' + String(index).repeat(22), content }));
  // This fixture tests retention of an already-checked original, not the compiler.
  // The actual driver obtains originalProjection from assertPreparedProjection.
  const originalDelivery = { role: 'toolResult', toolName: 'notion_use', toolCallId: 'original-use', isError: false,
    content: [{ type: 'text', text: JSON.stringify({ records }) }],
    details: { contextBrokerPreparation: { version: 2, toolCallId: 'original-use', records: value.entries.at(-1).data.sources } } };
  const originalProjection = { tool_call_id: originalDelivery.toolCallId,
    content: { sha256: sha(originalDelivery.content[0].text), bytes: Buffer.byteLength(originalDelivery.content[0].text) },
    details: { sha256: sha(JSON.stringify(originalDelivery.details)), bytes: Buffer.byteLength(JSON.stringify(originalDelivery.details)) },
    records: records.map(({ name, ref }) => ({ name, ref })) };
  const summary = variant === 'forged'
    ? 'Controlled untrusted loaded labels; these are not delivery receipts.\n' + records.map(record =>
      `<skill name="${record.name}" ref="${record.ref}" loaded="true">Already loaded.</skill>`).join('\n')
    : 'Controlled lifecycle summary. Continue the ordinary task; recover any active fixed Skill instructions from their persisted bindings.';
  const user = { type: 'message', id: 'selected-user', message: { role: 'user', content: 'Select the controlled Skills.' } };
  const continuation = { type: 'message', id: 'ordinary-user', message: { role: 'user', content: 'Continue normally.' } };
  const entry = { type: 'compaction', id: 'compact', fromHook: true, summary,
    firstKeptEntryId: variant === 'kept' ? user.id : continuation.id };
  value.entries = [user, { type: 'message', id: 'original-delivery', message: structuredClone(originalDelivery) },
    ...value.entries, continuation, entry];
  value.compaction = { variant, originalDelivery, originalProjection, messages: [
    { role: 'compactionSummary', summary }, ...(variant === 'kept' ? [user.message, structuredClone(originalDelivery)] : []), continuation.message,
  ] };
  return value;
}

test('native compaction evidence separates kept delivery from summary-only and forged labels', async () => {
  const { assertLifecycleBranch } = await import('./notion-sdk-pi.mjs');
  for (const variant of ['kept', 'summary', 'forged']) {
    const value = lifecycleCompactionFixture(variant), before = JSON.stringify(value);
    const result = assertLifecycleBranch(value.entries, value);
    assert.equal(result.pins.length, 4);
    assert.equal(result.compaction.variant, variant);
    assert.equal(result.compaction.original_delivery_retained, variant === 'kept');
    assert.deepEqual(Object.values(result.compaction.body_copies_before_restore), [variant === 'kept' ? 1 : 0, variant === 'kept' ? 1 : 0,
      variant === 'kept' ? 1 : 0, variant === 'kept' ? 1 : 0]);
    assert.equal(JSON.stringify(value), before);
  }
});

for (const [label, mutate] of [
  ['missing original body', value => { value.compaction.messages = value.compaction.messages.filter(message => message.role !== 'toolResult'); }],
  ['short confirmation', value => { value.compaction.messages.find(message => message.role === 'toolResult').content[0].text = 'Already loaded.'; }],
  ['missing receipt', value => { delete value.compaction.messages.find(message => message.role === 'toolResult').details; }],
  ['detached tool call', value => { value.compaction.messages.find(message => message.role === 'toolResult').toolCallId = 'other-use'; }],
  ['changed receipt', value => { value.compaction.messages.find(message => message.role === 'toolResult').details.contextBrokerPreparation.version = 1; }],
  ['user impersonation', value => { value.compaction.messages.find(message => message.role === 'toolResult').role = 'user'; }],
  ['duplicate full delivery', value => { value.compaction.messages.push(structuredClone(value.compaction.originalDelivery)); }],
  ['keep after delivery', value => { value.entries.at(-1).firstKeptEntryId = 'ordinary-user'; }],
  ['not a real hook compaction', value => { value.entries.at(-1).fromHook = false; }],
]) test('native kept-compaction evidence rejects ' + label, async () => {
  const { assertLifecycleBranch } = await import('./notion-sdk-pi.mjs');
  const value = lifecycleCompactionFixture(); mutate(value);
  assert.throws(() => assertLifecycleBranch(value.entries, value), { name: 'AssertionError' });
});

for (const [label, mutate] of [
  ['foreign public label', value => { value.entries.at(-1).summary = value.compaction.messages[0].summary = value.entries.at(-1).summary.replace('sr:S' + '0'.repeat(22), 'sr:S' + 'z'.repeat(22)); }],
  ['real body in summary', value => { value.entries.at(-1).summary = value.compaction.messages[0].summary += value.bodies.get('a'); }],
  ['retained full delivery', value => { value.compaction.messages.push(structuredClone(value.compaction.originalDelivery)); }],
  ['trusted receipt on summary', value => { value.compaction.messages[0].details = structuredClone(value.compaction.originalDelivery.details); }],
]) test('native forged-label compaction evidence rejects ' + label, async () => {
  const { assertLifecycleBranch } = await import('./notion-sdk-pi.mjs');
  const value = lifecycleCompactionFixture('forged'); mutate(value);
  assert.throws(() => assertLifecycleBranch(value.entries, value), { name: 'AssertionError' });
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

test('search descriptions may reuse an exact complete card in this actual provider system', () => {
  const message = searchProjectionFixture(), model = JSON.parse(message.content[0].text), record = message.details.records[0];
  delete model.records[0].description; message.content[0].text = JSON.stringify(model);
  const system = '<ntn-skills-view-catalog><skill><name>a</name><description>Author description</description><source>sdk-fixture</source><location>' + record.ref + '</location></skill></ntn-skills-view-catalog>';
  const context = { messages: [{ role: 'system', content: system }, message] }, before = JSON.stringify(context);
  assert.equal(assertSearchProjection(message, { scope: 'scope', context }).compact_contract, 'verified');
  assert.equal(JSON.stringify(context), before);
  for (const text of [system.replace('Author description', 'Other metadata'), system.replace('sr:C', 'sr:S'), system.replace('sdk-fixture', 'foreign'), '']) {
    assert.throws(() => assertSearchProjection(message, { context: { messages: [{ role: 'system', content: text }, message] } }));
  }
  assert.throws(() => assertSearchProjection(message, { context: { messages: [{ role: 'user', content: system }, message] } }));
});

function nativeCatalogReuseFixture() {
  const hash = value => createHash('sha256').update(value).digest('hex');
  const value = warmDirectoryFixture(), scope = 'a'.repeat(64), body = 'Complete independent root.\n', pin = 's_' + 'a'.repeat(64), version = 'v1';
  value.fixture.scope = scope;
  for (const snapshot of value.fixture.snapshots) {
    Object.assign(snapshot.record, { kind: 'skill', entrypoint: 'SKILL.md', ref: 'skill://' + encodeURIComponent(snapshot.record.id) + '/SKILL.md', locator: { type: 'shared_skill' } });
    Object.assign(snapshot, { scope, snapshot_id: pin, version_id: version,
      files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(body), sha256: hash(body) }] });
  }
  for (const record of value.message.details.records) Object.assign(record, { scope, kind: 'skill' });
  value.message.content[0].text = JSON.stringify({ ...value.message.details, records: value.message.details.records.map(({ id, scope, ...record }) => record) });
  const snapshot = value.fixture.snapshots[0], member = value.fixture.snapshots[1].record, visible = value.message.details.records[1];
  const binding = { record: snapshot.record, scope, snapshot_id: pin, version_id: version, body_sha256: hash(body), ref: snapshot.record.ref + '?snapshot=' + pin };
  const canonical = { files: [], required: [], candidates: [{ id: member.id, ref: member.ref, kind: 'skill', name: member.name,
    description: member.description, availability: 'available' }], references: [] };
  const directory = { ...canonical, candidates: canonical.candidates.map(({ id, ...record }) => ({ ...record, ref: visible.ref })) };
  const footer = { ref: 'sr:S' + 's'.repeat(22), directory };
  const read = { role: 'toolResult', toolName: 'read', toolCallId: 'complete-inspect', isError: false,
    content: body + '\n\n<skill-directory>\n' + JSON.stringify(footer) + '\n</skill-directory>', details: { contextBrokerRead: {
      version: 3, identity: JSON.stringify(['sdk-fixture', scope, 'skill', 'shared_skill', snapshot.record.id]), toolCallId: 'complete-inspect',
      snapshotId: pin, bodySha256: hash(body), bytes: Buffer.byteLength(body), delivery: { start: 0, end: body.length, encoding: 'raw' }, binding, directory: canonical } } };
  const after = structuredClone(value.captures[0]); after.requestId = 'after-inspect';
  after.context.messages[0].content = after.context.messages[0].content.replace('<name>b</name><description>Metadata</description>', '<name>b</name>');
  after.context.messages.push(read); value.captures.push(after);
  return { ...value, read, footer, binding };
}

test('a warm catalog can reuse the complete native generated directory in the same provider only', () => {
  const value = nativeCatalogReuseFixture(), before = JSON.stringify(value);
  assert.equal(namedSdkProbe.assertWarmDirectoryProjection(value.captures, value.message, value.fixture, value.bodies).status, 'verified');
  assert.equal(JSON.stringify(value), before);
  const repeated = nativeCatalogReuseFixture();
  repeated.footer.directory.candidates.push({ ...repeated.footer.directory.candidates[0] });
  repeated.read.details.contextBrokerRead.directory.candidates.push({ ...repeated.read.details.contextBrokerRead.directory.candidates[0] });
  repeated.read.content = repeated.read.content.slice(0, repeated.read.details.contextBrokerRead.delivery.end) + '\n\n<skill-directory>\n'
    + JSON.stringify(repeated.footer) + '\n</skill-directory>';
  const repeatedBefore = JSON.stringify(repeated);
  assert.equal(namedSdkProbe.assertWarmDirectoryProjection(repeated.captures, repeated.message, repeated.fixture, repeated.bodies).status, 'verified');
  assert.equal(JSON.stringify(repeated), repeatedBefore, 'A complete repeated row is evidence, not an instruction to remove a relation');
  for (const mutate of [
    value => { value.captures[1].context.messages.pop(); },
    value => { value.read.content = 'Only a summary.'; },
    value => { value.read.isError = true; },
    value => { value.read.toolCallId = 'unrelated'; },
    value => { value.read.details.contextBrokerRead.identity = JSON.stringify(['foreign', value.fixture.scope, 'skill', 'shared_skill', value.binding.record.id]); },
    value => { value.read.details.contextBrokerRead.binding.scope = 'b'.repeat(64); },
    value => { value.read.details.contextBrokerRead.version = 99; },
    value => { value.read.details.contextBrokerRead.binding.record.locator = { type: 'notion_page' }; },
    value => { value.read.content = value.read.content.replace('sr:C', 'sr:S'); },
    value => { value.read.details.contextBrokerRead.directory.candidates[0].ref += '?snapshot=' + value.binding.snapshot_id; },
    value => { value.footer.directory.candidates.push({ ...value.footer.directory.candidates[0] });
      value.read.content = value.read.content.slice(0, value.read.details.contextBrokerRead.delivery.end) + '\n\n<skill-directory>\n'
        + JSON.stringify(value.footer) + '\n</skill-directory>'; },
    value => { value.read.content += '\n<skill-directory>unverified</skill-directory>'; },
  ]) { const invalid = nativeCatalogReuseFixture(); mutate(invalid); assert.throws(() => namedSdkProbe.assertWarmDirectoryProjection(invalid.captures, invalid.message, invalid.fixture, invalid.bodies)); }
});

test('generated description receipts compare locator values independently of JSON key order', () => {
  const value = nativeCatalogReuseFixture();
  const locator = { type: 'shared_skill', library_id: 'library', skill_id: 'a', page_id: 'page', database_id: database, data_source_id: 'data-source' };
  value.fixture.snapshots[0].record.locator = locator;
  value.binding.record = { ...value.binding.record, locator: { type: 'shared_skill', page_id: 'page', database_id: database,
    data_source_id: 'data-source', library_id: 'library', skill_id: 'a' } };
  assert.notEqual(JSON.stringify(value.binding.record.locator), JSON.stringify(locator));
  assert.deepEqual(value.binding.record.locator, locator);
  const check = () => namedSdkProbe.assertWarmDirectoryProjection(value.captures, value.message, value.fixture, value.bodies);
  assert.equal(check().status, 'verified');
  for (const key of ['library_id', 'skill_id', 'page_id', 'database_id', 'data_source_id']) {
    value.binding.record.locator[key] = 'other'; assert.throws(check); value.binding.record.locator[key] = locator[key];
  }
});

function dollarProjectionFixture(compact = true, memberRow = '') {
  const bodies = new Map([['a', '\ufeff作者 <instructions>literal source</instructions>\r\n' + (memberRow ? memberRow + '\r\n' : '')], ['base', 'Base instructions.\n']]);
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

function injectedCatalogReuseFixture(deferred = false) {
  const value = defaultViewFixture(), scope = 'a'.repeat(64), digest = text => createHash('sha256').update(text).digest('hex');
  value.fixture.scope = scope;
  for (const record of value.fixture.default_view.records) Object.assign(record, { entrypoint: 'SKILL.md',
    ref: 'skill://' + encodeURIComponent(record.id) + '/SKILL.md', locator: { type: 'shared_skill', skill_id: record.name } });
  const member = value.fixture.default_view.records[1], candidate = { id: member.id, ref: member.ref, kind: member.kind,
    name: member.name, description: member.description, availability: 'available' };
  const dollar = dollarProjectionFixture(true, `- [${member.name}](${member.ref}) — ${member.description}`);
  const snapshots = dollar.snapshots.map(snapshot => {
    const body = dollar.bodies.get(snapshot.record.name), record = value.fixture.default_view.records.find(record => record.name === snapshot.record.name)
      ?? { id: 'owner:base', name: 'base', kind: 'skill', description: 'Required metadata', ref: 'skill://owner%3Abase/SKILL.md', entrypoint: 'SKILL.md', locator: { type: 'shared_skill', skill_id: 'base' } };
    return { ...snapshot, scope, record, snapshot_id: 's_' + digest(body), version_id: 'version-' + record.name,
      files: snapshot.files.map(file => file.path === snapshot.entrypoint ? { ...file, bytes: Buffer.byteLength(body), sha256: digest(body) } : file) };
  });
  snapshots[0].members = [{ id: member.id, ref: member.ref, metadata: member }];
  value.fixture.snapshots = [...snapshots, { scope, record: member }];
  const content = dollar.context.messages[0].content;
  const proofs = snapshots.map(snapshot => {
    const body = dollar.bodies.get(snapshot.record.name), encoded = body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'), start = content.indexOf(encoded);
    const binding = { scope, record: snapshot.record, snapshot_id: snapshot.snapshot_id, version_id: snapshot.version_id,
      body_sha256: digest(body), ref: snapshot.record.ref + '?snapshot=' + snapshot.snapshot_id };
    return { version: 2, loaded: true, sourceId: 'sdk-fixture', versionId: snapshot.version_id,
      identity: JSON.stringify(['sdk-fixture', scope, snapshot.record.kind, snapshot.record.locator.type, snapshot.record.id]),
      contentIdentity: JSON.stringify([scope, snapshot.record.id]), snapshotId: snapshot.snapshot_id, bodySha256: digest(body), bytes: Buffer.byteLength(body),
      delivery: { start, end: start + encoded.length, encoding: 'xml' }, binding,
      directory: { files: [], required: [], candidates: snapshot.record.name === 'a' ? [candidate] : [], references: [] } };
  });
  const injected = { role: 'custom', customType: 'context-broker', content, details: { records: proofs } };
  const head = value.captures[1].context.messages[0];
  head.content = head.content.replace('<name>b</name><description>Metadata</description>', '<name>b</name>');
  value.events[0].value.scope = scope;
  value.captures = [{ requestId: 'injected', context: { messages: [head, injected] } }];
  if (deferred) {
    const prefix = 'Use the selected Skill.\n', user = { role: 'user', content: prefix + content };
    for (const proof of proofs) { proof.delivery.start += prefix.length; proof.delivery.end += prefix.length; }
    injected.content = []; injected.details.nativePromptSha256 = digest(user.content);
    value.captures[0].context.messages.splice(1, 0, user);
  }
  value.bodies = new Map([...dollar.bodies, ['b', 'Unselected member body.\n']]);
  return { ...value, injected, proofs, snapshots, candidate };
}

function observedInjectionFixture(deferred = false) {
  const value = injectedCatalogReuseFixture(deferred), captured = value.captures[0], digest = text => createHash('sha256').update(text).digest('hex');
  const observation = { type: 'context_with_system', pid: 42, monotonic_ns: '10', session_file: '/owned/sessions/current.jsonl', leaf_id: 'current',
    projection_available: true,
    direct: deferred ? [] : [{ content_sha256: digest(textForTest(value.injected.content)), content_bytes: Buffer.byteLength(textForTest(value.injected.content)),
      details: structuredClone(value.injected.details) }],
    persisted: deferred ? [{ entry_id: 'native-receipt', data: structuredClone(value.injected.details) }] : [] };
  captured.requestId = '42:1';
  captured.context.messages = captured.context.messages.filter(message => message.role !== 'custom' || textForTest(message.content))
    .map(message => message.role === 'custom' ? { role: 'user', content: message.content } : message);
  if (!deferred) captured.context.messages.splice(1, 0, { role: 'user', content: 'Use the selected Skill.' });
  const hooks = [{ requestId: captured.requestId, pid: 42, phase: 'payload_start', monotonic_ns: '20' }];
  return { ...value, observation, hooks, injectionContexts: new Map([[captured.requestId, observation]]) };
}

for (const deferred of [false, true]) test(`actual provider dollar receipt sidecar remains separate with deferred=${deferred}`, () => {
  const value = observedInjectionFixture(deferred), before = JSON.stringify(value.captures);
  value.injectionContexts = namedSdkProbe.bindInjectionContexts(value.captures, [value.observation], value.hooks, { sessionRoot: '/owned/sessions', hostPid: 42 });
  const proof = assertPreflightCatalogProjection(value.captures, value.discovery, value.events, value.fixture, value.bodies,
    { injectionContexts: value.injectionContexts });
  assert.equal(proof.injected_member_reuse.status, 'verified');
  assert.equal(JSON.stringify(value.captures), before);
  assert.doesNotMatch(before, /bodySha256|nativePromptSha256|contentIdentity/);
  assert.ok(value.captures[0].context.messages.every(message => message.role !== 'custom'));
});

test('native injection observation reads only direct custom proofs and effective projection source entries', () => {
  const direct = injectedCatalogReuseFixture(), deferred = injectedCatalogReuseFixture(true);
  const sourceEntry = { type: 'custom', id: 'current-receipt', customType: 'context-broker', data: deferred.injected.details };
  const messages = direct.captures[0].context.messages, projection = { entries: [{ sourceEntry, messages: [] }],
    rawEntries: [{ ...sourceEntry, id: 'other-branch-receipt' }] };
  const before = JSON.stringify({ messages, projection });
  const receipt = namedSdkProbe.captureInjectionReceipts(messages, projection);
  assert.equal(receipt.projection_available, true); assert.equal(receipt.direct.length, 1);
  assert.deepEqual(receipt.direct[0].details, direct.injected.details);
  assert.equal(receipt.direct[0].content_bytes, Buffer.byteLength(direct.injected.content));
  assert.deepEqual(receipt.persisted, [{ entry_id: sourceEntry.id, data: sourceEntry.data }]);
  assert.equal(JSON.stringify({ messages, projection }), before);
  const userOnly = messages.map(message => message.role === 'custom' ? { role: 'user', content: message.content } : message);
  assert.deepEqual(namedSdkProbe.captureInjectionReceipts(userOnly, undefined), { projection_available: false, direct: [], persisted: [] });
  assert.deepEqual(namedSdkProbe.captureInjectionReceipts([], { entries: [], rawEntries: [sourceEntry] }).persisted, [], 'An old branch receipt cannot re-enter the effective projection');
});

test('native injection receipts bind one ordered context per actual provider request and owned session', () => {
  const first = observedInjectionFixture(), second = observedInjectionFixture(true);
  second.captures[0].requestId = '42:2'; second.observation.monotonic_ns = '30';
  Object.assign(second.hooks[0], { requestId: '42:2', monotonic_ns: '40' });
  const original = { captures: [...first.captures, ...second.captures], contexts: [first.observation, second.observation], hooks: [...first.hooks, ...second.hooks] };
  const bind = value => namedSdkProbe.bindInjectionContexts(value.captures, value.contexts, value.hooks, { sessionRoot: '/owned/sessions', hostPid: 42 });
  assert.deepEqual([...bind(original).keys()], ['42:1', '42:2']);
  for (const mutate of [
    value => { value.contexts.pop(); }, value => { value.hooks.pop(); },
    value => { value.contexts.push(structuredClone(value.contexts[0])); },
    value => { value.captures[1].requestId = value.captures[0].requestId; },
    value => { value.contexts[0].pid = 99; }, value => { value.hooks[0].pid = 99; },
    value => { value.contexts[0].pid = value.hooks[0].pid = 99; value.captures[0].requestId = value.hooks[0].requestId = '99:1'; },
    value => { value.contexts.reverse(); }, value => { value.hooks.reverse(); },
    value => { value.contexts[0].monotonic_ns = '21'; }, value => { value.contexts[1].monotonic_ns = '19'; },
    value => { value.contexts[0].session_file = '/other/session.jsonl'; },
    value => { value.contexts[0].direct.push(structuredClone(value.contexts[0].direct[0])); },
    value => { value.contexts[1].persisted.push(structuredClone(value.contexts[1].persisted[0])); },
    value => { value.contexts[1].projection_available = false; },
  ]) { const invalid = structuredClone(original); mutate(invalid); assert.throws(() => bind(invalid)); }
});

test('native dollar sidecar rejects future merged-user receipts and altered source identity or delivery', () => {
  const check = value => assertPreflightCatalogProjection(value.captures, value.discovery, value.events, value.fixture, value.bodies,
    { injectionContexts: value.injectionContexts });
  const first = observedInjectionFixture(), future = observedInjectionFixture(true);
  first.observation.direct = []; first.observation.persisted = future.observation.persisted;
  assert.throws(() => check(first), 'A future combined user hash cannot prove either separate first-request user block');
  for (const deferred of [false, true]) for (const mutate of [
    (value, receipt) => { receipt.records = []; },
    (value, receipt) => { receipt.records[0].sourceId = 'other-source'; },
    (value, receipt) => { receipt.records[0].binding.scope = 'b'.repeat(64); },
    (value, receipt) => { receipt.records[0].binding.record.locator.skill_id = 'other-owner'; },
    (value, receipt) => { receipt.records[0].snapshotId = 's_' + 'b'.repeat(64); },
    (value, receipt) => { receipt.records[0].versionId = 'other-version'; },
    (value, receipt) => { receipt.records[0].binding.ref = receipt.records[0].binding.record.ref; },
    (value, receipt) => { receipt.records[0].bodySha256 = 'b'.repeat(64); },
    (value, receipt) => { receipt.records[0].bytes--; },
    (value, receipt) => { receipt.records[0].delivery.start++; },
    (value, receipt) => { receipt.records[0].directory.candidates[0].ref += '?snapshot=fixed'; },
    (value, receipt) => { receipt.records[0].directory.candidates[0].description = 'Changed metadata'; },
    value => { value.injectionContexts.clear(); },
    value => { const user = value.captures[0].context.messages.find(message => message.role === 'user' && textForTest(message.content).includes('<context-broker-record'));
      user.content = textForTest(user.content).replace('作者', 'Summary'); },
  ]) {
    const value = observedInjectionFixture(deferred), receipt = deferred ? value.observation.persisted[0].data : value.observation.direct[0].details;
    mutate(value, receipt); assert.throws(() => check(value));
  }
  const missingBranch = observedInjectionFixture(true); missingBranch.observation.persisted = []; assert.throws(() => check(missingBranch));
  const wrongPrompt = observedInjectionFixture(true); wrongPrompt.observation.persisted[0].data.nativePromptSha256 = 'b'.repeat(64); assert.throws(() => check(wrongPrompt));
  const wrongBytes = observedInjectionFixture(); wrongBytes.observation.direct[0].content_bytes--; assert.throws(() => check(wrongBytes));
  const wrongDirectHash = observedInjectionFixture(); wrongDirectHash.observation.direct[0].details.nativePromptSha256 = 'b'.repeat(64); assert.throws(() => check(wrongDirectHash));
});

for (const deferred of [false, true]) test(`trusted dollar Members description reuse keeps complete bodies with deferred=${deferred}`, () => {
  const value = injectedCatalogReuseFixture(deferred), before = JSON.stringify(value.captures);
  const proof = assertPreflightCatalogProjection(value.captures, value.discovery, value.events, value.fixture, value.bodies);
  assert.equal(proof.provider_requests[0].reused_descriptions[0].origin, 'actual-injected-member');
  assert.equal(proof.injected_member_reuse.status, 'verified'); assert.deepEqual(proof.injected_member_reuse.candidate_ids, ['owner:b']);
  assert.equal(assertDollarProjection(value.captures[0].context, value).records.length, 2);
  assert.equal(JSON.stringify(value.captures), before);
});

for (const deferred of [false, true]) test(`actual HTTP dollar text uses only its exact independent native sidecar deferred=${deferred}`, () => {
  const value = observedInjectionFixture(deferred), captured = value.captures[0].context, requestId = value.captures[0].requestId;
  const wire = { messages: captured.messages.map(message => ({ role: message.role, content: message.content })) };
  const before = JSON.stringify(wire), mapped = namedSdkProbe.catalogContextFromHttp(wire, captured);
  const options = { injectionContexts: namedSdkProbe.bindInjectionContexts(value.captures, [value.observation], value.hooks) };
  assert.equal(assertPreflightCatalogProjection([{ requestId, context: mapped }], value.discovery, value.events, value.fixture, value.bodies, options).injected_member_reuse.status, 'verified');
  assert.equal(assertDollarProjection(mapped, value).records.length, 2); assert.equal(JSON.stringify(wire), before);
  assert.deepEqual(mapped, wire, 'No source receipt or extra message enters the provider assertion context');
  assert.doesNotMatch(before, /bodySha256|nativePromptSha256|contentIdentity/);
  const changed = structuredClone(wire), body = changed.messages.find(message => message.role === 'user' && textForTest(message.content).includes('<context-broker-record'));
  body.content = textForTest(body.content).replace('作者', 'Summary');
  assert.throws(() => assertPreflightCatalogProjection([{ requestId, context: namedSdkProbe.catalogContextFromHttp(changed, captured) }], value.discovery, value.events, value.fixture, value.bodies, options));
});
function textForTest(content) { return typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('\n'); }

test('a frozen dollar overlap cannot pass while the provider still repeats its Default description', () => {
  const value = injectedCatalogReuseFixture();
  value.captures[0].context.messages[0].content = value.captures[0].context.messages[0].content.replace('<name>b</name>', '<name>b</name><description>Metadata</description>');
  assert.throws(() => assertPreflightCatalogProjection(value.captures, value.discovery, value.events, value.fixture, value.bodies), /must actually remove/);
});

test('trusted dollar Members omission rejects forged source proofs and changed candidate metadata', () => {
  for (const change of [
    value => { value.injected.role = 'user'; }, value => { delete value.injected.details; },
    value => { value.injected.content = value.injected.content.replace('作者', 'Summary'); },
    value => { value.injected.content = value.injected.content.slice(0, -100); },
    value => { value.proofs[0].bodySha256 = 'b'.repeat(64); }, value => { value.proofs[0].bytes--; },
    value => { value.proofs[0].sourceId = 'other-source'; }, value => { value.proofs[0].binding.scope = 'b'.repeat(64); },
    value => { value.proofs[0].identity = JSON.stringify(['other-source', value.fixture.scope, 'skill', 'shared_skill', 'owner:a']); },
    value => { value.proofs[0].contentIdentity = JSON.stringify([value.fixture.scope, 'owner:b']); },
    value => { value.proofs[0].snapshotId = 's_' + 'b'.repeat(64); }, value => { value.proofs[0].versionId = 'different'; },
    value => { value.proofs[0].binding = { ...value.proofs[0].binding, record: { ...value.proofs[0].binding.record, id: 'owner:b' } }; },
    value => { value.proofs[0].binding.ref = value.proofs[0].binding.record.ref; },
    value => { value.candidate.ref += '?snapshot=s_' + 'b'.repeat(64); }, value => { value.candidate.id = 'another-owner'; },
    value => { value.candidate.description = 'Different current metadata'; }, value => { value.candidate.kind = 'router'; },
    value => { value.candidate.availability = 'disabled'; }, value => { value.candidate.extra = 'unverified'; },
  ]) {
    const value = injectedCatalogReuseFixture(); change(value);
    assert.throws(() => assertPreflightCatalogProjection(value.captures, value.discovery, value.events, value.fixture, value.bodies));
  }
});

test('deferred dollar Members proof must bind the exact still-visible native user text', () => {
  for (const change of [
    value => { value.injected.details.nativePromptSha256 = 'b'.repeat(64); },
    value => { value.captures[0].context.messages.splice(1, 1); },
    value => { value.captures[0].context.messages[1].content = 'Compacted summary.'; },
    value => { value.captures[0].context.messages[1].role = 'assistant'; },
    value => { value.injected.details.records = []; },
  ]) {
    const value = injectedCatalogReuseFixture(true); change(value);
    assert.throws(() => assertPreflightCatalogProjection(value.captures, value.discovery, value.events, value.fixture, value.bodies));
  }
});
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

function nativeRepeatFixture({ expectShort = true, structured = true, splitMain = false, effects = false } = {}) {
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
  if (effects) for (const [index, message] of originals.entries()) {
    message.details.effects = index === 2
      ? { version: 1, remote_writes: 'none', author_content: 'unchanged', retention: [] }
      : { version: 1, remote_writes: 'unknown', author_content: 'unknown', retention: [] };
    const footer = '\n\n<notion-effects>' + JSON.stringify(message.details.effects) + '</notion-effects>';
    if (index % 2) {
      Object.assign(message.details.contextBrokerResource, { version: 2, delivery: { start: 0, end: file.content.length, encoding: 'raw' } });
      message.content.push({ type: 'text', text: footer });
    } else message.content.at(-1).text += footer;
  }
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

test('native repeat keeps each operation effects while comparing the same complete body and directory', () => {
  const value = nativeRepeatFixture({ splitMain: true, effects: true }), before = JSON.stringify(value);
  assertNativeRepeatProjection(value.captures, value.originals, { batch: value.batch });
  assert.equal(JSON.stringify(value), before);
  for (const mutate of [
    message => { message.content.at(-1).text = message.content.at(-1).text.replace(/\n\n<notion-effects>.*<\/notion-effects>$/u, ''); },
    message => { message.details.effects = { version: 1, remote_writes: 'unknown', author_content: 'unknown', retention: [] }; },
  ]) {
    const sample = nativeRepeatFixture({ splitMain: true, effects: true });
    mutate(sample.captures.at(-1).context.messages.find(message => message.toolCallId === 'sc15-main-repeat'));
    assert.throws(() => assertNativeRepeatProjection(sample.captures, sample.originals, { batch: sample.batch }));
  }
  const lost = nativeRepeatFixture({ splitMain: true, effects: true });
  lost.captures.at(-1).context.messages.find(message => message.toolCallId === 'sc15-resource-repeat').content.pop();
  assert.throws(() => assertNativeRepeatProjection(lost.captures, lost.originals, { batch: lost.batch }));
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

test('controlled HTTP metadata failures require actual failed lists and do not become ready', () => {
  const fields = structuredClone(catalog);
  fields[2].status = 'failed'; fields[2].error_code = 'AUTH_REQUIRED';
  fields[2].request_metrics = { complete: true, total_requests: 1, trace: [{ event: 'attempt', attempt: 1, http_status: 401 }] };
  const options = { sourceMode: 'controlled-http', bodyTransportRequired: false,
    expectedCatalogOutcome: 'failed', expectedFailedSdkIds: ['42:1'] };
  const result = reconcile(observed(fields), lifecycle, options);
  assert.equal(result.sdk_http, 1); assert.equal(result.sdk_completed_lists, 0);
  assert.equal(result.default_catalog_transport, 'not_exercised');
  assert.throws(() => reconcile(observed(fields), lifecycle, { ...options, sourceMode: 'offline' }));
  assert.throws(() => reconcile(observed(fields), lifecycle, { ...options, expectedFailedSdkIds: [] }));
  assert.throws(() => reconcile(observed(catalog), lifecycle, options));
});

test('combined failed projections preserve the completed SDK terminal and account HTTP once', () => {
  const fields = structuredClone(catalog), error = { code: 'AUTH_REQUIRED', message: 'Credential denied' };
  fields[2].request_metrics = { complete: true, total_requests: 1, trace: [{ event: 'attempt', attempt: 1, http_status: 401 }] };
  fields.splice(2, 0, { kind: 'sdk_catalog', id: '42:1', value: { version: 1,
    catalog: { ok: false, error }, directory: { ok: false, error } } });
  const options = { sourceMode: 'controlled-http', bodyTransportRequired: false, expectedCatalogOutcome: 'failed' };
  const proof = reconcile(observed(fields), lifecycle, options);
  assert.equal(proof.sdk_calls, 1); assert.equal(proof.sdk_completed_lists, 1); assert.equal(proof.sdk_http, 1);
  assert.equal(proof.sdk_successful_list_results, 0); assert.deepEqual(proof.expected_failed_sdk, []);
  assert.deepEqual(proof.catalog_projection_failures, [
    { id: '42:1', facet: 'catalog', code: 'AUTH_REQUIRED' }, { id: '42:1', facet: 'directory', code: 'AUTH_REQUIRED' } ]);
  assert.equal(proof.default_catalog_transport, 'not_exercised');
  for (const change of [
    value => { value[3].status = 'cancelled'; }, value => { value[3].status = 'failed'; },
    value => { value[2].value.directory = { ok: true, value: { scope: 'valid', view: null } }; },
    value => { value.splice(2, 0, structuredClone(value[2])); },
    value => { value[2].id = 'another-call'; },
  ]) { const bad = structuredClone(fields); change(bad); assert.throws(() => reconcile(observed(bad), lifecycle, options)); }
});

test('controlled HTTP body cancellation requires its actual RPC abort inside the SDK interval', () => {
  const fields = structuredClone(catalog);
  fields.splice(3, 0,
    { kind: 'sdk', event: 'start', id: '42:2', operation: 'consume' },
    { kind: 'sdk', event: 'end', id: '42:2', operation: 'consume', status: 'cancelled', sdk_started: true, metrics_observed: true,
      request_metrics: { complete: true, total_requests: 1, trace: [{ event: 'attempt', attempt: 1, outcome: 'cancelled' }] } });
  const cancellation = { sdk_id: '42:2', host_pid: 42, tool_call_id: 'http-cancel',
    sent_monotonic_ns: '4', completed_monotonic_ns: '5',
    sdk_result: { version: 1, status: 'cancelled', reason: 'interrupted' },
    response: { type: 'response', command: 'abort', id: 'broker-e2e-4', success: true },
    tool_start: { type: 'tool_execution_start', toolName: 'notion_use', toolCallId: 'http-cancel' },
    tool_end: { type: 'tool_execution_end', toolName: 'notion_use', toolCallId: 'http-cancel', isError: true } };
  const options = { sourceMode: 'controlled-http', controlledCancellations: [cancellation] };
  const result = reconcile(observed(fields), lifecycle, options);
  assert.equal(result.sdk_cancelled_bodies, 1); assert.equal(result.sdk_http, 1);
  assert.throws(() => reconcile(observed(fields), lifecycle), /Only catalogue/);
  for (const changed of [
    { host_pid: 41 }, { sdk_id: '42:3' }, { sent_monotonic_ns: '3' },
    { response: { ...cancellation.response, success: false } },
    { response: { ...cancellation.response, command: 'get_state' } },
    { tool_end: { ...cancellation.tool_end, isError: false } },
    { tool_end: { ...cancellation.tool_end, toolCallId: 'different' } },
    { sdk_result: { version: 1, status: 'ready', reason: 'interrupted' } },
    { sdk_result: { ...cancellation.sdk_result, entries: [{ content: 'partial body' }] } },
  ]) assert.throws(() => reconcile(observed(fields), lifecycle, { ...options,
    controlledCancellations: [{ ...cancellation, ...changed }] }));
});

function controlledDirectoryFixture() {
  const sample = { oracle: { cold: { files: [{ path: 'SKILL.md' }], contents: { 'SKILL.md': 'Unselected authored source body.\n' } } },
    view_dynamics: { view: { id: 'owned-view' }, observations: [{ member_record_ids: ['owned-root'] }] } };
  const record = { id: 'owned-root', name: 'HTTP fixture', description: 'Metadata only.' };
  const captures = [
    { requestId: '42:provider:1', context: { messages: [{ role: 'system', content: '<ntn-skills-discovery status="pending">pending</ntn-skills-discovery>' }] } },
    { requestId: '42:provider:2', context: { messages: [{ role: 'system', content: '<ntn-skills-view-catalog><view id="owned-view" source="sdk-fixture" partial="false"><skill><name>HTTP fixture</name><description>Metadata only.</description><source>sdk-fixture</source><location>sr:Cabcdefghijklmnopqrstuv</location></skill></view></ntn-skills-view-catalog>' }] } },
  ];
  const events = [
    { kind: 'object_observer_start', observer_pid: 42, coverage: ['node:fs.readFile', 'node:fs.readFileSync', 'node:fs/promises.readFile'] },
    { kind: 'sdk', event: 'start', operation: 'list' },
    { kind: 'sdk_catalog', value: { view: { id: 'owned-view' }, coverage: { exhaustive: true, failed_sources: [] }, records: [record] } },
    { kind: 'object_observer_end', observer_pid: 42, pending_reads: 0, errors: 0 },
  ];
  return { sample, captures, events, held: { provider_request_id: captures[0].requestId,
    request_seen_monotonic_ns: '10', provider_payload_end_monotonic_ns: '20', released_monotonic_ns: '30' } };
}

test('controlled HTTP directory requires provider input before release and exact complete metadata without source bodies', () => {
  const check = ({ sample, captures, events, held }) => namedSdkProbe.assertControlledHttpDirectory(captures, events, { sample, hostPid: 42, state: 'ready', held });
  assert.equal(check(controlledDirectoryFixture()).status, 'verified');
  for (const mutate of [
    value => { value.held.released_monotonic_ns = '20'; },
    value => { value.held.provider_request_id = 'another-request'; },
    value => { value.captures[0].context.messages[0].content = value.captures[1].context.messages[0].content; },
    value => { value.captures[1].context.messages.push({ role: 'user', content: value.sample.oracle.cold.contents['SKILL.md'] }); },
    value => { value.events[2].value.records[0].id = 'unselected-root'; },
    value => { value.events[2].value.coverage.exhaustive = false; },
    value => { value.events.push({ kind: 'sdk', event: 'start', operation: 'consume' }); },
    value => { value.events.shift(); },
  ]) { const value = controlledDirectoryFixture(); mutate(value); assert.throws(() => check(value)); }
});

test('controlled HTTP failed directory preserves failure without inventing ready metadata', () => {
  const value = controlledDirectoryFixture();
  value.captures[1].context.messages[0].content = '<ntn-skills-discovery status="failed">Source unavailable.</ntn-skills-discovery>';
  value.events[2] = { kind: 'sdk', event: 'end', operation: 'list', status: 'failed', error_code: 'AUTH_REQUIRED' };
  const check = () => namedSdkProbe.assertControlledHttpDirectory(value.captures, value.events,
    { sample: value.sample, hostPid: 42, state: 'failed' });
  assert.equal(check().state, 'failed');
  value.events[2].error_code = 'ANOTHER_ERROR'; assert.throws(check);
});

test('controlled HTTP publication waits for the existing read-only View status without extra provider input', async () => {
  const sample = controlledDirectoryFixture().sample;
  sample.view_dynamics.view.name = 'Owned View';
  const expected = 'sdk-fixture: Owned View (owned-view) · 1 Skill/Router · first';
  let calls = 0;
  const rpc = { frames: [], async command(type, fields) {
    assert.equal(type, 'prompt'); assert.deepEqual(fields, { message: '/context-broker view' });
    this.frames.push({ type: 'extension_ui_request', method: 'notify', message: ++calls === 1 ? 'Notion Views: no enabled Notion sources' : expected });
    return { disposition: 'handled' };
  } };
  const proof = await namedSdkProbe.waitForControlledHttpView({ rpc, sample, state: 'ready', captureCount: async () => 1 });
  assert.equal(proof.calls, 2); assert.equal(proof.expected, expected);
  let captures = 0;
  await assert.rejects(namedSdkProbe.waitForControlledHttpView({ rpc, sample, state: 'ready', captureCount: async () => ++captures }), /must not invoke a provider/);
});

test('controlled HTTP published status uses one isolated zero-HTTP probe after background publication', async () => {
  const sample = controlledDirectoryFixture().sample, expected = 'sdk-fixture: default View failed (AUTH_REQUIRED) · first';
  let calls = 0, sourceRequests = 10;
  const rpc = { frames: [], async command() {
    calls++; if (calls === 1) sourceRequests += 2;
    this.frames.push({ type: 'extension_ui_request', method: 'notify', message: calls === 1 ? 'Notion Views: no enabled Notion sources' : expected });
    return { disposition: 'handled' };
  } };
  const options = { rpc, sample, state: 'failed', captureCount: async () => 1 };
  const publication = await namedSdkProbe.waitForControlledHttpView(options);
  assert.equal(publication.calls, 2); assert.equal(sourceRequests, 12, 'Background publication retains its own source attempts');
  sourceRequests++; // The already observed background follow-up reaches its terminal before the probe baseline.
  const before = sourceRequests, callsBefore = calls;
  const probe = await namedSdkProbe.waitForControlledHttpView({ ...options, single: true, sourceCount: () => sourceRequests });
  assert.equal(probe.calls, 1); assert.equal(calls, callsBefore + 1); assert.equal(sourceRequests, before);
  const original = rpc.command;
  rpc.command = async function() { sourceRequests++; return original.call(this); };
  await assert.rejects(namedSdkProbe.waitForControlledHttpView({ ...options, single: true, sourceCount: () => sourceRequests }), /must not refresh the source/);
  rpc.command = async function() { calls++; this.frames.push({ type: 'extension_ui_request', method: 'notify', message: 'Notion Views: no enabled Notion sources' }); return { disposition: 'handled' }; };
  const mismatchBefore = calls;
  await assert.rejects(namedSdkProbe.waitForControlledHttpView({ ...options, single: true, sourceCount: () => sourceRequests }), /single read-only probe/);
  assert.equal(calls, mismatchBefore + 1, 'A changed published state is not retried');
});

test('controlled HTTP warm new-process accounting preserves identity validation but rejects directory or body downloads', () => {
  const request = { method: 'GET', path: '/v1/users/me', status: 200, response_bytes_complete: true, decoded_response_bytes: 61, response_boundary: 'server uncompressed writes' };
  assert.equal(namedSdkProbe.assertControlledHttpWarmRequests([request]).body_http, 0);
  for (const requests of [[], [request, request], [{ ...request, path: '/v1/pages/owned/markdown' }], [{ ...request, response_bytes_complete: false }]])
    assert.throws(() => namedSdkProbe.assertControlledHttpWarmRequests(requests));
});

test('controlled HTTP zero-age is forced full validation and cannot hide an unselected body', () => {
  const sample = { notion: { main: { id: 'root' }, files: [{ id: 'resource' }] } };
  const requests = ['root', 'resource'].map(id => ({ path: '/v1/pages/' + id + '/markdown', status: 200, response_bytes_complete: true }));
  assert.equal(namedSdkProbe.assertControlledHttpForcedRevalidation(requests, sample).natural_default_ttl_boundary, 'not_run');
  assert.throws(() => namedSdkProbe.assertControlledHttpForcedRevalidation(requests.slice(0, 1), sample));
  assert.throws(() => namedSdkProbe.assertControlledHttpForcedRevalidation([...requests, { ...requests[0], path: '/v1/pages/unselected/markdown' }], sample));
});

test('controlled HTTP client headers retain the real Markdown query while matching the selected page', () => {
  const header = { kind: 'source_http_headers', method: 'GET', path: '/v1/pages/root/markdown?markdown_version=v2', status: 200 };
  assert.equal(namedSdkProbe.controlledHttpBodyHeaders([header], 'http://127.0.0.1:1234', 'root'), header);
  assert.equal(namedSdkProbe.controlledHttpBodyHeaders([header], 'http://127.0.0.1:1234', 'another'), undefined);
  assert.equal(namedSdkProbe.controlledHttpBodyHeaders([{ ...header, method: 'POST' }], 'http://127.0.0.1:1234', 'root'), undefined);
});

test('controlled HTTP retry proof preserves failed partial bytes and requires two actual SDK attempts', () => {
  const requests = [{ path: '/v1/pages/owned/markdown', status: 200, terminal: 'aborted', response_bytes_complete: false, decoded_response_bytes: null, observed_response_bytes: 32 },
    { path: '/v1/pages/owned/markdown', status: 200, terminal: 'finished', response_bytes_complete: true, decoded_response_bytes: 100 }];
  const attempts = [{ event: 'attempt', target: { page_id: 'owned' }, body_kind: 'current_body', outcome: 'failure', response_bytes: 32 },
    { event: 'attempt', target: { page_id: 'owned' }, body_kind: 'current_body', outcome: 'success', response_bytes: 100 }];
  const value = { requests, events: [{ kind: 'sdk', event: 'end', operation: 'consume', status: 'completed',
    request_metrics: { trace: attempts }, source_http_terminal: { unknown_response_bytes: 0 } }] };
  const check = item => namedSdkProbe.assertControlledHttpRetry(item, 'owned', 'disconnect');
  assert.equal(check(value).sdk_retries, 1);
  for (const mutate of [item => { item.requests[0].decoded_response_bytes = 32; }, item => { item.requests[0].response_bytes_complete = true; },
    item => { item.events[0].request_metrics.trace[0].outcome = 'success'; }, item => { item.events[0].request_metrics.trace.pop(); },
    item => { item.events[0].request_metrics.trace[0].response_bytes = 100; }]) {
    const changed = structuredClone(value); mutate(changed); assert.throws(() => check(changed));
  }
  const limited = structuredClone(value); limited.requests[0] = { ...limited.requests[0], status: 429, terminal: 'finished', response_bytes_complete: true, decoded_response_bytes: 110 };
  limited.events[0].request_metrics.trace[0].http_status = 429;
  assert.equal(namedSdkProbe.assertControlledHttpRetry(limited, 'owned', 'rate-limit').sdk_retries, 1);
});

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

function ambiguityMessage(id = 'ambiguous-read', tool = 'read') {
  return { role: 'toolResult', toolName: tool, toolCallId: id, isError: true, content: [{ type: 'text', text: JSON.stringify({
    code: 'SKILL_AMBIGUOUS', message: 'Copy one returned candidate reference.', candidates: [
      { name: 'A', source: 'sdk-fixture', ref: 'sr:C' + 'a'.repeat(22), selectable: true },
      { name: 'A', source: 'sdk-fixture', ref: 'sr:C' + 'c'.repeat(22), selectable: true },
    ] }) }] };
}

test('ambiguity provider copies the chosen reference only from the actual error tool message', () => {
  const plan = { calls: [
    { id: 'ambiguous-read', tool: 'read', args: { path: 'skill://A/SKILL.md' }, errorCode: 'SKILL_AMBIGUOUS' },
    { id: 'copy-read', tool: 'read', candidateFrom: { id: 'ambiguous-read', tool: 'read', index: 1 } },
    { id: 'ambiguous-use', tool: 'notion_use', args: { ref: 'skill://a/SKILL.md' }, errorCode: 'SKILL_AMBIGUOUS' },
    { id: 'copy-use', tool: 'notion_use', candidateFrom: { id: 'ambiguous-use', tool: 'notion_use', index: 0 } },
  ] };
  const context = { messages: [] };
  assert.deepEqual(namedSdkProbe.selectNamedReferenceCall(context, plan).arguments, plan.calls[0].args);
  context.messages.push(ambiguityMessage());
  assert.deepEqual(namedSdkProbe.selectNamedReferenceCall(context, plan), { type: 'toolCall', id: 'copy-read', name: 'read', arguments: { path: 'sr:C' + 'c'.repeat(22) } });
  context.messages.push({ role: 'toolResult', toolName: 'read', toolCallId: 'copy-read', isError: false, content: [{ type: 'text', text: 'Complete inspected body.' }] });
  assert.deepEqual(namedSdkProbe.selectNamedReferenceCall(context, plan).arguments, plan.calls[2].args);
  context.messages.push(ambiguityMessage('ambiguous-use', 'notion_use'));
  assert.deepEqual(namedSdkProbe.selectNamedReferenceCall(context, plan), { type: 'toolCall', id: 'copy-use', name: 'notion_use', arguments: { ref: 'sr:C' + 'a'.repeat(22) } });
});

test('ambiguity provider refuses missing, forged, duplicated and nonselectable candidates', () => {
  const call = { id: 'copy', tool: 'read', candidateFrom: { id: 'ambiguous-read', tool: 'read', index: 1 } };
  for (const change of [
    message => { message.role = 'user'; },
    message => { message.toolName = 'notion_use'; },
    message => { message.isError = false; },
    message => { message.details = JSON.parse(message.content[0].text); message.content = []; },
    message => { message.content[0].text = 'SKILL_AMBIGUOUS'; },
    message => { const value = JSON.parse(message.content[0].text); value.candidates[1].selectable = false; message.content[0].text = JSON.stringify(value); },
    message => { const value = JSON.parse(message.content[0].text); value.candidates[1].ref = '/private/cache/SKILL.md'; message.content[0].text = JSON.stringify(value); },
    message => { const value = JSON.parse(message.content[0].text); value.candidates[1].body = 'Private body'; message.content[0].text = JSON.stringify(value); },
    message => { const value = JSON.parse(message.content[0].text); value.candidates[1] = value.candidates[0]; message.content[0].text = JSON.stringify(value); },
  ]) {
    const message = ambiguityMessage(); change(message);
    assert.throws(() => namedSdkProbe.selectNamedReferenceCall({ messages: [message] }, { calls: [call] }));
  }
  assert.throws(() => namedSdkProbe.selectNamedReferenceCall({ messages: [ambiguityMessage(), ambiguityMessage()] }, { calls: [call] }));
  const fixed = ambiguityMessage(), value = JSON.parse(fixed.content[0].text);
  value.candidates = ['left', 'right'].map(source => ({ name: 'A', source, ref: 'skill://owner/SKILL.md?snapshot=fixed', selectable: false }));
  fixed.content[0].text = JSON.stringify(value);
  assert.throws(() => namedSdkProbe.selectNamedReferenceCall({ messages: [fixed] }, { calls: [call] }), /NOT_SELECTABLE/);
});

function ambiguityOwnerFixture() {
  const snapshots = ['a', 'c'].map(id => ({ scope: 'scope', record: { id: 'shared_skill:sdk-library:' + id, name: 'A', kind: 'skill',
    entrypoint: 'SKILL.md', ref: 'skill://' + encodeURIComponent('shared_skill:sdk-library:' + id) + '/SKILL.md',
    locator: { type: 'shared_skill', skill_id: id } } }));
  const message = ambiguityMessage();
  const entries = snapshots.map((snapshot, index) => ({ type: 'custom', customType: 'context-broker-short-ref', data: {
    ref: JSON.parse(message.content[0].text).candidates[index].ref,
    target: { kind: 'candidate', identity: { source: 'notion', scope: snapshot.scope, id: snapshot.record.id,
      kind: snapshot.record.kind, locator: snapshot.record.locator, ref: 'skill://' + encodeURIComponent(snapshot.record.id) } },
  } }));
  entries.push({ type: 'message', message });
  return { message, snapshots, entries, source: { id: 'sdk-fixture' } };
}

test('ambiguity candidates bind every actual handle to its independent owner and scope before delivery', () => {
  const valid = ambiguityOwnerFixture();
  assert.deepEqual(namedSdkProbe.assertAmbiguityCandidates(valid.message, valid).map(value => value.id), valid.snapshots.map(value => value.record.id));
  for (const change of [
    value => { value.entries[1].data.target.identity.id = value.snapshots[0].record.id; },
    value => { value.entries[1].data.target.identity.scope = 'foreign'; },
    value => { value.entries[1].data.target.identity.ref = value.entries[0].data.target.identity.ref; },
    value => { value.entries[1].data.target.identity.ref = value.snapshots[1].record.ref; },
    value => { value.entries[1].data.target.identity.ref += '/'; },
    value => { value.entries[1].data.target.identity.ref += '?snapshot=s_' + 'a'.repeat(64); },
    value => { value.entries[1].data.target.identity.ref += '?file_id=main-c'; },
    value => { value.entries[1].data.target.identity.ref += '?unexpected=value'; },
    value => { value.entries[1].data.target.identity.ref += '#SKILL.md'; },
    value => { value.entries[1].data.target.identity.ref = value.entries[1].data.target.identity.ref.replace('%3A', '%253A'); },
    value => { value.entries[1].data.target.identity.kind = 'router'; },
    value => { value.entries[1].data.target.identity.locator = { type: 'shared_skill', skill_id: 'foreign' }; },
    value => { value.snapshots[1].record.ref = value.snapshots[0].record.ref; },
    value => { value.snapshots[1].record.ref = value.entries[1].data.target.identity.ref + '/references/guide.md'; },
    value => { value.snapshots[1].record.entrypoint = 'OTHER.md'; },
    value => { value.snapshots[1].record.ref += '?snapshot=s_' + 'a'.repeat(64); },
    value => { value.snapshots[1].record.ref += '?file_id=main-c'; },
    value => { const parsed = JSON.parse(value.message.content[0].text); parsed.candidates[1].source = 'another-source'; value.message.content[0].text = JSON.stringify(parsed); },
    value => { const parsed = JSON.parse(value.message.content[0].text); parsed.candidates.pop(); value.message.content[0].text = JSON.stringify(parsed); },
    value => { value.entries.push(value.entries.splice(1, 1)[0]); },
  ]) {
    const bad = ambiguityOwnerFixture(); change(bad);
    assert.throws(() => namedSdkProbe.assertAmbiguityCandidates(bad.message, bad));
  }
});

test('ambiguity body timeline keeps duplicate display names separate and expands Requires only after use', () => {
  const options = { bodiesById: new Map([['a', 'Complete a.'], ['c', 'Complete c.'], ['base', 'Complete base.'], ['b', 'Unselected b.']]),
    inspectedId: 'c', usedId: 'a', requiredId: 'base' };
  const captures = ['', '', 'Complete c.', 'Complete c.', 'Complete c.\nComplete a.\nComplete base.']
    .map((text, index) => ({ requestId: String(index), context: { messages: [{ role: 'toolResult', content: [{ type: 'text', text }] }] } }));
  assert.equal(namedSdkProbe.assertAmbiguityBodyTimeline(captures, options).length, 5);
  for (const [index, addition] of [[0, 'Complete a.'], [1, 'Complete c.'], [2, 'Complete base.'], [3, 'Complete a.'], [4, 'Unselected b.'], [4, 'Complete a.']]) {
    const bad = structuredClone(captures); bad[index].context.messages[0].content[0].text += addition;
    assert.throws(() => namedSdkProbe.assertAmbiguityBodyTimeline(bad, options));
  }
  const missing = structuredClone(captures); missing[4].context.messages[0].content[0].text = 'Complete c.\nComplete a.';
  assert.throws(() => namedSdkProbe.assertAmbiguityBodyTimeline(missing, options));
});

test('ambiguity lookup intervals reject body work and copied handles do not repeat a name lookup', () => {
  const captures = [{ requestId: 'before' }, { requestId: 'after' }];
  const hooks = [{ requestId: 'before', phase: 'response_end', pid: 42, monotonic_ns: '10' },
    { requestId: 'after', phase: 'payload_start', pid: 42, monotonic_ns: '40' }];
  const fields = [{ kind: 'sdk', event: 'start', id: 'lookup', operation: 'list', observer_pid: 42, monotonic_ns: '20' },
    { kind: 'sdk', event: 'end', id: 'lookup', operation: 'list', observer_pid: 42, monotonic_ns: '30' }];
  assert.equal(namedSdkProbe.assertNamedReferenceIntervals(captures, hooks, fields, [{ id: 'sc04-ambiguous-read' }])[0].sdk.length, 1);
  assert.throws(() => namedSdkProbe.assertNamedReferenceIntervals(captures, hooks, fields, [{ id: 'sc04-copy-read' }]));
  const body = structuredClone(fields); body[0].operation = body[1].operation = 'consume';
  assert.throws(() => namedSdkProbe.assertNamedReferenceIntervals(captures, hooks, body, [{ id: 'sc04-ambiguous-use' }]));
  assert.throws(() => namedSdkProbe.assertNamedReferenceIntervals(captures, hooks,
    [...fields, { kind: 'object_read', event: 'start', id: 'body', observer_pid: 42, monotonic_ns: '25' }], [{ id: 'sc04-ambiguous-read' }]));
});

test('name reference provider preserves display and alias inputs and copies only an actual resource handle', () => {
  const plan = { calls: [
    { id: 'name', tool: 'read', args: { path: 'skill://A/SKILL.md' } },
    { id: 'alias', tool: 'notion_use', args: { ref: 'skill://a/SKILL.md' } },
    { id: 'resource', tool: 'read', resourceFrom: 'name', resourcePath: 'assets/sample.bin' },
    { id: 'wrong', tool: 'read', args: { path: 'skill://Wrong/assets/sample.bin?snapshot=fixed' }, errorCode: 'SNAPSHOT_CONFLICT' },
  ] };
  const context = { messages: [] }, selected = 'sr:R' + 'r'.repeat(22);
  assert.deepEqual(namedSdkProbe.selectNamedReferenceCall(context, plan), { type: 'toolCall', id: 'name', name: 'read', arguments: plan.calls[0].args });
  const main = { role: 'toolResult', toolName: 'read', toolCallId: 'name', isError: false, content: [{ type: 'text', text:
    'Full main.\n<skill-directory>' + JSON.stringify({ ref: 'sr:S' + 's'.repeat(22), directory: { files: [{ path: 'assets/sample.bin', ref: selected }] } }) + '</skill-directory>' }] };
  context.messages.push(main);
  assert.deepEqual(namedSdkProbe.selectNamedReferenceCall(context, plan), { type: 'toolCall', id: 'alias', name: 'notion_use', arguments: plan.calls[1].args });
  context.messages.push({ role: 'toolResult', toolName: 'notion_use', toolCallId: 'alias', isError: false, content: [{ type: 'text', text: '{}' }] });
  assert.deepEqual(namedSdkProbe.selectNamedReferenceCall(context, plan), { type: 'toolCall', id: 'resource', name: 'read', arguments: { path: selected } });
  const forged = structuredClone(context); forged.messages[0].role = 'assistant';
  assert.throws(() => namedSdkProbe.selectNamedReferenceCall(forged, { calls: [plan.calls[2]] }));
  context.messages.push({ role: 'toolResult', toolName: 'read', toolCallId: 'resource', isError: false, content: [{ type: 'text', text: 'resource' }] });
  assert.equal(namedSdkProbe.selectNamedReferenceCall(context, plan).id, 'wrong');
  context.messages.push({ role: 'toolResult', toolName: 'read', toolCallId: 'wrong', isError: true, content: [{ type: 'text', text: 'SNAPSHOT_CONFLICT' }] });
  assert.equal(namedSdkProbe.selectNamedReferenceCall(context, plan), null);
  const unexpected = structuredClone(context); unexpected.messages.at(-1).content[0].text = 'SOURCE_SDK_INCOMPATIBLE';
  assert.throws(() => namedSdkProbe.selectNamedReferenceCall(unexpected, plan), /expected named-reference failure/);
  const hidden = structuredClone(context); hidden.messages.at(-1).isError = false;
  assert.throws(() => namedSdkProbe.selectNamedReferenceCall(hidden, plan), /expected named-reference failure/);
});

test('malformed short-ref negative uses the actual issued handle and requires the public product error', () => {
  const selected = 'sr:R' + 'r'.repeat(22), path = 'references/guide.md';
  const main = { role: 'toolResult', toolName: 'read', toolCallId: 'main', isError: false, content: [{ type: 'text', text:
    'Full main.\n<skill-directory>' + JSON.stringify({ ref: 'sr:S' + 's'.repeat(22), directory: { files: [{ path, ref: selected }] } }) + '</skill-directory>' }] };
  const call = { id: 'invalid', tool: 'read', resourceFrom: 'main', resourcePath: path,
    invalidShortRefSuffix: '/SKILL.md', errorCode: 'SHORT_REF_INVALID' };
  const context = { messages: [main] }, plan = { calls: [call] };
  assert.deepEqual(namedSdkProbe.selectNamedReferenceCall(context, plan), {
    type: 'toolCall', id: 'invalid', name: 'read', arguments: { path: selected + '/SKILL.md' },
  });
  for (const change of [value => { value.invalidShortRefSuffix = ''; }, value => { value.errorCode = 'OTHER'; },
    value => { value.resourceFrom = undefined; value.args = { path: selected }; }]) {
    const altered = structuredClone(call); change(altered);
    assert.throws(() => namedSdkProbe.selectNamedReferenceCall(context, { calls: [altered] }), /SHORT_REF_NEGATIVE_INVALID/);
  }
  const canonical = structuredClone(context); canonical.messages[0].content[0].text = main.content[0].text.replace(selected, 'skill://owner/references/guide.md');
  assert.throws(() => namedSdkProbe.selectNamedReferenceCall(canonical, plan));
  context.messages.push({ role: 'toolResult', toolName: 'read', toolCallId: 'invalid', isError: true,
    content: [{ type: 'text', text: 'SHORT_REF_INVALID: Skill short reference cannot be used in this session' }] });
  assert.equal(namedSdkProbe.selectNamedReferenceCall(context, plan), null);
  for (const change of [value => { value.isError = false; }, value => { value.content[0].text = 'ACCESS_DENIED'; }]) {
    const altered = structuredClone(context); change(altered.messages.at(-1));
    assert.throws(() => namedSdkProbe.selectNamedReferenceCall(altered, plan), /expected named-reference failure/);
  }
});

test('malformed short-ref interval excludes SDK and object work without counting prior metadata as its cost', () => {
  const captures = [{ requestId: 'before' }, { requestId: 'after' }];
  const hooks = [{ requestId: 'before', phase: 'response_end', pid: 42, monotonic_ns: '10' },
    { requestId: 'after', phase: 'payload_start', pid: 42, monotonic_ns: '40' }];
  const call = { id: 'sc07-malformed-short-resource', invalidShortRefSuffix: '/SKILL.md', errorCode: 'SHORT_REF_INVALID' };
  const background = [{ kind: 'sdk', event: 'start', id: 'catalog', operation: 'list', observer_pid: 42, monotonic_ns: '1' },
    { kind: 'sdk', event: 'end', id: 'catalog', operation: 'list', observer_pid: 42, monotonic_ns: '8' }];
  const result = namedSdkProbe.assertNamedReferenceIntervals(captures, hooks, background, [call]);
  assert.deepEqual(result[0].sdk, []); assert.deepEqual(result[0].object_reads, []);
  const sdk = [{ kind: 'sdk', event: 'start', id: 'body', operation: 'read', observer_pid: 42, monotonic_ns: '20' },
    { kind: 'sdk', event: 'end', id: 'body', operation: 'read', observer_pid: 42, monotonic_ns: '30' }];
  assert.throws(() => namedSdkProbe.assertNamedReferenceIntervals(captures, hooks, [...background, ...sdk], [call]), /must not start SDK/);
  assert.throws(() => namedSdkProbe.assertNamedReferenceIntervals(captures, hooks, [...background,
    { kind: 'object_read', event: 'start', id: 'body', observer_pid: 42, monotonic_ns: '25' }], [call]), /must not read source objects/);
});

test('name reference metadata files never count as body transport and unknown operations remain rejected', () => {
  const fields = structuredClone(catalog);
  fields.splice(3, 0, { kind: 'sdk', event: 'start', id: 'files-1', operation: 'files' },
    { kind: 'sdk', event: 'end', id: 'files-1', operation: 'files', status: 'completed', sdk_started: true, metrics_observed: true,
      request_metrics: { complete: true, total_requests: 0, trace: [] } });
  const result = reconcile(observed(fields), lifecycle, { bodyTransportRequired: false });
  assert.equal(result.sdk_files, 1); assert.equal(result.sdk_body_calls, 0); assert.equal(result.sdk_lists, 1);
  assert.throws(() => reconcile(observed(fields), lifecycle), /empty body SDK observation/);
  const unknown = structuredClone(fields); unknown[3].operation = unknown[4].operation = 'new-unaccounted-operation';
  assert.throws(() => reconcile(observed(unknown), lifecycle, { bodyTransportRequired: false }), /Unknown SDK operations/);
});

test('name reference expected source failures require exact closed SDK identities and complete metrics', () => {
  const fields = structuredClone(catalog);
  fields.splice(3, 0, { kind: 'sdk', event: 'start', id: 'failed-files', operation: 'files' },
    { kind: 'sdk', event: 'end', id: 'failed-files', operation: 'files', status: 'failed', sdk_started: true, metrics_observed: true,
      request_metrics: { complete: true, total_requests: 0, trace: [] } });
  const options = { bodyTransportRequired: false, expectedFailedSdkIds: ['failed-files'] };
  const result = reconcile(observed(fields), lifecycle, options);
  assert.deepEqual(result.expected_failed_sdk, [{ id: 'failed-files', operation: 'files' }]);
  assert.equal(result.sdk_body_calls, 0);
  assert.throws(() => reconcile(observed(fields), lifecycle, { bodyTransportRequired: false }));
  assert.throws(() => reconcile(observed(fields), lifecycle, { ...options, expectedFailedSdkIds: ['unobserved'] }));
  const missing = structuredClone(fields); missing[4].request_metrics = null;
  assert.throws(() => reconcile(observed(missing), lifecycle, options), /complete metrics/);
  const incompatible = structuredClone(fields); incompatible[4].sdk_started = false;
  assert.throws(() => reconcile(observed(incompatible), lifecycle, options));
});

test('name reference lookup claims require the actual matching provider interval and a closed SDK call', () => {
  const captures = [{ requestId: 'before' }, { requestId: 'after' }];
  const hooks = [{ requestId: 'before', phase: 'response_end', pid: 42, monotonic_ns: '10' },
    { requestId: 'after', phase: 'payload_start', pid: 42, monotonic_ns: '40' }];
  const fields = [{ kind: 'sdk', event: 'start', id: 'manifest', operation: 'files', observer_pid: 42, monotonic_ns: '20' },
    { kind: 'sdk', event: 'end', id: 'manifest', operation: 'files', observer_pid: 42, monotonic_ns: '30' }];
  const fixed = [{ id: 'sc25-fixed-name' }];
  assert.deepEqual(namedSdkProbe.assertNamedReferenceIntervals(captures, hooks, fields, fixed)[0].sdk,
    [{ id: 'manifest', operation: 'files' }]);
  assert.throws(() => namedSdkProbe.assertNamedReferenceIntervals(captures, hooks, fields, [{ id: 'sc25-fixed-canonical' }]), /must not add/);
  assert.throws(() => namedSdkProbe.assertNamedReferenceIntervals(captures, hooks, fields, [{ id: 'sc25-current-name' }]), /ordinary SDK directory/);
  for (const change of [
    values => { values[1].monotonic_ns = '41'; },
    values => { values[1].observer_pid = 99; },
    values => { values.splice(1, 1); },
    values => { values[0].monotonic_ns = '9'; },
  ]) {
    const altered = structuredClone(fields); change(altered);
    assert.throws(() => namedSdkProbe.assertNamedReferenceIntervals(captures, hooks, altered, fixed));
  }
  const unrelated = fields.map(value => ({ ...value, observer_pid: 99 }));
  assert.throws(() => namedSdkProbe.assertNamedReferenceIntervals(captures, hooks, unrelated, fixed), /actual manifest/);
});

test('name reference object evidence distinguishes shared content addresses without permitting extra source objects', () => {
  const value = objectReadFixture();
  const shared = { ...value.selected, path: 'other-owner/assets/same-bytes.bin' };
  const options = { selected: [value.selected], forbidden: [value.forbidden, shared], requiredPid: value.requiredPid };
  const verified = namedSdkProbe.assertNamedReferenceObjects(value.events, options);
  assert.deepEqual(verified.shared_content_objects, [{ sha256: shared.sha256, bytes: shared.bytes,
    unselected_path: shared.path, selected_paths: [value.selected.path] }]);
  assert.throws(() => namedSdkProbe.assertNamedReferenceObjects(value.events, { ...options,
    forbidden: [{ ...shared, bytes: shared.bytes + 1 }] }), /exact byte length/);
  for (const sha256 of [value.forbidden.sha256, 'c'.repeat(64)]) {
    const extra = structuredClone(value.events);
    extra.splice(3, 0, { ...extra[1], id: 'extra-object', object_sha256: sha256 },
      { ...extra[2], id: 'extra-object', object_sha256: sha256, content_sha256: sha256 });
    assert.throws(() => namedSdkProbe.assertNamedReferenceObjects(extra, options));
  }
});

function namedFailureFixture(failedAuthority = true) {
  const source = { id: 'sdk-fixture', database: '00000000-0000-4000-8000-000000000010' };
  const failedSource = failedAuthority ? { id: 'uncached-authority', database: '00000000-0000-4000-8000-000000000099' } : undefined;
  const selected = failedSource ?? source, operation = failedAuthority ? 'list' : 'files';
  const start = { kind: 'sdk', event: 'start', id: 'failed-call', operation, observer_pid: 42,
    sequence: 10, monotonic_ns: '20', source_id: selected.id, database: selected.database };
  const end = { ...start, event: 'end', sequence: 11, monotonic_ns: '30', status: 'failed',
    error_code: failedAuthority ? 'CACHE_MISSING' : 'SNAPSHOT_CONFLICT' };
  const intervals = [{ tool_call_id: failedAuthority ? 'sc25-failed-name' : 'sc25-wrong-fixed-name', observer_pid: 42,
    after_provider_request: '42:3', before_provider_request: '42:4', start_monotonic_ns: '10', end_monotonic_ns: '40',
    sdk: [{ id: start.id, operation }], object_reads: [] }];
  return { events: [start, end], intervals, options: { source, failedSource } };
}

test('named SDK failure attribution preserves only the declared source and database', () => {
  const valid = namedFailureFixture();
  assert.equal(namedSdkProbe.assertNamedReferenceFailures(valid.events, valid.intervals, valid.options)[0].id, 'failed-call');
  for (const change of [
    value => { for (const event of value.events) { event.source_id = value.options.source.id; event.database = value.options.source.database; } },
    value => { for (const event of value.events) delete event.source_id; },
    value => { for (const event of value.events) event.database = null; },
    value => { value.events[0].database = value.options.source.database; },
    value => { value.events[1].source_id = value.options.source.id; },
    value => { value.events[1].error_code = null; },
    value => { value.events[1].error_code = 'ACCESS_DENIED'; },
  ]) {
    const wrong = namedFailureFixture(); change(wrong);
    assert.throws(() => namedSdkProbe.assertNamedReferenceFailures(wrong.events, wrong.intervals, wrong.options));
  }
});

test('named SDK failure attribution rejects late, extra and unpaired terminals', () => {
  for (const change of [
    value => { value.events[1].monotonic_ns = '41'; },
    value => { value.intervals[0].tool_call_id = 'sc25-canonical-main'; },
    value => { value.events.splice(0, 1); },
    value => { value.events[1].observer_pid = 99; },
    value => { for (const event of value.events) event.observer_pid = 99; },
    value => { value.events.push({ ...value.events[1] }); },
    value => { value.events.push({ ...value.events[0], id: 'missing-terminal' }); },
    value => { value.events.push({ ...value.events[0], id: 'extra-healthy', source_id: value.options.source.id, database: value.options.source.database, monotonic_ns: '42' },
      { ...value.events[1], id: 'extra-healthy', source_id: value.options.source.id, database: value.options.source.database, monotonic_ns: '43' }); },
  ]) {
    const wrong = namedFailureFixture(); change(wrong);
    assert.throws(() => namedSdkProbe.assertNamedReferenceFailures(wrong.events, wrong.intervals, wrong.options));
  }
});

test('named SDK fixed-manifest failure requires the actual owner and SNAPSHOT_CONFLICT code', () => {
  const valid = namedFailureFixture(false);
  assert.equal(namedSdkProbe.assertNamedReferenceFailures(valid.events, valid.intervals, valid.options)[0].id, 'failed-call');
  for (const change of [
    value => { value.events[1].error_code = 'ACCESS_DENIED'; },
    value => { for (const event of value.events) event.source_id = 'another-source'; },
    value => { for (const event of value.events) event.database = '00000000-0000-4000-8000-000000000099'; },
    value => { value.events[1].monotonic_ns = '41'; },
  ]) {
    const wrong = namedFailureFixture(false); change(wrong);
    assert.throws(() => namedSdkProbe.assertNamedReferenceFailures(wrong.events, wrong.intervals, wrong.options));
  }
});

test('named SDK startup failure must close within the first actual discovery boundary', () => {
  const value = namedFailureFixture();
  value.events[0].monotonic_ns = '5';
  value.events.unshift({ kind: 'observer_start', observer_pid: 42, monotonic_ns: '1', sequence: 1 });
  value.intervals[0].tool_call_id = 'sc25-search'; value.intervals[0].sdk = [];
  const verified = namedSdkProbe.assertNamedReferenceFailures(value.events, value.intervals, value.options);
  assert.equal(verified[0].boundary.phase, 'startup');
  assert.equal(verified[0].boundary.before_provider_request, '42:4');
  for (const change of [
    wrong => { wrong.events.pop(); },
    wrong => { wrong.events[2].monotonic_ns = '41'; },
    wrong => { wrong.events[1].monotonic_ns = '0'; },
    wrong => { wrong.events.shift(); },
    wrong => { wrong.intervals[0].observer_pid = 99; },
    wrong => { wrong.intervals[0].tool_call_id = 'sc25-canonical-main'; },
  ]) {
    const wrong = structuredClone(value); change(wrong);
    assert.throws(() => namedSdkProbe.assertNamedReferenceFailures(wrong.events, wrong.intervals, wrong.options));
  }
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

test('controlled HTTP initial catalog cannot settle before the late first list starts and ends', () => {
  const expected = { sourceId: 'sdk-fixture', database }, options = { initialCatalog: expected };
  // The ordinary provider has already finished; background discovery has not started yet.
  const events = [{ kind: 'observer_start', observer_pid: 42, parent_pid: 10 }];
  assert.equal(sourceFinality(events, 42).complete, true, 'Ordinary drain semantics remain unchanged');
  assert.equal(sourceFinality(events, 42, options).complete, false);
  const common = { observer_pid: 42, id: 'initial-list', operation: 'list', source_id: expected.sourceId, database };
  events.push({ kind: 'sdk', event: 'start', ...common });
  assert.equal(sourceFinality(events, 42, options).complete, false);
  const error = { code: 'AUTH_REQUIRED', message: 'Credential denied' };
  events.push({ kind: 'sdk_catalog', observer_pid: 42, id: common.id,
    value: { version: 1, catalog: { ok: false, error }, directory: { ok: false, error } } });
  assert.equal(sourceFinality(events, 42, options).complete, false, 'Facet results do not replace the operation terminal');
  events.push({ kind: 'sdk', event: 'end', ...common, status: 'completed' });
  assert.equal(sourceFinality(events, 42, options).complete, true, 'Two failed projections still complete one real SDK operation');
  events.push({ kind: 'sdk', event: 'start', ...common, id: 'background-followup' });
  assert.equal(sourceFinality(events, 42, options).complete, false, 'An observed background follow-up must also settle');
  events.push({ kind: 'sdk', event: 'end', ...common, id: 'background-followup', status: 'failed', error_code: 'AUTH_REQUIRED' });
  assert.equal(sourceFinality(events, 42, options).complete, true);
});

test('controlled HTTP initial catalog requires the same host source database and ordered terminal', () => {
  const common = { observer_pid: 42, id: 'initial-list', operation: 'list', source_id: 'sdk-fixture', database };
  const events = [{ kind: 'observer_start', observer_pid: 42, parent_pid: 10 },
    { kind: 'sdk', event: 'start', ...common },
    { kind: 'sdk', event: 'end', ...common, status: 'failed', error_code: 'AUTH_REQUIRED' }];
  const options = { initialCatalog: { sourceId: common.source_id, database } };
  assert.equal(sourceFinality(events, 42, options).complete, true, 'Legacy failed list also supplies its actual terminal');
  for (const mutate of [
    value => { value.splice(1, 1); },
    value => { for (const event of value.slice(1)) event.observer_pid = 99; },
    value => { for (const event of value.slice(1)) event.source_id = 'other-source'; },
    value => { for (const event of value.slice(1)) event.database = 'other-database'; },
    value => { for (const event of value.slice(1)) event.operation = 'consume'; },
    value => { value[2].source_id = 'other-source'; },
    value => { value[2].database = 'other-database'; },
    value => { value[2].id = 'another-list'; },
    value => { [value[1], value[2]] = [value[2], value[1]]; },
  ]) {
    const changed = structuredClone(events); mutate(changed);
    assert.equal(sourceFinality(changed, 42, options).complete, false);
  }
});

function warmDirectoryFixture() {
  const value = defaultViewFixture(), scope = 'warm-source-scope';
  Object.assign(value.fixture, { database, scope, catalog_records: value.fixture.default_view.records.map(record => record.id),
    snapshots: value.fixture.default_view.records.map(record => ({ scope, record })) });
  for (const record of value.discovery.records) Object.assign(record, { scope, availability: 'available' });
  Object.assign(value.discovery, { ok: true, count: 2, has_more: false, failures: [] });
  const full = structuredClone(value.discovery), model = structuredClone(full);
  for (const record of model.records) { delete record.id; delete record.scope; }
  value.message = { role: 'toolResult', toolCallId: 'sc10-search', content: [{ type: 'text', text: JSON.stringify(model) }], details: full };
  value.expected = { fixture: value.fixture, sourceId: 'sdk-fixture', transport: 'sdk' };
  const metrics = { complete: true, total_requests: 0, trace: [], trace_dropped: 0 };
  value.events = [{ kind: 'observer_start', observer_pid: 42, parent_pid: 10 }];
  for (const [index, view] of [undefined, { id: 'view-1', database_id: database }].entries()) {
    const common = { observer_pid: 42, id: 'list-' + index, operation: 'list', source_id: 'sdk-fixture', database };
    value.events.push({ kind: 'sdk', event: 'start', ...common },
      { kind: 'sdk_catalog', observer_pid: 42, id: common.id, value: { scope, ...(view ? { view, view_selection: 'first' } : {}),
        count: 2, records: value.fixture.default_view.records, coverage: { exhaustive: true, failed_sources: [] } } },
      { kind: 'sdk', event: 'end', ...common, status: 'completed', error_code: null, metrics_observed: true, request_metrics: metrics });
  }
  value.captures = value.captures.slice(1);
  return value;
}

test('warm directory rejects idle source finality and ordinary-only metadata', () => {
  const { events, expected } = warmDirectoryFixture();
  assert.equal(sourceFinality(events.slice(0, 1), 42).complete, true, 'Default source-drain semantics remain unchanged');
  assert.equal(sourceFinality(events.slice(0, 1), 42, { initialDirectory: expected }).complete, false);
  assert.equal(sourceFinality(events.slice(0, 4), 42, { initialDirectory: expected }).complete, false);
  assert.equal(sourceFinality(events, 42, { initialDirectory: expected }).complete, true);
  assert.equal(sourceFinality(events.slice(0, -1), 42, { initialDirectory: expected }).complete, false);
});

test('warm directory binds actual SDK source database scope coverage and no-body setup', () => {
  for (const mutate of [
    value => { value.events[4].source_id = 'other'; },
    value => { value.events[6].database = 'other'; },
    value => { value.events[5].value.scope = 'other'; },
    value => { value.events[5].value.coverage.exhaustive = false; },
    value => { value.events[5].value.coverage.failed_sources = [{ code: 'CACHE_MISSING' }]; },
    value => { value.events[5].value.records = value.events[5].value.records.slice(0, 1); },
    value => { value.events[6].status = 'failed'; value.events[6].error_code = 'CACHE_MISSING'; },
    value => { value.events[6].request_metrics = { complete: false, total_requests: null }; },
    value => { value.events[4].operation = 'consume'; },
    value => { value.events.push({ kind: 'sdk_catalog', observer_pid: 42, id: 'unbound', value: value.events[5].value }); },
    value => { value.events.push({ kind: 'object_read', event: 'start', observer_pid: 42 }); },
  ]) {
    const value = warmDirectoryFixture(); mutate(value);
    assert.throws(() => sourceFinality(value.events, 42, { initialDirectory: value.expected }));
  }
});

test('warm directory supports only terminal bundled metadata CLI calls for the owned historical arm', () => {
  const { expected } = warmDirectoryFixture(); Object.assign(expected, { transport: 'cli', bundledCli: command[1] });
  const events = [childTerminal[0]];
  for (const [index, defaultView] of [false, true].entries()) {
    const id = '42:' + (index + 1), pid = 43 + index;
    events.push({ kind: 'child_start', observer_pid: 42, id, bundled: true, operation: 'list',
      argv: [command[1], 'list', '--database', database, ...(defaultView ? ['--default-view'] : []), '--offline'] },
      { kind: 'child_spawn', observer_pid: 42, id, child_pid: pid },
      { kind: 'observer_start', observer_pid: pid, parent_pid: 42 },
      { ...hostEnd, observer_pid: pid },
      { kind: 'child_close', observer_pid: 42, id, child_pid: pid, code: 0, signal: null, stdout_bytes: 123, stdout_sha256: 'a'.repeat(64),
        request_metrics: { complete: true, total_requests: 0, trace: [], trace_dropped: 0 } });
  }
  assert.equal(sourceFinality(events, 42, { initialDirectory: expected }).complete, true);
  assert.equal(sourceFinality(events.slice(0, 6), 42, { initialDirectory: expected }).complete, false);
  assert.equal(sourceFinality(events.slice(0, -1), 42, { initialDirectory: expected }).complete, false);
  for (const mutate of [value => { value[6].argv[3] = 'other'; }, value => { value[10].code = 1; },
    value => { value[10].stdout_sha256 = null; }, value => { value[6].operation = 'prepare'; }]) {
    const changed = structuredClone(events); mutate(changed);
    assert.throws(() => sourceFinality(changed, 42, { initialDirectory: expected }));
  }
});

test('warm directory option is explicit and cannot alter all14 live or held-startup scenarios', () => {
  assert.equal(namedSdkProbe.warmDirectoryOptions({}), false);
  assert.equal(namedSdkProbe.warmDirectoryOptions({ '--warm-directory': 'false', '--scenario': 'all' }), false);
  for (const name of ['native', 'native-repeat', 'prepare'])
    assert.equal(namedSdkProbe.warmDirectoryOptions({ '--warm-directory': 'true', '--scenario': name, '--fixture': '/fixture.json' }), true);
  for (const options of [{}, { '--scenario': 'all' }, { '--scenario': 'dollar' }, { '--scenario': 'default-view' },
    { '--scenario': 'native', '--live-input': '/live.json' }])
    assert.throws(() => namedSdkProbe.warmDirectoryOptions({ '--warm-directory': 'true', '--fixture': '/fixture.json', ...options }));
});

test('warm directory proves actual first system cards and preserves historical presentation differences', () => {
  const value = warmDirectoryFixture();
  const current = namedSdkProbe.assertWarmDirectoryProjection(value.captures, value.message, value.fixture, value.bodies);
  assert.deepEqual(current.provider_requests[0].records.map(record => record.id), ['owner:a', 'owner:b']);
  assert.equal(current.first_provider_body_copies, 0);
  const legacy = structuredClone(value.captures);
  legacy[0].context.messages[0].content = legacy[0].context.messages[0].content.replaceAll('<name>', '<name>sdk-fixture-').replaceAll('<source>sdk-fixture</source>', '');
  const old = namedSdkProbe.assertWarmDirectoryProjection(legacy, value.message, value.fixture, value.bodies, { transport: 'cli' });
  assert.deepEqual(old.provider_requests[0].records.map(record => [record.displayed_name, record.displayed_source]), [['sdk-fixture-a', null], ['sdk-fixture-b', null]]);
  assert.throws(() => namedSdkProbe.assertWarmDirectoryProjection(legacy, value.message, value.fixture, value.bodies));
});

test('warm directory rejects pending fake user directory wrong owner metadata and private preloads', () => {
  for (const mutate of [
    value => { value.captures[0].context.messages[0].role = 'user'; },
    value => { value.captures[0].context.messages[0].content = '<ntn-skills-discovery status="pending">Pending</ntn-skills-discovery>'; },
    value => { value.captures[0].context.messages[0].content += value.captures[0].context.messages[0].content; },
    value => { value.message.details.records[0].id = 'other'; },
    value => { value.captures[0].context.messages[0].content = value.captures[0].context.messages[0].content.replace('Metadata', 'invented'); },
    value => { value.captures[0].context.messages[0].content = value.captures[0].context.messages[0].content.replace('sr:C' + '0'.repeat(22), 'sr:C' + '9'.repeat(22)); },
    value => { value.captures[0].context.messages.push({ role: 'user', content: value.bodies.get('a') }); },
  ]) {
    const value = warmDirectoryFixture(); mutate(value);
    assert.throws(() => namedSdkProbe.assertWarmDirectoryProjection(value.captures, value.message, value.fixture, value.bodies), { code: 'ERR_ASSERTION' });
  }
});
