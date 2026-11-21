import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { inspectNotionAgentSession, captureNotionAgentSelection, analyzeNotionAgentTurn } from './notion-agent-analysis.mjs';

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
const oracle = (payload, bodies) => {
  const texts = payload.messages.flatMap(message => typeof message.content === 'string' ? [message.content] :
    (message.content ?? []).filter(part => part.type === 'text').map(part => part.text));
  return bodies.map(body => ({ sha256: body.sha256, bytes: body.bytes,
    occurrences: texts.reduce((sum, text) => sum + text.split(body.text).length - 1, 0) }));
};
function fixture({ calls = [], answerText = '合计：100 元', bodies = {}, scope = 'a'.repeat(64) } = {}) {
  const files = new Map(), bodyFiles = [];
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
      responseModel: 'actual-worker', stopReason: message.stopReason, usage,
      content: { sha256: hash(JSON.stringify(message.content)), bytes: Buffer.byteLength(JSON.stringify(message.content)) } } });
    transport.push({ phase: 'request_start', id: i + 1, category: 'model' },
      { phase: 'request_sent', id: i + 1, requestBodySha256: sha256, requestBodyBytes: bytes.length },
      { phase: 'request_end', id: i + 1, category: 'model', modelApi: 'openai-completions', status: 200, outcome: 'completed',
        responseEntitySha256: 'f'.repeat(64), responseEntityBytes: 60 });
    tasks.push({ phase: 'provider_payload', sha256, bytes: bytes.length, payloadFile: path, bodies: counts });
    if (i < calls.length) tasks.push({ phase: 'tool_call', toolCallId: 't' + i, toolName: calls[i].name, selectors: calls[i].arguments ?? {} },
      { phase: 'tool_result', toolCallId: 't' + i, toolName: calls[i].name, isError: calls[i].isError === true });
  }
  tasks.push({ phase: 'assistant_final', text: answerText, sha256: hash(answerText), bytes: Buffer.byteLength(answerText), stopReason: 'stop', success: true });
  const binding = { version: 1, public: {}, private: { objects: {}, bodies: bodyBindings, facts: { total: { anyOf: ['合计：100 元', '总额是100元'] } }, readbacks: {} } };
  const observed = { costs, transport, tasks, session, source: [], sourceCoverage: true,
    selection: { version: 1, sessionId: session.sessionId, leafId: session.leafId, branchSha256: session.branchSha256, scopes: [], active: [] } };
  const run = expect => analyzeNotionAgentTurn({ id: 'test-turn', expect }, observed, binding, { inspectPayload: oracle,
    readArtifact: async path => { if (!files.has(path)) throw new Error('missing artifact ' + path); return files.get(path); } });
  const bindRemote = (alias, version, textKey, owner = 'skill-' + alias) => {
    const body = bodyBindings[textKey], snapshot_id = 's_' + hash(alias + version), version_id = hash(version + alias);
    binding.private.objects[alias] = { kind: 'notion', owner, scope, currentVersion: version,
      versions: { [version]: { snapshot_id, version_id, bodyKeys: Object.keys(bodyBindings).filter(key => key.startsWith(alias + '@' + version + '/')) } } };
    const selected = { record: { id: owner }, scope, snapshot_id, version_id, body_sha256: body.sha256 };
    observed.selection.scopes.push({ scope, roots: [owner], bindings: [selected], graphLocks: [] });
    return { owner, scope, snapshot_id, version_id };
  };
  return { files, entries, bodyFiles, binding, observed, run, bindRemote };
}

test('completed real-evidence shape passes facts and zero tool attempts', async () => {
  const f = fixture();
  const result = await f.run([{ kind: 'completed' }, { kind: 'output', all: ['total'] },
    { kind: 'tool-attempts', tool: 'notion_use', max: 0 }, { kind: 'no-semantic-writes' }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  assert.equal(result.efficiency.usage.totalTokens, 16);
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

test('resource proof binds owner and version independently from content equality', async () => {
  const f = fixture({ bodies: { 'remote@A/SKILL.md': 'business text', 'remote@A/rates.md': 'rate is 100' } });
  const target = f.bindRemote('remote', 'A', 'remote@A/SKILL.md'), body = f.binding.private.bodies['remote@A/rates.md'];
  f.observed.tasks.push({ phase: 'receipt', proofs: { contextBrokerResource: { ...target, id: 'wrong-owner', path: 'rates.md',
    sha256: body.sha256, bytes: body.bytes, delivered_complete_text: true } } });
  assert.equal((await f.run([{ kind: 'resource', object: 'remote', version: 'A', path: 'rates.md' }])).status, 'failed');
  f.observed.tasks.at(-1).proofs.contextBrokerResource.id = target.owner;
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
  f.observed.tasks[0].bodies = [];
  const result = await f.run([{ kind: 'body', body: 'remote@B/SKILL.md', occurrences: 1 }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  assert.equal(result.delivery.requests[0].bodyObservation[0].method, 'independent-raw-payload-count-only');
});

test('connected main-document inspection proves read ownership without adoption', async () => {
  const f = fixture({ calls: [{ name: 'read', arguments: { path: 'sr:document' } }],
    bodies: { 'guidance@A/SKILL.md': 'current connected maintenance guidance' } });
  const target = f.bindRemote('guidance', 'A', 'guidance@A/SKILL.md');
  const body = f.binding.private.bodies['guidance@A/SKILL.md'];
  const binding = { record: { id: target.owner, entrypoint: 'SKILL.md' }, scope: target.scope,
    snapshot_id: target.snapshot_id, version_id: target.version_id };
  f.observed.selection.scopes = [];
  f.observed.tasks.push({ phase: 'receipt', proofs: { contextBrokerRead: { binding, snapshotId: target.snapshot_id,
    bodySha256: body.sha256, bytes: body.bytes, toolCallId: 't0', purpose: 'inspect' } } });
  const result = await f.run([{ kind: 'resource', object: 'guidance', version: 'A', path: 'SKILL.md' },
    { kind: 'tool-attempts', tool: 'notion_use', max: 0 }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  f.observed.tasks.at(-1).proofs.contextBrokerRead.binding.record.id = 'same-name-package-copy';
  assert.equal((await f.run([{ kind: 'resource', object: 'guidance', version: 'A', path: 'SKILL.md' }])).status, 'failed');
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

test('a pending view needs actual source timing, not just an old pending label', async () => {
  const f = fixture(); f.binding.private.objects.remote = { kind: 'notion', name: 'remote', owner: 'skill-remote', scope: 'a'.repeat(64), versions: {} };
  const task = addMetadata(f, '<ntn-skills-discovery status="pending">metadata pending</ntn-skills-discovery><ntn-skills-guidance>instructions</ntn-skills-guidance>');
  task.monotonicNs = '200';
  f.observed.source = [{ phase: 'started', kind: 'sdk', operation: 'list', requestId: 'catalog', monotonicNs: '100' },
    { phase: 'completed', kind: 'sdk', operation: 'list', requestId: 'catalog', monotonicNs: '300' }];
  assert.equal((await f.run([{ kind: 'visibility', object: 'remote', stage: 'source-pending' }])).status, 'passed');
  f.observed.source[1].monotonicNs = '150';
  assert.equal((await f.run([{ kind: 'visibility', object: 'remote', stage: 'source-pending' }])).status, 'failed');
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
  const f = fixture({ bodies: { 'remote@A/SKILL.md': 'business text', 'remote@A/rates.md': 'rate is 100' } });
  const target = f.bindRemote('remote', 'A', 'remote@A/SKILL.md'), body = f.binding.private.bodies['remote@A/rates.md'];
  const proof = { version: 2, toolCallId: 'read-batch', loaded: false,
    selection: { owner: target.owner, scope: target.scope, snapshot_id: target.snapshot_id, version_id: target.version_id },
    files: [{ path: 'rates.md', sha256: body.sha256, bytes: body.bytes, state: 'source', encoding: 'utf8', delivered_complete_text: true }] };
  f.observed.tasks.push({ phase: 'receipt', proofs: { contextBrokerResource: proof } });
  assert.equal((await f.run([{ kind: 'resource', object: 'remote', version: 'A', path: 'rates.md' }])).status, 'passed');
  proof.selection.version_id = 'e'.repeat(64);
  assert.equal((await f.run([{ kind: 'resource', object: 'remote', version: 'A', path: 'rates.md' }])).status, 'failed');
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
