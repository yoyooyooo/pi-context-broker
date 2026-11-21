import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { providerApplicationCompletion } from './skill-consumption-provider.mjs';
import { validateAgentAssertion, validateAgentBindings } from './notion-agent-scenarios.mjs';
import { correlateNotionAgentToolAttempts, inspectNotionAgentReadOnlyContainer } from './notion-agent-tool-lineage.mjs';
import { verifyPreparationEvidence } from './skill-preparation-evidence.mjs';

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
const databaseKey = value => typeof value === 'string' && /^[a-f0-9]{32}$/iu.test(value.replaceAll('-', ''))
  ? value.replaceAll('-', '').toLowerCase() : value;
const sameDatabase = (left, right) => nonempty(left) && nonempty(right) && databaseKey(left) === databaseKey(right);
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
  need(registrations.length === 1 && source?.origin === 'package' && ['project', 'user'].includes(source.scope) &&
    source.baseDir === root && source.source === root && source.path === entry[0].path,
  'TOOL_IMPLEMENTATION_UNKNOWN', 'The live host must register this exact frozen Broker package');
  return { source, commit: selected[0].commit, entrySha256: entry[0].sha256 };
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
          content: { sha256: hash(text), bytes: Buffer.byteLength(text) }, delivery: span };
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
  shared.attempts = new Map(); shared.proposals = [];
  shared.toolObservation = await check('tool-attempt-observation', () => {
    const correlation = correlateNotionAgentToolAttempts({ tasks, session: observed.session });
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
        for (const call of [...shared.attempts.values()].filter(call => call.name === 'read' && call.result?.isError === false &&
          call.native?.isError === false && actualReadPath(call.arguments?.path) === path)) {
          let content;
          if (call.provenance?.kind === 'native-nested-summary') {
            need(call.result.contentArtifact, 'NESTED_READ_RESULT_MISSING',
              'A composed read needs its own observed complete result, not just script-generated parent output', { toolCallId: call.id });
            content = JSON.parse((await verifiedArtifact(call.result.contentArtifact, readArtifact)).toString('utf8'));
          } else content = observed.session.branchEntries.find(entry => entry.id === call.native.resultEntryId)?.message?.content;
          if (textOf(content).includes(frozen.text)) calls.push(call);
        }
        const ids = new Set(calls.map(call => call.deliveryToolCallId));
        const messages = (payload.messages ?? []).filter(message => message.role === 'tool' && ids.has(message.tool_call_id));
        const count = inspectPayload({ ...payload, messages }, [frozen])[0];
        need(count && count.sha256 === frozen.sha256 && Number.isSafeInteger(count.occurrences) && count.occurrences >= 0,
          'NATIVE_BODY_METRIC_MISSING', 'The actual native tool response requires an independent full-body count');
        nativeReadBodies.push({ body: key, path, sha256: frozen.sha256, occurrences: count.occurrences, toolCallIds: calls.map(call => call.id), deliveryToolCallIds: [...ids] });
      }
      const notion = boundNotionDeliveries(payload, tasks, uniqueBodies);
      payloads.push({ request: request.request, wireRequestId: sent.id, sha256: task.sha256, bytes: task.bytes, bodies, bodyObservation, nativeReadBodies,
        notionDeliveries: notion.deliveries, rejectedNotionReceipts: notion.rejected,
        monotonicNs: task.monotonicNs, metadataText: (payload.messages ?? []).filter(message => ['user', 'system'].includes(message.role)).map(message => textOf(message.content)).join('\n'),
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

  const interactionProofs = new Map(), toolOwners = new Map();
  let brokerOwner;
  const sourceRequests = async () => {
    need(shared.toolObservation, 'TOOL_OBSERVATION_UNPROVEN', 'Source effects require complete actual tool observations');
    need(observed.sourceCoverage === true && Array.isArray(observed.source), 'SOURCE_COVERAGE_MISSING', 'Complete source observation is required for source effects');
    const source = observed.source, starts = source.filter(row => row.phase === 'started'), attempts = source.filter(row => row.phase === 'attempt');
    const ids = new Set(starts.map(row => row.requestId));
    need(ids.size === starts.length && attempts.every(row => ids.has(row.requestId)),
      'SOURCE_OPERATION_CORRELATION_MISSING', 'Source attempts need unique observed operations');
    for (const start of starts) {
      const metric = source.filter(row => row.phase === 'metrics' && row.requestId === start.requestId);
      need(metric.length === 1 && metric[0].observed === true && metric[0].complete === true &&
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
      if (['read', 'grep', 'find', 'ls', 'tool_search'].includes(call.name) &&
        source?.source === 'builtin' && source.path === 'builtin:' + call.name) {
        toolOwners.set(call.id, { toolCallId: call.id, owner: 'builtin', path: source.path });
      } else if (['read', 'notion_list', 'notion_use', 'notion_ctl'].includes(call.name)) {
        brokerOwner ??= observedBrokerToolOwner(observed, readArtifact);
        const expected = await brokerOwner;
        need(source && ['path', 'source', 'scope', 'origin', 'baseDir'].every(key => source[key] === expected.source[key]),
          'TOOL_IMPLEMENTATION_UNKNOWN', 'A familiar tool name cannot impersonate the frozen Broker owner', { tool: call.name, toolCallId: call.id });
        toolOwners.set(call.id, { toolCallId: call.id, owner: 'broker', path: source.path,
          commit: expected.commit, entrySha256: expected.entrySha256 });
      }
    }
    const readOnly = call => interactionProofs.has(call.id) || toolOwners.has(call.id) &&
      (call.name !== 'notion_ctl' || object(call.arguments) && (call.arguments.working_set === 'show' || nonempty(call.arguments.cli_source)) &&
        Object.keys(call.arguments).every(key => ['working_set', 'cli_source'].includes(key))) ||
      call.name === 'codemode' && inspectNotionAgentReadOnlyContainer(call, shared.correlation, readOnly).readOnly;
    for (const call of shared.attempts.values())
      need(readOnly(call), 'TOOL_EFFECTS_UNKNOWN', 'An executed tool has effects outside the observed SDK boundary', { tool: call.name, toolCallId: call.id });
    return { source, attempts, coverage: 'subject-tool-operations-with-complete-SDK-metrics',
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

  for (const expected of turn.expect) await check(expected.kind, async () => {
    switch (expected.kind) {
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
          need(nonempty(source?.sourceId) && nonempty(source.database), 'PENDING_SOURCE_BINDING_MISSING',
            'Retain the actual configured target Source and database');
          const config = JSON.parse((await verifiedArtifact(source.configArtifact, readArtifact)).toString('utf8'));
          const configured = config.sources?.filter(item => item.type === 'notion' && item.enabled !== false && item.id === source.sourceId);
          need(configured?.length === 1 && sameDatabase(configured[0].database, source.database) &&
            sameDatabase(privateBindings.fixture?.entry, source.database), 'PENDING_SOURCE_SCOPE_MISMATCH',
          'The real enabled source configuration and independently read fixture library must agree');
          need(/^\d+$/u.test(first.monotonicNs ?? '') && Array.isArray(observed.source), 'PENDING_TIMING_MISSING', 'Pending discovery needs actual source and request clocks');
          const belongs = row => row.kind === 'sdk' && row.operation === 'list' && row.source_id === source.sourceId &&
            sameDatabase(row.database, source.database);
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
          return { object: expected.object, sourceId: source.sourceId, database: source.database,
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
