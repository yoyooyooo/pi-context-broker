import assert from 'node:assert/strict';
import { parseNativeReference, hasExactNativeOwner, nativeReferenceLibrary, nativeSkillId } from '../packages/context-broker/src/native-reference.ts';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { providerApplicationCompletion } from './skill-consumption-provider.mjs';
import { verifyNotionAgentDirectoryInventory } from './notion-agent-inventory-evidence.mjs';
import { isAgentSourceHandoff } from './notion-agent-source-handoff.mjs';
import { validateAgentAssertion, validateAgentBindings } from './notion-agent-scenarios.mjs';
import { correlateNotionAgentToolAttempts, inspectNotionAgentReadOnlyContainer, inspectedCompactReadImplementation, inspectedLocalReadEvidence, inspectedPiToolRuntime, verifyObservedPiToolRuntime } from './notion-agent-tool-lineage.mjs';
import { verifyPreparationEvidence, visibleDiscoveryCards } from './skill-preparation-evidence.mjs';
import { parseSourceObservation } from './skill-consumption-source-observer.mjs';
import { verifyNotionAgentCliProcesses, verifyNotionAgentSingleProjectionRestore, verifyNotionAgentOriginalSourceResume } from './notion-agent-cli-process.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const textOf = content => typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
  .filter(part => part?.type === 'text').map(part => part.text).join('\n');
const sessionTypes = new Set(['message', 'thinking_level_change', 'model_change', 'usage', 'compaction',
  'branch_summary', 'custom', 'label', 'session_info', 'custom_message', 'context_edit']);
const roles = new Set(['system', 'user', 'assistant', 'toolResult', 'custom', 'bashExecution', 'branchSummary', 'compactionSummary']);

// This view is for semantic inspection only. The original serialized payload
// remains the source of every wire hash, byte count and body-oracle measurement.
function providerPayloadView(payload, api, session, responseEntryId) {
  if (api !== 'openai-responses') {
    need(api === undefined || api === 'openai-completions', 'TRANSPORT_UNSUPPORTED', 'Unknown provider input protocol');
    return payload;
  }
  need(Array.isArray(payload.input) && payload.messages === undefined, 'RESPONSES_INPUT_UNPROVEN',
    'Responses delivery needs its original input item array');
  const reply = session?.assistantMessages?.filter(row => row.active && row.entryId === responseEntryId) ?? [];
  need(reply.length === 1 && reply[0].api === 'openai-responses', 'RESPONSES_NATIVE_BOUNDARY_MISSING',
    'Responses input must be bound to its one actual native response');
  const messages = [], calls = new Map(), outputs = new Set();
  const content = value => {
    need(typeof value === 'string' || Array.isArray(value), 'RESPONSES_CONTENT_UNPROVEN', 'Retain the complete Responses content');
    return typeof value === 'string' ? value : value.map(part =>
      ['input_text', 'output_text'].includes(part?.type) ? { ...part, type: 'text' } : part);
  };
  for (const item of payload.input) {
    need(object(item), 'RESPONSES_INPUT_UNPROVEN', 'Each Responses input item must be an object');
    if (item.type === 'function_call') {
      let argumentsValue;
      try { argumentsValue = JSON.parse(item.arguments); } catch { /* Reject below without retaining private arguments. */ }
      const nativeId = nonempty(item.call_id) && nonempty(item.id) ? item.call_id + '|' + item.id : undefined;
      const native = session?.attempts?.filter(call => call.active && call.id === nativeId) ?? [];
      const assistant = native.length === 1 ? session.branchEntries.find(row => row.id === native[0].assistantEntryId)?.message : undefined;
      need(nonempty(nativeId) && !item.call_id.includes('|') && /^fc_[A-Za-z0-9_-]+$/u.test(item.id)
        && !calls.has(item.call_id) && native.length === 1 && native[0].name === item.name
        && object(argumentsValue) && isDeepStrictEqual(native[0].arguments, argumentsValue)
        && assistant?.api === 'openai-responses' && native[0].callLine < reply[0].line
        && session.contributions.some(row => row.entryId === native[0].assistantEntryId && row.role === 'assistant'),
      'RESPONSES_TOOL_IDENTITY_UNPROVEN', 'A Responses call must match the complete retained native ID, name and original arguments');
      calls.set(item.call_id, native[0]);
    } else if (item.type === 'function_call_output') {
      const call = calls.get(item.call_id);
      const terminal = call && session.branchEntries.find(row => row.id === call.resultEntryId)?.message;
      need(call && call.resultLine < reply[0].line && !outputs.has(item.call_id) && terminal?.role === 'toolResult' && terminal.toolCallId === call.id
        && session.contributions.some(row => row.entryId === call.resultEntryId && row.role === 'toolResult'),
      'RESPONSES_TOOL_IDENTITY_UNPROVEN', 'A Responses output needs its preceding exact call and retained native result');
      outputs.add(item.call_id);
      messages.push({ role: 'tool', tool_call_id: call.id, wireToolCallId: item.call_id, content: content(item.output) });
    } else if ((item.type === undefined || item.type === 'message') && ['system', 'developer', 'user', 'assistant'].includes(item.role)) {
      messages.push({ role: item.role, content: content(item.content) });
    } else {
      need(['reasoning', 'additional_tools', 'configuration_update'].includes(item.type),
        'RESPONSES_INPUT_UNSUPPORTED', 'An unsupported Responses input item cannot silently supply delivery');
    }
  }
  const { input: _input, ...rest } = payload;
  return { ...rest, messages };
}

function projectNativeBranch(branch) {
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
  return { latestCompaction, kept, contributions };
}

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
        stopReason: message.stopReason, api: message.api, responseId: message.responseId, rawStopReason: message.rawStopReason,
        usage: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens'].map(key => [key, message.usage?.[key] ?? null])),
        content: { sha256: hash(JSON.stringify(message.content)), bytes: Buffer.byteLength(JSON.stringify(message.content)) } });
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

  const { latestCompaction, kept, contributions } = projectNativeBranch(branch);
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
export function captureNotionAgentSelection({ sessionId, leafId, branchSha256, selection, active, shortRefs }) {
  assert.ok(nonempty(sessionId) && (leafId === null || nonempty(leafId)) && digest(branchSha256));
  assert.ok(selection?.scopes instanceof Map && active?.sources instanceof Map, 'Use the actual product selection and active reducers');
  return { version: 1, sessionId, leafId, branchSha256,
    scopes: [...selection.scopes.values()].map(scope => {
      assert.ok(scope.bindings instanceof Map && scope.roots instanceof Set && Array.isArray(scope.graphs));
      return { scope: scope.scope, roots: [...scope.roots], bindings: [...scope.bindings.values()], graphLocks: scope.graphs };
    }),
    active: [...active.sources.values()],
    ...(shortRefs === undefined ? {} : (() => {
      assert.ok(shortRefs.bindings instanceof Map, 'Use the actual product short-reference reducer');
      return { shortRefs: [...shortRefs.bindings].map(([ref, target]) => ({ ref, target })) };
    })()) };
}

class EvidenceError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
const demand = (condition, code, message, details) => { if (!condition) throw new EvidenceError('failed', code, message, details); };
const need = (condition, code, message, details) => { if (!condition) throw new EvidenceError('blocked', code, message, details); };
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const libraryKey = value => typeof value === 'string' && /^[a-f0-9]{32}$/iu.test(value.replaceAll('-', ''))
  ? value.replaceAll('-', '').toLowerCase() : value;
const sameLibrary = (left, right) => nonempty(left) && nonempty(right) && libraryKey(left) === libraryKey(right);
const xmlText = value => value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
  .replace(/&#(\d+);/gu, (_match, value) => String.fromCodePoint(Number(value)));
function catalogCards(text) {
  const cards = [];
  for (const section of text.matchAll(/<ntn-skills-view-catalog>([\s\S]*?)<\/ntn-skills-view-catalog>/gu)) {
    for (const card of section[1].matchAll(/<card\b([^>]*)(?:\/>|>([\s\S]*?)<\/card>)/gu)) {
      const attributes = Object.fromEntries([...card[1].matchAll(/([a-z_]+)="([^"]*)"/gu)].map(match => [match[1], xmlText(match[2])]));
      if (attributes.name && (attributes.location || attributes.ref)) cards.push({ name: attributes.name, ref: attributes.location ?? attributes.ref });
    }
    for (const card of section[1].matchAll(/<skill>([\s\S]*?)<\/skill>/gu)) {
      const name = /<name>([\s\S]*?)<\/name>/u.exec(card[1])?.[1], ref = /<(?:location|ref)>([\s\S]*?)<\/(?:location|ref)>/u.exec(card[1])?.[1];
      if (name && ref) cards.push({ name: xmlText(name), ref: xmlText(ref) });
    }
  }
  return cards;
}
const normalized = value => String(value).normalize('NFKC').replace(/\s+/gu, ' ').toLocaleLowerCase('en-US').trim();

// A topic elsewhere in the answer cannot lend an unrelated question or a word
// such as "confirm" to this assertion. Requests for material may be imperative;
// a question mark is not required. This returns the actual matching clause.
function clarificationRequest(text, alternatives) {
  const topics = alternatives.map(normalized);
  const prose = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, '\n\n')
    .replace(/\[([^\]]+)\]\([^\n)]+\)/gu, '$1').replace(/https?:\/\/[^\s<>()]+/gu, '')
    .replace(/\*\*|__|`/gu, '').normalize('NFKC');
  const clean = value => value.replace(/^\s*(?:(?:[-*+]|\d+[.)])\s+|#{1,6}\s+)/u, '').trim();
  const matches = value => topics.filter(topic => normalized(value).includes(topic));
  const negated = value => /(?:不需要|无需|不用|不必|不要|别再|不知道|不确定|无法确认)|\b(?:do not|does not|don't|doesn't|need not|needn't|must not|mustn't|should not|shouldn't|no need|not required|not necessary)\b/iu.test(value);
  const definition = value => /(?:字段说明|用于|用来|表示|代表|指的是|例如|比如|示例|举例)|\b(?:means|represents|describes|for example)\b/iu.test(value);
  const sequenceLead = /^(?:首先|接下来|随后|然后|先|再)\s*/u;
  const imperative = value => {
    // Timing may precede or follow politeness. It changes neither the requested
    // topic nor negation, which is checked on the original clause below.
    const request = value.replace(sequenceLead, '')
      .replace(/^(?:请|麻烦|劳烦)(?:你|您)?\s*/u, '').replace(sequenceLead, '');
    return /^(?:告诉我|给我|发给我|发我|提供|补充|上传|发送|分享|确认|选择|告知|说明)/u.test(request)
      || /^(?:(?:你|您)?(?:可以|需要)?\s*)?(?:把|将).+(?:发(?:送)?|传|贴|交)(?:给)?我/u.test(request)
      || /^(?:需要|希望)(?:你|您)(?:提供|补充|告诉我|给我|发给我)/u.test(request)
      || /^(?:please\s+)?(?:tell me|send me|give me|provide|share|specify|choose|confirm)\b/iu.test(value)
      || /^(?:can|could|would|will)\s+you\s+(?:tell|send|give|provide|share|specify|choose|confirm)\b/iu.test(value);
  };
  const form = value => {
    if (negated(value)) return null;
    if (imperative(value)) return 'request';
    const tail = normalized(value.replace(sequenceLead, '')).replace(/[:：]\s*$/u, '');
    const statement = /^(?:我|我们)(?:已经|已)?(?:知道|了解|明确|确定)/u.test(tail);
    const implicitQuestion = /(?:哪(?:里|儿)?|什么|多少|何时|何处)$/u.test(tail)
      || /^(?:是否|能否|可否|如何|怎么|怎样)/u.test(tail)
      || /(?:哪个|哪份|哪种|哪些|什么|多少)/u.test(tail) && matches(value).some(topic => tail.endsWith(topic));
    if (!statement && !definition(value) && (/[?？]/u.test(value) || implicitQuestion
      || /^(?:which|what|where|when|how)\b/iu.test(value))) return 'question';
    return null;
  };
  for (const block of prose.split(/\n\s*\n/u)) {
    const lines = block.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const header = clean(lines[index]);
      if (!/:\s*$/u.test(header) || form(header) !== 'request') continue;
      for (const line of lines.slice(index + 1)) {
        if (!/^\s*(?:[-*+]|\d+[.)])\s+/u.test(line)) break;
        const item = clean(line), found = matches(item);
        if (found.length && !negated(item)) return { form: 'request-list', text: header + '\n' + item, topics: found };
      }
    }
    for (const sentence of block.split(/(?<=[。！？!?；;\n])|(?<=\.)\s+/u)) {
      for (const part of sentence.split(/[，,]/u)) {
        const clause = clean(part), found = matches(clause), kind = form(clause);
        if (found.length && kind) return { form: kind, text: clause, topics: found };
      }
    }
  }
  return null;
}

const statusOf = items => items.some(item => item.status === 'failed') ? 'failed' : items.some(item => item.status === 'blocked') ? 'blocked' : 'passed';
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

async function retainedToolHistory(record, readArtifact) {
  need(record?.version === 1 && Array.isArray(record.artifacts) && record.artifacts.length > 0,
    'TOOL_HISTORY_MISSING', 'Reusing a retained read needs its sealed actual tool observations');
  const rows = [], sources = new Map(), paths = new Set();
  for (const artifact of record.artifacts) {
    need(!paths.has(artifact.path), 'TOOL_HISTORY_DUPLICATED', 'A historical observer artifact was supplied twice');
    paths.add(artifact.path);
    const text = (await verifiedArtifact(artifact, readArtifact)).toString('utf8');
    need(text.endsWith('\n'), 'TOOL_HISTORY_INCOMPLETE', 'Retain the complete historical observer JSONL');
    const events = text.trimEnd().split('\n').map(JSON.parse), first = events[0], last = events.at(-1);
    need(first?.phase === 'task_observer_start' && last?.phase === 'task_observer_end'
      && last.complete === true && last.errors === 0 && Number.isSafeInteger(first.pid) && first.pid > 0,
    'TOOL_HISTORY_INCOMPLETE', 'The historical task observer did not start and finish completely');
    let previous = null, time = 0n;
    for (const [index, event] of events.entries()) {
      const { eventSha256, ...body } = event;
      demand(event.sequence === index + 1 && event.previousSha256 === previous && event.pid === first.pid
        && digest(eventSha256) && hash(JSON.stringify(body)) === eventSha256,
      'TOOL_HISTORY_CHANGED', 'The historical observer chain or process identity changed');
      need(/^\d+$/u.test(event.monotonicNs ?? '') && BigInt(event.monotonicNs) >= time,
        'TOOL_HISTORY_CLOCK_MISSING', 'Historical callbacks need their actual ordered process clock');
      previous = eventSha256; time = BigInt(event.monotonicNs);
      if (['tool_call', 'tool_result'].includes(event.phase)) { rows.push(event); sources.set(event, artifact); }
    }
  }
  return { rows, sources };
}

// The caller supplies a fully correlated native child, verified Pi runtime and
// Broker owner, and the hash-bound branch of this exact provider request.
// SDK identity comes from the original same-segment read, never body equality.
export async function verifyNotionAgentNestedResourceRead({ call, parent, brokerOwner, runtimeEvidence,
  branch, branchArtifact, taskArtifact, sdkSegment, payload, frozenBodies, readArtifact }) {
  const requireProof = (condition, message) => need(condition, 'NESTED_RESOURCE_PROOF_MISSING', message, { toolCallId: call.id });
  requireProof(call.name === 'read' && call.provenance?.kind === 'native-nested-summary'
    && call.parentToolCallId === parent?.id && parent.name === 'codemode' && parent.container?.complete === true,
  'A resource read needs its complete native code-mode parent and actual callbacks');
  const source = call.event.toolSource;
  requireProof(source && ['path', 'source', 'scope', 'origin', 'baseDir'].every(key => source[key] === brokerOwner.source[key]),
    'The actual read must belong to the verified frozen Broker');
  for (const item of [call, parent]) {
    const runtime = runtimeEvidence.get(item.id), implementation = inspectedPiToolRuntime(item.event.toolRuntime);
    requireProof(implementation && runtime && isDeepStrictEqual(runtime.implementation, implementation)
      && runtime.toolCallId === item.id && runtime.toolName === item.name
      && runtime.pid === item.event.pid && runtime.inputSha256 === item.event.inputSha256
      && item.result?.isError === false && item.native?.isError === false,
    'The child and parent need their own verified runtime and successful results');
  }
  const callIndex = branch.findIndex(entry => entry.id === parent.native.assistantEntryId);
  const resultIndex = branch.findIndex(entry => entry.id === parent.native.resultEntryId);
  requireProof(callIndex >= 0 && resultIndex > callIndex, 'The original native call and result must remain on this request branch');
  const prior = branch.slice(0, callIndex);
  const refs = ref => prior.filter(entry => entry.type === 'custom' && entry.customType === 'context-broker-short-ref'
    && entry.data?.version === 1 && entry.data.ref === ref);
  requireProof(/^sr:R[A-Za-z0-9_-]{22}$/u.test(call.arguments?.path ?? '')
    && Object.keys(call.arguments).every(key => key === 'path'), 'Only the complete original single-resource short-ref read is covered');
  const resources = refs(call.arguments.path), resource = resources[0]?.data.target;
  requireProof(resources.length === 1 && resource?.kind === 'resource', 'The resource short ref must exist uniquely before the native call');
  const owners = refs(resource.owner), selected = owners[0]?.data.target, identity = selected?.identity;
  requireProof(owners.length === 1 && selected?.kind === 'selected' && identity?.source === 'notion'
    && digest(identity.scope) && /^s_[a-f0-9]{64}$/u.test(selected.snapshot_id ?? '') && digest(selected.version_id),
  'The resource must name one complete pre-call Notion selection');
  const fixed = parseNativeReference(resource.ref), main = parseNativeReference(selected.ref);
  requireProof(hasExactNativeOwner(fixed) && fixed.selector === identity.id && fixed.path === resource.path
    && fixed.snapshot === selected.snapshot_id && main.selector === identity.id && main.snapshot === selected.snapshot_id
    && main.path === selected.entrypoint && nativeReferenceLibrary(fixed) === identity.locator?.library_id
    && nonempty(resource.file_id) && digest(resource.sha256) && Number.isSafeInteger(resource.bytes) && resource.bytes > 0,
  'The selected owner and resource must retain their exact fixed identity and file binding');
  const frozen = frozenBodies.get(resource.sha256);
  requireProof(frozen && frozen.bytes === resource.bytes, 'The original resource needs the independently frozen complete body');

  requireProof(isDeepStrictEqual(sdkSegment?.tasks, taskArtifact), 'SDK evidence must name this exact historical task segment');
  const sdkText = (await verifiedArtifact(sdkSegment.sdk, readArtifact)).toString('utf8');
  requireProof(sdkText.endsWith('\n'), 'Retain the complete SDK observation');
  const sdk = sdkText.trimEnd().split('\n').map(JSON.parse);
  const pid = call.event.pid, first = sdk[0], last = sdk.at(-1);
  requireProof(Number.isSafeInteger(pid) && pid > 0 && call.result.pid === pid && parent.event.pid === pid && parent.result.pid === pid
    && first?.phase === 'sdk-observer-start' && first.pid === pid && last?.phase === 'sdk-observer-end' && last.pid === pid
    && last.pending === 0 && sdk.filter(row => row.phase === 'sdk-observer-start').length === 1
    && sdk.filter(row => row.phase === 'sdk-observer-end').length === 1 && !sdk.some(row => row.phase === 'sdk-observer-error'),
  'The SDK and complete native callbacks must belong to one original process');
  const clock = value => { requireProof(/^\d+$/u.test(value ?? ''), 'The actual original monotonic clock is required'); return BigInt(value); };
  const from = clock(call.event.monotonicNs), to = clock(call.result.monotonicNs);
  requireProof(clock(parent.event.monotonicNs) < from && from < to && to < clock(parent.result.monotonicNs),
    'The child must finish inside the actual parent window');
  const reads = sdk.filter(row => row.phase === 'sdk-start' && row.operation === 'read'
    && row.pid === pid && clock(row.monotonic_ns) >= from && clock(row.monotonic_ns) <= to);
  requireProof(reads.length === 1, 'Exactly one SDK read may supply this child result');
  const start = reads[0], ends = sdk.filter(row => row.phase === 'sdk-end' && row.requestId === start.requestId);
  requireProof(sdk.filter(row => row.phase === 'sdk-start' && row.requestId === start.requestId).length === 1 && ends.length === 1,
    'The original SDK request needs one start and end');
  const end = ends[0];
  requireProof(end.operation === 'read' && end.pid === pid && end.status === 'completed' && end.resultObserved === true
    && clock(end.monotonic_ns) >= clock(start.monotonic_ns) && clock(end.monotonic_ns) <= to,
  'The successful SDK read must complete within the same child window');
  const sourceObservation = parseSourceObservation((await verifiedArtifact(sdkSegment.source, readArtifact)).toString('utf8'));
  requireProof(sourceObservation.complete === true && sourceObservation.errors.length === 0 && sourceObservation.events[0]?.pid === pid,
    'Retain this process segment complete source observation and clock');
  const sourceRows = sourceObservation.events.filter(row => row.requestId === 'sdk:' + pid + ':' + start.requestId);
  const starts = sourceRows.filter(row => row.phase === 'started'), completions = sourceRows.filter(row => row.phase === 'completed');
  requireProof(starts.length === 1 && completions.length === 1, 'The SDK request must have its exact original source observation');
  for (const [row, counterpart] of [[starts[0], start], [completions[0], end]]) {
    requireProof(row.kind === 'sdk' && row.operation === 'read' && row.pid === pid
      && row.sourceMonotonicNs === counterpart.monotonic_ns && nonempty(row.source_id)
      && row.library === nativeReferenceLibrary(fixed) && clock(row.monotonicNs) >= from && clock(row.monotonicNs) <= to,
    'Source identity and both clocks must agree with this same-segment SDK read');
  }
  requireProof(starts[0].source_id === completions[0].source_id && completions[0].status === 'completed',
    'Source start and completion must name the same successful owner');
  const responses = (sdkSegment.responses ?? []).filter(row => row.requestId === start.requestId);
  requireProof(responses.length === 1 && end.responseFile === start.requestId + '.json'
    && responses[0].artifact.path === join(dirname(sdkSegment.sdk.path), 'sdk-responses', end.responseFile),
  'Retain the exact response file named by the original SDK end');
  const responseArtifact = responses[0].artifact;
  const receipt = JSON.parse((await verifiedArtifact(responseArtifact, readArtifact)).toString('utf8'));
  const value = receipt.value, output = receipt.outputEvidence;
  requireProof(receipt.version === 2 && receipt.transport === 'sdk' && receipt.operation === 'read'
    && receipt.requestId === start.requestId && receipt.status === 'completed' && receipt.resultObserved === true,
  'The sealed SDK response must be the actual complete read result');
  requireProof(value?.record?.id === identity.id && isDeepStrictEqual(value.record.locator, identity.locator)
    && value.scope === identity.scope && value.snapshot_id === selected.snapshot_id && value.version_id === selected.version_id
    && value.path === resource.path && value.ref === resource.ref && value.sha256 === resource.sha256 && value.bytes === resource.bytes
    && value.entrypoint_sha256 === selected.body_sha256 && value.entrypoint === selected.entrypoint
    && value.freshness?.policy === 'pinned',
  'The SDK response must match the full pre-call owner, scope, version, path and source bytes');
  const files = value.file_bindings?.filter(file => file.path === resource.path) ?? [];
  requireProof(files.length === 1 && files[0].file_id === resource.file_id && nonempty(files[0].page_id),
    'The SDK response must retain the original exact File binding');
  requireProof(output?.path === value.output && output.sha256 === resource.sha256 && output.bytes === resource.bytes
    && output.content === frozen.text && Buffer.byteLength(output.content) === output.bytes && hash(output.content) === output.sha256,
  'Use the already observed complete SDK output, never reopen the Store or infer bytes from a directory');
  const readContent = async item => {
    const bytes = await verifiedArtifact(item.result.contentArtifact, readArtifact);
    requireProof(item.result.content?.sha256 === hash(bytes) && item.result.content.bytes === bytes.length,
      'The sealed result must match its original callback content identity');
    const content = JSON.parse(bytes.toString('utf8'));
    requireProof(Array.isArray(content) && content.every(part => part.type === 'text' && typeof part.text === 'string'),
      'This proof covers complete text results only');
    return content;
  };
  const childContent = await readContent(call), parentContent = await readContent(parent);
  requireProof(textOf(childContent) === output.content, 'The child result must contain precisely the full SDK resource body');
  requireProof(isDeepStrictEqual(parentContent, branch[resultIndex]?.message?.content),
    'The parent callback must equal its complete retained native result');
  const messages = (payload.messages ?? []).map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'tool' && message.tool_call_id === parent.id);
  requireProof(messages.length === 1 && textOf(messages[0].message.content) === textOf(parentContent),
    'The actual outer provider message must equal this exact parent native result');
  const text = textOf(parentContent), offset = text.indexOf(output.content);
  requireProof(offset >= 0 && text.indexOf(output.content, offset + 1) < 0,
    'The parent must deliver one complete unmodified copy of this proven child body');
  return { owner: identity.id, scope: identity.scope, snapshot_id: selected.snapshot_id, version_id: selected.version_id,
    path: resource.path, sha256: resource.sha256, bytes: resource.bytes, purpose: 'resource',
    messageIndex: messages[0].index, toolCallId: parent.id, content: { sha256: hash(text), bytes: Buffer.byteLength(text) },
    delivery: { start: offset, end: offset + output.content.length, encoding: 'raw' },
    native: { kind: 'nested-sdk-resource', toolCallId: call.id, rootToolCallId: parent.id,
      callEntryId: parent.native.assistantEntryId, resultEntryId: parent.native.resultEntryId,
      resourceEntryId: resources[0].id, ownerEntryId: owners[0].id, branchArtifact, taskArtifact,
      sdkArtifact: sdkSegment.sdk, sourceArtifact: sdkSegment.source, responseArtifact,
      requestId: start.requestId, pid, clockId: sourceObservation.events[0].clockId,
      startedNs: start.monotonic_ns, endedNs: end.monotonic_ns,
      childResultArtifact: call.result.contentArtifact, parentResultArtifact: parent.result.contentArtifact,
      brokerOwner, runtimeProfile: runtimeEvidence.get(call.id).implementation.profile } };
}

async function observedCandidateCli(observed, readArtifact) {
  const record = observed.cliProcesses, implementation = observed.implementation;
  need(record?.version === 1 && Array.isArray(record.artifacts) && implementation?.version === 1,
    'CLI_PROCESS_OBSERVATION_MISSING', 'Actual CLI execution requires sealed process and candidate artifacts');
  const candidate = JSON.parse((await verifiedArtifact(implementation.candidateArtifact, readArtifact)).toString('utf8'));
  const config = JSON.parse((await verifiedArtifact(implementation.configArtifact, readArtifact)).toString('utf8'));
  need(candidate?.version === 1 && Array.isArray(candidate.baseline) && Array.isArray(candidate.cliFiles) &&
    Array.isArray(candidate.sourceTuple) && isAbsolute(config.brokerRoot ?? '') && isAbsolute(config.cliRoot ?? ''),
    'CLI_CANDIDATE_IDENTITY_MISSING', 'The actual candidate must bind its paired standalone and embedded CLI');
  for (const name of ['broker', 'cli']) {
    const owners = candidate.sourceTuple.filter(item => item.repository === name);
    need(owners.length === 1 && /^[a-f0-9]{40}$/u.test(owners[0].commit ?? '') &&
      owners[0].dirty === false && digest(owners[0].tree_sha256), 'CLI_CANDIDATE_IDENTITY_MISSING',
    'Both paired source trees must be clean and frozen');
  }
  const expectedEntries = [];
  for (const [files, path] of [[candidate.baseline, join(config.brokerRoot, 'dist/ntn-skills.mjs')],
    [candidate.cliFiles, join(config.cliRoot, 'dist/ntn-skills.js')]]) {
    const matches = files.filter(file => file.path === path);
    need(matches.length === 1 && isAbsolute(matches[0].realpath ?? ''), 'CLI_CANDIDATE_IDENTITY_MISSING',
      'Each actual CLI package must identify its precise executable entry');
    await verifiedArtifact(matches[0], readArtifact); expectedEntries.push(matches[0]);
  }
  const window = record.window, validNs = value => typeof value === 'string' && /^\d+$/u.test(value);
  need(validNs(window?.startNs) && validNs(window?.endNs) && BigInt(window.endNs) >= BigInt(window.startNs),
    'CLI_TURN_WINDOW_MISSING', 'CLI execution needs the actual completed turn interval');
  need(observed.tasks.filter(row => validNs(row.monotonicNs)).every(row =>
    BigInt(row.monotonicNs) >= BigInt(window.startNs) && BigInt(row.monotonicNs) <= BigInt(window.endNs)),
    'CLI_TURN_WINDOW_MISMATCH', 'The process interval must cover this turn’s actual tool and provider observations');
  const sourceObservation = parseSourceObservation((await verifiedArtifact(record.sourceArtifact, readArtifact)).toString('utf8'));
  need(sourceObservation.complete === true && sourceObservation.errors.length === 0,
    'CLI_PARENT_SOURCE_UNVERIFIED', 'The complete parent source ledger must be independently verified');
  const processFiles = await Promise.all(record.artifacts.map(async artifact =>
    ({ artifact, contents: await verifiedArtifact(artifact, readArtifact) })));
  const input = { sourceObservation, processFiles, expectedEntries };
  // Check the whole real process segment before counting this turn. A wrong
  // candidate outside a prompt window cannot disappear from the run’s identity.
  const segment = verifyNotionAgentCliProcesses(input);
  if (segment.status !== 'passed') {
    const issue = segment.diagnostics.find(item => item.severity === segment.status) ?? segment.diagnostics[0];
    throw new EvidenceError(segment.status, issue?.code ?? 'CLI_PROCESS_UNPROVEN',
      'Actual CLI process identity differs or remains unproved', segment);
  }
  const current = verifyNotionAgentCliProcesses({ ...input, window });
  if (current.status !== 'passed') {
    const issue = current.diagnostics.find(item => item.severity === current.status) ?? current.diagnostics[0];
    throw new EvidenceError(current.status, issue?.code ?? 'CLI_PROCESS_UNPROVEN',
      'This turn’s actual CLI process identity remains unproved', current);
  }
  return { ...current, window, segmentCliCount: segment.cliCount, sourceArtifact: record.sourceArtifact };
}

async function observedBrokerToolOwner(observed, readArtifact) {
  const implementation = observed.implementation;
  need(implementation?.version === 1, 'TOOL_IMPLEMENTATION_UNKNOWN', 'Broker effects need the actual frozen candidate identity');
  const candidate = JSON.parse((await verifiedArtifact(implementation.candidateArtifact, readArtifact)).toString('utf8'));
  const config = JSON.parse((await verifiedArtifact(implementation.configArtifact, readArtifact)).toString('utf8'));
  need(candidate?.version === 1 && isAbsolute(config?.brokerRoot ?? '') && Array.isArray(candidate.baseline) &&
    Array.isArray(candidate.sourceTuple), 'TOOL_IMPLEMENTATION_UNKNOWN', 'The candidate and configuration must identify the executed Broker');
  const root = resolve(config.brokerRoot), selected = candidate.sourceTuple.filter(item => item.repository === 'broker');
  need(selected.length === 1 && /^[a-f0-9]{40}$/u.test(selected[0].commit ?? '') && selected[0].dirty === false && digest(selected[0].tree_sha256),
    'TOOL_IMPLEMENTATION_UNKNOWN', 'The Broker tool owner must be the clean frozen candidate');
  const entry = candidate.baseline.filter(item => item.path === join(root, 'src/index.ts'));
  const manifest = candidate.baseline.filter(item => item.path === join(root, 'package.json'));
  need(entry.length === 1 && manifest.length === 1, 'TOOL_IMPLEMENTATION_UNKNOWN', 'The candidate must bind one Broker entry and package');
  await verifiedArtifact(entry[0], readArtifact);
  const pkg = JSON.parse((await verifiedArtifact(manifest[0], readArtifact)).toString('utf8'));
  need(pkg.name === 'pi-context-broker' && Array.isArray(pkg.pi?.extensions) && pkg.pi.extensions.includes('./src/index.ts'),
    'TOOL_IMPLEMENTATION_UNKNOWN', 'The selected package must register the actual Broker entry');
  const commands = JSON.parse((await verifiedArtifact(observed.visibility?.nativeCommands, readArtifact)).toString('utf8'));
  need(Array.isArray(commands), 'TOOL_IMPLEMENTATION_UNKNOWN', 'Broker effects require the observed host command registration');
  const registrations = commands.filter(command => command.name === 'context-broker');
  const source = registrations[0]?.sourceInfo;
  let resolvedSource = source?.source, ordinaryInstallation;
  if (implementation.ordinaryInstallationArtifact !== undefined) {
    const artifact = implementation.ordinaryInstallationArtifact;
    const binding = JSON.parse((await verifiedArtifact(artifact, readArtifact)).toString('utf8'));
    const settings = candidate.before?.settings;
    need(binding?.version === 1 && binding.kind === 'ordinary-pi-package-binding' && source?.scope === 'user'
      && isAbsolute(binding.settingsDirectory ?? '') && isAbsolute(settings?.path ?? '')
      && settings.path === join(binding.settingsDirectory, 'settings.json')
      && digest(settings.sha256) && Number.isSafeInteger(settings.bytes) && settings.bytes > 0
      && isDeepStrictEqual(binding.settings, settings),
    'TOOL_IMPLEMENTATION_UNKNOWN', 'Ordinary package resolution needs the frozen user settings directory and identity');
    const selectedPackage = binding.package;
    const rawSettings = JSON.parse((await verifiedArtifact(settings, readArtifact)).toString('utf8'));
    const packages = rawSettings.packages;
    const sourceSpec = value => typeof value === 'string' ? value : value?.source;
    const localSource = value => typeof value === 'string' && (isAbsolute(value) || /^\.{1,2}\//u.test(value));
    need(Array.isArray(packages) && Number.isSafeInteger(selectedPackage?.index) && selectedPackage.index >= 0
      && selectedPackage.index < packages.length && selectedPackage.count === packages.length
      && selectedPackage.index === (config.packageIndex ?? 1) && localSource(selectedPackage.source)
      && selectedPackage.source === source.source && sourceSpec(packages[selectedPackage.index]) === source.source
      && packages.filter(value => localSource(sourceSpec(value))
        && resolve(binding.settingsDirectory, sourceSpec(value)) === root).length === 1,
    'TOOL_IMPLEMENTATION_UNKNOWN', 'The ordinary binding must retain the unique actual settings package slot and source');
    // Pi resolves a user package relative to settings.json, not the package's
    // own sourceInfo.baseDir. Keep the original source spelling as evidence.
    resolvedSource = resolve(binding.settingsDirectory, selectedPackage.source);
    ordinaryInstallation = { artifact, settingsDirectory: binding.settingsDirectory, packageIndex: selectedPackage.index };
  }
  need(registrations.length === 1 && source?.origin === 'package' && ['project', 'user'].includes(source.scope) &&
    source.baseDir === root && resolvedSource === root && source.path === entry[0].path,
  'TOOL_IMPLEMENTATION_UNKNOWN', 'The live host must register this exact frozen Broker package');
  return { source, commit: selected[0].commit, entrySha256: entry[0].sha256,
    ...(ordinaryInstallation ? { ordinaryInstallation } : {}) };
}

// All bytes cross the same artifact boundary as other observed tool results.
// The pure lineage check still validates the original native call, exact
// transformation, current-turn receipt and immutable owner/File relationship.
export async function observedPreparedReads(observed, readArtifact) {
  const reads = new Map(); let brokerOwner;
  for (const observation of observed.tasks.filter(row => row.phase === 'prepared_read')) {
    const event = observed.tasks.find(row => row.phase === 'tool_call' && row.toolCallId === observation.toolCallId);
    const result = observed.tasks.find(row => row.phase === 'tool_result' && row.toolCallId === observation.toolCallId);
    const reader = inspectedCompactReadImplementation(event);
    need(reader && result && !reads.has(observation.toolCallId), 'TOOL_IMPLEMENTATION_UNKNOWN',
      'Prepared read evidence needs the exact reviewed actual reader implementation');
    for (const file of reader.files) await verifiedArtifact(file.artifact, readArtifact);
    brokerOwner ??= await observedBrokerToolOwner(observed, readArtifact);
    const inputBytes = await verifiedArtifact(observation.inputArtifact, readArtifact);
    const body = await verifiedArtifact(observation.file?.artifact, readArtifact);
    const manifest = observation.projection === 'resource' ? undefined
      : JSON.parse((await verifiedArtifact(observation.manifest?.artifact, readArtifact)).toString('utf8'));
    const contentBytes = await verifiedArtifact(result.contentArtifact, readArtifact);
    demand(hash(inputBytes) === result.inputSha256 && hash(contentBytes) === result.content?.sha256
      && contentBytes.length === result.content.bytes, 'PREPARED_READ_ARTIFACT_CHANGED',
    'The sealed prepared input and tool result must match their actual callback hashes');
    reads.set(observation.toolCallId, { observation, brokerOwner, input: JSON.parse(inputBytes.toString('utf8')),
      manifest, body, content: JSON.parse(contentBytes.toString('utf8')) });
  }
  return reads;
}

// This reviewed package has a non-TUI early return before its optional network
// notification. A name, a claimed "read-only" result, or a matching source path
// alone cannot establish that the branch ran. Changed implementations need a new
// review; this profile is deliberately not supplied by the subject or its oracle.
const askUserNoUiProfile = Object.freeze({
  id: '@yoyo/ask-user-pi:23ec9aee:no-ui',
  files: {
    'package.json': { sha256: 'd944aeac21c5c77120c4c9819d4ecbb41d8171b7abe605d5fd3a4b5b38525b27', bytes: 853 },
    'src/index.ts': { sha256: '25a275c8cb5883688808b9c2c643043f3b8e657742ce72710974a28316d12fbd', bytes: 11381 },
    'src/prompt.ts': { sha256: '231eabae6d14214ab851af666f4588f8a772a96888b655218c1cd13165cfbcda', bytes: 1833 },
    'src/notify.ts': { sha256: 'ad97c5337073c5e5567c5b6ca2f79e874163e1a3ca8aa83b396ae7082b84b4ce', bytes: 3398 },
  },
});
async function proveAskUserNoUi(call, session, readArtifact) {
  const source = call.event?.toolSource, implementation = call.event?.toolImplementation;
  need(source?.origin === 'package' && ['user', 'project'].includes(source.scope) &&
    isAbsolute(source.baseDir ?? '') && source.source === source.baseDir &&
    source.path === resolve(source.baseDir, 'src/index.ts'),
  'INTERACTION_IMPLEMENTATION_UNKNOWN', 'An interaction name is not evidence of its actual package implementation');
  need(implementation?.version === 1 && ['rpc', 'json', 'print'].includes(implementation.runtimeMode) &&
    Array.isArray(implementation.files) && implementation.files.length === Object.keys(askUserNoUiProfile.files).length,
  'INTERACTION_IMPLEMENTATION_UNKNOWN', 'The observed non-TUI invocation needs its sealed implementation and imports');
  const seen = new Set();
  for (const file of implementation.files) {
    const reviewed = askUserNoUiProfile.files[file.relativePath];
    need(reviewed && !seen.has(file.relativePath) && file.path === resolve(source.baseDir, file.relativePath) &&
      file.artifact?.sha256 === reviewed.sha256 && file.artifact.bytes === reviewed.bytes,
    'INTERACTION_IMPLEMENTATION_UNKNOWN', 'Only the reviewed complete implementation can establish the interaction effects');
    seen.add(file.relativePath);
    await verifiedArtifact(file.artifact, readArtifact);
  }
  const input = call.arguments;
  need(object(input) && nonempty(input.question) && Object.keys(input).every(key => ['question', 'options'].includes(key)) &&
    Array.isArray(input.options) && input.options.length >= 2 && input.options.length <= 5 &&
    input.options.every(option => object(option) && nonempty(option.label) &&
      (option.description === undefined || typeof option.description === 'string') &&
      Object.keys(option).every(key => ['label', 'description'].includes(key))),
  'INTERACTION_INPUT_UNPROVEN', 'The interaction arguments must match the reviewed parameter contract');
  need(call.provenance?.kind === 'native-tool-call' && call.native?.isError === false && call.result?.isError === false,
    'INTERACTION_RESULT_UNPROVEN', 'The no-UI path needs its own completed native tool result');
  const native = session.branchEntries.find(entry => entry.id === call.native.resultEntryId)?.message;
  const expectedContent = [{ type: 'text', text: 'No interactive UI is available. Ask the user in plain text instead.' }];
  need(native?.role === 'toolResult' && native.toolName === 'ask_user' && native.toolCallId === call.id &&
    isDeepStrictEqual(native.content, expectedContent) && isDeepStrictEqual(native.details, {
      question: input.question, options: input.options.map(option => option.label), answer: null, wasCustom: false, cancelled: true,
    }),
  'INTERACTION_RESULT_UNPROVEN', 'Only the actual no-UI early return proves that the notification branch was not entered');
  const content = await verifiedArtifact(call.result.contentArtifact, readArtifact), encoded = JSON.stringify(native.content);
  demand(content.toString('utf8') === encoded && call.result.content?.sha256 === hash(content) &&
    call.result.content.bytes === content.length,
  'INTERACTION_RESULT_CHANGED', 'The native no-UI result differs from the independently observed tool result');
  return { toolCallId: call.id, profile: askUserNoUiProfile.id, runtimeMode: implementation.runtimeMode,
    resultSha256: hash(content), coverage: 'reviewed-non-TUI-return-before-notification' };
}

/** Deferred injection is persisted as a native context edit plus a machine
 * receipt. It has no context-hook message on later requests. Read only the
 * sealed branch that existed before this request's actual response. */
async function nativeSourceReceipts(artifact, session, responseEntryId, readArtifact) {
  if (artifact === undefined) return { receipts: [], rejected: [] };
  const snapshot = JSON.parse((await verifiedArtifact(artifact, readArtifact)).toString('utf8'));
  need(object(snapshot) && snapshot.sessionId === session.sessionId && snapshot.sessionId === artifact.sessionId &&
    snapshot.leafId === artifact.leafId && Array.isArray(snapshot.entries),
  'SOURCE_RECEIPT_BRANCH_MISMATCH', 'The retained source receipt needs this request\'s actual native session branch');
  const branch = session.branchEntries, leafIndex = branch.findIndex(entry => entry.id === snapshot.leafId);
  need(leafIndex >= 0 && isDeepStrictEqual(snapshot.entries, branch.slice(0, leafIndex + 1)),
    'SOURCE_RECEIPT_BRANCH_MISMATCH', 'A sibling or changed branch cannot supply source delivery identity');
  const responseIndex = branch.findIndex(entry => entry.id === responseEntryId);
  need(responseIndex > leafIndex, 'SOURCE_RECEIPT_FROM_FUTURE', 'A receipt appended after the actual response cannot prove its input');
  const { kept, contributions } = projectNativeBranch(snapshot.entries.map((value, index) => ({ value, line: index + 2 })));
  const retained = new Map(kept.map(entry => [entry.value.id, entry.value])), receipts = [], rejected = [];
  for (const { value: entry } of kept) {
    if (entry.type !== 'custom' || entry.customType !== 'context-broker' || !object(entry.data) ||
      entry.data.nativePromptSha256 === undefined) continue;
    try {
      const data = entry.data, edit = retained.get(entry.parentId);
      assert.ok(digest(data.nativePromptSha256) && Array.isArray(data.records) && data.records.length,
        'A deferred source receipt needs its complete native prompt identity and records');
      assert.ok(edit?.type === 'context_edit' && object(edit.replacement), 'A deferred source receipt must follow its native context edit');
      const user = contributions.find(row => row.entryId === edit.targetId && row.role === 'user');
      assert.ok(user && hash(textOf(edit.replacement.content)) === data.nativePromptSha256 &&
        hash(textOf(user.content)) === data.nativePromptSha256, 'The exact projected user content is no longer retained');
      receipts.push({ phase: 'receipt', customType: 'context-broker', proofs: { custom: data },
        native: { kind: 'deferred-source-projection', receiptEntryId: entry.id, contextEditEntryId: edit.id,
          userEntryId: user.entryId, nativePromptSha256: data.nativePromptSha256,
          branchArtifact: { path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes } } });
    } catch (error) { rejected.push({ receiptEntryId: entry.id, reason: error.message }); }
  }
  return { receipts, rejected, branch: snapshot.entries };
}

function boundNotionDeliveries(payload, tasks, frozenBodies) {
  const deliveries = new Map(), rejected = [];
  const decode = (text, span) => {
    assert.ok(object(span) && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) &&
      span.start >= 0 && span.end > span.start && span.end <= text.length, 'A source delivery needs its exact complete text span');
    const value = text.slice(span.start, span.end);
    if (span.encoding === 'raw') return value;
    if (span.encoding === 'json') return JSON.parse('"' + value + '"');
    if (span.encoding === 'xml') return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    throw new Error('Unknown source delivery encoding');
  };
  for (const receipt of tasks.filter(row => row.phase === 'receipt')) {
    const custom = receipt.proofs?.custom;
    for (const [index, message] of (payload.messages ?? []).entries()) {
      const text = textOf(message.content);
      const sameText = receipt.content?.sha256 === hash(text) && receipt.content.bytes === Buffer.byteLength(text);
      const matches = nonempty(receipt.toolCallId) ? message.role === 'tool' && message.tool_call_id === receipt.toolCallId && sameText
        : ['context-broker', 'skill-prompt-message'].includes(receipt.customType) && message.role === 'user' &&
          (digest(custom?.nativePromptSha256) ? custom.nativePromptSha256 === hash(text) : sameText);
      if (!matches) continue;
      const add = (binding, path, proof, span, purpose) => {
        const sha256 = proof.bodySha256 ?? proof.sha256, frozen = frozenBodies.get(sha256);
        if (!frozen) return;
        assert.ok(object(binding?.record) && nonempty(binding.record.id) && digest(binding.scope) &&
          /^s_[a-f0-9]{64}$/u.test(binding.snapshot_id) && digest(binding.version_id) && nonempty(path),
        'The delivered body needs its real logical owner, scope, version and path');
        assert.equal(proof.bytes, frozen.bytes);
        const body = decode(text, span);
        assert.equal(body, frozen.text, 'The bound source span differs from the independently frozen bytes');
        const value = { owner: binding.record.id, scope: binding.scope, snapshot_id: binding.snapshot_id,
          version_id: binding.version_id, path, sha256, bytes: frozen.bytes, purpose,
          messageIndex: index, ...(receipt.toolCallId ? { toolCallId: receipt.toolCallId } : { customType: receipt.customType }),
          content: { sha256: hash(text), bytes: Buffer.byteLength(text) }, delivery: span,
          ...(receipt.native ? { native: receipt.native } : {}) };
        deliveries.set(JSON.stringify([index, span.start, span.end, value.scope, value.owner, value.snapshot_id, path]), value);
      };
      try {
        const prepared = receipt.proofs?.contextBrokerPreparation;
        if (prepared && ['notion_use', 'skill_prepare'].includes(receipt.toolName)) {
          const result = verifyPreparationEvidence(text, prepared, receipt.toolCallId);
          for (const record of result.records.filter(record => record.mapping.state === 'source'))
            add(record.receipt.binding, record.receipt.binding.record.entrypoint, record.receipt, record.mapping.delivery, prepared.purpose);
        }
        const main = receipt.proofs?.contextBrokerRead;
        if (main && receipt.toolName === 'read' && main.toolCallId === receipt.toolCallId) {
          assert.equal(main.version, 3, 'Main inspection needs the current spanned read receipt');
          assert.equal(main.rendered?.sha256, hash(text)); assert.equal(main.rendered?.bytes, Buffer.byteLength(text));
          assert.equal(main.snapshotId, main.binding?.snapshot_id); assert.equal(main.bodySha256, main.binding?.body_sha256);
          add(main.binding, main.binding?.record?.entrypoint, main, main.delivery, main.purpose);
        }
        const resource = receipt.proofs?.contextBrokerResource;
        if (resource && receipt.toolName === 'read' && resource.toolCallId === receipt.toolCallId) {
          assert.equal(resource.version, 2); assert.equal(resource.loaded, false);
          if (Array.isArray(resource.files)) {
            assert.equal(resource.projection?.version, 1);
            assert.equal(resource.projection.compiler, 'context-broker/resource-read/v1');
            assert.equal(resource.projection.rendered?.sha256, hash(text));
            assert.equal(resource.projection.rendered?.bytes, Buffer.byteLength(text));
            const model = JSON.parse(text);
            assert.equal(model.status, 'ready'); assert.equal(model.files.length, resource.files.length);
            const binding = { record: { id: resource.selection.owner }, ...resource.selection };
            for (const [fileIndex, file] of resource.files.entries()) {
              if (file.state !== 'source' || file.encoding !== 'utf8' || file.delivered_complete_text !== true) continue;
              const rendered = model.files[fileIndex];
              assert.equal(file.index, fileIndex); assert.equal(rendered.kind, 'text');
              assert.equal(rendered.path, file.path); assert.equal(rendered.ref, file.model_ref);
              assert.equal(rendered.content, decode(text, file.delivery));
              add(binding, file.path, file, file.delivery, resource.purpose);
            }
          } else {
            assert.equal(resource.delivered_complete_text, true);
            add({ record: { id: resource.id }, scope: resource.scope, snapshot_id: resource.snapshot_id,
              version_id: resource.version_id }, resource.path, resource, resource.delivery, resource.purpose);
          }
        }
        if (custom) for (const record of custom.records ?? [custom]) {
          if (record.version !== 2 || record.loaded !== true) continue;
          assert.equal(record.snapshotId, record.binding?.snapshot_id);
          assert.equal(record.bodySha256, record.binding?.body_sha256);
          add(record.binding, record.binding?.record?.entrypoint, record, record.delivery, record.purpose);
        }
      } catch (error) {
        rejected.push({ messageIndex: index, toolCallId: receipt.toolCallId, customType: receipt.customType, reason: error.message });
      }
    }
  }
  return { deliveries: [...deliveries.values()], rejected };
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

function catalogDescriptionCards(messages) {
  const attributes = text => Object.fromEntries([...text.matchAll(/([a-z_]+)="([^"]*)"/gu)]
    .map(match => [match[1], xmlText(match[2])]));
  return messages.filter(message => ['user', 'system', 'developer'].includes(message.role)).flatMap(message =>
    [...textOf(message.content).matchAll(/<ntn-skills-view-catalog>([\s\S]*?)<\/ntn-skills-view-catalog>/gu)].flatMap(section =>
      [...section[1].matchAll(/<catalog-cards>([\s\S]*?)<\/catalog-cards>/gu)].flatMap(block =>
        [...block[1].matchAll(/<group\b([^>]*)>([\s\S]*?)<\/group>/gu)].flatMap(group => {
          const header = attributes(group[1]);
          return [...group[2].matchAll(/<card\b([^>]*?)\/>|<card\b([^>]*)>([\s\S]*?)<\/card>/gu)]
            .filter(card => card[1] === undefined).map(card => {
              const fields = attributes(card[2]);
              return { kind: header.kind, source: header.source, name: fields.name,
                ref: fields.location ?? fields.ref, description: xmlText(card[3]) };
            });
        }))));
}

// The request projector may remove a duplicate description, but the completed
// lookup's envelope and every other record field still have to reach the model.
function metadataDescriptionProjection(native, message, request, selection) {
  try {
    visibleDiscoveryCards(native);
    visibleDiscoveryCards({ ...native, content: message.content });
    const original = JSON.parse(textOf(native.content)), projected = JSON.parse(textOf(message.content));
    const witnesses = catalogDescriptionCards(request.messages ?? []), omitted = [];
    for (const [index, record] of projected.records.entries()) {
      const before = original.records[index];
      if (isDeepStrictEqual(record, before)) continue;
      const { description, ...remaining } = before;
      if (typeof description !== 'string' || !isDeepStrictEqual(record, remaining)
        || !/^sr:C[A-Za-z0-9_-]{22}$/u.test(record.ref ?? '')) return undefined;
      const full = native.details.records[index];
      const refs = (selection?.shortRefs ?? []).filter(row => row.ref === record.ref);
      if (refs.length !== 1 || !['candidate', 'selected'].includes(refs[0].target?.kind)
        || refs[0].target.identity?.source !== 'notion' || !nonempty(full.id) || !digest(full.scope)
        || refs[0].target.identity.id !== full.id || refs[0].target.identity.scope !== full.scope) return undefined;
      if (!witnesses.some(card => card.ref === record.ref && card.source === record.source
        && card.kind === record.kind && card.name === record.name && card.description === description)) return undefined;
      omitted.push({ ref: record.ref, source: record.source, kind: record.kind, name: record.name,
        owner: full.id, scope: full.scope, descriptionSha256: hash(description), descriptionBytes: Buffer.byteLength(description) });
    }
    return omitted.length ? omitted : undefined;
  } catch { return undefined; }
}

/** Prove an explicit metadata lookup from its native result, provider payload and
 * observed SDK requests. A continuation also proves the old complete miss was
 * still inside its original TTL when the same process asked again. */
export async function verifyNotionAgentMetadataLookup(expected, observed, bindings, { attempts, delivery, source, readArtifact = readFile }) {
  const item = bindings.private.objects[expected.object], sourceId = observed.visibility?.source?.sourceId;
  need(item?.kind === 'notion' && nonempty(item.name) && nonempty(sourceId),
    'METADATA_IDENTITY_MISSING', 'Metadata lookup requires the independently bound name and configured source');
  const candidates = attempts.filter(call => call.name === 'notion_list' && call.arguments?.query?.trim() === item.name &&
    (call.arguments.search_in === undefined || call.arguments.search_in === 'metadata') &&
    (call.arguments.source === undefined || call.arguments.source === sourceId) && call.result?.isError === false);
  demand(candidates.length > 0, 'NAMED_METADATA_LOOKUP_MISSING', 'The current turn did not search for the named Skill');
  const call = candidates.at(-1), native = observed.session.branchEntries.find(entry => entry.id === call.native?.resultEntryId);
  demand(call.arguments.refresh === true, 'METADATA_REFRESH_NOT_REQUESTED', 'A named availability inquiry must explicitly request fresh metadata');
  need(native?.message?.role === 'toolResult' && native.message.toolCallId === call.id && native.message.isError === false,
    'METADATA_RESULT_MISSING', 'The lookup needs its completed native result');
  const content = JSON.parse((await verifiedArtifact(call.result.contentArtifact, readArtifact)).toString('utf8'));
  demand(isDeepStrictEqual(content, native.message.content), 'METADATA_RESULT_CHANGED', 'Observed and native metadata results differ');
  const text = textOf(content), value = JSON.parse(text), freshness = value.freshness?.sources?.find(row => row.source === sourceId);
  need(value.ok === true && value.state === 'known' && Array.isArray(value.records) && Array.isArray(value.failures),
    'METADATA_RESULT_UNKNOWN', 'Lookup failure or pending state cannot prove presence or absence');
  demand(value.failures.length === 0 && value.coverage?.exhaustive === true &&
    value.coverage.sources?.find(row => row.source === sourceId)?.exhaustive === true,
  'METADATA_COVERAGE_INCOMPLETE', 'A partial directory cannot establish a complete named lookup');
  need(freshness && Number.isFinite(Date.parse(freshness.validated_at)) && Number.isFinite(freshness.age_ms) &&
    freshness.age_ms >= 0 && Number.isFinite(freshness.max_age_ms) && freshness.max_age_ms > 0,
  'METADATA_FRESHNESS_UNKNOWN', 'The original validation time and finite TTL must be observed');
  demand(freshness.stale === false && freshness.age_ms < freshness.max_age_ms,
    'METADATA_RESULT_STALE', 'The lookup returned stale metadata');
  demand(freshness.policy === 'refresh', 'METADATA_REFRESH_POLICY_MISMATCH', 'Offline or cache-eligible metadata cannot prove a current named inquiry');
  const deliveries = [], descriptionProjections = [];
  for (const payload of delivery.requests) {
    const task = observed.tasks.find(row => row.phase === 'provider_payload' && row.sha256 === payload.sha256);
    const raw = providerPayloadView(JSON.parse((await verifiedArtifact({ path: task?.payloadFile, sha256: payload.sha256, bytes: payload.bytes }, readArtifact)).toString('utf8')), payload.api, observed.session, payload.nativeResponseEntryId);
    for (const message of (raw.messages ?? []).filter(message => message.role === 'tool' && message.tool_call_id === call.deliveryToolCallId)) {
      if (textOf(message.content) === text) { deliveries.push(payload); break; }
      const descriptions = metadataDescriptionProjection(native.message, message, raw, payload.selection);
      if (descriptions) {
        deliveries.push(payload);
        descriptionProjections.push({ payloadSha256: payload.sha256, descriptions });
        break;
      }
    }
  }
  demand(deliveries.length > 0, 'METADATA_NOT_DELIVERED', 'The completed lookup was not sent to the actual model');
  const matches = value.records.filter(row => row.name === item.name && row.source === sourceId);
  if (expected.state === 'absent') {
    demand(value.records.length === 0 && value.count === 0 && value.total_count === 0 && value.has_more === false && value.next_cursor === null,
      'METADATA_EXPECTED_EMPTY', 'The initial lookup must be a complete empty result');
  } else {
    demand(matches.length === 1 && matches[0].availability === 'available', 'METADATA_TARGET_MISSING', 'The enabled target is not available in the returned metadata');
    need(nonempty(item.owner) && digest(item.scope), 'METADATA_OWNER_MISSING', 'The enabled target needs its independently read identity');
    demand(deliveries.some(payload => payload.selection?.shortRefs?.some(row => row.ref === matches[0].ref &&
      ['candidate', 'selected'].includes(row.target?.kind) && row.target.identity?.source === 'notion' &&
      row.target.identity.id === item.owner && row.target.identity.scope === item.scope)),
    'METADATA_WRONG_OWNER', 'The returned reference resolves to another Skill or source scope');
    if (expected.outsideDefaultView) demand(matches[0].in_default_view === false &&
      delivery.requests.every(payload => !catalogCards(payload.metadataText).some(card => card.name === item.name)),
    'METADATA_DEFAULT_VIEW_LEAK', 'This target must remain outside the actual default View');
  }
  const resultNs = call.result.monotonicNs, callNs = call.event.monotonicNs;
  need(/^\d+$/u.test(resultNs ?? '') && /^\d+$/u.test(callNs ?? '') && Number.isSafeInteger(call.event.pid),
    'METADATA_CALL_TIMING_MISSING', 'Lookup boundaries and the actual process must be observed');
  const proof = { object: expected.object, state: expected.state, toolCallId: call.id, resultEntryId: native.id,
    query: item.name, source: sourceId, sessionId: observed.session.sessionId, pid: call.event.pid,
    resultMonotonicNs: resultNs, freshness, records: matches.map(row => ({ ref: row.ref, name: row.name, availability: row.availability,
      in_default_view: row.in_default_view })), payloads: deliveries.map(payload => payload.sha256),
    ...(descriptionProjections.length ? { descriptionProjections } : {}) };
  if (expected.afterTurn) {
    const continuation = observed.metadataContinuation;
    need(continuation?.previous && Array.isArray(continuation.events), 'METADATA_CONTINUATION_MISSING', 'Keep the earlier turn and external event originals');
    const previous = JSON.parse((await verifiedArtifact(continuation.previous, readArtifact)).toString('utf8'));
    const before = previous.analysis?.assertions?.find(row => row.kind === 'metadata-lookup' && row.status === 'passed' &&
      row.details?.object === expected.object && row.details.state === 'absent')?.details;
    need(previous.analysis?.turnId === expected.afterTurn && before, 'METADATA_PRIOR_MISS_UNPROVEN', 'The same target needs a proved earlier complete miss');
    demand(before.sessionId === observed.session.sessionId && before.pid === call.event.pid &&
      isDeepStrictEqual(previous.observed.session.branchEntries, observed.session.branchEntries.slice(0, previous.observed.session.branchEntries.length)),
    'METADATA_SESSION_REPLACED', 'The lookup must continue the same native session and process');
    const elapsedMs = Number(BigInt(callNs) - BigInt(before.resultMonotonicNs)) / 1e6;
    need(elapsedMs >= 0 && before.freshness.age_ms + elapsedMs < before.freshness.max_age_ms,
      'METADATA_TTL_PRECONDITION_MISSED', 'The second query occurred after the old directory TTL; it cannot prove forced discovery',
      { priorAgeMs: before.freshness.age_ms, elapsedMs, maxAgeMs: before.freshness.max_age_ms });
    const events = await Promise.all(continuation.events.map(async artifact =>
      JSON.parse((await verifiedArtifact(artifact, readArtifact)).toString('utf8'))));
    const enabled = events.filter(event => event.afterTurn === expected.afterTurn && event.event?.kind === 'set-enabled' &&
      event.event.object === expected.object && event.event.enabled === true);
    need(enabled.length === 1 && events.length === 1 && enabled[0].result?.actor === 'fixture-controller' && enabled[0].result.status === 'passed',
      'METADATA_EXTERNAL_EVENT_UNPROVEN', 'Only the independent successful enable event may occur between these turns');
    const event = enabled[0], completed = event.result.completed;
    const rawEvent = JSON.parse((await verifiedArtifact(event.result.artifact, readArtifact)).toString('utf8'));
    const { artifact: _artifact, ...eventResult } = event.result;
    demand(isDeepStrictEqual(rawEvent, eventResult), 'METADATA_EVENT_CHANGED', 'The external event differs from its retained original');
    const row = rawEvent.result?.row, enabledId = bindings.private.fixture?.library?.skills?.property_ids?.Enabled;
    const enabledProperty = Object.values(row?.properties ?? {}).find(value => value.id === enabledId && enabledId !== undefined) ?? row?.properties?.Enabled;
    need(nonempty(item.pageId), 'METADATA_PAGE_IDENTITY_MISSING', 'The external event needs the independently bound target page');
    demand(row?.id === item.pageId && enabledProperty?.type === 'checkbox' && enabledProperty.checkbox === true,
      'METADATA_ENABLE_READBACK_MISMATCH', 'The external event did not read back Enabled on the same target page');
    need(/^\d+$/u.test(event.finishedNs ?? '') && BigInt(event.finishedNs) > BigInt(before.resultMonotonicNs) && BigInt(event.finishedNs) < BigInt(callNs) &&
      Number.isFinite(Date.parse(completed?.at)), 'METADATA_EVENT_TIMING_MISSING', 'External enable must complete strictly between the two lookups');
    demand(Date.parse(freshness.validated_at) > Date.parse(before.freshness.validated_at) &&
      Date.parse(freshness.validated_at) >= Date.parse(completed.at),
    'METADATA_NOT_REFRESHED', 'The returned metadata was not newly validated after the external change');
    const operations = source.filter(row => row.phase === 'started' && row.kind === 'sdk' && row.operation === 'list' && row.source_id === sourceId &&
      /^\d+$/u.test(row.monotonicNs ?? '') && BigInt(row.monotonicNs) >= BigInt(callNs) && BigInt(row.monotonicNs) <= BigInt(resultNs));
    const refreshed = operations.filter(start => source.some(row => row.requestId === start.requestId && row.phase === 'completed' && row.status === 'completed') &&
      source.some(row => row.requestId === start.requestId && row.phase === 'attempt' && row.request_kind === 'notion_metadata' && row.outcome === 'success'));
    demand(refreshed.length > 0, 'METADATA_REFRESH_HTTP_MISSING', 'A refresh flag or cache hit cannot replace actual fresh metadata requests');
    demand(isDeepStrictEqual(observed.selection.scopes, previous.observed.selection.scopes) &&
      isDeepStrictEqual(observed.selection.active, previous.observed.selection.active),
    'METADATA_CHANGED_SELECTION', 'Metadata discovery must preserve existing task selections');
    proof.continuation = { afterTurn: expected.afterTurn, previous: continuation.previous, event: event.result.artifact,
      priorAgeMs: before.freshness.age_ms, elapsedMs, maxAgeMs: before.freshness.max_age_ms, requests: refreshed.map(row => row.requestId), pinsUnchanged: true };
  }
  return proof;
}

/** A remote match is evidence of discovery, never a fixed-content read or a complete absence proof. */
export async function verifyNotionAgentContentSearch(expected, observed, bindings, { attempts, delivery, source, readArtifact = readFile }) {
  const item = bindings.private.objects[expected.object], body = bindings.private.bodies[expected.body];
  const query = bindings.public[expected.query], configuredSource = observed.visibility?.source;
  need(item?.kind === 'notion' && nonempty(item.owner) && digest(item.scope) && nonempty(item.pageId) &&
    body?.object === expected.object && nonempty(query) && nonempty(configuredSource?.sourceId),
  'CONTENT_FIXTURE_IDENTITY_MISSING', 'Content discovery needs its independently bound owner, body and public query');
  const sourceId = configuredSource.sourceId;
  const config = JSON.parse((await verifiedArtifact(configuredSource.configArtifact, readArtifact)).toString('utf8'));
  const configured = (config.sources ?? []).filter(row => row.type === 'notion' && row.enabled !== false);
  need(configured.length === 1 && configured[0].id === sourceId && sameLibrary(configured[0].library, configuredSource.library) &&
    sameLibrary(configuredSource.library, bindings.private.fixture?.libraryId),
  'CONTENT_SOURCE_SCOPE_MISMATCH', 'The user-visible source and independently read fixture library must agree');
  const readbackKey = item.versions?.[body.version]?.readback;
  const receipt = bindings.private.fixture?.observedReadbacks?.[readbackKey];
  need(receipt?.status === 'passed' && receipt.object?.owner === item.owner && receipt.object?.scope === item.scope,
    'CONTENT_READBACK_MISSING', 'The content premise requires the production CLI fixture readback');
  const sealed = JSON.parse((await verifiedArtifact(receipt.artifact, readArtifact)).toString('utf8'));
  const { artifact: _artifact, ...receiptValue } = receipt;
  demand(isDeepStrictEqual(sealed, receiptValue), 'CONTENT_READBACK_CHANGED', 'The fixture receipt changed after independent readback');
  const raw = JSON.parse((await verifiedArtifact(receipt.rawEvidence, readArtifact)).toString('utf8'));
  const record = raw.main?.record, bytes = await verifiedArtifact(body, readArtifact);
  need(record?.id === item.owner && raw.main?.scope === item.scope && record.name === item.name &&
    sameLibrary(record.locator?.page_id, item.pageId) && typeof record.description === 'string' &&
    raw.observedFiles?.some(file => file.path === body.resourcePath && file.sha256 === body.sha256 && file.bytes === body.bytes),
  'CONTENT_READBACK_OWNER_MISMATCH', 'The frozen body and metadata must belong to the same independently read Skill');
  demand(normalized(bytes.toString('utf8')).includes(normalized(query)) &&
    !normalized(record.name).includes(normalized(query)) && !normalized(record.description).includes(normalized(query)),
  'CONTENT_BODY_ONLY_PRECONDITION_MISSING', 'The query must occur in actual content and be absent from its name and description');
  let matchPageId = item.pageId, representation = 'native';
  if (body.resourcePath !== 'SKILL.md') {
    const propertyId = bindings.private.fixture?.library?.files?.property_ids?.Path;
    const pathOf = page => {
      const values = Object.values(page.properties ?? {});
      const property = values.find(value => value.id === propertyId && propertyId !== undefined) ?? page.properties?.Path;
      return (property?.rich_text ?? []).map(value => value.plain_text ?? value.text?.content ?? '').join('');
    };
    const files = (raw.files ?? []).filter(file => pathOf(file) === body.resourcePath);
    need(files.length === 1 && nonempty(files[0].id), 'CONTENT_FILE_OWNER_MISSING', 'A supporting-file hit needs its independently read physical File');
    matchPageId = files[0].id; representation = 'supporting_file';
  }
  const candidates = attempts.filter(call => call.name === 'notion_list' && call.arguments?.search_in === 'content' &&
    call.arguments.query === query && (call.arguments.source === undefined || call.arguments.source === sourceId) && call.result?.isError === false);
  demand(candidates.length > 0, 'CONTENT_SEARCH_MISSING', 'The current turn did not explicitly search content using the public query');
  const call = candidates.at(-1), native = observed.session.branchEntries.find(entry => entry.id === call.native?.resultEntryId);
  need(native?.message?.role === 'toolResult' && native.message.toolCallId === call.id && native.message.isError === false,
    'CONTENT_RESULT_MISSING', 'Content discovery needs its completed native tool result');
  const content = JSON.parse((await verifiedArtifact(call.result.contentArtifact, readArtifact)).toString('utf8'));
  demand(isDeepStrictEqual(content, native.message.content), 'CONTENT_RESULT_CHANGED', 'Observed and native content-search results differ');
  const text = textOf(content), value = JSON.parse(text);
  need(value.ok === true && value.state === 'known' && value.search_in === 'content' && Array.isArray(value.records),
    'CONTENT_RESULT_UNAVAILABLE', 'Authorization failure, denial or a pending result cannot prove a remote hit');
  demand(value.source === sourceId && value.count === value.records.length && value.records.length <= (call.arguments.limit ?? 20) &&
    value.next_cursor === null && value.pagination === 'not_supported' && value.coverage === 'remote_non_exhaustive' &&
    value.exhaustive === false && typeof value.partial === 'boolean' && nonempty(value.result_id) &&
    nonempty(value.connection?.id) && nonempty(value.connection?.grantEpoch),
  'CONTENT_RESULT_CONTRACT_MISMATCH', 'Remote discovery must preserve its scope, bound and non-exhaustive result contract');
  demand(call.arguments.cursor === undefined, 'CONTENT_CURSOR_UNSUPPORTED', 'Content discovery cannot resume a metadata or fabricated cursor');
  const matches = value.records.filter(row => row.id === item.owner && row.source === sourceId);
  demand(matches.length === 1 && matches[0].name === item.name && matches[0].availability === 'available' && matches[0].enabled === true &&
    matches[0].locator?.type === 'shared_skill' && ['page_id', 'database_id', 'data_source_id', 'library_id', 'skill_id']
      .every(key => matches[0].locator[key] === record.locator[key]),
  'CONTENT_MATCH_WRONG_OWNER', 'The returned match must name the independently read owner and physical source');
  const match = matches[0];
  let reference;
  try { reference = parseNativeReference(match.ref); } catch { reference = undefined; }
  demand(reference && hasExactNativeOwner(reference) && reference.selector === record.id && reference.snapshot === undefined
    && reference.path === record.entrypoint && match.ref === record.ref && match.entrypoint === record.entrypoint &&
    match.match?.kind === 'notion_remote_match' && match.match.representation === representation && sameLibrary(match.match.pageId, matchPageId),
  'CONTENT_MATCH_WRONG_REPRESENTATION', 'The discovery reference must remain current and the remote page must map to the read Skill or File');
  const deliveries = [];
  for (const payload of delivery.requests) {
    const task = observed.tasks.find(row => row.phase === 'provider_payload' && row.sha256 === payload.sha256);
    const rawPayload = providerPayloadView(JSON.parse((await verifiedArtifact({ path: task?.payloadFile, sha256: payload.sha256, bytes: payload.bytes }, readArtifact)).toString('utf8')), payload.api, observed.session, payload.nativeResponseEntryId);
    if ((rawPayload.messages ?? []).some(message => message.role === 'tool' && message.tool_call_id === call.deliveryToolCallId && textOf(message.content) === text))
      deliveries.push(payload);
  }
  demand(deliveries.length > 0, 'CONTENT_NOT_DELIVERED', 'The remote result was not sent to the actual model');
  const callNs = call.event.monotonicNs, resultNs = call.result.monotonicNs;
  need(/^\d+$/u.test(callNs ?? '') && /^\d+$/u.test(resultNs ?? '') && Number.isSafeInteger(call.event.pid),
    'CONTENT_CALL_TIMING_MISSING', 'Retain actual source and tool boundaries');
  const contentStarts = source.filter(row => row.phase === 'started' && row.kind === 'sdk' && row.operation === 'content-search');
  demand(contentStarts.every(row => row.source_id === sourceId && sameLibrary(row.library, configuredSource.library)),
    'CONTENT_QUERY_BROADCAST', 'Content discovery may use only the explicitly selected source');
  const requests = contentStarts.filter(row => row.pid === call.event.pid && /^\d+$/u.test(row.monotonicNs ?? '') &&
    BigInt(row.monotonicNs) >= BigInt(callNs) && BigInt(row.monotonicNs) <= BigInt(resultNs) &&
    source.some(end => end.requestId === row.requestId && end.phase === 'completed' && end.status === 'completed' &&
      /^\d+$/u.test(end.monotonicNs ?? '') && BigInt(end.monotonicNs) <= BigInt(resultNs)));
  demand(requests.length === 1, 'CONTENT_SDK_CALL_UNPROVEN', 'The result must belong to one completed source SDK call');
  const before = delivery.requests[0]?.selection;
  const snapshots = [...delivery.requests.map(payload => payload.selection), observed.selection];
  need(before && Array.isArray(before.scopes) && Array.isArray(before.active) && snapshots.every(snapshot =>
    snapshot?.sessionId === observed.session.sessionId && Array.isArray(snapshot.scopes) && Array.isArray(snapshot.active)),
  'CONTENT_SELECTION_OBSERVATION_MISSING', 'Retain actual selection snapshots before and after discovery');
  demand(snapshots.every(snapshot => isDeepStrictEqual(snapshot.scopes, before.scopes) && isDeepStrictEqual(snapshot.active, before.active)),
    'CONTENT_CHANGED_SELECTION', 'Content discovery must preserve task roots, fixed bindings, Requires locks and active sources');
  return { object: expected.object, query, source: sourceId, toolCallId: call.id, resultEntryId: native.id,
    records: [{ ref: match.ref, owner: item.owner, pageId: matchPageId, representation }],
    resultId: value.result_id, partial: value.partial, coverage: value.coverage, exhaustive: false,
    fixtureReadback: receipt.artifact, bodySha256: body.sha256, payloads: deliveries.map(payload => payload.sha256),
    sdkRequests: requests.map(row => row.requestId), pinsUnchanged: true, mcpHttpAttempts: null,
    notClaimed: 'MCP HTTP count, exhaustive search, fixed-content delivery, or exact-match semantics of the remote index' };
}

/** Analyze one real turn. Only the outside controller receives private bindings.
 * readArtifact and inspectPayload are injected I/O/pure helpers, never model tools. */
/** A user's statement that a page is gone cannot replace an actual failed current read. */
// The shared catalog resolver is pure: a complete online list can succeed and
// then resolve the exact absent owner to SKILL_NOT_FOUND without an SDK read.
// Only its already captured, sealed response can prove that path.
async function unavailableCatalogProof({ call, item, library, sourceId, observed, source, within, readArtifact }) {
  const operations = source.filter(row => row.phase === 'started' && row.kind === 'sdk' && row.operation === 'list'
    && row.pid === call.event.pid && row.source_id === sourceId && sameLibrary(row.library, library) && within(row.monotonicNs));
  if (operations.length === 0) return undefined;
  const prove = (condition, message) => need(condition, 'UNAVAILABLE_CATALOG_PROOF_MISSING', message, { toolCallId: call.id });
  prove(operations.length === 1, 'The failed tool needs one exact-source catalog invocation');
  const operation = operations[0], pid = call.event.pid, prefix = 'sdk:' + pid + ':';
  prove(operation.requestId.startsWith(prefix) && call.result.pid === pid, 'The catalog and native result must belong to this actual process');
  const requestId = operation.requestId.slice(prefix.length), window = observed.sourceObservationWindow;
  prove(/^\d+$/u.test(window?.startedNs ?? '') && /^\d+$/u.test(window?.endedNs ?? '')
    && BigInt(window.startedNs) <= BigInt(call.event.monotonicNs) && BigInt(call.event.monotonicNs) < BigInt(call.result.monotonicNs)
    && BigInt(call.result.monotonicNs) <= BigInt(window.endedNs), 'The whole failed tool must lie inside the current observation window');
  const segments = observed.toolHistory?.sdkSegments?.filter(segment => segment.responses?.some(row => row.requestId === requestId)) ?? [];
  prove(segments.length === 1, 'Keep one sealed original SDK catalog response, never reopen an unbound file');
  const segment = segments[0], rawSource = parseSourceObservation((await verifiedArtifact(segment.source, readArtifact)).toString('utf8'));
  prove(rawSource.complete === true && rawSource.errors.length === 0 && rawSource.events[0]?.pid === pid,
    'The catalog needs the complete original process source observation');
  const rows = rawSource.events.filter(row => row.requestId === operation.requestId);
  prove(isDeepStrictEqual(rows, source.filter(row => row.requestId === operation.requestId)) && rows.every(row => within(row.monotonicNs)),
    'Catalog source rows must be the exact current tool-window observations');
  const starts = rows.filter(row => row.phase === 'started'), ends = rows.filter(row => row.phase === 'completed');
  prove(starts.length === 1 && ends.length === 1 && isDeepStrictEqual(starts[0], operation), 'Keep one actual catalog start and completion');
  const end = ends[0];
  prove(end.kind === 'sdk' && end.operation === 'list' && end.pid === pid && end.source_id === sourceId
    && sameLibrary(end.library, library) && end.status === 'completed' && end.sdkStarted === true && end.errorCode === null,
  'The exact-source catalog must have completed successfully');
  const sdkText = (await verifiedArtifact(segment.sdk, readArtifact)).toString('utf8');
  prove(sdkText.endsWith('\n'), 'Keep the complete original SDK ledger');
  const sdk = sdkText.trimEnd().split('\n').map(JSON.parse), first = sdk[0], last = sdk.at(-1);
  prove(first?.phase === 'sdk-observer-start' && first.pid === pid && last?.phase === 'sdk-observer-end'
    && last.pid === pid && last.pending === 0 && !sdk.some(row => row.phase === 'sdk-observer-error')
    && sdk.filter(row => row.phase === 'sdk-observer-start').length === 1
    && sdk.filter(row => row.phase === 'sdk-observer-end').length === 1, 'The original SDK observer must finish completely in this process');
  const sdkStarts = sdk.filter(row => row.phase === 'sdk-start' && row.requestId === requestId);
  const sdkEnds = sdk.filter(row => row.phase === 'sdk-end' && row.requestId === requestId);
  prove(sdkStarts.length === 1 && sdkEnds.length === 1, 'The catalog response needs one matching original SDK start and end');
  const sdkStart = sdkStarts[0], sdkEnd = sdkEnds[0];
  for (const [row, counterpart] of [[operation, sdkStart], [end, sdkEnd]])
    prove(counterpart.operation === 'list' && counterpart.pid === pid && within(counterpart.monotonic_ns)
      && row.sourceMonotonicNs === counterpart.monotonic_ns, 'SDK and Source must agree on the exact catalog invocation and clocks');
  prove(BigInt(sdkStart.monotonic_ns) < BigInt(sdkEnd.monotonic_ns) && sdkEnd.status === 'completed'
    && sdkEnd.resultObserved === true && sdkEnd.metricsComplete === true, 'The actual SDK catalog result and metrics must be complete');
  const responses = segment.responses.filter(row => row.requestId === requestId), responseArtifact = responses[0]?.artifact;
  prove(responses.length === 1 && sdkEnd.responseFile === requestId + '.json'
    && responseArtifact?.path === join(dirname(segment.sdk.path), 'sdk-responses', sdkEnd.responseFile),
  'Use only the response file named by the original SDK completion');
  const receipt = JSON.parse((await verifiedArtifact(responseArtifact, readArtifact)).toString('utf8'));
  prove(receipt.version === 2 && receipt.transport === 'sdk' && receipt.operation === 'list' && receipt.requestId === requestId
    && receipt.status === 'completed' && receipt.resultObserved === true && receipt.sdk_started === true && receipt.metrics_observed === true,
  'The sealed catalog must be the actual SDK result');
  const http = rows.filter(row => row.phase === 'attempt'), metrics = rows.filter(row => row.phase === 'metrics');
  const trace = receipt.metrics?.trace?.filter(row => row.event === 'attempt') ?? [];
  prove(http.length > 0 && metrics.length === 1 && metrics[0].observed === true && metrics[0].complete === true
    && metrics[0].trace_dropped === 0 && metrics[0].total_requests === http.length && receipt.metrics?.complete === true
    && receipt.metrics.trace_dropped === 0 && receipt.metrics.total_requests === http.length && trace.length === http.length
    && trace.every((attempt, index) => Object.entries(attempt).every(([key, value]) => isDeepStrictEqual(http[index][key], value))),
  'Catalog absence needs every original HTTP attempt, not a cache hit or partial request trace');
  const value = receipt.value, freshness = value?.freshness, coverage = value?.coverage;
  const from = Date.parse(sdkStart.at), to = Date.parse(sdkEnd.at), validated = Date.parse(freshness?.validated_at);
  prove(value?.source === 'notion' && digest(item.scope) && value.scope === item.scope && sameLibrary(value.library_id, library)
    && ['refresh', 'max_age'].includes(freshness?.policy) && freshness.stale === false && freshness.age_ms === 0
    && Number.isFinite(from) && Number.isFinite(to) && from <= validated && validated <= to && value.fetched_at === validated,
  'Catalog scope and freshness must belong to this original owner and actual online invocation');
  prove(!['view', 'view_selection', 'view_query', 'profile', 'capability_directory', 'query', 'limit', 'cursor', 'has_more', 'next_cursor', 'total_count']
    .some(key => Object.hasOwn(value, key)) && coverage?.method === 'explicit_library' && coverage.exhaustive === true
    && coverage.search_index_limited === false && Array.isArray(coverage.failed_sources) && coverage.failed_sources.length === 0
    && Array.isArray(value.records) && value.count === value.records.length && Array.isArray(value.databases) && value.databases.length === 1,
  'Only an exhaustive unfiltered complete Library catalog can prove an absent owner');
  const database = value.databases[0], descriptor = database.shared_library, skills = descriptor?.skills;
  prove(database.role === 'content' && descriptor?.version === 2 && sameLibrary(descriptor.library_id, library)
    && nonempty(skills?.database_id) && nonempty(skills.data_source_id) && database.database_id === skills.database_id
    && isDeepStrictEqual(database.data_source_ids, [skills.data_source_id])
    && isDeepStrictEqual(coverage.queried_data_sources, [skills.data_source_id])
    && http.some(row => row.method === 'POST' && row.request_kind === 'notion_metadata' && row.target?.data_source_id === skills.data_source_id
      && row.outcome === 'success' && row.http_status >= 200 && row.http_status < 300),
  'The full catalog must have queried the exact Library Skills data source');
  const identities = new Set(), pages = new Set();
  for (const record of value.records) {
    const locator = record?.locator;
    prove(locator?.type === 'shared_skill' && sameLibrary(locator.library_id, library)
      && locator.database_id === skills.database_id && locator.data_source_id === skills.data_source_id
      && nonempty(locator.page_id) && nonempty(locator.skill_id) && record.id === nativeSkillId(library, locator.skill_id)
      && !identities.has(record.id) && !pages.has(libraryKey(locator.page_id)), 'Every catalog row needs a unique exact Library owner');
    identities.add(record.id); pages.add(libraryKey(locator.page_id));
  }
  prove(nonempty(item.pageId) && !identities.has(item.owner) && !pages.has(libraryKey(item.pageId)),
    'The exact original logical and physical owner must be absent from the complete catalog');
  return { evidence: 'fresh-exhaustive-catalog', requestId: operation.requestId, httpAttempts: http.length,
    scope: value.scope, count: value.count, validatedAt: freshness.validated_at, queriedDataSources: coverage.queried_data_sources,
    sdkArtifact: segment.sdk, sourceArtifact: segment.source, responseArtifact };
}

export async function verifyNotionAgentUnavailableReference(expected, observed, bindings, { attempts, delivery, source, readArtifact = readFile }) {
  const item = bindings.private.objects[expected.object];
  need(item?.kind === 'notion' && nonempty(item.owner), 'UNAVAILABLE_OWNER_MISSING', 'Bind the original independently read owner');
  const owner = parseNativeReference(item.owner), library = nativeReferenceLibrary(owner);
  const configured = observed.visibility?.source;
  const sourceId = configured?.library === library ? configured.sourceId
    : configured?.additionalLibrary?.library === library ? configured.additionalLibrary.sourceId : undefined;
  need(nonempty(sourceId), 'UNAVAILABLE_SOURCE_MISSING', 'The original root must be an explicitly reviewed enabled Source');
  const candidates = attempts.filter(call => {
    if (!['read', 'notion_use'].includes(call.name) || call.result?.isError !== true) return false;
    try {
      const ref = parseNativeReference(call.name === 'read' ? call.arguments?.path : call.arguments?.ref);
      return ref.snapshot === undefined && hasExactNativeOwner(ref) && ref.selector === item.owner && (ref.path || 'SKILL.md') === expected.path;
    } catch { return false; }
  });
  demand(candidates.length > 0, 'UNAVAILABLE_CURRENT_READ_MISSING', 'The Agent must actually try the original current owner, not repeat the prompt');
  const proofs = [];
  for (const call of candidates) {
    const native = observed.session.branchEntries.find(entry => entry.id === call.native?.resultEntryId)?.message;
    need(native?.role === 'toolResult' && native.toolCallId === call.id && native.isError === true,
      'UNAVAILABLE_NATIVE_RESULT_MISSING', 'Keep the actual failed native tool result');
    const content = JSON.parse((await verifiedArtifact(call.result.contentArtifact, readArtifact)).toString('utf8'));
    demand(isDeepStrictEqual(content, native.content), 'UNAVAILABLE_RESULT_CHANGED', 'Replay original failure bytes');
    const within = time => /^\d+$/u.test(time ?? '') && /^\d+$/u.test(call.event.monotonicNs ?? '') && /^\d+$/u.test(call.result.monotonicNs ?? '')
      && BigInt(time) >= BigInt(call.event.monotonicNs) && BigInt(time) <= BigInt(call.result.monotonicNs);
    const delivered = async (currentWindow = false) => {
      const payloads = [];
      for (const payload of delivery.requests) {
        const task = observed.tasks.find(row => row.phase === 'provider_payload' && row.sha256 === payload.sha256);
        if (currentWindow && (!/^\d+$/u.test(task?.monotonicNs ?? '') || BigInt(task.monotonicNs) <= BigInt(call.result.monotonicNs)
          || !/^\d+$/u.test(observed.sourceObservationWindow?.endedNs ?? '')
          || BigInt(task.monotonicNs) > BigInt(observed.sourceObservationWindow.endedNs))) continue;
        const raw = providerPayloadView(JSON.parse((await verifiedArtifact({ path: task?.payloadFile, sha256: payload.sha256, bytes: payload.bytes }, readArtifact)).toString('utf8')), payload.api, observed.session, payload.nativeResponseEntryId);
        if ((raw.messages ?? []).some(message => message.role === 'tool' && message.tool_call_id === call.deliveryToolCallId
          && textOf(message.content) === textOf(content))) payloads.push(payload.sha256);
      }
      return payloads;
    };
    const operations = source.filter(row => row.phase === 'started' && row.kind === 'sdk' && row.pid === call.event.pid
      && row.source_id === sourceId && sameLibrary(row.library, library) && ['read', 'resolve', 'read-resources', 'consume'].includes(row.operation) && within(row.monotonicNs));
    for (const operation of operations) {
      const end = source.find(row => row.phase === 'completed' && row.requestId === operation.requestId && within(row.monotonicNs));
      if (end?.status !== 'failed' || !['SKILL_NOT_FOUND', 'SOURCE_NOT_FOUND', 'NOT_FOUND'].includes(end.errorCode)) continue;
      const http = source.filter(row => row.phase === 'attempt' && row.requestId === operation.requestId);
      if (http.length === 0 || !textOf(content).includes(end.errorCode)) continue;
      const payloads = await delivered();
      if (payloads.length) proofs.push({ toolCallId: call.id, requestId: operation.requestId, sourceId, library, owner: item.owner,
        path: expected.path, errorCode: end.errorCode, httpAttempts: http.length, payloads, result: call.result.contentArtifact });
    }
    if (proofs.some(proof => proof.toolCallId === call.id)) continue;
    let nativeFailure;
    if (call.name === 'read') {
      let failure;
      try { failure = JSON.parse(textOf(content)); } catch { continue; }
      const admission = failure?.admission;
      if (admission?.version !== 1 || admission.phase !== 'execute' || admission.stage !== 'reference' || admission.code !== 'SKILL_NOT_FOUND'
        || admission.signal_aborted !== false || !Number.isSafeInteger(admission.generation_started)
        || admission.generation_started !== admission.generation_current
        || !failure.error?.startsWith('context-broker source ' + sourceId + ' unavailable (SKILL_NOT_FOUND).')) continue;
      nativeFailure = { kind: 'read-admission', generationObserved: true };
    } else {
      // Before acquisition, notion_use throws SourceError unchanged. Pi keeps
      // only Error.message and empty details; it produces no generation receipt.
      const nativeCalls = observed.session.attempts?.filter(attempt => attempt.id === call.id) ?? [];
      const attempt = nativeCalls[0];
      if (typeof call.arguments?.ref !== 'string' || Object.keys(call.arguments).some(key => !['ref', 'refresh'].includes(key))
        || call.arguments.refresh !== undefined && typeof call.arguments.refresh !== 'boolean'
        || nativeCalls.length !== 1 || attempt.active !== true || attempt.name !== 'notion_use'
        || attempt.resultEntryId !== call.native.resultEntryId || !isDeepStrictEqual(attempt.arguments, call.arguments)
        || native.toolName !== 'notion_use' || !isDeepStrictEqual(native.details, {})
        || !isDeepStrictEqual(content, [{ type: 'text', text: 'context-broker source operation failed (SKILL_NOT_FOUND)' }])) continue;
      nativeFailure = { kind: 'pi-error-message', generationObserved: false };
    }
    const payloads = await delivered(true);
    if (payloads.length === 0) continue;
    const catalog = await unavailableCatalogProof({ call, item, library, sourceId, observed, source, within, readArtifact });
    if (catalog) proofs.push({ ...catalog, toolCallId: call.id, sourceId, library, owner: item.owner, path: expected.path,
      errorCode: 'SKILL_NOT_FOUND', nativeFailure, payloads, result: call.result.contentArtifact });
  }
  demand(proofs.length > 0, 'UNAVAILABLE_ONLINE_READ_UNPROVEN', 'Only an online failure of the exact original root inside that tool attempt proves unavailability');
  return { object: expected.object, proofs };
}

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
  shared.attempts = new Map(); shared.proposals = [];
  shared.toolObservation = await check('tool-attempt-observation', async () => {
    const preparedReads = await observedPreparedReads(observed, readArtifact);
    const runtimeEvidence = await verifyObservedPiToolRuntime(tasks, readArtifact);
    shared.runtimeEvidence = runtimeEvidence;
    const correlation = correlateNotionAgentToolAttempts({ tasks, session: observed.session, preparedReads, runtimeEvidence });
    shared.correlation = correlation;
    shared.attempts = new Map(correlation.attempts.map(call => [call.id, call]));
    shared.proposals = [...correlation.attempts, ...correlation.retractedProposals];
    if (!correlation.complete) {
      const problem = correlation.diagnostics.find(item => item.status === 'failed') ?? correlation.diagnostics[0];
      throw new EvidenceError(problem?.status ?? 'blocked', problem?.code ?? 'TOOL_CORRELATION_INCOMPLETE',
        problem?.message ?? 'The native and actual tool attempts are not completely correlated', { diagnostics: correlation.diagnostics });
    }
    return correlation.counts;
  });

  const localBodyPath = key => {
    const body = privateBindings.bodies[key];
    const owners = Object.values(privateBindings.objects).filter(item => item.kind === 'local' &&
      Object.values(item.versions).some(version => version.bodyKeys?.includes(key)));
    if (!owners.length) return undefined;
    need(owners.length === 1 && isAbsolute(owners[0].path ?? ''), 'LOCAL_BODY_OWNER_MISSING', 'A local body needs one actual owner path');
    const resource = body.resourcePath ?? (key.endsWith('/SKILL.md') ? 'SKILL.md' : undefined);
    need(nonempty(resource), 'LOCAL_BODY_PATH_MISSING', 'A local resource needs its exact logical path');
    const path = resolve(dirname(owners[0].path), resource);
    need(body.observedPath === undefined || body.observedPath === path, 'LOCAL_BODY_PATH_MISMATCH', 'The observed local file does not belong to its bound owner');
    return path;
  };
  const actualReadPath = value => typeof value === 'string'
    ? value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(observed.session.header.cwd, value) : undefined;

  // Attempt/effects counts remain current-turn-only. Historical delivery is a
  // separate proof: retained native ancestry, original callbacks/result bytes,
  // and this request's exact tool message. It does not infer a fresh read.
  let history;
  const historicalRoots = new Map();
  const retainedReadAttempts = async (matches, payload, payloadTime, includeCurrent = false) => {
    const delivered = new Set((payload.messages ?? []).filter(message => message.role === 'tool').map(message => message.tool_call_id));
    const calls = [], session = observed.session;
    for (const root of session.attempts.filter(call => call.active && (includeCurrent || call.userEntryId !== session.currentUserId) && delivered.has(call.id))) {
      const terminal = session.branchEntries.find(entry => entry.id === root.resultEntryId)?.message;
      const members = terminal?.nestedCalls?.calls ?? [];
      if (![root, ...members].some(call => call.name === 'read' && matches(call, root))) continue;
      need(session.contributions.some(row => row.entryId === root.assistantEntryId && row.role === 'assistant')
        && session.contributions.some(row => row.entryId === root.resultEntryId && row.role === 'toolResult'),
      'HISTORICAL_READ_NOT_RETAINED', 'An omitted or compacted historical result cannot supply read identity');
      if (!historicalRoots.has(root.id)) {
        history ??= await retainedToolHistory(observed.toolHistory, readArtifact);
        const ids = new Set([root.id, ...members.map(call => call.id)]);
        const runtimeEvidence = history.runtimeEvidence ??= await verifyObservedPiToolRuntime(history.rows, readArtifact);
        const correlation = correlateNotionAgentToolAttempts({ tasks: history.rows.filter(row => ids.has(row.toolCallId)),
          session: { ...session, attempts: [root] }, currentUserId: root.userEntryId, runtimeEvidence });
        if (!correlation.complete) {
          const problem = correlation.diagnostics.find(item => item.status === 'failed') ?? correlation.diagnostics[0];
          throw new EvidenceError(problem?.status ?? 'blocked', problem?.code ?? 'HISTORICAL_TOOL_CORRELATION_INCOMPLETE',
            problem?.message ?? 'Historical read callbacks do not match their native root', { rootToolCallId: root.id, diagnostics: correlation.diagnostics });
        }
        historicalRoots.set(root.id, correlation.attempts.map(call => ({ ...call, history: {
          userEntryId: root.userEntryId, rootToolCallId: root.id,
          callArtifact: history.sources.get(call.event), resultArtifact: history.sources.get(call.result),
        } })));
      }
      for (const call of historicalRoots.get(root.id).filter(call => call.name === 'read' && matches(call, root))) {
        need(/^\d+$/u.test(payloadTime ?? '') && BigInt(call.result.monotonicNs) < BigInt(payloadTime),
          'HISTORICAL_READ_ORDER_UNPROVEN', 'A reused result must have completed before this actual provider payload');
        calls.push(call);
      }
    }
    return calls;
  };

  shared.delivery = await check('actual-provider-delivery', async () => {
    const requests = costs.filter(row => row.phase === 'provider_request'), used = new Set(), payloads = [], nativeUsed = new Set(), responseIds = new Set();
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
      need(['openai-completions', 'openai-responses'].includes(end.modelApi), 'TRANSPORT_UNSUPPORTED', 'The selected API needs independent Node Undici protocol evidence');
      if (end.modelApi === 'openai-responses') {
        const native = nativeMatches[0];
        need(nonempty(message.responseId) && !responseIds.has(message.responseId),
          'RESPONSE_ID_REUSED', 'Each Responses request needs its own independently observed response ID');
        responseIds.add(message.responseId);
        need(request.api === end.modelApi && message.api === end.modelApi && native.api === end.modelApi
          && native.responseId === message.responseId && native.rawStopReason === message.rawStopReason
          && ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens'].every(key => native.usage?.[key] === message.usage?.[key]),
        'NATIVE_RESPONSE_PROTOCOL_MISMATCH', 'The native Responses identity, completion and usage must match the observed assistant');
      }
      need(providerApplicationCompletion(end, message) && digest(end.responseEntitySha256) && end.responseEntityBytes > 0,
        'APPLICATION_COMPLETION_MISSING', 'A hook or HTTP status is not a completed application response');
      demand(['stop', 'toolUse'].includes(message.stopReason), 'MODEL_RESPONSE_INCOMPLETE', 'The response stopped before completing its task');
      need(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(key => numeric(message.usage?.[key])) &&
        message.usage.totalTokens > 0, 'USAGE_UNKNOWN', 'Missing usage must not become zero');
      const taskRows = tasks.filter(row => row.phase === 'provider_payload' && row.sha256 === request.payload.sha256 && row.bytes === request.payload.bytes);
      need(taskRows.length === 1 && nonempty(taskRows[0].payloadFile), 'RAW_PAYLOAD_MISSING', 'Retain the exact private payload file');
      const task = taskRows[0], bytes = await verifiedArtifact({ path: task.payloadFile, sha256: task.sha256, bytes: task.bytes }, readArtifact);
      const rawPayload = JSON.parse(bytes.toString('utf8'));
      demand(rawPayload.model === 'group/worker' && (end.modelApi === 'openai-responses'
        ? rawPayload.reasoning?.effort === 'high' && rawPayload.stream === true : rawPayload.reasoning_effort === 'high'),
      'WRONG_WIRE_MODEL', 'Actual wire payload must request worker/high with the selected API');
      const payload = providerPayloadView(rawPayload, end.modelApi, observed.session, nativeMatches[0].entryId);
      const bodies = inspectPayload(rawPayload, bodyFiles);
      need(Array.isArray(bodies), 'BODY_ORACLE_INVALID', 'The body oracle returned no observations');
      const bodyObservation = [];
      for (const body of bodies) {
        need(digest(body.sha256) && Number.isSafeInteger(body.occurrences) && body.occurrences >= 0, 'BODY_METRIC_MISSING', 'Body counts must be observed numbers');
        const observer = task.bodies?.filter(value => value.sha256 === body.sha256) ?? [];
        // A body created or published after process start cannot be known to the
        // startup oracle. Its frozen bytes can still be counted independently in
        // the exact payload whose hash was matched to the wire.
        demand(observer.every(value => value.occurrences === body.occurrences), 'BODY_OBSERVATION_MISMATCH', 'Independent payload read differs from the task observer');
        bodyObservation.push({ sha256: body.sha256, method: observer.length ? 'observer-and-independent-raw-payload-count' : 'independent-raw-payload-count-only' });
      }
      const nativeReadBodies = [];
      for (const key of bodyKeys) {
        const path = localBodyPath(key);
        if (!path) continue;
        need(shared.toolObservation, 'TOOL_OBSERVATION_UNPROVEN', 'Native local body delivery needs complete actual tool observations');
        const frozen = uniqueBodies.get(privateBindings.bodies[key].sha256);
        const calls = [];
        const available = [...shared.attempts.values(), ...await retainedReadAttempts(call => actualReadPath(call.arguments?.path) === path, payload, task.monotonicNs)];
        for (const call of available.filter(call => call.name === 'read' && call.result?.isError === false &&
          call.native?.isError === false && actualReadPath(call.arguments?.path) === path)) {
          let content;
          if (call.history || call.provenance?.kind === 'native-nested-summary') {
            need(call.result.contentArtifact, call.history ? 'HISTORICAL_READ_RESULT_MISSING' : 'NESTED_READ_RESULT_MISSING',
              'A reused or composed read needs its own observed complete result', { toolCallId: call.id });
            content = JSON.parse((await verifiedArtifact(call.result.contentArtifact, readArtifact)).toString('utf8'));
            if (call.history && call.provenance.kind === 'native-tool-call')
              demand(isDeepStrictEqual(content, observed.session.branchEntries.find(entry => entry.id === call.native.resultEntryId)?.message?.content),
                'HISTORICAL_READ_RESULT_MISMATCH', 'The historical callback and native result contain different bytes', { toolCallId: call.id });
          } else content = observed.session.branchEntries.find(entry => entry.id === call.native.resultEntryId)?.message?.content;
          if (textOf(content).includes(frozen.text)) calls.push(call);
        }
        const ids = new Set(calls.map(call => call.deliveryToolCallId));
        const messages = (payload.messages ?? []).filter(message => message.role === 'tool' && ids.has(message.tool_call_id));
        const count = inspectPayload({ messages }, [frozen])[0];
        need(count && count.sha256 === frozen.sha256 && Number.isSafeInteger(count.occurrences) && count.occurrences >= 0,
          'NATIVE_BODY_METRIC_MISSING', 'The actual native tool response requires an independent full-body count');
        nativeReadBodies.push({ body: key, path, sha256: frozen.sha256, occurrences: count.occurrences, toolCallIds: calls.map(call => call.id), deliveryToolCallIds: [...ids],
          provenance: calls.map(call => ({ toolCallId: call.id, resultEntryId: call.native.resultEntryId,
            ...(call.history ? { history: call.history } : { currentTurn: true }) })) });
      }
      const native = uniqueBodies.size ? await nativeSourceReceipts(task.branch, observed.session, nativeMatches[0].entryId, readArtifact)
        : { receipts: [], rejected: [] };
      const notion = boundNotionDeliveries(payload, [...tasks, ...native.receipts], uniqueBodies);
      const resourceRef = (call, root) => call.id !== root.id && native.branch?.some(entry => entry.type === 'custom' && entry.customType === 'context-broker-short-ref'
        && entry.data?.ref === call.arguments?.path && entry.data.target?.kind === 'resource'
        && uniqueBodies.has(entry.data.target.sha256));
      for (const call of await retainedReadAttempts(resourceRef, payload, task.monotonicNs, true)) {
        if (call.provenance?.kind !== 'native-nested-summary') continue;
        try {
          const parent = historicalRoots.get(call.rootToolCallId).find(item => item.id === call.parentToolCallId);
          const taskArtifact = history.sources.get(call.event);
          need(parent && [call.result, parent.event, parent.result].every(row => isDeepStrictEqual(history.sources.get(row), taskArtifact)),
            'NESTED_RESOURCE_SEGMENT_MISMATCH', 'The nested resource callbacks must belong to one original task segment');
          const segments = observed.toolHistory.sdkSegments?.filter(segment => isDeepStrictEqual(segment.tasks, taskArtifact)) ?? [];
          need(segments.length === 1, 'NESTED_RESOURCE_SEGMENT_MISSING', 'Retain exactly one SDK/source binding for this task segment');
          shared.resourceBrokerOwner ??= await observedBrokerToolOwner(observed, readArtifact);
          notion.deliveries.push(await verifyNotionAgentNestedResourceRead({ call, parent, brokerOwner: shared.resourceBrokerOwner,
            runtimeEvidence: history.runtimeEvidence, branch: native.branch, branchArtifact: task.branch, taskArtifact,
            sdkSegment: segments[0], payload, frozenBodies: uniqueBodies, readArtifact }));
        } catch (error) {
          notion.rejected.push({ toolCallId: call.id, code: error.code ?? 'NESTED_RESOURCE_PROOF_INVALID', reason: error.message });
        }
      }
      payloads.push({ request: request.request, api: end.modelApi, nativeResponseEntryId: nativeMatches[0].entryId,
        ...(end.modelApi === 'openai-responses' ? { responseId: end.sseCompletion.response.id, responseModel: end.sseCompletion.response.model } : {}),
        wireRequestId: sent.id, sha256: task.sha256, bytes: task.bytes, bodies, bodyObservation, nativeReadBodies,
        notionDeliveries: notion.deliveries, rejectedNotionReceipts: [...notion.rejected, ...native.rejected],
        monotonicNs: task.monotonicNs, metadataText: (payload.messages ?? []).filter(message => ['user', 'system', 'developer'].includes(message.role)).map(message => textOf(message.content)).join('\n'),
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
      const graphs = selection.scopes.flatMap(scope => scope.graphLocks ?? []);
      demand(graphs.some(graph => graph.purpose === 'use' && graph.roots?.includes(target.owner) &&
        graph.bindings?.some(binding => sameIdentity(binding, target))), 'TASK_SELECTION_MISSING',
      'Inspection or a saved binding is not an adopted task selection');
      need(delivery.last.notionDeliveries.some(proof => proof.owner === target.owner && proof.scope === target.scope &&
        proof.snapshot_id === target.snapshot_id && proof.version_id === target.version_id &&
        proof.path === 'SKILL.md' && proof.sha256 === body.sha256 && proof.bytes === body.bytes),
      'SELECTED_BODY_DELIVERY_MISSING', 'The selected version needs its own receipt-bound body in this actual request',
      { target, rejected: delivery.last.rejectedNotionReceipts });
    } else {
      const active = selection.active.some(source => ['local', 'filesystem'].includes(source.record?.source) && source.record.path === target.path && source.bodySha256 === body.sha256);
      const read = delivery.last.nativeReadBodies.some(proof => proof.path === target.path && proof.sha256 === body.sha256 && proof.occurrences > 0);
      demand(active || read, 'LOCAL_OWNER_UNPROVEN', 'A matching body hash alone does not prove the selected local owner');
    }
    return { ...target, body: main, payloadSha256: delivery.last.sha256 };
  };
  const factFound = key => {
    need(shared.final, 'FINAL_RESPONSE_UNPROVEN', 'Business facts require the completed native/model answer');
    const fact = privateBindings.facts[key]; need(fact && Array.isArray(fact.anyOf) && fact.anyOf.length, 'FACT_BINDING_MISSING', 'Missing private necessary fact ' + key);
    return fact.anyOf.some(value => normalized(shared.final.text).includes(normalized(value)));
  };

  const interactionProofs = new Map(), toolOwners = new Map();
  let brokerOwner;
  const sourceRequests = async ({ requireHttpMetrics = true } = {}) => {
    need(shared.toolObservation, 'TOOL_OBSERVATION_UNPROVEN', 'Source effects require complete actual tool observations');
    need(observed.sourceCoverage === true && Array.isArray(observed.source), 'SOURCE_COVERAGE_MISSING', 'Complete source observation is required for source effects');
    const source = observed.source, starts = source.filter(row => row.phase === 'started'), attempts = source.filter(row => row.phase === 'attempt');
    const ids = new Set(starts.map(row => row.requestId));
    need(ids.size === starts.length && attempts.every(row => ids.has(row.requestId)),
      'SOURCE_OPERATION_CORRELATION_MISSING', 'Source attempts need unique observed operations');
    for (const start of starts) {
      const metric = source.filter(row => row.phase === 'metrics' && row.requestId === start.requestId);
      if (requireHttpMetrics) need(start.operation !== 'content-search',
        'SOURCE_MCP_METRICS_UNKNOWN', 'REST metrics do not establish the hosted MCP or OAuth HTTP count');
      if (requireHttpMetrics) need(metric.length === 1 && metric[0].observed === true && metric[0].complete === true &&
        Number.isSafeInteger(metric[0].total_requests) && metric[0].total_requests >= 0 &&
        metric[0].total_requests === attempts.filter(row => row.requestId === start.requestId).length,
      'SOURCE_METRICS_UNKNOWN', 'Missing or incomplete metrics cannot prove a source request count');
      need(source.filter(row => row.phase === 'completed' && row.requestId === start.requestId).length === 1,
        'SOURCE_OPERATION_INCOMPLETE', 'Source operation did not finish exactly once');
    }
    for (const call of shared.attempts.values()) {
      if (call.name === 'ask_user' && !interactionProofs.has(call.id))
        interactionProofs.set(call.id, await proveAskUserNoUi(call, observed.session, readArtifact));
      const source = call.event.toolSource;
      const reviewedReader = inspectedCompactReadImplementation(call.event);
      const builtinPath = call.name === 'tool_search' ? 'builtin:tool-search' : 'builtin:' + call.name;
      if (call.preparedRead) {
        toolOwners.set(call.id, { toolCallId: call.id, owner: 'reviewed-native-read-delegate', path: source.path,
          preparation: call.preparedRead });
      } else if (call.name === 'bash' && source?.source === 'builtin' && source.path === 'builtin:bash') {
        const inventory = verifyNotionAgentDirectoryInventory(call, { source: observed.source, session: observed.session,
          runtimeEvidence: shared.runtimeEvidence, sourceObservationWindow: observed.sourceObservationWindow });
        if (inventory.status === 'passed') toolOwners.set(call.id, inventory);
      } else if (['read', 'grep', 'find', 'ls', 'tool_search'].includes(call.name) &&
        source?.source === 'builtin' && source.path === builtinPath) {
        toolOwners.set(call.id, { toolCallId: call.id, owner: 'builtin', path: source.path });
      } else if (reviewedReader) {
        for (const file of reviewedReader.files) await verifiedArtifact(file.artifact, readArtifact);
        const content = await verifiedArtifact(call.result?.contentArtifact, readArtifact);
        const localRead = inspectedLocalReadEvidence(call, content);
        need(localRead, 'TOOL_IMPLEMENTATION_UNKNOWN',
          'A reviewed local read needs its complete unchanged native call and result', { tool: call.name, toolCallId: call.id });
        toolOwners.set(call.id, { toolCallId: call.id, owner: 'reviewed-native-local-read-delegate',
          path: source.path, localRead, implementationArtifacts: reviewedReader.files.map(file => file.artifact) });
      } else if (['read', 'notion_list', 'notion_use', 'notion_ctl'].includes(call.name)) {
        brokerOwner ??= observedBrokerToolOwner(observed, readArtifact);
        const expected = await brokerOwner;
        need(source && ['path', 'source', 'scope', 'origin', 'baseDir'].every(key => source[key] === expected.source[key]),
          'TOOL_IMPLEMENTATION_UNKNOWN', 'A familiar tool name cannot impersonate the frozen Broker owner', { tool: call.name, toolCallId: call.id });
        toolOwners.set(call.id, { toolCallId: call.id, owner: 'broker', path: source.path,
          commit: expected.commit, entrySha256: expected.entrySha256,
          ...(expected.ordinaryInstallation ? { ordinaryInstallation: expected.ordinaryInstallation } : {}) });
      }
    }
    const readOnly = call => interactionProofs.has(call.id) || toolOwners.has(call.id) &&
      (call.name !== 'notion_ctl' || object(call.arguments) && (call.arguments.working_set === 'show' || nonempty(call.arguments.cli_source)) &&
        Object.keys(call.arguments).every(key => ['working_set', 'cli_source'].includes(key))) ||
      call.name === 'codemode' && inspectNotionAgentReadOnlyContainer(call, shared.correlation, readOnly).readOnly;
    for (const call of shared.attempts.values())
      need(readOnly(call), 'TOOL_EFFECTS_UNKNOWN', 'An executed tool has effects outside the observed SDK boundary', { tool: call.name, toolCallId: call.id });
    return { source, attempts, coverage: requireHttpMetrics ? 'subject-tool-operations-with-complete-SDK-metrics' : 'subject-SDK-operation-lifecycle-only',
      interactions: [...interactionProofs.values()], implementations: [...toolOwners.values()],
      backgroundChildren: source.filter(row => row.phase === 'unmatched_child_start').map(row => ({ childId: row.childId, transport: 'unknown' })),
      notClaimed: 'all-host/plugin/descendant traffic; any subject execution tool still requires complete independent effects evidence' };
  };
  const subjectEffects = async () => {
    const effects = observed.effects, raw = JSON.parse((await verifiedArtifact(effects.artifact, readArtifact)).toString('utf8'));
    const { artifact: _artifact, ...value } = effects;
    demand(isDeepStrictEqual(raw, value), 'EFFECTS_RECEIPT_CHANGED', 'Effects summary differs from its original observation');
    need(effects.coverage === 'all-subject-notion-operations' && effects.complete === true,
      'EFFECTS_COVERAGE_MISSING', 'Unknown child-process effects cannot be treated as zero');
    return effects;
  };

  if (observed.cliProcesses !== undefined || turn.expect.some(expected => ['candidate-cli', 'single-projection-restore', 'original-source-resume'].includes(expected.kind)))
    shared.cliCandidate = await check('actual-cli-process-identity', () => observedCandidateCli(observed, readArtifact));

  for (const expected of turn.expect) await check(expected.kind, async () => {
    switch (expected.kind) {
      case 'unavailable-reference': {
        const delivery = requireDelivery(), { source } = await sourceRequests();
        return verifyNotionAgentUnavailableReference(expected, observed, bindings, { attempts: [...shared.attempts.values()], delivery, source, readArtifact });
      }
      case 'original-source-resume': {
        const observation = observed.sourceResumes?.[expected.object];
        need(observation?.artifact, 'SOURCE_RESUME_READBACK_MISSING', 'Keep the independent original Store and remote readback');
        const raw = JSON.parse((await verifiedArtifact(observation.artifact, readArtifact)).toString('utf8'));
        const { artifact: _artifact, ...receipt } = observation;
        demand(isDeepStrictEqual(raw, receipt), 'SOURCE_RESUME_RECEIPT_CHANGED', 'Replay the sealed original-operation proof');
        need(raw.actor === 'independent-readback' && raw.controllerResumeCommands === 0 && raw.status === 'passed',
          'SOURCE_RESUME_ACTOR_INVALID', 'The fixture controller may observe but cannot resume the intent');
        const original = privateBindings.fixture?.objects?.[expected.object]?.sourceOperation;
        need(original?.actor === 'agent' && original.id === raw.operationId && original.libraryId === raw.libraryId
          && isDeepStrictEqual(original.intent, raw.intent), 'SOURCE_RESUME_INTENT_CHANGED', 'Keep the original root, operation and frozen input fingerprint');
        const before = JSON.parse(JSON.parse((await verifiedArtifact(raw.before, readArtifact)).toString('utf8')).stdout);
        const after = JSON.parse(JSON.parse((await verifiedArtifact(raw.after, readArtifact)).toString('utf8')).stdout);
        const fixture = privateBindings.fixture, owned = fixture.objects[expected.object];
        const library = fixture.libraries?.[owned.library] ?? fixture.library;
        const interrupted = raw.interrupted && JSON.parse((await verifiedArtifact(raw.interrupted, readArtifact)).toString('utf8'));
        demand(isAgentSourceHandoff({ inspection: before, operationId: raw.operationId, library,
          sourceId: raw.sourceId, sourcePageId: owned.sourcePageId, inputSha256: raw.intent.input_sha256, interrupted })
          && before.library?.library_id === raw.libraryId && after.library?.library_id === raw.libraryId
          && after.status === 'not_found' && after.operation === null, 'SOURCE_RESUME_LIFECYCLE_INVALID', 'The exact public intent must finish in its original Library and Store');
        demand(raw.retired?.id === before.operation.record_page_id && (raw.retired.in_trash === true || raw.retired.archived === true),
          'SOURCE_RESUME_RECORD_LIVE', 'The original intent Record must be retired');
        await verifiedArtifact(raw.declaration, readArtifact);
        const proof = verifyNotionAgentOriginalSourceResume(shared.cliCandidate, raw);
        if (proof.status !== 'passed') {
          const issue = proof.diagnostics.find(row => row.severity === proof.status) ?? proof.diagnostics[0];
          throw new EvidenceError(proof.status, issue.code, 'The Agent must continue the original public Source operation', proof);
        }
        return { ...proof, operationId: raw.operationId, libraryId: raw.libraryId, readback: raw.readback.artifact };
      }
      case 'candidate-cli':
        need(shared.cliCandidate, 'CLI_CANDIDATE_EXECUTION_UNPROVEN', 'An actual paired CLI process is required');
        need(shared.cliCandidate.matchedCliCount >= expected.min, 'CLI_CANDIDATE_EXECUTION_MISSING',
          'Building the candidate or writing its command does not prove actual execution',
          { expectedMin: expected.min, observed: shared.cliCandidate.matchedCliCount });
        return { actual: shared.cliCandidate.matchedCliCount, distinctEntries: shared.cliCandidate.distinctEntries };
      case 'content-search': {
        const delivery = requireDelivery(), { source } = await sourceRequests({ requireHttpMetrics: false });
        return verifyNotionAgentContentSearch(expected, observed, bindings, { attempts: [...shared.attempts.values()], delivery, source, readArtifact });
      }
      case 'source-operation-attempts': {
        const { source, coverage } = await sourceRequests({ requireHttpMetrics: false });
        const starts = source.filter(row => row.phase === 'started' && row.kind === 'sdk' && row.operation === expected.operation);
        demand(expected.min === undefined || starts.length >= expected.min, 'SOURCE_OPERATIONS_TOO_FEW', 'A required SDK operation is missing');
        demand(expected.max === undefined || starts.length <= expected.max, 'SOURCE_OPERATIONS_TOO_MANY', 'A forbidden SDK operation was attempted');
        return { operation: expected.operation, actual: starts.length, requestIds: starts.map(row => row.requestId), coverage,
          counting: 'SDK calls including failed or cancelled operations; not HTTP attempts' };
      }
      case 'single-projection-restore': {
        need(shared.cliCandidate, 'CLI_CANDIDATE_EXECUTION_UNPROVEN', 'A completed paired CLI invocation is required');
        const proof = verifyNotionAgentSingleProjectionRestore(shared.cliCandidate);
        if (proof.status !== 'passed') {
          const issue = proof.diagnostics.find(row => row.severity === proof.status) ?? proof.diagnostics[0];
          throw new EvidenceError(proof.status, issue.code, 'Restoration must complete in one public CLI invocation', proof);
        }
        return proof;
      }
      case 'completed':
        need(shared.final && shared.delivery, 'TURN_COMPLETION_UNPROVEN', 'Provider and native completion are both required');
        return { finalSha256: shared.final.sha256 };
      case 'visibility': {
        const item = privateBindings.objects[expected.object];
        need(item, 'OBJECT_BINDING_MISSING', 'Visibility needs an actual target object');
        const name = item.name ?? bindings.public[expected.object + '.name'];
        need(nonempty(name), 'OBJECT_NAME_MISSING', 'Visibility needs the actual public object name');
        if (expected.stage === 'native-discovery') {
          need(item.kind === 'local' && isAbsolute(item.path ?? ''), 'NATIVE_IDENTITY_MISSING', 'Native discovery must bind an actual local Skill');
          const artifact = observed.visibility?.nativeCommands;
          const commands = JSON.parse((await verifiedArtifact(artifact, readArtifact)).toString('utf8'));
          need(Array.isArray(commands), 'NATIVE_COMMANDS_MISSING', 'Read the actual native command inventory');
          const matches = commands.filter(command => command.source === 'skill' && command.name === 'skill:' + name && command.sourceInfo?.path === item.path);
          demand(matches.length === 1, 'NATIVE_TARGET_NOT_DISCOVERED', 'The exact target was not discovered through native Skill loading');
          return { object: expected.object, path: item.path, artifact };
        }
        const delivery = requireDelivery();
        if (expected.stage === 'source-pending') {
          const first = delivery.requests[0], source = observed.visibility?.source;
          need(item.kind === 'notion' && nonempty(item.owner) && digest(item.scope), 'PENDING_OBJECT_IDENTITY_MISSING',
            'A pending target must be an independently bound Notion object');
          need(nonempty(source?.sourceId) && nonempty(source.library), 'PENDING_SOURCE_BINDING_MISSING',
            'Retain the actual configured target Source and library');
          const config = JSON.parse((await verifiedArtifact(source.configArtifact, readArtifact)).toString('utf8'));
          const configured = config.sources?.filter(item => item.type === 'notion' && item.enabled !== false && item.id === source.sourceId);
          need(configured?.length === 1 && sameLibrary(configured[0].library, source.library) &&
            sameLibrary(privateBindings.fixture?.libraryId, source.library), 'PENDING_SOURCE_SCOPE_MISMATCH',
          'The real enabled source configuration and independently read fixture library must agree');
          need(/^\d+$/u.test(first.monotonicNs ?? '') && Array.isArray(observed.source), 'PENDING_TIMING_MISSING', 'Pending discovery needs actual source and request clocks');
          const belongs = row => row.kind === 'sdk' && row.operation === 'list' && row.source_id === source.sourceId &&
            sameLibrary(row.library, source.library);
          const pending = observed.source.filter(row => row.phase === 'started' && belongs(row) &&
            /^\d+$/u.test(row.monotonicNs ?? '') && BigInt(row.monotonicNs) <= BigInt(first.monotonicNs)).filter(row =>
              !observed.source.some(end => end.phase === 'completed' && end.requestId === row.requestId &&
                /^\d+$/u.test(end.monotonicNs ?? '') && BigInt(end.monotonicNs) <= BigInt(first.monotonicNs)));
          demand(pending.length > 0 && /<ntn-skills-discovery\b[^>]*status="pending"/u.test(first.metadataText) &&
            /<ntn-skills-guidance\b/u.test(first.metadataText), 'SOURCE_NOT_PENDING', 'The first real request did not expose its target Notion source while loading');
          for (const operation of pending) {
            const ends = observed.source.filter(row => row.phase === 'completed' && row.requestId === operation.requestId);
            need(ends.length === 1 && belongs(ends[0]) && /^\d+$/u.test(ends[0].monotonicNs ?? '') &&
              BigInt(ends[0].monotonicNs) > BigInt(first.monotonicNs), 'PENDING_SOURCE_TERMINAL_MISSING',
            'The same target-source operation must retain its real later completion');
          }
          return { object: expected.object, sourceId: source.sourceId, library: source.library,
            configArtifact: source.configArtifact, payloadSha256: first.sha256, pendingOperations: pending.map(row => row.requestId) };

        }
        need(expected.stage === 'model-catalog', 'VISIBILITY_STAGE_UNSUPPORTED', 'Unsupported visibility stage');
        need(item.kind === 'notion' && nonempty(item.owner) && digest(item.scope), 'CATALOG_IDENTITY_MISSING', 'Notion catalog visibility needs its logical owner and source scope');
        const matches = [];
        for (const payload of delivery.requests) {
          const refs = payload.selection?.shortRefs;
          need(Array.isArray(refs), 'SHORT_REF_OBSERVATION_MISSING', 'Catalog short refs must come from the same actual request branch');
          for (const card of catalogCards(payload.metadataText)) {
            if (card.name !== name) continue;
            const resolved = refs.find(row => row.ref === card.ref)?.target;
            if (['candidate', 'selected'].includes(resolved?.kind) && resolved.identity?.source === 'notion' &&
              resolved.identity.id === item.owner && resolved.identity.scope === item.scope)
              matches.push({ payloadSha256: payload.sha256, ref: card.ref, owner: item.owner, scope: item.scope });
          }
        }
        demand(matches.length > 0, 'CATALOG_TARGET_NOT_VISIBLE', 'The exact target was absent from the actual model-visible catalog');
        return { object: expected.object, matches };
      }
      case 'metadata-lookup': {
        const delivery = requireDelivery(), { source } = await sourceRequests();
        return verifyNotionAgentMetadataLookup(expected, observed, bindings, {
          attempts: [...shared.attempts.values()], delivery, source, readArtifact,
        });
      }
      case 'forbidden-tool-input': {
        need(shared.toolObservation, 'TOOL_OBSERVATION_UNPROVEN', 'Forbidden inputs require complete actual tool observations');
        const facts = expected.facts.map(key => {
          const fact = privateBindings.facts[key];
          need(fact?.anyOf?.length, 'FACT_BINDING_MISSING', 'Missing private forbidden input ' + key);
          return { key, literals: fact.anyOf };
        });
        const found = shared.proposals.filter(call => call.name === expected.tool).flatMap(call => {
          const input = normalized(JSON.stringify(call.arguments));
          return facts.filter(fact => fact.literals.some(value => input.includes(normalized(value))))
            .map(fact => ({ toolCallId: call.id, fact: fact.key, isError: call.result?.isError }));
        });
        demand(!found.length, 'FORBIDDEN_TOOL_INPUT', 'An actual tool attempt used a forbidden package or fallback input', { found });
        return { tool: expected.tool, facts: expected.facts, matches: 0 };
      }
      case 'tool-attempts': {
        need(shared.toolObservation, 'TOOL_OBSERVATION_UNPROVEN', 'Attempt counts require complete actual tool observations');
        const attempts = shared.proposals.filter(call => call.name === expected.tool);
        demand(expected.min === undefined || attempts.length >= expected.min, 'TOOL_ATTEMPTS_TOO_FEW', 'Required actual tool attempts are missing');
        demand(expected.max === undefined || attempts.length <= expected.max, 'TOOL_ATTEMPTS_TOO_MANY', 'Forbidden or unnecessary actual tool attempts occurred');
        return { tool: expected.tool, actual: attempts.filter(call => call.dispatched).length, proposed: attempts.length,
          retracted: attempts.filter(call => !call.dispatched).length, ids: attempts.map(call => call.id), errors: attempts.filter(call => call.result?.isError).length };
      }
      case 'body': {
        const delivery = requireDelivery();
        const payloads = expected.scope === 'all' || expected.occurrences === 0 ? delivery.requests : [delivery.last];
        // Zero is an exposure prohibition over every raw payload. A positive
        // receipt assertion counts deliveries of this logical file, not matching
        // text in creation inputs, unrelated owners or another retained version.
        const owned = expected.occurrences > 0 && expected.receiptRequired !== false;
        const body = privateBindings.bodies[expected.body], localPath = owned ? localBodyPath(expected.body) : undefined;
        let target, resourcePath;
        if (owned && !localPath) {
          const owners = Object.entries(privateBindings.objects).flatMap(([alias, item]) =>
            Object.entries(item.versions).filter(([, version]) => version.bodyKeys?.includes(expected.body))
              .map(([label]) => resolveObject(privateBindings, alias, label)));
          need(owners.length === 1 && owners[0].kind === 'notion', 'BODY_OWNER_MISSING',
            'Receipt-required bytes need one independently bound logical owner and version');
          target = owners[0];
          resourcePath = body.resourcePath ?? (expected.body.endsWith('/SKILL.md') ? 'SKILL.md' : undefined);
          need(nonempty(resourcePath), 'BODY_PATH_MISSING', 'A receipt-required body needs its exact logical file path');
        }
        const counts = [];
        for (const payload of payloads) {
          const rawOccurrences = bodyCount(expected.body, payload);
          let actual = rawOccurrences;
          if (owned && localPath) {
            const proof = payload.nativeReadBodies.filter(row => row.body === expected.body && row.path === localPath);
            need(proof.length === 1, 'LOCAL_BODY_DELIVERY_MISSING',
              'Full local bytes require their successful actual read response in this payload');
            actual = proof[0].occurrences;
          } else if (owned) {
            actual = payload.notionDeliveries.filter(proof => proof.owner === target.owner && proof.scope === target.scope &&
              proof.snapshot_id === target.snapshot_id && proof.version_id === target.version_id &&
              proof.path === resourcePath && proof.sha256 === body.sha256 && proof.bytes === body.bytes).length;
          }
          if (owned && rawOccurrences > 0) need(actual > 0, localPath ? 'LOCAL_BODY_DELIVERY_MISSING' : 'BODY_RECEIPT_MISSING',
            'Matching text without the exact successful owner delivery cannot prove this body',
            { body: expected.body, payloadSha256: payload.sha256, actual, rawOccurrences });
          demand(actual === expected.occurrences, 'BODY_OCCURRENCE_MISMATCH',
            owned ? 'Required logical file delivery count differs in an actual request' : 'Required full-text count differs in an actual request',
            { body: expected.body, payloadSha256: payload.sha256, expected: expected.occurrences, actual, rawOccurrences,
              counting: owned ? 'owner-bound-delivery' : 'payload-text' });
          counts.push({ payloadSha256: payload.sha256, actual, rawOccurrences });
        }
        return { body: expected.body, payloads: payloads.map(row => row.sha256), occurrences: expected.occurrences,
          counting: owned ? 'owner-bound-delivery' : 'payload-text', counts };
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
          need(delivery.last.notionDeliveries.some(proof => proof.owner === target.owner && proof.scope === target.scope &&
            proof.snapshot_id === target.snapshot_id && proof.version_id === target.version_id && proof.path === expected.path &&
            proof.sha256 === body.sha256 && proof.bytes === body.bytes), 'WRONG_RESOURCE_OWNER',
          'The complete resource needs an exact owner/version receipt bound to its actual payload message',
          { target, path: expected.path, rejected: delivery.last.rejectedNotionReceipts });
        } else {
          const path = localBodyPath(keys[0]);
          const proofs = delivery.last.nativeReadBodies.filter(row => row.body === keys[0] && row.path === path);
          need(proofs.length === 1 && proofs[0].occurrences > 0, 'LOCAL_RESOURCE_DELIVERY_MISSING',
            'The local resource needs its exact successful read result in the actual provider request');
        }
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
      case 'clarification': {
        const request = factFound(expected.topic) && clarificationRequest(shared.final.text, privateBindings.facts[expected.topic].anyOf);
        demand(request,
          'CLARIFICATION_MISSING', 'The necessary business clarification was not asked');
        return { topic: expected.topic, request };
      }
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
      case 'source-network-attempts': {
        let count, details;
        if (observed.effects) {
          const effects = await subjectEffects();
          need(Number.isSafeInteger(effects.notionHttpAttempts) && effects.notionHttpAttempts >= 0,
            'SOURCE_NETWORK_METRIC_MISSING', 'The complete effects observation must explicitly measure Notion HTTP attempts');
          count = effects.notionHttpAttempts;
          details = { coverage: effects.coverage, artifact: effects.artifact };
        } else {
          const observedRequests = await sourceRequests();
          count = observedRequests.attempts.length;
          const { source: _source, attempts: _attempts, ...scope } = observedRequests;
          details = scope;
        }
        demand(expected.min === undefined || count >= expected.min, 'SOURCE_NETWORK_ATTEMPTS_TOO_FEW', 'Required source network attempts are missing');
        demand(expected.max === undefined || count <= expected.max, 'SOURCE_NETWORK_ATTEMPTS_TOO_MANY', 'The source attempted forbidden network access', { actual: count });
        return { actual: count, ...details, counting: 'actual-attempts-including-failures' };
      }
      case 'no-semantic-writes': {
        if (observed.effects) {
          const effects = await subjectEffects();
          need(Number.isSafeInteger(effects.semanticWrites) && effects.semanticWrites >= 0 && typeof effects.externalRepair === 'boolean',
            'EFFECTS_COVERAGE_MISSING', 'Unknown child-process effects cannot be treated as zero');
          demand(effects.semanticWrites === 0 && effects.externalRepair === false, 'UNAUTHORIZED_SEMANTIC_WRITE', 'A read-only task changed Notion semantics or required repair');
          return { semanticWrites: 0, coverage: effects.coverage, artifact: effects.artifact };
        }
        demand((observed.source ?? []).filter(row => row.phase === 'attempt')
          .every(row => row.request_kind !== 'notion_write' && !['PATCH', 'PUT', 'DELETE'].includes(row.method)),
          'UNAUTHORIZED_SEMANTIC_WRITE', 'Source transport attempted a Notion mutation');
        const { source, attempts: _attempts, ...details } = await sourceRequests();
        return { semanticWrites: 0, ...details,
          backgroundCatalogRequests: source.filter(row => row.phase === 'started' && row.operation === 'list').length };
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
    delivery: shared.delivery ? { requests: shared.delivery.requests.map(({ usage, selection, metadataText, ...row }) => row),
      lastPayloadSha256: shared.delivery.last.sha256 } : null,
    session: observed.session ? { sessionId: observed.session.sessionId, leafId: observed.session.leafId,
      branchSha256: observed.session.branchSha256, currentUserId: observed.session.currentUserId } : null };
}
