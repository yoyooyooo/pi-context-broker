import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspectNotionAgentSession, captureNotionAgentSelection, analyzeNotionAgentTurn } from './notion-agent-analysis.mjs';
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
      responseModel: 'actual-worker', stopReason: message.stopReason, usage,
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

test('a familiar read name without actual implementation provenance cannot prove zero effects', async () => {
  for (const name of ['read', 'notion_list', 'notion_use', 'tool_search']) {
    const f = fixture({ calls: [{ name }] });
    delete f.observed.tasks.find(row => row.phase === 'tool_call').toolSource;
    assert.equal((await f.run([{ kind: 'no-semantic-writes' }])).status, 'blocked', name);
  }
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
  const sourceId = 'notion-target', database = '01234567-89ab-cdef-0123-456789abcdef';
  const bytes = Buffer.from(JSON.stringify({ sources: [{ type: 'notion', id: sourceId, database }] })), path = '/owned/private/source-config.json';
  f.files.set(path, bytes);
  f.binding.private.fixture = { entry: database };
  f.observed.visibility = { source: { sourceId, database, configArtifact: { path, sha256: hash(bytes), bytes: bytes.length } } };
  f.observed.source = [{ phase: 'started', kind: 'sdk', operation: 'list', requestId: 'catalog', monotonicNs: '100', source_id: sourceId, database },
    { phase: 'completed', kind: 'sdk', operation: 'list', requestId: 'catalog', monotonicNs: '300', source_id: sourceId, database }];
  return f;
}

test('a pending view needs actual target-source timing, not just an old pending label', async () => {
  const f = pendingSourceFixture();
  f.observed.visibility.source.database = f.observed.visibility.source.database.replaceAll('-', '').toUpperCase();
  const result = await f.run([{ kind: 'visibility', object: 'remote', stage: 'source-pending' }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
  f.observed.source[1].monotonicNs = '150';
  assert.equal((await f.run([{ kind: 'visibility', object: 'remote', stage: 'source-pending' }])).status, 'failed');
});

test('pending visibility cannot borrow another Source list or fabricate attribution for old diagnostics', async () => {
  for (const mutate of [
    f => { f.observed.source[0].source_id = f.observed.source[1].source_id = 'other-source'; },
    f => { f.observed.source[0].database = f.observed.source[1].database = 'another-library'; },
    f => { for (const row of f.observed.source) { delete row.source_id; delete row.database; } },
    f => { f.observed.source[0].monotonicNs = '250'; },
    f => { f.observed.source[1].source_id = 'other-source'; },
    f => { f.binding.private.fixture.entry = 'other-library'; },
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

test('complete code-mode reads prove their own bytes and the parent wire delivery', async () => {
  const f = composedLocalFixture();
  const result = await f.run([{ kind: 'body', body: 'local@A/SKILL.md', occurrences: 1 }, { kind: 'no-semantic-writes' },
    { kind: 'source-network-attempts', max: 0 }, { kind: 'tool-attempts', tool: 'read', min: 1, max: 1 }]);
  assert.equal(result.status, 'passed', JSON.stringify(result.assertions));
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

function attachCandidateCli(f, { actualPath, startNs = '150', endNs = '160' } = {}) {
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
      { ...base, phase: 'process_start', monotonicNs: start },
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
