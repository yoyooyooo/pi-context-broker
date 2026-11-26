import test from 'node:test';
import { verifyPreparationEvidence } from './retained-source-views.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectRuntimeTools, deliveredSourceBodies, preparedSourceMatches, verifiedCodeModeRuntime } from './collect.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const measure = value => ({ sha256: sha(value), bytes: Buffer.byteLength(value) });
const eventArtifact = { id: 'events', sha256: sha('native callbacks') };
const sessionArtifact = { id: 'session-entries', sha256: sha('native session') };

function nestedFixture() {
  const args = { path: 'input/data.json' }, result = { content: [{ type: 'text', text: 'complete body' }] };
  const parentResult = { content: [{ type: 'text', text: 'Script completed' }], details: { calls: [{ id: 'outer/1', name: 'read', status: 'ok', args: 'display preview only' }] } };
  const event = data => ({ type: 'session_event', turn_id: 'turn-1', data });
  const events = [
    event({ type: 'tool_execution_start', toolCallId: 'outer', toolName: 'codemode', args: { code: 'arbitrary source is not evidence' } }),
    event({ type: 'tool_execution_start', toolCallId: 'outer/1', parentToolCallId: 'outer', toolName: 'read', args }),
    event({ type: 'tool_execution_end', toolCallId: 'outer/1', parentToolCallId: 'outer', toolName: 'read', isError: false, result }),
    event({ type: 'tool_execution_end', toolCallId: 'outer', toolName: 'codemode', isError: false, result: parentResult }),
  ];
  const session = { entries: [{ message: { role: 'toolResult', toolCallId: 'outer', toolName: 'codemode', isError: false,
    ...structuredClone(parentResult), nestedCalls: { complete: true, calls: [{ id: 'outer/1', name: 'read', status: 'ok', arguments: args }] } } }] };
  return { events, session };
}
const lineage = value => collectRuntimeTools(value.events, eventArtifact, value.session, sessionArtifact);
test('complete native census and actual callbacks prove a container, independently of script or preview text', () => {
  const value = lineage(nestedFixture());
  assert.equal(value.complete, true); assert.equal(value.tools[0].container.complete, true);
  assert.deepEqual(value.tools[0].container.descendant_ids, ['outer/1']);
  assert.ok(value.tools[0].container.refs.some(ref => ref.artifact_id === 'session-entries'));
  assert.equal(value.tools[1].result.content[0].text, 'complete body');
});

const badLineages = {
  'missing persisted census': f => { delete f.session.entries[0].message.nestedCalls; },
  'partial census': f => { f.session.entries[0].message.nestedCalls.complete = false; },
  'omitted actual child': f => { f.session.entries[0].message.nestedCalls.calls = []; },
  'invented child without callbacks': f => { f.session.entries[0].message.nestedCalls.calls.push({ id: 'ghost', name: 'read', status: 'ok', arguments: {} }); },
  'duplicate census child': f => { f.session.entries[0].message.nestedCalls.calls.push(f.session.entries[0].message.nestedCalls.calls[0]); },
  'changed child arguments': f => { f.events[1].data.args = { path: 'different.json' }; },
  'truncated child arguments': f => { f.session.entries[0].message.nestedCalls.calls[0].argumentsBytes = 100; },
  'changed child tool': f => { f.session.entries[0].message.nestedCalls.calls[0].name = 'bash'; },
  'unfinished child': f => { f.session.entries[0].message.nestedCalls.calls[0].status = 'running'; },
  'failed child reported successful': f => { f.events[2].data.isError = true; },
  'missing terminal callback': f => { f.events.splice(2, 1); },
  'duplicate native callback': f => { f.events.splice(2, 0, structuredClone(f.events[1])); },
  'orphan child': f => { f.events[1].data.parentToolCallId = f.events[2].data.parentToolCallId = 'missing'; },
  'cyclic ancestry': f => { f.events[0].data.parentToolCallId = f.events[3].data.parentToolCallId = 'outer/1'; },
  'child ends outside parent': f => { [f.events[2], f.events[3]] = [f.events[3], f.events[2]]; },
  'child crosses turn': f => { f.events[1].turn_id = f.events[2].turn_id = 'turn-2'; },
  'parent result differs from session': f => { f.events[3].data.result.content[0].text = 'different'; },
  'direct census omits child': f => { f.session.entries[0].message.details.calls = []; },
  'direct census has an unobserved side effect': f => { f.session.entries[0].message.details.calls.push({ id: 'hidden', name: 'bash', status: 'ok' }); },
  'callback direct census contradicts the persisted census': f => { f.events[3].data.result.details.calls.push({ id: 'hidden', name: 'bash', status: 'ok' }); },
};
for (const [name, mutate] of Object.entries(badLineages)) test('container rejects ' + name, () => {
  const f = nestedFixture(); mutate(f); assert.equal(lineage(f).tools.find(tool => tool.id === 'outer').container.complete, false);
});
test('failed parent and a census without an artifact remain opaque; observed child bytes survive', () => {
  const f = nestedFixture(); f.events[3].data.isError = f.session.entries[0].message.isError = true;
  assert.equal(lineage(f).tools[0].container.complete, false); assert.equal(lineage(f).tools[1].status, 'pass');
  const other = nestedFixture(); assert.equal(collectRuntimeTools(other.events, eventArtifact, other.session).tools[0].container.complete, false);
});
test('a caught child failure remains opaque even when both complete censuses honestly report it', () => {
  for (const name of ['read', 'write', 'edit', 'bash']) {
    const f = nestedFixture();
    f.events[1].data.toolName = f.events[2].data.toolName = name; f.events[2].data.isError = true;
    f.events[3].data.result.details.calls[0].name = name; f.events[3].data.result.details.calls[0].status = 'error';
    const message = f.session.entries[0].message;
    message.details.calls[0].name = message.nestedCalls.calls[0].name = name;
    message.details.calls[0].status = message.nestedCalls.calls[0].status = 'error';
    const result = lineage(f); assert.equal(result.complete, true); assert.equal(result.tools[0].container.complete, false, name);
  }
});

function runtimeFixture() {
  const files = [
    ['index.js', '7306902a1079689f601231d4c9bd3abb1d92ec388d202ff08920e4aee87343f4', 1620],
    ['tool.js', '6904d6b3ebb66e6d9b6eac5cce8f70c11d01ddc3a0a0422ba78645558476d319', 17993],
    ['execute.js', '18c746d8ec9ad52c17bae4357a374629d500823e7744281905c8a1faf9c17791', 34675],
  ].map(([name, sha256, bytes]) => ({ path: '/retained/pi/dist/extensions/codemode/' + name, sha256, bytes }));
  const snapshot = { entry_kind: 'pi-sdk', pi: { files }, code_mode: { enabled: true, models: false },
    factories: { codemode: 'public createCodemodeExtension, models:false' },
    extensions: [{ resolved_path: 'builtin:codemode', tools: ['codemode'], handlers: [] }],
    tools: { all: [{ name: 'codemode', sourceInfo: { path: 'builtin:codemode', source: 'builtin' } }] } };
  return { candidate: { snapshot: structuredClone(snapshot), projection: structuredClone(snapshot) },
    expected: { projection: structuredClone(snapshot) }, admission: { differences: [] }, after: { files: structuredClone(files), differences: [] } };
}
test('only the reviewed builtin wrapper with matching frozen admission and after observation is recognized', () => {
  assert.equal(verifiedCodeModeRuntime(runtimeFixture()), true);
  for (const mutate of [
    f => { f.candidate.snapshot.pi.files[2].sha256 = sha('different runtime'); },
    f => { f.candidate.snapshot.code_mode.models = true; },
    f => { f.candidate.snapshot.factories.codemode = 'custom factory'; },
    f => { f.candidate.snapshot.tools.all[0].sourceInfo.source = 'extension'; },
    f => { f.candidate.snapshot.extensions[0].handlers = [{ event: 'tool_result', count: 1 }]; },
    f => { f.candidate.snapshot.extensions.push(f.candidate.snapshot.extensions[0]); },
    f => { f.candidate.snapshot.pi.files.push(f.candidate.snapshot.pi.files[0]); },
    f => { f.expected.projection.code_mode.models = true; },
    f => { f.admission.differences = ['drift']; },
    f => { f.after.files[0].sha256 = sha('changed during run'); },
    f => { f.after.differences = ['drift']; },
    f => { delete f.after; },
  ]) { const value = runtimeFixture(); mutate(value); assert.equal(verifiedCodeModeRuntime(value), false); }
});

function preparationFixture({ owner = 'shared_skill:fixture:one', token = 'sr:R' + 'r'.repeat(22), body = '完整 resource\n', snapshot = 's_' + sha('snapshot'), version = sha('version'), compactDescription = false } = {}) {
  const scope = sha('scope'), main = '# Source\n', path = 'references/rules.md';
  const fixed = resource => 'skill://' + encodeURIComponent(owner) + '/' + resource + '?snapshot=' + snapshot;
  const binding = { record: { id: owner, entrypoint: 'SKILL.md' }, scope, snapshot_id: snapshot, version_id: version, body_sha256: sha(main) };
  const description = 'Exact fixed resource description';
  const directory = { files: [{ path, ref: token, bytes: Buffer.byteLength(body), ...(compactDescription ? { description } : {}) }],
    required: [], candidates: [], references: compactDescription ? [{ ref: token }] : [] };
  const record = { name: 'fixture', kind: 'skill', ref: 'sr:S' + 's'.repeat(22), content: main, directory };
  const model = { ok: true, status: 'ready', purpose: 'use', roots: [record.ref], records: [record] }, content = JSON.stringify(model);
  const encoded = JSON.stringify(main).slice(1, -1), start = content.indexOf('"content":') + '"content":"'.length;
  const delivery = { start, end: start + encoded.length, encoding: 'json' }, identity = JSON.stringify(['notion', scope, 'skill', 'shared_skill', owner]);
  const receipt = { version: 2, identity, contentIdentity: JSON.stringify([scope, owner]), loaded: true,
    snapshotId: snapshot, bodySha256: sha(main), bytes: Buffer.byteLength(main), binding, delivery,
    directory: { ...directory, files: [{ path, ref: fixed(path), ...measure(body) }],
      references: compactDescription ? [{ ref: fixed(path), kind: 'file', name: path, description, availability: 'available' }] : [] } };
  const proof = { version: 2, toolCallId: 'prepare', purpose: 'use', records: [receipt], graphs: [{ scope }],
    projection: { version: 1, compiler: 'context-broker/skill-prepare/v1', sourceProjection: 'source-identity/v1', rendered: measure(content),
      records: [{ index: 0, ref: record.ref, source: { identity, ...measure(main) }, rendered: measure(encoded), delivery, state: 'source' }] } };
  const prep = { id: 'prepare', name: 'notion_use', status: 'pass', turn_id: 'turn-1', sequence: 1, end_sequence: 2,
    result: { content: [{ type: 'text', text: content }], details: { contextBrokerPreparation: proof } }, refs: [{ ...sessionArtifact, artifact_id: sessionArtifact.id, pointer: '/entries/0/message' }] };
  const read = { id: 'outer/1', parent_id: 'outer', name: 'read', status: 'pass', turn_id: 'turn-1', sequence: 4, end_sequence: 5,
    args: { path: token }, result: { content: [{ type: 'text', text: body }], structuredContent: body } };
  return { prep, read, proof, binding, body, path, model };
}
test('short reference read needs a preceding complete preparation, exact token and complete delivered bytes', () => {
  const f = preparationFixture(), result = deliveredSourceBodies(f.read, [f.prep]);
  assert.equal(result.length, 1); assert.equal(result[0].body, f.body); assert.equal(result[0].path, f.path);
  assert.equal(result[0].owner, f.binding.record.id); assert.equal(result[0].preparation_tool_call_id, f.prep.id);
  assert.ok(result[0].refs.some(ref => ref.artifact_id === 'session-entries'));
  assert.deepEqual(deliveredSourceBodies(f.read), []);
  for (const mutate of [
    f => { f.read.args.path += ' extra'; },
    f => { f.read.name = 'bash'; },
    f => { f.read.status = 'fail'; },
    f => { f.read.turn_id = 'turn-2'; },
    f => { f.prep.end_sequence = f.read.sequence; },
    f => { f.read.result.content[0].text += 'trailing bytes'; },
    f => { f.read.result.structuredContent = 'different bytes'; },
    f => { f.proof.projection.rendered.sha256 = sha('forged'); },
    f => { f.proof.records[0].directory.files[0].sha256 = sha('wrong body'); },
    f => { f.proof.records[0].directory.files[0].bytes--; },
    f => { f.proof.records[0].directory.files[0].ref = f.proof.records[0].directory.files[0].ref.replace('fixture', 'foreign'); },
    f => { f.proof.records[0].binding.scope = sha('other scope'); },
    f => { f.proof.records[0].binding.snapshot_id = 's_' + sha('other snapshot'); },
  ]) { const value = preparationFixture(); mutate(value); assert.deepEqual(deliveredSourceBodies(value.read, [value.prep]), []); }
});
test('one token cannot silently acquire a second owner, snapshot, version or path', () => {
  const first = preparationFixture();
  for (const options of [{ owner: 'shared_skill:fixture:other' }, { snapshot: 's_' + sha('other snapshot') }, { version: sha('other version') }]) {
    const other = preparationFixture(options); assert.deepEqual(deliveredSourceBodies(first.read, [first.prep, other.prep]), []);
  }
  const other = preparationFixture();
  other.proof.records[0].directory.files[0].path = 'other.md';
  other.proof.records[0].directory.files[0].ref = other.proof.records[0].directory.files[0].ref.replace('references/rules.md', 'other.md');
  other.model.records[0].directory.files[0].path = 'other.md';
  other.prep.result.content[0].text = JSON.stringify(other.model); other.proof.projection.rendered = measure(other.prep.result.content[0].text);
  assert.deepEqual(deliveredSourceBodies(first.read, [first.prep, other.prep]), []);
});
test('relative source read uses the prepared record identity and complete directory bytes', () => {
  const f = preparationFixture(), direct = deliveredSourceBodies(f.read, [f.prep]);
  f.read.args = { from: f.model.records[0].ref, path: f.path };
  assert.deepEqual(deliveredSourceBodies(f.read, [f.prep]), direct);
  assert.deepEqual(deliveredSourceBodies(f.read), []);
  for (const mutate of [
    value => { value.read.args.from = 'sr:S' + 'x'.repeat(22); },
    value => { value.read.args.path = 'other/rules.md'; },
    value => { value.read.result.content[0].text = value.body.slice(0, -1); },
    value => { value.read.result.structuredContent = 'different bytes'; },
    value => { value.read.turn_id = 'turn-2'; },
    value => { value.prep.end_sequence = value.read.sequence; },
    value => { value.proof.projection.rendered.sha256 = sha('forged'); },
  ]) {
    const value = preparationFixture(); value.read.args = { from: value.model.records[0].ref, path: value.path };
    mutate(value); assert.deepEqual(deliveredSourceBodies(value.read, [value.prep]), []);
  }
});
test('a relative source read cannot borrow identical bytes from another owner or snapshot', () => {
  const first = preparationFixture(); first.read.args = { from: first.model.records[0].ref, path: first.path };
  for (const options of [{ owner: 'shared_skill:fixture:other' }, { snapshot: 's_' + sha('other snapshot') }, { version: sha('other version') }]) {
    const other = preparationFixture(options);
    assert.deepEqual(deliveredSourceBodies(first.read, [first.prep, other.prep]), []);
  }
});
test('retained compact file descriptions keep their exact fixed reference evidence', () => {
  const fixture = () => {
    const value = preparationFixture({ compactDescription: true });
    value.read.args = { from: value.model.records[0].ref, path: value.path };
    return value;
  };
  const complete = fixture();
  assert.equal(deliveredSourceBodies(complete.read, [complete.prep])[0]?.body, complete.body);
  for (const mutate of [
    value => { value.proof.records[0].directory.references[0].ref = value.proof.records[0].directory.references[0].ref.split('?')[0]; },
    value => { value.proof.records[0].directory.references[0].ref += '&library=11111111-1111-4111-8111-111111111111'; },
    value => { value.proof.records[0].directory.references[0].ref = value.proof.records[0].directory.references[0].ref.replace('fixture', 'foreign'); },
    value => { value.proof.records[0].directory.references[0].description = 'Different description'; },
    value => { value.model.records[0].directory.references[0].ref = 'sr:R' + 'x'.repeat(22); },
    value => { value.model.records[0].directory.files[0].description = 'Different description'; },
  ]) {
    const value = fixture(); mutate(value);
    value.prep.result.content[0].text = JSON.stringify(value.model);
    value.proof.projection.rendered = measure(value.prep.result.content[0].text);
    assert.deepEqual(deliveredSourceBodies(value.read, [value.prep]), []);
  }
});
test('retained preparation verification preserves local source references', () => {
  for (const reference of ['/owned/skills/eligibility/SKILL.md', 'file:///owned/skills/eligibility/SKILL.md', 'local:/owned/catalog#eligibility']) {
    const f = preparationFixture({ owner: 'local:/owned/skills/eligibility/SKILL.md' }), receipt = f.proof.records[0];
    receipt.binding.record.ref = reference; receipt.binding.ref = reference;
    receipt.directory.files[0].ref = reference;
    assert.equal(verifyPreparationEvidence(f.prep.result.content[0].text, f.proof, f.prep.id).records.length, 1, reference);
    for (const mutate of [
      value => { value.binding.record.id = 'skill://eligibility?library=11111111-1111-4111-8111-111111111111'; },
      value => { value.binding.ref = 'skill://eligibility/SKILL.md?library=11111111-1111-4111-8111-111111111111'; },
      value => { value.directory.files[0].ref = 'skill://eligibility/rules.md?library=11111111-1111-4111-8111-111111111111'; },
    ]) {
      const proof = structuredClone(f.proof); mutate(proof.records[0]);
      assert.throws(() => verifyPreparationEvidence(f.prep.result.content[0].text, proof, f.prep.id), /Library-qualified/);
    }
  }
});
test('prepared identity must independently match material version and observed SDK source identity', () => {
  const f = preparationFixture(), delivered = deliveredSourceBodies(f.read, [f.prep])[0], binding = delivered.source_binding;
  const material = { path: f.path, actual_sha256: sha(f.body), identity: { bound_owner: binding.owner,
    bound_versions: { v1: { snapshot_id: binding.snapshot_id, version_id: binding.version_id } } } };
  const sdk = { ...binding, path: f.path, ...measure(f.body) };
  assert.equal(preparedSourceMatches(binding, material, sdk, Buffer.byteLength(f.body)), true);
  for (const key of ['owner', 'scope', 'snapshot_id', 'version_id', 'path', 'sha256', 'bytes'])
    assert.equal(preparedSourceMatches(binding, material, { ...sdk, [key]: 'foreign' }, Buffer.byteLength(f.body)), false, key);
  assert.equal(preparedSourceMatches(binding, { ...material, identity: { ...material.identity, bound_owner: 'same-bytes-different-owner' } }, sdk, sdk.bytes), false);
  const multiple = structuredClone(material); multiple.identity.bound_versions.v2 = { snapshot_id: 's_' + sha('v2'), version_id: sha('v2') };
  assert.equal(preparedSourceMatches(binding, multiple, sdk, sdk.bytes), false);
  multiple.version = 'v2'; assert.equal(preparedSourceMatches(binding, multiple, sdk, sdk.bytes), false);
  multiple.version = 'v1'; assert.equal(preparedSourceMatches(binding, multiple, sdk, sdk.bytes), true);
});
