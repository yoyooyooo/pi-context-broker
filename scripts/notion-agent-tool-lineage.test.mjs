import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { correlateNotionAgentToolAttempts, inspectNotionAgentReadOnlyContainer, inspectedCompactReadImplementation, inspectedLocalReadEvidence } from './notion-agent-tool-lineage.mjs';
import { analyzeNotionAgentTurn } from './notion-agent-analysis.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const argsHash = value => sha(JSON.stringify(value));
function fixture() {
  const rootId = 'opaque-model-root', childId = 'independent-child-identity';
  const args = { code: 'const result = await tools.read({path:"/owned/SKILL.md"}); text(result);' };
  const child = { id: childId, name: 'read', arguments: { path: '/owned/SKILL.md' }, status: 'ok', durationMs: 3 };
  const native = { id: rootId, name: 'codemode', arguments: args, active: true, userEntryId: 'user',
    callLine: 3, resultLine: 4, assistantEntryId: 'assistant', resultEntryId: 'result', isError: false };
  const message = { role: 'toolResult', toolCallId: rootId, toolName: 'codemode', isError: false,
    content: [{ type: 'text', text: 'actual parent output' }], nestedCalls: { complete: true, calls: [child] },
    details: { calls: [{ id: childId, name: 'read', args: 'preview only', status: 'ok' }] } };
  const tasks = [
    { phase: 'tool_call', toolCallId: rootId, toolName: 'codemode', inputSha256: argsHash(args), selectors: {},
      toolSource: { path: 'builtin:codemode', source: 'builtin' } },
    { phase: 'tool_call', toolCallId: childId, toolName: 'read', inputSha256: argsHash(child.arguments), selectors: child.arguments },
    { phase: 'tool_result', toolCallId: childId, toolName: 'read', isError: false },
    { phase: 'tool_result', toolCallId: rootId, toolName: 'codemode', isError: false },
  ];
  const session = { supported: true, currentUserId: 'user', attempts: [native],
    branchEntries: [{ type: 'message', id: 'result', message }] };
  return { tasks, session, rootId, childId, native, message, child };
}
const inspect = value => correlateNotionAgentToolAttempts(value);
const codes = value => inspect(value).diagnostics.map(problem => problem.code);

function preparedFixture() {
  const id = 'actual-read', scope = 'a'.repeat(64), owner = 'shared_skill:library-test:skill-test';
  const snapshot = 's_' + 'b'.repeat(64), version = 'c'.repeat(64), fileId = 'file-' + 'd'.repeat(64);
  const original = { path: 'sr:Cl_Zoi4sBM-mbsLglJeO1BA' }, body = Buffer.from('完整正文\n');
  const path = '/cache/notion/scopes/' + scope + '/records/' + sha(owner) + '/entries/' + snapshot + '/tree/SKILL.md';
  const input = { path }, ref = 'skill://' + encodeURIComponent(owner), fixed = ref + '/SKILL.md?snapshot=' + snapshot + '&file_id=' + fileId;
  const locator = { type: 'shared_skill', database_id: 'database', data_source_id: 'source', page_id: 'page', library_id: 'library-test', skill_id: 'skill-test' };
  const record = { id: owner, kind: 'skill', locator, entrypoint: 'SKILL.md', ref: ref + '/SKILL.md' };
  const binding = { record, scope, snapshot_id: snapshot, version_id: version, body_sha256: sha(body), ref: fixed };
  const rendered = body.toString() + '\n<notion-effects>readonly</notion-effects>';
  const proof = { version: 3, identity: JSON.stringify(['notion', scope, 'skill', 'shared_skill', owner]), contentIdentity: JSON.stringify([scope, owner]),
    toolCallId: id, snapshotId: snapshot, bodySha256: sha(body), bytes: body.length, binding,
    delivery: { start: 0, end: body.toString().length, encoding: 'raw' }, rendered: { bytes: Buffer.byteLength(rendered), sha256: sha(rendered) } };
  const baseDir = '/installed/pi-compact-ui';
  const toolSource = { path: baseDir + '/index.ts', baseDir, source: 'npm:pi-compact-ui', scope: 'user', origin: 'package' };
  const reviewed = [['package.json', 567, 'a5f319f04fcc0ddeb47c0da5bdd08240598404f96b38dc1fe1baaaab14428f98'],
    ['index.ts', 66369, 'bac76ae9ed99a3790d8a728cc6e9b5463927ac427a1462ffe59c6adf9e4d4509']];
  const toolImplementation = { version: 1, runtimeMode: 'rpc', files: reviewed.map(([relativePath, bytes, sha256]) =>
    ({ relativePath, path: baseDir + '/' + relativePath, artifact: { path: '/sealed/' + sha256, bytes, sha256 } })) };
  const brokerSource = { path: '/current/broker/src/index.ts', baseDir: '/current/broker', source: '/current/broker', scope: 'user', origin: 'package' };
  const observation = { phase: 'prepared_read', version: 1, toolName: 'read', toolCallId: id, receiptSequence: 3,
    originalInputSha256: argsHash(original), preparedInputSha256: argsHash(input), brokerSource,
    file: { path, realpath: path }, manifest: { path: path.replace('/tree/SKILL.md', '/.broker-entry.json'), realpath: path.replace('/tree/SKILL.md', '/.broker-entry.json') } };
  const tasks = [
    { phase: 'tool_call', toolName: 'read', toolCallId: id, inputSha256: argsHash(original), selectors: original, toolSource, toolImplementation },
    { phase: 'tool_result', toolName: 'read', toolCallId: id, inputSha256: argsHash(input), isError: false },
    { phase: 'receipt', toolName: 'read', toolCallId: id, proofs: { contextBrokerRead: proof }, content: proof.rendered },
    observation, { phase: 'provider_payload' },
  ];
  tasks.forEach((row, index) => Object.assign(row, { pid: 100, turn: 1, sequence: index + 1 }));
  const native = { id, name: 'read', arguments: original, active: true, userEntryId: 'user', callLine: 4, resultLine: 5,
    assistantEntryId: 'assistant', resultEntryId: 'result', isError: false };
  const session = { supported: true, currentUserId: 'user', attempts: [native], branchEntries: [
    { type: 'custom', id: 'short-ref', customType: 'context-broker-short-ref', data: { version: 1, ref: original.path,
      target: { kind: 'candidate', identity: { source: 'notion', scope, id: owner, kind: 'skill', locator, ref } } } },
    { type: 'message', id: 'assistant' },
    { type: 'message', id: 'result', message: { role: 'toolResult', toolCallId: id, toolName: 'read', isError: false,
      content: [{ type: 'text', text: rendered }], details: { contextBrokerRead: proof } } },
  ] };
  const manifest = { version: 1, projection: 'entry', manifest_complete: true, scope, id: owner, snapshot_id: snapshot,
    version_id: version, entrypoint: 'SKILL.md', ref: fixed,
    files: [{ path: 'SKILL.md', bytes: body.length, sha256: sha(body), ref: fixed }],
    file_bindings: [{ path: 'SKILL.md', file_id: fileId, page_id: locator.page_id }] };
  // Artifact I/O is the analyzer's existing verifiedArtifact boundary. These
  // are its verified byte values, not a caller-supplied 'passed' declaration.
  const evidence = { observation, input, body, manifest, content: [{ type: 'text', text: body.toString() }],
    brokerOwner: { source: structuredClone(brokerSource), commit: 'e'.repeat(40) } };
  return { tasks, session, preparedReads: new Map([[id, evidence]]), evidence, native, proof };
}

function localReadFixture({ nested = false, input = { path: '/owned/SKILL.md' } } = {}) {
  const value = fixture(), reviewed = preparedFixture().tasks[0];
  const content = Buffer.from(JSON.stringify([{ type: 'text', text: 'Actual local text.\n' }]));
  value.child.arguments = structuredClone(input);
  let tasks = value.tasks, session = value.session, id = value.childId;
  if (!nested) {
    id = 'native-local-read';
    const native = { id, name: 'read', arguments: structuredClone(input), active: true, userEntryId: 'user',
      callLine: 3, resultLine: 4, assistantEntryId: 'assistant', resultEntryId: 'result', isError: false };
    session = { supported: true, currentUserId: 'user', attempts: [native], branchEntries: [{
      type: 'message', id: 'result', message: { role: 'toolResult', toolName: 'read', toolCallId: id,
        isError: false, content: JSON.parse(content) },
    }] };
    tasks = [{ phase: 'tool_call', toolName: 'read', toolCallId: id },
      { phase: 'tool_result', toolName: 'read', toolCallId: id, isError: false }];
  }
  const event = tasks.find(row => row.phase === 'tool_call' && row.toolCallId === id);
  const result = tasks.find(row => row.phase === 'tool_result' && row.toolCallId === id);
  Object.assign(event, { inputSha256: argsHash(input), selectors: structuredClone(input),
    toolSource: structuredClone(reviewed.toolSource), toolImplementation: structuredClone(reviewed.toolImplementation) });
  Object.assign(result, { inputSha256: argsHash(input), content: { bytes: content.length, sha256: sha(content) },
    contentArtifact: { path: '/sealed/local-result.json', bytes: content.length, sha256: sha(content) } });
  if (nested) event.parentToolCallId = result.parentToolCallId = value.rootId;
  tasks.forEach((row, index) => Object.assign(row, { pid: 100, turn: 1, sequence: index + 1 }));
  const correlation = inspect({ tasks, session });
  assert.equal(correlation.status, 'passed', JSON.stringify(correlation.diagnostics));
  return { tasks, session, content, event, result, call: correlation.attempts.find(row => row.id === id) };
}

test('a reviewed local reader retains native and nested calls, including bounded ranges', () => {
  for (const nested of [false, true]) for (const input of [
    { path: '/owned/SKILL.md' }, { path: '/owned/reference.md', limit: 135 },
    { path: '/owned/reference.md', offset: 138, limit: 117 },
  ]) {
    const f = localReadFixture({ nested, input });
    const proof = inspectedLocalReadEvidence(f.call, f.content);
    assert.ok(proof);
    assert.equal(proof.profile, 'pi-compact-ui:0.1.3:native-read-delegate');
    assert.equal(proof.path, input.path);
    assert.equal(proof.offset, input.offset);
    assert.equal(proof.limit, input.limit);
    assert.deepEqual(proof.content, { sha256: sha(f.content), bytes: f.content.length });
  }
});

test('local read lineage cannot borrow a name, partial implementation, changed input, or incomplete result', () => {
  for (const mutate of [
    f => { delete f.event.toolImplementation; f.event.reviewedReadTool = true; },
    f => { f.event.toolSource.source = 'npm:another-package'; },
    f => { f.event.toolImplementation.files.pop(); },
    f => { f.event.toolImplementation.files[1].artifact.sha256 = 'a'.repeat(64); },
    f => { f.call.arguments.path = 'sr:C' + 'a'.repeat(22); },
    f => { f.call.arguments.path = 'skill://owner/SKILL.md'; },
    f => { f.call.arguments.path = 'relative/SKILL.md'; },
    f => { f.call.arguments.path = 42; },
    f => { f.call.arguments.refresh = true; },
    f => { f.call.arguments.limit = 0; },
    f => { f.call.arguments.offset = 1.5; },
    f => { f.event.inputSha256 = 'a'.repeat(64); },
    f => { delete f.result.inputSha256; },
    f => { f.result.inputSha256 = 'a'.repeat(64); },
    f => { f.result.pid += 1; },
    f => { f.result.turn += 1; },
    f => { f.result.sequence = f.event.sequence; },
    f => { f.result.parentToolCallId = 'another-parent'; },
    f => { f.call.parentToolCallId = 'another-parent'; },
    f => { f.result.isError = true; },
    f => { f.result.content.bytes += 1; },
    f => { f.result.content.sha256 = 'a'.repeat(64); },
    f => { delete f.result.contentArtifact; },
    f => { f.result.contentArtifact.sha256 = 'a'.repeat(64); },
    f => { f.content = Buffer.from('different actual result'); },
    f => { f.call.preparedRead = { claimed: true }; },
    f => { f.call.provenance.kind = 'unobserved'; },
  ]) {
    const f = localReadFixture({ nested: true }); mutate(f);
    assert.equal(inspectedLocalReadEvidence(f.call, f.content), undefined, mutate.toString());
  }
});

function selectedPreparedFixture({ resource = false, storage = 'entry', refresh = false, inspect = false, canonical = false } = {}) {
  const value = preparedFixture(), { evidence, tasks, session, native } = value;
  const binding = value.proof.binding, owner = binding.record.id, scope = binding.scope;
  const main = evidence.manifest.files[0], mainBinding = evidence.manifest.file_bindings[0];
  const ownerRef = 'sr:S' + 'o'.repeat(22), resourceRef = 'sr:R' + 'r'.repeat(22);
  const selected = { kind: 'selected', identity: session.branchEntries[0].data.target.identity,
    snapshot_id: binding.snapshot_id, version_id: binding.version_id, body_sha256: binding.body_sha256,
    entrypoint: 'SKILL.md', ref: binding.ref, file_id: mainBinding.file_id };
  const body = Buffer.from('精确资源\n'), fileId = 'file-' + 'f'.repeat(64), relative = 'references/rates.md';
  const fixed = 'skill://' + encodeURIComponent(owner) + '/' + relative + '?snapshot=' + binding.snapshot_id + '&file_id=' + fileId;
  const file = { path: relative, bytes: body.length, sha256: sha(body), ref: fixed };
  const fileBinding = { path: relative, file_id: fileId, page_id: 'resource-page' };
  evidence.manifest.files = [main, file]; evidence.manifest.file_bindings = [mainBinding, fileBinding];
  const priorOwner = { type: 'custom', id: 'selected-owner', customType: 'context-broker-short-ref',
    data: { version: 1, ref: ownerRef, target: selected } };
  const original = { path: canonical ? resource ? fixed : selected.ref : resource ? resourceRef : ownerRef,
    ...(refresh ? { refresh: true } : {}) };
  native.arguments = original; tasks[0].selectors = original; tasks[0].inputSha256 = argsHash(original);
  evidence.observation.originalInputSha256 = argsHash(original);
  session.branchEntries[0] = priorOwner;
  if (resource) {
    session.branchEntries.splice(1, 0, { type: 'custom', id: 'resource-ref', customType: 'context-broker-short-ref',
      data: { version: 1, ref: resourceRef, target: { kind: 'resource', owner: ownerRef,
        path: relative, ref: fixed, bytes: body.length, sha256: sha(body), file_id: fileId } } });
    evidence.body = body; evidence.content = [{ type: 'text', text: body.toString() }];
    const proof = { version: 2, toolCallId: native.id, id: owner, scope,
      snapshot_id: binding.snapshot_id, version_id: binding.version_id,
      ref: fixed, path: relative, bytes: body.length, sha256: sha(body), file_id: fileId,
      delivery: { start: 0, end: body.toString().length, encoding: 'raw' },
      delivered_complete_text: true, loaded: false, ...(inspect ? { purpose: 'inspect' } : {}) };
    value.proof = proof; tasks[2].proofs = { contextBrokerResource: proof };
    const message = session.branchEntries.find(entry => entry.id === 'result').message;
    const rendered = body.toString() + '\n<notion-effects>readonly</notion-effects>';
    message.content = [{ type: 'text', text: rendered }]; message.details = { contextBrokerResource: proof };
    tasks[2].content = { bytes: Buffer.byteLength(rendered), sha256: sha(rendered) };
    const path = '/cache/notion/scopes/' + scope + '/records/' + sha(owner) + '/' +
      (storage === 'entry' ? 'entries' : 'resources') + '/' + binding.snapshot_id + '/tree/' + relative;
    evidence.input = { path }; evidence.observation.file = { path, realpath: path };
    if (storage === 'resource') {
      evidence.observation.projection = 'resource'; delete evidence.observation.manifest; delete evidence.manifest;
    }
  } else if (refresh) {
    selected.snapshot_id = 's_' + 'e'.repeat(64); selected.version_id = 'f'.repeat(64);
    selected.ref = binding.ref.replace(binding.snapshot_id, selected.snapshot_id);
    if (canonical) {
      original.path = selected.ref; tasks[0].inputSha256 = argsHash(original);
      evidence.observation.originalInputSha256 = argsHash(original);
    }
    evidence.input = { ...evidence.input, refresh: true };
    value.proof.purpose = 'inspect';
    value.proof.readStatus = { purpose: 'inspect', activation_effect: 'unchanged', requires_acquisition: 'not_performed',
      use_selection: { status: 'inspection_only', roles: [] } };
    value.proof.directory = { files: structuredClone(evidence.manifest.files), required: [], candidates: [], references: [] };
  }
  tasks[1].inputSha256 = argsHash(evidence.input);
  evidence.observation.preparedInputSha256 = tasks[1].inputSha256;
  return value;
}

function changePreparedOriginal(value, input) {
  value.native.arguments = input; value.tasks[0].selectors = input;
  value.tasks[0].inputSha256 = argsHash(input);
  value.evidence.observation.originalInputSha256 = argsHash(input);
}

test('registered canonical fixed File reads retain the prior selected owner for main and resource storage', () => {
  for (const options of [{}, { refresh: true }, { resource: true }, { resource: true, storage: 'resource', inspect: true }]) {
    const value = selectedPreparedFixture({ ...options, canonical: true }), result = inspect(value);
    assert.equal(result.status, 'passed', JSON.stringify({ options, diagnostics: result.diagnostics }));
    assert.equal(result.attempts[0].preparedRead.originalRef, value.native.arguments.path);
    assert.equal(result.attempts[0].preparedRead.snapshotId, options.refresh ? value.proof.snapshotId : value.session.branchEntries[0].data.target.snapshot_id);
  }
});

test('canonical rewrites require the unique prior fixed registration and cannot rely on the receipt alone', () => {
  const resource = { resource: true, storage: 'resource', canonical: true };
  const main = { canonical: true, refresh: true };
  for (const [options, alter] of [
    [resource, value => { value.session.branchEntries.shift(); }],
    [resource, value => { value.session.branchEntries.splice(1, 1); }],
    [resource, value => { const row = structuredClone(value.session.branchEntries[1]); row.data.ref = 'sr:R' + 'z'.repeat(22); value.session.branchEntries.splice(1, 0, row); }],
    [resource, value => { value.session.branchEntries[1].data.ref = 'unregistered-ref-kind'; }],
    [resource, value => { const row = value.session.branchEntries.splice(1, 1)[0]; value.session.branchEntries.push(row); }],
    [resource, value => { value.session.branchEntries[1].data.target.owner = 'sr:S' + 'z'.repeat(22); }],
    [resource, value => { value.proof.file_id = 'file-' + 'e'.repeat(64); }],
    [resource, value => { value.proof.version_id = 'e'.repeat(64); }],
    [resource, value => { changePreparedOriginal(value, { ...value.native.arguments, refresh: true }); }],
    [resource, value => { const path = value.native.arguments.path.split('?')[0]; value.session.branchEntries[1].data.target.ref = path; changePreparedOriginal(value, { path }); }],
    [resource, value => { const path = value.native.arguments.path + '&extra=unreviewed'; value.session.branchEntries[1].data.target.ref = path; value.proof.ref = path; changePreparedOriginal(value, { path }); }],
    [resource, value => { const path = value.native.arguments.path + '&snapshot=' + value.proof.snapshot_id; value.session.branchEntries[1].data.target.ref = path; value.proof.ref = path; changePreparedOriginal(value, { path }); }],
    [main, value => { value.session.branchEntries[0].data.target.identity.scope = 'f'.repeat(64); }],
    [main, value => { delete value.evidence.input.refresh; }],
    [main, value => { delete value.proof.purpose; }],
    [resource, value => { value.preparedReads.clear(); }],
  ]) {
    const value = selectedPreparedFixture(options); alter(value);
    assert.equal(inspect(value).status, 'failed');
    assert.ok(codes(value).includes('TOOL_RESULT_INPUT_MISMATCH'));
  }
});

test('selected refresh inspection keeps its original flag while binding the newly observed complete entry', () => {
  const value = selectedPreparedFixture({ refresh: true }), result = inspect(value);
  assert.equal(result.status, 'passed', JSON.stringify(result.diagnostics));
  assert.deepEqual(result.attempts[0].arguments, value.native.arguments);
  assert.equal(result.attempts[0].preparedRead.snapshotId, value.proof.snapshotId);
});

test('a fixed selected read retains its original full multi-file selection', () => {
  const value = selectedPreparedFixture(), result = inspect(value);
  assert.equal(result.status, 'passed');
  assert.equal(result.attempts[0].preparedRead.snapshotId, value.session.branchEntries[0].data.target.snapshot_id);
  assert.equal(value.evidence.manifest.files.length, 2);
});

test('scalar resource delegation binds the prior resource and selected owner for entry and resource storage', () => {
  for (const options of [{ resource: true }, { resource: true, storage: 'resource', inspect: true }]) {
    const value = selectedPreparedFixture(options), result = inspect(value);
    assert.equal(result.status, 'passed', JSON.stringify(result.diagnostics));
    assert.equal(result.attempts[0].preparedRead.bodySha256, sha(value.evidence.body));
    assert.equal(result.attempts[0].preparedRead.resourcePath, 'references/rates.md');
  }
});

test('selected and resource rewrites reject lost flags, foreign bindings, incomplete delivery and receipt-only history', () => {
  const cases = [
    [() => selectedPreparedFixture({ refresh: true }), value => { delete value.evidence.input.refresh; }],
    [() => selectedPreparedFixture({ refresh: true }), value => { delete value.proof.purpose; }],
    [() => selectedPreparedFixture(), value => { value.session.branchEntries[0].data.target.snapshot_id = 's_' + 'e'.repeat(64); }],
    [() => selectedPreparedFixture({ refresh: true }), value => { value.evidence.manifest.files.pop(); }],
    [() => selectedPreparedFixture({ resource: true }), value => { value.session.branchEntries.shift(); }],
    [() => selectedPreparedFixture({ resource: true }), value => { value.session.branchEntries.splice(0, 0, structuredClone(value.session.branchEntries[0])); }],
    [() => selectedPreparedFixture({ resource: true }), value => { const owner = value.session.branchEntries.shift(); value.session.branchEntries.push(owner); }],
    [() => selectedPreparedFixture({ resource: true }), value => { value.session.branchEntries[1].data.target.owner = 'sr:S' + 'z'.repeat(22); }],
    [() => selectedPreparedFixture({ resource: true }), value => { value.proof.file_id = 'file-' + 'e'.repeat(64); }],
    [() => selectedPreparedFixture({ resource: true }), value => { value.proof.version_id = 'e'.repeat(64); }],
    [() => selectedPreparedFixture({ resource: true }), value => { value.evidence.manifest.file_bindings[1].file_id = 'file-' + 'e'.repeat(64); }],
    [() => selectedPreparedFixture({ resource: true, storage: 'resource' }), value => { value.evidence.observation.file.realpath += '-other'; }],
    [() => selectedPreparedFixture({ resource: true, storage: 'resource' }), value => { value.evidence.content = [{ type: 'text', text: 'partial' }]; }],
    [() => selectedPreparedFixture({ resource: true, storage: 'resource' }), value => { value.proof.delivered_complete_text = false; }],
    [() => selectedPreparedFixture({ resource: true, storage: 'resource' }), value => { value.evidence.body = Buffer.from('different'); }],
    [() => selectedPreparedFixture({ resource: true, storage: 'resource' }), value => { value.preparedReads.clear(); }],
  ];
  for (const [index, [make, alter]] of cases.entries()) {
    const value = make(); alter(value);
    assert.equal(inspect(value).status, 'failed', 'case ' + index);
    assert.ok(codes(value).includes('TOOL_RESULT_INPUT_MISMATCH'), 'case ' + index);
  }
});

test('a verified ordinary compact-ui read proves original short ref, prepared input, owner and full file delivery', () => {
  const value = preparedFixture(), result = inspect(value);
  assert.equal(result.status, 'passed', JSON.stringify(result.diagnostics));
  assert.equal(result.attempts[0].preparedRead.profile, 'pi-compact-ui:0.1.3:native-read-delegate');
  assert.equal(result.attempts[0].preparedRead.bodySha256, sha(value.evidence.body));
  assert.deepEqual(result.attempts[0].arguments, value.native.arguments);
  value.preparedReads.clear();
  assert.ok(codes(value).includes('TOOL_RESULT_INPUT_MISMATCH'), 'a receipt alone cannot repair old observations');
});

test('prepared read proof rejects wrong original, path, bytes, owner, implementation and late cross-call evidence', () => {
  const cases = [
    value => { value.native.arguments = { path: 'sr:CAAAAAAAAAAAAAAAAAAAAAA' }; value.tasks[0].inputSha256 = argsHash(value.native.arguments); value.tasks[0].selectors = value.native.arguments; value.evidence.observation.originalInputSha256 = value.tasks[0].inputSha256; },
    value => { value.evidence.input.path = value.evidence.input.path.replace('/records/', '/elsewhere/'); value.tasks[1].inputSha256 = argsHash(value.evidence.input); value.evidence.observation.preparedInputSha256 = value.tasks[1].inputSha256; value.evidence.observation.file = { path: value.evidence.input.path, realpath: value.evidence.input.path }; },
    value => { value.evidence.body = Buffer.from('different bytes'); },
    value => { value.evidence.manifest.file_bindings[0].page_id = 'different-owner'; },
    value => { value.tasks[0].toolSource.source = 'npm:unreviewed-reader'; },
    value => { value.tasks[0].toolImplementation.files[1].artifact.sha256 = 'f'.repeat(64); },
    value => { value.tasks[3].brokerSource = { ...value.tasks[3].brokerSource, path: '/other/broker/src/index.ts' }; },
    value => { value.tasks[2].toolCallId = 'another-call'; },
    value => { value.tasks[2].turn = 2; value.tasks[3].turn = 2; },
    value => { for (const row of value.tasks) delete row.pid; },
    value => { [value.tasks[3], value.tasks[4]] = [value.tasks[4], value.tasks[3]]; },
    value => { const binding = value.session.branchEntries.shift(); value.session.branchEntries.push(binding); },
    value => { value.evidence.content = [{ type: 'text', text: 'same receipt but wrong actual result' }]; },
  ];
  for (const [index, change] of cases.entries()) {
    const value = preparedFixture(); change(value);
    assert.equal(inspect(value).status, 'failed', 'case ' + index);
    assert.ok(codes(value).includes('TOOL_RESULT_INPUT_MISMATCH'), 'case ' + index);
  }
});

test('reviewed read delegation requires the observed complete package files and actual registration', () => {
  const value = preparedFixture(), event = value.tasks[0];
  assert.ok(inspectedCompactReadImplementation(event));
  event.toolImplementation.files.pop(); assert.equal(inspectedCompactReadImplementation(event), undefined);
  const other = preparedFixture().tasks[0]; other.toolSource.path = '/somewhere/index.ts';
  assert.equal(inspectedCompactReadImplementation(other), undefined);
});

test('analysis reads the actual sealed implementation bytes before admitting a claimed reviewed rewrite', async () => {
  const bindings = { version: 1, public: {}, private: { objects: {}, bodies: {}, facts: {}, readbacks: {} } };
  for (const value of [preparedFixture(), selectedPreparedFixture({ refresh: true }),
    selectedPreparedFixture({ resource: true, storage: 'resource' })]) {
    const observed = { tasks: value.tasks, session: value.session, costs: [], transport: [], source: [], sourceCoverage: true };
    const result = await analyzeNotionAgentTurn({ id: 'sealed-read', expect: [{ kind: 'no-semantic-writes' }] }, observed, bindings,
      { inspectPayload: () => [], readArtifact: async () => Buffer.from('a different implementation despite the claimed hash') });
    assert.equal(result.assertions.find(row => row.kind === 'tool-attempt-observation').code, 'ARTIFACT_CHANGED');
    assert.notEqual(result.status, 'passed');
  }
});

test('opaque child IDs correlate through complete native census and direct structure, without ID parsing', () => {
  const value = fixture(), result = inspect(value);
  assert.equal(result.status, 'passed'); assert.deepEqual(result.counts, { actual: 2, topLevel: 1, nested: 1, errors: 0, retractedProposals: 0 });
  const child = result.attempts.find(call => call.id === value.childId), root = result.attempts[0];
  assert.equal(child.parentToolCallId, value.rootId); assert.equal(child.rootToolCallId, value.rootId);
  assert.equal(child.deliveryToolCallId, value.rootId); assert.equal(child.native.resultEntryId, 'result');
  assert.equal(child.provenance.parentEvidence, 'native-codemode-direct-census');
  assert.equal(child.native.syntheticFrom, 'native-nested-summary');
  assert.equal(inspectNotionAgentReadOnlyContainer(root, result, call => call.name === 'read').readOnly, true);
});

test('matching ID syntax cannot invent missing native nested execution evidence', () => {
  const value = fixture(); value.tasks[1].toolCallId = value.rootId + '/1'; value.tasks[2].toolCallId = value.rootId + '/1';
  delete value.message.nestedCalls; value.message.details.calls = [];
  const result = inspect(value);
  assert.equal(result.complete, false); assert.ok(result.diagnostics.some(problem => problem.code === 'NATIVE_TOOL_CORRELATION_MISSING'));
  assert.equal(inspectNotionAgentReadOnlyContainer(result.attempts[0], result, () => true).readOnly, false);
});

test('missing, truncated, unfinished, and unobserved children never provide complete coverage', () => {
  for (const change of [
    value => { value.message.nestedCalls.complete = false; },
    value => { delete value.child.arguments; value.child.argumentsBytes = 9000; },
    value => { value.child.status = 'unfinished'; },
    value => { value.tasks.splice(2, 1); },
    value => { value.tasks.splice(1, 2); },
  ]) {
    const value = fixture(); change(value);
    const result = inspect(value); assert.equal(result.complete, false);
    assert.equal(inspectNotionAgentReadOnlyContainer(result.attempts[0], result, () => true).readOnly, false);
  }
});

test('full nested arguments are checked against actual input hashes rather than UI previews', () => {
  const value = fixture(); value.child.arguments = { path: '/owned/' + 'long'.repeat(400) + '.md' };
  value.tasks[1].inputSha256 = argsHash(value.child.arguments); value.tasks[1].selectors = value.child.arguments;
  value.message.details.calls[0].args = '{"path":"truncated…';
  assert.equal(inspect(value).status, 'passed');
  value.tasks[1].inputSha256 = 'b'.repeat(64);
  assert.ok(codes(value).includes('TOOL_INPUT_HASH_MISMATCH')); assert.equal(inspect(value).status, 'failed');
});

test('a readonly-looking script cannot conceal a write child or unobserved model operation', () => {
  const value = fixture(); value.child.name = 'write'; value.tasks[1].toolName = 'write'; value.tasks[2].toolName = 'write';
  value.message.details.calls[0].name = 'write';
  const result = inspect(value);
  assert.equal(result.status, 'passed');
  assert.equal(inspectNotionAgentReadOnlyContainer(result.attempts[0], result, call => call.name === 'read').readOnly, false);
  const model = fixture(); model.message.details.calls.push({ id: 'opaque-model-operation', name: 'models.generateImages', status: 'ok' });
  const observed = inspect(model); assert.equal(observed.status, 'passed');
  assert.equal(observed.containers[0].complete, false);
  assert.equal(observed.containers[0].diagnostics[0].code, 'CODEMODE_UNOBSERVED_DIRECT_EFFECT');
});

test('failed children remain actual attempts and require matching terminal error status', () => {
  const value = fixture(); value.child.status = 'error'; value.tasks[2].isError = true; value.message.details.calls[0].status = 'error';
  const result = inspect(value); assert.equal(result.status, 'passed'); assert.equal(result.counts.errors, 1);
  assert.equal(inspectNotionAgentReadOnlyContainer(result.attempts[0], result, call => call.name === 'read').readOnly, true);
  value.tasks[2].isError = false; assert.equal(inspect(value).status, 'failed');
  assert.ok(codes(value).includes('TOOL_RESULT_STATUS_MISMATCH'));
});

test('explicit callback ancestry supports deeper nesting and preserves result artifacts', () => {
  const value = fixture(), grandchild = { id: 'another-opaque-identity', name: 'read',
    arguments: { path: '/owned/reference.md' }, status: 'ok', durationMs: 1 };
  value.message.nestedCalls.calls.push(grandchild);
  value.tasks[1].parentToolCallId = value.rootId; value.tasks[2].parentToolCallId = value.rootId;
  const proof = { path: '/private/result.json', sha256: 'c'.repeat(64), bytes: 50 };
  value.tasks.splice(2, 0,
    { phase: 'tool_call', toolCallId: grandchild.id, toolName: 'read', inputSha256: argsHash(grandchild.arguments), selectors: grandchild.arguments, parentToolCallId: value.childId },
    { phase: 'tool_result', toolCallId: grandchild.id, toolName: 'read', isError: false, parentToolCallId: value.childId,
      inputSha256: argsHash(grandchild.arguments), contentArtifact: proof });
  const result = inspect(value); assert.equal(result.status, 'passed');
  const actual = result.attempts.find(call => call.id === grandchild.id);
  assert.equal(actual.parentToolCallId, value.childId); assert.equal(actual.deliveryToolCallId, value.rootId);
  assert.deepEqual(actual.result.contentArtifact, proof);
  assert.deepEqual(result.containers[0].descendantIds, [value.childId, grandchild.id]);
});

test('contradictory parent callbacks and results outside parent lifetime are blocked', () => {
  const value = fixture(); value.tasks[1].parentToolCallId = 'wrong'; value.tasks[2].parentToolCallId = 'wrong';
  assert.equal(inspect(value).status, 'failed'); assert.ok(codes(value).includes('NESTED_TOOL_PARENT_CONFLICT'));
  const late = fixture(); [late.tasks[2], late.tasks[3]] = [late.tasks[3], late.tasks[2]];
  assert.ok(codes(late).includes('NESTED_TOOL_LIFETIME_UNPROVEN'));
});

test('callbacks cannot duplicate or omit an input hash to inflate or invent execution', () => {
  const value = fixture(); value.tasks.splice(2, 0, structuredClone(value.tasks[1]));
  assert.equal(inspect(value).status, 'failed'); assert.ok(codes(value).includes('TOOL_CALLBACK_DUPLICATED'));
  const missing = fixture(); delete missing.tasks[1].inputSha256;
  assert.equal(inspect(missing).complete, false); assert.ok(codes(missing).includes('TOOL_INPUT_HASH_MISSING'));
});

test('native retracted proposals stay separate from actual dispatch and effects', () => {
  const value = fixture(); value.session.attempts.push({ id: 'unexecuted-notion-use', name: 'notion_use',
    arguments: { ref: 'chosen-ref' }, active: true, userEntryId: 'user', retractedLine: 7 });
  const result = inspect(value); assert.equal(result.status, 'passed'); assert.equal(result.counts.actual, 2);
  assert.equal(result.counts.retractedProposals, 1);
  assert.equal(result.retractedProposals[0].phase, 'proposed_retracted'); assert.equal(result.retractedProposals[0].dispatched, false);
});

test('complete empty builtin composition is distinct from missing census or replacement implementation', () => {
  const value = fixture(); value.tasks.splice(1, 2); delete value.message.nestedCalls; value.message.details.calls = [];
  const result = inspect(value); assert.equal(result.status, 'passed'); assert.equal(result.containers[0].complete, true);
  assert.equal(inspectNotionAgentReadOnlyContainer(result.attempts[0], result, () => false).readOnly, true);
  value.tasks[0].toolSource = { path: '/unreviewed/codemode.js', source: 'package' };
  assert.equal(inspect(value).containers[0].complete, false);
  delete value.tasks[0].toolSource; delete value.message.details;
  assert.equal(inspect(value).containers[0].complete, false);
});

test('missing implementation provenance cannot certify zero writes even when lineage is complete', () => {
  for (const source of [undefined, null, {}, { path: 'builtin:codemode', source: 'package' }, { path: '/replacement/codemode.js', source: 'builtin' }]) {
    const value = fixture(); value.tasks[0].toolSource = source;
    const result = inspect(value);
    assert.equal(result.status, 'passed', 'Actual attempt correlation is separate from implementation effects');
    assert.equal(result.counts.actual, 2); assert.equal(result.counts.nested, 1);
    assert.equal(result.containers[0].complete, false);
    assert.equal(inspectNotionAgentReadOnlyContainer(result.attempts[0], result, call => call.name === 'read').readOnly, false);
    assert.ok(result.containers[0].diagnostics.some(value => value.code.startsWith('CODEMODE_IMPLEMENTATION_')));
  }
});
