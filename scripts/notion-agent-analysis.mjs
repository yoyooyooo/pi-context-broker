import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { providerApplicationCompletion } from './skill-consumption-provider.mjs';
import { validateAgentAssertion, validateAgentBindings } from './notion-agent-scenarios.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const textOf = content => typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
  .filter(part => part?.type === 'text').map(part => part.text).join('\n');
const sessionTypes = new Set(['message', 'thinking_level_change', 'model_change', 'usage', 'compaction',
  'branch_summary', 'custom', 'label', 'session_info', 'custom_message', 'context_edit']);
const roles = new Set(['system', 'user', 'assistant', 'toolResult', 'custom', 'bashExecution', 'branchSummary', 'compactionSummary']);

/** Inspect the actual append-only Pi v3 tree. This models persisted context, not
 * the final provider payload: context hooks can still change that payload. */
export function inspectNotionAgentSession(text, options = {}) {
  const { provider = 'magpie', model = 'group/worker', expectedUserMessages, expectedActiveUserMessages,
    expectedSessionId, fork, requireCompletion = true } = options;
  assert.ok(typeof text === 'string' && text.endsWith('\n'), 'Retain a complete native JSONL session');
  const rows = text.trimEnd().split('\n').map((line, index) => ({ value: JSON.parse(line), line: index + 1 }));
  const header = rows[0]?.value;
  assert.ok(object(header) && header.type === 'session' && header.version === 3, 'Only the current Pi v3 session is supported');
  assert.ok(nonempty(header.id) && nonempty(header.cwd) && Number.isFinite(Date.parse(header.timestamp)), 'Native session identity is incomplete');
  if (expectedSessionId !== undefined) assert.equal(header.id, expectedSessionId);
  if (fork) {
    assert.equal(header.parentSession, fork.parentSession); assert.equal(header.cwd, fork.cwd);
    assert.ok(nonempty(fork.sourceSessionId) && header.id !== fork.sourceSessionId);
    assert.ok(Number.isSafeInteger(fork.history?.bytes) && fork.history.bytes > 0 && digest(fork.history.sha256));
    const bytes = Buffer.from(text), offset = bytes.indexOf(10) + 1;
    const retained = bytes.subarray(offset, offset + fork.history.bytes);
    assert.equal(retained.length, fork.history.bytes); assert.equal(hash(retained), fork.history.sha256, 'The public fork changed its bound retained history');
    assert.equal(retained.at(-1), 10);
    assert.equal(retained.toString('utf8').trimEnd().split('\n').length, fork.history.entries);
  } else assert.ok(!header.parentSession, 'A fork needs its bound parent and retained bytes');

  const entries = rows.slice(1), byId = new Map(), children = new Map();
  const ancestry = id => {
    const result = [];
    for (let current = id === null ? undefined : byId.get(id); current; current = current.value.parentId === null ? undefined : byId.get(current.value.parentId))
      result.push(current);
    return result.reverse();
  };
  for (const wrapped of entries) {
    const row = wrapped.value;
    assert.ok(object(row) && sessionTypes.has(row.type), 'Unsupported native entry type: ' + row?.type);
    assert.ok(nonempty(row.id) && !byId.has(row.id), 'Native entry identity is missing or duplicated');
    assert.ok(row.parentId === null || nonempty(row.parentId) && byId.has(row.parentId), 'Native parent must be an earlier entry');
    assert.ok(Number.isFinite(Date.parse(row.timestamp)), 'Native entry timestamp is missing');
    const ancestors = ancestry(row.parentId);
    if (row.type === 'message') assert.ok(object(row.message) && roles.has(row.message.role), 'Unsupported native message role');
    if (row.type === 'context_edit') {
      const target = byId.get(row.targetId)?.value;
      assert.ok(ancestors.some(entry => entry.value.id === row.targetId), 'Context edit targets a sibling or missing entry');
      assert.ok(target.type === 'custom_message' || target.type === 'message' && ['user', 'assistant', 'toolResult'].includes(target.message.role),
        'Context edit targets an entry without editable model content');
      assert.ok(row.replacement === null || object(row.replacement) && (typeof row.replacement.content === 'string' || Array.isArray(row.replacement.content)),
        'Unsupported context replacement');
    }
    if (row.type === 'compaction') {
      assert.ok(nonempty(row.summary) && Number.isFinite(row.tokensBefore) && row.tokensBefore >= 0, 'Compaction has no actual summary');
      assert.ok(ancestors.some(entry => entry.value.id === row.firstKeptEntryId), 'Compaction retention must name an ancestor on this branch');
    }
    if (row.type === 'branch_summary') {
      assert.ok(nonempty(row.summary) && (row.fromId === 'root' || byId.has(row.fromId)), 'Branch summary has no bound abandoned path');
    }
    byId.set(row.id, wrapped);
    const siblings = children.get(row.parentId) ?? []; siblings.push(row.id); children.set(row.parentId, siblings);
  }
  const branched = [...children.values()].some(ids => ids.length > 1);
  if (branched) assert.ok(Object.hasOwn(options, 'leafId'), 'A branched file needs the actually observed current leaf');
  const leafId = Object.hasOwn(options, 'leafId') ? options.leafId : entries.at(-1)?.value.id ?? null;
  assert.ok(leafId === null || byId.has(leafId), 'Observed native leaf is missing');
  const branch = ancestry(leafId), activeIds = new Set(branch.map(entry => entry.value.id));
  const calls = new Map(), models = [], finals = [], userLines = [], projections = [], assistantMessages = [];
  const userFor = row => [...ancestry(row.parentId)].reverse().find(entry => entry.value.type === 'message' && entry.value.message.role === 'user')?.value.id ?? null;
  for (const { value: row, line } of entries) {
    if (row.type === 'model_change') {
      if (activeIds.has(row.id)) { assert.equal(row.provider, provider); assert.equal(row.modelId, model); }
      models.push({ line, entryId: row.id, active: activeIds.has(row.id), provider: row.provider, model: row.modelId });
    }
    if (row.type === 'context_edit') {
      projections.push({ line, entryId: row.id, targetId: row.targetId, active: activeIds.has(row.id), sha256: hash(JSON.stringify(row.replacement)) });
      if (row.replacement === null) for (const call of calls.values()) if (call.assistantEntryId === row.targetId) {
        call.contextEdits.push({ line, entryId: row.id, active: activeIds.has(row.id), omitted: true });
        if (['error', 'aborted'].includes(call.assistantStopReason) && call.resultLine === undefined)
          call.retractedLine = line;
      }
    }
    if (row.type !== 'message') continue;
    const message = row.message, active = activeIds.has(row.id);
    if (message.role === 'user') userLines.push({ line, entryId: row.id, active, sha256: hash(textOf(message.content)) });
    if (message.role === 'assistant') {
      if (active) { assert.equal(message.provider, provider); assert.equal(message.model, model); }
      assistantMessages.push({ entryId: row.id, line, active, userEntryId: userFor(row), provider: message.provider, model: message.model,
        stopReason: message.stopReason, content: { sha256: hash(JSON.stringify(message.content)), bytes: Buffer.byteLength(JSON.stringify(message.content)) } });
      for (const part of Array.isArray(message.content) ? message.content : []) if (part.type === 'toolCall') {
        assert.ok(nonempty(part.id) && !calls.has(part.id) && nonempty(part.name) && object(part.arguments), 'Invalid or duplicate native tool attempt');
        calls.set(part.id, { id: part.id, name: part.name, arguments: part.arguments, callLine: line,
          assistantEntryId: row.id, assistantStopReason: message.stopReason, userEntryId: userFor(row), active, contextEdits: [] });
      }
      if (['stop', 'length', 'error', 'aborted'].includes(message.stopReason)) {
        const output = textOf(message.content);
        finals.push({ line, entryId: row.id, active, userEntryId: userFor(row), stopReason: message.stopReason,
          bytes: Buffer.byteLength(output), sha256: hash(output) });
      }
    }
    if (message.role === 'toolResult') {
      const call = calls.get(message.toolCallId), ancestors = new Set(ancestry(row.parentId).map(entry => entry.value.id));
      assert.ok(call && ancestors.has(call.assistantEntryId) && call.resultLine === undefined, 'A tool result must match one earlier call on its branch');
      assert.equal(message.toolName, call.name);
      Object.assign(call, { resultLine: line, resultEntryId: row.id, isError: message.isError === true,
        proofKinds: ['contextBrokerPreparation', 'contextBrokerRead', 'contextBrokerResource'].filter(key => message.details?.[key] !== undefined),
        resultSha256: hash(JSON.stringify(message.content)) });
    }
  }
  if (expectedUserMessages !== undefined) assert.equal(userLines.length, expectedUserMessages, 'Native submissions differ from the run');
  const activeUserLines = userLines.filter(row => row.active);
  if (expectedActiveUserMessages !== undefined) assert.equal(activeUserLines.length, expectedActiveUserMessages);
  const activeFinals = finals.filter(row => row.active);
  if (requireCompletion) {
    assert.ok(activeFinals.length && activeFinals.at(-1).stopReason === 'stop' && activeFinals.at(-1).bytes > 0,
      'A process exit or truncated answer is not a completed turn');
    assert.ok(models.some(row => row.active), 'The active branch has no recorded selected model');
    assert.ok([...calls.values()].filter(call => call.active).every(call => call.resultLine !== undefined ||
      call.retractedLine !== undefined && call.contextEdits.some(edit => edit.active)), 'An active native tool call has no result or explicit failed-response retraction');
  }

  const latestCompaction = branch.filter(entry => entry.value.type === 'compaction').at(-1);
  let kept = branch;
  if (latestCompaction) {
    const index = branch.indexOf(latestCompaction), first = branch.findIndex(entry => entry.value.id === latestCompaction.value.firstKeptEntryId);
    kept = [latestCompaction, ...branch.slice(first, index).filter(entry => !(entry.value.type === 'message' && entry.value.message.role === 'system')),
      ...branch.slice(index + 1)];
  }
  const edits = new Map(kept.filter(entry => entry.value.type === 'context_edit').map(entry => [entry.value.targetId, entry]));
  const contributions = [];
  for (const [index, { value: row, line }] of kept.entries()) {
    const edit = edits.get(row.id)?.value;
    if (edit?.replacement === null) continue;
    let role, content, details;
    if (row.type === 'message') { role = row.message.role; content = row.message.content ?? (role === 'system' ? '' : []); details = row.message.details; }
    else if (row.type === 'custom_message') { role = 'custom'; content = row.content ?? []; details = row.details; }
    else if (row.type === 'branch_summary') { role = 'branchSummary'; content = row.summary; }
    else if (row.type === 'compaction' && index === 0) {
      if (row.systemMessage) contributions.push({ entryId: row.id, line, role: 'system', content: row.systemMessage.content ?? '', checkpoint: true });
      role = 'compactionSummary'; content = row.summary;
    } else continue;
    if (edit && ['user', 'assistant', 'toolResult', 'custom'].includes(role)) content = edit.replacement.content;
    contributions.push({ entryId: row.id, line, role, content, ...(details === undefined ? {} : { details }), ...(edit ? { editedBy: edit.id } : {}) });
  }
  return { version: 1, supported: true, sessionId: header.id, header, sha256: hash(text), bytes: Buffer.byteLength(text),
    lines: rows.length, leafId, branched, branchEntryIds: branch.map(entry => entry.value.id), branchEntries: branch.map(entry => entry.value),
    branchSha256: hash(JSON.stringify(branch.map(entry => entry.value))), activeUserLines, userLines, currentUserId: activeUserLines.at(-1)?.entryId ?? null,
    models, assistantMessages, finals, currentFinal: activeFinals.at(-1) ?? null, attempts: [...calls.values()], calls: [...calls.values()].filter(call => call.retractedLine === undefined),
    retractedCalls: [...calls.values()].filter(call => call.retractedLine !== undefined), projections,
    errors: [...calls.values()].filter(call => call.isError).map(call => ({ id: call.id, name: call.name, line: call.resultLine, active: call.active })),
    effectiveEntryIds: kept.map(entry => entry.value.id), contributions,
    compaction: latestCompaction ? { entryId: latestCompaction.value.id, firstKeptEntryId: latestCompaction.value.firstKeptEntryId } : null,
    ...(fork ? { fork: { header, history: fork.history } } : {}),
    scope: 'observed-native-branch-and-persisted-context; actual provider delivery requires correlated wire evidence' };
}

/** Serialize the real product reducers. Callers load those reducers from the
 * exact candidate, so this analyzer does not implement a second selection engine. */
export function captureNotionAgentSelection({ sessionId, leafId, branchSha256, selection, active }) {
  assert.ok(nonempty(sessionId) && (leafId === null || nonempty(leafId)) && digest(branchSha256));
  assert.ok(selection?.scopes instanceof Map && active?.sources instanceof Map, 'Use the actual product selection and active reducers');
  return { version: 1, sessionId, leafId, branchSha256,
    scopes: [...selection.scopes.values()].map(scope => {
      assert.ok(scope.bindings instanceof Map && scope.roots instanceof Set && Array.isArray(scope.graphs));
      return { scope: scope.scope, roots: [...scope.roots], bindings: [...scope.bindings.values()], graphLocks: scope.graphs };
    }),
    active: [...active.sources.values()] };
}

class EvidenceError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
const demand = (condition, code, message, details) => { if (!condition) throw new EvidenceError('failed', code, message, details); };
const need = (condition, code, message, details) => { if (!condition) throw new EvidenceError('blocked', code, message, details); };
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const normalized = value => String(value).normalize('NFKC').replace(/\s+/gu, ' ').toLocaleLowerCase('en-US').trim();
const statusOf = items => items.some(item => item.status === 'failed') ? 'failed' : items.some(item => item.status === 'blocked') ? 'blocked' : 'passed';
const proofValues = tasks => tasks.filter(row => row.phase === 'receipt').flatMap(row => Object.values(row.proofs ?? {}));
const sameIdentity = (binding, target) => binding?.record?.id === target.owner && binding.scope === target.scope &&
  binding.snapshot_id === target.snapshot_id && binding.version_id === target.version_id;

async function verifiedArtifact(artifact, readArtifact) {
  need(object(artifact) && isAbsolute(artifact.path ?? '') && digest(artifact.sha256) &&
    Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0, 'ARTIFACT_BINDING_MISSING', 'An actual artifact needs absolute path, SHA-256 and positive byte count');
  let bytes;
  try { bytes = await readArtifact(artifact.path); } catch (error) { throw new EvidenceError('blocked', 'ARTIFACT_UNREADABLE', error.message); }
  bytes = Buffer.from(bytes);
  demand(bytes.length === artifact.bytes && hash(bytes) === artifact.sha256, 'ARTIFACT_CHANGED', 'Observed artifact bytes changed', { path: artifact.path });
  return bytes;
}
function resolveObject(privateBindings, alias, versionLabel) {
  const item = privateBindings.objects[alias];
  need(item && object(item.versions), 'OBJECT_BINDING_MISSING', 'No real object binding for ' + alias);
  const label = versionLabel ?? item.currentVersion, version = item.versions[label];
  need(nonempty(label) && object(version), 'VERSION_BINDING_MISSING', 'No real version binding for ' + alias);
  const resolved = { alias, label, kind: item.kind, owner: version.owner ?? item.owner, scope: version.scope ?? item.scope,
    snapshot_id: version.snapshot_id, version_id: version.version_id, path: version.path ?? item.path,
    bodyKeys: version.bodyKeys ?? [] };
  if (item.kind === 'notion') need(nonempty(resolved.owner) && digest(resolved.scope) &&
    /^s_[a-f0-9]{64}$/u.test(resolved.snapshot_id ?? '') && digest(resolved.version_id),
  'OBJECT_NOT_PUBLISHED', 'The expected Notion version has not been independently bound', { alias, label });
  else need(isAbsolute(resolved.path ?? '') && nonempty(resolved.owner), 'LOCAL_IDENTITY_MISSING', 'The exact local file identity is missing', { alias, label });
  return resolved;
}
function mainBodyKey(target, bodies) {
  const selected = target.bodyKeys.filter(key => bodies[key]?.resourcePath === 'SKILL.md' || key.endsWith('/SKILL.md'));
  need(selected.length === 1, 'MAIN_BODY_BINDING_MISSING', 'A selected object needs exactly one frozen main body', { alias: target.alias, label: target.label });
  return selected[0];
}

/** Analyze one real turn. Only the outside controller receives private bindings.
 * readArtifact and inspectPayload are injected I/O/pure helpers, never model tools. */
export async function analyzeNotionAgentTurn(turn, observed, bindings, { inspectPayload, readArtifact = readFile } = {}) {
  const assertions = [], shared = {};
  const check = async (kind, task) => {
    try { const details = await task(); const result = { kind, status: 'passed', ...(details === undefined ? {} : { details }) }; assertions.push(result); return details; }
    catch (error) {
      assertions.push({ kind, status: error instanceof EvidenceError ? error.status : 'blocked',
        code: error.code ?? 'EVIDENCE_INVALID', message: error.message, ...(error.details === undefined ? {} : { details: error.details }) });
      return undefined;
    }
  };
  const configValid = await check('analysis-input', () => {
    validateAgentBindings(bindings); assert.ok(Array.isArray(turn.expect) && turn.expect.length > 0);
    for (const assertion of turn.expect) validateAgentAssertion(assertion);
    need(typeof inspectPayload === 'function', 'BODY_ORACLE_MISSING', 'Use the existing payload-body oracle');
    for (const key of ['costs', 'transport', 'tasks']) need(Array.isArray(observed[key]), 'TRACE_MISSING', 'Missing ' + key + ' observations');
    return true;
  });
  if (!configValid) return { version: 1, turnId: turn.id, status: statusOf(assertions), assertions };
  const { costs, transport, tasks } = observed, privateBindings = bindings.private;
  shared.attempts = new Map();
  await check('tool-attempt-observation', () => {
    for (const row of tasks.filter(row => row.phase === 'tool_call')) {
      need(nonempty(row.toolCallId) && nonempty(row.toolName), 'TOOL_IDENTITY_MISSING', 'An actual tool attempt has no identity');
      need(!shared.attempts.has(row.toolCallId), 'TOOL_ATTEMPT_DUPLICATED', 'Tool observation cannot count duplicate callbacks as new attempts');
      shared.attempts.set(row.toolCallId, { id: row.toolCallId, name: row.toolName, selectors: row.selectors ?? {}, event: row,
        result: tasks.find(result => result.phase === 'tool_result' && result.toolCallId === row.toolCallId) });
    }
    need(observed.session?.supported === true, 'NATIVE_SESSION_MISSING', 'Use the parsed actual native session');
    const native = observed.session.attempts.filter(call => call.userEntryId === observed.session.currentUserId && call.active);
    for (const actual of shared.attempts.values()) {
      const call = native.find(call => call.id === actual.id);
      need(call && call.name === actual.name, 'NATIVE_TOOL_CORRELATION_MISSING', 'An observed tool attempt is absent from this native turn', { toolCallId: actual.id });
      actual.arguments = call.arguments; actual.native = call;
    }
    for (const call of native.filter(call => call.resultLine !== undefined)) need(shared.attempts.has(call.id),
      'TASK_TOOL_OBSERVATION_MISSING', 'A native tool result has no actual-attempt observation', { toolCallId: call.id });
    return { attempts: shared.attempts.size, errors: [...shared.attempts.values()].filter(call => call.result?.isError).length,
      retractedProposals: native.filter(call => call.retractedLine !== undefined && !shared.attempts.has(call.id)).length };
  });

  shared.delivery = await check('actual-provider-delivery', async () => {
    const requests = costs.filter(row => row.phase === 'provider_request'), used = new Set(), payloads = [], nativeUsed = new Set();
    const nativeMessages = observed.session?.assistantMessages?.filter(row => row.active && row.userEntryId === observed.session.currentUserId);
    need(Array.isArray(nativeMessages), 'NATIVE_RESPONSE_MISSING', 'Actual native assistant responses must be retained');
    need(requests.length > 0, 'PROVIDER_REQUEST_MISSING', 'No actual model request was observed');
    const bodyKeys = new Set();
    for (const expected of turn.expect) {
      if (expected.kind === 'body') bodyKeys.add(expected.body);
      for (const choice of expected.kind === 'selection-any' ? expected.objects : ['selection', 'resource'].includes(expected.kind) ? [expected] : []) {
        const item = privateBindings.objects[choice.object], version = item?.versions[choice.version ?? item.currentVersion];
        for (const key of version?.bodyKeys ?? []) if (expected.kind === 'resource'
          ? privateBindings.bodies[key]?.resourcePath === expected.path || key.endsWith('/' + expected.path)
          : privateBindings.bodies[key]?.resourcePath === 'SKILL.md' || key.endsWith('/SKILL.md')) bodyKeys.add(key);
      }
    }
    const uniqueBodies = new Map();
    for (const key of bodyKeys) {
      const body = privateBindings.bodies[key];
      need(body, 'BODY_BINDING_MISSING', 'Missing frozen body ' + key);
      const bytes = await verifiedArtifact(body, readArtifact);
      const decoded = { key, ...body, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
      if (uniqueBodies.has(body.sha256)) demand(uniqueBodies.get(body.sha256).bytes === body.bytes, 'BODY_HASH_COLLISION', 'Equal body hashes have different byte lengths');
      else uniqueBodies.set(body.sha256, decoded);
    }
    const bodyFiles = [...uniqueBodies.values()];
    for (const request of requests) {
      demand(request.provider === 'magpie' && request.model === 'group/worker', 'WRONG_MODEL', 'The formal journey must actually use magpie/group/worker');
      const matches = transport.filter(row => row.phase === 'request_sent' && !used.has(row.id) &&
        row.requestBodySha256 === request.payload?.sha256 && row.requestBodyBytes === request.payload?.bytes);
      need(matches.length === 1, 'WIRE_CORRELATION_MISSING', 'Each hook payload must identify one actual wire request');
      const sent = matches[0]; used.add(sent.id);
      const start = transport.find(row => row.phase === 'request_start' && row.id === sent.id);
      const ends = transport.filter(row => row.phase === 'request_end' && row.id === sent.id);
      need(start?.category === 'model' && ends.length === 1, 'WIRE_RESPONSE_MISSING', 'The selected-model wire request has no single terminal response');
      const end = ends[0], messages = costs.filter(row => row.phase === 'message_end' && row.request === request.request && row.message?.role === 'assistant');
      need(messages.length === 1, 'RESPONSE_CORRELATION_MISSING', 'Each request needs exactly one terminal assistant response');
      const message = messages[0].message;
      const nativeMatches = nativeMessages.filter(row => !nativeUsed.has(row.entryId) && row.stopReason === message.stopReason &&
        row.content.sha256 === message.content?.sha256 && row.content.bytes === message.content?.bytes);
      need(nativeMatches.length === 1, 'NATIVE_RESPONSE_CORRELATION_MISSING', 'Provider response content must match one native assistant entry');
      nativeUsed.add(nativeMatches[0].entryId);
      demand(message.provider === 'magpie' && message.model === 'group/worker', 'WRONG_RESPONSE_MODEL', 'Actual response belongs to another requested model');
      need(end.modelApi === 'openai-completions', 'TRANSPORT_UNSUPPORTED', 'This observer currently proves only openai-completions over Node Undici');
      need(providerApplicationCompletion(end, message) && digest(end.responseEntitySha256) && end.responseEntityBytes > 0,
        'APPLICATION_COMPLETION_MISSING', 'A hook or HTTP status is not a completed application response');
      demand(['stop', 'toolUse'].includes(message.stopReason), 'MODEL_RESPONSE_INCOMPLETE', 'The response stopped before completing its task');
      need(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(key => numeric(message.usage?.[key])) &&
        message.usage.totalTokens > 0, 'USAGE_UNKNOWN', 'Missing usage must not become zero');
      const taskRows = tasks.filter(row => row.phase === 'provider_payload' && row.sha256 === request.payload.sha256 && row.bytes === request.payload.bytes);
      need(taskRows.length === 1 && nonempty(taskRows[0].payloadFile), 'RAW_PAYLOAD_MISSING', 'Retain the exact private payload file');
      const task = taskRows[0], bytes = await verifiedArtifact({ path: task.payloadFile, sha256: task.sha256, bytes: task.bytes }, readArtifact);
      const payload = JSON.parse(bytes.toString('utf8'));
      demand(payload.model === 'group/worker' && payload.reasoning_effort === 'high', 'WRONG_WIRE_MODEL', 'Actual wire payload must request worker/high');
      const bodies = inspectPayload(payload, bodyFiles);
      need(Array.isArray(bodies), 'BODY_ORACLE_INVALID', 'The body oracle returned no observations');
      for (const body of bodies) {
        need(digest(body.sha256) && Number.isSafeInteger(body.occurrences) && body.occurrences >= 0, 'BODY_METRIC_MISSING', 'Body counts must be observed numbers');
        const observer = task.bodies?.find(value => value.sha256 === body.sha256);
        demand(observer?.occurrences === body.occurrences, 'BODY_OBSERVATION_MISMATCH', 'Independent payload read differs from the task observer');
      }
      payloads.push({ request: request.request, wireRequestId: sent.id, sha256: task.sha256, bytes: task.bytes, bodies,
        verifiedBodies: request.payload.verifiedBodyOccurrences, usage: message.usage, completion: providerApplicationCompletion(end, message),
        selection: observed.selectionSnapshots?.find(row => row.payloadSha256 === task.sha256)?.selection });
    }
    need(nativeMessages.every(row => nativeUsed.has(row.entryId)), 'UNATTRIBUTED_NATIVE_RESPONSE', 'A native assistant response lacks actual provider evidence');
    const actualStarts = transport.filter(row => row.phase === 'request_start' && row.category === 'model');
    need(actualStarts.every(start => used.has(start.id)), 'UNATTRIBUTED_MODEL_REQUEST', 'A model HTTP attempt lacks a correlated payload');
    return { requests: payloads, last: payloads.at(-1), usage: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']
      .map(key => [key, payloads.reduce((total, row) => total + row.usage[key], 0)])) };
  });
  shared.final = await check('actual-turn-completion', () => {
    const final = tasks.filter(row => row.phase === 'assistant_final').at(-1);
    need(final && typeof final.text === 'string', 'FINAL_RESPONSE_MISSING', 'This turn has no actual final answer');
    demand(final.stopReason === 'stop' && final.text.trim().length > 0, 'TURN_INCOMPLETE', 'Length, abort, empty output and RPC acknowledgement do not complete the turn');
    demand(final.sha256 === hash(final.text) && final.bytes === Buffer.byteLength(final.text), 'FINAL_RESPONSE_CHANGED', 'Final answer identity does not match its bytes');
    need(observed.session?.currentFinal?.sha256 === final.sha256 && observed.session.currentFinal.stopReason === 'stop',
      'NATIVE_FINAL_CORRELATION_MISSING', 'Final answer does not match the current native branch');
    need(shared.delivery?.last, 'DELIVERY_UNPROVEN', 'The final answer has no proved provider delivery');
    return final;
  });

  const requireDelivery = () => {
    need(shared.delivery?.last, 'DELIVERY_UNPROVEN', 'This assertion needs actual provider delivery');
    return shared.delivery;
  };
  const bodyCount = (key, payload) => {
    const body = privateBindings.bodies[key]; need(body, 'BODY_BINDING_MISSING', 'Missing frozen body ' + key);
    const matches = payload.bodies.filter(row => row.sha256 === body.sha256);
    need(matches.length === 1, 'BODY_COUNT_MISSING', 'Frozen body has no unique actual-payload count');
    return matches[0].occurrences;
  };
  const targetSelection = target => {
    const delivery = requireDelivery(), selection = observed.selection;
    need(selection?.version === 1 && selection.sessionId === observed.session?.sessionId && selection.leafId === observed.session?.leafId &&
      selection.branchSha256 === observed.session?.branchSha256 && Array.isArray(selection.scopes) && Array.isArray(selection.active),
    'SELECTION_OBSERVATION_MISSING', 'Current selection is not bound to this observed native branch');
    const main = mainBodyKey(target, privateBindings.bodies), body = privateBindings.bodies[main];
    demand(bodyCount(main, delivery.last) > 0, 'SELECTED_BODY_MISSING', 'The currently selected main is absent from the final request');
    if (target.kind === 'notion') {
      const matches = selection.scopes.flatMap(scope => scope.bindings).filter(binding => sameIdentity(binding, target));
      demand(matches.length === 1, 'WRONG_SELECTION', 'Actual selected logical identity/version differs', { expected: target });
      demand(matches[0].body_sha256 === body.sha256, 'SELECTED_BODY_IDENTITY_MISMATCH', 'Selected main bytes differ from the frozen version');
    } else {
      const active = selection.active.some(source => ['local', 'filesystem'].includes(source.record?.source) && source.record.path === target.path && source.bodySha256 === body.sha256);
      const read = [...shared.attempts.values()].some(call => call.name === 'read' && call.arguments?.path === target.path && call.result?.isError === false);
      demand(active || read, 'LOCAL_OWNER_UNPROVEN', 'A matching body hash alone does not prove the selected local owner');
    }
    return { ...target, body: main, payloadSha256: delivery.last.sha256 };
  };
  const factFound = key => {
    need(shared.final, 'FINAL_RESPONSE_UNPROVEN', 'Business facts require the completed native/model answer');
    const fact = privateBindings.facts[key]; need(fact && Array.isArray(fact.anyOf) && fact.anyOf.length, 'FACT_BINDING_MISSING', 'Missing private necessary fact ' + key);
    return fact.anyOf.some(value => normalized(shared.final.text).includes(normalized(value)));
  };

  for (const expected of turn.expect) await check(expected.kind, async () => {
    switch (expected.kind) {
      case 'completed':
        need(shared.final && shared.delivery, 'TURN_COMPLETION_UNPROVEN', 'Provider and native completion are both required');
        return { finalSha256: shared.final.sha256 };
      case 'tool-attempts': {
        const attempts = [...shared.attempts.values()].filter(call => call.name === expected.tool);
        demand(expected.min === undefined || attempts.length >= expected.min, 'TOOL_ATTEMPTS_TOO_FEW', 'Required actual tool attempts are missing');
        demand(expected.max === undefined || attempts.length <= expected.max, 'TOOL_ATTEMPTS_TOO_MANY', 'Forbidden or unnecessary actual tool attempts occurred');
        return { tool: expected.tool, actual: attempts.length, ids: attempts.map(call => call.id), errors: attempts.filter(call => call.result?.isError).length };
      }
      case 'body': {
        const delivery = requireDelivery();
        const payloads = expected.scope === 'all' || expected.occurrences === 0 ? delivery.requests : [delivery.last];
        for (const payload of payloads) {
          demand(bodyCount(expected.body, payload) === expected.occurrences, 'BODY_OCCURRENCE_MISMATCH', 'Required full-body count differs in an actual request',
            { body: expected.body, payloadSha256: payload.sha256, expected: expected.occurrences, actual: bodyCount(expected.body, payload) });
          if (expected.occurrences > 0 && expected.receiptRequired !== false) {
            const body = privateBindings.bodies[expected.body], proof = payload.verifiedBodies?.filter(row => row.sha256 === body.sha256);
            need(proof?.length === 1 && proof[0].occurrences === expected.occurrences, 'BODY_RECEIPT_MISSING', 'Full bytes have no corresponding receipt-verified body');
          }
        }
        return { body: expected.body, payloads: payloads.map(row => row.sha256), occurrences: expected.occurrences };
      }
      case 'selection':
        return targetSelection(resolveObject(privateBindings, expected.object, expected.version));
      case 'selection-any': {
        const choices = expected.objects.map(choice => {
          try { return { status: 'passed', target: targetSelection(resolveObject(privateBindings, choice.object, choice.version)) }; }
          catch (error) { return { status: error.status ?? 'blocked', code: error.code ?? 'EVIDENCE_INVALID', message: error.message }; }
        });
        if (!choices.some(choice => choice.status === 'passed')) {
          need(!choices.some(choice => choice.status === 'blocked'), 'SELECTION_OPTIONS_UNPROVEN', 'An allowed identity lacks complete observations', { choices });
          demand(false, 'WRONG_SELECTION', 'None of the allowed logical identities was actually selected', { choices });
        }
        return { choices };
      }
      case 'resource': {
        const target = resolveObject(privateBindings, expected.object, expected.version), delivery = requireDelivery();
        const keys = target.bodyKeys.filter(key => privateBindings.bodies[key]?.resourcePath === expected.path || key.endsWith('/' + expected.path));
        need(keys.length === 1, 'RESOURCE_BINDING_MISSING', 'Resource must have one frozen owner/version/path binding');
        const body = privateBindings.bodies[keys[0]];
        demand(bodyCount(keys[0], delivery.last) > 0, 'RESOURCE_BODY_MISSING', 'Required full resource is absent from the actual request');
        if (target.kind === 'notion') {
          const matches = proofValues(tasks).filter(proof => proof.id === target.owner && proof.scope === target.scope && proof.snapshot_id === target.snapshot_id &&
            proof.version_id === target.version_id && proof.path === expected.path && proof.sha256 === body.sha256 && proof.bytes === body.bytes &&
            proof.delivered_complete_text === true);
          demand(matches.length > 0, 'WRONG_RESOURCE_OWNER', 'No complete resource receipt for the chosen logical owner and version');
        } else demand([...shared.attempts.values()].some(call => call.name === 'read' &&
          call.arguments?.path === target.path.replace(/SKILL\.md$/u, '') + expected.path && call.result?.isError === false),
        'LOCAL_RESOURCE_OWNER_UNPROVEN', 'Local resource was not read from the selected owner');
        return { target, path: expected.path, body: keys[0], payloadSha256: delivery.last.sha256 };
      }
      case 'output': {
        const all = (expected.all ?? []).map(key => ({ key, found: factFound(key) }));
        const none = (expected.none ?? []).map(key => ({ key, found: factFound(key) }));
        const any = (expected.any ?? []).map(key => ({ key, found: factFound(key) }));
        demand(all.every(row => row.found) && none.every(row => !row.found) && (!any.length || any.some(row => row.found)),
          'BUSINESS_FACT_MISMATCH', 'The answer violates private necessary facts', { all, none, any });
        return { all, none, any, method: 'necessary-facts-with-alternatives; not-whole-answer-equality' };
      }
      case 'clarification':
        demand(factFound(expected.topic) && /[?？]|(?:请|需要|哪(?:个|一|种)|选择|确认|which|please provide|tell me)/iu.test(shared.final.text),
          'CLARIFICATION_MISSING', 'The necessary business clarification was not asked');
        return { topic: expected.topic };
      case 'business-readback': {
        const declaration = privateBindings.readbacks?.[expected.receipt], receipt = observed.readbacks?.[expected.receipt];
        need(declaration && receipt, 'READBACK_MISSING', 'A declared readback is not an observed business result');
        const bytes = await verifiedArtifact(receipt.artifact, readArtifact), raw = JSON.parse(bytes.toString('utf8'));
        const { artifact: _artifact, ...value } = receipt;
        demand(isDeepStrictEqual(raw, value), 'READBACK_RECEIPT_CHANGED', 'Readback summary differs from its original artifact');
        need(Array.isArray(receipt.assertions) && receipt.assertions.length > 0, 'READBACK_CHECKS_MISSING', 'The business readback must perform actual checks');
        need(receipt.assertions.every(item => ['passed', 'failed'].includes(item.status)), 'READBACK_CHECKS_UNKNOWN', 'Missing checks cannot pass');
        demand(receipt.status === 'passed' && receipt.assertions.every(item => item.status === 'passed'), 'BUSINESS_READBACK_FAILED', 'Independent business checks failed');
        need(typeof receipt.externalRepair === 'boolean', 'REPAIR_ACCOUNTING_MISSING', 'External repair must be accounted for explicitly');
        demand(receipt.externalRepair === false, 'EXTERNAL_REPAIR_REQUIRED', 'The product needed external cleanup after completion');
        demand(receipt.observed?.state === declaration.state, 'READBACK_STATE_MISMATCH', 'Readback does not match the intended present/absent state');
        const expectedObject = privateBindings.objects[declaration.object];
        need(nonempty(expectedObject?.owner) && receipt.object?.owner === expectedObject.owner, 'READBACK_OWNER_MISSING', 'Business readback is not bound to the intended owner');
        if (declaration.version) {
          const target = resolveObject(privateBindings, declaration.object, declaration.version);
          demand(receipt.object.snapshot_id === target.snapshot_id && receipt.object.version_id === target.version_id &&
            (target.scope === undefined || receipt.object.scope === target.scope), 'READBACK_VERSION_MISMATCH', 'Readback observed another version');
        }
        return { receipt: expected.receipt, artifact: receipt.artifact, checks: receipt.assertions.length };
      }
      case 'no-semantic-writes': {
        if (observed.effects) {
          const effects = observed.effects, raw = JSON.parse((await verifiedArtifact(effects.artifact, readArtifact)).toString('utf8'));
          const { artifact: _artifact, ...value } = effects;
          demand(isDeepStrictEqual(raw, value), 'EFFECTS_RECEIPT_CHANGED', 'Effects summary differs from its original observation');
          need(effects.coverage === 'all-subject-notion-operations' && effects.complete === true && Number.isSafeInteger(effects.semanticWrites) &&
            effects.semanticWrites >= 0 && typeof effects.externalRepair === 'boolean', 'EFFECTS_COVERAGE_MISSING', 'Unknown child-process effects cannot be treated as zero');
          demand(effects.semanticWrites === 0 && effects.externalRepair === false, 'UNAUTHORIZED_SEMANTIC_WRITE', 'A read-only task changed Notion semantics or required repair');
          return { semanticWrites: 0, coverage: effects.coverage, artifact: effects.artifact };
        }
        need(observed.sourceCoverage === true && Array.isArray(observed.source), 'SOURCE_COVERAGE_MISSING', 'Complete source observation is required for zero writes');
        const source = observed.source;
        demand(source.filter(row => row.phase === 'attempt').every(row => row.request_kind !== 'notion_write' && !['PATCH', 'PUT', 'DELETE'].includes(row.method)),
          'UNAUTHORIZED_SEMANTIC_WRITE', 'Source transport attempted a Notion mutation');
        need(!source.some(row => row.phase === 'unmatched_child_start'), 'CHILD_TRANSPORT_UNKNOWN', 'A descendant transport was not observed');
        for (const start of source.filter(row => row.phase === 'started')) {
          const metric = source.filter(row => row.phase === 'metrics' && row.requestId === start.requestId);
          need(metric.length === 1 && metric[0].observed === true && metric[0].complete === true &&
            Number.isSafeInteger(metric[0].total_requests) && metric[0].total_requests === source.filter(row => row.phase === 'attempt' && row.requestId === start.requestId).length,
          'SOURCE_METRICS_UNKNOWN', 'Missing or incomplete metrics cannot prove zero writes');
          need(source.some(row => row.phase === 'completed' && row.requestId === start.requestId), 'SOURCE_OPERATION_INCOMPLETE', 'Source operation did not finish');
        }
        for (const call of shared.attempts.values()) {
          const readOnly = ['read', 'grep', 'find', 'ls', 'notion_list', 'notion_use'].includes(call.name) ||
            call.name === 'notion_ctl' && object(call.arguments) && (call.arguments.working_set === 'show' || nonempty(call.arguments.cli_source)) &&
            Object.keys(call.arguments).every(key => ['working_set', 'cli_source'].includes(key));
          need(readOnly, 'TOOL_EFFECTS_UNKNOWN', 'An executed tool can write but its effects were not independently observed', { tool: call.name, toolCallId: call.id });
        }
        return { semanticWrites: 0, coverage: 'complete-subject-SDK-and-read-only-tool-attempts', backgroundCatalogRequests: source.filter(row => row.phase === 'started' && row.operation === 'list').length };
      }
      default: throw new EvidenceError('blocked', 'ASSERTION_UNSUPPORTED', 'Unsupported assertion ' + expected.kind);
    }
  });
  const businessKinds = new Set(['output', 'clarification', 'business-readback']);
  const business = assertions.filter(item => businessKinds.has(item.kind));
  return { version: 1, turnId: turn.id, status: statusOf(assertions), assertions,
    business: { status: business.length ? statusOf(business) : 'not_run' },
    contract: { status: statusOf(assertions.filter(item => !businessKinds.has(item.kind))) },
    efficiency: { actualToolAttempts: shared.attempts.size, failedToolAttempts: [...shared.attempts.values()].filter(call => call.result?.isError).length,
      providerRequests: shared.delivery?.requests.length ?? null, usage: shared.delivery?.usage ?? null,
      accounting: 'one terminal usage per actual request; native/stdout copies are not summed' },
    delivery: shared.delivery ? { requests: shared.delivery.requests.map(({ usage, selection, ...row }) => row),
      lastPayloadSha256: shared.delivery.last.sha256 } : null,
    session: observed.session ? { sessionId: observed.session.sessionId, leafId: observed.session.leafId,
      branchSha256: observed.session.branchSha256, currentUserId: observed.session.currentUserId } : null };
}
