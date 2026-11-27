import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, fingerprint } from './protocol.mjs';
import { gradeEpisode } from './corpus/grader.mjs';
import { readTurnControlEvidence, collectTurnFacts } from './collect-turns.mjs';
import { known, unknown, normalizeEpisode } from './evidence/normalize.mjs';
import { assessReportedModel, providerReportedModel, validateRoutingPolicy } from './reported-model.mjs';
import { deriveRedactedProviderBinding } from './provider-binding.mjs';
export { deriveRedactedProviderBinding } from './provider-binding.mjs';
import { verifyArtifactFiles, writeEvidenceBundle } from './evidence/store.mjs';
import { readProviderTransport } from '../scripts/skill-consumption-provider.mjs';
import { parseSourceObservation } from '../scripts/skill-consumption-source-observer.mjs';
import { graphSourceViews, verifyPreparationEvidence, retainedMaterialSelection, retainedSelectionSnapshots, RETAINED_SOURCE_CONTRACT } from './retained-source-views.mjs';
import { CURRENT_SOURCE_CONTRACT, loadCurrentSourceViews } from './current-source-views.mjs';
import { pairedBrokerEntry } from './paired-broker-entry.mjs';

export const COLLECTOR_VERSION = '1.2.2';
export const CURRENT_COLLECTOR_VERSION = '1.3.3';
const retainedSourceViews = { contract: RETAINED_SOURCE_CONTRACT, graphSourceViews, verifyPreparationEvidence };
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const finite = value => Number.isSafeInteger(value) && value >= 0;
const cleanRef = ref => ref && Object.hasOwn(ref, 'line') ? { artifact_id: ref.artifact_id, sha256: ref.sha256, line: ref.line }
  : ref ? { artifact_id: ref.artifact_id, sha256: ref.sha256, pointer: ref.pointer ?? '' } : null;
const uniqueRefs = values => [...new Map(values.filter(Boolean).map(ref => [canonicalJson(ref), ref])).values()];
const textContent = content => typeof content === 'string' ? content : Array.isArray(content) && content.every(part => part?.type === 'text')
  ? content.map(part => part.text).join('\n') : null;
const jsonPointer = (value, pointer) => {
  for (const part of pointer === '' ? [] : pointer.slice(1).split('/')) value = value?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  return value;
};
async function writeOnce(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.ok((await readFile(path)).equals(Buffer.from(bytes)), 'Refusing to overwrite a different collected observation: ' + path);
  }
}
// Capture the local static import closure when this implementation is loaded.
// Later collection rechecks these bytes; changing code produces a new identity.
async function implementationSources(entry) {
  const repository = fileURLToPath(new URL('../', entry)), found = new Map();
  async function visit(url) {
    const path = fileURLToPath(url);
    if (found.has(path)) return;
    assert.ok(inside(repository, path), 'Analysis implementation dependency escaped the repository');
    const bytes = await readFile(path), row = { path, relative_path: relative(repository, path).split(sep).join('/'),
      sha256: hash(bytes), bytes };
    found.set(path, row);
    if (!path.endsWith('.mjs')) return;
    const imports = /(?:^|\n)\s*(?:import|export)\s+(?:(?:[^\n;]+?)\s+from\s+)?['\"](\.[^'\"]+)['\"]/g;
    for (const match of bytes.toString('utf8').matchAll(imports)) await visit(new URL(match[1], url));
  }
  await visit(entry);
  return [...found.values()].sort((a, b) => a.relative_path.localeCompare(b.relative_path));
}
const loadedImplementation = implementationSources(import.meta.url);

function localPath(root, name) {
  assert.ok(typeof name === 'string' && name && !isAbsolute(name));
  const path = resolve(root, name); assert.ok(inside(root, path) && path !== root, 'Declared output escapes the workspace');
  return path;
}

/** Provider-reported components only; absent cache/reasoning is not a zero observation. */
export function collectRawUsage(api, event) {
  const source = api === 'openai-completions' ? event?.usage : api === 'openai-responses' ? event?.response?.usage : null;
  if (!object(source)) return null;
  const responses = api === 'openai-responses';
  const number = value => finite(value) ? value : null;
  const input = number(source[responses ? 'input_tokens' : 'prompt_tokens']);
  const output = number(source[responses ? 'output_tokens' : 'completion_tokens']);
  const inputDetails = source[responses ? 'input_tokens_details' : 'prompt_tokens_details'];
  const outputDetails = source[responses ? 'output_tokens_details' : 'completion_tokens_details'];
  const total = number(source.total_tokens);
  return { input, output, cache_read: number(inputDetails?.cached_tokens ?? source.prompt_cache_hit_tokens ?? source.cached_tokens),
    cache_write: number(inputDetails?.cache_write_tokens), reasoning: number(outputDetails?.reasoning_tokens ?? source.reasoning_tokens),
    complete: input !== null && output !== null && (source.total_tokens === undefined || total === input + output),
    raw_pointer: responses ? '/response/usage' : '/usage', input_semantics: 'includes_cache', output_semantics: 'includes_reasoning' };
}

/** Recover only the exact recorder marker from an independently observed, unique
 * provider configuration key. A missing or arbitrary provider is never accepted. */

/** Runtime-owned execution callbacks, not model proposals or CodeMode display previews. */
export function collectRuntimeTools(events, eventArtifact, sessionEntries = null, sessionArtifact = null) {
  const starts = new Map(), ends = new Map(), errors = [], native = new Map(), proposals = new Map();
  const ref = index => ({ artifact_id: eventArtifact.id, sha256: eventArtifact.sha256, line: index + 1 });
  for (const [index, row] of events.entries()) {
    if (row.type !== 'session_event') continue;
    const event = row.data;
    if (!['tool_execution_start', 'tool_execution_end'].includes(event?.type)) continue;
    const target = event.type === 'tool_execution_start' ? starts : ends;
    if (typeof event.toolCallId !== 'string' || target.has(event.toolCallId)) { errors.push('Duplicate or missing native tool callback identity'); continue; }
    target.set(event.toolCallId, { event, ref: ref(index), turn_id: row.turn_id ?? null, seq: index + 1 });
  }
  for (const [index, entry] of (sessionEntries?.entries ?? []).entries()) {
    const message = entry.message;
    const ref = sessionArtifact ? { artifact_id: sessionArtifact.id, sha256: sessionArtifact.sha256, pointer: '/entries/' + index + '/message' } : null;
    if (message?.role === 'assistant') for (const call of message.content ?? [])
      if (call.type === 'toolCall' && typeof call.id === 'string') proposals.set(call.id, { call, ref });
    if (message?.role === 'toolResult' && typeof message.toolCallId === 'string') {
      if (native.has(message.toolCallId)) errors.push('Duplicate native persisted tool result');
      native.set(message.toolCallId, { message, ref });
    }
  }
  const tools = [];
  for (const [id, start] of starts) {
    const end = ends.get(id), persisted = native.get(id);
    if (!end) errors.push('Missing tool execution end: ' + id);
    if (end && (end.event.toolName !== start.event.toolName || (end.event.parentToolCallId ?? null) !== (start.event.parentToolCallId ?? null)))
      errors.push('Tool identity or ancestry changed: ' + id);
    if (end && (end.seq <= start.seq || end.turn_id !== start.turn_id)) errors.push('Tool lifetime or turn changed: ' + id);
    let result = end?.event.result ?? null;
    if (persisted && (persisted.message.toolName !== start.event.toolName || persisted.message.isError !== end?.event.isError ||
        canonicalJson(persisted.message.content ?? null) !== canonicalJson(result?.content ?? null)))
      errors.push('Persisted tool result differs from its callback: ' + id);
    if (persisted && result && !result.details && persisted.message.details &&
        canonicalJson(result.content ?? null) === canonicalJson(persisted.message.content ?? null))
      result = { ...result, details: persisted.message.details };
    const isError = end?.event.isError ?? result?.isError;
    tools.push({ id, parent_id: start.event.parentToolCallId ?? null, name: start.event.toolName,
      args: structuredClone(start.event.args ?? {}), status: isError === true ? 'fail' : isError === false ? 'pass' : 'unknown',
      result: structuredClone(result), turn_id: start.turn_id, execution: 'observed', sequence: start.seq, end_sequence: end?.seq ?? null,
      refs: uniqueRefs([start.ref, end?.ref, persisted?.ref]), interface_misuse: null });
  }
  for (const [id, end] of ends) if (!starts.has(id)) errors.push('Tool result without execution start: ' + id);
  // A rejected call can have a persisted native result without an execution callback.
  for (const [id, item] of native) if (!starts.has(id)) {
    const proposal = proposals.get(id);
    if (!proposal || proposal.call.name !== item.message.toolName || item.message.isError !== true) {
      errors.push('Uncorrelated persisted native tool result: ' + id); continue;
    }
    tools.push({ id, parent_id: null, name: item.message.toolName, args: proposal.call.arguments ?? {}, status: 'fail',
      result: structuredClone(item.message), turn_id: null, execution: 'rejected_before_execution', sequence: null,
      refs: uniqueRefs([proposal.ref, item.ref]), interface_misuse: null });
  }
  const ids = new Set(tools.map(tool => tool.id));
  for (const tool of tools) if (tool.parent_id !== null && !ids.has(tool.parent_id)) {
    errors.push('Unobserved parent for nested call: ' + tool.id);
    tool.observed_parent_id = tool.parent_id; tool.parent_id = null; tool.ancestry = 'unknown';
  }
  const byId = new Map(tools.map(tool => [tool.id, tool]));
  for (const tool of tools) if (tool.parent_id !== null) {
    const parent = byId.get(tool.parent_id);
    if (!tool.turn_id || tool.turn_id !== parent.turn_id || !(parent.sequence < tool.sequence &&
        tool.sequence < tool.end_sequence && tool.end_sequence < parent.end_sequence)) {
      errors.push('Nested tool lifetime is not inside its parent: ' + tool.id);
      tool.observed_parent_id = tool.parent_id; tool.parent_id = null; tool.ancestry = 'unknown';
    }
  }
  for (const tool of tools.filter(tool => tool.name === 'codemode' && tool.execution === 'observed')) {
    const message = native.get(tool.id)?.message, summary = message?.nestedCalls, reasons = [], descendants = [];
    const visit = parent => { for (const child of tools.filter(item => item.parent_id === parent)) { descendants.push(child); visit(child.id); } };
    visit(tool.id); // Strict lifetime containment above excludes ancestry cycles.
    if (!native.get(tool.id)?.ref) reasons.push('Native census has no retained artifact');
    if (!summary || summary.complete !== true || !Array.isArray(summary.calls)) reasons.push('Complete native nested-call census is missing');
    else {
      const declared = new Set();
      for (const child of summary.calls) {
        const actual = descendants.find(item => item.id === child?.id);
        if (!actual || declared.has(child.id) || child.name !== actual.name || !object(child.arguments) ||
            child.argumentsBytes !== undefined || canonicalJson(child.arguments) !== canonicalJson(actual.args) ||
            !['ok', 'error'].includes(child.status) || (child.status === 'ok' ? 'pass' : 'fail') !== actual.status)
          reasons.push('Nested census differs from actual callbacks');
        declared.add(child?.id);
      }
      if (declared.size !== descendants.length || descendants.some(child => !declared.has(child.id))) reasons.push('Nested callback set differs from the census');
      const direct = message.details?.calls, children = descendants.filter(child => child.parent_id === tool.id);
      if (canonicalJson(direct ?? null) !== canonicalJson(tool.result?.details?.calls ?? null)) reasons.push('Callback and persisted direct census disagree');
      if (!Array.isArray(direct) || direct.length !== children.length || new Set(direct.map(child => child?.id)).size !== children.length ||
          direct.some(child => !children.some(actual => actual.id === child?.id && actual.name === child.name &&
            ['ok', 'error', 'cancelled'].includes(child.status) && (child.status === 'ok' ? 'pass' : 'fail') === actual.status)))
        reasons.push('Direct CodeMode census differs from actual callbacks');
    }
    if (summary && reasons.length) errors.push('Unverified nested tool census: ' + tool.id);
    if (descendants.some(child => child.status !== 'pass')) reasons.push('An executed descendant did not finish successfully');
    tool.container = { complete: reasons.length === 0 && tool.status === 'pass', descendant_ids: descendants.map(child => child.id),
      reasons, refs: uniqueRefs([native.get(tool.id)?.ref, ...descendants.flatMap(child => child.refs)]) };
  }
  if (errors.length) for (const tool of tools) if (tool.container) tool.container.complete = false;
  return { tools, complete: errors.length === 0, errors };
}

// Reviewed Pi builtin wrapper contract: QuickJS receives tool bridges, not Node,
// filesystem or network globals. This pin does not attest the whole installation.
const codeModeModules = {
  'index.js': ['7306902a1079689f601231d4c9bd3abb1d92ec388d202ff08920e4aee87343f4', 1620],
  'tool.js': ['6904d6b3ebb66e6d9b6eac5cce8f70c11d01ddc3a0a0422ba78645558476d319', 17993],
  'execute.js': ['18c746d8ec9ad52c17bae4357a374629d500823e7744281905c8a1faf9c17791', 34675],
};
export function verifiedCodeModeRuntime({ candidate, expected, admission, after }) {
  try {
    assert.deepEqual(candidate.projection, expected.projection); assert.deepEqual(admission.differences, []);
    assert.deepEqual(after.differences, []);
    const pinned = files => Object.entries(codeModeModules).map(([name, [sha256, bytes]]) => {
      const matches = files.filter(file => file.path?.endsWith('/dist/extensions/codemode/' + name));
      assert.equal(matches.length, 1); assert.equal(matches[0].sha256, sha256); assert.equal(matches[0].bytes, bytes);
      return matches[0];
    });
    for (const view of [candidate.snapshot, candidate.projection]) {
      assert.equal(view.entry_kind, 'pi-sdk'); assert.equal(view.code_mode.enabled, true); assert.equal(view.code_mode.models, false);
      assert.equal(view.factories.codemode, 'public createCodemodeExtension, models:false');
      const owners = view.extensions.filter(extension => extension.tools.includes('codemode'));
      assert.equal(owners.length, 1); assert.equal(owners[0].resolved_path, 'builtin:codemode');
      assert.deepEqual(owners[0].handlers, []);
      const declared = view.tools.all.filter(tool => tool.name === 'codemode');
      assert.equal(declared.length, 1); assert.equal(declared[0].sourceInfo.path, 'builtin:codemode');
      assert.equal(declared[0].sourceInfo.source, 'builtin'); pinned(view.pi.files);
    }
    assert.deepEqual(pinned(candidate.snapshot.pi.files), pinned(after.files));
    return true;
  } catch { return false; }
}

// Reviewed Broker owner and metadata-only list branch, paired by source revision.
// Changed or mixed producers remain opaque; a tool name is not evidence.
const notionMetadataProducers = [{
  'src/index.ts': '292fc3c967cb2d4235eaf8412f582b18391250d46c332a1c67ea2934e1602d63',
  'src/host-skills.ts': 'c24c6d08799dfa1e353b9bc282e16b44a8ad141229b681a51ef2bad84f6d6ae1',
}, {
  'src/index.ts': 'e76e3c3ac75e5c6f1ca9668e60f5addc625471ce68cb3a7cec20b02f4ea60482',
  'src/host-skills.ts': 'eb9153cdc6e3b6665633d80e6bca804bb72df7447eccd5ab98510640798da205',
}, {
  // 3d57426c routes by local Library identity; only an observed SDK list below
  // can establish directory evidence. Local selection and candidates cannot.
  'src/index.ts': 'bfbf2d32db29c53a09f933ee657e467ef7132bcaf65becb4d19fac3c8efd8bd9',
  'src/host-skills.ts': 'ddfd7abf4d501c97c69d3d8baf4d3b4656fe9878361735f42d86e1742c5d9f59',
}];
export function verifiedNotionListRuntime({ candidate, expected, admission, files, build }) {
  try {
    assert.deepEqual(candidate.projection, expected.projection); assert.deepEqual(admission.differences, []);
    const producer = notionMetadataProducers.find(producer => Object.entries(producer).every(([path, sha256]) => {
      const matches = files.filter(file => file.name === path);
      return matches.length === 1 && matches[0].sha256 === sha256;
    }));
    assert.ok(producer, 'The complete Broker metadata producer tuple must be reviewed');
    const selected = pairedBrokerEntry(build, dirname(candidate.snapshot.build.path));
    assert.equal(selected.package_path, 'src/index.ts', 'The reviewed producer depends on its original relative imports');
    assert.equal(selected.sha256, producer['src/index.ts']);
    for (const [view, path] of [[candidate.snapshot, selected.path],
      [candidate.projection, '$BUILD' + selected.path.slice(build.root.length)]]) {
      assert.equal(view.entry_kind, 'pi-sdk'); assert.equal(view.mode, 'broker');
      const owners = view.extensions.filter(extension => extension.tools.includes('notion_list'));
      assert.equal(owners.length, 1); assert.equal(owners[0].resolved_path, path);
      assert.equal(owners[0].entry.path, path); assert.equal(owners[0].entry.realpath, path);
      assert.equal(owners[0].entry.sha256, producer['src/index.ts']);
      const declarations = view.tools.all.filter(tool => tool.name === 'notion_list');
      assert.equal(declarations.length, 1); assert.equal(declarations[0].sourceInfo.path, path);
      assert.equal(declarations[0].sourceInfo.source, 'cli'); assert.equal(declarations[0].exposure, 'direct');
      const launch = view.launch_profile.extensions.filter(extension => extension.role === 'broker');
      assert.equal(launch.length, 1); assert.equal(launch[0].path, path);
      assert.equal(launch[0].sha256, producer['src/index.ts']);
    }
    return true;
  } catch { return false; }
}

/** Only a verified current producer's closed metadata projection is exempt.
 * The directory match proves metadata identity, not Skill adoption or absence. */
export function notionMetadataEvidence(tool, { runtime, directories, sources }) {
  if (tool.name !== 'notion_list' || runtime.status !== 'verified') return null;
  try {
    assert.equal(runtime.status, 'verified'); assert.equal(tool.name, 'notion_list'); assert.equal(tool.status, 'pass');
    assert.equal(tool.execution, 'observed');
    const keys = (value, allowed, required = allowed) => {
      assert.ok(object(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)));
    };
    const args = tool.args;
    keys(args, ['query', 'source', 'limit', 'search_in', 'refresh', 'cursor'], []);
    assert.ok(args.search_in === undefined || args.search_in === 'metadata');
    assert.ok(args.query === undefined || typeof args.query === 'string' && args.query.length <= 512);
    assert.ok(args.source === undefined || typeof args.source === 'string');
    assert.ok(args.limit === undefined || Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= 100);
    assert.ok(args.refresh === undefined || typeof args.refresh === 'boolean');
    assert.ok(args.cursor === undefined || typeof args.cursor === 'string' && /^(0|[1-9][0-9]*)\.[a-f0-9]{64}$/.test(args.cursor));
    assert.ok(!(args.refresh === true && args.cursor !== undefined));
    keys(tool.result, ['content', 'details', 'isError'], ['content', 'details']); assert.notEqual(tool.result.isError, true);
    assert.equal(tool.result.content.length, 1); keys(tool.result.content[0], ['type', 'text']);
    assert.equal(tool.result.content[0].type, 'text');
    const result = tool.result.details;
    keys(result, ['ok', 'state', 'count', 'has_more', 'total_count', 'next_cursor', 'freshness', 'coverage', 'records', 'failures']);
    assert.equal(result.ok, true); assert.equal(result.state, 'known'); assert.deepEqual(result.failures, []);
    assert.ok(Array.isArray(result.records)); assert.equal(result.count, result.records.length);
    assert.ok(finite(result.total_count) && result.total_count >= result.count); assert.equal(typeof result.has_more, 'boolean');
    assert.ok(result.next_cursor === null || typeof result.next_cursor === 'string' && /^(0|[1-9][0-9]*)\.[a-f0-9]{64}$/.test(result.next_cursor));
    keys(result.freshness, ['sources']); keys(result.coverage, ['exhaustive', 'sources']);
    assert.equal(result.coverage.exhaustive, true); assert.ok(result.coverage.sources.length > 0);
    const matched = [], allowedSources = new Set();
    for (const coverage of result.coverage.sources) {
      keys(coverage, ['source', 'exhaustive']); assert.equal(coverage.exhaustive, true);
      assert.ok(!allowedSources.has(coverage.source)); allowedSources.add(coverage.source);
      const configured = sources.filter(source => source.type === 'notion' && source.enabled !== false && source.id === coverage.source);
      assert.equal(configured.length, 1); assert.ok(args.source === undefined || args.source === coverage.source);
      assert.ok(typeof configured[0].library === 'string' && configured[0].library.length > 0);
      const observed = directories.filter(item => item.value.library_id === configured[0].library && item.end_sequence < tool.end_sequence);
      assert.ok(observed.length > 0); matched.push(...observed);
    }
    assert.equal(result.freshness.sources.length, allowedSources.size);
    const freshSources = new Set();
    for (const fresh of result.freshness.sources) {
      keys(fresh, ['source', 'policy', 'validated_at', 'age_ms', 'max_age_ms', 'stale']);
      assert.ok(allowedSources.has(fresh.source) && !freshSources.has(fresh.source)); freshSources.add(fresh.source);
      assert.ok(['default', 'refresh', 'offline'].includes(fresh.policy));
      assert.ok(typeof fresh.validated_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(fresh.validated_at) && Number.isFinite(Date.parse(fresh.validated_at)));
      assert.ok(finite(fresh.age_ms) && finite(fresh.max_age_ms)); assert.equal(typeof fresh.stale, 'boolean');
    }
    for (const record of result.records) {
      keys(record, ['id', 'ref', 'kind', 'name', 'description', 'source', 'scope', 'in_default_view', 'availability']);
      assert.equal(record.kind, 'skill'); assert.equal(record.availability, 'available');
      assert.equal(typeof record.in_default_view, 'boolean'); assert.ok(allowedSources.has(record.source));
      const source = sources.find(source => source.id === record.source);
      const matches = matched.flatMap(item => item.value.library_id === source.library && item.value.scope === record.scope
        ? item.value.records.filter(row => row.id === record.id && row.kind === record.kind && row.name === record.name && row.description === record.description && row.enabled === true) : []);
      assert.ok(matches.length > 0);
      assert.ok(matches.some(row => row.ref === record.ref) || /^sr:[A-Za-z0-9_-]{23}$/.test(record.ref));
    }
    const rendered = JSON.parse(tool.result.content[0].text);
    const compact = { ...result, records: result.records.map(({ id, scope, ...record }) => record) };
    assert.ok(canonicalJson(rendered) === canonicalJson(result) || canonicalJson(rendered) === canonicalJson(compact));
    return { tool_call_id: tool.id, kind: 'broker-metadata-only', source_contract: CURRENT_SOURCE_CONTRACT,
      operation_ids: [...new Set(matched.map(item => item.requestId))],
      refs: uniqueRefs([...tool.refs, ...runtime.refs, ...matched.map(item => item.ref)]) };
  } catch { return null; }
}

function bodySpan(text, proof, defaultHashKey = 'bodySha256') {
  if (typeof text !== 'string' || !object(proof)) return null;
  const delivery = proof.delivery;
  let body = text;
  if (delivery) {
    if (!Number.isSafeInteger(delivery.start) || !Number.isSafeInteger(delivery.end) ||
        delivery.start < 0 || delivery.end < delivery.start || delivery.end > text.length) return null;
    const span = text.slice(delivery.start, delivery.end);
    try {
      if (delivery.encoding === 'raw') body = span;
      else if (delivery.encoding === 'json') body = JSON.parse('"' + span + '"');
      else if (delivery.encoding === 'xml') body = span.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
      else return null;
    } catch { return null; }
  }
  return hash(body) === proof[defaultHashKey] && Buffer.byteLength(body) === proof.bytes ? body : null;
}

function preparedResourceBodies(tool, preparations, sourceViews) {
  const relativeToRecord = Object.hasOwn(tool.args ?? {}, 'from');
  const reference = relativeToRecord ? tool.args.from : tool.args?.path;
  if (tool.name !== 'read' || !/^sr:[SR][A-Za-z0-9_-]{22}$/u.test(reference ?? '') || !tool.turn_id) return [];
  const text = textContent(tool.result.content), matches = [];
  if (typeof text !== 'string' || tool.result.structuredContent !== undefined && tool.result.structuredContent !== text) return [];
  try {
    for (const preparation of preparations.filter(item => item.status === 'pass' && ['skill_prepare', 'notion_use'].includes(item.name) &&
      item.turn_id === tool.turn_id && Number.isSafeInteger(item.end_sequence) && item.end_sequence < tool.sequence)) {
      const verified = sourceViews.verifyPreparationEvidence(textContent(preparation.result?.content), preparation.result?.details?.contextBrokerPreparation, preparation.id);
      for (const { model, receipt, mapping } of verified.records) {
        if (mapping.state !== 'source' || !model.directory) continue;
        const binding = receipt.binding, owner = binding.record.id;
        assert.ok(typeof owner === 'string' && owner); assert.match(binding.scope, /^[a-f0-9]{64}$/u);
        assert.match(binding.snapshot_id, /^s_[a-f0-9]{64}$/u); assert.match(binding.version_id, /^[a-f0-9]{64}$/u);
        assert.equal(receipt.contentIdentity, JSON.stringify([binding.scope, owner]));
        const paths = new Set(), tokens = new Set();
        for (const [index, file] of receipt.directory.files.entries()) {
          const projected = model.directory.files[index];
          if (sourceViews.contract === CURRENT_SOURCE_CONTRACT) {
            const fixed = sourceViews.parseReference(file.ref);
            assert.equal(fixed.selector, owner); assert.equal(fixed.path, file.path); assert.equal(fixed.snapshot, binding.snapshot_id);
          } else {
            const fixed = new URL(file.ref);
            assert.equal(fixed.protocol, 'skill:'); assert.equal(decodeURIComponent(fixed.hostname), owner);
            assert.equal(fixed.pathname.slice(1).split('/').map(decodeURIComponent).join('/'), file.path);
            assert.deepEqual(fixed.searchParams.getAll('snapshot'), [binding.snapshot_id]);
            assert.ok(!fixed.username && !fixed.password && !fixed.port && !fixed.hash);
          }
          assert.match(file.sha256, /^[a-f0-9]{64}$/u); assert.ok(finite(file.bytes));
          assert.ok(!paths.has(file.path) && !tokens.has(projected.ref)); paths.add(file.path); tokens.add(projected.ref);
          const addressed = relativeToRecord ? model.ref === reference && file.path === tool.args.path : projected.ref === reference;
          if (addressed) matches.push({ path: file.path, sha256: file.sha256, bytes: file.bytes,
            source_binding: { owner, scope: binding.scope, snapshot_id: binding.snapshot_id, version_id: binding.version_id },
            refs: preparation.refs, preparation_tool_call_id: preparation.id });
        }
      }
    }
    const identities = new Set(matches.map(({ refs, preparation_tool_call_id, ...identity }) => canonicalJson(identity)));
    if (identities.size !== 1) return [];
    const selected = matches[0], body = bodySpan(text, selected, 'sha256');
    return body === null ? [] : [{ ...selected, body, owner: selected.source_binding.owner, kind: 'broker-prepared-resource-read',
      refs: uniqueRefs(matches.flatMap(item => item.refs)) }];
  } catch { return []; } // Unverified, ambiguous or cross-turn short refs stay opaque.
}

export function preparedSourceMatchKind(binding, material, sdk, bytes) {
  if (!['owner', 'scope', 'snapshot_id', 'version_id'].every(key => sdk[key] === binding[key]) ||
      sdk.path !== material.path || sdk.sha256 !== material.actual_sha256 || sdk.bytes !== bytes) return null;
  const versions = material.version ? [material.identity.bound_versions?.[material.version]] : Object.values(material.identity.bound_versions ?? {});
  if (binding.owner === material.identity.bound_owner && versions.length === 1 &&
      versions[0]?.snapshot_id === binding.snapshot_id && versions[0]?.version_id === binding.version_id) return 'exact';
  const selected = material.source_selection;
  if (selected) {
    try {
      const snapshots = Object.values(retainedSelectionSnapshots(selected));
      const matches = binding.owner === material.identity.bound_owner && selected.owner === binding.owner && selected.scope === binding.scope &&
        selected.version_id === binding.version_id && snapshots.includes(selected.snapshot_id) && snapshots.includes(binding.snapshot_id) &&
        canonicalJson(selected.record) === canonicalJson(sdk.record) && canonicalJson(selected.file_binding) === canonicalJson(sdk.file_binding) &&
        selected.path === material.path && selected.sha256 === material.actual_sha256 && selected.bytes === bytes &&
        (!material.version || material.version === selected.material_version);
      return matches ? 'retained-record-selection-v1' : null;
    } catch { return null; }
  }
  return null;
}
export function preparedSourceMatches(binding, material, sdk, bytes) {
  return preparedSourceMatchKind(binding, material, sdk, bytes) !== null;
}

/** Complete delivered bytes backed by product receipts; declarations without bytes are excluded. */
export function deliveredSourceBodies(tool, preparations = [], sourceViews = retainedSourceViews) {
  if (!sourceViews) return [];
  if (tool.status !== 'pass' || !object(tool.result)) return [];
  const text = textContent(tool.result.content), details = tool.result.details ?? {}, output = [];
  const main = details.contextBrokerRead;
  if (tool.name === 'read' && main?.toolCallId === tool.id && [2, 3].includes(main.version)) {
    const body = bodySpan(text, main);
    if (body !== null && (!main.rendered || main.rendered.sha256 === hash(text) && main.rendered.bytes === Buffer.byteLength(text)))
      output.push({ path: 'SKILL.md', body, owner: main.binding?.record?.id ?? null, kind: 'broker-main-read' });
  }
  const resource = details.contextBrokerResource;
  if (tool.name === 'read' && resource?.toolCallId === tool.id && resource.version === 2) {
    if (Array.isArray(resource.files) && resource.projection?.rendered?.sha256 === hash(text ?? '') &&
        resource.projection.rendered.bytes === Buffer.byteLength(text ?? '')) {
      for (const item of resource.files) if (item.delivered_complete_text === true && item.state === 'source') {
        const body = bodySpan(text, item, 'sha256');
        if (body !== null) output.push({ path: item.path, body, owner: resource.selection?.owner ?? null, kind: 'broker-resource-batch' });
      }
    } else if (resource.delivered_complete_text === true && resource.loaded === false) {
      const body = bodySpan(text, resource, 'sha256');
      if (body !== null) output.push({ path: resource.path, body, owner: resource.id ?? null, kind: 'broker-resource-read' });
    }
  }
  const preparation = details.contextBrokerPreparation;
  if (['skill_prepare', 'notion_use'].includes(tool.name) && preparation?.toolCallId === tool.id && [1, 2].includes(preparation.version)) {
    try {
      const prepared = sourceViews.verifyPreparationEvidence(text, preparation, tool.id);
      for (const record of prepared.records.filter(record => record.mapping.state === 'source')) {
        const item = record.receipt, body = bodySpan(text, item);
        if (body !== null) output.push({ path: item.binding.record.entrypoint, body, owner: item.binding.record.id, kind: 'broker-prepared-main' });
      }
    } catch { /* An unverified projection does not prove source consumption. */ }
  }
  if (!main && !resource) output.push(...preparedResourceBodies(tool, preparations, sourceViews));
  return output;
}

export async function collectEpisode({ raw, binding, protocol, slot, condition, model, outputDirectory, environmentRoot, reanalysisOf = null }) {
  assert.ok(isAbsolute(environmentRoot) && isAbsolute(outputDirectory) && isAbsolute(raw.root));
  const owned = await realpath(environmentRoot), runRoot = await realpath(raw.root), workspace = join(runRoot, 'workspace');
  if (!inside(owned, resolve(outputDirectory)) && inside(resolve(environmentRoot), resolve(outputDirectory)))
    outputDirectory = resolve(owned, relative(resolve(environmentRoot), resolve(outputDirectory)));
  assert.ok(inside(owned, runRoot) && inside(owned, resolve(outputDirectory)) && !inside(workspace, resolve(outputDirectory)), 'Collector outputs must stay outside the subject workspace');
  assert.equal(protocol.protocol_sha256, fingerprint({ ...protocol, protocol_sha256: null }), 'Frozen protocol changed');
  assert.equal(slot.case_id, binding.id); assert.equal(slot.condition_id, condition.id); assert.equal(condition.model_id, model.id);
  const caseInfo = protocol.corpus.cases.find(item => item.id === slot.case_id);
  assert.ok(caseInfo && condition.case_ids.includes(slot.case_id), 'Case is not in the frozen condition');
  assert.equal(binding.protocol_case?.contract_sha256 ?? caseInfo.contract_sha256, caseInfo.contract_sha256);
  const registeredModel = protocol.models.find(item => item.id === model.id);
  assert.ok(registeredModel && canonicalJson(registeredModel.adapter) === canonicalJson(model.adapter), 'Adapter differs from frozen model');
  await mkdir(outputDirectory, { recursive: true });
  outputDirectory = await realpath(outputDirectory);
  assert.ok(inside(owned, outputDirectory) && !inside(workspace, outputDirectory), 'Collector output resolves outside its owned namespace');
  const artifacts = [], registry = new Map(), fileByPath = new Map(), fileBytes = new Map(), observations = [], problems = [];
  async function addFile(id, path, expected = null, kind = 'json') {
    const actual = await realpath(path); assert.ok(inside(owned, actual), 'Evidence file escapes the owned environment');
    const stat = await lstat(actual); assert.ok(stat.isFile(), 'Evidence must be an ordinary file');
    const bytes = await readFile(actual), sha256 = hash(bytes);
    if (expected) assert.equal(sha256, expected, 'Evidence bytes changed: ' + id);
    if (fileByPath.has(actual)) return fileByPath.get(actual);
    assert.ok(!registry.has(id), 'Duplicate evidence ID');
    const artifact = { id, path: actual, sha256, bytes: bytes.length, kind };
    artifacts.push(artifact); registry.set(id, artifact); fileByPath.set(actual, artifact); fileBytes.set(id, bytes); return artifact;
  }
  const ref = (artifact, pointer = '') => ({ artifact_id: artifact.id, sha256: artifact.sha256, pointer });
  async function save(id, name, value) {
    const path = join(outputDirectory, name); await writeOnce(path, canonicalJson(value) + '\n');
    return addFile(id, path);
  }
  const sourceFiles = await loadedImplementation, implementationFiles = [];
  for (const [index, source] of sourceFiles.entries()) {
    assert.equal(hash(await readFile(source.path)), source.sha256, 'Loaded analysis implementation changed');
    const saved = join(outputDirectory, 'implementation', source.sha256);
    await writeOnce(saved, source.bytes);
    const artifact = await addFile('collection-implementation-' + index, saved, source.sha256, 'implementation');
    implementationFiles.push({ path: source.relative_path, sha256: source.sha256, bytes: source.bytes.length, artifact_id: artifact.id });
  }
  const implementation = { schema_version: 1, scope: 'collector local static import closure', files: implementationFiles };
  implementation.sha256 = fingerprint(implementation);
  const collectorSourceSha256 = implementationFiles.find(file => file.path === 'benchmark/collect.mjs').sha256;
  const runArtifact = await addFile('collection-run', join(runRoot, 'run.json'));
  const sharedArtifact = await addFile('collection-launcher-result', join(runRoot, 'result.json'));
  const run = JSON.parse(fileBytes.get(runArtifact.id)), shared = JSON.parse(fileBytes.get(sharedArtifact.id));
  assert.equal(run.run_id, raw.run_id ?? run.run_id); assert.equal(shared.run_id, run.run_id);
  if (raw.shared) assert.equal(canonicalJson(raw.shared), canonicalJson(shared), 'Caller launcher result differs from retained receipt');
  const protocolArtifact = await save('collection-protocol', 'protocol.json', protocol);
  const oracleBytes = await readFile(binding.oracle_path);
  assert.equal(hash(oracleBytes), binding.oracle_sha256, 'Private oracle bytes changed');
  const oracle = JSON.parse(oracleBytes);
  assert.equal(fingerprint(oracle), caseInfo.contract_sha256, 'Oracle does not match the frozen business contract');
  // Oracle contents and its private file are deliberately absent from the distributable artifact registry.
  const oracleIdentity = { sha256: hash(oracleBytes), contract_sha256: fingerprint(oracle), grading_entry: 'corpus/gradeEpisode/v1' };
  let episode = null, resultArtifact = null, events = [], eventArtifact = null;
  if (raw.episode) {
    resultArtifact = await addFile('collection-runtime-result', raw.result_path ?? join(runRoot, 'benchmark/runtime/episode-result.json'));
    episode = JSON.parse(fileBytes.get(resultArtifact.id));
    assert.equal(canonicalJson(raw.episode), canonicalJson(episode), 'Caller runtime result differs from retained receipt');
    assert.equal(episode.correlation?.run_id, run.run_id); assert.equal(episode.correlation?.episode_id, run.run_id);
    assert.equal(episode.correlation?.candidate_id, condition.id); assert.equal(episode.correlation?.task_id, binding.id);
    await verifyArtifactFiles(episode.artifacts, { root: owned });
    for (const artifact of episode.artifacts) await addFile(artifact.id, artifact.path, artifact.sha256, artifact.kind);
    eventArtifact = registry.get('events'); assert.ok(eventArtifact, 'Runtime event artifact is required');
    const eventText = fileBytes.get(eventArtifact.id).toString('utf8'); assert.ok(eventText.endsWith('\n'), 'Runtime event stream is truncated');
    events = eventText.trimEnd().split('\n').map((line, index) => { const row = JSON.parse(line); assert.equal(row.sequence ?? row.seq, index + 1); if (row.seq !== undefined && row.sequence !== undefined) assert.equal(row.seq, row.sequence); return row; });
  } else problems.push('missing_terminal_runtime_receipt');
  function resolveRef(input) {
    const cleaned = cleanRef(input); if (!cleaned) return null;
    const artifact = registry.get(cleaned.artifact_id);
    assert.ok(artifact && artifact.sha256 === cleaned.sha256, 'Runtime source ref does not match its raw artifact');
    if (cleaned.line !== undefined) {
      const lines = fileBytes.get(artifact.id).toString('utf8').trimEnd().split('\n');
      assert.ok(cleaned.line >= 1 && cleaned.line <= lines.length);
      return { value: JSON.parse(lines[cleaned.line - 1]), ref: cleaned };
    }
    return { value: jsonPointer(JSON.parse(fileBytes.get(artifact.id)), cleaned.pointer), ref: cleaned };
  }

  const turnControl = await readTurnControlEvidence({ raw, binding, environmentRoot: owned, runRoot, runId: run.run_id,
    episode, eventArtifact, eventBytes: eventArtifact ? fileBytes.get(eventArtifact.id) : null, knownArtifacts: artifacts });
  try {
    for (const { artifact } of turnControl.sources)
      await addFile(artifact.id, artifact.path, artifact.sha256, artifact.kind);
  } catch (error) {
    turnControl.summary.status = 'unavailable'; turnControl.summary.verified_completed = false;
    turnControl.summary.reason = error.message; turnControl.summary.refs = [];
    turnControl.checkpoints = []; turnControl.control = null;
    turnControl.problems.push('turn_control_artifact_changed');
  }
  problems.push(...turnControl.problems);

  const sourceArtifact = registry.get('notion-source'), sdkArtifact = registry.get('notion-sdk');
  const notionRequired = (protocol.environments ?? []).some(env => env.id === condition.environment_id &&
    (env.pi?.sources ?? []).some(source => source.kind === 'notion')) ||
    Boolean(binding.materialization_proof && run.pi_launch?.mode === 'broker');
  const sourceContract = episode?.notion?.source_contract ?? binding.source_contract ?? RETAINED_SOURCE_CONTRACT;
  const currentSource = sourceContract === CURRENT_SOURCE_CONTRACT;
  const collectorVersion = currentSource ? CURRENT_COLLECTOR_VERSION : COLLECTOR_VERSION;
  let sourceViews = currentSource ? null : retainedSourceViews;
  const notion = { status: 'unavailable', source_contract: sourceContract,
    operations: [], source_bodies: [], owned_http: { status: 'unknown', value: null },
    coverage: episode?.notion?.coverage ?? null, descendant_transport: 'unobserved',
    scope: 'Owned SDK and directly observed bundled CLI only; SDK reads do not prove delivery to the agent.',
    errors: [], refs: [] };
  if (currentSource) {
    try {
      assert.ok(!binding.materialization_proof || binding.source_contract === CURRENT_SOURCE_CONTRACT, 'Current runtime requires refreshed current material');
      const candidateArtifact = registry.get('candidate-observed'); assert.ok(candidateArtifact, 'Current source provenance needs the actual captured candidate');
      sourceViews = await loadCurrentSourceViews({ runRoot, buildRoot: run.build_root, candidate: JSON.parse(fileBytes.get(candidateArtifact.id)) });
      for (const [index, file] of sourceViews.artifacts.entries()) {
        const artifact = await addFile('collection-current-source-' + index, file.path, file.sha256, 'implementation');
        notion.refs.push(ref(artifact));
      }
      notion.producer = sourceViews.producer;
    } catch (error) {
      sourceViews = null; notion.errors.push(error.message); problems.push('current_source_contract_unverified');
    }
  } else assert.equal(sourceContract, RETAINED_SOURCE_CONTRACT, 'Unknown source evidence contract');
  const sdkBodyRows = [], sdkDirectories = [];
  if (episode?.notion) {
    try {
      assert.ok(sourceArtifact && sdkArtifact, 'Notion ledgers are required');
      const source = parseSourceObservation(fileBytes.get(sourceArtifact.id).toString('utf8'));
      assert.ok(source.complete, 'Notion source hash chain or lifecycle is incomplete: ' + source.errors.join(', '));
      const sdkText = fileBytes.get(sdkArtifact.id).toString('utf8');
      assert.ok(sdkText.endsWith('\n'), 'Notion SDK ledger is truncated');
      const sdk = sdkText.trimEnd().split('\n').map(JSON.parse);
      assert.equal(sdk[0]?.phase, 'sdk-observer-start'); assert.equal(sdk.at(-1)?.phase, 'sdk-observer-end');
      assert.equal(sdk.at(-1)?.pending, 0); assert.ok(!sdk.some(row => row.phase === 'sdk-observer-error'));
      const starts = sdk.filter(row => row.phase === 'sdk-start'), ends = sdk.filter(row => row.phase === 'sdk-end');
      const operations = episode.notion.operations ?? [];
      assert.equal(new Set(starts.map(row => row.requestId)).size, starts.length);
      assert.equal(starts.length, ends.length); assert.equal(starts.length, operations.length);
      const receipts = [], receiptRefs = new Map();
      for (const operation of operations) {
        const captured = resolveRef(operation.receipt_ref);
        const receipt = captured?.value;
        assert.ok(receipt && receipt.version === 2 && receipt.transport === 'sdk');
        assert.equal(receipt.requestId, operation.operation_id); assert.equal(receipt.operation, operation.operation);
        assert.equal(receipt.status, operation.status);
        assert.equal(starts.filter(row => row.requestId === receipt.requestId && row.operation === receipt.operation).length, 1);
        assert.equal(ends.filter(row => row.requestId === receipt.requestId && row.operation === receipt.operation && row.status === receipt.status).length, 1);
        for (const [key, eventKind] of [['start_ref', 'start'], ['end_ref', 'end']]) {
          const event = resolveRef(operation[key])?.value;
          assert.ok(event?.type === 'notion_sdk_event' && event.data?.event?.id === receipt.requestId &&
            event.data.event.event === eventKind && event.data.event.operation === receipt.operation);
        }
        if (receipt.status === 'completed') {
          const result = resolveRef(operation.result_ref)?.value;
          assert.equal(receipt.resultObserved, true);
          assert.ok(result?.type === 'notion_sdk_result' && result.data?.event?.id === receipt.requestId);
          assert.equal(canonicalJson(result.data.event.value), canonicalJson(receipt.value), 'SDK receipt differs from the actual result event');
        }
        const metrics = source.events.filter(row => row.phase === 'metrics' && row.requestId === operation.source_request_id);
        const attempts = source.events.filter(row => row.phase === 'attempt' && row.kind === 'http' && row.requestId === operation.source_request_id);
        assert.equal(metrics.length, 1); assert.equal(metrics[0].observed, true); assert.equal(metrics[0].complete, true);
        assert.equal(receipt.metrics?.complete, true); assert.equal(receipt.metrics.total_requests, attempts.length);
        assert.equal(operation.http_attempts, attempts.length);
        receipts.push(receipt); receiptRefs.set(receipt.requestId, captured.ref);
        const refs = uniqueRefs([cleanRef(operation.start_ref), cleanRef(operation.end_ref), cleanRef(operation.result_ref), captured.ref,
          ...source.events.filter(row => row.requestId === operation.source_request_id).map(row => ({ artifact_id: sourceArtifact.id, sha256: sourceArtifact.sha256, line: row.sequence }))]);
        notion.operations.push({ operation_id: receipt.requestId, source_request_id: operation.source_request_id,
          operation: receipt.operation, stage: operation.stage, status: receipt.status,
          turn_id: operation.turn_id ?? null, model_request_id: operation.model_request_id ?? null,
          tool_call_id: null, tool_association: 'unproven; matching source bytes establish material identity, not causal attribution',
          http_attempts: attempts.length, result_observed: receipt.resultObserved, refs });
      }
      assert.ok(sourceViews, 'Current source interpreter provenance is unavailable');
      const views = sourceViews.graphSourceViews(receipts);
      for (const entry of views.directories) {
        const operation = operations.find(item => item.operation_id === entry.requestId);
        sdkDirectories.push({ ...entry, end_sequence: operation.end_ref.line, ref: receiptRefs.get(entry.requestId) });
      }
      for (const entry of views.entries) {
        const value = entry.value, output = entry.outputEvidence;
        const body = typeof value.content === 'string' ? value.content : typeof output?.content === 'string' ? output.content : null;
        if (body === null) continue;
        assert.equal(hash(body), value.sha256); assert.equal(Buffer.byteLength(body), value.bytes);
        if (output) { assert.equal(output.sha256, value.sha256); assert.equal(output.bytes, value.bytes); }
        sdkBodyRows.push({ operation_id: entry.requestId, path: value.path ?? 'SKILL.md', owner: value.record?.id ?? null,
          scope: value.scope, snapshot_id: value.snapshot_id, version_id: value.version_id,
          record: value.record, file_binding: value.file_bindings?.find(file => file.path === (value.path ?? 'SKILL.md')),
          sha256: hash(body), bytes: Buffer.byteLength(body), ref: receiptRefs.get(entry.requestId) });
      }
      for (const entry of views.resources) for (const file of entry.value.files) {
        const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
        sdkBodyRows.push({ operation_id: entry.requestId, path: file.path, owner: entry.value.selection.owner,
          scope: entry.value.selection.scope, snapshot_id: entry.value.selection.snapshot_id, version_id: entry.value.selection.version_id,
          record: entry.value.manifest.record, file_binding: entry.value.manifest.file_bindings?.find(binding => binding.path === file.path),
          sha256: hash(bytes), bytes: bytes.length, ref: receiptRefs.get(entry.requestId) });
      }
      assert.equal(episode.notion.coverage?.sdk, 'complete'); assert.equal(episode.notion.coverage?.owned_http, 'complete');
      assert.equal(episode.notion.coverage?.child_lifecycle, 'complete');
      assert.equal(source.unmatchedChildLifecycle?.complete, true);
      const attempts = source.events.filter(row => row.phase === 'attempt' && row.kind === 'http');
      const kinds = {};
      for (const attempt of attempts) kinds[attempt.request_kind ?? 'unknown'] = (kinds[attempt.request_kind ?? 'unknown'] ?? 0) + 1;
      notion.status = 'observed'; notion.source_bodies = sdkBodyRows;
      notion.owned_http = { status: 'known', value: attempts.length, by_request_kind: kinds,
        refs: attempts.map(row => ({ artifact_id: sourceArtifact.id, sha256: sourceArtifact.sha256, line: row.sequence })) };
      const runtimeRefs = uniqueRefs(Object.values(episode.notion.refs ?? {}).map(cleanRef));
      for (const item of runtimeRefs) resolveRef(item);
      notion.refs = uniqueRefs([...notion.refs, ...runtimeRefs]);
    } catch (error) {
      notion.errors.push(error.message); notion.status = 'partial'; problems.push('core_notion_evidence_incomplete');
    }
  } else if (notionRequired) problems.push('core_notion_evidence_missing');

  const materialRows = [], identityMap = binding.identity_map ?? {};
  if (binding.materialization_proof) {
    const descriptor = binding.materialization_proof;
    const artifact = await addFile('collection-material-parity', descriptor.path, descriptor.sha256);
    const proof = JSON.parse(fileBytes.get(artifact.id));
    assert.equal(proof.status, 'passed'); assert.equal(proof.parity?.status, 'valid');
    if (currentSource) {
      assert.equal(proof.source_contract, CURRENT_SOURCE_CONTRACT, 'Current collection cannot reuse a historical material proof');
      if (sourceViews) assert.equal(proof.source_sdk.sha256, sourceViews.producer.public_sdk_sha256, 'Material and runtime must use the same paired SDK');
      await addFile('collection-current-material-sdk', proof.source_sdk.path, proof.source_sdk.sha256, 'implementation');
    }
    for (const [index, item] of (proof.canonical_to_actual ?? []).entries()) {
      const references = [ref(artifact, '/canonical_to_actual/' + index)];
      const files = {};
      for (const key of ['canonical_source', 'prepared_source', 'actual_source', 'receipt', 'raw_receipt']) {
        assert.ok(item[key]?.path && item[key].sha256, 'Parity needs retained ' + key);
        const file = await addFile('collection-material-' + index + '-' + key, item[key].path, item[key].sha256, key.includes('source') ? 'source-bytes' : 'json');
        files[key] = file; references.push(key.includes('source') ? null : ref(file));
      }
      assert.equal(files.canonical_source.sha256, item.canonical_sha256);
      assert.equal(files.prepared_source.sha256, item.prepared_sha256);
      assert.equal(files.actual_source.sha256, item.actual_sha256);
      assert.equal(item.matched, true); assert.equal(item.comparison?.matched, true);
      if (item.method === 'exact-bytes') assert.equal(item.actual_sha256, item.canonical_sha256);
      else {
        assert.equal(item.method, 'public-sdk-native-structural-equivalence');
        assert.equal(item.frontmatter_matches_prepared, true);
        assert.equal(item.actual_header_sha256, item.prepared_header_sha256);
        assert.ok(['exact', 'normalized'].includes(item.canonical_body_comparison));
        assert.ok(['exact', 'normalized'].includes(item.prepared_body_comparison));
        assert.ok(item.public_sdk_path && item.public_sdk_sha256);
        await addFile('collection-material-sdk-' + index, item.public_sdk_path, item.public_sdk_sha256, 'implementation');
      }
      const native = (proof.files ?? []).find(file => file.skill_id === item.skill_id && file.resource_path === item.path);
      if (native) await addFile('collection-native-material-' + index, native.path, native.sha256, 'source-bytes');
      const selection = currentSource ? null : retainedMaterialSelection({ receiptBytes: fileBytes.get(files.receipt.id), rawBytes: fileBytes.get(files.raw_receipt.id),
        material: { path: item.path, sha256: item.actual_sha256, bytes: files.actual_source.bytes },
        boundIdentity: identityMap[item.skill_id], proofIdentity: proof.identity_map?.[item.skill_id] });
      if (selection) selection.refs = [ref(artifact, '/identity_map/' + item.skill_id.replaceAll('~', '~0').replaceAll('/', '~1')),
        ref(files.receipt, '/object'), ref(files.raw_receipt, '/main'), ref(files.raw_receipt, '/directory')];
      materialRows.push({ skill_id: item.skill_id, path: item.path, actual_sha256: item.actual_sha256,
        canonical_sha256: item.canonical_sha256, native_path: native?.path ?? null,
        actual_source: files.actual_source.path, refs: references.filter(Boolean),
        ...(selection ? { source_selection: selection } : {}),
        identity: identityMap[item.skill_id] ?? proof.identity_map?.[item.skill_id] ?? {} });
    }
  } else {
    for (const [index, item] of (binding.skill_inventory ?? []).entries()) {
      const file = await addFile('collection-canonical-material-' + index, item.path, item.sha256, 'source-bytes');
      materialRows.push({ skill_id: item.skill_id, path: item.resource_path, actual_sha256: file.sha256,
        canonical_sha256: file.sha256, native_path: item.path, actual_source: file.path, refs: [ref(protocolArtifact, '/corpus/content_sha256')],
        identity: identityMap[item.skill_id] ?? {} });
    }
  }

  const turnFacts = await collectTurnFacts({ turnControl, binding, run, episode, initialMaterials: materialRows,
    resolveRef, eventArtifact });
  try {
    for (const { artifact } of turnControl.sources)
      await addFile(artifact.id, artifact.path, artifact.sha256, artifact.kind);
  } catch (error) {
    turnFacts.problems.push('turn_effect_artifact_changed');
    turnFacts.clarifications = []; turnFacts.state_events = []; turnFacts.material_rows = [];
    turnFacts.evidence_refs.clear(); turnFacts.coverage = { clarifications: 'unavailable', state_events: 'unavailable' };
    turnFacts.limitations.push(error.message);
  }
  problems.push(...turnFacts.problems);
  materialRows.push(...turnFacts.material_rows);

  let adapterVerified = registeredModel.adapter.verification === 'verified';
  if (adapterVerified) {
    if (!model.adapter_evidence_path) { adapterVerified = false; problems.push('adapter_verification_artifact_unavailable'); }
    else await addFile('collection-adapter-proof', model.adapter_evidence_path, registeredModel.adapter.evidence_sha256);
  }
  const sessionArtifact = registry.get('session-entries');
  const sessionEntries = sessionArtifact ? JSON.parse(fileBytes.get(sessionArtifact.id)) : null;
  const toolResult = eventArtifact ? collectRuntimeTools(events, eventArtifact, sessionEntries, sessionArtifact) : { tools: [], complete: false, errors: ['Missing SDK event evidence'] };
  const tools = toolResult.tools;
  if (!toolResult.complete) problems.push('tool_lineage_incomplete');
  const codeModeRuntime = { status: 'unverified', refs: [], scope: 'reviewed builtin wrapper modules; not the entire Pi installation' };
  if (tools.some(tool => tool.container)) try {
    assert.equal(episode.admission.status, 'accepted_before_task');
    const candidate = registry.get('candidate-observed'), admission = registry.get('admission-comparison');
    for (const artifact of [candidate, admission]) assert.ok(artifact && episode.admission.refs.some(item => item.artifact_id === artifact.id && item.sha256 === artifact.sha256));
    const comparison = JSON.parse(fileBytes.get(admission.id));
    const expected = await addFile('collection-provider-binding-expectation', comparison.expected_file.path, comparison.expected_file.sha256);
    const after = events.map((row, index) => ({ row, index })).filter(item => item.row.type === 'sdk_runtime_after');
    assert.equal(after.length, 1); assert.ok(tools.every(tool => tool.execution === 'rejected_before_execution' ||
      Number.isSafeInteger(tool.end_sequence) && tool.end_sequence < after[0].index + 1));
    assert.ok(verifiedCodeModeRuntime({ candidate: JSON.parse(fileBytes.get(candidate.id)), expected: JSON.parse(fileBytes.get(expected.id)),
      admission: comparison, after: after[0].row.data }));
    codeModeRuntime.status = 'verified'; codeModeRuntime.refs = [ref(candidate), ref(admission), ref(expected),
      { artifact_id: eventArtifact.id, sha256: eventArtifact.sha256, line: after[0].index + 1 }];
  } catch (error) { codeModeRuntime.reason = error.message; }
  const metadataRuntime = { status: 'unverified', refs: [], scope: 'reviewed current Broker metadata-only list branch' };
  let metadataSources = [];
  if (currentSource && notion.status === 'observed' && tools.some(tool => tool.name === 'notion_list')) try {
    assert.equal(episode.admission.status, 'accepted_before_task');
    const candidate = registry.get('candidate-observed'), admission = registry.get('admission-comparison');
    for (const artifact of [candidate, admission]) assert.ok(artifact && episode.admission.refs.some(item => item.artifact_id === artifact.id && item.sha256 === artifact.sha256));
    const captured = JSON.parse(fileBytes.get(candidate.id)), comparison = JSON.parse(fileBytes.get(admission.id));
    const expected = await addFile('collection-provider-binding-expectation', comparison.expected_file.path, comparison.expected_file.sha256);
    const buildArtifact = await addFile('collection-metadata-build', captured.snapshot.build.path, captured.snapshot.build.sha256);
    const build = JSON.parse(fileBytes.get(buildArtifact.id)), files = [];
    for (const name of ['src/index.ts', 'src/host-skills.ts']) {
      const declarations = build.packages.broker.files.filter(file => file.path === name); assert.equal(declarations.length, 1);
      const artifact = await addFile('collection-metadata-producer-' + files.length, join(run.build_root, 'broker', name), declarations[0].sha256, 'implementation');
      files.push({ name, ...artifact });
    }
    assert.ok(verifiedNotionListRuntime({ candidate: captured, expected: JSON.parse(fileBytes.get(expected.id)), admission: comparison, files, build }));
    assert.equal(shared.runtime_check.status, 'unchanged'); assert.equal(shared.frozen_artifacts, 'passed');
    metadataSources = captured.snapshot.broker_config?.sources ?? [];
    const sourceRef = artifact => ({ artifact_id: artifact.id, sha256: artifact.sha256, line: 1 });
    metadataRuntime.status = 'verified'; metadataRuntime.refs = uniqueRefs([ref(candidate), ref(admission), ref(expected), ref(buildArtifact),
      ...files.map(sourceRef), ...notion.refs.map(item => registry.get(item.artifact_id)?.kind === 'implementation'
        ? sourceRef(registry.get(item.artifact_id)) : item)]);
  } catch (error) { metadataRuntime.reason = error.message; }
  const evidence = { artifacts: [], selections: [], resource_reads: [], clarifications: turnFacts.clarifications,
    state_events: turnFacts.state_events,
    coverage: { artifacts: 'partial', selections: 'partial', resource_reads: 'partial', ...turnFacts.coverage } };
  const evidenceRefs = new Map(turnFacts.evidence_refs), unmatchedReads = [], opaqueTools = [], metadataOnlyTools = [];
  const copiedRoot = run.pi_launch?.native_corpus?.root;
  const sourceRoot = binding.skills_root ?? binding.native_skill_root;
  function matchMaterial(bytes, resourcePath = null, owner = null, actualPath = null, turnId = null) {
    const sha256 = hash(bytes);
    const turnPosition = (episode?.turns ?? []).findIndex(turn => turn.id === turnId);
    let candidates = materialRows.filter(row => row.actual_sha256 === sha256 && (resourcePath === null || row.path === resourcePath) &&
      (!row.available_from_turn_id || turnPosition >= 0 && turnPosition >= episode.turns.findIndex(turn => turn.id === row.available_from_turn_id)));
    if (actualPath) {
      const exact = candidates.filter(row => {
        if (row.native_path === actualPath || row.actual_source === actualPath) return true;
        if (!copiedRoot || !sourceRoot || !row.native_path || !inside(sourceRoot, row.native_path)) return false;
        return resolve(copiedRoot, relative(sourceRoot, row.native_path)) === actualPath;
      });
      if (exact.length) candidates = exact;
      else return null;
    }
    if (owner) {
      const exact = candidates.filter(row => [row.skill_id, row.identity.bound_owner, row.identity.bound_skill_id, row.identity.bound_page_id].includes(owner));
      if (exact.length) candidates = exact;
      else return null;
    }
    const identities = new Set(candidates.map(row => canonicalJson([row.skill_id, row.path, row.canonical_sha256])));
    if (identities.size !== 1) return null;
    return candidates.sort((a, b) => (b.available_from_turn_id ? episode.turns.findIndex(turn => turn.id === b.available_from_turn_id) : -1) -
      (a.available_from_turn_id ? episode.turns.findIndex(turn => turn.id === a.available_from_turn_id) : -1))[0] ?? null;
  }
  function observeSource(tool, body, resourcePath, owner, actualPath, kind, sourceBinding = null) {
    const material = matchMaterial(Buffer.isBuffer(body) ? body : Buffer.from(body), resourcePath, owner, actualPath, tool.turn_id);
    if (!material) { unmatchedReads.push({ tool_call_id: tool.id, path: resourcePath, owner, actual_sha256: hash(body), reason: 'No unique independently verified material mapping' }); return false; }
    const evidence_id = 'source-' + evidence.resource_reads.length;
    const sdkMatches = sdkBodyRows.filter(row => row.sha256 === material.actual_sha256 && row.path === material.path &&
      (!row.owner || [material.skill_id, material.identity.bound_owner, material.identity.bound_skill_id].includes(row.owner)) &&
      (!sourceBinding || preparedSourceMatches(sourceBinding, material, row, Buffer.byteLength(body))));
    if (sourceBinding && sdkMatches.length === 0) {
      unmatchedReads.push({ tool_call_id: tool.id, path: resourcePath, owner, reason: 'Prepared reference has no independently observed source binding' }); return false;
    }
    const sourceMatchKind = sourceBinding ? preparedSourceMatchKind(sourceBinding, material, sdkMatches[0], Buffer.byteLength(body)) : null;
    const refs = uniqueRefs([...tool.refs, ...material.refs, ...sdkMatches.map(row => row.ref)]);
    evidence.resource_reads.push({ skill_id: material.skill_id, path: material.path, sha256: material.canonical_sha256,
      actual_sha256: material.actual_sha256, mapping: material.mapping ?? (material.actual_sha256 === material.canonical_sha256 ? 'exact-bytes' : 'verified-material-parity'),
      ...(material.version ? { version: material.version, state_event_id: material.event_id } : {}),
      turn_id: tool.turn_id, evidence_id, tool_call_id: tool.id, kind,
      ...(sourceBinding ? { source_binding: sourceBinding } : {}),
      ...(sourceMatchKind === 'retained-record-selection-v1' ? { selection_bridge: {
        kind: 'retained-record-selection-v1', material_snapshot_id: material.source_selection.snapshot_id,
        runtime_snapshot_id: sourceBinding.snapshot_id, version_id: material.source_selection.version_id,
        record_sha256: hash(canonicalJson(material.source_selection.record)), receipt_sha256: material.source_selection.receipt_sha256,
        raw_receipt_sha256: material.source_selection.raw_receipt_sha256, refs: material.source_selection.refs,
      } } : {}),
      sdk_operation_ids: sdkMatches.map(row => row.operation_id), sdk_association: 'matching bytes and identity; causal association unproven' });
    evidenceRefs.set(evidence_id, refs);
    if (material.path === 'SKILL.md') evidence.selections.push({ skill_id: material.skill_id, evidence_id, turn_id: tool.turn_id, tool_call_id: tool.id });
    return true;
  }
  for (const tool of tools) {
    if (tool.execution === 'rejected_before_execution') continue;
    if (tool.container?.complete && codeModeRuntime.status === 'verified') { tool.refs = uniqueRefs([...tool.refs, ...codeModeRuntime.refs, ...tool.container.refs]); continue; }
    if (tool.status !== 'pass') { if (!['read', 'write', 'edit'].includes(tool.name)) opaqueTools.push(tool.id); continue; }
    const delivered = deliveredSourceBodies(tool, tools, sourceViews);
    for (const item of delivered) observeSource({ ...tool, refs: uniqueRefs([...tool.refs, ...(item.refs ?? [])]) }, item.body, item.path, item.owner, null, item.kind, item.source_binding);
    if (delivered.length) continue;
    const metadata = notionMetadataEvidence(tool, { runtime: metadataRuntime, directories: sdkDirectories,
      sources: metadataSources });
    if (metadata) { metadataOnlyTools.push(metadata); tool.refs = uniqueRefs([...tool.refs, ...metadata.refs]); continue; }
    if (tool.name === 'read' && Object.hasOwn(tool.args ?? {}, 'from')) {
      unmatchedReads.push({ tool_call_id: tool.id, path: tool.args.path ?? null, from: tool.args.from ?? null,
        reason: 'Source-backed read has no verified preparation mapping' });
      continue;
    }
    if (tool.name === 'read' && typeof tool.args?.path === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(tool.args.path)) {
      const actualPath = isAbsolute(tool.args.path) ? resolve(tool.args.path) : resolve(workspace, tool.args.path);
      const nativeText = typeof tool.result?.structuredContent === 'string' ? tool.result.structuredContent : textContent(tool.result?.content);
      const isMaterial = materialRows.some(row => row.native_path === actualPath || row.actual_source === actualPath ||
        copiedRoot && sourceRoot && row.native_path && inside(sourceRoot, row.native_path) && resolve(copiedRoot, relative(sourceRoot, row.native_path)) === actualPath);
      if (isMaterial && nativeText !== null) observeSource(tool, nativeText, null, null, actualPath, 'native-read');
      else if (isMaterial || /(?:^|[\\/])SKILL\.md$/i.test(actualPath)) {
        unmatchedReads.push({ tool_call_id: tool.id, path: actualPath, reason: 'Complete source bytes were not observed' });
      }
    } else if (!['write', 'edit'].includes(tool.name) && tool.execution !== 'rejected_before_execution') opaqueTools.push(tool.id);
  }
  const toolsComplete = episode?.coverage?.tools === 'complete' && toolResult.complete;
  const sourceComplete = toolsComplete && unmatchedReads.length === 0 && opaqueTools.length === 0;
  evidence.coverage.selections = sourceComplete ? 'complete' : 'partial';
  evidence.coverage.resource_reads = sourceComplete ? 'complete' : 'partial';

  const outputChecks = [];
  const declaredOutputs = [...new Set(binding.public_case.completion?.paths ?? [])];
  const outputContracts = oracle.contracts.filter(item => item.kind === 'artifact-json');
  assert.ok(outputContracts.every(item => declaredOutputs.includes(item.path)), 'Private grader cannot request an undeclared subject file');
  const turns = episode?.turns ?? [];
  let allOutputsChecked = true, historicalOutputsComplete = true;
  for (const [index, name] of declaredOutputs.entries()) {
    const path = localPath(workspace, name);
    try {
      const actual = await realpath(path); assert.ok(inside(workspace, actual), 'Output link escapes workspace');
      const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink(), 'Deliverable must be an ordinary file');
      const bytes = await readFile(actual), sha256 = hash(bytes);
      const retained = join(outputDirectory, 'raw-outputs', sha256);
      await writeOnce(retained, bytes);
      const artifact = await addFile('collection-output-' + index, retained, sha256, 'subject-output');
      const check = { path: name, observed_path: path, status: 'observed', sha256, bytes: bytes.length, artifact_id: artifact.id };
      outputChecks.push(check);
      const matchingTurns = [];
      for (const turn of turns) if (turn.workspace_manifest_ref) {
        const observed = resolveRef(turn.workspace_manifest_ref);
        const file = observed?.value?.files?.find(item => item.path === name);
        if (file?.sha256 === sha256) matchingTurns.push({ turn, ref: observed.ref });
      }
      if (turns.length && !matchingTurns.length && episode.status === 'completed') {
        const finalManifest = resolveRef(turns.at(-1).workspace_manifest_ref);
        if (finalManifest?.value?.files) problems.push('output_changed_after_subject_boundary:' + name);
      }
      const records = matchingTurns.length ? matchingTurns : [{ turn: turns.at(-1) ?? null, ref: null }];
      for (const { turn, ref: snapshotRef } of records) {
        const evidence_id = 'artifact-' + evidence.artifacts.length;
        evidence.artifacts.push({ path: name, content: bytes.toString('utf8'), sha256, evidence_id, ...(turn?.id ? { turn_id: turn.id } : {}) });
        evidenceRefs.set(evidence_id, uniqueRefs([snapshotRef]));
      }
      for (const contract of outputContracts.filter(c => c.path === name && c.turn_id))
        if (!matchingTurns.some(item => item.turn.id === contract.turn_id)) historicalOutputsComplete = false;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        outputChecks.push({ path: name, observed_path: path, status: 'absent' });
        const final = turns.at(-1)?.workspace_manifest_ref ? resolveRef(turns.at(-1).workspace_manifest_ref) : null;
        if (final?.value?.files?.some(item => item.path === name)) problems.push('output_removed_after_subject_boundary:' + name);
      }
      else { allOutputsChecked = false; outputChecks.push({ path: name, status: 'unavailable', reason: error.message }); problems.push('output_readback_unavailable:' + name); }
    }
  }
  evidence.coverage.artifacts = allOutputsChecked && historicalOutputsComplete ? 'complete' : 'partial';
  const protocolCapabilities = protocol.corpus.capabilities ?? [];
  const capabilities = protocolCapabilities.map(item => ({ id: item.id, supported: item.environment_ids.includes(condition.environment_id) }));
  const grade = gradeEpisode({ oracle, evidence, capabilities });
  const readback = { schema_version: 1, kind: 'benchmark-independent-readback', collector_version: collectorVersion,
    runtime_result_sha256: resultArtifact?.sha256 ?? null, launcher_result_sha256: sharedArtifact.sha256,
    protocol_sha256: protocol.protocol_sha256, oracle: oracleIdentity, reanalysis_of: reanalysisOf,
    analysis_implementation: implementation, collector_source_sha256: collectorSourceSha256, notion, turn_control: turnControl.summary,
    turn_effects: { coverage: turnFacts.coverage, limitations: turnFacts.limitations, material_versions: turnFacts.material_rows.map(row => ({
      skill_id: row.skill_id, path: row.path, version: row.version, actual_sha256: row.actual_sha256,
      canonical_sha256: row.canonical_sha256, available_from_turn_id: row.available_from_turn_id, event_id: row.event_id, mapping: row.mapping })) },
    evidence, output_checks: outputChecks, tool_lineage_errors: toolResult.errors, unmatched_reads: unmatchedReads, opaque_tools: opaqueTools,
    code_mode_runtime: codeModeRuntime, metadata_runtime: metadataRuntime, metadata_only_tools: metadataOnlyTools,
    tool_containers: tools.filter(tool => tool.container).map(tool => ({ tool_call_id: tool.id, ...tool.container })),
    limitations: ['Source consumption requires delivered bytes and independently verified material parity.',
      'Opaque shell or arbitrary tool filesystem access is not inferred from code text or tool count.',
      'No clarification or state callback is synthesized from an expected event.'],
    source_registry: artifacts.map(a => ({ id: a.id, sha256: a.sha256, bytes: a.bytes, kind: a.kind })) };
  const readbackArtifact = await save('collection-readback', 'readback.json', readback);
  for (const [index, item] of evidence.artifacts.entries()) evidenceRefs.set(item.evidence_id,
    uniqueRefs([...(evidenceRefs.get(item.evidence_id) ?? []), ref(readbackArtifact, '/evidence/artifacts/' + index)]));
  for (const [index, item] of evidence.resource_reads.entries()) evidenceRefs.set(item.evidence_id,
    uniqueRefs([...(evidenceRefs.get(item.evidence_id) ?? []), ref(readbackArtifact, '/evidence/resource_reads/' + index)]));
  const gradeArtifact = await save('collection-grade', 'grade.json', { ...grade, derivation: oracleIdentity, collector_version: collectorVersion });
  const baseRefs = uniqueRefs([ref(sharedArtifact), ref(readbackArtifact), ...(resultArtifact ? [ref(resultArtifact)] : []),
    ...turnControl.summary.refs]);

  let transport = [], transportComplete = false;
  const transportArtifact = registry.get('transport');
  if (transportArtifact) {
    try { transport = await readProviderTransport(transportArtifact.path); transportComplete = transport.at(-1)?.complete === true; }
    catch { problems.push('transport_integrity_failed'); }
  }
  const starts = new Map(transport.filter(row => row.phase === 'request_start' && row.category === 'model').map(row => [row.id, row]));
  const sent = new Map(transport.filter(row => row.phase === 'request_sent').map(row => [row.id, row]));
  const endings = new Map(transport.filter(row => row.phase === 'request_end').map(row => [row.id, row]));
  const transportRef = row => ({ artifact_id: transportArtifact.id, sha256: transportArtifact.sha256, line: row.sequence });
  const attempts = [], matched = new Set();
  if (model.routing !== undefined) validateRoutingPolicy(model.routing);
  const providerBindings = new Map();
  async function bindProviderEvent(row, request, attempt, sourceRef) {
    if (row.data.provider !== '[REDACTED_CREDENTIAL]' || !attempt) return null;
    if (providerBindings.has(attempt.id)) return providerBindings.get(attempt.id);
    const candidateArtifact = registry.get('candidate-observed'), admissionArtifact = registry.get('admission-comparison');
    if (!candidateArtifact || !admissionArtifact) return null;
    const candidate = JSON.parse(fileBytes.get(candidateArtifact.id)), admission = JSON.parse(fileBytes.get(admissionArtifact.id));
    const expectedFile = admission.expected_file;
    if (!expectedFile?.path || !expectedFile.sha256) return null;
    const expectation = await addFile('collection-provider-binding-expectation', expectedFile.path, expectedFile.sha256);
    const start = resolveRef(request.start_ref), payload = resolveRef(request.payload_ref), httpStart = resolveRef(attempt.start_ref);
    const transportStart = starts.get(attempt.transport_id), transportSent = transportStart && sent.get(transportStart.id);
    const transportEnd = transportStart && endings.get(transportStart.id);
    const binding = deriveRedactedProviderBinding({ event: row, request, attemptId: attempt.id, requestStart: start?.value,
      candidate, expected: JSON.parse(fileBytes.get(expectation.id)), admission, payload: payload?.value,
      attemptStart: httpStart?.value, transportStart, transportSent, transportEnd, model,
      refs: uniqueRefs([sourceRef, ref(candidateArtifact, '/projection/model_configuration'),
        ref(candidateArtifact, '/projection/model'), ref(admissionArtifact), ref(expectation), start?.ref, payload?.ref, httpStart?.ref,
        transportStart ? transportRef(transportStart) : null, transportSent ? transportRef(transportSent) : null,
        transportEnd ? transportRef(transportEnd) : null]) });
    if (binding) providerBindings.set(attempt.id, binding);
    return binding;
  }
  let attemptSeq = 0, usageUnknown = false;
  for (const request of episode?.requests ?? []) {
    let observedUsage = null, usageRef = null, providerBinding = null;
    if (request.usage_ref) {
      const source = resolveRef(request.usage_ref), row = source?.value;
      if (row?.type === 'provider_stream_event' && row.data?.request_id === request.id &&
          row.data?.attempt_id === request.usage_attempt_id && row.data?.api === model.api &&
          row.data?.model === (model.route ?? model.id)) {
        providerBinding = await bindProviderEvent(row, request, request.attempts?.find(attempt => attempt.id === request.usage_attempt_id), source.ref);
        if (row.data.provider === model.provider || providerBinding) {
          observedUsage = collectRawUsage(model.api, row.data.event); usageRef = source.ref;
        }
      }
    }
    for (const attempt of request.attempts ?? []) {
      const start = starts.get(attempt.transport_id), actualSend = start && sent.get(start.id), end = start && endings.get(start.id);
      if (start) matched.add(start.id);
      const sendStatus = actualSend ? true : attempt.sent === false ? false : null;
      if (!start || !actualSend || !end || actualSend.requestBodySha256 !== request.payload_sha256) problems.push('model_transport_proof_incomplete');
      if (attempt.sent === true && !actualSend) problems.push('claimed_send_not_observed');
      let rawUsage = request.usage_attempt_id === attempt.id ? observedUsage : null;
      let attemptUsageRef = rawUsage ? usageRef : null, attemptProviderBinding = request.usage_attempt_id === attempt.id ? providerBinding : null;
      let reportedModel;
      if (model.routing) {
        const observations = [], bindingRefs = [];
        for (const [index, row] of events.entries()) {
          if (row.type !== 'provider_stream_event' || row.data?.request_id !== request.id || row.data?.attempt_id !== attempt.id) continue;
          const sourceRef = { artifact_id: eventArtifact.id, sha256: eventArtifact.sha256, line: index + 1 };
          const binding = await bindProviderEvent(row, request, attempt, sourceRef);
          if (binding) attemptProviderBinding ??= binding;
          bindingRefs.push(...(binding?.refs ?? []));
          const bound = row.data.api === model.api && row.data.model === (model.route ?? model.id) &&
            (row.data.provider === model.provider || Boolean(binding));
          const usage = bound ? collectRawUsage(model.api, row.data.event) : null;
          if (usage) { rawUsage = usage; attemptUsageRef = sourceRef; attemptProviderBinding = binding; }
          const reported = providerReportedModel(row.data.api, row.data.event);
          if (!reported) continue;
          observations.push({ ...reported, bound, ref: sourceRef });
        }
        reportedModel = assessReportedModel({ routing: model.routing, sent: sendStatus, observations,
          providerError: Boolean(attempt.error_ref) || attempt.status >= 400 || Boolean(end && end.outcome !== 'completed'),
          refs: uniqueRefs([cleanRef(attempt.start_ref), actualSend ? transportRef(actualSend) : null, end ? transportRef(end) : null,
            ...(resultArtifact ? [ref(resultArtifact, '/requests')] : []), ...bindingRefs]) });
        if (reportedModel.reason) problems.push(reportedModel.reason);
      }
      if (sendStatus === true && (!rawUsage?.complete || !adapterVerified)) usageUnknown = true;
      const sourceRefs = uniqueRefs([cleanRef(attempt.start_ref), actualSend ? transportRef(actualSend) : null,
        end ? transportRef(end) : null, attemptUsageRef, ...(attemptProviderBinding?.refs ?? []), ...(reportedModel?.refs ?? []), ...(resultArtifact ? [ref(resultArtifact, '/requests')] : [])]);
      const usage = Object.fromEntries(['input', 'output', 'cache_read', 'cache_write', 'reasoning'].map(key =>
        [key, rawUsage?.[key] !== null && rawUsage?.[key] !== undefined && attemptUsageRef
          ? known(rawUsage[key], [attemptUsageRef], 'reported') : unknown('Raw provider ' + key + ' is unavailable for this actual attempt', sourceRefs)]));
      attempts.push({ id: attempt.id, request_id: request.id, seq: attemptSeq++, sent: sendStatus, refs: sourceRefs,
        transport_id: start?.id ?? null, provider_binding: attemptProviderBinding, raw_usage_pointer: rawUsage?.raw_pointer ?? null,
        ...(reportedModel ? { reported_model: reportedModel } : {}),
        adapter: { id: model.adapter.id, version: model.adapter.version, verified: adapterVerified,
          evidence_sha256: model.adapter.evidence_sha256, input_semantics: 'includes_cache', output_semantics: 'includes_reasoning' },
        usage, cost: unknown('Route pricing is unverified; configured Pi zeros are not economic cost', sourceRefs) });
    }
  }
  for (const [id, start] of starts) if (!matched.has(id)) {
    problems.push('unattributed_model_transport'); usageUnknown = true;
    const actualSend = sent.get(id), refs = [transportRef(actualSend ?? start)];
    const reportedModel = model.routing ? assessReportedModel({ routing: model.routing, sent: actualSend ? true : null, refs }) : null;
    if (reportedModel?.reason) problems.push(reportedModel.reason);
    attempts.push({ id: 'unattributed-http-' + id, request_id: 'unattributed-http-' + id, seq: attemptSeq++,
      sent: actualSend ? true : null, refs, adapter: { id: model.adapter.id, version: model.adapter.version, verified: false },
      ...(reportedModel ? { reported_model: reportedModel } : {}),
      usage: {}, cost: unknown('Unattributed request cost is unknown', refs) });
  }
  const requestCoverage = episode?.coverage?.attempts === 'complete' && transportComplete &&
    !problems.some(reason => /transport|claimed_send/.test(reason)) ? 'complete' : 'partial';
  const status = episode?.status ?? 'invalid';
  if (!['completed', 'budget_stopped', 'failed'].includes(status)) problems.push('runtime_not_a_business_episode:' + status);
  if (episode?.admission?.status !== 'accepted_before_task') problems.push('task_admission_not_accepted');
  if (shared.runtime_check?.status !== 'unchanged' || shared.frozen_artifacts !== 'passed') problems.push('shared_runtime_or_artifact_drift');
  if (shared.timed_out || shared.signal !== null && shared.signal !== undefined || !shared.spawned) problems.push('launcher_completion_unproven');
  if (!episode?.completion?.cleanup?.abort_settled || !episode.completion.cleanup.dispose_called) problems.push('runtime_cleanup_incomplete');
  if (requestCoverage !== 'complete') problems.push('core_attempt_evidence_incomplete');
  if (!toolsComplete) problems.push('core_tool_evidence_incomplete');
  const reasons = [...new Set(problems)];
  const validity = reasons.length ? 'invalid' : 'valid';
  const duration = Number.isFinite(episode?.timing?.duration_ms) && episode.timing.duration_ms >= 0
    ? known(episode.timing.duration_ms, [ref(resultArtifact, '/timing/duration_ms')], 'observed') : unknown('No complete runtime elapsed-time observation', baseRefs);
  let successTime = unknown('Verified business completion boundary is unavailable', baseRefs);
  if (grade.verified_success && validity === 'valid' && status === 'completed' && turns.length) {
    const last = turns.at(-1), ended = resolveRef(last.end_ref), begin = episode.timing?.started_monotonic_ns;
    if (ended?.value?.type === 'user_turn_end' && ended.value.data?.settled === true && ended.value.data?.is_idle === true &&
        /^\d+$/.test(begin ?? '') && /^\d+$/.test(ended.value.monotonic_ns ?? '') && BigInt(ended.value.monotonic_ns) >= BigInt(begin)) {
      successTime = known(Number(BigInt(ended.value.monotonic_ns) - BigInt(begin)) / 1e6,
        [ended.ref, ref(resultArtifact, '/timing/started_monotonic_ns'), ref(readbackArtifact), ref(gradeArtifact)],
        'derived', 'verified_readback_matching_subject_boundary_elapsed_ms/v1');
    }
  }
  const normalizedContracts = grade.contracts.map((contract, index) => ({ ...contract,
    refs: uniqueRefs([ref(gradeArtifact, '/contracts/' + index), ref(readbackArtifact, '/evidence/coverage'),
      ...contract.evidence_ids.flatMap(id => evidenceRefs.get(id) ?? [])]),
    precision: 'derived', formula: 'corpus/gradeEpisode/v1', oracle_sha256: oracleIdentity.sha256 }));
  const interventions = [], interventionKinds = new Set(['human_rescue', 'evaluation_rescue', 'task_clarification', 'product_recovery']);
  let interventionCoverage = episode?.coverage?.interventions ?? 'unavailable';
  for (const [index, item] of (episode?.interventions ?? []).entries()) {
    if (interventionKinds.has(item.kind)) {
      const observed = item.ref ? resolveRef(item.ref) : null;
      const refs = uniqueRefs([observed?.ref, resultArtifact ? ref(resultArtifact, '/interventions/' + index) : null]);
      interventions.push({ ...item, id: item.id ?? 'intervention-' + index, refs });
    } else if (!/^BENCHMARK_/.test(item.kind ?? '')) interventionCoverage = 'partial';
  }
  const normalizationInput = {
    identity: { episode_id: run.run_id, run_id: run.run_id, experiment_id: protocol.id, condition_id: condition.id,
      environment_id: condition.environment_id, environment_sha256: condition.environment_sha256,
      model_id: model.id, model_route: model.route, ...(model.routing ? { model_routing: structuredClone(model.routing), model_api: model.api, model_provider: model.provider } : {}), corpus_id: protocol.corpus.id, corpus_sha256: protocol.corpus.content_sha256,
      case_id: slot.case_id, material_id: caseInfo.material_id, cluster_id: caseInfo.cluster_id, family: caseInfo.family,
      pair_id: slot.pair_id ?? null, repeat: slot.repeat, seed: slot.seed ?? null, split: caseInfo.split, phase: protocol.phase,
      build_id: shared.build_id ?? null, budget_id: condition.budget_id, goal: binding.public_case.title,
      collector_version: collectorVersion, collector_source_sha256: collectorSourceSha256,
      analysis_implementation: implementation, reanalysis_of: reanalysisOf },
    admission: { status: validity, reasons, refs: baseRefs, completeness: { attempts: requestCoverage,
      tools: toolsComplete ? 'complete' : 'partial', interventions: interventionCoverage } },
    attempts, tools, business: { status: grade.business_outcome, capability_status: grade.capability_status,
      capability_scope: grade.capability_scope, refs: [ref(gradeArtifact, '/business_outcome'), ref(readbackArtifact)],
      precision: 'derived', formula: 'corpus/gradeEpisode/v1', oracle_sha256: oracleIdentity.sha256 },
    contracts: normalizedContracts, interventions, timing: { duration_ms: duration, time_to_success_ms: successTime },
    artifacts,
  };
  // Runtime guard stops are limits, not human rescues. Unknown external assistance stays explicit in coverage.
  for (const source of sourceFiles)
    assert.equal(hash(await readFile(source.path)), source.sha256, 'Analysis implementation changed during collection');
  const normalizationPath = join(outputDirectory, 'normalization-input.json');
  await writeOnce(normalizationPath, canonicalJson(normalizationInput) + '\n');
  const normalizationArtifact = { path: normalizationPath }; // It cannot list itself without a recursive hash.
  const bundle = normalizeEpisode(normalizationInput);
  const stored = await writeEvidenceBundle({ directory: join(outputDirectory, 'normalized'), bundle, rawRoot: owned });
  const actualRequests = bundle.episode.measurements.actual_attempts;
  const budget_usage = { model_requests: actualRequests.status === 'known' ? actualRequests.value : null,
    input_tokens: bundle.episode.measurements.input_total.value.status === 'known' ? bundle.episode.measurements.input_total.value.value : null,
    output_tokens: bundle.episode.measurements.output_total.value.status === 'known' ? bundle.episode.measurements.output_total.value.value : null,
    duration_ms: duration.status === 'known' ? duration.value : null };
  const stop_batch = validity === 'invalid' || usageUnknown;
  const result = { schema_version: 1, kind: 'benchmark-collected-episode', collector_version: collectorVersion,
    run_id: run.run_id, validity, outcome: bundle.episode.result.outcome, verified_success: bundle.episode.result.verified_success,
    budget_usage, stop_batch, stop_reason: stop_batch ? reasons[0] ?? 'unknown_actual_usage' : null,
    turn_control: turnControl.summary,
    paths: { readback: readbackArtifact.path, grade: gradeArtifact.path, normalization_input: normalizationArtifact.path,
      bundle: stored.directory, episode: join(stored.directory, 'episode.json'), journey: join(stored.directory, 'journey.json') },
    episode_sha256: bundle.episode.episode_sha256 };
  await writeOnce(join(outputDirectory, 'collection.json'), canonicalJson(result) + '\n');
  return { ...result, bundle, grade, readback, stored };
}
