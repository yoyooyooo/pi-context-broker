import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspectNotionAgentSession, captureNotionAgentSelection, analyzeNotionAgentTurn, verifyNotionAgentUnavailableReference, verifyNotionAgentNestedResourceRead } from './notion-agent-analysis.mjs';
import { inspectedPiToolRuntime, reviewedPiToolRuntimeProfile } from './notion-agent-tool-lineage.mjs';
import { candidatePayloadBodies } from './verify-pi-daily-candidate.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const stamp = '2026-11-21T14:00:00.000Z';
const header = { type: 'session', version: 3, id: 'session-1', timestamp: stamp, cwd: '/owned/project' };
const entry = (id, parentId, type, fields) => ({ type, id, parentId, timestamp: stamp, ...fields });
const message = (id, parentId, role, content, fields = {}) => entry(id, parentId, 'message', { message: {
  role, content, ...(role === 'assistant' ? { provider: 'magpie', model: 'group/worker', stopReason: 'stop' } : {}), ...fields } });
const model = entry('m', null, 'model_change', { provider: 'magpie', modelId: 'group/worker' });
const user = message('u', 'm', 'user', '请计算这次费用。');
const answer = (id = 'a', parent = 'u', text = '合计：100 元') => message(id, parent, 'assistant', [{ type: 'text', text }]);
const jsonl = (entries, suppliedHeader = header) => [suppliedHeader, ...entries].map(row => JSON.stringify(row)).join('\n') + '\n';
const inspect = (entries, options = {}) => inspectNotionAgentSession(jsonl(entries), options);

test('unavailable original reference requires its own online failed tool read, not repeated prompt text or another library request', async () => {
  const rootA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', rootB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const owner = 'skill://same-policy?library=' + rootA, content = [{ type: 'text', text: 'SKILL_NOT_FOUND: original current owner is absent' }];
  const files = new Map();
  const artifact = (path, value) => { const bytes = Buffer.from(JSON.stringify(value)); files.set(path, bytes); return { path, bytes: bytes.length, sha256: hash(bytes) }; };
  const failed = artifact('/owned/failed-read.json', content), payload = artifact('/owned/provider.json', { messages: [{ role: 'tool', tool_call_id: 'read-a', content }] });
  const bindings = { private: { objects: { original: { kind: 'notion', owner } } } };
  const observed = { visibility: { source: { sourceId: 'notion-a', library: rootA, additionalLibrary: { sourceId: 'notion-b', library: rootB } } },
    tasks: [{ phase: 'provider_payload', sha256: payload.sha256, payloadFile: payload.path }],
    session: { branchEntries: [{ id: 'result-a', message: { role: 'toolResult', toolCallId: 'read-a', isError: true, content } }] } };
  const attempts = [{ id: 'read-a', name: 'read', arguments: { path: owner }, event: { pid: 123, monotonicNs: '100' },
    native: { resultEntryId: 'result-a' }, result: { isError: true, monotonicNs: '200', contentArtifact: failed }, deliveryToolCallId: 'read-a' }];
  const source = [{ phase: 'started', kind: 'sdk', requestId: 'r-a', pid: 123, source_id: 'notion-a', library: rootA, operation: 'read', monotonicNs: '110' },
    { phase: 'attempt', requestId: 'r-a', monotonicNs: '120' },
    { phase: 'completed', requestId: 'r-a', status: 'failed', errorCode: 'SKILL_NOT_FOUND', monotonicNs: '190' }];
  const options = { attempts, source, delivery: { requests: [payload] }, readArtifact: async path => files.get(path) };
  const expected = { kind: 'unavailable-reference', object: 'original', path: 'SKILL.md' };
  const proof = await verifyNotionAgentUnavailableReference(expected, observed, bindings, options);
  assert.equal(proof.proofs[0].library, rootA); assert.equal(proof.proofs[0].httpAttempts, 1);
  await assert.rejects(verifyNotionAgentUnavailableReference(expected, observed, bindings, { ...options, attempts: [] }), /actually try/u);
  for (const change of [rows => { rows[0].library = rootB; }, rows => { rows[0].source_id = 'notion-b'; },
    rows => { rows[0].operation = 'list'; }, rows => { rows[0].pid = 456; }, rows => { rows[2].status = 'cancelled'; },
    rows => { rows[2].errorCode = 'AUTHENTICATION_FAILED'; }, rows => { rows[2].monotonicNs = '201'; }, rows => rows.splice(1, 1)]) {
    const altered = structuredClone(source); change(altered);
    await assert.rejects(verifyNotionAgentUnavailableReference(expected, observed, bindings, { ...options, source: altered }), /online failure/u);
  }
  const wrong = structuredClone(attempts); wrong[0].arguments.path = 'skill://same-policy?library=' + rootB;
  await assert.rejects(verifyNotionAgentUnavailableReference(expected, observed, bindings, { ...options, attempts: wrong }), /actually try/u);
  await assert.rejects(verifyNotionAgentUnavailableReference(expected, observed, bindings, { ...options, delivery: { requests: [] } }), /online failure/u);
  const changedPayload = artifact('/owned/changed-provider.json', { messages: [{ role: 'tool', tool_call_id: 'read-a', content: 'SKILL_NOT_FOUND: another owner failed; original A was not checked' }] });
  const changedObserved = { ...observed, tasks: [{ phase: 'provider_payload', sha256: changedPayload.sha256, payloadFile: changedPayload.path }] };
  await assert.rejects(verifyNotionAgentUnavailableReference(expected, changedObserved, bindings,
    { ...options, delivery: { requests: [changedPayload] } }), /online failure/u);
});

function unavailableCatalogFixture(tool = 'read') {
  // Synthetic identities with the real list -> pure resolver -> native error
  // shape. The catalog response was captured before the tool result, not read
  // from a Store or reconstructed from the expected missing object.
  const library = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', otherLibrary = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const database = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', dataSource = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const owner = 'skill://original-policy?library=' + library, scope = 'a'.repeat(64), pid = 123;
  const requestId = '11111111-1111-4111-8111-111111111111', sourceRequestId = 'sdk:' + pid + ':' + requestId;
  const files = new Map(), put = (path, value, raw = false) => {
    const bytes = Buffer.from(raw ? value : JSON.stringify(value)); files.set(path, bytes);
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  };
  const error = { error: 'context-broker source notion-a unavailable (SKILL_NOT_FOUND).',
    effects: { version: 1, remote_writes: 'unknown', author_content: 'unknown' },
    admission: { version: 1, phase: 'execute', stage: 'reference', code: 'SKILL_NOT_FOUND',
      generation_started: 3, generation_current: 3, signal_aborted: false } };
  const content = [{ type: 'text', text: tool === 'notion_use'
    ? 'context-broker source operation failed (SKILL_NOT_FOUND)' : JSON.stringify(error) }];
  const failed = put('/owned/segment/tool-results/read-a.json', content);
  const call = { id: 'read-a|fc_fixture', name: tool, arguments: tool === 'notion_use' ? { ref: owner } : { path: owner },
    event: { pid, monotonicNs: '100' }, native: { resultEntryId: 'result-a' },
    result: { pid, isError: true, monotonicNs: '200', contentArtifact: failed }, deliveryToolCallId: 'read-a|fc_fixture' };
  const payload = { input: [{ type: 'function_call', call_id: 'read-a', id: 'fc_fixture', name: tool, arguments: JSON.stringify(call.arguments) },
    { type: 'function_call_output', call_id: 'read-a', output: content[0].text }] };
  const bindings = { private: { objects: { original: { kind: 'notion', owner, scope,
    pageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } } } };
  const sourceRows = [
    { phase: 'source_observer_start', kind: 'observer', pid, monotonicNs: '1' },
    { phase: 'started', kind: 'sdk', requestId: sourceRequestId, pid, operation: 'list',
      library, source_id: 'notion-a', sourceMonotonicNs: '110', monotonicNs: '111' },
    { phase: 'attempt', event: 'attempt', kind: 'http', requestId: sourceRequestId, monotonicNs: '181',
      attempt: 1, request_kind: 'notion_metadata', method: 'POST', target: { data_source_id: dataSource }, http_status: 200, outcome: 'success' },
    { phase: 'metrics', kind: 'metrics', requestId: sourceRequestId, observed: true, complete: true,
      total_requests: 1, trace_dropped: 0, monotonicNs: '182' },
    { phase: 'completed', kind: 'sdk', requestId: sourceRequestId, pid, operation: 'list',
      library, source_id: 'notion-a', status: 'completed', sdkStarted: true, errorCode: null,
      sourceMonotonicNs: '180', monotonicNs: '183' },
    { phase: 'source_observer_end', kind: 'observer', operations: 1, sdkStarts: 1, cliStarts: 0,
      unmatchedChildren: 0, errors: 0, complete: true, pendingRequestIds: [], monotonicNs: '300' },
  ];
  const sdk = [{ phase: 'sdk-observer-start', pid },
    { phase: 'sdk-start', operation: 'list', requestId, pid, monotonic_ns: '110', at: stamp },
    { phase: 'sdk-end', operation: 'list', requestId, pid, monotonic_ns: '180', at: '2026-11-21T14:00:00.100Z',
      status: 'completed', resultObserved: true, metricsComplete: true, responseFile: requestId + '.json' },
    { phase: 'sdk-observer-end', pid, pending: 0 }];
  const receipt = { version: 2, transport: 'sdk', requestId, operation: 'list', status: 'completed',
    resultObserved: true, sdk_started: true, metrics_observed: true,
    metrics: { complete: true, total_requests: 1, trace_dropped: 0, trace: [{ event: 'attempt', attempt: 1,
      request_kind: 'notion_metadata', method: 'POST', target: { data_source_id: dataSource }, http_status: 200, outcome: 'success' }] },
    value: { scope, library_id: library, fetched_at: Date.parse('2026-11-21T14:00:00.090Z'), source: 'notion',
      freshness: { policy: 'max_age', validated_at: '2026-11-21T14:00:00.090Z', age_ms: 0, max_age_ms: 300000, stale: false },
      databases: [{ database_id: database, data_source_ids: [dataSource], role: 'content', shared_library: {
        version: 2, library_id: library, skills: { database_id: database, data_source_id: dataSource } } }],
      coverage: { method: 'explicit_library', exhaustive: true, queried_data_sources: [dataSource],
        failed_sources: [], search_index_limited: false },
      count: 1, records: [{ id: 'skill://another-policy?library=' + library, kind: 'skill',
        locator: { type: 'shared_skill', page_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          library_id: library, database_id: database, data_source_id: dataSource, skill_id: 'another-policy' } }] } };
  const observed = { visibility: { source: { sourceId: 'notion-a', library,
    additionalLibrary: { sourceId: 'notion-b', library: otherLibrary } } },
    sourceObservationWindow: { startedNs: '1', endedNs: '250', includesStartup: true },
    session: { branchEntries: [{ id: 'call-a', message: { role: 'assistant', api: 'openai-responses' } },
      { id: 'result-a', message: { role: 'toolResult', toolCallId: call.id, toolName: tool, isError: true, content, details: {} } }],
      attempts: [{ id: call.id, name: tool, arguments: call.arguments, active: true, assistantEntryId: 'call-a', resultEntryId: 'result-a', callLine: 2, resultLine: 3 }],
      contributions: [{ entryId: 'call-a', role: 'assistant' }, { entryId: 'result-a', role: 'toolResult' }],
      assistantMessages: [{ active: true, entryId: 'answer', api: 'openai-responses', line: 4 }] },
    toolHistory: { version: 1, sdkSegments: [] } };
  const options = { attempts: [call], source: [], delivery: { requests: [] }, readArtifact: async path => files.get(path) };
  const seal = () => {
    let previous = null;
    const rows = sourceRows.map((row, index) => {
      const value = { version: 1, sequence: index + 1, previousSha256: previous, clockId: 'fixture-segment', ...row };
      previous = hash(JSON.stringify(value)); return { ...value, eventSha256: previous };
    });
    options.source = rows.slice(1, -1); observed.source = options.source;
    const segment = { sdk: put('/owned/segment/sdk.jsonl', sdk.map(row => JSON.stringify(row)).join('\n') + '\n', true),
      source: put('/owned/segment/source.jsonl', rows.map(row => JSON.stringify(row)).join('\n') + '\n', true),
      responses: [{ requestId, artifact: put('/owned/segment/sdk-responses/' + requestId + '.json', receipt) }] };
    observed.toolHistory.sdkSegments = [segment];
    const wire = put('/owned/segment/payload.json', payload);
    options.delivery.requests = [{ ...wire, api: 'openai-responses', nativeResponseEntryId: 'answer' }];
    observed.tasks = [{ phase: 'provider_payload', sha256: wire.sha256, payloadFile: wire.path, monotonicNs: '210' }];
  };
  seal();
  return { observed, options, receipt, sdk, sourceRows, bindings, payload, call, seal, files, otherLibrary,
    run: () => verifyNotionAgentUnavailableReference({ kind: 'unavailable-reference', object: 'original', path: 'SKILL.md' }, observed, bindings, options) };
}

test('unavailable original reference accepts a fresh exhaustive exact-library catalog with the same native and wire not-found', async () => {
  const f = unavailableCatalogFixture(), result = await f.run();
  assert.equal(result.proofs.length, 1);
  assert.equal(result.proofs[0].evidence, 'fresh-exhaustive-catalog');
  assert.equal(result.proofs[0].owner, f.bindings.private.objects.original.owner);
  assert.equal(result.proofs[0].httpAttempts, 1);
  assert.equal(result.proofs[0].responseArtifact.sha256, f.observed.toolHistory.sdkSegments[0].responses[0].artifact.sha256);
});

test('unavailable catalog proof accepts a completely observed retry ending in a successful exact-data-source query', async () => {
  const f = unavailableCatalogFixture(), success = f.sourceRows[2];
  const failed = { ...success, outcome: 'failure', http_status: 429 };
  success.attempt = 2;
  f.sourceRows.splice(2, 0, failed);
  f.sourceRows[4].total_requests = 2;
  const trace = f.receipt.metrics.trace[0];
  f.receipt.metrics.trace = [{ ...trace, outcome: 'failure', http_status: 429 }, { ...trace, attempt: 2 }];
  f.receipt.metrics.total_requests = 2;
  f.seal();
  const proof = await f.run();
  assert.equal(proof.proofs[0].httpAttempts, 2);
  assert.equal(proof.proofs[0].evidence, 'fresh-exhaustive-catalog');
});

test('unavailable catalog proof accepts the source-derived Pi notion_use error shape without inventing a read admission', async () => {
  // SourceError.message is passed through Pi's createErrorToolResult; unlike
  // read, an early use resolver failure has no Broker admission envelope.
  const f = unavailableCatalogFixture('notion_use'), proof = await f.run();
  assert.equal(proof.proofs[0].evidence, 'fresh-exhaustive-catalog');
  assert.deepEqual(proof.proofs[0].nativeFailure, { kind: 'pi-error-message', generationObserved: false });
});

test('unavailable notion_use catalog proof rejects other native error shapes, calls and outputs', async t => {
  const replaceContent = (f, content) => {
    const bytes = Buffer.from(JSON.stringify(content)), path = f.call.result.contentArtifact.path;
    f.files.set(path, bytes); f.call.result.contentArtifact = { path, sha256: hash(bytes), bytes: bytes.length };
    f.observed.session.branchEntries[1].message.content = content;
    f.payload.input[1].output = content.map(row => row.text ?? '').join('\n');
  };
  const exact = 'context-broker source operation failed (SKILL_NOT_FOUND)';
  const cases = [
    ['Error prefix', f => replaceContent(f, [{ type: 'text', text: 'Error: ' + exact }])],
    ['stack suffix', f => replaceContent(f, [{ type: 'text', text: exact + '\n    at resolver' }])],
    ['another error code', f => replaceContent(f, [{ type: 'text', text: 'context-broker source operation failed (SOURCE_REFERENCE_MISSING)' }])],
    ['read envelope substituted for native use error', f => replaceContent(f, [{ type: 'text', text: JSON.stringify({ error: exact, admission: { code: 'SKILL_NOT_FOUND' } }) }])],
    ['multiple text blocks', f => replaceContent(f, [{ type: 'text', text: exact }, { type: 'text', text: '' }])],
    ['extra text block field', f => replaceContent(f, [{ type: 'text', text: exact, extra: true }])],
    ['nonempty native details', f => { f.observed.session.branchEntries[1].message.details = { code: 'SKILL_NOT_FOUND' }; }],
    ['missing native details', f => { delete f.observed.session.branchEntries[1].message.details; }],
    ['wrong native tool name', f => { f.observed.session.branchEntries[1].message.toolName = 'read'; }],
    ['inactive native call', f => { f.observed.session.attempts[0].active = false; }],
    ['different native arguments', f => { f.observed.session.attempts[0].arguments = { ref: 'skill://another-policy?library=' + f.otherLibrary }; }],
    ['different native result entry', f => { f.observed.session.attempts[0].resultEntryId = 'another-result'; }],
    ['multiple requested refs', f => { f.call.arguments.ref = [f.bindings.private.objects.original.owner, 'skill://another-policy?library=' + f.otherLibrary]; }],
    ['ownerless requested ref', f => { f.call.arguments.ref = 'skill://original-policy'; }],
    ['different provider output', f => { f.payload.input[1].output = 'SKILL_NOT_FOUND'; }],
    ['wrong catalog owner', f => { f.receipt.value.library_id = f.otherLibrary; }],
    ['non-exhaustive catalog', f => { f.receipt.value.coverage.exhaustive = false; }],
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    const f = unavailableCatalogFixture('notion_use'); change(f); f.seal();
    await assert.rejects(f.run(), error => error.code?.startsWith('UNAVAILABLE_'));
  });
});

test('unavailable catalog proof rejects incomplete, stale, wrong-owner and mismatched invocation evidence', async t => {
  const cases = [
    ['wrong credential scope', f => { f.receipt.value.scope = 'b'.repeat(64); }],
    ['wrong Library', f => { f.receipt.value.library_id = f.otherLibrary; }],
    ['wrong configured Source', f => { for (const row of f.sourceRows.filter(row => row.source_id)) row.source_id = 'notion-b'; }],
    ['stale catalog', f => { f.receipt.value.freshness.stale = true; }],
    ['cached catalog', f => { f.receipt.value.source = 'cache'; }],
    ['old validation time', f => { f.receipt.value.freshness.validated_at = '2026-11-20T14:00:00.090Z'; }],
    ['filtered View', f => { f.receipt.value.view = 'an-active-view'; }],
    ['limited page', f => { f.receipt.value.has_more = true; }],
    ['non-exhaustive directory', f => { f.receipt.value.coverage.exhaustive = false; }],
    ['failed data source', f => { f.receipt.value.coverage.failed_sources = ['unavailable-source']; }],
    ['count mismatch', f => { f.receipt.value.count++; }],
    ['wrong queried data source', f => { f.receipt.value.coverage.queried_data_sources = ['another-source']; }],
    ['original ID still present', f => { f.receipt.value.records[0].id = f.bindings.private.objects.original.owner; f.receipt.value.records[0].locator.skill_id = 'original-policy'; }],
    ['original page still present under another ID', f => { f.receipt.value.records[0].locator.page_id = f.bindings.private.objects.original.pageId; }],
    ['row belongs to another Library', f => { f.receipt.value.records[0].locator.library_id = f.otherLibrary; }],
    ['partial HTTP metrics', f => { f.receipt.metrics.trace_dropped = 1; }],
    ['failed HTTP attempt', f => { f.receipt.metrics.trace[0].outcome = 'failure'; f.sourceRows[2].outcome = 'failure'; }],
    ['SDK completion after tool result', f => { f.sdk[2].monotonic_ns = '201'; f.sourceRows[4].sourceMonotonicNs = '201'; }],
    ['SDK response from another invocation', f => { f.receipt.requestId = '22222222-2222-4222-8222-222222222222'; }],
    ['missing actual SDK result', f => { f.receipt.resultObserved = false; }],
    ['native and wire error differ', f => { f.payload.input[1].output = 'SKILL_NOT_FOUND: different failure'; }],
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    const f = unavailableCatalogFixture(); change(f); f.seal();
    await assert.rejects(f.run(), error => error.code?.startsWith('UNAVAILABLE_'));
  });
  for (const [name, change] of [
    ['missing observation window', f => { delete f.observed.sourceObservationWindow; }],
    ['tool outside observation window', f => { f.observed.sourceObservationWindow.endedNs = '199'; }],
    ['wire output before native result', f => { f.observed.tasks[0].monotonicNs = '199'; }],
    ['unsealed catalog response', f => { f.observed.toolHistory.sdkSegments[0].responses = []; }],
    ['changed response bytes', f => { const a = f.observed.toolHistory.sdkSegments[0].responses[0].artifact; f.files.set(a.path, Buffer.from('{}')); }],
  ]) await t.test(name, async () => {
    const f = unavailableCatalogFixture(); change(f);
    await assert.rejects(f.run(), error => error.code?.startsWith('UNAVAILABLE_') || error.code === 'ARTIFACT_CHANGED');
  });
});

test('native session keeps real tool attempts, failures and final identity', () => {
  const call = message('c', 'u', 'assistant', [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: '/owned/skill/SKILL.md' } }], { stopReason: 'toolUse' });
  const result = message('r', 'c', 'toolResult', [{ type: 'text', text: 'missing' }], { toolCallId: 't1', toolName: 'read', isError: true });
  const audit = inspect([model, user, call, result, answer('a', 'r')], { expectedUserMessages: 1 });
  assert.equal(audit.attempts.length, 1);
  assert.equal(audit.attempts[0].isError, true);
  assert.equal(audit.currentUserId, 'u');
  assert.equal(audit.assistantMessages.length, 2);
  assert.equal(audit.currentFinal.sha256, hash('合计：100 元'));
});

test('branch analysis follows observed leaf and excludes sibling context', () => {
  const entries = [model, user, answer('left', 'u', '左分支秘密'), message('right-user', 'u', 'user', '从这里重新计算'), answer('right', 'right-user', '右分支结果')];
  assert.throws(() => inspect(entries), /actually observed current leaf/u);
  const audit = inspect(entries, { leafId: 'right' });
  assert.deepEqual(audit.branchEntryIds, ['m', 'u', 'right-user', 'right']);
  assert.equal(audit.contributions.some(row => JSON.stringify(row.content).includes('左分支秘密')), false);
  assert.equal(audit.currentFinal.sha256, hash('右分支结果'));
  assert.equal(audit.userLines.length, 2);
  assert.equal(audit.finals.find(row => row.entryId === 'left').active, false);
});

test('a branch-local edit cannot target a sibling', () => {
  const entries = [model, user, answer('left'), answer('right'), entry('edit', 'right', 'context_edit', { targetId: 'left', replacement: { content: 'leak' } })];
  assert.throws(() => inspect(entries, { leafId: 'edit' }), /sibling/u);
});

test('effective context applies the latest retained edit without erasing history', () => {
  const entries = [model, user, answer(), entry('e1', 'a', 'context_edit', { targetId: 'u', replacement: { content: '第一次修改' } }),
    entry('e2', 'e1', 'context_edit', { targetId: 'u', replacement: { content: '第二次修改' } })];
  const audit = inspect(entries);
  assert.equal(audit.contributions.find(row => row.entryId === 'u').content, '第二次修改');
  assert.equal(audit.userLines[0].sha256, hash('请计算这次费用。'));
  assert.equal(audit.projections.length, 2);
});

test('compaction uses the active checkpoint, retained range and edits only', () => {
  const entries = [model, message('sys', 'm', 'system', 'old system'), message('u', 'sys', 'user', 'old request'),
    answer(), message('u2', 'a', 'user', 'retained request'), answer('a2', 'u2'),
    entry('compact', 'a2', 'compaction', { summary: '新的摘要', firstKeptEntryId: 'u2', tokensBefore: 3000,
      systemMessage: { role: 'system', content: 'checkpoint system' } }),
    message('u3', 'compact', 'user', '继续'), answer('a3', 'u3')];
  const audit = inspect(entries);
  assert.deepEqual(audit.effectiveEntryIds, ['compact', 'u2', 'a2', 'u3', 'a3']);
  assert.equal(audit.contributions.some(row => row.content === 'old system'), false);
  assert.equal(audit.contributions.some(row => row.content === 'old request'), false);
  assert.equal(audit.contributions[0].content, 'checkpoint system');
  assert.equal(audit.contributions[1].content, '新的摘要');
});

test('a newer compaction does not reintroduce an older retained summary', () => {
  const entries = [model, user, answer(), entry('c1', 'a', 'compaction', { summary: 'old summary', firstKeptEntryId: 'u', tokensBefore: 100 }),
    message('u2', 'c1', 'user', 'second'), answer('a2', 'u2'),
    entry('c2', 'a2', 'compaction', { summary: 'new summary', firstKeptEntryId: 'c1', tokensBefore: 200 }),
    message('u3', 'c2', 'user', 'third'), answer('a3', 'u3')];
  const audit = inspect(entries);
  assert.equal(audit.contributions.some(row => row.content === 'old summary'), false);
  assert.equal(audit.contributions.filter(row => row.role === 'compactionSummary').length, 1);
});

test('retracted failed proposals remain in the native attempt history', () => {
  const failed = message('c', 'u', 'assistant', [{ type: 'toolCall', id: 't1', name: 'notion_use', arguments: { ref: 'sr:1' } }], { stopReason: 'error' });
  const audit = inspect([model, user, failed, entry('e', 'c', 'context_edit', { targetId: 'c', replacement: null }), answer('a', 'e')]);
  assert.equal(audit.attempts.length, 1);
  assert.equal(audit.retractedCalls.length, 1);
  assert.equal(audit.contributions.some(row => row.entryId === 'c'), false);
});

test('forks require exact parent identity and retained bytes', () => {
  const entries = [model, user, answer()], text = jsonl(entries, { ...header, id: 'fork', parentSession: '/owned/parent.jsonl' });
  assert.throws(() => inspectNotionAgentSession(text), /bound parent/u);
  const retained = entries.map(row => JSON.stringify(row)).join('\n') + '\n';
  const fork = { parentSession: '/owned/parent.jsonl', cwd: header.cwd, sourceSessionId: header.id,
    history: { bytes: Buffer.byteLength(retained), sha256: hash(retained), entries: entries.length } };
  assert.equal(inspectNotionAgentSession(text, { fork }).sessionId, 'fork');
  assert.throws(() => inspectNotionAgentSession(text.replace('合计', '总共'), { fork }), /retained history/u);
});

test('unknown session structure and missing response completion never silently pass', () => {
  assert.throws(() => inspectNotionAgentSession(jsonl([model, user, answer()]).trimEnd()), /complete native/u);
  assert.throws(() => inspectNotionAgentSession(jsonl([model, user, answer()], { ...header, version: 2 })), /current Pi v3/u);
  assert.throws(() => inspect([model, user, entry('future', 'u', 'future_entry', {})]), /Unsupported native/u);
  assert.throws(() => inspect([model, user, answer('a', 'missing')]), /earlier entry/u);
  assert.throws(() => inspect([model, user, message('a', 'u', 'assistant', [{ type: 'text', text: 'truncated' }], { stopReason: 'length' })]), /completed turn/u);
});

test('selection capture serializes actual maps without synthesizing state', () => {
  const scope = 'a'.repeat(64), bindings = new Map([['owner', { record: { id: 'owner' }, scope }]]);
  const captured = captureNotionAgentSelection({ sessionId: 's', leafId: 'l', branchSha256: 'b'.repeat(64),
    selection: { scopes: new Map([[scope, { scope, roots: new Set(['owner']), bindings, graphs: [] }]]) },
    active: { sources: new Map([['owner', { identity: 'owner' }]]) } });
  assert.equal(captured.scopes[0].bindings[0], bindings.get('owner'));
  assert.deepEqual(captured.scopes[0].roots, ['owner']);
  assert.throws(() => captureNotionAgentSelection({ sessionId: 's', leafId: 'l', branchSha256: 'b'.repeat(64),
    selection: { scopes: [] }, active: { sources: [] } }), /actual product/u);
});

// These are deterministic verifier fixtures, not real-model acceptance results.
const oracle = candidatePayloadBodies;
function rewritePayloads(f, change) {
  for (const [index, request] of f.observed.costs.filter(row => row.phase === 'provider_request').entries()) {
    const task = f.observed.tasks.find(row => row.phase === 'provider_payload' && row.sha256 === request.payload.sha256);
    const sent = f.observed.transport.find(row => row.phase === 'request_sent' && row.id === index + 1);
    const payload = JSON.parse(f.files.get(task.payloadFile).toString('utf8'));
    change(payload, index);
    const bytes = Buffer.from(JSON.stringify(payload)), sha256 = hash(bytes), counts = oracle(payload, f.bodyFiles);
    f.files.set(task.payloadFile, bytes);
    Object.assign(task, { sha256, bytes: bytes.length, bodies: counts });
    Object.assign(request.payload, { sha256, bytes: bytes.length, verifiedBodyOccurrences: counts });
    Object.assign(sent, { requestBodySha256: sha256, requestBodyBytes: bytes.length });
  }
}
function bindReadDelivery(f, content, proofs, toolCallId = 't0') {
  const row = { phase: 'receipt', toolName: 'read', toolCallId, content: { sha256: hash(content), bytes: Buffer.byteLength(content) }, proofs };
  f.observed.tasks.push(row);
  rewritePayloads(f, (payload, index) => {
    if (index > 0) payload.messages.push({ role: 'tool', tool_call_id: toolCallId, content });
  });
  return row;
}
function fixture({ calls = [], answerText = '合计：100 元', bodies = {}, scope = 'a'.repeat(64) } = {}) {
  const files = new Map(), bodyFiles = [];
  const brokerRoot = '/owned/candidate/packages/context-broker';
  const brokerSource = { path: brokerRoot + '/src/index.ts', source: brokerRoot, scope: 'project', origin: 'package', baseDir: brokerRoot };
  const toolSource = name => ['read', 'grep', 'find', 'ls', 'tool_search', 'codemode'].includes(name)
    ? { path: name === 'tool_search' ? 'builtin:tool-search' : 'builtin:' + name, source: 'builtin' }
    : ['notion_list', 'notion_use', 'notion_ctl'].includes(name) ? { ...brokerSource } : undefined;
  const artifact = (path, value) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    files.set(path, bytes); return { path, bytes: bytes.length, sha256: hash(bytes) };
  };
  const bodyBindings = Object.fromEntries(Object.entries(bodies).map(([key, text]) => {
    const bytes = Buffer.from(text), value = { path: '/owned/private/' + key.replaceAll('/', '_'), sha256: hash(bytes), bytes: bytes.length,
      resourcePath: key.split('/').slice(1).join('/') };
    files.set(value.path, bytes); bodyFiles.push({ ...value, text }); return [key, value];
  }));
  const entries = [model, user], assistant = [];
  let parent = 'u';
  for (const [i, call] of calls.entries()) {
    const native = message('call-' + i, parent, 'assistant', [{ type: 'toolCall', id: 't' + i, name: call.name, arguments: call.arguments ?? {} }], { stopReason: 'toolUse' });
    entries.push(native); assistant.push(native.message);
    const result = message('result-' + i, native.id, 'toolResult', [{ type: 'text', text: call.result ?? 'result' }],
      { toolCallId: 't' + i, toolName: call.name, isError: call.isError === true });
    entries.push(result); parent = result.id;
  }
  const final = answer('final', parent, answerText); entries.push(final); assistant.push(final.message);
  const session = inspect(entries), costs = [], transport = [], tasks = [];
  const usage = { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, totalTokens: 16 };
  for (const [i, message] of assistant.entries()) {
    const payload = { model: 'group/worker', reasoning_effort: 'high', messages: [
      { role: 'system', content: Object.values(bodies).join('\n') }, { role: 'user', content: '请计算这次费用。' }] };
    // Real provider requests differ as conversation accumulates.
    payload.messages.push({ role: 'assistant', content: 'step ' + i });
    const bytes = Buffer.from(JSON.stringify(payload)), sha256 = hash(bytes), path = '/owned/private/payload-' + i + '.json';
    files.set(path, bytes);
    const counts = oracle(payload, bodyFiles);
    costs.push({ phase: 'provider_request', request: i + 1, provider: 'magpie', model: 'group/worker',
      payload: { sha256, bytes: bytes.length, verifiedBodyOccurrences: counts } });
    costs.push({ phase: 'message_end', request: i + 1, message: { role: 'assistant', provider: 'magpie', model: 'group/worker',
      responseModel: 'actual-worker', responseModelStatus: 'reported', stopReason: message.stopReason, usage,
      content: { sha256: hash(JSON.stringify(message.content)), bytes: Buffer.byteLength(JSON.stringify(message.content)) } } });
    transport.push({ phase: 'request_start', id: i + 1, category: 'model' },
      { phase: 'request_sent', id: i + 1, requestBodySha256: sha256, requestBodyBytes: bytes.length },
      { phase: 'request_end', id: i + 1, category: 'model', modelApi: 'openai-completions', status: 200, outcome: 'completed',
        responseEntitySha256: 'f'.repeat(64), responseEntityBytes: 60 });
    tasks.push({ phase: 'provider_payload', sha256, bytes: bytes.length, payloadFile: path, bodies: counts });
    if (i < calls.length) tasks.push({ phase: 'tool_call', toolCallId: 't' + i, toolName: calls[i].name, toolSource: calls[i].toolSource ?? toolSource(calls[i].name), inputSha256: hash(JSON.stringify(calls[i].arguments ?? {})), selectors: calls[i].arguments ?? {} },
      { phase: 'tool_result', toolCallId: 't' + i, toolName: calls[i].name, isError: calls[i].isError === true });
  }
  tasks.push({ phase: 'assistant_final', text: answerText, sha256: hash(answerText), bytes: Buffer.byteLength(answerText), stopReason: 'stop', success: true });
  const binding = { version: 1, public: {}, private: { objects: {}, bodies: bodyBindings, facts: { total: { anyOf: ['合计：100 元', '总额是100元'] } }, readbacks: {} } };
  const observed = { costs, transport, tasks, session, source: [], sourceCoverage: true,
    selection: { version: 1, sessionId: session.sessionId, leafId: session.leafId, branchSha256: session.branchSha256, scopes: [], active: [] } };
  const baseline = [
    artifact(brokerSource.path, '// Frozen fixture Broker implementation\n'),
    artifact(brokerRoot + '/package.json', { name: 'pi-context-broker', pi: { extensions: ['./src/index.ts'] } }),
  ];
  observed.implementation = { version: 1,
    candidateArtifact: artifact('/owned/evidence/started.json', { version: 1, baseline,
      sourceTuple: [{ repository: 'broker', commit: 'c'.repeat(40), dirty: false, tree_sha256: 'd'.repeat(64) }] }),
    configArtifact: artifact('/owned/evidence/config.json', { brokerRoot }) };
  observed.visibility = { nativeCommands: artifact('/owned/evidence/commands.json',
    [{ name: 'context-broker', source: 'extension', sourceInfo: brokerSource }]) };
  const run = expect => analyzeNotionAgentTurn({ id: 'test-turn', expect }, observed, binding, { inspectPayload: oracle,
    readArtifact: async path => { if (!files.has(path)) throw new Error('missing artifact ' + path); return files.get(path); } });
  const bindRemote = (alias, version, textKey, owner = 'skill-' + alias, deliver = true) => {
    const body = bodyBindings[textKey], snapshot_id = 's_' + hash(alias + version), version_id = hash(version + alias);
    binding.private.objects[alias] = { kind: 'notion', owner, scope, currentVersion: version,
      versions: { ...binding.private.objects[alias]?.versions,
        [version]: { snapshot_id, version_id, bodyKeys: Object.keys(bodyBindings).filter(key => key.startsWith(alias + '@' + version + '/')) } } };
    const selected = { record: { id: owner, entrypoint: 'SKILL.md' }, scope, snapshot_id, version_id, body_sha256: body.sha256 };
    observed.selection.scopes.push({ scope, roots: [owner], bindings: [selected],
      graphLocks: [{ purpose: 'use', roots: [owner], bindings: [selected] }] });
    if (deliver) {
      const original = files.get(body.path).toString('utf8'), prefix = 'Source ' + owner + ' ' + snapshot_id + '\n', content = prefix + original;
      tasks.push({ phase: 'receipt', customType: 'context-broker', content: { sha256: hash(content), bytes: Buffer.byteLength(content) },
        proofs: { custom: { version: 2, loaded: true, snapshotId: snapshot_id, bodySha256: body.sha256, bytes: body.bytes,
          binding: selected, delivery: { start: prefix.length, end: content.length, encoding: 'raw' } } } });
      rewritePayloads({ observed, files, bodyFiles }, payload => {
        payload.messages[0].content = payload.messages[0].content.replace(original, '');
        payload.messages.push({ role: 'user', content });
      });
    }
    return { owner, scope, snapshot_id, version_id };
  };
  return { files, entries, bodyFiles, binding, observed, run, bindRemote };
}

function deferredSourceFixture(mode = 'same-turn') {
  const f = fixture({ bodies: { 'remote@A/SKILL.md': '完整规则：票面金额 < 100 & 保留来源。' } });
  f.bindRemote('remote', 'A', 'remote@A/SKILL.md', 'exact-owner', false);
  const body = f.binding.private.bodies['remote@A/SKILL.md'], binding = f.observed.selection.scopes[0].bindings[0];
  const prefix = '<source>\n', source = prefix + f.files.get(body.path).toString('utf8')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '\n</source>';
  const content = [{ type: 'text', text: user.message.content }, { type: 'text', text: source }];
  const prompt = content.map(part => part.text).join('\n'), start = user.message.content.length + 1 + prefix.length;
  const record = { version: 2, loaded: true, snapshotId: binding.snapshot_id, bodySha256: body.sha256, bytes: body.bytes,
    binding: structuredClone(binding), delivery: { start, end: prompt.length - '\n</source>'.length, encoding: 'xml' } };
  const edit = entry('source-edit', 'u', 'context_edit', { targetId: 'u', replacement: { content } });
  const receipt = entry('source-receipt', edit.id, 'custom', { customType: 'context-broker',
    data: { nativePromptSha256: hash(prompt), records: [record] } });
  const branch = [model, user, edit, receipt];
  if (mode !== 'same-turn') {
    branch.push(answer('prior-answer', receipt.id));
    if (mode === 'compact-kept') branch.push(entry('checkpoint', 'prior-answer', 'compaction', {
      summary: '继续原始工作', firstKeptEntryId: 'u', tokensBefore: 1000 }));
    branch.push(message('next-user', branch.at(-1).id, 'user', '继续按刚才的原规则计算。'));
    if (mode === 'compact-removed') branch.push(entry('checkpoint', 'next-user', 'compaction', {
      summary: '规则全文已移出', firstKeptEntryId: 'next-user', tokensBefore: 1000 }));
  }
  const sealBranch = (entries = branch) => {
    const leafId = entries.at(-1).id, value = { sessionId: f.observed.session.sessionId, leafId, entries };
    const bytes = Buffer.from(JSON.stringify(value)), path = '/owned/evidence/request-branch.json';
    f.files.set(path, bytes);
    f.observed.tasks.find(row => row.phase === 'provider_payload').branch = {
      path, bytes: bytes.length, sha256: hash(bytes), sessionId: value.sessionId, leafId };
  };
  const setSession = (entries = [...branch, answer('final', branch.at(-1).id)]) => {
    f.observed.session = inspect(entries);
    Object.assign(f.observed.selection, { leafId: f.observed.session.leafId, branchSha256: f.observed.session.branchSha256 });
  };
  setSession(); sealBranch();
  rewritePayloads(f, payload => {
    payload.messages[0].content = '';
    payload.messages[1].content = content;
    if (mode !== 'same-turn') payload.messages.push({ role: 'user', content: '继续按刚才的原规则计算。' });
  });
  return { ...f, branch, edit, receipt, record, content, source, sealBranch, setSession,
    expectations: [{ kind: 'selection', object: 'remote', version: 'A' }, { kind: 'body', body: 'remote@A/SKILL.md', occurrences: 1 }] };
}

test('completed real-evidence shape passes facts and zero tool attempts', async () => {
  const f = fixture();
  const result = await f.run([{ kind: 'completed' }, { kind: 'output', all: ['total'] },
    { kind: 'tool-attempts', tool: 'notion_use', max: 0 }, { kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  assert.equal(result.efficiency.usage.totalTokens, 16);
});

test('unreported response models retain wire, native response and SSE completion requirements', async t => {
  const make = () => {
    const f = fixture({ calls: [{ name: 'read', arguments: { path: '/owned/data.txt' } }] });
    for (const row of f.observed.costs.filter(row => row.phase === 'message_end')) Object.assign(row.message, { responseModel: null, responseModelStatus: 'unreported' });
    for (const row of f.observed.transport.filter(row => row.phase === 'request_end')) Object.assign(row, {
      outcome: 'failure', errorName: 'AbortError', errorCode: 20, contentEncoding: 'identity', contentType: 'text/event-stream',
      sseCompletion: { method: 'bounded-sse-data-done-v1', doneEvents: 1 },
    });
    return f;
  };
  await t.test('unreported', async () => {
    const f = make();
    const before = structuredClone(f.observed.costs), result = await f.run([{ kind: 'completed' }]);
    assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
    assert.deepEqual(result.delivery.requests.map(row => row.completion), ['sse-done-before-http-cancel', 'sse-done-before-http-cancel']);
    assert.deepEqual(f.observed.costs, before, 'Do not fill responseModel from the requested model');
  });
  for (const [name, change, code] of [
    ['invalid response model', f => { f.observed.costs[1].message.responseModel = {}; }, 'APPLICATION_COMPLETION_MISSING'],
    ['missing raw status', f => { delete f.observed.costs[1].message.responseModelStatus; }, 'APPLICATION_COMPLETION_MISSING'],
    ['missing DONE', f => { f.observed.transport[2].sseCompletion.doneEvents = 0; }, 'APPLICATION_COMPLETION_MISSING'],
    ['empty response entity', f => { f.observed.transport[2].responseEntityBytes = 0; }, 'APPLICATION_COMPLETION_MISSING'],
    ['wrong native response', f => { f.observed.costs[1].message.content.sha256 = 'e'.repeat(64); }, 'NATIVE_RESPONSE_CORRELATION_MISSING'],
  ]) await t.test(name, async () => {
    const f = make(); change(f);
    const result = await f.run([{ kind: 'completed' }]);
    assert.equal(result.status, 'blocked', JSON.stringify(result.assertions));
    assert.ok(result.assertions.some(item => item.code === code), JSON.stringify(result.assertions));
  });
});

test('an unnecessary failed tool attempt fails even after a correct final answer', async () => {
  const f = fixture({ calls: [{ name: 'notion_use', arguments: { ref: 'missing' }, isError: true }] });
  const result = await f.run([{ kind: 'tool-attempts', tool: 'notion_use', max: 0 }, { kind: 'output', all: ['total'] }]);
  assert.equal(result.status, 'failed');
  assert.equal(result.efficiency.failedToolAttempts, 1);
  assert.equal(result.efficiency.usage.totalTokens, 32);
});

test('a hook-only success or missing usage stays unproved', async () => {
  const f = fixture();
  f.observed.transport = [];
  assert.equal((await f.run([{ kind: 'completed' }])).status, 'blocked');
  const g = fixture(); g.observed.costs[1].message.usage.totalTokens = null;
  const result = await g.run([{ kind: 'completed' }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(item => item.code === 'USAGE_UNKNOWN'));
});

test('native assistant responses omitted from provider evidence cannot disappear', async () => {
  const f = fixture({ calls: [{ name: 'read', arguments: { path: '/owned/data.txt' } }] });
  f.observed.costs.splice(0, 2); f.observed.transport.splice(0, 3); f.observed.tasks.splice(0, 1);
  const result = await f.run([{ kind: 'completed' }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(item => item.code === 'UNATTRIBUTED_NATIVE_RESPONSE'));
});

test('provider payload bytes are independently read and bound', async () => {
  const f = fixture();
  f.files.set('/owned/private/payload-0.json', Buffer.from('{}'));
  const result = await f.run([{ kind: 'completed' }]);
  assert.equal(result.status, 'failed');
  assert.ok(result.assertions.some(item => item.code === 'ARTIFACT_CHANGED'));
});

test('missing body metrics are not zero; full-body receipt is separately required', async () => {
  const f = fixture({ bodies: { 'remote@A/SKILL.md': 'business instructions' } });
  f.observed.tasks[0].bodies = [];
  assert.equal((await f.run([{ kind: 'body', body: 'remote@A/SKILL.md', occurrences: 0 }])).status, 'failed');
  const g = fixture({ bodies: { 'remote@A/SKILL.md': 'business instructions' } });
  g.observed.costs[0].payload.verifiedBodyOccurrences = [];
  assert.equal((await g.run([{ kind: 'body', body: 'remote@A/SKILL.md', occurrences: 1 }])).status, 'blocked');
});

test('same content from the wrong owner cannot satisfy selection', async () => {
  const f = fixture({ bodies: { 'remote@A/SKILL.md': 'same business text' } });
  f.bindRemote('remote', 'A', 'remote@A/SKILL.md');
  f.observed.selection.scopes[0].bindings[0].record.id = 'another-owner';
  const result = await f.run([{ kind: 'selection', object: 'remote', version: 'A' }]);
  assert.equal(result.status, 'failed');
  assert.ok(result.assertions.some(item => item.code === 'WRONG_SELECTION'));
});

test('actual selection requires the exact observed session branch', async () => {
  const f = fixture({ bodies: { 'remote@A/SKILL.md': 'business text' } });
  f.bindRemote('remote', 'A', 'remote@A/SKILL.md');
  f.observed.selection.branchSha256 = '0'.repeat(64);
  const result = await f.run([{ kind: 'selection', object: 'remote', version: 'A' }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(item => item.code === 'SELECTION_OBSERVATION_MISSING'));
});

test('a matching body plus actual exact selection passes without requiring Notion HTTP bytes', async () => {
  const f = fixture({ bodies: { 'remote@A/SKILL.md': 'business text' } });
  f.bindRemote('remote', 'A', 'remote@A/SKILL.md');
  const result = await f.run([{ kind: 'selection', object: 'remote', version: 'A' }, { kind: 'output', all: ['total'] }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
});

test('deferred native source receipts prove merged context after a tool turn, compaction and resume', async () => {
  for (const mode of ['same-turn', 'compact-kept', 'resume']) {
    const f = deferredSourceFixture(mode);
    // A context-hook receipt was for a standalone custom message. It does not
    // match the subsequent merged native user message and cannot be guessed.
    f.observed.tasks.push({ phase: 'receipt', customType: 'context-broker',
      content: { sha256: hash(f.source), bytes: Buffer.byteLength(f.source) },
      proofs: { custom: { ...f.record, delivery: { ...f.record.delivery, start: 9, end: 20 } } } });
    const result = await f.run(f.expectations);
    assert.equal(result.status, 'passed', mode + ': ' + JSON.stringify(result.assertions));
    const deliveries = result.delivery.requests[0].notionDeliveries;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].owner, 'exact-owner');
    assert.equal(deliveries[0].native.receiptEntryId, 'source-receipt');
    assert.equal(deliveries[0].native.contextEditEntryId, 'source-edit');
    assert.equal(deliveries[0].native.userEntryId, 'u');
    assert.equal(deliveries[0].native.branchArtifact.sha256, f.observed.tasks[0].branch.sha256);
  }
});

test('compacted or omitted native source receipts cannot prove a matching wire copy', async () => {
  const compacted = deferredSourceFixture('compact-removed');
  assert.equal((await compacted.run(compacted.expectations)).status, 'blocked');
  const omitted = deferredSourceFixture();
  omitted.branch.push(entry('omit-source', 'source-receipt', 'context_edit', { targetId: 'u', replacement: null }));
  omitted.setSession(); omitted.sealBranch();
  const result = await omitted.run(omitted.expectations);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(row => row.code === 'BODY_RECEIPT_MISSING'));
  assert.match(result.delivery.requests[0].rejectedNotionReceipts[0].reason, /no longer retained/u);
});

test('a native source receipt needs the exact prompt hash, body span and binding', async () => {
  for (const damage of ['prompt-hash', 'span', 'body-hash', 'owner', 'version']) {
    const f = deferredSourceFixture();
    if (damage === 'prompt-hash') f.receipt.data.nativePromptSha256 = '0'.repeat(64);
    if (damage === 'span') f.record.delivery.start += 1;
    if (damage === 'body-hash') f.record.bodySha256 = '0'.repeat(64);
    if (damage === 'owner') f.record.binding.record.id = 'another-owner';
    if (damage === 'version') f.record.binding.version_id = '0'.repeat(64);
    f.setSession(); f.sealBranch();
    assert.equal((await f.run(f.expectations)).status, 'blocked', damage);
  }
});

test('later user edits invalidate the old machine receipt even if wire still contains its old text', async () => {
  const f = deferredSourceFixture();
  f.branch.push(entry('replace-source', 'source-receipt', 'context_edit', { targetId: 'u', replacement: { content: '新的用户内容' } }));
  f.setSession(); f.sealBranch();
  assert.equal((await f.run(f.expectations)).status, 'blocked');
});

test('source receipt identity cannot come from a different session or sibling branch', async () => {
  for (const damage of ['session', 'sibling']) {
    const f = deferredSourceFixture();
    if (damage === 'sibling') f.sealBranch([...f.branch.slice(0, -1), { ...f.receipt, id: 'sibling-receipt' }]);
    else {
      const task = f.observed.tasks[0], snapshot = JSON.parse(f.files.get(task.branch.path));
      snapshot.sessionId = 'another-session';
      const bytes = Buffer.from(JSON.stringify(snapshot));
      f.files.set(task.branch.path, bytes); Object.assign(task.branch, { bytes: bytes.length, sha256: hash(bytes), sessionId: snapshot.sessionId });
    }
    const result = await f.run(f.expectations);
    assert.equal(result.status, 'blocked');
    assert.ok(result.assertions.some(row => row.code === 'SOURCE_RECEIPT_BRANCH_MISMATCH'), damage);
  }
});

test('a receipt only appended after the response cannot retroactively prove its request', async () => {
  const f = deferredSourceFixture();
  const later = [model, user, answer('final', 'u'), { ...f.edit, parentId: 'final' }, f.receipt];
  f.setSession(later); f.sealBranch(later);
  const result = await f.run(f.expectations);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(row => row.code === 'SOURCE_RECEIPT_FROM_FUTURE'));
});

test('a deferred receipt requires unmodified sealed branch bytes and actual wire delivery', async () => {
  const changed = deferredSourceFixture();
  changed.files.set(changed.observed.tasks[0].branch.path, Buffer.from('{}'));
  assert.equal((await changed.run(changed.expectations)).status, 'failed');
  const absent = deferredSourceFixture(); delete absent.observed.tasks[0].branch;
  assert.equal((await absent.run(absent.expectations)).status, 'blocked');
  const wire = deferredSourceFixture();
  rewritePayloads(wire, payload => { payload.messages[1].content = '原规则未投递'; });
  assert.notEqual((await wire.run(wire.expectations)).status, 'passed');
});

test('resource proof binds owner and version independently from content equality', async () => {
  const content = 'rate is 100';
  const f = fixture({ calls: [{ name: 'read', result: content }],
    bodies: { 'remote@A/SKILL.md': 'business text', 'remote@A/rates.md': content } });
  const target = f.bindRemote('remote', 'A', 'remote@A/SKILL.md'), body = f.binding.private.bodies['remote@A/rates.md'];
  const proof = { version: 2, toolCallId: 't0', loaded: false, id: 'wrong-owner', scope: target.scope,
    snapshot_id: target.snapshot_id, version_id: target.version_id, path: 'rates.md', sha256: body.sha256, bytes: body.bytes,
    delivered_complete_text: true, delivery: { start: 0, end: content.length, encoding: 'raw' } };
  bindReadDelivery(f, content, { contextBrokerResource: proof });
  assert.notEqual((await f.run([{ kind: 'resource', object: 'remote', version: 'A', path: 'rates.md' }])).status, 'passed');
  proof.id = target.owner;
  assert.equal((await f.run([{ kind: 'resource', object: 'remote', version: 'A', path: 'rates.md' }])).status, 'passed');
});

test('zero semantic writes needs complete metrics and descendant coverage', async () => {
  const f = fixture();
  f.observed.source = [{ phase: 'started', kind: 'sdk', requestId: 'r', operation: 'list' },
    { phase: 'completed', kind: 'sdk', requestId: 'r' }, { phase: 'metrics', requestId: 'r', observed: false, total_requests: null }];
  assert.equal((await f.run([{ kind: 'no-semantic-writes' }])).status, 'blocked');
  f.observed.source = [{ phase: 'attempt', request_kind: 'notion_write', method: 'PATCH' }];
  assert.equal((await f.run([{ kind: 'no-semantic-writes' }])).status, 'failed');
  f.observed.source = [{ phase: 'unmatched_child_start', childId: 'background-hook' }];
  const result = await f.run([{ kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'passed');
  const effect = result.assertions.find(row => row.kind === 'no-semantic-writes').details;
  assert.equal(effect.coverage, 'subject-tool-operations-with-complete-SDK-metrics');
  assert.deepEqual(effect.backgroundChildren, [{ childId: 'background-hook', transport: 'unknown' }]);
});

test('a shell command is not assumed read-only because its final answer says so', async () => {
  const f = fixture({ calls: [{ name: 'bash', arguments: { command: 'anything' } }] });
  f.observed.source = [{ phase: 'unmatched_child_start', childId: 'subject-shell' }];
  const result = await f.run([{ kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(item => item.code === 'TOOL_EFFECTS_UNKNOWN'));
});

test('read effects bind the actual Broker override to its frozen candidate and host registration', async () => {
  const f = fixture({ calls: [{ name: 'read', arguments: { path: '/owned/skill.md' } }] });
  const commands = JSON.parse(f.files.get(f.observed.visibility.nativeCommands.path));
  f.observed.tasks.find(row => row.phase === 'tool_call').toolSource = { ...commands[0].sourceInfo };
  const result = await f.run([{ kind: 'no-semantic-writes' }, { kind: 'source-network-attempts', max: 0 }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  const proof = result.assertions.find(row => row.kind === 'no-semantic-writes').details.implementations;
  assert.equal(proof[0].owner, 'broker');
  assert.equal(proof[0].commit, 'c'.repeat(40));
});

function ordinaryPackageFixture() {
  const f = fixture({ calls: [{ name: 'notion_list' }] });
  const save = (reference, value) => {
    const bytes = Buffer.from(JSON.stringify(value)); f.files.set(reference.path, bytes);
    Object.assign(reference, { sha256: hash(bytes), bytes: bytes.length }); return reference;
  };
  const source = '../../candidate/packages/context-broker';
  const settings = save({ path: '/owned/.pi/agent/settings.json' }, { packages: ['another-package', source] });
  const started = JSON.parse(f.files.get(f.observed.implementation.candidateArtifact.path));
  started.before = { settings }; save(f.observed.implementation.candidateArtifact, started);
  save(f.observed.implementation.configArtifact, { brokerRoot: '/owned/candidate/packages/context-broker', packageIndex: 1 });
  const commands = JSON.parse(f.files.get(f.observed.visibility.nativeCommands.path));
  Object.assign(commands[0].sourceInfo, { scope: 'user', source });
  save(f.observed.visibility.nativeCommands, commands);
  f.observed.tasks.find(row => row.phase === 'tool_call').toolSource = { ...commands[0].sourceInfo };
  const binding = { version: 1, kind: 'ordinary-pi-package-binding', settingsDirectory: '/owned/.pi/agent', settings,
    package: { index: 1, count: 2, source } };
  const artifact = save({ path: '/owned/evidence/ordinary-installation.json' }, binding);
  f.observed.implementation.ordinaryInstallationArtifact = artifact;
  return { ...f, binding, artifact, save };
}

test('ordinary relative package source resolves from frozen user settings and keeps its original spelling', async () => {
  const f = ordinaryPackageFixture();
  const result = await f.run([{ kind: 'no-semantic-writes' }, { kind: 'source-network-attempts', max: 0 }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  const proof = result.assertions.find(row => row.kind === 'no-semantic-writes').details.implementations[0];
  assert.equal(proof.path, '/owned/candidate/packages/context-broker/src/index.ts');
  assert.equal(proof.ordinaryInstallation.settingsDirectory, '/owned/.pi/agent');
  assert.equal(proof.ordinaryInstallation.packageIndex, 1);
  assert.equal(JSON.parse(f.files.get(f.observed.visibility.nativeCommands.path))[0].sourceInfo.source,
    '../../candidate/packages/context-broker');
});

test('ordinary relative package ownership retains the existing default package slot', async () => {
  const f = ordinaryPackageFixture();
  f.save(f.observed.implementation.configArtifact, { brokerRoot: '/owned/candidate/packages/context-broker' });
  const result = await f.run([{ kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  const proof = result.assertions.find(row => row.kind === 'no-semantic-writes').details.implementations[0];
  assert.equal(proof.ordinaryInstallation.packageIndex, 1);
  assert.equal(JSON.parse(f.files.get(f.observed.implementation.configArtifact.path)).packageIndex, undefined);
});

test('ordinary relative source cannot borrow another directory, slot, source, package or settings identity', async () => {
  for (const mutate of [
    f => { delete f.observed.implementation.ordinaryInstallationArtifact; },
    f => { f.binding.settingsDirectory = '/owned/candidate/packages/context-broker'; },
    f => { f.binding.settings.sha256 = '0'.repeat(64); },
    f => { f.binding.package.index = 0; },
    f => { f.binding.package.count = 1; },
    f => { f.binding.package.count = 3; },
    f => {
      f.save(f.binding.settings, { packages: ['another-package', '../../different-package'] });
      const started = JSON.parse(f.files.get(f.observed.implementation.candidateArtifact.path));
      started.before.settings = f.binding.settings; f.save(f.observed.implementation.candidateArtifact, started);
    },
    f => {
      f.save(f.binding.settings, { packages: [f.binding.package.source, { source: f.binding.package.source }] });
      const started = JSON.parse(f.files.get(f.observed.implementation.candidateArtifact.path));
      started.before.settings = f.binding.settings; f.save(f.observed.implementation.candidateArtifact, started);
    },
    f => { f.binding.package.source = '../../other/packages/context-broker'; },
    f => {
      const commands = JSON.parse(f.files.get(f.observed.visibility.nativeCommands.path));
      commands[0].sourceInfo.source = f.binding.package.source = '../../../outside/context-broker';
      f.save(f.observed.visibility.nativeCommands, commands);
      f.observed.tasks.find(row => row.phase === 'tool_call').toolSource = { ...commands[0].sourceInfo };
    },
    f => {
      const started = JSON.parse(f.files.get(f.observed.implementation.candidateArtifact.path));
      f.save(started.baseline[1], { name: 'another-package', pi: { extensions: ['./src/index.ts'] } });
      f.save(f.observed.implementation.candidateArtifact, started);
    },
  ]) {
    const f = ordinaryPackageFixture(); mutate(f); f.save(f.artifact, f.binding);
    const result = await f.run([{ kind: 'no-semantic-writes' }]);
    assert.equal(result.status, 'blocked', JSON.stringify(result.assertions));
    assert.ok(result.assertions.some(row => row.code === 'TOOL_IMPLEMENTATION_UNKNOWN'));
  }
});

test('a changed raw user settings file cannot borrow its frozen package identity', async () => {
  const f = ordinaryPackageFixture();
  f.files.set(f.binding.settings.path, Buffer.from(JSON.stringify({ packages: ['another-package', '../../different-package'] })));
  const result = await f.run([{ kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'failed');
  assert.ok(result.assertions.some(row => row.code === 'ARTIFACT_CHANGED'));
});

test('ordinary object package entries retain their explicit source and filters', async () => {
  const f = ordinaryPackageFixture();
  f.save(f.binding.settings, { packages: ['another-package', { source: f.binding.package.source, extensions: ['./src/index.ts'] }] });
  const started = JSON.parse(f.files.get(f.observed.implementation.candidateArtifact.path));
  started.before.settings = f.binding.settings; f.save(f.observed.implementation.candidateArtifact, started);
  f.save(f.artifact, f.binding);
  assert.equal((await f.run([{ kind: 'no-semantic-writes' }])).status, 'passed');
});

test('changed ordinary installation binding bytes cannot retain their proof', async () => {
  const f = ordinaryPackageFixture(); f.files.set(f.artifact.path, Buffer.from('{}'));
  const result = await f.run([{ kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'failed');
  assert.ok(result.assertions.some(row => row.code === 'ARTIFACT_CHANGED'));
});

test('a familiar read name without actual implementation provenance cannot prove zero effects', async () => {
  for (const name of ['read', 'notion_list', 'notion_use', 'tool_search']) {
    const f = fixture({ calls: [{ name }] });
    delete f.observed.tasks.find(row => row.phase === 'tool_call').toolSource;
    assert.equal((await f.run([{ kind: 'no-semantic-writes' }])).status, 'blocked', name);
  }
});

function claimedCompactReaderFixture() {
  const baseDir = '/installed/pi-compact-ui';
  const f = fixture({ calls: [{ name: 'read', arguments: { path: '/owned/SKILL.md' },
    toolSource: { path: baseDir + '/index.ts', baseDir, source: 'npm:pi-compact-ui', scope: 'user', origin: 'package' } }] });
  const event = f.observed.tasks.find(row => row.phase === 'tool_call');
  event.reviewedReadTool = true;
  // Claimed metadata is intentionally not the reviewed source bytes. These
  // negatives must exercise the analyzer's actual artifact verification.
  event.toolImplementation = { version: 1, runtimeMode: 'rpc', files: [
    ['package.json', 567, 'a5f319f04fcc0ddeb47c0da5bdd08240598404f96b38dc1fe1baaaab14428f98'],
    ['index.ts', 66369, 'bac76ae9ed99a3790d8a728cc6e9b5463927ac427a1462ffe59c6adf9e4d4509'],
  ].map(([relativePath, bytes, sha256]) => ({ relativePath, path: baseDir + '/' + relativePath,
    artifact: { path: '/owned/evidence/claimed-' + relativePath, bytes, sha256 } })) };
  return { ...f, event };
}

test('local read effects cannot borrow a reviewed flag or a partial or foreign implementation', async () => {
  for (const change of [
    event => { delete event.toolImplementation; },
    event => { event.toolImplementation.files.pop(); },
    event => { event.toolSource.source = 'npm:another-read'; },
    event => { event.toolImplementation.files[1].artifact.sha256 = '0'.repeat(64); },
  ]) {
    const f = claimedCompactReaderFixture(); change(f.event);
    const result = await f.run([{ kind: 'no-semantic-writes' }]);
    assert.equal(result.status, 'blocked', JSON.stringify(result.assertions));
    assert.ok(result.assertions.some(row => row.code === 'TOOL_IMPLEMENTATION_UNKNOWN'));
  }
});

test('an exact reviewed reader hash claim must still match the retained implementation bytes', async () => {
  const f = claimedCompactReaderFixture();
  for (const file of f.event.toolImplementation.files)
    f.files.set(file.artifact.path, Buffer.alloc(file.artifact.bytes, 'x'));
  const result = await f.run([{ kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'failed', JSON.stringify(result.assertions));
  assert.ok(result.assertions.some(row => row.code === 'ARTIFACT_CHANGED'));
});

test('missing original implementation bytes leave the local read unproved', async () => {
  const f = claimedCompactReaderFixture();
  const result = await f.run([{ kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'blocked', JSON.stringify(result.assertions));
  assert.ok(result.assertions.some(row => row.code === 'ARTIFACT_UNREADABLE'));
});

test('tool discovery binds the real hyphenated Pi builtin path and rejects same-name replacements', async () => {
  const f = fixture({ calls: [{ name: 'tool_search', arguments: { query: 'notion_ctl' } }] });
  const result = await f.run([{ kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.assertions.find(row => row.kind === 'no-semantic-writes').details.implementations,
    [{ toolCallId: 't0', owner: 'builtin', path: 'builtin:tool-search' }]);
  for (const toolSource of [
    { source: 'extension', path: 'builtin:tool-search' },
    { source: '/another/package', path: '/another/package/tool-search.js', origin: 'package' },
    { source: 'builtin', path: 'builtin:tool_search' },
  ]) {
    f.observed.tasks.find(row => row.phase === 'tool_call').toolSource = toolSource;
    const rejected = await f.run([{ kind: 'no-semantic-writes' }]);
    assert.equal(rejected.status, 'blocked');
    assert.ok(rejected.assertions.some(row => row.code === 'TOOL_EFFECTS_UNKNOWN'));
  }
});

test('the basic maintenance how-to requires both routes and preservation of an existing body', async () => {
  const corpus = JSON.parse(readFileSync(new URL('./notion-agent-scenarios.json', import.meta.url), 'utf8'));
  const scenario = corpus.scenarios.find(row => row.id === 'cold-maintenance-consultation');
  const expected = scenario.turns[0].expect.find(row => row.kind === 'output');
  const facts = corpus.fixtures[scenario.fixture].facts;
  for (const [text, status] of [
    ['从本地 SKILL.md 用 skill create 新建；已有 Notion 页面用 skill register 登记，不改写正文。', 'passed'],
    ['可以创建一个 Skill，也可以登记已有 Notion 页面并保留原正文。', 'passed'],
    ['用 skill create 新建，已有页面用 skill register 注册。注册不会替换页面正文。', 'passed'],
    ['用 skill create 新建，已有页面用 skill register 注册，页面正文保持不变。', 'passed'],
    ['用 skill create 新建，已有页面用 skill register 注册，页面正文保持原样。', 'passed'],
    ['用 skill create 新建，已有页面用 skill register 注册，保留页面正文。', 'passed'],
    ['用 skill create 新建；已有页面用 skill register 登记。如果页面已经在当前库的 **Skills 表**里，直接注册，不会覆盖正文：', 'passed'],
    ['用 skill create 或 skill register，不覆盖正文。', 'passed'],
    ['用 skill create 或 skill register，不会覆盖页面正文。', 'passed'],
    ['用 skill create 或 skill register，不覆盖原正文。', 'passed'],
    ['用 skill create 或 skill register，不会覆盖原文。', 'passed'],
    ['用 skill create 或 skill register，不覆盖页面原文。', 'passed'],
    ['用 skill create 或 skill register，保留原文。', 'passed'],
    ['用 skill create 或 skill register，保留页面原文。', 'passed'],
    ['用 skill create 或 skill register，正文保持不变。', 'passed'],
    ['用 skill create 或 skill register，原文保持原样。', 'passed'],
    ['用 skill create 或 skill register，页面原文保持不变。', 'passed'],
    ['用 skill create 或 skill register，不会改原文。', 'passed'],
    ['用 skill create 或 skill register，不改写原文。', 'passed'],
    ['用 skill create 或 skill register，不会修改原文。', 'passed'],
    ['用 skill create 或 skill register，不替换原文。', 'passed'],
    ['用 skill create 或 skill register，不会重写原文。', 'passed'],
    ['用 skill create 或 skill register，不是不会覆盖正文。', 'failed'],
    ['用 skill create 或 skill register，并非不覆盖页面正文。', 'failed'],
    ['用 skill create 或 skill register，不是不会覆盖原文。', 'failed'],
    ['用 skill create 或 skill register，并非保留页面原文。', 'failed'],
    ['用 skill create 或 skill register，不保留原文。', 'failed'],
    ['用 skill create 或 skill register，不会保留页面原文。', 'failed'],
    ['用 skill create 或 skill register，不能保留原文。', 'failed'],
    ['用 skill create 或 skill register，无法保留页面原文。', 'failed'],
    ['用 skill create 或 skill register，并非原文保持不变。', 'failed'],
    ['用 skill create 或 skill register，不是不会修改原文。', 'failed'],
    ['用 skill create 或 skill register，不会覆盖正文，但注册会覆盖正文。', 'failed'],
    ['用 skill create 或 skill register，不会覆盖页面正文，但页面正文会被覆盖。', 'failed'],
    ['用 skill create 或 skill register，不覆盖原正文，随后覆盖原正文。', 'failed'],
    ['用 skill create 或 skill register，保留原文，但注册会覆盖原文。', 'failed'],
    ['用 skill create 或 skill register，原文保持不变，但原文会被覆盖。', 'failed'],
    ['用 skill create 或 skill register，页面原文保持原样，但随后覆盖页面原文。', 'failed'],
    ['用 skill create 或 skill register，不会修改原文，但不能保留原文。', 'failed'],
    ['用 skill create 或 skill register，页面原文保持不变，但页面原文不会保持不变。', 'failed'],
    ['可以用 skill create 创建 Skill。', 'failed'],
    ['已有页面用 skill register 登记，保留原正文。', 'failed'],
    ['用 skill create 或 skill register，随后覆盖页面正文。', 'failed'],
    ['给我文件路径、Notion 链接和目标库就行。', 'failed'],
    ['用 skill create 或 skill register，但不保留页面正文。', 'failed'],
    ['用 skill create 或 skill register，但不会保留原正文。', 'failed'],
    ['用 skill create 或 skill register，但不是保留页面正文。', 'failed'],
    ['用 skill create 或 skill register，并非页面正文保持不变。', 'failed'],
    ['用 skill create 或 skill register，不是不会替换页面正文。', 'failed'],
    ...facts['existing-body-preserved'].anyOf.map(value => ['用 skill create 新建，用 skill register 注册：' + value, 'passed']),
    ...facts['body-preservation-denied'].anyOf.map(value => ['用 skill create 新建，用 skill register 注册：' + value, 'failed']),
  ]) {
    const f = fixture({ answerText: text });
    f.binding.private.facts = facts;
    const result = await f.run([expected]);
    assert.equal(result.status, status, JSON.stringify({ text, assertions: result.assertions }));
  }
});

test('business clarification accepts topical questions and material requests without imposing one sentence form', async () => {
  for (const [answerText, topics] of [
    ['把名称、用途和执行步骤发我。', ['名称', '用途']],
    ['麻烦提供发票金额。', ['金额']],
    ['请告诉我用途。', ['用途']],
    ['先告诉我用途。', ['用途']],
    ['请先提供名称。', ['名称']],
    ['首先请说明用途。', ['用途']],
    ['麻烦您接下来把名称发给我。', ['名称']],
    ['随后给我用途。', ['用途']],
    ['然后确认名称。', ['名称']],
    ['再提供用途。', ['用途']],
    ['不用改页面，请把用途发给我。', ['用途']],
    ['名称是什么？', ['名称']],
    ['名称是什么', ['名称']],
    ['使用哪个版本', ['版本']],
    ['看内容现在在哪：', ['内容']],
    ['**请提供以下信息：**\n- 名称\n- 用途', ['名称', '用途']],
    ['Can you send me the deployment region?', ['region']],
    ['Send me the desired region.', ['region']],
    ['Please provide the expected timeout.', ['timeout']],
    ['The tool requires configuration. Which version should I use?', ['version']],
    ['确认这次使用的版本。', ['版本']],
  ]) {
    const f = fixture({ answerText }); f.binding.private.facts.question = { anyOf: topics };
    const result = await f.run([{ kind: 'clarification', topic: 'question' }]);
    assert.equal(result.status, 'passed', answerText);
    const request = result.assertions.find(row => row.kind === 'clarification').details.request;
    assert.ok(request.text && request.topics.length);
  }
});

test('negation, unrelated questions and plain field descriptions cannot stand in for clarification', async () => {
  for (const [answerText, topics] of [
    ['名称用于检索。今天过得怎么样？', ['名称']],
    ['名称已经确定，几点开会？', ['名称']],
    ['名称、用途和内容是必填字段。', ['名称', '用途', '内容']],
    ['不用提供名称。', ['名称']],
    ['不需要你告诉我用途。', ['用途']],
    ['不要给我名称。', ['名称']],
    ['先不要告诉我用途。', ['用途']],
    ['请先不用提供名称。', ['名称']],
    ['首先我已经知道用途是什么。', ['用途']],
    ['首先我已经知道用途是什么', ['用途']],
    ['先告诉我天气。名称可由我拟定。', ['名称']],
    ['接下来是名称、用途和内容。', ['名称', '用途', '内容']],
    ['I do not need the target region.', ['region']],
    ['Please do not provide a timeout.', ['timeout']],
    ['The name describes what the skill does.', ['name']],
    ['我可以起草名称给你确认。', ['名称']],
    ['```text\n请提供名称。\n```', ['名称']],
    ['名称见 https://example.test/help?mode=confirm 。', ['名称']],
    ['例如：名称是什么？', ['名称']],
    ['哪个版本都可以，我先用本地。', ['版本']],
    ['我知道名称是什么。', ['名称']],
    ['我知道名称是什么', ['名称']],
    ['名称解释了如何配置。', ['名称']],
  ]) {
    const f = fixture({ answerText }); f.binding.private.facts.question = { anyOf: topics };
    const result = await f.run([{ kind: 'clarification', topic: 'question' }]);
    assert.equal(result.status, 'failed', answerText);
    assert.ok(result.assertions.some(row => row.code === 'CLARIFICATION_MISSING'));
  }
});

test('the business brief oracle accepts purpose and deliverables but not implementation setup requests', async () => {
  const corpus = JSON.parse(readFileSync(new URL('./notion-agent-scenarios.json', import.meta.url), 'utf8'));
  const facts = Object.values(corpus.fixtures).map(recipe => recipe.facts?.['description-question']).filter(Boolean);
  assert.ok(facts.length > 0);
  assert.equal(new Set(facts.map(fact => JSON.stringify(fact))).size, 1, 'business brief topics stay consistent across fixtures');
  for (const [answerText, status] of [
    ['先告诉我这个 Skill 要解决什么问题。', 'passed'],
    ['请先说明希望解决哪类业务问题。', 'passed'],
    ['首先请告诉我目的和业务目标。', 'passed'],
    ['麻烦您先提供输入材料和预期结果。', 'passed'],
    ['接下来请说明输入信息与输出结果。', 'passed'],
    ['请先把交付物的要求发我。', 'passed'],
    ['随后告诉我期望的产出。', 'passed'],
    ['请先提供 CLI 输出。', 'failed'],
    ['先给我输入目录路径。', 'failed'],
    ['目的、业务目标、输入材料、输出结果是待填字段。', 'failed'],
    ['首先不用提供预期结果。', 'failed'],
    ['我已经知道要解决什么问题。', 'failed'],
    ['业务目标已经确定，今天几点开会？', 'failed'],
    ['先告诉我天气。输出结果是模板里的字段。', 'failed'],
  ]) {
    const f = fixture({ answerText }); f.binding.private.facts.question = facts[0];
    const result = await f.run([{ kind: 'clarification', topic: 'question' }]);
    assert.equal(result.status, status, answerText);
    if (status === 'failed') assert.ok(result.assertions.some(row => row.code === 'CLARIFICATION_MISSING'));
  }
});

test('a same-name Broker replacement cannot borrow the actual candidate owner', async () => {
  const f = fixture({ calls: [{ name: 'notion_list' }] });
  f.observed.tasks.find(row => row.phase === 'tool_call').toolSource.path = '/another/package/src/index.ts';
  const result = await f.run([{ kind: 'no-semantic-writes' }, { kind: 'source-network-attempts', max: 0 }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(row => row.code === 'TOOL_IMPLEMENTATION_UNKNOWN'));
});

test('a changed frozen Broker entry cannot retain its earlier effects identity', async () => {
  const f = fixture({ calls: [{ name: 'notion_list' }] });
  const started = JSON.parse(f.files.get(f.observed.implementation.candidateArtifact.path));
  f.files.set(started.baseline[0].path, Buffer.from('// changed candidate'));
  const result = await f.run([{ kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'failed');
  assert.ok(result.assertions.some(row => row.code === 'ARTIFACT_CHANGED'));
});

test('host registration, clean candidate, and selected configuration must describe the same Broker', async () => {
  for (const [artifactKey, mutate] of [
    ['commands', value => { value[0].sourceInfo.baseDir = '/another/package'; }],
    ['candidate', value => { value.sourceTuple[0].dirty = true; }],
    ['candidate', value => { value.baseline = value.baseline.filter(row => !row.path.endsWith('/src/index.ts')); }],
    ['config', value => { value.brokerRoot = '/different/candidate'; }],
  ]) {
    const f = fixture({ calls: [{ name: 'notion_list' }] });
    const target = artifactKey === 'commands' ? f.observed.visibility.nativeCommands
      : f.observed.implementation[artifactKey === 'candidate' ? 'candidateArtifact' : 'configArtifact'];
    const value = JSON.parse(f.files.get(target.path)); mutate(value);
    const bytes = Buffer.from(JSON.stringify(value)); f.files.set(target.path, bytes);
    Object.assign(target, { sha256: hash(bytes), bytes: bytes.length });
    assert.equal((await f.run([{ kind: 'no-semantic-writes' }])).status, 'blocked');
  }
});

test('a transparent builtin container cannot excuse an untrusted same-name read child', async () => {
  const f = composedLocalFixture();
  const child = f.observed.tasks.find(row => row.phase === 'tool_call' && row.toolName === 'read');
  child.toolSource = { path: 'mcp:other/read', source: 'other', origin: 'mcp' };
  const result = await f.run([{ kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'blocked');
  assert.equal(result.efficiency.actualToolAttempts, 2);
  assert.ok(result.assertions.some(row => row.code === 'TOOL_IMPLEMENTATION_UNKNOWN'));
});

test('a frozen Broker owner does not permit mutating or unknown notion_ctl arguments', async () => {
  const f = fixture({ calls: [{ name: 'notion_ctl', arguments: { working_set: 'show', remove: 'all' } }] });
  const result = await f.run([{ kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(row => row.code === 'TOOL_EFFECTS_UNKNOWN'));
});

function interactionFixture() {
  const input = { question: '本地和 Notion 都有同名 Skill，这次使用哪个版本？', options: [{ label: '本地版' }, { label: 'Notion 版' }] };
  const text = 'No interactive UI is available. Ask the user in plain text instead.';
  const f = fixture({ calls: [{ name: 'ask_user', arguments: input, result: text }] });
  const source = '/owned/extensions/ask-user-pi', event = f.observed.tasks.find(row => row.phase === 'tool_call');
  event.toolSource = { path: source + '/src/index.ts', source, scope: 'user', origin: 'package', baseDir: source };
  const snapshot = JSON.parse(readFileSync(new URL('./fixtures/ask-user-rpc-implementation.json', import.meta.url), 'utf8'));
  event.toolImplementation = { version: 1, runtimeMode: 'rpc', files: Object.entries(snapshot.files).map(([relativePath, text]) => {
    const bytes = Buffer.from(text), artifact = { path: '/owned/evidence/implementation/' + relativePath, sha256: hash(bytes), bytes: bytes.length };
    f.files.set(artifact.path, bytes);
    return { relativePath, path: source + '/' + relativePath, artifact };
  }) };
  const terminal = f.entries.find(row => row.id === 'result-0');
  terminal.message.details = { question: input.question, options: input.options.map(option => option.label),
    answer: null, wasCustom: false, cancelled: true };
  f.observed.session = inspect(f.entries);
  const content = Buffer.from(JSON.stringify(terminal.message.content)), result = f.observed.tasks.find(row => row.phase === 'tool_result');
  result.content = { sha256: hash(content), bytes: content.length };
  result.contentArtifact = { path: '/owned/evidence/ask-result.json', ...result.content };
  f.files.set(result.contentArtifact.path, content);
  return { ...f, event, result, terminal };
}

test('a reviewed RPC interaction proves its actual no-UI return before notification', async () => {
  const f = interactionFixture();
  const result = await f.run([{ kind: 'no-semantic-writes' }, { kind: 'source-network-attempts', max: 0 },
    { kind: 'tool-attempts', tool: 'ask_user', min: 1, max: 1 }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  const effects = result.assertions.find(row => row.kind === 'no-semantic-writes').details;
  assert.deepEqual(effects.interactions.map(row => ({ toolCallId: row.toolCallId, mode: row.runtimeMode })),
    [{ toolCallId: 't0', mode: 'rpc' }]);
});

test('the same interaction name and no-UI text cannot replace implementation evidence', async () => {
  const f = interactionFixture();
  delete f.event.toolImplementation;
  const result = await f.run([{ kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(row => row.code === 'INTERACTION_IMPLEMENTATION_UNKNOWN'));
});

test('a same-name replacement package cannot inherit the reviewed effects', async () => {
  const f = interactionFixture();
  f.event.toolSource = { path: 'mcp:other/ask_user', origin: 'mcp', scope: 'user' };
  const result = await f.run([{ kind: 'no-semantic-writes' }, { kind: 'source-network-attempts', max: 0 }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(row => row.code === 'INTERACTION_IMPLEMENTATION_UNKNOWN'));
});

test('a changed implementation stays unknown even when its new artifact is correctly sealed', async () => {
  const f = interactionFixture(), file = f.event.toolImplementation.files.find(row => row.relativePath === 'src/index.ts');
  const changed = Buffer.concat([f.files.get(file.artifact.path), Buffer.from('\n// new implementation\n')]);
  f.files.set(file.artifact.path, changed);
  file.artifact = { ...file.artifact, sha256: hash(changed), bytes: changed.length };
  const result = await f.run([{ kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(row => row.code === 'INTERACTION_IMPLEMENTATION_UNKNOWN'));
});

test('missing imports and mismatched package paths cannot prove an interaction profile', async () => {
  for (const mutation of [
    f => { f.event.toolImplementation.files.pop(); },
    f => { f.event.toolImplementation.files[0].path = '/different-package/package.json'; },
    f => { f.event.toolImplementation.files[0] = f.event.toolImplementation.files[1]; },
  ]) {
    const f = interactionFixture(); mutation(f);
    assert.equal((await f.run([{ kind: 'no-semantic-writes' }])).status, 'blocked');
  }
});

test('TUI interactions are not classified as no-network even if a result claims no UI', async () => {
  const f = interactionFixture(); f.event.toolImplementation.runtimeMode = 'tui';
  const result = await f.run([{ kind: 'source-network-attempts', max: 0 }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(row => row.code === 'INTERACTION_IMPLEMENTATION_UNKNOWN'));
});

test('a completed interactive answer cannot substitute for the native no-UI early return', async () => {
  const f = interactionFixture();
  f.terminal.message.details.answer = 'Notion 版'; f.terminal.message.details.cancelled = false;
  f.observed.session = inspect(f.entries);
  const result = await f.run([{ kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(row => row.code === 'INTERACTION_RESULT_UNPROVEN'));
});

test('the no-UI return must agree with the independent tool-result bytes', async () => {
  const f = interactionFixture();
  f.files.set(f.result.contentArtifact.path, Buffer.from('[{"type":"text","text":"a different return"}]'));
  const result = await f.run([{ kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'failed');
  assert.ok(result.assertions.some(row => row.code === 'ARTIFACT_CHANGED'));
});

test('a reviewed interaction cannot hide an observed Notion write', async () => {
  const f = interactionFixture();
  f.observed.source = [{ phase: 'attempt', request_kind: 'notion_write', method: 'PATCH' }];
  assert.equal((await f.run([{ kind: 'no-semantic-writes' }])).status, 'failed');
});

test('independent business readback rejects repair and changed identity', async () => {
  const f = fixture({ bodies: { 'remote@A/SKILL.md': 'business text' } });
  const target = f.bindRemote('remote', 'A', 'remote@A/SKILL.md');
  f.binding.private.readbacks.created = { object: 'remote', version: 'A', state: 'present' };
  const raw = { status: 'passed', externalRepair: false, object: target, observed: { state: 'present' },
    assertions: [{ id: 'body-and-relations', status: 'passed' }] };
  const save = value => {
    const bytes = Buffer.from(JSON.stringify(value)), artifact = { path: '/owned/readback.json', sha256: hash(bytes), bytes: bytes.length };
    f.files.set(artifact.path, bytes); f.observed.readbacks = { created: { ...value, artifact } };
  };
  save(raw);
  assert.equal((await f.run([{ kind: 'business-readback', receipt: 'created' }])).status, 'passed');
  save({ ...raw, externalRepair: true });
  assert.equal((await f.run([{ kind: 'business-readback', receipt: 'created' }])).status, 'failed');
  save({ ...raw, assertions: [] });
  assert.equal((await f.run([{ kind: 'business-readback', receipt: 'created' }])).status, 'blocked');
});

test('business facts accept defined alternatives but forbidden facts remain hard failures', async () => {
  const f = fixture({ answerText: '总额是100元' });
  assert.equal((await f.run([{ kind: 'output', all: ['total'] }])).status, 'passed');
  f.binding.private.facts.forbidden = { anyOf: ['100元'] };
  assert.equal((await f.run([{ kind: 'output', all: ['total'], none: ['forbidden'] }])).status, 'failed');
});

test('unsupported assertions remain explicit instead of becoming empty success', async () => {
  const f = fixture(), result = await f.run([{ kind: 'invented' }]);
  assert.equal(result.status, 'blocked');
  assert.match(result.assertions[0].message, /unsupported assertion/u);
});

test('newly published body can be counted from the bound raw request after startup', async () => {
  const f = fixture({ bodies: { 'remote@B/SKILL.md': 'newly published business text' } });
  f.bindRemote('remote', 'B', 'remote@B/SKILL.md');
  f.observed.tasks[0].bodies = [];
  const result = await f.run([{ kind: 'body', body: 'remote@B/SKILL.md', occurrences: 1 }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  assert.equal(result.delivery.requests[0].bodyObservation[0].method, 'independent-raw-payload-count-only');
});

test('connected main-document inspection proves read ownership without adoption', async () => {
  const content = 'current connected maintenance guidance';
  const f = fixture({ calls: [{ name: 'read', arguments: { path: 'sr:guidance' }, result: content }],
    bodies: { 'guidance@A/SKILL.md': content } });
  const target = f.bindRemote('guidance', 'A', 'guidance@A/SKILL.md', 'skill-guidance', false), body = f.binding.private.bodies['guidance@A/SKILL.md'];
  const binding = f.observed.selection.scopes[0].bindings[0];
  f.observed.selection.scopes = [];
  const proof = { version: 3, toolCallId: 't0', binding, snapshotId: target.snapshot_id,
    bodySha256: body.sha256, bytes: body.bytes, purpose: 'inspect', delivery: { start: 0, end: content.length, encoding: 'raw' },
    rendered: { sha256: hash(content), bytes: Buffer.byteLength(content) } };
  bindReadDelivery(f, content, { contextBrokerRead: proof });
  const result = await f.run([{ kind: 'resource', object: 'guidance', version: 'A', path: 'SKILL.md' },
    { kind: 'tool-attempts', tool: 'notion_use', max: 0 }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  proof.binding = { ...binding, record: { ...binding.record, id: 'package-counterfeit' } };
  assert.notEqual((await f.run([{ kind: 'resource', object: 'guidance', version: 'A', path: 'SKILL.md' }])).status, 'passed');
});

function addMetadata(f, text, index = 0) {
  const task = f.observed.tasks.filter(row => row.phase === 'provider_payload')[index], old = task.sha256;
  const payload = JSON.parse(f.files.get(task.payloadFile));
  payload.messages.push({ role: 'user', content: text });
  const bytes = Buffer.from(JSON.stringify(payload)), sha256 = hash(bytes);
  f.files.set(task.payloadFile, bytes);
  task.sha256 = sha256; task.bytes = bytes.length;
  const request = f.observed.costs.find(row => row.phase === 'provider_request' && row.payload.sha256 === old);
  request.payload.sha256 = sha256; request.payload.bytes = bytes.length;
  const sent = f.observed.transport.find(row => row.phase === 'request_sent' && row.requestBodySha256 === old);
  sent.requestBodySha256 = sha256; sent.requestBodyBytes = bytes.length;
  return task;
}

test('native visibility proves the target path, not a positive total command count', async () => {
  const f = fixture();
  f.binding.private.objects.local = { kind: 'local', owner: 'local:/owned/skill/SKILL.md', name: 'fixture-name',
    path: '/owned/skill/SKILL.md', currentVersion: 'A', versions: { A: { bodyKeys: [] } } };
  const store = commands => {
    const bytes = Buffer.from(JSON.stringify(commands)), artifact = { path: '/owned/native-commands.json', sha256: hash(bytes), bytes: bytes.length };
    f.files.set(artifact.path, bytes); f.observed.visibility = { nativeCommands: artifact };
  };
  store([{ name: 'skill:fixture-name', source: 'skill', sourceInfo: { path: '/owned/other/SKILL.md' } }]);
  assert.equal((await f.run([{ kind: 'visibility', object: 'local', stage: 'native-discovery' }])).status, 'failed');
  store([{ name: 'skill:fixture-name', source: 'skill', sourceInfo: { path: '/owned/skill/SKILL.md' } }]);
  assert.equal((await f.run([{ kind: 'visibility', object: 'local', stage: 'native-discovery' }])).status, 'passed');
});

test('model catalog visibility binds the actual advertised ref to logical owner', async () => {
  const f = fixture({ bodies: { 'remote@A/SKILL.md': 'business text' } });
  const target = f.bindRemote('remote', 'A', 'remote@A/SKILL.md');
  f.binding.private.objects.remote.name = '远端费率';
  const ref = 'sr:CAAAAAAAAAAAAAAAAAAAAAA';
  const task = addMetadata(f, '<ntn-skills-view-catalog><catalog-cards><group kind="skill" source="notion"><card name="远端费率" location="' + ref + '">规则</card></group></catalog-cards></ntn-skills-view-catalog>');
  const selection = { ...f.observed.selection, shortRefs: [{ ref, target: { kind: 'candidate', identity: {
    source: 'notion', scope: target.scope, id: target.owner } } }] };
  f.observed.selectionSnapshots = [{ payloadSha256: task.sha256, selection }];
  assert.equal((await f.run([{ kind: 'visibility', object: 'remote', stage: 'model-catalog' }])).status, 'passed');
  selection.shortRefs[0].target.identity.id = 'same-name-other-owner';
  assert.equal((await f.run([{ kind: 'visibility', object: 'remote', stage: 'model-catalog' }])).status, 'failed');
});

function pendingSourceFixture() {
  const f = fixture({ bodies: { 'remote@A/SKILL.md': 'business text' } });
  f.bindRemote('remote', 'A', 'remote@A/SKILL.md');
  f.binding.private.objects.remote.name = 'Remote rates';
  const task = addMetadata(f, '<ntn-skills-discovery status="pending">pending</ntn-skills-discovery><ntn-skills-guidance>notion_list</ntn-skills-guidance>');
  task.monotonicNs = '200';
  const sourceId = 'notion-target', library = '01234567-89ab-cdef-0123-456789abcdef';
  const bytes = Buffer.from(JSON.stringify({ sources: [{ type: 'notion', id: sourceId, library }] })), path = '/owned/private/source-config.json';
  f.files.set(path, bytes);
  f.binding.private.fixture = { libraryId: library };
  f.observed.visibility = { source: { sourceId, library, configArtifact: { path, sha256: hash(bytes), bytes: bytes.length } } };
  f.observed.source = [{ phase: 'started', kind: 'sdk', operation: 'list', requestId: 'catalog', monotonicNs: '100', source_id: sourceId, library },
    { phase: 'completed', kind: 'sdk', operation: 'list', requestId: 'catalog', monotonicNs: '300', source_id: sourceId, library }];
  return f;
}

test('a pending view needs actual target-source timing, not just an old pending label', async () => {
  const f = pendingSourceFixture();
  f.observed.visibility.source.library = f.observed.visibility.source.library.replaceAll('-', '').toUpperCase();
  const result = await f.run([{ kind: 'visibility', object: 'remote', stage: 'source-pending' }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  f.observed.source[1].monotonicNs = '150';
  assert.equal((await f.run([{ kind: 'visibility', object: 'remote', stage: 'source-pending' }])).status, 'failed');
});

test('pending visibility cannot borrow another Source list or fabricate attribution for old diagnostics', async () => {
  for (const mutate of [
    f => { f.observed.source[0].source_id = f.observed.source[1].source_id = 'other-source'; },
    f => { f.observed.source[0].library = f.observed.source[1].library = 'another-library'; },
    f => { for (const row of f.observed.source) { delete row.source_id; delete row.library; } },
    f => { f.observed.source[0].monotonicNs = '250'; },
    f => { f.observed.source[1].source_id = 'other-source'; },
    f => { f.binding.private.fixture.libraryId = 'other-library'; },
  ]) {
    const f = pendingSourceFixture(); mutate(f);
    assert.notEqual((await f.run([{ kind: 'visibility', object: 'remote', stage: 'source-pending' }])).status, 'passed');
  }
});

test('pending visibility binds the real source configuration artifact', async () => {
  const f = pendingSourceFixture(), artifact = f.observed.visibility.source.configArtifact;
  f.files.set(artifact.path, Buffer.from('{"sources":[]}'));
  const result = await f.run([{ kind: 'visibility', object: 'remote', stage: 'source-pending' }]);
  assert.equal(result.status, 'failed');
  assert.ok(result.assertions.some(row => row.code === 'ARTIFACT_CHANGED'));
});

test('an equivalent copy is allowed only through an actually proven owner', async () => {
  const f = fixture({ bodies: { 'remote@A/SKILL.md': 'same business text', 'other@A/SKILL.md': 'same business text' } });
  f.bindRemote('remote', 'A', 'remote@A/SKILL.md');
  f.bindRemote('other', 'A', 'other@A/SKILL.md');
  f.observed.selection.scopes.splice(1, 1);
  const result = await f.run([{ kind: 'selection-any', objects: [{ object: 'remote', version: 'A' }, { object: 'other', version: 'A' }] }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  f.observed.selection.scopes[0].bindings[0].record.id = 'unrelated';
  assert.equal((await f.run([{ kind: 'selection-any', objects: [{ object: 'remote', version: 'A' }, { object: 'other', version: 'A' }] }])).status, 'failed');
});

test('a batch resource read preserves logical owner and complete source bytes', async () => {
  const source = 'rate is 100', model = { status: 'ready', files: [{ kind: 'text', path: 'rates.md', ref: 'sr:resource', content: source }] };
  const content = JSON.stringify(model);
  const f = fixture({ calls: [{ name: 'read', result: content }],
    bodies: { 'remote@A/SKILL.md': 'business text', 'remote@A/rates.md': source } });
  const target = f.bindRemote('remote', 'A', 'remote@A/SKILL.md'), body = f.binding.private.bodies['remote@A/rates.md'];
  const start = content.indexOf(JSON.stringify(source)) + 1;
  const proof = { version: 2, toolCallId: 't0', loaded: false,
    selection: { owner: target.owner, scope: target.scope, snapshot_id: target.snapshot_id, version_id: target.version_id },
    projection: { version: 1, compiler: 'context-broker/resource-read/v1', rendered: { sha256: hash(content), bytes: Buffer.byteLength(content) } },
    files: [{ index: 0, path: 'rates.md', model_ref: 'sr:resource', sha256: body.sha256, bytes: body.bytes,
      delivered_complete_text: true, state: 'source', encoding: 'utf8',
      delivery: { start, end: start + JSON.stringify(source).length - 2, encoding: 'json' } }] };
  bindReadDelivery(f, content, { contextBrokerResource: proof });
  assert.equal((await f.run([{ kind: 'resource', object: 'remote', version: 'A', path: 'rates.md' }])).status, 'passed');
  proof.selection.version_id = 'e'.repeat(64);
  assert.notEqual((await f.run([{ kind: 'resource', object: 'remote', version: 'A', path: 'rates.md' }])).status, 'passed');
});

test('forbidden package inputs count failed actual attempts and leave other operations allowed', async () => {
  const f = fixture({ calls: [{ name: 'bash', arguments: { command: 'ntn-skills ctl builtin show packaged-maintain' }, isError: true }] });
  f.binding.private.facts.package = { anyOf: ['ctl builtin show'] };
  const result = await f.run([{ kind: 'forbidden-tool-input', tool: 'bash', facts: ['package'] }]);
  assert.equal(result.status, 'failed');
  assert.ok(result.assertions.some(item => item.code === 'FORBIDDEN_TOOL_INPUT'));
  assert.equal((await f.run([{ kind: 'forbidden-tool-input', tool: 'read', facts: ['package'] }])).status, 'passed');
});

test('missing native attempt evidence cannot produce passed zero or forbidden-input assertions', async () => {
  const f = fixture(); f.observed.session = undefined;
  f.binding.private.facts.package = { anyOf: ['/owned/package/skills'] };
  const result = await f.run([{ kind: 'tool-attempts', tool: 'notion_use', max: 0 },
    { kind: 'forbidden-tool-input', tool: 'read', facts: ['package'] }]);
  for (const kind of ['tool-attempts', 'forbidden-tool-input'])
    assert.equal(result.assertions.find(row => row.kind === kind).status, 'blocked');
});

function nativeLocalFixture({ actualPath = '/owned/global/skill/SKILL.md', isError = false, deliveryRole = 'tool' } = {}) {
  const key = 'local@A/SKILL.md', text = 'Native global instructions; all author bytes.\n';
  const f = fixture({ calls: [{ name: 'read', arguments: { path: actualPath }, result: text, isError }], bodies: { [key]: text } });
  f.binding.private.objects.local = { kind: 'local', owner: 'local:/owned/global/skill/SKILL.md', path: '/owned/global/skill/SKILL.md',
    currentVersion: 'A', versions: { A: { bodyKeys: [key] } } };
  f.binding.private.bodies[key].observedPath = '/owned/global/skill/SKILL.md';
  for (const [index, request] of f.observed.costs.filter(row => row.phase === 'provider_request').entries()) {
    const task = f.observed.tasks.find(row => row.phase === 'provider_payload' && row.sha256 === request.payload.sha256);
    const sent = f.observed.transport.find(row => row.phase === 'request_sent' && row.id === index + 1);
    const payload = JSON.parse(f.files.get(task.payloadFile).toString('utf8'));
    payload.messages[0].content = '';
    if (index > 0) payload.messages.push({ role: deliveryRole, tool_call_id: 't0', content: text });
    const bytes = Buffer.from(JSON.stringify(payload)), sha256 = hash(bytes), counts = oracle(payload, f.bodyFiles);
    f.files.set(task.payloadFile, bytes);
    Object.assign(task, { sha256, bytes: bytes.length, bodies: counts });
    Object.assign(request.payload, { sha256, bytes: bytes.length, verifiedBodyOccurrences: [] });
    Object.assign(sent, { requestBodySha256: sha256, requestBodyBytes: bytes.length });
  }
  return f;
}

test('native global read proves full body through actual path and exact wire tool response without a Broker receipt', async () => {
  const f = nativeLocalFixture();
  const result = await f.run([{ kind: 'body', body: 'local@A/SKILL.md', occurrences: 1 },
    { kind: 'selection', object: 'local', version: 'A' }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  const delivery = result.assertions.find(row => row.kind === 'actual-provider-delivery').details;
  assert.equal(delivery.last.nativeReadBodies[0].path, '/owned/global/skill/SKILL.md');
  assert.notEqual(f.binding.private.bodies['local@A/SKILL.md'].path, delivery.last.nativeReadBodies[0].path);
});

for (const [reason, options] of [
  ['a different physical file', { actualPath: '/owned/private/local@A_SKILL.md' }],
  ['a failed read', { isError: true }],
  ['body text echoed by an assistant', { deliveryRole: 'assistant' }],
]) test('native local body rejects ' + reason + ' despite equal full bytes in the wire payload', async () => {
  const f = nativeLocalFixture(options);
  const result = await f.run([{ kind: 'body', body: 'local@A/SKILL.md', occurrences: 1 }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(row => row.code === 'LOCAL_BODY_DELIVERY_MISSING'));
});

test('local resources require the actual tool delivery, not an assistant echo', async () => {
  const success = nativeLocalFixture();
  assert.equal((await success.run([{ kind: 'resource', object: 'local', version: 'A', path: 'SKILL.md' }])).status, 'passed');
  const echo = nativeLocalFixture({ deliveryRole: 'assistant' });
  const result = await echo.run([{ kind: 'resource', object: 'local', version: 'A', path: 'SKILL.md' }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(row => row.code === 'LOCAL_RESOURCE_DELIVERY_MISSING'));
});

test('local resource identity accepts a normalized actual path within the exact owner', async () => {
  const f = nativeLocalFixture({ actualPath: '../global/skill/SKILL.md' });
  assert.equal((await f.run([{ kind: 'resource', object: 'local', version: 'A', path: 'SKILL.md' }])).status, 'passed');
});

function sourceOperation(attempts = []) {
  return [{ phase: 'started', kind: 'sdk', requestId: 'sdk:owned', operation: 'list' },
    ...attempts.map((attempt, index) => ({ phase: 'attempt', requestId: 'sdk:owned', attempt: index + 1,
      request_kind: 'notion_metadata', method: 'GET', ...attempt })),
    { phase: 'metrics', requestId: 'sdk:owned', observed: true, complete: true, total_requests: attempts.length },
    { phase: 'completed', kind: 'sdk', requestId: 'sdk:owned', status: attempts.some(item => item.status === 403) ? 'failed' : 'completed' }];
}

test('offline source assertion measures zero actual source attempts through complete metrics', async () => {
  const f = fixture({ calls: [{ name: 'read', arguments: { path: '/owned/package/skill/SKILL.md' } }] });
  f.observed.source = sourceOperation();
  const result = await f.run([{ kind: 'source-network-attempts', max: 0 }]);
  assert.equal(result.status, 'passed');
  assert.equal(result.assertions.find(item => item.kind === 'source-network-attempts').details.actual, 0);
});

test('content SDK call counts do not claim a known HTTP total or silently prove zero MCP calls', async () => {
  const f = fixture();
  f.observed.source = sourceOperation().map(row => row.phase === 'metrics'
    ? { ...row, observed: false, complete: false, total_requests: null }
    : { ...row, operation: 'content-search' });
  const count = await f.run([{ kind: 'source-operation-attempts', operation: 'content-search', min: 1, max: 1 }]);
  assert.equal(count.status, 'passed');
  assert.equal(count.assertions.find(row => row.kind === 'source-operation-attempts').details.actual, 1);
  assert.equal((await f.run([{ kind: 'source-operation-attempts', operation: 'content-search', max: 0 }])).status, 'failed');
  const network = await f.run([{ kind: 'source-network-attempts', max: 0 }]);
  assert.equal(network.status, 'blocked');
  assert.ok(network.assertions.some(row => row.code === 'SOURCE_MCP_METRICS_UNKNOWN'));
});

test('an authorization-failed HTTP attempt is still network access', async () => {
  const f = fixture(); f.observed.source = sourceOperation([{ status: 403 }]);
  const result = await f.run([{ kind: 'source-network-attempts', max: 0 }]);
  assert.equal(result.status, 'failed');
  assert.ok(result.assertions.some(item => item.code === 'SOURCE_NETWORK_ATTEMPTS_TOO_MANY'));
  assert.equal((await f.run([{ kind: 'source-network-attempts', min: 1, max: 1 }])).status, 'passed');
});

test('missing request metrics cannot prove offline even with an empty visible trace', async () => {
  const f = fixture(); f.observed.source = sourceOperation().filter(row => row.phase !== 'metrics');
  assert.equal((await f.run([{ kind: 'source-network-attempts', max: 0 }])).status, 'blocked');
});

test('zero observed SDK traffic cannot stand in for a CLI child of a bash tool', async () => {
  const f = fixture({ calls: [{ name: 'bash', arguments: { command: 'node /owned/cli.mjs ctl builtin read maintain' } }] });
  f.observed.source = sourceOperation();
  const result = await f.run([{ kind: 'source-network-attempts', max: 0 }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(item => item.code === 'TOOL_EFFECTS_UNKNOWN'));
});

test('complete child effects need an explicit measured network metric as well as zero semantic writes', async () => {
  const f = fixture({ calls: [{ name: 'bash', arguments: { command: 'node /owned/cli.mjs ctl builtin read maintain' } }] });
  const bind = value => {
    const bytes = Buffer.from(JSON.stringify(value)), path = '/owned/private/effects.json';
    f.files.set(path, bytes); f.observed.effects = { ...value, artifact: { path, sha256: hash(bytes), bytes: bytes.length } };
  };
  const value = { coverage: 'all-subject-notion-operations', complete: true, semanticWrites: 0, externalRepair: false };
  bind(value);
  const unknown = await f.run([{ kind: 'source-network-attempts', max: 0 }]);
  assert.equal(unknown.status, 'blocked');
  assert.ok(unknown.assertions.some(item => item.code === 'SOURCE_NETWORK_METRIC_MISSING'));
  bind({ ...value, notionHttpAttempts: 0 });
  assert.equal((await f.run([{ kind: 'source-network-attempts', max: 0 }, { kind: 'no-semantic-writes' }])).status, 'passed');
  bind({ ...value, notionHttpAttempts: 1 });
  assert.equal((await f.run([{ kind: 'source-network-attempts', max: 0 }])).status, 'failed');
});

function composedLocalFixture({ childName = 'read', retainResult = true } = {}) {
  const f = nativeLocalFixture(), childId = 'opaque-child-without-parent-prefix';
  const parent = f.entries.find(row => row.id === 'call-0').message;
  const terminal = f.entries.find(row => row.id === 'result-0').message;
  const childContent = terminal.content;
  const childArgs = childName === 'read' ? { path: '/owned/global/skill/SKILL.md' } : { path: '/owned/other', content: 'changed' };
  const parentArgs = { code: '/* The verifier must not infer effects from this script text. */' };
  Object.assign(parent.content[0], { name: 'codemode', arguments: parentArgs });
  Object.assign(terminal, { toolName: 'codemode', content: [{ type: 'text', text: JSON.stringify({ value: childContent[0].text }) }],
    nestedCalls: { complete: true, calls: [{ id: childId, name: childName, arguments: childArgs, status: 'ok' }] },
    details: { calls: [{ id: childId, name: childName, status: 'ok' }] } });
  const start = f.observed.tasks.find(row => row.phase === 'tool_call');
  Object.assign(start, { toolName: 'codemode', inputSha256: hash(JSON.stringify(parentArgs)), selectors: {},
    toolSource: { path: 'builtin:codemode', source: 'builtin' } });
  const resultIndex = f.observed.tasks.findIndex(row => row.phase === 'tool_result'), parentResult = f.observed.tasks[resultIndex];
  parentResult.toolName = 'codemode';
  const bytes = Buffer.from(JSON.stringify(childContent)), path = '/owned/private/nested-result.json';
  f.files.set(path, bytes);
  f.observed.tasks.splice(resultIndex, 0,
    { phase: 'tool_call', toolCallId: childId, toolName: childName, toolSource: { path: 'builtin:' + childName, source: 'builtin' }, inputSha256: hash(JSON.stringify(childArgs)), selectors: childArgs },
    { phase: 'tool_result', toolCallId: childId, toolName: childName, isError: false,
      ...(retainResult ? { contentArtifact: { path, sha256: hash(bytes), bytes: bytes.length } } : {}) });
  f.observed.session = inspect(f.entries);
  const observedResponse = f.observed.costs.find(row => row.phase === 'message_end');
  observedResponse.message.content = { sha256: hash(JSON.stringify(parent.content)), bytes: Buffer.byteLength(JSON.stringify(parent.content)) };
  for (const [index, request] of f.observed.costs.filter(row => row.phase === 'provider_request').entries()) {
    const task = f.observed.tasks.find(row => row.phase === 'provider_payload' && row.sha256 === request.payload.sha256);
    const sent = f.observed.transport.find(row => row.phase === 'request_sent' && row.id === index + 1);
    const payload = JSON.parse(f.files.get(task.payloadFile).toString('utf8'));
    for (const message of payload.messages.filter(row => row.role === 'tool')) message.content = terminal.content[0].text;
    const bytes = Buffer.from(JSON.stringify(payload)), sha256 = hash(bytes), counts = oracle(payload, f.bodyFiles);
    f.files.set(task.payloadFile, bytes);
    Object.assign(task, { sha256, bytes: bytes.length, bodies: counts });
    Object.assign(request.payload, { sha256, bytes: bytes.length });
    Object.assign(sent, { requestBodySha256: sha256, requestBodyBytes: bytes.length });
  }
  return f;
}

function reusedLocalFixture(f = nativeLocalFixture()) {
  const historyRows = structuredClone(f.observed.tasks.filter(row => ['tool_call', 'tool_result'].includes(row.phase)));
  for (const row of historyRows.filter(row => row.phase === 'tool_result' && !row.contentArtifact)) {
    const terminal = f.entries.find(entry => entry.message?.role === 'toolResult' && entry.message.toolCallId === row.toolCallId);
    if (!terminal) continue; // A missing nested result cannot be reconstructed from its parent text.
    const path = '/owned/private/history-result-' + row.toolCallId + '.json', bytes = Buffer.from(JSON.stringify(terminal.message.content));
    f.files.set(path, bytes); row.contentArtifact = { path, sha256: hash(bytes), bytes: bytes.length };
  }
  const sealHistory = (rows = historyRows, end = { errors: 0, complete: true }) => {
    let previous = null;
    const events = [{ phase: 'task_observer_start' }, ...rows, { phase: 'task_observer_end', ...end }].map((row, index) => {
      const value = { sequence: index + 1, previousSha256: previous, pid: 20, monotonicNs: String(index + 1), ...row };
      previous = hash(JSON.stringify(value)); return { ...value, eventSha256: previous };
    });
    const bytes = Buffer.from(events.map(row => JSON.stringify(row)).join('\n') + '\n'), path = '/owned/evidence/history-tasks.jsonl';
    f.files.set(path, bytes); f.observed.toolHistory = { version: 1, artifacts: [{ path, sha256: hash(bytes), bytes: bytes.length }] };
  };
  sealHistory();
  f.entries.push(message('next-user', 'final', 'user', '继续使用刚才的规则。'), answer('next-final', 'next-user'));
  f.observed.session = inspect(f.entries);
  Object.assign(f.observed.selection, { leafId: f.observed.session.leafId, branchSha256: f.observed.session.branchSha256 });
  f.observed.costs = f.observed.costs.slice(-2);
  for (const row of f.observed.costs) row.request = 1;
  f.observed.transport = f.observed.transport.slice(-3);
  for (const row of f.observed.transport) row.id = 1;
  f.observed.tasks = [f.observed.tasks.filter(row => row.phase === 'provider_payload').at(-1), f.observed.tasks.at(-1)];
  f.observed.tasks[0].monotonicNs = '1000';
  return { ...f, historyRows, sealHistory };
}

test('a retained native local read can be reused without inventing another current-turn attempt', async () => {
  const f = reusedLocalFixture();
  const result = await f.run([{ kind: 'body', body: 'local@A/SKILL.md', occurrences: 1 },
    { kind: 'resource', object: 'local', version: 'A', path: 'SKILL.md' }, { kind: 'selection', object: 'local', version: 'A' },
    { kind: 'tool-attempts', tool: 'read', max: 0 }, { kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  assert.equal(result.efficiency.actualToolAttempts, 0);
  const proof = result.assertions.find(row => row.kind === 'actual-provider-delivery').details.last.nativeReadBodies[0];
  assert.deepEqual(proof.toolCallIds, ['t0']);
  assert.equal(proof.provenance[0].resultEntryId, 'result-0');
  assert.equal(proof.provenance[0].history.userEntryId, 'u');
  assert.deepEqual(proof.provenance[0].history.callArtifact, f.observed.toolHistory.artifacts[0]);
});

test('a retained composed read keeps its native child lineage and original child result', async () => {
  const f = reusedLocalFixture(composedLocalFixture());
  const result = await f.run([{ kind: 'body', body: 'local@A/SKILL.md', occurrences: 1 },
    { kind: 'tool-attempts', tool: 'read', max: 0 }, { kind: 'tool-attempts', tool: 'codemode', max: 0 }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  const proof = result.assertions.find(row => row.kind === 'actual-provider-delivery').details.last.nativeReadBodies[0];
  assert.deepEqual(proof.toolCallIds, ['opaque-child-without-parent-prefix']);
  assert.deepEqual(proof.deliveryToolCallIds, ['t0']);
  assert.equal(proof.provenance[0].history.rootToolCallId, 't0');
});

for (const [reason, change, code] of [
  ['missing history', f => { delete f.observed.toolHistory; }, 'TOOL_HISTORY_MISSING'],
  ['unfinished history', f => f.sealHistory(f.historyRows, { complete: false, errors: 1 }), 'TOOL_HISTORY_INCOMPLETE'],
  ['missing callback', f => f.sealHistory(f.historyRows.filter(row => row.phase !== 'tool_result')), 'TOOL_RESULT_UNOBSERVED'],
  ['missing original body', f => { delete f.historyRows.find(row => row.phase === 'tool_result').contentArtifact; f.sealHistory(); }, 'HISTORICAL_READ_RESULT_MISSING'],
  ['changed sealed artifact', f => { const path = f.observed.toolHistory.artifacts[0].path; f.files.set(path, Buffer.from('changed\n')); }, 'ARTIFACT_CHANGED'],
  ['result completed after the payload', f => { f.observed.tasks[0].monotonicNs = '1'; }, 'HISTORICAL_READ_ORDER_UNPROVEN'],
  ['a different wire tool identity', f => rewritePayloads(f, payload => { for (const row of payload.messages.filter(row => row.role === 'tool')) row.tool_call_id = 'unrelated'; }), 'LOCAL_BODY_DELIVERY_MISSING'],
]) test('historical reuse rejects ' + reason, async () => {
  const f = reusedLocalFixture(); change(f);
  const result = await f.run([{ kind: 'body', body: 'local@A/SKILL.md', occurrences: 1 }]);
  assert.notEqual(result.status, 'passed');
  assert.ok(result.assertions.some(row => row.code === code), JSON.stringify(result.assertions));
});

test('a historical result cannot borrow identical bytes from a sibling or an omitted native entry', async () => {
  for (const omitted of [false, true]) {
    const f = reusedLocalFixture();
    const next = f.entries.find(row => row.id === 'next-user');
    if (omitted) {
      f.entries.splice(-2, 0, entry('omit-result', 'final', 'context_edit', { targetId: 'result-0', replacement: null }));
      next.parentId = 'omit-result';
    } else next.parentId = 'u';
    f.observed.session = inspect(f.entries, { leafId: 'next-final' });
    const result = await f.run([{ kind: 'body', body: 'local@A/SKILL.md', occurrences: 1 }]);
    assert.equal(result.status, 'blocked');
    assert.ok(result.assertions.some(row => row.code === (omitted ? 'HISTORICAL_READ_NOT_RETAINED' : 'LOCAL_BODY_DELIVERY_MISSING')));
  }
});

test('historical callback body bytes must match the retained native result', async () => {
  const f = reusedLocalFixture(), result = f.historyRows.find(row => row.phase === 'tool_result');
  const bytes = Buffer.from(JSON.stringify([{ type: 'text', text: 'Different original result.' }]));
  f.files.set(result.contentArtifact.path, bytes);
  Object.assign(result.contentArtifact, { sha256: hash(bytes), bytes: bytes.length }); f.sealHistory();
  const verdict = await f.run([{ kind: 'body', body: 'local@A/SKILL.md', occurrences: 1 }]);
  assert.equal(verdict.status, 'failed');
  assert.ok(verdict.assertions.some(row => row.code === 'HISTORICAL_READ_RESULT_MISMATCH'));
});

test('historical composition still requires its independently retained child body', async () => {
  const f = reusedLocalFixture(composedLocalFixture({ retainResult: false }));
  const result = await f.run([{ kind: 'body', body: 'local@A/SKILL.md', occurrences: 1 }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(row => row.code === 'HISTORICAL_READ_RESULT_MISSING'));
});

test('complete code-mode body delivery cannot certify readonly effects without sealed runtime evidence', async () => {
  const f = composedLocalFixture();
  const result = await f.run([{ kind: 'body', body: 'local@A/SKILL.md', occurrences: 1 }, { kind: 'no-semantic-writes' },
    { kind: 'source-network-attempts', max: 0 }, { kind: 'tool-attempts', tool: 'read', min: 1, max: 1 }]);
  assert.equal(result.status, 'blocked', JSON.stringify(result.assertions));
  for (const kind of ['body', 'tool-attempts'])
    assert.equal(result.assertions.find(row => row.kind === kind)?.status, 'passed', kind);
  for (const kind of ['no-semantic-writes', 'source-network-attempts']) {
    const claim = result.assertions.find(row => row.kind === kind);
    assert.equal(claim?.status, 'blocked', kind);
    assert.equal(claim.code, 'TOOL_EFFECTS_UNKNOWN', kind);
  }
  const proof = result.assertions.find(row => row.kind === 'actual-provider-delivery').details.last.nativeReadBodies[0];
  assert.deepEqual(proof.toolCallIds, ['opaque-child-without-parent-prefix']);
  assert.deepEqual(proof.deliveryToolCallIds, ['t0']);
});

test('complete code-mode structure does not excuse an executed write child', async () => {
  const f = composedLocalFixture({ childName: 'write' });
  const result = await f.run([{ kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(row => row.code === 'TOOL_EFFECTS_UNKNOWN'));
});

test('script-generated parent text cannot replace a missing child read result', async () => {
  const f = composedLocalFixture({ retainResult: false });
  const result = await f.run([{ kind: 'body', body: 'local@A/SKILL.md', occurrences: 1 }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(row => row.code === 'NESTED_READ_RESULT_MISSING'));
});

test('retracted native proposals count toward cognition guards without inventing dispatch', async () => {
  const f = fixture();
  const failed = message('failed', 'u', 'assistant', [{ type: 'toolCall', id: 'proposal', name: 'read',
    arguments: { path: 'forbidden-package-ref' } }], { stopReason: 'error' });
  const edit = entry('discard', 'failed', 'context_edit', { targetId: 'failed', replacement: null });
  f.entries.splice(2, 0, failed, edit); f.entries.at(-1).parentId = 'discard';
  f.observed.session = inspect(f.entries);
  f.binding.private.facts.package = { anyOf: ['forbidden-package-ref'] };
  const result = await f.run([{ kind: 'tool-attempts', tool: 'read', max: 0 },
    { kind: 'forbidden-tool-input', tool: 'read', facts: ['package'] }, { kind: 'no-semantic-writes' }]);
  assert.equal(result.assertions.find(row => row.kind === 'tool-attempt-observation').details.actual, 0);
  assert.equal(result.assertions.find(row => row.kind === 'tool-attempt-observation').details.retractedProposals, 1);
  assert.equal(result.assertions.find(row => row.kind === 'tool-attempts').status, 'failed');
  assert.equal(result.assertions.find(row => row.kind === 'forbidden-tool-input').status, 'failed');
  assert.equal(result.assertions.find(row => row.kind === 'no-semantic-writes').status, 'passed');
});


test('identical main text from two snapshots stays distinct while the task remains on A', async () => {
  const f = fixture({ bodies: { 'remote@A/SKILL.md': 'unchanged main bytes', 'remote@B/SKILL.md': 'unchanged main bytes' } });
  const a = f.bindRemote('remote', 'A', 'remote@A/SKILL.md');
  const b = f.bindRemote('remote', 'B', 'remote@B/SKILL.md');
  f.observed.selection.scopes.pop(); // The current task retains A; B was inspected separately.
  const expect = [{ kind: 'selection', object: 'remote', version: 'A' },
    { kind: 'resource', object: 'remote', version: 'B', path: 'SKILL.md' }];
  const complete = await f.run(expect);
  assert.equal(complete.status, 'passed', JSON.stringify(complete.assertions));
  const delivery = complete.assertions.find(row => row.kind === 'actual-provider-delivery').details.last;
  assert.equal(delivery.bodies[0].occurrences, 2);
  assert.deepEqual(new Set(delivery.notionDeliveries.map(row => row.snapshot_id)), new Set([a.snapshot_id, b.snapshot_id]));
  rewritePayloads(f, payload => { payload.messages = payload.messages.filter(message => !String(message.content).includes(a.snapshot_id)); });
  const replaced = await f.run(expect);
  assert.equal(replaced.status, 'blocked');
  assert.ok(replaced.assertions.some(row => row.code === 'SELECTED_BODY_DELIVERY_MISSING'));
  assert.equal(replaced.assertions.find(row => row.kind === 'actual-provider-delivery').details.last.bodies[0].occurrences, 1);
  assert.equal(replaced.assertions.find(row => row.kind === 'resource').status, 'passed');
});

test('an inspection binding and delivered body do not impersonate task adoption', async () => {
  const f = fixture({ bodies: { 'remote@A/SKILL.md': 'business instructions' } });
  f.bindRemote('remote', 'A', 'remote@A/SKILL.md');
  f.observed.selection.scopes[0].graphLocks[0].purpose = 'inspect';
  const result = await f.run([{ kind: 'selection', object: 'remote', version: 'A' }]);
  assert.equal(result.status, 'failed');
  assert.ok(result.assertions.some(row => row.code === 'TASK_SELECTION_MISSING'));
});

test('a resource receipt detached from its actual tool message cannot prove delivery', async () => {
  const content = 'resource bytes';
  const f = fixture({ calls: [{ name: 'read', result: content }],
    bodies: { 'remote@A/SKILL.md': 'main', 'remote@A/rates.md': content } });
  const target = f.bindRemote('remote', 'A', 'remote@A/SKILL.md'), body = f.binding.private.bodies['remote@A/rates.md'];
  const proof = { version: 2, toolCallId: 't0', loaded: false, id: target.owner, scope: target.scope,
    snapshot_id: target.snapshot_id, version_id: target.version_id, path: 'rates.md', sha256: body.sha256, bytes: body.bytes,
    delivered_complete_text: true, delivery: { start: 0, end: content.length, encoding: 'raw' } };
  bindReadDelivery(f, content, { contextBrokerResource: proof });
  rewritePayloads(f, payload => { for (const message of payload.messages.filter(message => message.role === 'tool')) message.tool_call_id = 'different-call'; });
  const result = await f.run([{ kind: 'resource', object: 'remote', version: 'A', path: 'rates.md' }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(row => row.code === 'WRONG_RESOURCE_OWNER'));
});

test('body delivery counts exclude historical creation inputs but retain raw exposure metrics', async () => {
  const key = 'native@A/SKILL.md', text = 'same complete creation and source bytes';
  const f = fixture({ bodies: { [key]: text } });
  f.bindRemote('native', 'A', key);
  rewritePayloads(f, payload => payload.messages.unshift({ role: 'tool', tool_call_id: 'historical-create-input', content: text }));
  const result = await f.run([{ kind: 'body', body: key, occurrences: 1 }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  assert.deepEqual(result.assertions.find(row => row.kind === 'body').details.counts.map(row =>
    [row.actual, row.rawOccurrences]), [[1, 2]]);
  assert.equal((await f.run([{ kind: 'body', body: key, occurrences: 1, receiptRequired: false }])).status, 'failed');
  assert.equal((await f.run([{ kind: 'body', body: key, occurrences: 0 }])).status, 'failed');
});

test('body delivery counts use exact owner and version even when main bytes are equal', async () => {
  const f = fixture({ bodies: { 'remote@A/SKILL.md': 'same main bytes', 'remote@B/SKILL.md': 'same main bytes' } });
  const a = f.bindRemote('remote', 'A', 'remote@A/SKILL.md');
  f.bindRemote('remote', 'B', 'remote@B/SKILL.md');
  const expected = [{ kind: 'body', body: 'remote@A/SKILL.md', occurrences: 1 }];
  assert.equal((await f.run(expected)).status, 'passed');
  rewritePayloads(f, payload => { payload.messages = payload.messages.filter(message => !String(message.content).includes(a.snapshot_id)); });
  const replaced = await f.run(expected);
  assert.equal(replaced.status, 'blocked');
  assert.equal(replaced.assertions.find(row => row.kind === 'body').details.actual, 0);
  assert.equal(replaced.assertions.find(row => row.kind === 'body').details.rawOccurrences, 1);
});

test('two actual deliveries of the same logical file remain a duplicate', async () => {
  const f = fixture({ bodies: { 'remote@A/SKILL.md': 'complete main bytes' } });
  f.bindRemote('remote', 'A', 'remote@A/SKILL.md');
  rewritePayloads(f, payload => payload.messages.push({ ...payload.messages.at(-1) }));
  const result = await f.run([{ kind: 'body', body: 'remote@A/SKILL.md', occurrences: 1 }]);
  assert.equal(result.status, 'failed');
  assert.equal(result.assertions.find(row => row.kind === 'body').details.actual, 2);
});

function attachCandidateCli(f, { actualPath, startNs = '150', endNs = '160', argv } = {}) {
  const save = (path, value) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    f.files.set(path, bytes); return { path, realpath: path, sha256: hash(bytes), bytes: bytes.length };
  };
  const embedded = save('/owned/candidate/packages/context-broker/dist/ntn-skills.mjs', 'frozen executable bytes');
  const standalone = save('/owned/cli/packages/cli/dist/ntn-skills.js', 'frozen executable bytes');
  const candidatePath = f.observed.implementation.candidateArtifact.path;
  const candidate = JSON.parse(f.files.get(candidatePath));
  candidate.baseline.push(embedded); candidate.cliFiles = [standalone];
  candidate.sourceTuple.push({ repository: 'cli', commit: 'e'.repeat(40), dirty: false, tree_sha256: 'f'.repeat(64) });
  f.observed.implementation.candidateArtifact = save(candidatePath, candidate);
  const configPath = f.observed.implementation.configArtifact.path;
  f.observed.implementation.configArtifact = save(configPath, {
    ...JSON.parse(f.files.get(configPath)), cliRoot: '/owned/cli/packages/cli',
  });
  const chain = rows => {
    let previous = null;
    return rows.map((row, index) => {
      const event = { version: 1, sequence: index + 1, previousSha256: previous, clockId: 'clock-actual', ...row };
      event.eventSha256 = hash(JSON.stringify(event)); previous = event.eventSha256;
      return JSON.stringify(event);
    }).join('\n') + '\n';
  };
  const source = save('/owned/evidence/source.jsonl', chain([
    { phase: 'source_observer_start', kind: 'observer', pid: 100, monotonicNs: '1', unmatchedChildLifecycleVersion: 1 },
    { phase: 'source_observer_end', kind: 'observer', monotonicNs: '400', complete: true, errors: 0,
      operations: 0, sdkStarts: 0, cliStarts: 0, unmatchedChildren: 0, unmatchedChildCloses: 0,
      pendingChildIds: [], pendingRequestIds: [] },
  ]));
  const process = (id, parent, owner, entry, start, end) => {
    const base = { processId: id + '-actual', pid: id, parentPid: parent, owner, node: '24.20.0',
      entryMode: 'file', entry, cli: owner ? null : { basis: 'entry-name' } };
    return save('/owned/evidence/process-' + id + '.jsonl', chain([
      { ...base, phase: 'process_start', monotonicNs: start,
        ...(owner || argv === undefined ? {} : { invocation: { version: 1, argvSha256: hash(JSON.stringify(argv)),
          arguments: argv.map(value => ({ sha256: hash(value), option: value.startsWith('-'), inline: null })) } }) },
      { ...base, phase: 'process_end', monotonicNs: end, exitCode: 0 },
    ]));
  };
  const entry = actualPath ? { ...standalone, path: actualPath, realpath: actualPath } : standalone;
  f.observed.cliProcesses = { version: 1, sourceArtifact: source, window: { startNs: '100', endNs: '200' },
    artifacts: [process(100, 99, true, embedded, '1', '400'), process(101, 100, false, entry, startNs, endNs)] };
  return f.observed.cliProcesses;
}

test('a claimed CLI success without independently sealed process evidence stays blocked', async () => {
  const f = fixture();
  f.observed.cliProcesses = { status: 'passed', cliCount: 99, matchedCliCount: 99 };
  const result = await f.run([{ kind: 'candidate-cli', min: 1 }]);
  assert.equal(result.status, 'blocked');
  assert.ok(result.assertions.some(row => row.code === 'CLI_PROCESS_OBSERVATION_MISSING'));
});

test('a real-shaped paired CLI identity is checked against the frozen candidate and exact turn', async () => {
  const f = fixture();
  attachCandidateCli(f);
  const result = await f.run([{ kind: 'candidate-cli', min: 1 }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  assert.equal(result.assertions.find(row => row.kind === 'candidate-cli').details.actual, 1);
  f.observed.cliProcesses.window = { startNs: '200', endNs: '300' };
  const outside = await f.run([{ kind: 'candidate-cli', min: 1 }]);
  assert.equal(outside.status, 'blocked');
  assert.ok(outside.assertions.some(row => row.code === 'CLI_CANDIDATE_EXECUTION_MISSING'));
});

test('the restore assertion consumes sealed process arguments rather than a claimed command count', async () => {
  const f = fixture();
  attachCandidateCli(f, { argv: ['ctl', 'library', 'projection', 'target', '--restore', '--library', 'library'] });
  const result = await f.run([{ kind: 'single-projection-restore' }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  assert.equal(result.assertions.find(row => row.kind === 'single-projection-restore').details.restoreInvocations, 1);
  const old = fixture(); attachCandidateCli(old);
  const missing = await old.run([{ kind: 'single-projection-restore' }]);
  assert.equal(missing.status, 'blocked');
  assert.ok(missing.assertions.some(row => row.code === 'CLI_COMMAND_EFFECTS_UNKNOWN'));
});

test('an unexpected CLI anywhere in the process segment fails even outside the current prompt', async () => {
  const f = fixture();
  attachCandidateCli(f, { actualPath: '/unselected/ntn-skills.js', startNs: '50', endNs: '60' });
  const result = await f.run([{ kind: 'completed' }]);
  assert.equal(result.status, 'failed');
  assert.ok(result.assertions.some(row => row.code === 'CLI_CANDIDATE_MISMATCH'));
});

test('CLI process or parent artifact tampering cannot retain an earlier candidate identity', async () => {
  for (const parent of [false, true]) {
    const f = fixture(), observed = attachCandidateCli(f);
    const artifact = parent ? observed.sourceArtifact : observed.artifacts[1];
    f.files.set(artifact.path, Buffer.concat([f.files.get(artifact.path), Buffer.from(' ') ]));
    const result = await f.run([{ kind: 'candidate-cli', min: 1 }]);
    assert.equal(result.status, 'failed');
    assert.ok(result.assertions.some(row => row.code === 'ARTIFACT_CHANGED'));
  }
});

function asResponses(f) {
  const originalSession = f.observed.session;
  const activeReplies = originalSession.assistantMessages.filter(row => row.active && row.userEntryId === originalSession.currentUserId);
  const ids = new Map();
  for (const row of f.entries) for (const part of row.message?.content ?? []) {
    if (part?.type === 'toolCall') { ids.set(part.id, part.id + '|fc_' + part.id); part.id = ids.get(part.id); }
  }
  for (const row of f.entries) {
    if (row.message?.role === 'toolResult') row.message.toolCallId = ids.get(row.message.toolCallId) ?? row.message.toolCallId;
    if (row.message?.role === 'assistant') Object.assign(row.message, {
      api: 'openai-responses', responseId: 'resp_' + row.id, rawStopReason: 'completed',
      usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, totalTokens: 16, reasoning: 2 },
    });
  }
  for (const row of [...f.observed.tasks, ...(f.historyRows ?? [])]) {
    if (ids.has(row.toolCallId)) row.toolCallId = ids.get(row.toolCallId);
    for (const proof of Object.values(row.proofs ?? {}))
      if (proof && typeof proof === 'object' && ids.has(proof.toolCallId)) proof.toolCallId = ids.get(proof.toolCallId);
  }
  if (f.historyRows) f.sealHistory();
  f.observed.session = inspect(f.entries);
  Object.assign(f.observed.selection, { leafId: f.observed.session.leafId, branchSha256: f.observed.session.branchSha256 });
  const calls = new Map(f.observed.session.attempts.map(call => [call.id, call]));
  rewritePayloads(f, payload => {
    const input = [];
    for (const message of payload.messages) {
      if (message.role === 'tool') {
        const nativeId = ids.get(message.tool_call_id) ?? message.tool_call_id, call = calls.get(nativeId);
        assert.ok(call, 'Controlled Responses fixture needs its actual native call');
        const [callId, id] = nativeId.split('|');
        input.push({ type: 'function_call', id, call_id: callId, name: call.name, arguments: JSON.stringify(call.arguments) },
          { type: 'function_call_output', call_id: callId, output: message.content });
      } else {
        input.push({ type: 'message', role: message.role === 'system' ? 'developer' : message.role,
          content: typeof message.content === 'string'
            ? [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }] : message.content });
      }
    }
    delete payload.messages; delete payload.reasoning_effort;
    Object.assign(payload, { input, stream: true, reasoning: { effort: 'high' } });
  });
  const requests = f.observed.costs.filter(row => row.phase === 'provider_request');
  for (const [index, request] of requests.entries()) {
    request.api = 'openai-responses';
    const native = f.entries.find(row => row.id === activeReplies[index].entryId).message;
    const cost = f.observed.costs.find(row => row.phase === 'message_end' && row.request === request.request).message;
    Object.assign(cost, { api: native.api, responseId: native.responseId, rawStopReason: native.rawStopReason, usage: { ...native.usage },
      content: { sha256: hash(JSON.stringify(native.content)), bytes: Buffer.byteLength(JSON.stringify(native.content)) } });
    const end = f.observed.transport.find(row => row.phase === 'request_end' && row.id === index + 1);
    Object.assign(end, { modelApi: 'openai-responses', contentType: 'text/event-stream', contentEncoding: 'identity',
      sseCompletion: { method: 'bounded-openai-responses-sse-v1', complete: true, terminalEvents: 1, doneEvents: 0,
        response: { id: native.responseId, model: 'actual-worker', status: 'completed',
          usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16,
            input_tokens_details: { cached_tokens: 1, cache_write_tokens: null },
            output_tokens_details: { reasoning_tokens: 2 }, optional_fields_valid: true } } } });
  }
  return f;
}

test('Responses analysis binds native response ID and usage to the exact wire completion and nested effort', async () => {
  const f = asResponses(fixture());
  const result = await f.run([{ kind: 'completed' }, { kind: 'output', all: ['total'] }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  assert.equal(result.delivery.requests.at(-1).api, 'openai-responses');
  assert.equal(result.delivery.requests.at(-1).completion, 'responses-completed');
});

test('Responses analysis preserves remote source spans and input_text body identity', async () => {
  const f = fixture({ bodies: { 'remote@A/SKILL.md': '完整规则\r\n必须保留全部正文。' } });
  f.bindRemote('remote', 'A', 'remote@A/SKILL.md');
  asResponses(f);
  const result = await f.run([{ kind: 'body', body: 'remote@A/SKILL.md', occurrences: 1 },
    { kind: 'selection', object: 'remote', version: 'A' }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  assert.equal(result.delivery.requests.at(-1).notionDeliveries[0].owner, 'skill-remote');
});

test('Responses analysis maps complete function-call identity to a local body and retained history', async () => {
  for (const historical of [false, true]) {
    const f = asResponses(historical ? reusedLocalFixture() : nativeLocalFixture());
    const result = await f.run([{ kind: 'body', body: 'local@A/SKILL.md', occurrences: 1 },
      { kind: 'tool-attempts', tool: 'read', max: historical ? 0 : 1 }]);
    assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
    assert.deepEqual(result.delivery.requests.at(-1).nativeReadBodies[0].deliveryToolCallIds, ['t0|fc_t0']);
    assert.equal(result.efficiency.actualToolAttempts, historical ? 0 : 1);
  }
});

test('Responses analysis rejects unmatched native identity, usage, effort and body call ownership', async () => {
  for (const [name, change] of [
    ['terminal absent', f => { delete f.observed.transport.find(row => row.phase === 'request_end').sseCompletion; }],
    ['native ID', f => { f.observed.session.assistantMessages[0].responseId = 'resp_elsewhere'; }],
    ['native usage', f => { f.observed.session.assistantMessages[0].usage.output++; }],
    ['wrong effort', f => rewritePayloads(f, payload => { payload.reasoning.effort = 'low'; })],
  ]) {
    const f = asResponses(fixture()); change(f);
    const result = await f.run([{ kind: 'completed' }]);
    assert.notEqual(result.status, 'passed', name);
  }
  for (const [name, change] of [
    ['different full item identity', item => { item.id = 'fc_other'; }],
    ['same prefix with different name', item => { item.name = 'write'; }],
    ['changed original arguments', item => { item.arguments = '{"path":"/different/SKILL.md"}'; }],
  ]) {
    const f = asResponses(nativeLocalFixture());
    rewritePayloads(f, payload => { for (const item of payload.input.filter(row => row.type === 'function_call')) change(item); });
    const result = await f.run([{ kind: 'body', body: 'local@A/SKILL.md', occurrences: 1 }]);
    assert.notEqual(result.status, 'passed', name);
    assert.ok(result.assertions.some(row => row.code === 'RESPONSES_TOOL_IDENTITY_UNPROVEN'), JSON.stringify(result.assertions));
  }
});

test('Responses analysis cannot borrow a native call that happened after this request', async () => {
  const f = asResponses(nativeLocalFixture());
  let replay;
  for (const row of f.observed.tasks.filter(row => row.phase === 'provider_payload')) {
    const payload = JSON.parse(f.files.get(row.payloadFile));
    if (payload.input.some(item => item.type === 'function_call')) replay = payload.input.filter(item => item.type.startsWith('function_call'));
  }
  rewritePayloads(f, (payload, index) => { if (index === 0) payload.input.push(...replay); });
  const result = await f.run([{ kind: 'completed' }]);
  assert.notEqual(result.status, 'passed');
  assert.ok(result.assertions.some(row => row.code === 'RESPONSES_TOOL_IDENTITY_UNPROVEN'), JSON.stringify(result.assertions));
});

function nestedResourceProofFixture() {
  const files = new Map(), pid = 20, library = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const owner = 'skill://synthetic-travel?library=' + library, snapshot = 's_' + 'b'.repeat(64);
  const body = 'Lodging is capped at 70.\n', resourceRef = 'sr:R' + 'B'.repeat(22), selectedRef = 'sr:S' + 'A'.repeat(22);
  const fileRef = owner.replace('?library=', '/rates.md?library=') + '&snapshot=' + snapshot;
  const put = (path, value, json = true) => {
    const bytes = Buffer.from(json ? JSON.stringify(value) : value); files.set(path, bytes);
    return { path, sha256: hash(bytes), bytes: bytes.length };
  };
  const brokerOwner = { source: { path: '/owned/broker/src/index.ts', source: '/owned/broker',
    baseDir: '/owned/broker', origin: 'package', scope: 'project' }, commit: 'c'.repeat(40), entrySha256: 'd'.repeat(64) };
  const selected = { kind: 'selected', identity: { source: 'notion', kind: 'skill', id: owner, scope: 'a'.repeat(64),
    locator: { type: 'shared_skill', library_id: library, page_id: 'fixture-page', database_id: 'fixture-db', data_source_id: 'fixture-ds' } },
    snapshot_id: snapshot, version_id: 'c'.repeat(64), body_sha256: hash('main'), entrypoint: 'SKILL.md',
    ref: owner.replace('?library=', '/SKILL.md?library=') + '&snapshot=' + snapshot };
  const resource = { kind: 'resource', owner: selectedRef, path: 'rates.md', ref: fileRef,
    file_id: 'file-' + hash('fixture-file'), sha256: hash(body), bytes: Buffer.byteLength(body) };
  const childContent = [{ type: 'text', text: body }], parentContent = [{ type: 'text', text: 'Actual child output:\n' + body }];
  const makeCall = (id, name, args, from, to, content) => {
    const artifact = put('/owned/segment/tool-results/' + id + '.json', content);
    return { id, name, arguments: args, native: { isError: false, assistantEntryId: 'native-call', resultEntryId: 'native-result' },
      event: { toolCallId: id, toolName: name, inputSha256: hash(JSON.stringify(args)), pid, monotonicNs: from },
      result: { pid, monotonicNs: to, isError: false, contentArtifact: artifact, content: { sha256: artifact.sha256, bytes: artifact.bytes } } };
  };
  const parent = makeCall('outer', 'codemode', { code: 'text(await tools.read({path:"' + resourceRef + '"}))' }, '50', '250', parentContent);
  parent.container = { complete: true };
  const call = makeCall('child', 'read', { path: resourceRef }, '100', '200', childContent);
  Object.assign(call, { parentToolCallId: parent.id, rootToolCallId: parent.id, provenance: { kind: 'native-nested-summary' } });
  call.event.toolSource = { ...brokerOwner.source };
  // As in the pure lineage tests, runtimeEvidence represents the output of the
  // separately tested sealed-byte verifier; these are synthetic observations.
  const runtimeEvidence = new Map();
  for (const item of [call, parent]) {
    const packageRoot = '/maintained/pi';
    item.event.toolRuntime = { version: 1, packageRoot, entry: packageRoot + '/dist/bundle/cli.js',
      files: Object.entries(reviewedPiToolRuntimeProfile.files).map(([relativePath, file]) => ({
        relativePath, path: packageRoot + '/' + relativePath, artifact: { path: '/sealed/' + file.sha256, ...file } })) };
    runtimeEvidence.set(item.id, { implementation: inspectedPiToolRuntime(item.event.toolRuntime),
      toolCallId: item.id, toolName: item.name, inputSha256: item.event.inputSha256, pid });
  }
  const branch = [
    entry('selected', null, 'custom', { customType: 'context-broker-short-ref', data: { version: 1, ref: selectedRef, target: selected } }),
    entry('resource', 'selected', 'custom', { customType: 'context-broker-short-ref', data: { version: 1, ref: resourceRef, target: resource } }),
    message('native-call', 'resource', 'assistant', []),
    message('native-result', 'native-call', 'toolResult', parentContent, { toolCallId: parent.id }),
  ];
  const sdk = [{ phase: 'sdk-observer-start', pid },
    { phase: 'sdk-start', operation: 'read', requestId: 'read-1', pid, monotonic_ns: '120' },
    { phase: 'sdk-end', operation: 'read', requestId: 'read-1', pid, monotonic_ns: '140',
      status: 'completed', resultObserved: true, responseFile: 'read-1.json' },
    { phase: 'sdk-observer-end', pid, pending: 0 }];
  const sourceRows = [{ phase: 'source_observer_start', kind: 'observer', pid, monotonicNs: '1' },
    { phase: 'started', kind: 'sdk', requestId: 'sdk:20:read-1', pid, operation: 'read',
      library, source_id: 'notion-fixture', sourceMonotonicNs: '120', monotonicNs: '121' },
    { phase: 'metrics', kind: 'metrics', requestId: 'sdk:20:read-1', observed: true, complete: true,
      total_requests: 0, trace_dropped: 0, monotonicNs: '141' },
    { phase: 'completed', kind: 'sdk', requestId: 'sdk:20:read-1', pid, operation: 'read', status: 'completed',
      library, source_id: 'notion-fixture', sourceMonotonicNs: '140', monotonicNs: '142' },
    { phase: 'source_observer_end', kind: 'observer', operations: 1, sdkStarts: 1, cliStarts: 0,
      unmatchedChildren: 0, errors: 0, complete: true, pendingRequestIds: [], monotonicNs: '300' }];
  const receipt = { version: 2, transport: 'sdk', operation: 'read', requestId: 'read-1', status: 'completed', resultObserved: true,
    value: { record: { id: owner, locator: selected.identity.locator }, scope: selected.identity.scope,
      snapshot_id: snapshot, version_id: selected.version_id, entrypoint_sha256: selected.body_sha256,
      entrypoint: selected.entrypoint, path: resource.path, ref: fileRef, sha256: resource.sha256, bytes: resource.bytes,
      freshness: { policy: 'pinned' }, file_bindings: [{ path: resource.path, file_id: resource.file_id, page_id: 'fixture-file-page' }],
      output: '/owned/cache/observed-output' },
    outputEvidence: { path: '/owned/cache/observed-output', sha256: resource.sha256, bytes: resource.bytes, content: body } };
  const taskArtifact = put('/owned/segment/tasks.jsonl', 'sealed synthetic task observations\n', false);
  const sdkSegment = { tasks: taskArtifact };
  const seal = () => {
    sdkSegment.sdk = put('/owned/segment/sdk.jsonl', sdk.map(row => JSON.stringify(row)).join('\n') + '\n', false);
    let previous = null;
    const rows = sourceRows.map((row, index) => {
      const value = { version: 1, sequence: index + 1, previousSha256: previous, clockId: 'fixture-segment', ...row };
      previous = hash(JSON.stringify(value)); return { ...value, eventSha256: previous };
    });
    sdkSegment.source = put('/owned/segment/source.jsonl', rows.map(row => JSON.stringify(row)).join('\n') + '\n', false);
    sdkSegment.responses = [{ requestId: 'read-1', artifact: put('/owned/segment/sdk-responses/read-1.json', receipt) }];
  };
  seal();
  const value = { call, parent, brokerOwner, runtimeEvidence, branch, branchArtifact: put('/owned/branch.json', branch),
    taskArtifact, sdkSegment, payload: { messages: [{ role: 'tool', tool_call_id: parent.id, content: parentContent }] },
    frozenBodies: new Map([[resource.sha256, { text: body, bytes: resource.bytes, sha256: resource.sha256 }]]),
    readArtifact: async path => { if (!files.has(path)) throw new Error('Missing fixture artifact'); return files.get(path); } };
  return { value, files, sdk, sourceRows, receipt, seal, resource, selected };
}

test('nested resource proof links the pre-call owner, original SDK read, child result and exact outer message', async () => {
  const f = nestedResourceProofFixture(), proof = await verifyNotionAgentNestedResourceRead(f.value);
  assert.equal(proof.owner, f.selected.identity.id);
  assert.equal(proof.version_id, f.selected.version_id);
  assert.equal(proof.native.toolCallId, 'child'); assert.equal(proof.toolCallId, 'outer');
  assert.equal(proof.native.requestId, 'read-1');
  assert.equal(proof.native.kind, 'nested-sdk-resource');
  assert.deepEqual(proof.native.taskArtifact, f.value.taskArtifact);
  assert.deepEqual(proof.native.responseArtifact, f.value.sdkSegment.responses[0].artifact);
});

for (const [reason, change] of [
  ['wrong owner', f => { f.receipt.value.record.id = 'skill://another?library=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; f.seal(); }],
  ['wrong scope', f => { f.receipt.value.scope = 'e'.repeat(64); f.seal(); }],
  ['wrong version', f => { f.receipt.value.version_id = 'e'.repeat(64); f.seal(); }],
  ['ambiguous SDK reads', f => { f.sdk.splice(2, 0, { ...f.sdk[1], requestId: 'other-read' }); f.seal(); }],
  ['missing SDK receipt', f => { f.value.sdkSegment.responses = []; }],
  ['missing child result', f => { delete f.value.call.result.contentArtifact; }],
  ['different original segment', f => { f.value.sdkSegment.tasks = { ...f.value.taskArtifact, sha256: 'e'.repeat(64) }; }],
  ['different source clock', f => { f.sourceRows[1].sourceMonotonicNs = '119'; f.seal(); }],
  ['owner appended after the call', f => { const row = f.value.branch.shift(); f.value.branch.push(row); }],
  ['altered SDK output bytes', f => { f.receipt.outputEvidence.content = 'another body'; f.seal(); }],
  ['altered outer provider message', f => { f.value.payload.messages[0].content = 'Invented output with the same body:\n' + f.receipt.outputEvidence.content; }],
  ['unverified runtime', f => { f.value.runtimeEvidence.clear(); }],
]) test('nested resource proof rejects ' + reason, async () => {
  const f = nestedResourceProofFixture(); change(f);
  await assert.rejects(verifyNotionAgentNestedResourceRead(f.value));
});
