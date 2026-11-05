#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs';
import fsPromises, { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, resolveHost, runCommand, writeFakeProvider, assertSupportedPiVersion } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { safeRequestMetrics } from './notion-default-context.mjs';
import { systemTempRoot } from './verification-paths.mjs';
import { verifyPreparationEvidence } from './skill-preparation-evidence.mjs';

const usage = 'Usage: node scripts/notion-sdk-pi.mjs doctor|run --package ABSOLUTE_INSTALLED_BROKER (--fixture ABSOLUTE_FIXTURE_JSON | --live-input ABSOLUTE_LIVE_INPUT_JSON) [--expect-short-refs true|false] [--expect-compact-context true|false] [--expect-direct-scalar true|false] [--expect-short-confirmations true|false] [--scenario all|default-view|codemode-hidden|codemode-truncated|dollar|native|native-repeat|prepare|scoped-command|resource-batch|resource-batch-short-refs|resource-scalar|resource-scalar-short-refs|partial-entrypoint|session-lifecycle] [--out NEW_ABSOLUTE_EVIDENCE]; evidence|cleanup --evidence ABSOLUTE_EVIDENCE. Real Pi 1.4.0 or 1.5.0 RPC, controlled provider with public onPayload/onResponse hooks, offline source, default bundled SDK (source.command is absent). Compact context, direct scalar and short confirmation checks default to true; false observes a baseline without certifying that contract. Comparisons include the installed Broker and bundled CLI/SDK identities. default-view observes pending startup plus ready metadata on an ordinary continuation. session-lifecycle drives native fork/clone/tree/compact/resume and late-response cancellation with a controlled summary. The explicit live-input route selects one separate cold consumer on real Notion, an independently installed package auto-loaded by owned settings, and observer-only frozen local originals. The default offline all remains 14 scenarios. Native menu and real model are not claimed; live retained-body Member exclusion requires separate source attribution.';
const scenarioNames = ['default-view', 'codemode-hidden', 'codemode-truncated', 'dollar', 'native', 'native-repeat', 'prepare', 'scoped-command', 'resource-batch', 'resource-batch-short-refs', 'resource-scalar', 'resource-scalar-short-refs', 'partial-entrypoint', 'session-lifecycle'];
const nativeTools = ['read', 'notion_list', 'notion_use'];
const scopedCommandTools = [...nativeTools, 'bash', 'notion_ctl'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const rows = async path => {
  try { const text = await readFile(path, 'utf8'); assert.ok(!text || text.endsWith('\n'), 'Incomplete JSONL line'); return text.split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const textContent = content => typeof content === 'string' ? content : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
function toolResult(context, id) { return [...context.messages].reverse().find(message => message.role === 'toolResult' && message.toolCallId === id); }
function parsedResult(message) { assert.ok(message && !message.isError, 'Public tool result must succeed'); return JSON.parse(textContent(message.content)); }
function strings(value) {
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed !== value) return strings(parsed); } catch { /* Ordinary text is not JSON. */ }
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap(strings);
  return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
}
function jsonTextValues(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(jsonTextValues);
  return value && typeof value === 'object' ? Object.values(value).flatMap(jsonTextValues) : [];
}
export function bodyCount(context, body) {
  assert.ok(typeof body === 'string' && body.length > 0);
  const escaped = body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return (context.messages ?? []).reduce((total, message) => {
    // Only message content is model text. Receipts, schemas and tool arguments
    // are not a substitute for delivering a source body in that content.
    const text = textContent(message.content);
    let decoded = [];
    try { decoded = jsonTextValues(JSON.parse(text)); } catch { /* Ordinary content need not be JSON. */ }
    return total + Math.max(text.split(body).length - 1, text.split(escaped).length - 1,
      decoded.reduce((count, value) => count + value.split(body).length - 1, 0));
  }, 0);
}
function exactKeys(value, expected, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label);
}

/** Independent evidence check against the original fixture bytes. It does not
 * call the production compiler or verifier to certify their own output. */
export function assertPreparedProjection(message, { snapshots, bodies, roots = ['a', 'b', 'c'], purpose = 'use', state = 'source' }) {
  assert.equal(message?.role, 'toolResult'); assert.equal(message.toolName, 'notion_use');
  assert.equal(message.isError, false);
  assert.ok(Array.isArray(message.content) && message.content.length === 1 && message.content[0].type === 'text');
  const content = textContent(message.content);
  const proof = message.details?.contextBrokerPreparation;
  const validated = verifyPreparationEvidence(content, proof, message.toolCallId), { model, projection } = validated;
  assert.equal(model.purpose, purpose); assert.equal(model.records.length, bodies.size);
  const ids = new Set(), references = new Map();
  const verified = validated.records.map(({ model: record, receipt, mapping }) => {
    const source = snapshots.find(snapshot => snapshot.record.id === receipt?.binding?.record?.id && snapshot.scope === receipt.binding.scope);
    assert.ok(source && bodies.has(source.record.name), 'The canonical receipt must identify an original selected source');
    const body = bodies.get(source.record.name);
    assert.equal(ids.has(source.record.id), false, 'Shared Required must appear once'); ids.add(source.record.id);
    assert.equal(record.name, source.record.name); assert.equal(record.kind, source.record.kind);
    assert.match(record.ref, /^sr:S[A-Za-z0-9_-]{22}$/u); references.set(record.name, record.ref);
    assert.equal(receipt.snapshotId, source.snapshot_id);
    assert.equal(receipt.binding.snapshot_id, source.snapshot_id); assert.equal(receipt.binding.version_id, source.version_id);
    assert.equal(receipt.bodySha256, hash(body)); assert.equal(receipt.bytes, Buffer.byteLength(body));
    assert.equal(receipt.binding.body_sha256, hash(body));
    assert.equal(mapping.state, state);
    assert.deepEqual(mapping.source, { identity: receipt.identity, sha256: hash(body), bytes: Buffer.byteLength(body) });
    if (state === 'source') {
      assert.equal(record.content, body, 'The complete author bytes must survive JSON encoding');
    } else {
      assert.equal(state, 'replaced'); assert.equal(receipt.loaded, false);
      assert.notEqual(record.content, body, 'The repeated source span is replaced only in provider projection');
      assert.equal(projection.derived?.reason, 'deduplicate');
    }
    const directory = receipt.directory;
    if (directory !== undefined) {
      for (const [index, actual] of record.directory.files.entries()) {
        const original = source.files.find(file => file.path === actual.path);
        assert.ok(original, 'Each advertised resource is owned by this selected snapshot');
        assert.equal(actual.bytes, original.bytes); assert.equal(directory.files[index].sha256, original.sha256);
        assert.match(actual.ref, actual.path === source.entrypoint ? /^sr:S[A-Za-z0-9_-]{22}$/u : /^sr:R[A-Za-z0-9_-]{22}$/u);
        if (actual.path === source.entrypoint) assert.equal(actual.ref, record.ref);
      }
    }
    return { name: record.name, ref: record.ref, source_sha256: hash(body), source_bytes: Buffer.byteLength(body),
      source_identity: receipt.identity, snapshot_id: source.snapshot_id, state, delivery: mapping.delivery };
  });
  assert.deepEqual(model.roots, roots.map(name => references.get(name)), 'Roots identify the fixed model references in request order');
  assert.ok(model.roots.every(ref => typeof ref === 'string'));
  assert.equal(proof.graphs.length, 1, 'The fixture has one source scope');
  const graph = proof.graphs[0];
  assert.equal(graph.scope, snapshots[0].scope);
  assert.deepEqual(graph.roots, roots.map(name => snapshots.find(snapshot => snapshot.record.name === name).record.id));
  assert.deepEqual(graph.graph_lock.roots, graph.roots);
  assert.deepEqual(new Set(graph.graph_lock.bindings.map(binding => binding.record.id)), ids);
  for (const binding of graph.graph_lock.bindings) {
    const original = snapshots.find(snapshot => snapshot.record.id === binding.record.id && snapshot.scope === binding.scope);
    assert.ok(original); assert.equal(binding.snapshot_id, original.snapshot_id); assert.equal(binding.version_id, original.version_id);
    assert.match(binding.ref, /^skill:\/\//u); assert.equal(binding.body_sha256, hash(bodies.get(original.record.name)));
  }
  return { tool_call_id: message.toolCallId, compiler: projection.compiler, source_projection: projection.sourceProjection,
    content: { bytes: Buffer.byteLength(content), sha256: hash(content) },
    details: { bytes: Buffer.byteLength(JSON.stringify(message.details)), sha256: hash(JSON.stringify(message.details)) },
    records: verified, state, measurement: 'Pi tool content and host-only details measured separately; not model HTTP bytes' };
}

export function assertPreparedHttpRequest(payload, body, context) {
  return assertToolHttpRequest(payload, body, context, 'notion_use', 'contextBrokerPreparation');
}

export function assertResourceHttpRequest(payload, body, context) {
  return assertToolHttpRequest(payload, body, context, 'read', 'contextBrokerResource');
}

function assertToolHttpRequest(payload, body, context, toolName, proofField) {
  const encoded = Buffer.from(JSON.stringify(payload));
  assert.deepEqual(body, encoded, 'The public serializer hook must match the actual HTTP request bytes');
  assert.ok(Array.isArray(payload.messages));
  const preparations = (context.messages ?? []).filter(message => message.role === 'toolResult' && message.toolName === toolName && message.details?.[proofField] !== undefined);
  assert.ok(preparations.length > 0, 'Replay requires an actual captured tool result');
  for (const message of payload.messages) assert.equal(Object.hasOwn(message, 'details'), false, 'Host details must not become API message fields');
  const delivered = preparations.map(message => {
    const matches = payload.messages.filter(item => item.role === 'tool' && item.tool_call_id === message.toolCallId);
    assert.equal(matches.length, 1, 'The emitted API request must contain one result for this exact tool call');
    const emitted = matches[0];
    exactKeys(emitted, ['role', 'content', 'tool_call_id', ...(emitted.name === undefined ? [] : ['name'])], 'No machine proof fields may be added to a tool message');
    assert.equal(emitted.content, textContent(message.content), 'The actual serializer must preserve the provider-projected tool content');
    assert.ok(message.details?.[proofField], 'The replay must retain the separate original host proof');
    return { tool_call_id: message.toolCallId, content_bytes: Buffer.byteLength(emitted.content), content_sha256: hash(emitted.content),
      host_details_bytes: Buffer.byteLength(JSON.stringify(message.details)), host_details_sha256: hash(JSON.stringify(message.details)) };
  });
  return { request_bytes: body.length, request_sha256: hash(body), payload_matches_http: true, details_in_tool_messages: false, delivered };
}

/** Measure the actual serializer POST, never JSON.stringify(TranscriptContext).
 * The request file is the byte authority; these values make each schema, result
 * and historical tool call independently attributable to that request. */
export function assertProviderHttpRequest(payload, body, context) {
  assert.deepEqual(body, Buffer.from(JSON.stringify(payload)), 'The serializer hook must equal the actual HTTP request bytes');
  assert.ok(Array.isArray(payload.messages));
  assert.equal(Object.hasOwn(payload, 'context'), false, 'A captured TranscriptContext is not an API request');
  for (const message of payload.messages) assert.equal(Object.hasOwn(message, 'details'), false, 'Host details must stay outside API messages');
  const originalResults = context.messages.filter(message => message.role === 'toolResult');
  const apiResults = payload.messages.filter(message => message.role === 'tool');
  assert.equal(apiResults.length, originalResults.length, 'Every captured tool result must reach the serializer exactly once');
  const toolResults = originalResults.map(message => {
    const matches = apiResults.filter(item => item.tool_call_id === message.toolCallId);
    assert.equal(matches.length, 1);
    const emitted = matches[0];
    exactKeys(emitted, ['role', 'content', 'tool_call_id', ...(emitted.name === undefined ? [] : ['name'])], 'Tool messages contain no host proof fields');
    const originalText = textContent(message.content);
    // Installed Pi 1.4 uses this placeholder for an empty native read result.
    // Keep the empty raw/session text separate from the actual API byte count.
    const expectedText = originalText.trim().length > 0 ? originalText
      : Array.isArray(message.content) && message.content.some(block => block.type === 'image') ? '(see attached image)' : '(no tool output)';
    assert.equal(emitted.content, expectedText, 'The actual HTTP tool text must preserve provider content or the native empty-result placeholder');
    const details = message.details === undefined ? undefined : JSON.stringify(message.details);
    return { tool_call_id: message.toolCallId, tool_name: message.toolName, content: emitted.content,
      content_bytes: Buffer.byteLength(emitted.content), content_sha256: hash(emitted.content),
      captured_content_bytes: Buffer.byteLength(originalText), serializer_empty_result_placeholder: emitted.content !== originalText,
      host_details_bytes: details === undefined ? 0 : Buffer.byteLength(details), host_details_sha256: details === undefined ? null : hash(details) };
  });
  const originalCalls = context.messages.filter(message => message.role === 'assistant')
    .flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'toolCall') : []);
  const apiCalls = payload.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []);
  assert.equal(apiCalls.length, originalCalls.length, 'The actual serializer must retain every captured historical tool call');
  const toolCalls = apiCalls.map((call, index) => {
    const original = originalCalls[index];
    assert.equal(call.type, 'function'); assert.equal(call.id, original.id); assert.equal(call.function?.name, original.name);
    assert.equal(call.function.arguments, JSON.stringify(original.arguments), 'Tool arguments come from the actual captured call, including returned short refs');
    return { tool_call_id: call.id, tool_name: call.function.name, arguments: JSON.parse(call.function.arguments),
      arguments_json: call.function.arguments, arguments_bytes: Buffer.byteLength(call.function.arguments), arguments_sha256: hash(call.function.arguments) };
  });
  const tools = payload.tools ?? [], schema = JSON.stringify(tools), messages = JSON.stringify(payload.messages);
  assert.deepEqual(tools.map(tool => tool.function?.name).sort(), currentProviderTools(context).map(tool => tool.name).sort(),
    'Actual API schemas must describe precisely the active provider tools');
  const transcript = JSON.stringify(context), hostDetails = context.messages.filter(message => message.details !== undefined).map(message => JSON.stringify(message.details));
  return { request_bytes: body.length, request_sha256: hash(body), payload_matches_http: true, details_in_tool_messages: false,
    messages_json_bytes: Buffer.byteLength(messages), messages_sha256: hash(messages),
    tools_json_bytes: Buffer.byteLength(schema), tools_sha256: hash(schema), tools_schema: tools,
    tool_content_bytes: toolResults.reduce((total, result) => total + result.content_bytes, 0), tool_results: toolResults, tool_calls: toolCalls,
    transcript_capture: { bytes: Buffer.byteLength(transcript), sha256: hash(transcript),
      host_details_bytes: hostDetails.reduce((total, details) => total + Buffer.byteLength(details), 0), host_details_messages: hostDetails.length,
      measurement: 'Host TranscriptContext including details; not HTTP bytes or model token usage' } };
}

export function assertProviderToolSequence(captures, frames, { expectedErrors = [] } = {}) {
  const errors = new Set(expectedErrors);
  assert.equal(errors.size, expectedErrors.length, 'Expected error call IDs must be unique');
  const starts = frames.filter(frame => frame.type === 'tool_execution_start');
  const ends = frames.filter(frame => frame.type === 'tool_execution_end');
  const rounds = frames.filter(frame => frame.type === 'message_end' && frame.message?.role === 'assistant')
    .map(frame => (Array.isArray(frame.message.content) ? frame.message.content : []).filter(block => block.type === 'toolCall'))
    .filter(calls => calls.length);
  const calls = rounds.flat();
  assert.deepEqual(calls.map(call => call.id), starts.map(frame => frame.toolCallId), 'RPC assistant calls and actual tool executions must reconcile in order');
  assert.equal(new Set(starts.map(frame => frame.toolCallId)).size, starts.length);
  assert.equal(ends.length, starts.length, 'Every actual tool call has one terminal result');
  for (const id of errors) assert.ok(starts.some(frame => frame.toolCallId === id), 'Each expected error must actually execute');
  const sequence = starts.map((frame, index) => {
    const ended = ends.filter(item => item.toolCallId === frame.toolCallId);
    assert.equal(ended.length, 1); assert.equal(ended[0].isError, errors.has(frame.toolCallId));
    assert.equal(frame.toolName, calls[index].name); assert.deepEqual(frame.args, calls[index].arguments);
    const requests = captures.filter(capture => {
      const result = toolResult(capture.context, frame.toolCallId);
      if (result) assert.equal(result.isError, ended[0].isError, 'The actual provider must receive the terminal error status unchanged');
      return Boolean(result);
    }).map(capture => capture.requestId);
    assert.ok(requests.length > 0, 'Every actual result must be observed by a following provider request');
    return { index: index + 1, round: rounds.findIndex(items => items.some(call => call.id === frame.toolCallId)) + 1,
      tool_call_id: frame.toolCallId, tool_name: frame.toolName, arguments: frame.args, is_error: ended[0].isError,
      observed_in_provider_requests: requests };
  });
  return { provider_requests: captures.length, tool_rounds: rounds.length, tool_calls: starts.length, sequence };
}

export function assertSearchProjection(message, { expectCompact = true, scope } = {}) {
  const model = parsedResult(message), full = message.details;
  assert.ok(full && Array.isArray(full.records), 'The full metadata directory must remain in host details');
  assert.equal(model.records.length, full.records.length);
  const compact = { ...full, records: full.records.map(record => {
    assert.ok(typeof record.id === 'string' && record.id.length > 0);
    assert.ok(typeof record.scope === 'string' && record.scope.length > 0);
    if (scope !== undefined) assert.equal(record.scope, scope);
    const { id: _id, scope: _scope, ...visible } = record;
    return visible;
  }) };
  if (expectCompact) assert.deepEqual(model, compact, 'Only id and scope are omitted from the model search projection');
  else assert.ok(JSON.stringify(model) === JSON.stringify(full) || JSON.stringify(model) === JSON.stringify(compact), 'Baseline search content must still agree with its full host receipt');
  return { records: full.records.length, content_bytes: Buffer.byteLength(textContent(message.content)),
    host_details_bytes: Buffer.byteLength(JSON.stringify(full)), full_host_id_scope: true,
    compact_contract: expectCompact ? 'verified' : 'not_required_for_baseline' };
}

/** The actual default catalog must agree with the independent metadata fixture. */
export function assertDefaultViewProjection(captures, discovery, events, fixture, bodies, { sourceId = 'sdk-fixture' } = {}) {
  const expected = fixture.default_view;
  assert.ok(expected?.records?.length, 'Default View fixture metadata is required');
  const results = events.filter(event => event.kind === 'sdk_catalog' && event.value?.view?.id === expected.id);
  assert.ok(results.length > 0, 'An actual default listCatalog SDK result is required');
  for (const { value } of results) {
    assert.equal(value.view_selection, 'first'); assert.equal(value.coverage?.exhaustive, true);
    assert.deepEqual(value.coverage.failed_sources, []);
    assert.deepEqual(value.records.map(record => record.id).sort(), expected.records.map(record => record.id).sort());
    assert.equal(value.count, expected.records.length);
  }
  if (discovery) assert.deepEqual(discovery.records.filter(record => record.in_default_view).map(record => record.name).sort(), expected.records.map(record => record.name).sort());
  const observations = captures.map(capture => {
    const texts = capture.context.messages.map(message => textContent(message.content));
    const catalogs = texts.flatMap(text => [...text.matchAll(/<ntn-skills-view-catalog>([\s\S]*?)<\/ntn-skills-view-catalog>/gu)]);
    assert.ok(catalogs.length <= 1, 'Default directory must not be duplicated in a provider request');
    for (const body of bodies.values()) assert.equal(bodyCount(capture.context, body), 0, 'Default discovery never delivers Skill bodies');
    if (!catalogs.length) return { request_id: capture.requestId,
      state: texts.some(text => /<ntn-skills-discovery status="pending">[\s\S]*?<\/ntn-skills-discovery>/u.test(text)) ? 'pending' : 'not_ready' };
    const catalog = catalogs[0][1], views = [...catalog.matchAll(/<view\b([^>]*)>/gu)];
    const attributes = views.map(view => Object.fromEntries([...view[1].matchAll(/([a-z_]+)="([^"]*)"/gu)].map(match => [match[1], match[2]])));
    const view = attributes.find(value => value.source === sourceId);
    if (!view?.id) return { request_id: capture.requestId, state: view?.status ?? 'not_ready', code: view?.code ?? null };
    assert.equal(view.id, expected.id); assert.equal(view.partial, 'false');
    const entries = [...catalog.matchAll(/<skill><name>([^<]+)<\/name><description>([^<]*)<\/description><source>([^<]+)<\/source><location>([^<]+)<\/location><\/skill>/gu)];
    assert.equal(entries.length, expected.records.length);
    const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    for (const record of expected.records) {
      const actual = discovery ? discovery.records.find(value => value.name === record.name && value.source === sourceId)
        : { name: record.name, description: record.description, source: sourceId };
      assert.ok(actual); const matches = entries.filter(entry => entry[1] === xml(record.name) && entry[3] === actual.source);
      assert.equal(matches.length, 1, 'Display the author name and explicit source, not the sanitized command token');
      assert.equal(matches[0][2], xml(actual.description)); assert.match(matches[0][4], /^sr:C[A-Za-z0-9_-]{22}$/u);
      if (discovery) assert.equal(matches[0][4], actual.ref);
      assert.equal(texts.reduce((count, text) => count + text.split(matches[0][0]).length - 1, 0), 1);
    }
    return { request_id: capture.requestId, state: 'ready', records: entries.length, catalog_bytes: Buffer.byteLength(catalogs[0][0]) };
  });
  assert.equal(observations.at(-1)?.state, 'ready', 'Missing or incomplete Default View cannot pass as an empty successful directory');
  return { status: 'verified', view_id: expected.id, source_command_configured: false, sdk_catalog_results: results.length,
    default_names: expected.records.map(record => record.name), provider_requests: observations, body_delivery: false };
}

export function assertDollarProjection(context, { bodies, snapshots, expectCompact = true }) {
  const texts = context.messages.map(message => textContent(message.content));
  const records = texts.flatMap(text => [...text.matchAll(/<context-broker-record\b([^>]*)>([\s\S]*?)<\/context-broker-record>/gu)]);
  assert.equal(records.length, 2, 'Dollar activation delivers only the selected root and its Required body');
  const evidence = records.map(match => {
    const attributes = Object.fromEntries([...match[1].matchAll(/([a-z-]+)="([^"]*)"/gu)].map(value => [value[1], value[2]]));
    assert.ok(['a', 'base'].includes(attributes.name));
    const source = bodies.get(attributes.name), encoded = source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const body = /<body>\n([\s\S]*)\n<\/body>/u.exec(match[2]);
    assert.ok(body); assert.equal(body[1], encoded, 'Every complete source byte survives the XML projection, including BOM and CRLF');
    const envelope = match[2].replace(body[0], '');
    if (expectCompact) {
      exactKeys(attributes, ['kind', 'name', 'ref'], 'Compact record identity uses one fixed ref');
      assert.match(attributes.ref, /^sr:S[A-Za-z0-9_-]{22}$/u);
      assert.doesNotMatch(envelope, /<(?:instructions|skill-directory|skill-ref|snapshot-id)(?:\s|>)/u, 'Generated wrappers must not advertise cache directories or repeated generic instructions');
      const snapshot = snapshots?.find(value => value.record.name === attributes.name);
      assert.ok(snapshot, 'Supporting resources must be checked against the independently selected snapshot');
      const expectedFiles = snapshot.files.filter(file => file.path !== snapshot.entrypoint);
      const resources = [...envelope.matchAll(/<resources>([\s\S]*?)<\/resources>/gu)];
      assert.equal(resources.length, expectedFiles.length ? 1 : 0, 'Only actual supporting files require a resource block');
      if (resources.length) {
        const decoded = resources[0][1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
        const files = JSON.parse(decoded);
        assert.deepEqual(files.map(file => file.path), expectedFiles.map(file => file.path), 'Every supporting path belongs to this selected snapshot');
        for (const file of files) { exactKeys(file, ['path', 'ref'], 'Supporting file cards contain only an exact path and copied ref'); assert.match(file.ref, /^sr:R[A-Za-z0-9_-]{22}$/u); }
      }
    }
    return { name: attributes.name, ref: attributes.ref ?? null, source_bytes: Buffer.byteLength(source), source_sha256: hash(source),
      envelope_bytes: Buffer.byteLength(match[0]) - Buffer.byteLength(body[1]), source_complete: true };
  });
  assert.deepEqual(evidence.map(record => record.name).sort(), ['a', 'base']);
  if (expectCompact) for (const text of texts) assert.doesNotMatch(text.replace(/<body>\n[\s\S]*?\n<\/body>/gu, ''), /<!-- context-broker:/u);
  return { records: evidence, compact_contract: expectCompact ? 'verified' : 'not_required_for_baseline' };
}

export function assertNativeProjection(message, { snapshot, body, expectCompact = true }) {
  assert.ok(message && !message.isError);
  const content = textContent(message.content), proof = message.details?.contextBrokerRead;
  assert.ok(proof); assert.equal(proof.binding?.record.id, snapshot.record.id); assert.equal(proof.binding?.scope, snapshot.scope);
  assert.equal(proof.snapshotId, snapshot.snapshot_id); assert.equal(proof.binding?.version_id, snapshot.version_id);
  assert.equal(proof.bodySha256, hash(body)); assert.equal(proof.bytes, Buffer.byteLength(body));
  assert.ok(content.startsWith(body), 'The native footer cannot replace or change the complete source prefix');
  const footer = /<skill-directory>\s*([\s\S]*?)\s*<\/skill-directory>/u.exec(content.slice(body.length));
  if (!footer) {
    assert.equal(expectCompact, false, 'The candidate native read must advertise its resources directly');
    return { direct_directory: false, compact_contract: 'not_required_for_baseline' };
  }
  const model = JSON.parse(footer[1]);
  if (expectCompact) {
    exactKeys(model, ['ref', 'directory'], 'The native model footer has one fixed main ref and directory');
    assert.match(model.ref, /^sr:S[A-Za-z0-9_-]{22}$/u);
    exactKeys(model.directory, ['files', 'required', 'candidates', 'references'], 'Compact native directory');
    assert.ok(proof.directory, 'The complete source directory stays in host details');
    assert.equal(proof.directory.files.length, snapshot.files.length);
    for (const [index, file] of model.directory.files.entries()) {
      exactKeys(file, ['path', 'ref', 'bytes'], 'Native model files omit hashes');
      const original = snapshot.files.find(item => item.path === file.path), full = proof.directory.files[index];
      assert.ok(original); assert.equal(file.bytes, original.bytes);
      assert.equal(full.path, file.path); assert.equal(full.bytes, original.bytes); assert.equal(full.sha256, original.sha256);
      assert.match(full.ref, /^skill:\/\//u);
      assert.match(file.ref, file.path === snapshot.entrypoint ? /^sr:S[A-Za-z0-9_-]{22}$/u : /^sr:R[A-Za-z0-9_-]{22}$/u);
      if (file.path === snapshot.entrypoint) assert.equal(file.ref, model.ref);
    }
    assert.deepEqual(model.directory.files.map(file => file.path), snapshot.files.map(file => file.path));
    for (const key of ['required', 'candidates', 'references']) {
      assert.equal(model.directory[key].length, proof.directory[key].length);
      for (const [index, relation] of model.directory[key].entries()) {
        exactKeys(relation, ['ref', 'kind', 'name', 'description', 'availability'], 'Native relation content omits machine identity');
        const full = proof.directory[key][index]; assert.ok(typeof full.id === 'string' && full.id.length > 0);
        for (const field of ['kind', 'name', 'description', 'availability']) assert.equal(relation[field], full[field]);
        assert.ok(typeof relation.ref === 'string' && relation.ref.length > 0);
      }
    }
  }
  return { direct_directory: true, directory_files: model.directory.files.length,
    resource_refs: model.directory.files.filter(file => file.path !== snapshot.entrypoint).map(file => file.ref),
    footer_bytes: Buffer.byteLength(footer[0]), footer_sha256: hash(footer[0]),
    host_details_bytes: Buffer.byteLength(JSON.stringify(message.details)), full_host_directory: proof.directory !== undefined,
    compact_contract: expectCompact ? 'verified' : 'not_required_for_baseline' };
}

/** Read only handles actually advertised by the first native main result. */
export function selectNativeRepeatCall(context, { mainRef, resourcePath }) {
  const find = id => context.messages.find(message => message.role === 'toolResult' && message.toolCallId === id);
  const call = (id, path) => ({ type: 'toolCall', id, name: 'read', arguments: { path } });
  const main = find('sc15-main');
  if (!main) return call('sc15-main', mainRef);
  if (main.isError) throw new Error('CONTROLLED_REPEAT_MAIN_FAILED');
  const text = typeof main.content === 'string' ? main.content : main.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const footer = /<skill-directory>\s*([\s\S]*?)\s*<\/skill-directory>/u.exec(text);
  if (!footer) throw new Error('CONTROLLED_REPEAT_DIRECTORY_MISSING');
  const model = JSON.parse(footer[1]), files = model.directory?.files?.filter(file => file.path === resourcePath);
  if (!/^sr:S[A-Za-z0-9_-]{22}$/u.test(model.ref) || files?.length !== 1 || !/^sr:R[A-Za-z0-9_-]{22}$/u.test(files[0].ref))
    throw new Error('CONTROLLED_REPEAT_HANDLES_INVALID');
  for (const [id, ref] of [['sc15-resource', files[0].ref], ['sc15-main-repeat', model.ref], ['sc15-resource-repeat', files[0].ref]]) {
    const result = find(id);
    if (!result) return call(id, ref);
    if (result.isError) throw new Error('CONTROLLED_REPEAT_READ_FAILED');
  }
  return null;
}

export function assertNativeRepeatProjection(captures, originals, { batch, expectShort = true }) {
  const ids = ['sc15-main', 'sc15-resource', 'sc15-main-repeat', 'sc15-resource-repeat'];
  assert.deepEqual(originals.map(message => message.toolCallId), ids);
  assert.equal(captures.length, 6, 'Search and four native reads require six provider requests');
  const file = batch.files.find(value => value.encoding === 'utf8' && value.content.length > 0 && !value.content.startsWith('\ufeff'));
  assert.ok(file);
  const mainReads = [originals[0], originals[2]].map(message => {
    assert.equal(message.role, 'toolResult'); assert.equal(message.toolName, 'read');
    const result = assertNativeProjection(message, { snapshot: batch.snapshot, body: batch.main });
    const proof = message.details.contextBrokerRead;
    assert.equal(proof.version, 3); assert.equal(proof.toolCallId, message.toolCallId);
    assert.deepEqual(proof.delivery, { start: 0, end: batch.main.length, encoding: 'raw' });
    return { tool_call_id: message.toolCallId, ...result };
  });
  assert.deepEqual(originals[2].content, originals[0].content, 'Both actual main reads return the complete same body and directory');
  const source = textContent(originals[0].content), suffix = source.slice(batch.main.length);
  const refs = JSON.parse(/<skill-directory>\s*([\s\S]*?)\s*<\/skill-directory>/u.exec(suffix)[1]);
  const resourceRef = refs.directory.files.find(value => value.path === file.path).ref;
  const resourceReads = [originals[1], originals[3]].map(message => assertResourceScalarResult(message,
    { batch, call: { id: message.toolCallId, args: { path: resourceRef }, file, expectedText: file.content, completeText: true } }));
  const mainConfirmation = expectShort ? 'Already loaded.'
    : `The complete Skill entry for snapshot ${batch.snapshot.snapshot_id} is already present in this active context. This successful repeated read verified the same entry bytes; use the existing instructions and their fixed resource directory.`;
  const resourceConfirmation = expectShort ? 'Already available.'
    : `The complete Skill resource ${file.path} for snapshot ${batch.snapshot.snapshot_id} is already present in this active context. This successful repeated read verified the same resource bytes.`;
  const expectedContent = [source, file.content, mainConfirmation + suffix, resourceConfirmation];
  assert.ok(originals[2].content[0]?.type === 'text' && originals[2].content[0].text.startsWith(batch.main));
  const repeatedMainBlocks = originals[2].content.map((block, index) => index === 0
    ? { ...block, text: mainConfirmation + block.text.slice(batch.main.length) } : block);
  const expectedBlocks = [originals[0].content, originals[1].content, repeatedMainBlocks, [{ type: 'text', text: resourceConfirmation }]];
  const requests = captures.map((capture, index) => {
    for (const [position, id] of ids.entries()) {
      const messages = capture.context.messages.filter(message => message.role === 'toolResult' && message.toolCallId === id);
      assert.equal(messages.length, index >= position + 2 ? 1 : 0, 'Every repeated read enters only its actual subsequent provider requests');
      if (!messages.length) continue;
      const message = messages[0]; assert.equal(message.isError, false); assert.equal(message.toolName, 'read');
      assert.deepEqual(message.content, expectedBlocks[position], 'Only the repeated body changes; the original native block boundaries and directory remain intact');
      assert.equal(textContent(message.content), expectedContent[position], 'The full native text projection preserves the exact directory suffix');
      if (position < 2) assert.deepEqual(message.details, originals[position].details, 'The first complete delivery retains its original receipt');
      // Native v1/v3 receipts and structured output describe the original tool
      // result. Provider text is checked independently rather than treating a
      // retained full-text flag as proof that a short marker is source bytes.
      if (message.structuredContent !== undefined) assert.deepEqual(message.structuredContent, originals[position].structuredContent);
      if (position % 2) assert.equal(message.details.contextBrokerResource.loaded, false);
      if (expectShort && position === 2) assert.equal(message.details.contextBrokerRead.loaded, false, 'The repeated main projection cannot claim activation');
      if (expectShort && position === 3) assert.equal(message.details.contextBrokerResource.delivered_complete_text, false, 'The confirmation is not a new complete resource delivery');
    }
    const mainCopies = bodyCount(capture.context, batch.main), resourceCopies = bodyCount(capture.context, file.content);
    assert.equal(mainCopies, index >= 2 ? 1 : 0); assert.equal(resourceCopies, index >= 3 ? 1 : 0);
    for (const other of [...batch.files, ...batch.unselected].filter(value => value.path !== file.path && value.encoding !== 'base64' && value.content.length))
      assert.equal(bodyCount(capture.context, other.content), 0, 'Unrequested text is never delivered');
    return { request_id: capture.requestId, main_content_copies: mainCopies, resource_content_copies: resourceCopies,
      repeated_main_present: index >= 4, repeated_resource_present: index >= 5,
      structured_content_present: ids.filter(id => toolResult(capture.context, id)?.structuredContent !== undefined) };
  });
  return { expectation: expectShort ? 'short_confirmations_verified' : 'baseline_long_confirmations_recorded',
    main: { source_bytes: Buffer.byteLength(batch.main), source_sha256: hash(batch.main), reads: mainReads,
      confirmation: mainConfirmation, confirmation_bytes: Buffer.byteLength(mainConfirmation), directory_suffix_bytes: Buffer.byteLength(suffix), directory_suffix_sha256: hash(suffix),
      native_content_blocks: originals[0].content.map(block => ({ type: block.type, ...(block.type === 'text' ? { bytes: Buffer.byteLength(block.text), sha256: hash(block.text) } : {}) })) },
    resource: { path: file.path, source_bytes: file.bytes, source_sha256: file.sha256, reads: resourceReads,
      confirmation: resourceConfirmation, confirmation_bytes: Buffer.byteLength(resourceConfirmation) },
    requests, first_complete_content_preserved: true, original_directory_preserved: true, raw_native_structured_content_verified: true,
    structured_content_boundary: 'Native RPC structured output is verified; provider/session fields are checked when present, and native Pi omission is recorded without injecting it' };
}

/** Compare actual tool/provider text and byte spans against independently seeded
 * fixture bytes. Host receipts are checked, never used as the source oracle. */
export function assertResourceBatchProjection(message, { batch, state = 'source' }) {
  assert.equal(message?.role, 'toolResult'); assert.equal(message.toolName, 'read'); assert.equal(message.isError, false);
  assert.ok(Array.isArray(message.content) && message.content.length === 1 && message.content[0].type === 'text');
  const content = textContent(message.content), model = JSON.parse(content), proof = message.details?.contextBrokerResource;
  assert.equal(content, JSON.stringify(model), 'The complete resource envelope uses deterministic JSON');
  exactKeys(model, ['status', 'files'], 'Only public resource results enter model content');
  assert.equal(model.status, 'ready'); assert.equal(model.files.length, batch.files.length);
  if (message.structuredContent !== undefined) assert.deepEqual(message.structuredContent, model, 'Structured output and actual tool text must agree');
  exactKeys(proof, ['version', 'toolCallId', 'loaded', 'selection', 'files', 'projection'], 'Resource proof stays in host details');
  assert.equal(proof.version, 2); assert.equal(proof.toolCallId, message.toolCallId); assert.equal(proof.loaded, false);
  assert.equal(message.details.contextBrokerRead, undefined); assert.equal(message.details.contextBrokerPreparation, undefined);
  const snapshot = batch.snapshot;
  assert.deepEqual(proof.selection, { scope: snapshot.scope, owner: snapshot.record.id, snapshot_id: snapshot.snapshot_id, version_id: snapshot.version_id });
  assert.equal(proof.files.length, batch.files.length);
  const projection = proof.projection;
  exactKeys(projection, ['version', 'compiler', 'rendered', ...(state === 'replaced' ? ['derived'] : [])], 'Versioned resource projection');
  assert.equal(projection.version, 1); assert.equal(projection.compiler, 'context-broker/resource-read/v1');
  assert.deepEqual(projection.rendered, { sha256: hash(content), bytes: Buffer.byteLength(content) });
  if (state === 'replaced') {
    exactKeys(projection.derived, ['reason', 'parentSha256'], 'Repeated provider projection links its actual parent');
    assert.equal(projection.derived.reason, 'deduplicate'); assert.match(projection.derived.parentSha256, /^[a-f0-9]{64}$/u);
  } else assert.equal(state, 'source');
  let cursor = content.indexOf('"files":[');
  const verified = model.files.map((file, index) => {
    const expected = batch.files[index], receipt = proof.files[index];
    assert.equal(file.path, expected.path); assert.ok(file.ref === expected.ref || /^sr:R[A-Za-z0-9_-]{22}$/u.test(file.ref));
    assert.equal(receipt.index, index); assert.equal(receipt.requested_ref, expected.ref); assert.equal(receipt.ref, expected.ref);
    assert.equal(receipt.model_ref, file.ref); assert.equal(receipt.file_id, expected.file_id); assert.equal(receipt.path, expected.path);
    assert.equal(receipt.bytes, expected.bytes); assert.equal(receipt.sha256, expected.sha256); assert.equal(receipt.encoding, expected.encoding);
    assert.equal(receipt.loaded, false);
    const binary = expected.encoding === 'base64';
    exactKeys(receipt, ['index', 'requested_ref', 'ref', 'model_ref', 'file_id', 'path', 'bytes', 'sha256', 'encoding', 'loaded', 'delivered_complete_text', 'state', binary ? 'output' : 'delivery'], 'Each selected resource has one exact receipt');
    if (binary) {
      exactKeys(file, ['kind', 'ref', 'path', 'bytes', 'sha256', 'output'], 'Binary bytes are materialized, not claimed as model text');
      assert.equal(file.kind, 'binary'); assert.equal(file.bytes, expected.bytes); assert.equal(file.sha256, expected.sha256);
      assert.ok(typeof file.output === 'string' && isAbsolute(file.output)); assert.equal(receipt.output, file.output);
      assert.equal(receipt.state, 'binary'); assert.equal(receipt.delivered_complete_text, false);
    } else {
      exactKeys(file, ['kind', 'ref', 'path', 'content'], 'Text includes the complete source or a proven repeat marker');
      assert.equal(file.kind, 'text'); assert.equal(typeof file.content, 'string');
      const replaced = state === 'replaced' && expected.content.length > 0;
      assert.equal(file.content, replaced ? 'Already available.' : expected.content);
      assert.equal(receipt.state, replaced ? 'replaced' : 'source'); assert.equal(receipt.delivered_complete_text, !replaced);
      const serialized = JSON.stringify(file), offset = content.indexOf(serialized, cursor);
      assert.ok(offset >= cursor, 'A text span belongs to this exact file entry');
      const property = serialized.indexOf('"content":' + JSON.stringify(file.content)); assert.ok(property >= 0);
      const start = offset + property + '"content":"'.length, encoded = JSON.stringify(file.content).slice(1, -1);
      assert.deepEqual(receipt.delivery, { start, end: start + encoded.length, encoding: 'json' });
      const actual = JSON.parse('"' + content.slice(start, start + encoded.length) + '"');
      assert.equal(actual, file.content);
      if (!replaced) { assert.equal(Buffer.byteLength(actual), expected.bytes); assert.equal(hash(actual), expected.sha256); }
      cursor = offset + serialized.length;
    }
    return { path: expected.path, ref: file.ref, source_bytes: expected.bytes, source_sha256: expected.sha256,
      state: receipt.state, delivered_complete_text: receipt.delivered_complete_text,
      ...(binary ? { output: file.output } : { delivery: receipt.delivery }) };
  });
  return { tool_call_id: message.toolCallId, state, content: projection.rendered, files: verified,
    details: { bytes: Buffer.byteLength(JSON.stringify(message.details)), sha256: hash(JSON.stringify(message.details)) } };
}

export function resourceTextCopies(context, file) {
  return (context.messages ?? []).reduce((count, message) => {
    if (message.role !== 'toolResult' || message.toolName !== 'read' || message.isError) return count;
    let value; try { value = JSON.parse(textContent(message.content)); } catch { return count; }
    return count + (Array.isArray(value.files) ? value.files.filter(item => item.kind === 'text' && item.path === file.path && item.content === file.content).length : 0);
  }, 0);
}

/** Five fixed scalar calls exercise native text, pagination, binary and empty
 * results without discovering or preparing a main body in the measured task. */
export function resourceScalarCalls(batch, refs = batch.refs) {
  assert.equal(batch.files.length, 4); assert.equal(refs.length, 4); assert.equal(new Set(refs).size, 4);
  const one = predicate => { const values = batch.files.filter(predicate); assert.equal(values.length, 1); return values[0]; };
  const utf8 = one(file => file.encoding === 'utf8' && file.content.length > 0 && !file.content.startsWith('\ufeff'));
  const bom = one(file => file.encoding === 'utf8' && file.content.startsWith('\ufeff'));
  const binary = one(file => file.encoding === 'base64'), empty = one(file => file.encoding === 'utf8' && file.content === '');
  const lines = bom.content.split('\n'); assert.equal(lines.length, 3); assert.equal(lines[2], '');
  const call = (id, file, extra = {}, expectedText = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')) => ({
    id, args: { path: refs[batch.files.indexOf(file)], ...extra }, file, expectedText,
    completeText: Buffer.byteLength(expectedText) === file.bytes && hash(expectedText) === file.sha256,
  });
  return [call('sc14-utf8', utf8), call('sc14-page', bom, { offset: 2, limit: 1 },
    lines[1] + '\n\n[1 more lines in file. Use offset=3 to continue.]'),
  call('sc14-bom', bom), call('sc14-binary', binary), call('sc14-empty', empty)];
}

export function selectScalarProviderCall(context, calls) {
  for (const call of calls) {
    const result = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === call.id);
    if (!result) return { type: 'toolCall', id: call.id, name: 'read', arguments: call.args };
    if (result.isError) throw new Error('CONTROLLED_SCALAR_RESOURCE_READ_FAILED');
  }
  return null;
}

export function assertResourceScalarResult(message, { batch, call }) {
  assert.equal(message?.role, 'toolResult'); assert.equal(message.toolName, 'read'); assert.equal(message.isError, false);
  assert.equal(message.toolCallId, call.id);
  assert.deepEqual(message.content, [{ type: 'text', text: call.expectedText }], 'Scalar reads preserve the native result, including BOM, CRLF and pagination');
  if (message.structuredContent !== undefined) assert.equal(message.structuredContent, call.expectedText, 'Native structured output is preserved');
  const proof = message.details?.contextBrokerResource, { snapshot } = batch, { file } = call;
  assert.ok(proof); assert.equal(proof.version, 1); assert.equal(proof.toolCallId, call.id); assert.equal(proof.loaded, false);
  assert.equal(proof.id, snapshot.record.id); assert.equal(proof.scope, snapshot.scope);
  assert.equal(proof.snapshot_id, snapshot.snapshot_id); assert.equal(proof.version_id, snapshot.version_id);
  assert.equal(proof.ref, file.ref); assert.equal(proof.path, file.path); assert.equal(proof.file_id, file.file_id);
  assert.equal(proof.bytes, file.bytes); assert.equal(proof.sha256, file.sha256);
  assert.equal(proof.delivered_complete_text, call.completeText);
  assert.equal(message.details.contextBrokerRead, undefined); assert.equal(message.details.contextBrokerPreparation, undefined);
  return { tool_call_id: call.id, arguments: call.args, path: file.path, file_id: file.file_id,
    source_bytes: file.bytes, source_sha256: file.sha256, content_bytes: Buffer.byteLength(call.expectedText), content_sha256: hash(call.expectedText),
    structured_content_present: message.structuredContent !== undefined, delivered_complete_text: proof.delivered_complete_text,
    loaded: proof.loaded, ...(proof.materialization === undefined ? {} : { materialization: proof.materialization }) };
}

/** This is declared session-state fixture setup, not a claim that an agent
 * obtained an sr:R without inspection. Only frozen manifest metadata is used. */
export function resourceScalarSelectedFixture(batch, root) {
  const { snapshot } = batch, main = snapshot.files.find(file => file.path === snapshot.entrypoint);
  assert.ok(main);
  const files = snapshot.files.map(file => {
    const binding = snapshot.file_bindings.find(value => value.path === file.path); assert.ok(binding);
    return { ...file, ref: 'skill://' + encodeURIComponent(snapshot.record.id) + '/' + file.path
      + '?snapshot=' + snapshot.snapshot_id + '&file_id=' + encodeURIComponent(binding.file_id) };
  });
  return { ...snapshot.record, source: 'notion', sourceId: 'sdk-fixture', sourceScope: snapshot.scope,
    path: join(root, snapshot.entrypoint), aliases: [], normalizedAliases: [], normalizedName: snapshot.record.name,
    normalizedDescription: snapshot.record.description, autoloadEnabled: false, snapshotId: snapshot.snapshot_id, versionId: snapshot.version_id,
    preparationBinding: { record: snapshot.record, scope: snapshot.scope, snapshot_id: snapshot.snapshot_id,
      version_id: snapshot.version_id, body_sha256: main.sha256, ref: files.find(file => file.path === snapshot.entrypoint).ref },
    fileBindings: snapshot.file_bindings,
    entryManifest: { version: 1, root, receipt: join(root, 'fixture-metadata-only.json'), manifest_id: hash(JSON.stringify(files)),
      files, manifest_complete: true, local_files_ready: false, materialized_paths: [] } };
}

export function assertResourceScalarSession(entries, { batch, setupOnly = false } = {}) {
  const messages = entries.flatMap(entry => entry.message ? [entry.message] : []), custom = entries.filter(entry => entry.type === 'custom');
  const active = custom.filter(entry => entry.customType === 'context-broker-active-sources');
  const deliveries = messages.filter(message => message.details?.contextBrokerRead || message.details?.contextBrokerPreparation
    || message.role === 'custom' && ['context-broker', 'skill-prompt-message'].includes(message.customType));
  assert.equal(active.length, 0, 'Reading resources must not activate their Skill');
  assert.equal(deliveries.length, 0, 'Reading resources must not create a main delivery receipt');
  assert.equal(bodyCount({ messages }, batch.main), 0, 'The actual session must not contain the main body');
  if (setupOnly) {
    assert.ok(custom.length > 0); assert.ok(custom.every(entry => entry.customType === 'context-broker-short-ref'));
    assert.ok(messages.length === 1 && messages[0].role === 'user', 'The seed has one declared setup message and no tool/model history');
    assert.equal(strings(entries).some(value => value.includes(batch.main)), false, 'The seed contains no main body in metadata either');
    assert.equal(custom.filter(entry => entry.data?.target?.kind === 'selected').length, 1);
    assert.equal(custom.filter(entry => entry.data?.target?.kind === 'resource').length, batch.files.length);
  }
  return { main_deliveries: deliveries.length, active_entries: active.length, main_content_copies: 0,
    selected_graph_entries: custom.filter(entry => entry.customType === 'context-broker-selected-graph').length,
    short_resource_bindings: custom.filter(entry => entry.customType === 'context-broker-short-ref' && entry.data?.target?.kind === 'resource').length };
}

async function seedScalarResourceSession(info, base, sessions, output) {
  const sessionModule = join(info.piPackageRoot, 'dist/core/session-manager.js'), requirePi = createRequire(sessionModule);
  const { SessionManager } = await import(pathToFileURL(sessionModule).href);
  const { createJiti } = requirePi('jiti'), jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
  const bridgePath = join(info.packageRoot, 'src/session-short-ref-host.ts');
  const { createSessionShortRefHost } = await jiti.import(bridgePath);
  const manager = SessionManager.create(base, sessions), ctx = { sessionManager: manager, cwd: base, mode: 'rpc', hasUI: false };
  const refs = createSessionShortRefHost({ on() { throw new Error('No event loop is used for metadata-only session setup'); },
    appendEntry: (type, data) => manager.appendCustomEntry(type, data) });
  const selected = resourceScalarSelectedFixture(info.resourceBatch, join(base, 'unmaterialized-seed'));
  assert.equal(Object.hasOwn(selected, 'body'), false);
  const handles = info.resourceBatch.files.map(file => refs.resource(ctx, selected, file.ref));
  manager.appendMessage({ role: 'user', content: 'Controlled persisted resource-reference setup. Only owner and file metadata was seeded; no source body was read or delivered.', timestamp: Date.now() });
  const path = manager.getSessionFile(); assert.ok(path);
  const before = await readFile(path), seedEntries = await rows(path);
  const state = assertResourceScalarSession(seedEntries, { batch: info.resourceBatch, setupOnly: true });
  const reopened = SessionManager.open(path, sessions), restored = { ...ctx, sessionManager: reopened };
  assert.deepEqual(handles.map(ref => refs.resolve(restored, ref).canonicalRef), info.resourceBatch.refs);
  assert.equal(hash(await readFile(path)), hash(before), 'Read-only reopening preserves the real Pi seed JSONL');
  await assert.rejects(lstat(selected.entryManifest.root), { code: 'ENOENT' }, 'The seed must not create a prepared main or resource directory');
  await writeFile(join(output, 'seed-session.jsonl'), before, { mode: 0o600, flag: 'wx' });
  const evidence = { kind: 'installed_pi_session_manager_metadata_fixture', session_file: path, session_cwd: base,
    session_bytes: before.length, session_sha256: hash(before), session_module: sessionModule, session_module_sha256: hash(await readFile(sessionModule)),
    bridge: bridgePath, bridge_sha256: hash(await readFile(bridgePath)), handles, canonical_refs: info.resourceBatch.refs, ...state,
    source_io: 'No SDK, CLI, object read or materialization is called by seed setup; frozen fixture manifest metadata only',
    boundary: 'Proves persisted short-reference restoration in a new Pi process; does not claim first-time agent discovery or authorization from the seed' };
  await save(join(output, 'resource-scalar-seed.json'), evidence);
  return { path, handles, evidence };
}

export function assertResourceScalarCost(events, materialized, observations, { batch, requiredPid, expectDirect = true }) {
  const main = batch.snapshot.files.find(file => file.path === batch.snapshot.entrypoint);
  const objectReads = assertObjectReadEvidence(events, { selected: batch.files,
    forbidden: [...batch.unselected, ...(expectDirect ? [main] : [])], requiredPid });
  const allowed = new Set([...batch.files, ...(expectDirect ? [] : [main])].map(file => file.sha256));
  assert.ok(objectReads.object_sha256s.every(value => allowed.has(value)), 'Only explicitly read resources and the observed baseline main may be read');
  const pathMatches = (entry, file) => entry.path === file.path || entry.path.endsWith('/' + file.path);
  const resources = batch.files.map(file => {
    const matches = materialized.filter(entry => pathMatches(entry, file)); assert.ok(matches.length > 0, file.path + ': materialized resource is absent');
    for (const entry of matches) { assert.equal(entry.bytes, file.bytes); assert.equal(entry.sha256, file.sha256); }
    return { path: file.path, bytes: file.bytes, sha256: file.sha256, materialized_paths: matches.map(entry => entry.path) };
  });
  for (const file of batch.unselected) assert.equal(materialized.some(entry => pathMatches(entry, file) || entry.sha256 === file.sha256), false);
  // Discovery writes metadata-only SKILL.md stubs under indexes. They are not a
  // prepared main body; still report them, and never exempt an exact body hash.
  const metadataIndex = entry => /^scopes\/[a-f0-9]{64}\/indexes\/[^/]+\/[a-f0-9]{64}\//u.test(entry.path);
  const mainFiles = materialized.filter(entry => entry.sha256 === main.sha256 || pathMatches(entry, main) && !metadataIndex(entry));
  const metadataIndexFiles = materialized.filter(entry => metadataIndex(entry) && pathMatches(entry, main) && entry.sha256 !== main.sha256);
  const mainReads = events.filter(event => event.kind === 'object_read' && event.event === 'end' && event.object_sha256 === main.sha256);
  if (expectDirect) {
    assert.equal(observations.sdk_reads, 5); assert.equal(observations.sdk_consumes, 0); assert.equal(observations.sdk_resource_batches, 0);
    assert.equal(observations.sdk_body_calls, 5);
    assert.equal(observations.sdk_calls, observations.sdk_body_calls + observations.sdk_lists);
    assert.equal(mainFiles.length, 0); assert.equal(mainReads.length, 0);
  }
  return { expectation: expectDirect ? 'direct_scalar_verified' : 'baseline_observation_only',
    sdk_calls: observations.sdk_calls, sdk_body_calls: observations.sdk_body_calls, sdk_lists: observations.sdk_lists,
    sdk_reads: observations.sdk_reads, sdk_consumes: observations.sdk_consumes,
    sdk_resource_batches: observations.sdk_resource_batches, object_reads: objectReads, resources, metadata_index_files: metadataIndexFiles,
    main: { bytes: main.bytes, sha256: main.sha256, object_reads: mainReads.length,
      returned_object_bytes: mainReads.reduce((total, event) => total + (event.bytes ?? 0), 0), materialized_files: mainFiles },
    unselected_object_reads: 0, unselected_materialized_files: 0 };
}

/** Attribute actual object API reads to sequential SDK start/end intervals.
 * The observer has no RPC id; the exact nonoverlapping call order is the bridge. */
export function assertScalarReadObjectIntervals(events, { calls, requiredPid }) {
  const sdk = events.filter(event => event.kind === 'sdk' && event.operation === 'read');
  const objects = events.filter(event => event.kind === 'object_read');
  assert.ok(sdk.length > 0 && objects.length > 0);
  for (const event of [...sdk, ...objects]) {
    assert.equal(event.observer_pid, requiredPid); assert.ok(Number.isInteger(event.sequence));
    assert.ok(['start', 'end'].includes(event.event));
  }
  const host = events.filter(event => event.observer_pid === requiredPid);
  assert.ok(host.every((event, index) => Number.isInteger(event.sequence) && (index === 0 || event.sequence > host[index - 1].sequence)), 'Owned observer sequence must be strictly ordered');
  const starts = sdk.filter(event => event.event === 'start'), ends = sdk.filter(event => event.event === 'end');
  assert.equal(starts.length, calls.length); assert.equal(ends.length, starts.length);
  assert.equal(new Set(starts.map(event => event.id)).size, starts.length);
  assert.equal(new Set(ends.map(event => event.id)).size, ends.length);
  const objectStarts = objects.filter(event => event.event === 'start'), objectEnds = objects.filter(event => event.event === 'end');
  assert.equal(objectStarts.length, objectEnds.length);
  assert.equal(new Set(objectStarts.map(event => event.id)).size, objectStarts.length);
  assert.equal(new Set(objectEnds.map(event => event.id)).size, objectEnds.length);
  let previousEnd = -1, assigned = 0;
  const intervals = starts.map((start, index) => {
    const end = ends.find(event => event.id === start.id), call = calls[index];
    assert.ok(end); assert.equal(end.status, 'completed');
    assert.ok(start.sequence > previousEnd && end.sequence > start.sequence, 'Scalar SDK intervals must complete without overlap');
    previousEnd = end.sequence;
    const reads = objectStarts.filter(event => event.sequence > start.sequence && event.sequence < end.sequence).map(objectStart => {
      const objectEnd = objectEnds.find(event => event.id === objectStart.id); assert.ok(objectEnd);
      assert.ok(objectEnd.sequence > objectStart.sequence && objectEnd.sequence < end.sequence, 'An object result belongs to the same SDK interval as its start');
      for (const event of [objectStart, objectEnd]) {
        assert.equal(event.api, 'node:fs.readFile'); assert.equal(event.object_sha256, call.file.sha256);
      }
      assert.equal(objectEnd.code, null); assert.equal(objectEnd.bytes, call.file.bytes); assert.equal(objectEnd.content_sha256, call.file.sha256);
      return { object_id: objectStart.id, start_sequence: objectStart.sequence, end_sequence: objectEnd.sequence,
        api: objectStart.api, bytes: objectEnd.bytes, content_sha256: objectEnd.content_sha256 };
    });
    assert.ok(reads.length >= 1, 'Every SDK read must actually read and verify its requested object'); assigned += reads.length;
    return { tool_call_id: call.id, arguments: call.args, sdk_id: start.id, observer_pid: requiredPid,
      start_sequence: start.sequence, end_sequence: end.sequence, path: call.file.path, object_sha256: call.file.sha256,
      object_reads: reads.length, returned_object_bytes: reads.reduce((sum, read) => sum + read.bytes, 0), reads };
  });
  assert.equal(assigned, objectStarts.length, 'No object read may occur outside the measured SDK read intervals');
  return { mapping: 'Exact sequential RPC plan order and nonoverlapping SDK start/end intervals; no shared RPC id is emitted by the SDK observer',
    coverage: 'Owned Store callback readFile API with exact returned bytes and hashes; not physical disk I/O',
    sdk_reads: intervals.length, object_reads: assigned, intervals };
}

export async function resolveInstalledPiSerializer(piPackageRoot, piVersion) {
  const base = await realpath(piPackageRoot);
  const specifier = '@earendil-works/pi-ai/api/openai-completions';
  // An ESM evaluation rooted at the installed host respects import-only exports
  // and Node's actual nested or hoisted dependency resolution. It imports no code.
  const resolved = await runCommand(process.execPath, ['--input-type=module', '--eval',
    `process.stdout.write(JSON.stringify(import.meta.resolve(${JSON.stringify(specifier)})))`],
  { cwd: base, env: { PATH: process.env.PATH ?? '' }, timeoutMs: 30000 });
  const moduleUrl = new URL(JSON.parse(resolved.stdout));
  assert.equal(moduleUrl.protocol, 'file:', 'The installed serializer must resolve to a local file');
  const modulePath = await realpath(fileURLToPath(moduleUrl));
  let current = dirname(modulePath), packagePath, packageBytes, packageInfo;
  for (;;) {
    packagePath = join(current, 'package.json');
    try { packageBytes = await readFile(packagePath); packageInfo = JSON.parse(packageBytes.toString('utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.notEqual(current, dirname(current), 'Cannot identify the installed serializer owning package');
    current = dirname(current);
  }
  assert.equal(packageInfo.name, '@earendil-works/pi-ai', 'The resolved serializer must belong to pi-ai');
  assert.equal(packageInfo.version, piVersion, 'The resolved serializer must match the installed Pi version');
  return {
    resolution: { method: 'node-esm-import-exports', specifier, base, node: process.execPath },
    api_package: { name: packageInfo.name, version: packageInfo.version, path: packagePath, sha256: hash(packageBytes) },
    serializer: { path: modulePath, sha256: hash(await readFile(modulePath)) },
  };
}

async function replayPreparationHttp(context, info, output, kind = 'prepare', verify) {
  const identity = info.serializerIdentity, modulePath = identity.serializer.path;
  assert.equal(hash(await readFile(modulePath)), identity.serializer.sha256, 'The resolved serializer changed after preflight');
  assert.equal(hash(await readFile(identity.api_package.path)), identity.api_package.sha256, 'The serializer owning package changed after preflight');
  const { stream } = await import(pathToFileURL(modulePath).href);
  const requests = [], serverErrors = [];
  const server = createServer((request, response) => {
    const chunks = []; let bytes = 0;
    request.on('error', error => serverErrors.push(error.message));
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) { serverErrors.push('SERIALIZER_REQUEST_TOO_LARGE'); request.destroy(); }
      else chunks.push(chunk);
    });
    request.on('end', () => {
      requests.push({ method: request.method, path: request.url, body: Buffer.concat(chunks) });
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      const chunk = { id: 'sc05-local-serializer', object: 'chat.completion.chunk', created: 1, model: 'sc05-local-serializer' };
      response.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'Controlled serializer replay.' }, finish_reason: null }] }) + '\n\n');
      response.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) + '\n\n');
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let payload, responses = 0, final;
  const original = JSON.stringify(context);
  try {
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const model = { id: 'sc05-local-serializer', name: 'Controlled serializer replay', api: 'openai-completions', provider: 'openai',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 128 };
    final = await stream(model, context, { apiKey: 'fixture-no-secret', env: {}, cacheRetention: 'none', maxTokens: 32,
      signal: AbortSignal.timeout(10000),
      onPayload(value) { assert.equal(payload, undefined, 'One serializer request is expected'); payload = structuredClone(value); },
      onResponse(response) { assert.equal(response.status, 200); responses++; },
    }).result();
    assert.equal(final.stopReason, 'stop'); assert.equal(responses, 1);
    assert.deepEqual(serverErrors, []); assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].path, '/v1/chat/completions');
    const verification = (verify ?? (kind === 'prepare' ? assertPreparedHttpRequest : assertResourceHttpRequest))(payload, requests[0].body, context);
    assert.equal(JSON.stringify(context), original, 'Replaying the provider serializer must not mutate the captured transcript');
    await writeFile(join(output, kind + '-serializer-request.json'), requests[0].body, { mode: 0o600 });
    const result = { status: 'passed', boundary: 'Actual Pi capture replayed through installed pi-ai serializer and localhost HTTP; no real model or production API call',
      ...identity, ...verification,
      response: { status: 200, stop_reason: final.stopReason, source: 'controlled local SSE', usage: 'not_real_model_usage' } };
    await save(join(output, kind + '-serializer.json'), result);
    return result;
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function replayScenarioHttp(captures, frames, info, output, { preparation = false, expectedErrors = [] } = {}) {
  const directory = join(output, 'provider-requests'); await mkdir(directory, { mode: 0o700 });
  const sequence = assertProviderToolSequence(captures, frames, { expectedErrors }), requests = [];
  for (const [index, capture] of captures.entries()) {
    const name = String(index + 1).padStart(3, '0');
    const result = await replayPreparationHttp(capture.context, info, directory, name, assertProviderHttpRequest);
    const requestFile = join('provider-requests', name + '-serializer-request.json');
    const evidenceFile = join('provider-requests', name + '-serializer.json');
    await save(join(output, evidenceFile), { ...result, provider_request_id: capture.requestId, provider_capture_line: index + 1, request_file: requestFile });
    requests.push({ index: index + 1, provider_request_id: capture.requestId, provider_capture_line: index + 1,
      request_file: requestFile, evidence_file: evidenceFile, request_bytes: result.request_bytes, request_sha256: result.request_sha256,
      messages_json_bytes: result.messages_json_bytes, tools_json_bytes: result.tools_json_bytes, tools_sha256: result.tools_sha256,
      tool_content_bytes: result.tool_content_bytes, tool_calls: result.tool_calls.map(call => call.tool_call_id),
      tool_results: result.tool_results.map(message => message.tool_call_id),
      transcript_bytes: result.transcript_capture.bytes, host_details_bytes: result.transcript_capture.host_details_bytes });
    if (preparation && index === captures.length - 1) {
      // Preserve the existing final-request evidence without another replay or
      // another Pi scenario. Both names refer to the same observed HTTP bytes.
      const body = await readFile(join(output, requestFile));
      const verified = assertPreparedHttpRequest(JSON.parse(body.toString('utf8')), body, capture.context);
      await writeFile(join(output, 'prepare-serializer-request.json'), body, { mode: 0o600 });
      await save(join(output, 'prepare-serializer.json'), { ...result, ...verified, provider_request_id: capture.requestId, replayed_request_file: requestFile });
    }
  }
  const sum = key => requests.reduce((total, request) => total + request[key], 0);
  const result = { status: 'passed', boundary: 'Every actual Pi provider capture replayed once through installed pi-ai and localhost HTTP; captured host details are measured separately',
    ...sequence, request_bytes: sum('request_bytes'), request_bytes_total: sum('request_bytes'),
    messages_json_bytes_total: sum('messages_json_bytes'), tools_json_bytes_total: sum('tools_json_bytes'),
    tool_content_bytes_total: sum('tool_content_bytes'), transcript_bytes_total: sum('transcript_bytes'), host_details_bytes_total: sum('host_details_bytes'),
    all_provider_requests_serialized: requests.length === captures.length, requests,
    real_model_usage: 'not_measured', production_network: false };
  await save(join(output, 'provider-http.json'), result);
  return result;
}

function currentProviderTools(context) {
  // Pi 1.4 passes TranscriptContext: replay system tool deltas as pi-ai getCurrentTools does.
  const tools = new Map();
  for (const message of context.messages ?? []) {
    if (message.role !== 'system') continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return [...tools.values()];
}

export function assertResourceReadSchema(context) {
  const read = currentProviderTools(context).find(tool => tool.name === 'read');
  assert.ok(read, 'The actual provider must expose read');
  const schema = read.parameters;
  assert.equal(schema?.type, 'object'); assert.equal(schema.properties?.path?.type, 'string');
  const paths = schema.properties?.paths;
  assert.equal(paths?.type, 'array'); assert.equal(paths.items?.type, 'string');
  assert.equal(paths.minItems, 1); assert.equal(paths.maxItems, 16);
  assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length === 2, 'path and paths must be mutually exclusive public branches');
  const single = schema.oneOf.find(branch => branch.required?.includes('path'));
  const batch = schema.oneOf.find(branch => branch.required?.includes('paths'));
  assert.ok(single && batch); assert.deepEqual(single.not, { required: ['paths'] });
  for (const path of [schema.properties.path, single.properties?.path]) {
    assert.equal(path?.type, 'string'); assert.equal(typeof path.description, 'string');
    assert.match(path.description, /local.*file.*path/iu);
    assert.match(path.description, /skill:\/\//u); assert.match(path.description, /sr:/u);
    assert.match(path.description, /\bcopy\b[\s\S]*\b(?:verbatim|unchanged)\b/iu,
      'Outer and scalar path schemas must both explain copying the supplied reference');
  }
  assert.deepEqual(batch.required, ['paths']); assert.equal(batch.additionalProperties, false);
  assert.deepEqual(Object.keys(batch.properties), ['paths']); assert.deepEqual(batch.properties.paths, paths);
  return { tool: 'read', paths_supported: true, path_ref_guidance: true, scalar_branch_ref_guidance: true,
    path_and_paths_exclusive: true, batch_range_options: false,
    parameters: schema, parameters_sha256: hash(JSON.stringify(schema)) };
}

export function assertNativeGuidance(context, bundledCli) {
  const tools = currentProviderTools(context).map(tool => tool.name);
  for (const name of nativeTools) assert.ok(tools.includes(name), `Actual provider must expose ${name}`);
  const guidance = strings(context.messages).flatMap(text => [...text.matchAll(/<ntn-skills-guidance>[\s\S]*?<\/ntn-skills-guidance>/gu)].map(match => match[0]));
  assert.equal(guidance.length, 1, 'Actual provider must receive one current host guidance');
  assert.doesNotMatch(guidance[0], /<(?:cli(?:\s|>)|(?:list|read|files|resource-read)-args(?:\s|>))/u,
    'Complete native consumption must not also advertise legacy CLI argument templates');
  assert.ok(!guidance[0].includes(bundledCli), 'Host-local bundled CLI path must be requested explicitly');
  return { tools, guidance_bytes: Buffer.byteLength(guidance[0]), guidance_sha256: hash(guidance[0]), legacy_cli_templates: false };
}

export function assertScopedCommand(captures, frames, { command, database, sourceId = 'sdk-fixture' }) {
  assert.equal(captures.length, 2, 'One scope query must produce one tool round and two provider requests');
  assert.equal(command.length, 2);
  for (const value of command) assert.ok(isAbsolute(value), 'The default Node and bundled CLI must be absolute');
  for (const capture of captures) {
    assert.deepEqual(currentProviderTools(capture.context).map(tool => tool.name).sort(), [...scopedCommandTools].sort());
    assertNativeGuidance(capture.context, command[1]);
  }
  assert.ok(!strings(captures[0].context).some(text => text.includes(command[1])), 'First provider request must not contain the host-local CLI path');
  const starts = frames.filter(frame => frame.type === 'tool_execution_start');
  assert.equal(starts.length, 1, 'The controlled provider may query the scope only; no bash or body read');
  assert.equal(starts[0].toolName, 'notion_ctl');
  assert.equal(starts[0].toolCallId, 'sc05-source-command');
  assert.deepEqual(starts[0].args, { cli_source: sourceId });
  const ends = frames.filter(frame => frame.type === 'tool_execution_end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].toolCallId, starts[0].toolCallId);
  assert.equal(ends[0].isError, false);
  const delivered = toolResult(captures[1].context, starts[0].toolCallId);
  const expected = { kind: 'host_cli_scope', command, database, sourceId, executed: false };
  assert.deepEqual(parsedResult(delivered), expected);
  assert.deepEqual(delivered.details, expected);
  assert.equal(textContent(delivered.content), textContent(ends[0].result.content), 'The following provider must receive the complete exact tool receipt');
  assert.deepEqual(ends[0].result.details, expected);
  return { ...expected, actual_tools: [...scopedCommandTools], model_tool_calls: 1, model_bash_calls: 0,
    first_request_cli_path_absent: true, receipt_delivered_verbatim: true };
}

async function inventory(root, relative = '') {
  const output = [];
  for (const item of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = join(relative, item.name);
    assert.equal(item.isSymbolicLink(), false, 'Installed product/fixture must not route through a symlink');
    if (item.isDirectory()) output.push(...await inventory(root, path));
    else if (item.isFile()) { const bytes = await readFile(join(root, path)); output.push({ path, bytes: bytes.length, sha256: hash(bytes) }); }
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}
async function productInventory(root) {
  return [...await inventory(root, 'src'), ...await inventory(root, 'dist')].sort((a, b) => a.path.localeCompare(b.path));
}
async function archiveSessions(root, output) {
  const entries = await inventory(root), messages = [], sessionEntries = [];
  for (const entry of entries) {
    const original = await readFile(join(root, entry.path)), target = join(output, 'sessions', entry.path);
    assert.equal(hash(original), entry.sha256);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, original, { mode: 0o600, flag: 'wx' });
    assert.equal(hash(await readFile(target)), entry.sha256);
    if (entry.path.endsWith('.jsonl')) {
      for (const line of original.toString('utf8').split('\n').filter(Boolean)) {
        const entry = JSON.parse(line);
        sessionEntries.push(entry);
        if (entry.message) messages.push(entry.message);
      }
    }
  }
  await save(join(output, 'session-archives.json'), { files: entries, preserved: true });
  return { files: entries, messages, entries: sessionEntries };
}

export function validateLiveInput(value) {
  exactKeys(value, ['version', 'kind', 'host', 'artifact', 'source', 'oracle', 'sentinels'], 'Explicit live input');
  assert.equal(value.version, 1); assert.equal(value.kind, 'live_notion_sdk');
  const identity = (item, extra = []) => {
    exactKeys(item, ['path', 'sha256', ...extra], 'Frozen local identity');
    assert.ok(typeof item.path === 'string' && isAbsolute(item.path));
    assert.match(item.sha256, /^[a-f0-9]{64}$/u);
  };
  identity(value.host); identity(value.artifact);
  exactKeys(value.source, ['id', 'database'], 'One explicit live source');
  assert.match(value.source.id, /^[a-z][a-z0-9-]{0,63}$/u);
  assert.match(value.source.database, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  exactKeys(value.oracle, ['catalog', 'use', 'resource'], 'Observer-only source originals');
  identity(value.oracle.catalog); identity(value.oracle.use); identity(value.oracle.resource, ['logical_path']);
  const path = value.oracle.resource.logical_path;
  assert.ok(typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.split('/').some(part => ['', '.', '..'].includes(part)));
  assert.ok(Array.isArray(value.sentinels) && value.sentinels.length > 0);
  value.sentinels.forEach(item => identity(item));
  assert.equal(new Set(value.sentinels.map(item => item.path)).size, value.sentinels.length);
  return value;
}

async function frozenBytes(identity) {
  const bytes = await readFile(identity.path);
  assert.equal(hash(bytes), identity.sha256, identity.path + ': frozen input changed');
  return bytes;
}

async function inspectLiveInput(live, common) {
  assert.ok(process.env.NOTION_API_TOKEN, 'Live mode uses this machine’s existing NOTION_API_TOKEN');
  assert.ok(!process.env.NOTION_API_BASE_URL || process.env.NOTION_API_BASE_URL.replace(/\/$/u, '') === 'https://api.notion.com');
  await frozenBytes(live.host); await frozenBytes(live.artifact);
  assert.equal(await realpath(live.host.path), common.host.identity);
  for (const sentinel of live.sentinels) await frozenBytes(sentinel);
  // Same published-file closure used by the daily installation verifier. The
  // archive and installed files are read only; no source checkout is loaded.
  const members = execFileSync('tar', ['-tf', live.artifact.path], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    .split('\n').filter(path => path && !path.endsWith('/'));
  const published = [];
  for (const member of members) {
    assert.ok(member.startsWith('package/'));
    const relative = member.slice(8), path = resolve(common.packageRoot, relative);
    assert.ok(path.startsWith(common.packageRoot + '/') && (await realpath(path)).startsWith(common.packageRoot + '/'));
    const packed = execFileSync('tar', ['-xOf', live.artifact.path, member], { maxBuffer: 32 * 1024 * 1024 });
    const actual = await readFile(path); assert.deepEqual(actual, packed, relative + ': installed archive mismatch');
    published.push({ path: relative, bytes: actual.length, sha256: hash(actual) });
  }
  assert.ok(published.some(file => file.path === 'package.json') && published.some(file => file.path === 'dist/ntn-skills-runtime.json'));
  assert.equal(new Set(published.map(file => file.path)).size, published.length);
  const catalog = JSON.parse((await frozenBytes(live.oracle.catalog)).toString('utf8'));
  assert.equal(catalog.ok, true); assert.equal(catalog.coverage?.exhaustive, true);
  assert.deepEqual(catalog.coverage.failed_sources, []); assert.equal(catalog.has_more, false);
  assert.equal(catalog.count, catalog.records.length); assert.equal(catalog.total_count, catalog.records.length);
  assert.equal(catalog.view?.database_id, live.source.database); assert.equal(catalog.view_selection, 'first');
  const use = JSON.parse((await frozenBytes(live.oracle.use)).toString('utf8'));
  assert.equal(use.ok, true); assert.equal(use.status, 'ready'); assert.equal(use.preparation?.status, 'ready');
  assert.equal(use.preparation.purpose, 'use'); assert.equal(use.preparation.roots.length, 1);
  const snapshots = use.entries.map(entry => entry.manifest), bodies = new Map();
  assert.deepEqual(snapshots.map(snapshot => snapshot.record.id).sort(), [...use.preparation.required_closure].sort());
  for (const snapshot of snapshots) {
    assert.equal(snapshot.complete, true); assert.equal(snapshot.scope, catalog.scope);
    assert.equal(snapshot.record.locator.database_id, live.source.database);
    const node = use.preparation.nodes.find(node => node.id === snapshot.record.id);
    const file = snapshot.files.find(file => file.path === snapshot.entrypoint);
    assert.ok(node && file && typeof node.content === 'string' && node.content.length);
    assert.equal(hash(node.content), file.sha256); assert.equal(Buffer.byteLength(node.content), file.bytes);
    assert.equal(bodies.has(snapshot.record.name), false); bodies.set(snapshot.record.name, node.content);
  }
  const root = snapshots.find(snapshot => snapshot.record.id === use.preparation.roots[0].id);
  assert.ok(root && catalog.records.some(record => record.id === root.record.id));
  const files = root.files.filter(file => file.path === live.oracle.resource.logical_path); assert.equal(files.length, 1);
  const bytes = await frozenBytes(live.oracle.resource); assert.equal(bytes.length, files[0].bytes); assert.equal(hash(bytes), files[0].sha256);
  const binding = root.file_bindings.find(binding => binding.path === files[0].path);
  const ref = 'skill://' + encodeURIComponent(root.record.id) + '/' + files[0].path + '?snapshot=' + root.snapshot_id
    + (binding ? '&file_id=' + encodeURIComponent(binding.file_id) : '');
  const resource = { ...files[0], ref, ...(binding ? { file_id: binding.file_id } : {}),
    content: new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  const selected = new Set(snapshots.map(snapshot => snapshot.record.id));
  return { live, bodies, snapshots, root, resource, catalog, published,
    unselected: use.preparation.nodes.filter(node => !selected.has(node.id)).map(node => node.record),
    fixture: { scope: catalog.scope, snapshots, default_view: { id: catalog.view.id, records: catalog.records } } };
}

async function inspect(options) {
  assert.ok(options['--package'] && Boolean(options['--fixture']) !== Boolean(options['--live-input']), usage);
  const live = options['--live-input'] ? validateLiveInput(await json(options['--live-input'])) : undefined;
  const packageRoot = await realpath(options['--package']);
  const checkout = resolve(import.meta.dirname, '..');
  assert.ok(!packageRoot.startsWith(checkout + '/'), 'Use an independently installed Broker package');
  const manifest = await json(join(packageRoot, 'package.json'));
  assert.equal(manifest.name, 'pi-context-broker');
  const extension = join(packageRoot, manifest.pi.extensions[0]);
  assert.ok((await realpath(extension)).startsWith(packageRoot + '/'));
  const runtime = await json(join(packageRoot, 'dist/ntn-skills-runtime.json'));
  assert.equal(runtime.sdk_version, 1); assert.equal(runtime.consumer_contract_version, 1);
  for (const [file, field] of [['ntn-skills.mjs', 'cli_sha256'], ['ntn-skills-sdk.mjs', 'sdk_sha256']])
    assert.equal(hash(await readFile(join(packageRoot, 'dist', file))), runtime[field]);
  const host = await resolveHost(live?.host.path ?? 'pi');
  let current = dirname(host.identity), pi;
  for (;;) {
    try { const candidate = await json(join(current, 'package.json')); if (candidate.name === '@earendil-works/pi-coding-agent') { pi = candidate; break; } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.notEqual(current, dirname(current), 'Cannot identify installed Pi package'); current = dirname(current);
  }
  assertSupportedPiVersion(pi.version);
  const serializerIdentity = await resolveInstalledPiSerializer(current, pi.version);
  const common = { packageRoot, manifest, extension, runtime, host, pi, piPackageRoot: current, serializerIdentity };
  if (live) return { ...common, ...await inspectLiveInput(live, common) };
  const fixture = await json(options['--fixture']);
  assert.equal(fixture.version, 1); assert.equal(fixture.catalog, true);
  const fixtureEnv = await json(fixture.env);
  assert.equal(new URL(fixtureEnv.NOTION_API_BASE_URL).hostname, '127.0.0.1', 'Only controlled offline fixture origin is accepted');
  const stateRoot = resolve(fixture.cwd, fixtureEnv.NTN_SKILLS_HOME);
  assert.ok(stateRoot.startsWith(resolve(fixture.cwd) + '/'));
  const bodies = new Map();
  for (const snapshot of fixture.snapshots.slice(0, 4)) {
    const file = snapshot.files.find(file => file.path === snapshot.entrypoint);
    const bytes = await readFile(join(stateRoot, 'objects', file.sha256));
    assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
    bodies.set(snapshot.record.name, new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes));
  }
  let resourceBatch;
  if (fixture.resourceBatch) {
    assert.equal(runtime.resource_read_contract_version, 1, 'The installed Broker manifest must identify its selected SDK resource contract');
    const batch = fixture.resourceBatch;
    assert.equal(batch.source_cache, 'warm'); assert.equal(batch.files.length, 4);
    assert.deepEqual(batch.refs, batch.files.map(file => file.ref));
    const snapshot = fixture.snapshots.find(snapshot => snapshot.record.name === batch.name);
    assert.ok(snapshot); assert.equal(snapshot.scope, fixture.scope);
    const main = snapshot.files.find(file => file.path === snapshot.entrypoint);
    const mainBytes = await readFile(join(stateRoot, 'objects', main.sha256));
    assert.equal(mainBytes.length, main.bytes); assert.equal(hash(mainBytes), main.sha256);
    for (const file of [...batch.files, ...batch.unselected]) {
      const original = snapshot.files.find(item => item.path === file.path);
      assert.ok(original); assert.equal(original.bytes, file.bytes); assert.equal(original.sha256, file.sha256);
      assert.equal(snapshot.file_bindings.find(binding => binding.path === file.path)?.file_id, file.file_id);
      const bytes = await readFile(join(stateRoot, 'objects', file.sha256));
      assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
      assert.deepEqual(Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'), bytes);
    }
    resourceBatch = { ...batch, snapshot, main: new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(mainBytes) };
  }
  let entrypoint;
  if (fixture.entrypoint) {
    const sample = fixture.entrypoint, snapshot = fixture.snapshots.find(value => value.record.name === sample.name);
    assert.ok(snapshot); assert.equal(snapshot.scope, fixture.scope);
    const main = snapshot.files.find(file => file.path === snapshot.entrypoint);
    const bytes = await readFile(join(stateRoot, 'objects', main.sha256));
    assert.equal(bytes.length, main.bytes); assert.equal(hash(bytes), main.sha256);
    assert.deepEqual(sample.files.map(file => file.role).sort(), ['corrupt', 'missing', 'selected']);
    for (const file of sample.files) {
      const original = snapshot.files.find(value => value.path === file.path);
      assert.ok(original); assert.equal(original.bytes, file.bytes); assert.equal(original.sha256, file.sha256);
      assert.equal(snapshot.file_bindings.find(binding => binding.path === file.path)?.file_id, file.file_id);
      const bytes = await readFile(join(stateRoot, 'objects', file.sha256));
      assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
      if (file.role === 'selected') assert.deepEqual(Buffer.from(file.content, 'utf8'), bytes);
      else assert.ok(file.bytes >= 2 * 1024 * 1024);
    }
    entrypoint = { ...sample, snapshot, main_file: main, main: new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  }
  return { packageRoot, manifest, extension, runtime, host, pi, piPackageRoot: current, serializerIdentity, fixture, fixtureEnv, bodies, resourceBatch, entrypoint };
}

export function resourceRefsFromNative(message, paths) {
  if (message?.role !== 'toolResult' || message.toolName !== 'read' || message.isError
    || !Array.isArray(paths) || !paths.length || new Set(paths).size !== paths.length)
    throw new Error('CONTROLLED_RESOURCE_INSPECTION_INVALID');
  const text = typeof message.content === 'string' ? message.content : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  const footers = [...text.matchAll(/<skill-directory>\s*([\s\S]*?)\s*<\/skill-directory>/gu)];
  if (footers.length !== 1) throw new Error('CONTROLLED_RESOURCE_DIRECTORY_NOT_UNIQUE');
  const model = JSON.parse(footers[0][1]);
  if (!/^sr:S[A-Za-z0-9_-]{22}$/u.test(model.ref) || !Array.isArray(model.directory?.files)) throw new Error('CONTROLLED_RESOURCE_OWNER_NOT_UNIQUE');
  const refs = paths.map(path => {
    const files = model.directory.files.filter(file => file.path === path);
    if (files.length !== 1 || !/^sr:R[A-Za-z0-9_-]{22}$/u.test(files[0].ref)) throw new Error('CONTROLLED_RESOURCE_HANDLE_NOT_UNIQUE');
    return files[0].ref;
  });
  if (new Set(refs).size !== refs.length) throw new Error('CONTROLLED_RESOURCE_HANDLES_DUPLICATED');
  return refs;
}

function selectProviderCall(context) {
  const plan = JSON.parse(readFileSync(process.env.SC10_PI_TOOL_PLAN, 'utf8'));
  if (plan.mode === 'complete') return null;
  const find = id => [...context.messages].reverse().find(message => message.role === 'toolResult' && message.toolCallId === id);
  const text = value => typeof value === 'string' ? value : (value ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  const parsed = result => { if (result.isError) throw new Error('CONTROLLED_TOOL_FAILED'); return JSON.parse(text(result.content)); };
  const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
  if (plan.mode === 'live-consume') return selectLiveProviderCall(context, plan);
  if (plan.mode === 'lifecycle-probe') return find(plan.id) ? null : call(plan.id, 'read', { path: plan.ref });
  if (['resource-scalar', 'resource-scalar-short-refs'].includes(plan.mode)) return selectScalarProviderCall(context, plan.calls);
  if (plan.mode === 'scoped-command') {
    const scope = find('sc05-source-command');
    if (!scope) return call('sc05-source-command', 'notion_ctl', { cli_source: 'sdk-fixture' });
    parsed(scope);
    return null;
  }
  const search = find('sc10-search');
  if (!search) return call('sc10-search', 'notion_list', { query: '', source: 'sdk-fixture', limit: 20 });
  const directory = parsed(search);
  const selected = name => {
    const matches = directory.records.filter(record => record.name === name && record.source === 'sdk-fixture' && record.availability === 'available');
    if (matches.length !== 1) throw new Error('CONTROLLED_DIRECTORY_SELECTION_NOT_UNIQUE');
    return matches[0];
  };
  if (plan.mode === 'search') return null;
  if (['codemode-hidden', 'codemode-truncated'].includes(plan.mode)) {
    const code = find('sc26-code'), refs = ['a', 'b', 'c'].map(name => selected(name).ref);
    if (!code) return call('sc26-code', 'codemode', { code: [
      'try { await tools.notion_use(' + JSON.stringify({ ref: refs }) + '); throw new Error("UNEXPECTED_NESTED_USE"); } catch (error) { if (String(error).includes("UNEXPECTED_NESTED_USE")) throw error; text("TOP_LEVEL_USE_REQUIRED"); }',
      'const result = await tools.read(' + JSON.stringify({ path: selected('a').ref }) + ');',
      plan.mode === 'codemode-hidden' ? 'text("INTERNAL_READ_COMPLETED");' : 'text((typeof result === "string" ? result : JSON.stringify(result)).slice(0, 16));',
    ].join('\n') });
    if (code.isError) throw new Error('CONTROLLED_CODEMODE_FAILED');
    if (!find('sc26-use')) return call('sc26-use', 'notion_use', { ref: refs });
    return null;
  }
  if (plan.mode === 'native-repeat') return selectNativeRepeatCall(context, { mainRef: selected(plan.owner).ref, resourcePath: plan.resource_path });
  if (plan.mode === 'partial-entrypoint') {
    selected(plan.owner);
    const main = find('sc13-main');
    if (!main) return call('sc13-main', 'read', { path: plan.fixed_main_ref });
    if (main.isError) throw new Error('CONTROLLED_MAIN_READ_FAILED');
    const refs = resourceRefsFromNative(main, [plan.selected_path]);
    const resource = find('sc13-resource');
    if (!resource) return call('sc13-resource', 'read', { path: refs[0] });
    if (resource.isError) throw new Error('CONTROLLED_RESOURCE_READ_FAILED');
    return null;
  }
  if (['resource-batch', 'resource-batch-repeat', 'resource-batch-short-refs'].includes(plan.mode)) {
    selected(plan.owner);
    let refs = plan.refs;
    if (plan.short_refs) {
      const inspected = find('sc07-resource-inspect');
      if (!inspected) return call('sc07-resource-inspect', 'read', { path: selected(plan.owner).ref });
      refs = resourceRefsFromNative(inspected, plan.paths);
    }
    const id = plan.mode === 'resource-batch-repeat' ? 'sc07-resources-repeat' : 'sc07-resources';
    if (!find(id)) return call(id, 'read', { paths: refs });
    parsed(find(id));
    return null;
  }
  if (plan.mode === 'prepare' || plan.mode === 'prepare-repeat') {
    const id = plan.mode === 'prepare' ? 'sc10-prepare' : 'sc05-prepare-repeat';
    if (!find(id)) return call(id, 'notion_use', { ref: ['a', 'b', 'c'].map(name => selected(name).ref) });
    return null;
  }
  if (plan.mode !== 'native') throw new Error('CONTROLLED_PLAN_INVALID');
  const main = find('sc10-main');
  if (!main) return call('sc10-main', 'read', { path: selected('a').ref });
  if (main.isError) throw new Error('CONTROLLED_MAIN_READ_FAILED');
  const footer = /<skill-directory>\s*([\s\S]*?)\s*<\/skill-directory>/u.exec(text(main.content));
  if (!footer) throw new Error('CONTROLLED_RESOURCE_DIRECTORY_MISSING');
  const files = JSON.parse(footer[1]).directory.files;
  const resources = files.filter(file => file.path !== 'SKILL.md');
  if (resources.length !== 1) throw new Error('CONTROLLED_RESOURCE_SELECTION_NOT_UNIQUE');
  if (!find('sc10-resource')) return call('sc10-resource', 'read', { path: resources[0].ref });
  return null;
}

export function selectLiveProviderCall(context, plan) {
  const find = id => context.messages.find(message => message.role === 'toolResult' && message.toolCallId === id);
  const parsed = result => {
    if (result.isError) throw new Error('LIVE_TOOL_FAILED');
    const value = typeof result.content === 'string' ? result.content : result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    return JSON.parse(value);
  };
  const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
  const search = find('live-list');
  if (!search) return call('live-list', 'notion_list', { query: plan.owner, source: plan.source, limit: 20 });
  const directory = parsed(search);
  const records = directory.records.filter(record => record.name === plan.owner && record.source === plan.source && record.availability === 'available');
  if (records.length !== 1 || directory.has_more) throw new Error('LIVE_DIRECTORY_SELECTION_NOT_UNIQUE');
  const used = find('live-use');
  if (!used) return call('live-use', 'notion_use', { ref: records[0].ref });
  const roots = parsed(used).records.filter(record => record.name === plan.owner);
  if (roots.length !== 1) throw new Error('LIVE_ROOT_NOT_UNIQUE');
  const files = roots[0].directory.files.filter(file => file.path === plan.resource_path);
  if (files.length !== 1 || !/^sr:R[A-Za-z0-9_-]{22}$/u.test(files[0].ref)) throw new Error('LIVE_RESOURCE_NOT_UNIQUE');
  const read = find('live-resource');
  if (!read) return call('live-resource', 'read', { path: files[0].ref });
  if (read.isError) throw new Error('LIVE_RESOURCE_FAILED');
  return null;
}
async function holdLifecycleResponse(options, hook) {
  if (!JSON.parse(readFileSync(process.env.SC10_PI_TOOL_PLAN, 'utf8')).holdResponse) return false;
  hook('response_held');
  const aborted = () => hook('signal_aborted');
  options.signal.addEventListener('abort', aborted, { once: true });
  try {
    if (options.signal.aborted) aborted();
    while (JSON.parse(readFileSync(process.env.SC10_PI_TOOL_PLAN, 'utf8')).holdResponse)
      await new Promise(resolve => setTimeout(resolve, 25));
  } finally { options.signal.removeEventListener('abort', aborted); }
  return true;
}

async function provider(base) {
  const path = await writeFakeProvider(base);
  let source = await readFile(path, 'utf8');
  const replace = (before, after) => { assert.equal(source.split(before).length, 2, 'Provider fixture shape changed'); source = source.replace(before, after); };
  replace('import { appendFileSync }', 'import { appendFileSync, readFileSync }');
  replace('function stream(model, context) {', `${resourceRefsFromNative.toString()}\n${selectScalarProviderCall.toString()}\n${selectNativeRepeatCall.toString()}\n${selectLiveProviderCall.toString()}\n${selectProviderCall.toString()}\n${holdLifecycleResponse.toString()}\nlet nextRequest = 0;\nfunction stream(model, context) {\n  const requestId = String(process.pid) + ':' + String(++nextRequest);\n  const hook = phase => appendFileSync(process.env.SC10_PI_PROVIDER_HOOKS, JSON.stringify({ requestId, phase, pid: process.pid, aborted: Boolean(options?.signal?.aborted), monotonic_ns: process.hrtime.bigint().toString() }) + '\\n', { mode: 0o600 });`);
  replace('const payload = await options?.onPayload?.({ model: model.id, context }, model);', 'if (typeof options?.onPayload !== "function" || typeof options?.onResponse !== "function") throw new Error("PUBLIC_PROVIDER_HOOKS_REQUIRED");\n      hook("payload_start");\n      const payload = await options.onPayload({ model: model.id, context }, model);\n      hook("payload_end");');
  replace('JSON.stringify({ model: model.id, context })', 'JSON.stringify({ requestId, model: model.id, context })');
  replace('await options?.onResponse?.({ status: 200, headers: { "x-fixture": "deterministic" } }, model);', 'const held = await holdLifecycleResponse(options, hook);\n      await options.onResponse({ status: 200, headers: { "x-fixture": "deterministic" } }, model);\n      if (held) hook("response_callback");\n      hook("response_end");');
  replace('let sent = false;', `let sent = false;\n  let call, prepared = false;\n  async function prepareOutput() {\n    await request();\n    if (!prepared) { call = selectProviderCall(context); if (call) { output.content = [call]; output.stopReason = 'toolUse'; } prepared = true; }\n    return output;\n  }`);
  replace('result: async () => { await request(); return output; }', 'result: prepareOutput');
  replace('await request();\n      for (const event of events) yield event;', `await prepareOutput();\n      if (call) {\n        yield { type: 'start', partial: output };\n        yield { type: 'toolcall_start', contentIndex: 0, partial: output };\n        yield { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: output };\n        yield { type: 'done', reason: 'toolUse', message: output };\n      } else for (const event of events) yield event;`);
  await writeFile(path, source, { mode: 0o600 });
  return path;
}

/** Observe owned Store object reads without changing arguments, returned bytes,
 * callbacks or errors. Node FileSystem uses the callback API; every proof below
 * requires that actual API as a positive control, with exact source hashes. */
export function observeOwnedObjectReads({ fs, fsPromises, objects, record, hash }) {
  let next = 0, pending = 0, errors = 0, ended = false;
  const emit = fields => { try { record(fields); } catch { errors++; } };
  const start = (api, path) => {
    if (ended || typeof path !== 'string' || !path.startsWith(objects + '/')) return;
    const objectSha256 = path.slice(objects.length + 1), id = String(process.pid) + ':object:' + (++next);
    pending++;
    emit({ kind: 'object_read', event: 'start', id, api, object_sha256: objectSha256 });
    return (error, bytes) => {
      pending--;
      const value = bytes === undefined ? undefined : Buffer.from(bytes);
      emit({ kind: 'object_read', event: 'end', id, api, object_sha256: objectSha256,
        code: error?.code ?? null, bytes: value?.length ?? null, content_sha256: value ? hash(value) : null });
    };
  };
  const callbackRead = fs.readFile, syncRead = fs.readFileSync, promiseRead = fsPromises.readFile;
  fs.readFile = function(...args) {
    const end = start('node:fs.readFile', args[0]);
    if (!end) return callbackRead.apply(this, args);
    const callback = args.at(-1);
    args[args.length - 1] = function(error, bytes) { end(error, bytes); return callback.apply(this, arguments); };
    try { return callbackRead.apply(this, args); } catch (error) { end(error); throw error; }
  };
  fs.readFileSync = function(...args) {
    const end = start('node:fs.readFileSync', args[0]);
    try { const bytes = syncRead.apply(this, args); end?.(null, bytes); return bytes; }
    catch (error) { end?.(error); throw error; }
  };
  fsPromises.readFile = function(...args) {
    const end = start('node:fs/promises.readFile', args[0]);
    const result = promiseRead.apply(this, args);
    return !end ? result : result.then(bytes => { end(null, bytes); return bytes; }, error => { end(error); throw error; });
  };
  emit({ kind: 'object_observer_start', objects, coverage: ['node:fs.readFile', 'node:fs.readFileSync', 'node:fs/promises.readFile'] });
  return { finish() {
    if (!ended) {
      emit({ kind: 'object_observer_end', reads: next, pending_reads: pending, errors });
      ended = true; fs.readFile = callbackRead; fs.readFileSync = syncRead; fsPromises.readFile = promiseRead;
    }
    return { reads: next, pending_reads: pending, errors };
  } };
}

export function assertObjectReadEvidence(events, { selected, forbidden = [], requiredPid }) {
  const observers = events.filter(event => event.kind === 'object_observer_start');
  assert.ok(observers.length > 0, 'No observation is not evidence of zero object reads');
  if (requiredPid !== undefined) assert.equal(observers.filter(event => event.observer_pid === requiredPid).length, 1);
  for (const observer of observers) {
    assert.deepEqual(observer.coverage, ['node:fs.readFile', 'node:fs.readFileSync', 'node:fs/promises.readFile']);
    const ended = events.filter(event => event.kind === 'object_observer_end' && event.observer_pid === observer.observer_pid);
    assert.equal(ended.length, 1); assert.equal(ended[0].pending_reads, 0); assert.equal(ended[0].errors, 0);
  }
  const starts = events.filter(event => event.kind === 'object_read' && event.event === 'start');
  const ends = events.filter(event => event.kind === 'object_read' && event.event === 'end');
  assert.equal(starts.length, ends.length);
  for (const start of starts) {
    assert.match(start.object_sha256, /^[a-f0-9]{64}$/u);
    assert.ok(observers.some(observer => observer.observer_pid === start.observer_pid));
    const completed = ends.filter(end => end.id === start.id && end.observer_pid === start.observer_pid);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].api, start.api); assert.equal(completed[0].object_sha256, start.object_sha256);
  }
  for (const file of selected) assert.ok(ends.some(event => (requiredPid === undefined || event.observer_pid === requiredPid)
    && event.api === 'node:fs.readFile' && event.object_sha256 === file.sha256 && event.code === null
    && event.bytes === file.bytes && event.content_sha256 === file.sha256), file.path + ': actual Store.readBytes positive control');
  for (const file of forbidden) assert.equal(starts.filter(event => event.object_sha256 === file.sha256).length, 0, file.path + ': unselected source object was read');
  return { reads: starts.length, object_sha256s: [...new Set(starts.map(event => event.object_sha256))].sort(),
    positive_control_sha256s: selected.map(file => file.sha256), forbidden_object_reads: 0,
    coverage: 'owned Store.readBytes through Node readFile APIs; exact returned source bytes are positive controls' };
}

function observe() {
  const ledger = process.env.SC10_PI_OBSERVER;
  const cli = process.env.SC10_PI_BUNDLED_CLI;
  let sequence = 0, previous = null, nextChild = 0;
  const activeSdk = new Set(), activeChildren = new Set();
  const record = fields => {
    const value = { version: 1, observer_pid: process.pid, sequence: ++sequence, monotonic_ns: process.hrtime.bigint().toString(), previous_sha256: previous, ...fields };
    previous = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    appendFileSync(ledger, JSON.stringify({ ...value, sha256: previous }) + '\n', { mode: 0o600 });
  };
  record({ kind: 'observer_start', exec_path: process.execPath, parent_pid: process.ppid });
  const objectObserver = process.env.SC13_PI_OBJECT_ROOT ? observeOwnedObjectReads({ fs, fsPromises,
    objects: process.env.SC13_PI_OBJECT_ROOT, record, hash: bytes => createHash('sha256').update(bytes).digest('hex') }) : undefined;
  channel('context-broker.notion-sdk').subscribe(event => {
    if (event.event === 'start') activeSdk.add(event.id);
    if (event.event === 'end') activeSdk.delete(event.id);
    const { request_metrics, ...safe } = event;
    record({ kind: 'sdk', ...safe, request_metrics: request_metrics === undefined ? undefined : safeRequestMetrics(request_metrics) ?? null });
  });
  channel('context-broker.notion-sdk-result').subscribe(event => {
    if (event.operation === 'list') record({ kind: 'sdk_catalog', id: event.id, value: event.value });
    else if (process.env.SC08_PI_LIFECYCLE === '1') record({ kind: 'sdk_lifecycle_result', id: event.id, operation: event.operation, value: event.value });
  });
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function(...values) {
    const argv = Array.isArray(values[1]) ? values[1] : [];
    const id = `${process.pid}:${++nextChild}`;
    const operation = argv.find(value => ['list', 'views', 'ctl', 'prepare', 'read', 'files', 'export'].includes(value)) ?? null;
    const bundled = argv.includes(cli) || values[0] === cli;
    record({ kind: 'child_start', id, api: 'spawn', bundled, operation, executable: values[0], argv });
    const child = originalSpawn.apply(this, values);
    record({ kind: 'child_spawn', id, child_pid: child.pid ?? null });
    activeChildren.add(id);
    const chunks = []; let bytes = 0; const digest = createHash('sha256');
    child.stdout?.on('data', chunk => { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.length; digest.update(value); if (bytes <= 16 * 1024 * 1024) chunks.push(value); });
    child.once('error', error => record({ kind: 'child_error', id, code: error.code ?? 'UNKNOWN' }));
    child.once('close', (code, signal) => {
      activeChildren.delete(id);
      let metrics = null;
      try { if (bytes <= 16 * 1024 * 1024) metrics = safeRequestMetrics(JSON.parse(Buffer.concat(chunks).toString('utf8')).request_metrics) ?? null; } catch { /* Unknown is not zero. */ }
      record({ kind: 'child_close', id, child_pid: child.pid ?? null, code, signal, stdout_bytes: bytes, stdout_sha256: digest.digest('hex'), request_metrics: metrics });
    });
    return child;
  };
  for (const name of ['exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']) {
    const original = childProcess[name];
    childProcess[name] = function(...values) {
      record({ kind: 'alternate_child_api', api: name });
      return original.apply(this, values);
    };
  }
  syncBuiltinESMExports();
  process.once('exit', code => {
    const objects = objectObserver?.finish();
    record({ kind: 'observer_end', code, active_sdk: activeSdk.size, active_children: activeChildren.size,
      ...(objects ? { active_object_reads: objects.pending_reads, object_read_errors: objects.errors } : {}) });
  });
}
async function observer(path) {
  await writeFile(path, `import { isMainThread } from 'node:worker_threads';\nimport childProcess from 'node:child_process';\nimport { createHash } from 'node:crypto';\nimport { channel } from 'node:diagnostics_channel';\nimport fs, { appendFileSync } from 'node:fs';\nimport fsPromises from 'node:fs/promises';\nimport { syncBuiltinESMExports } from 'node:module';\n${safeRequestMetrics.toString()}\n${observeOwnedObjectReads.toString()}\nif (isMainThread) (${observe.toString()})();\n`, { mode: 0o600 });
}

export function sourceFinality(events, hostPid, { hostClosed = false } = {}) {
  const pending = [];
  const starts = events.filter(event => event.kind === 'observer_start');
  if (starts.filter(event => event.observer_pid === hostPid).length !== 1) pending.push({ kind: 'host_observer_start', pid: hostPid });
  for (const start of events.filter(event => event.kind === 'child_start')) {
    const spawned = events.filter(event => event.kind === 'child_spawn' && event.id === start.id && event.observer_pid === start.observer_pid);
    const pid = spawned[0]?.child_pid;
    if (spawned.length !== 1 || !Number.isInteger(pid) || pid <= 0) { pending.push({ kind: 'child_identity', id: start.id }); continue; }
    const closed = events.filter(event => event.kind === 'child_close' && event.id === start.id && event.child_pid === pid && event.observer_pid === start.observer_pid);
    if (closed.length !== 1) pending.push({ kind: 'child_close', id: start.id, pid });
    if (starts.filter(event => event.observer_pid === pid && event.parent_pid === start.observer_pid).length !== 1) pending.push({ kind: 'child_observer_start', id: start.id, pid });
  }
  for (const start of starts) {
    if (start.observer_pid !== hostPid && !events.some(event => event.kind === 'child_spawn' && event.child_pid === start.observer_pid && event.observer_pid === start.parent_pid))
      pending.push({ kind: 'unbound_observer', pid: start.observer_pid });
    if (!hostClosed && start.observer_pid === hostPid) continue;
    const ended = events.filter(event => event.kind === 'observer_end' && event.observer_pid === start.observer_pid);
    if (ended.length !== 1 || ended[0].active_sdk !== 0 || ended[0].active_children !== 0
      || (ended[0].active_object_reads ?? 0) !== 0 || (ended[0].object_read_errors ?? 0) !== 0) pending.push({ kind: 'observer_end', pid: start.observer_pid });
  }
  for (const start of events.filter(event => event.kind === 'sdk' && event.event === 'start')) {
    if (events.filter(event => event.kind === 'sdk' && event.event === 'end' && event.id === start.id && event.observer_pid === start.observer_pid).length !== 1)
      pending.push({ kind: 'sdk_end', id: start.id, pid: start.observer_pid });
  }
  return { complete: pending.length === 0, host_pid: hostPid, host_closed: hostClosed,
    observer_processes: starts.length, source_children: events.filter(event => event.kind === 'child_start').length, pending };
}

async function waitForSourceFinality(path, hostPid, options = {}) {
  const timeoutMs = 10000, deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1000000n;
  let last;
  for (;;) {
    try { last = sourceFinality(await rows(path), hostPid, options); }
    catch (error) { last = { complete: false, pending: [{ kind: 'observer_read', error: String(error.message) }] }; }
    if (last.complete) return { ...last, timeout_ms: timeoutMs, deadline_exceeded: false };
    if (process.hrtime.bigint() >= deadline) return { ...last, timeout_ms: timeoutMs, deadline_exceeded: true };
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export function assertCatalogCancellationBoundary(start, end, lifecycle) {
  assert.equal(start.operation, 'list', 'Only catalogue cancellation can be reconciled at a native session boundary');
  assert.equal(end.operation, start.operation); assert.equal(end.observer_pid, start.observer_pid);
  const boundary = lifecycle.find(event => ['session_tree', 'session_shutdown'].includes(event.type)
    && event.pid === start.observer_pid && typeof event.monotonic_ns === 'string' && /^\d+$/.test(event.monotonic_ns)
    && BigInt(event.monotonic_ns) >= BigInt(start.monotonic_ns) && BigInt(event.monotonic_ns) <= BigInt(end.monotonic_ns));
  assert.ok(boundary, 'Cancelled catalogue must match an actual session boundary inside its exact SDK interval');
  return boundary;
}

export function reconcile(events, lifecycle, { bodyTransportRequired = true, sourceMode = 'offline', catalogLifecycle = [] } = {}) {
  assert.ok(['offline', 'live'].includes(sourceMode));
  assert.ok(events.length > 0, 'Empty observer ledger cannot establish zero work');
  const chains = new Map();
  for (const item of events) {
    const { sha256, ...payload } = item;
    const before = chains.get(item.observer_pid);
    assert.equal(item.sequence, (before?.sequence ?? 0) + 1);
    assert.equal(item.previous_sha256, before?.sha256 ?? null);
    assert.equal(hash(JSON.stringify(payload)), sha256);
    assert.ok(!before || BigInt(item.monotonic_ns) >= BigInt(before.monotonic_ns));
    if (!before) assert.equal(item.kind, 'observer_start');
    chains.set(item.observer_pid, item);
  }
  for (const last of chains.values()) { assert.equal(last.kind, 'observer_end'); assert.equal(last.active_sdk, 0); assert.equal(last.active_children, 0);
    assert.equal(last.active_object_reads ?? 0, 0); assert.equal(last.object_read_errors ?? 0, 0); }
  assert.equal(lifecycle.filter(event => event.event === 'spawn').length, 1);
  assert.equal(lifecycle.filter(event => event.event === 'close').length, 1);
  assert.equal(lifecycle.at(-1).code, 0); assert.equal(lifecycle.at(-1).signal, null);
  assert.ok(chains.has(lifecycle[0].pid), 'Owned Pi must have an observer chain');
  const starts = events.filter(event => event.kind === 'child_start');
  for (const start of starts) assert.equal(events.filter(event => event.kind === 'child_close' && event.id === start.id).length, 1);
  assert.equal(events.filter(event => event.kind === 'alternate_child_api').length, 0, 'Unexpected child APIs require explicit accounting');
  assert.equal(starts.length, 0, 'Default bundled SDK directory and body consumption must not spawn CLI children');
  const sdk = events.filter(event => event.kind === 'sdk' && event.event === 'start');
  assert.ok(sdk.every(event => ['list', 'consume', 'read', 'read-resources'].includes(event.operation)), 'Unknown SDK operations require explicit accounting');
  const catalog = sdk.filter(event => event.operation === 'list'), bodies = sdk.filter(event => event.operation !== 'list');
  if (bodyTransportRequired) {
    assert.ok(catalog.length > 0, 'Actual default catalog SDK must be observed');
    assert.ok(bodies.length > 0, 'An empty body SDK observation cannot establish default transport');
  } else assert.equal(bodies.length, 0, 'A host-local command metadata query must not consume source bodies');
  let http = 0;
  const cancelledCatalogs = [];
  for (const start of sdk) {
    const ends = events.filter(event => event.kind === 'sdk' && event.event === 'end' && event.id === start.id);
    assert.equal(ends.length, 1);
    const end = ends[0];
    assert.equal(end.observer_pid, start.observer_pid); assert.equal(end.operation, start.operation);
    let boundary;
    if (end.status === 'cancelled') {
      boundary = assertCatalogCancellationBoundary(start, end, catalogLifecycle);
    } else assert.equal(end.status, 'completed');
    assert.equal(end.sdk_started, true); assert.equal(end.metrics_observed, true);
    assert.equal(end.request_metrics?.complete, true, 'Every SDK terminal, including cancellation, requires complete metrics');
    assert.ok(Array.isArray(end.request_metrics.trace), 'Complete metrics must retain the actual HTTP trace');
    const attempts = end.request_metrics.trace.filter(event => event.event === 'attempt');
    assert.equal(attempts.length, end.request_metrics.total_requests, 'Every SDK terminal must account for every actual HTTP attempt');
    assert.equal(new Set(attempts.map(event => event.attempt)).size, attempts.length);
    assert.ok(attempts.every(event => Number.isSafeInteger(event.attempt) && event.attempt > 0 && event.attempt <= attempts.length));
    http += end.request_metrics.total_requests;
    if (boundary) cancelledCatalogs.push({ id: start.id, pid: start.observer_pid, native_event: boundary.type,
      native_monotonic_ns: boundary.monotonic_ns, http_attempts: attempts.length });
  }
  const completedCatalogs = catalog.length - cancelledCatalogs.length;
  if (catalog.length) assert.ok(completedCatalogs > 0, 'Cancelled catalogues do not establish successful default discovery');
  if (sourceMode === 'offline') assert.equal(http, 0, 'The controlled SDK source must stay offline');
  const cliCloses = events.filter(event => event.kind === 'child_close');
  return { sdk_calls: sdk.length, sdk_body_calls: bodies.length, sdk_lists: catalog.length,
    sdk_completed_lists: completedCatalogs, sdk_cancelled_lists: cancelledCatalogs.length, cancelled_catalogs: cancelledCatalogs,
    sdk_consumes: sdk.filter(event => event.operation === 'consume').length,
    sdk_reads: sdk.filter(event => event.operation === 'read').length, sdk_http: http,
    sdk_resource_batches: sdk.filter(event => event.operation === 'read-resources').length,
    cli_catalog_children: starts.filter(event => event.bundled && event.operation === 'list').length,
    cli_prepare_read_export_children: 0, cli_http: cliCloses.every(event => event.request_metrics?.complete) ? cliCloses.reduce((total, event) => total + event.request_metrics.total_requests, 0) : null,
    observer_processes: chains.size, source_children_closed: starts.length, eof_closed: true,
    default_catalog_transport: completedCatalogs ? 'verified_sdk' : 'not_exercised',
    default_body_transport: bodyTransportRequired ? 'verified_sdk' : 'not_applicable_metadata_query' };
}

// Fixture setup only. Preserve the actual signed payload and use the existing
// disposable-cache retirement flag in this owned clone, never a fake receipt.
function fixtureCurrentReceipt(database, key, retirePayload) {
  const db = new DatabaseSync(database, { readOnly: retirePayload === undefined });
  try {
    const query = db.prepare('SELECT category,payload,retired FROM shared_local_records WHERE key=?');
    let row = query.get(key);
    assert.ok(row); assert.equal(row.category, 'cache');
    if (retirePayload !== undefined) {
      assert.equal(row.retired, 0); assert.equal(row.payload, retirePayload);
      const update = db.prepare("UPDATE shared_local_records SET retired=1 WHERE key=? AND category='cache' AND retired=0 AND payload=?").run(key, retirePayload);
      assert.equal(update.changes, 1);
      row = query.get(key); assert.equal(row.retired, 1); assert.equal(row.payload, retirePayload);
    }
    return { key, ...row, receipt: JSON.parse(row.payload) };
  } finally { db.close(); }
}

async function preparePartialEntrypoint(info, localSource, fixtureEnv, output) {
  const sample = info.entrypoint;
  assert.ok(sample, 'Generate the complete entrypoint fixture with the selected CLI package');
  const state = fixtureEnv.NTN_SKILLS_HOME, objects = join(state, 'objects');
  const retained = join(output, 'partial-object-originals'); await mkdir(retained, { mode: 0o700 });
  const receiptKey = 'cache/shared-current-tree-validation/' + sample.snapshot.scope + '/' + sample.snapshot.snapshot_id + '.json';
  const database = join(state, 'state.sqlite'), publishedReceipt = fixtureCurrentReceipt(database, receiptKey);
  assert.equal(publishedReceipt.retired, 0);
  assert.equal(publishedReceipt.receipt.scope, sample.snapshot.scope); assert.equal(publishedReceipt.receipt.snapshot_id, sample.snapshot.snapshot_id);
  await save(join(retained, 'published-current-receipt.json'), publishedReceipt);
  const retirement = fixtureCurrentReceipt(database, receiptKey, publishedReceipt.payload);
  await save(join(retained, 'current-receipt-retirement.json'), retirement);
  const events = [], metrics = [];
  const record = fields => {
    const row = { observer_pid: process.pid, sequence: events.length + 1, ...fields };
    events.push(row); fs.appendFileSync(join(output, 'warm-object-reads.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
  };
  const observation = observeOwnedObjectReads({ fs, fsPromises, objects, record, hash });
  syncBuiltinESMExports();
  let prepared;
  try {
    const sdk = await import(pathToFileURL(join(info.packageRoot, 'dist/ntn-skills-sdk.mjs')).href);
    prepared = await sdk.consume({ version: 1, targets: [sample.current_ref], purpose: 'inspect', freshness: { policy: 'offline' } },
      { cwd: localSource, env: fixtureEnv, metrics: true, onRequestMetrics: value => metrics.push(safeRequestMetrics(value)) });
  } finally { observation.finish(); syncBuiltinESMExports(); }
  const reads = assertObjectReadEvidence(events, { selected: sample.snapshot.files, requiredPid: process.pid });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared)); assert.equal(prepared.entries.length, 1);
  const entry = prepared.entries[0];
  assert.equal(entry.manifest.complete, true); assert.equal(entry.manifest.snapshot_id, sample.snapshot.snapshot_id);
  assert.deepEqual(entry.manifest.files, sample.snapshot.files);
  assert.deepEqual(entry.materialization, { status: 'entry_ready', paths: [sample.snapshot.entrypoint] });
  assert.equal(entry.source_body.sha256, sample.main_file.sha256); assert.equal(entry.source_body.bytes, sample.main_file.bytes);
  const revalidated = fixtureCurrentReceipt(database, receiptKey);
  assert.equal(revalidated.retired, 0); assert.equal(revalidated.payload, publishedReceipt.payload);
  const receipt = revalidated.receipt;
  assert.equal(receipt.scope, sample.snapshot.scope); assert.equal(receipt.snapshot_id, sample.snapshot.snapshot_id);
  assert.equal(receipt.version_id, sample.snapshot.version_id);
  assert.equal(metrics.length, 1); assert.equal(metrics[0]?.complete, true); assert.equal(metrics[0]?.total_requests, 0);
  const warm = { method: 'installed public SDK current consume after preserving the publisher receipt; real complete validation regenerates it',
    source_state: 'controlled warm fixture; not cold source evidence', sdk_sha256: info.runtime.sdk_sha256,
    result: prepared, receipt, receipt_storage: 'SQLite shared_local_records', retirement_preserved_payload: true,
    object_reads: reads, request_metrics: metrics[0] };
  await save(join(output, 'warm-current-validation.json'), warm);
  const missing = sample.files.find(file => file.role === 'missing'), corrupt = sample.files.find(file => file.role === 'corrupt');
  await rename(join(objects, missing.sha256), join(retained, 'missing-source.bin'));
  await rename(join(objects, corrupt.sha256), join(retained, 'corrupt-source.bin'));
  const bad = Buffer.alloc(corrupt.bytes, 0xff); assert.notEqual(hash(bad), corrupt.sha256);
  await writeFile(join(objects, corrupt.sha256), bad, { mode: 0o600, flag: 'wx' });
  const partial = { objects, missing_sha256: missing.sha256, corrupt_sha256: corrupt.sha256,
    corrupt_actual_sha256: hash(bad), corrupt_bytes: bad.length };
  await save(join(output, 'partial-state-before.json'), partial);
  return { warm, partial };
}

async function assertPartialObjectState(partial) {
  await assert.rejects(lstat(join(partial.objects, partial.missing_sha256)), { code: 'ENOENT' });
  const bytes = await readFile(join(partial.objects, partial.corrupt_sha256));
  assert.equal(bytes.length, partial.corrupt_bytes); assert.equal(hash(bytes), partial.corrupt_actual_sha256);
  return { missing_sha256: partial.missing_sha256, corrupt_expected_sha256: partial.corrupt_sha256,
    corrupt_actual_sha256: hash(bytes), corrupt_bytes: bytes.length, unchanged: true };
}

/** The input is the native SessionManager's current branch, never getEntries()
 * over every branch. Compare persisted authority against independent fixture
 * pins; provider body delivery is checked separately at each actual request. */
export function assertLifecycleBranch(entries, { snapshots, bodies, selected, preparedNames = [] }) {
  assert.ok(Array.isArray(entries));
  const active = entries.filter(entry => entry.type === 'custom' && entry.customType === 'context-broker-active-sources');
  const graphs = entries.filter(entry => entry.type === 'custom' && entry.customType === 'context-broker-selected-graph');
  const refs = entries.filter(entry => entry.type === 'custom' && entry.customType === 'context-broker-short-ref'
    && entry.data?.target?.kind === 'selected');
  const prepared = refs.map(entry => {
    const target = entry.data.target, snapshot = snapshots.find(item => item.record.id === target.identity.id && item.scope === target.identity.scope);
    assert.ok(snapshot && bodies.has(snapshot.record.name), 'Prepared short reference must belong to the original source scope');
    assert.equal(target.snapshot_id, snapshot.snapshot_id); assert.equal(target.version_id, snapshot.version_id);
    assert.equal(target.body_sha256, hash(bodies.get(snapshot.record.name))); assert.match(entry.data.ref, /^sr:S[A-Za-z0-9_-]{22}$/u);
    return { name: snapshot.record.name, ref: entry.data.ref, snapshot_id: target.snapshot_id, version_id: target.version_id };
  });
  if (!selected) {
    assert.equal(active.length, 0, 'An unselected native branch cannot inherit active sources from another branch');
    assert.equal(graphs.length, 0, 'An unselected native branch cannot inherit another branch graph');
    assert.deepEqual([...new Set(prepared.map(item => item.name))].sort(), [...preparedNames].sort(),
      'Only explicitly prepared, unactivated source handles may remain after cancellation');
    return { active_entries: 0, selected_graph_entries: 0, selected_handles: new Set(prepared.map(item => item.ref)).size,
      prepared_unactivated: prepared, pins: [] };
  }
  assert.ok(active.length > 0, 'Complete provider delivery must persist an active entry on this branch');
  const sources = active.at(-1).data.sources;
  assert.equal(sources.length, bodies.size);
  assert.equal(new Set(sources.map(source => source.record.id)).size, sources.length);
  const pins = sources.map(source => {
    const snapshot = snapshots.find(item => item.record.id === source.record.id && item.scope === source.record.sourceScope);
    assert.ok(snapshot && bodies.has(snapshot.record.name), 'Active source must belong to the original source scope');
    const body = bodies.get(snapshot.record.name), binding = source.record.preparationBinding;
    assert.equal(source.record.source, 'notion'); assert.equal(source.snapshotId, snapshot.snapshot_id);
    assert.equal(source.record.snapshotId, snapshot.snapshot_id); assert.equal(source.record.versionId, snapshot.version_id);
    assert.equal(source.bodySha256, hash(body)); assert.equal(source.bytes, Buffer.byteLength(body));
    assert.equal(binding.scope, snapshot.scope); assert.equal(binding.record.id, snapshot.record.id);
    assert.equal(binding.snapshot_id, snapshot.snapshot_id); assert.equal(binding.version_id, snapshot.version_id);
    assert.equal(binding.body_sha256, hash(body)); assert.equal(new URL(binding.ref).searchParams.get('snapshot'), snapshot.snapshot_id);
    const matching = refs.filter(entry => entry.data.target.identity.id === snapshot.record.id);
    assert.ok(matching.length > 0, 'The active selected source needs a current-branch short handle');
    for (const entry of matching) {
      const target = entry.data.target;
      assert.equal(target.identity.scope, snapshot.scope); assert.equal(target.snapshot_id, snapshot.snapshot_id);
      assert.equal(target.version_id, snapshot.version_id); assert.equal(target.body_sha256, hash(body));
      assert.match(entry.data.ref, /^sr:S[A-Za-z0-9_-]{22}$/u);
    }
    return { name: snapshot.record.name, scope: snapshot.scope, id: snapshot.record.id, snapshot_id: snapshot.snapshot_id,
      version_id: snapshot.version_id, body_sha256: hash(body), ref: matching.at(-1).data.ref };
  });
  const locks = active.at(-1).data.graphs;
  assert.equal(locks.length, 1); assert.equal(locks[0].scope, snapshots[0].scope);
  assert.deepEqual(locks[0].roots, ['a', 'b', 'c'].map(name => snapshots.find(item => item.record.name === name).record.id));
  assert.equal(locks[0].bindings.length, pins.length);
  for (const binding of locks[0].bindings) {
    const pin = pins.find(item => item.id === binding.record.id && item.scope === binding.scope);
    assert.ok(pin); assert.equal(binding.snapshot_id, pin.snapshot_id); assert.equal(binding.version_id, pin.version_id);
    assert.equal(binding.body_sha256, pin.body_sha256);
  }
  return { active_entries: active.length, selected_graph_entries: graphs.length,
    selected_handles: new Set(refs.map(entry => entry.data.ref)).size, pins };
}

export function assertLifecycleRestore(value, { snapshots, bodies }) {
  assert.equal(value.status, 'ready'); assert.equal(value.preparation.purpose, 'inspect');
  assert.deepEqual(value.preparation.required_closure, [], 'Recovery inspects the persisted fixed vector without traversing a new Requires closure');
  assert.equal(value.delivery.status, 'not_observed'); assert.equal(value.activation.status, 'not_evaluated');
  assert.equal(value.entries.length, bodies.size); assert.equal(value.preparation.roots.length, bodies.size);
  const ids = new Set();
  const pins = value.entries.map(entry => {
    const manifest = entry.manifest, snapshot = snapshots.find(item => item.record.id === manifest.record.id && item.scope === manifest.scope);
    assert.ok(snapshot && bodies.has(snapshot.record.name)); assert.equal(ids.has(manifest.record.id), false); ids.add(manifest.record.id);
    assert.equal(manifest.snapshot_id, snapshot.snapshot_id); assert.equal(manifest.version_id, snapshot.version_id);
    const root = value.preparation.roots.filter(item => item.id === snapshot.record.id);
    assert.equal(root.length, 1); assert.equal(root[0].readiness, 'ready');
    assert.equal(new URL(root[0].target).searchParams.get('snapshot'), snapshot.snapshot_id, 'The SDK recovery input must already be fixed');
    assert.equal(new URL(root[0].ref).searchParams.get('snapshot'), snapshot.snapshot_id);
    assert.equal(entry.source_body.sha256, hash(bodies.get(snapshot.record.name)));
    assert.equal(entry.source_body.bytes, Buffer.byteLength(bodies.get(snapshot.record.name))); assert.equal(entry.source_body.has_more, false);
    return { name: snapshot.record.name, id: snapshot.record.id, scope: snapshot.scope, target: root[0].target,
      snapshot_id: manifest.snapshot_id, version_id: manifest.version_id, source_body: entry.source_body };
  });
  return { purpose: 'inspect', pins, required_closure_expanded: false, delivery_claimed_by_sdk: false,
    boundary: 'Actual bundled SDK result; subsequent provider bytes and response establish delivery separately' };
}

function lifecycleControl(api) {
  const control = () => JSON.parse(readFileSync(process.env.SC08_PI_CONTROL, 'utf8'));
  const record = (type, fields = {}) => appendFileSync(process.env.SC08_PI_NATIVE_EVENTS,
    JSON.stringify({ type, pid: process.pid, monotonic_ns: process.hrtime.bigint().toString(), ...fields }) + '\n', { mode: 0o600 });
  for (const name of ['session_start', 'session_shutdown', 'session_before_fork', 'session_fork', 'session_before_tree', 'session_tree', 'session_compact'])
    api.on(name, (event, ctx) => record(name, { reason: event.reason ?? null, position: event.position ?? null,
      target_id: event.entryId ?? event.preparation?.targetId ?? null, leaf_id: ctx.sessionManager.getLeafId(),
      session_file: ctx.sessionManager.getSessionFile(), from_extension: event.fromExtension ?? null }));
  api.on('session_before_compact', event => {
    const plan = control();
    if (plan.action !== 'compact') return;
    if (!event.branchEntries.some(entry => entry.id === plan.firstKeptEntryId)) throw new Error('SC08_COMPACT_KEEP_ENTRY_ABSENT');
    record('controlled_compaction', { first_kept_entry_id: plan.firstKeptEntryId, tokens_before: event.preparation.tokensBefore });
    return { compaction: { summary: 'Controlled lifecycle summary. Continue the ordinary task; recover any active fixed Skill instructions from their persisted bindings.',
      firstKeptEntryId: plan.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
      details: { verification: 'controlled summary; real Pi compaction lifecycle, no model summary quality claim' } } };
  });
  api.registerCommand('sc08-fixture', { description: 'Owned verification fixture: inspect or navigate the actual Pi session branch.',
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const plan = control();
      if (plan.action === 'rewind') {
        const result = await ctx.navigateTree(plan.entryId, { summarize: false });
        if (result.cancelled) throw new Error('SC08_TREE_CANCELLED');
      } else if (plan.action !== 'snapshot') throw new Error('SC08_CONTROL_ACTION_INVALID');
      const snapshot = { session_file: ctx.sessionManager.getSessionFile(), leaf_id: ctx.sessionManager.getLeafId(),
        branch: ctx.sessionManager.getBranch() };
      writeFileSync(plan.output, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      record('branch_snapshot', { action: plan.action, output: plan.output, leaf_id: snapshot.leaf_id, session_file: snapshot.session_file });
    } });
}

async function runSdkLifecycle({ info, base, output, sessions, providerFile, hookFile, ledger, toolPlan, env, argv }) {
  const controlFile = join(base, 'lifecycle-control.json'), nativeEvents = join(output, 'native-session-events.jsonl');
  const extension = join(base, 'lifecycle-control.mjs'), steps = [], processes = [], frames = [];
  const compactionSettings = { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 };
  await save(join(env.PI_CODING_AGENT_DIR, 'settings.json'), { compaction: compactionSettings });
  await save(controlFile, { action: 'snapshot', output: join(output, 'initial-unused.json') });
  await writeFile(extension, "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';\nexport default " + lifecycleControl.toString() + '\n', { mode: 0o600 });
  const args = [...argv, '-e', extension], lifecycleEnv = { ...env, SC08_PI_LIFECYCLE: '1', SC08_PI_CONTROL: controlFile, SC08_PI_NATIVE_EVENTS: nativeEvents };
  await save(join(output, 'lifecycle-launch.json'), { host: info.host, argv: args, cwd: base,
    source_command_configured: false, control_extension: extension, control_extension_sha256: hash(await readFile(extension)),
    controlled_summary: true, compaction_settings: compactionSettings, real_model: false,
    observation: 'Same public provider and SDK observer; every process has a separate complete source ledger' });
  const oracle = { snapshots: info.fixture.snapshots.slice(0, 4), bodies: info.bodies };
  let rpc, segment, failed, archive, serializer;
  const countBodies = context => Object.fromEntries([...info.bodies].map(([key, body]) => [key, bodyCount(context, body)]));
  const counts = selected => Object.fromEntries([...info.bodies.keys()].map(key => [key, selected ? 1 : 0]));
  const bodyOperations = async () => (await rows(segment.ledger)).filter(event => event.kind === 'sdk' && event.event === 'start' && event.operation !== 'list').length;
  const snapshot = async (label, selected, action = {}, preparedNames = []) => {
    const path = join(output, label + '-branch.json');
    await save(controlFile, { action: 'snapshot', ...action, output: path });
    await rpc.prompt('/sc08-fixture');
    const state = await json(path), checked = assertLifecycleBranch(state.branch, { ...oracle, selected, preparedNames });
    steps.push({ label, boundary: 'native SessionManager.getBranch()', session_file: state.session_file, leaf_id: state.leaf_id,
      evidence: label + '-branch.json', ...checked });
    return state;
  };
  const ordinary = async (label, selected) => {
    await save(toolPlan, { mode: 'complete' });
    const before = (await rows(providerFile)).length, bodyBefore = await bodyOperations();
    await rpc.prompt('SC08_' + label + ' Continue the ordinary task without requesting new Skill instructions.');
    const captures = await rows(providerFile), current = captures.slice(before);
    assert.equal(current.length, 1, label + ': an ordinary continuation has one actual provider request');
    assert.deepEqual(countBodies(current[0].context), counts(selected), label + ': full selected root and Requires body counts');
    const value = { label, boundary: 'actual Pi provider payload', provider_request_id: current[0].requestId,
      body_counts: countBodies(current[0].context), sdk_body_calls: await bodyOperations() - bodyBefore };
    steps.push(value); return value;
  };
  const open = async (name, sessionPath) => {
    const suffix = name === 'initial' ? '' : '-' + name;
    const observerFile = name === 'initial' ? ledger : join(output, 'observer' + suffix + '.jsonl');
    segment = { name, ledger: observerFile, observer_file: 'observer' + suffix + '.jsonl',
      lifecycle_file: 'rpc-lifecycle' + suffix + '.json', frames_file: 'rpc-frames' + suffix + '.json' };
    rpc = await startRpc({ host: 'pi', args: [...args, ...(sessionPath ? ['--session', sessionPath] : [])],
      cwd: base, env: { ...lifecycleEnv, SC10_PI_OBSERVER: observerFile }, timeoutMs: 60000 });
    segment.rpc = rpc; processes.push(segment);
    await rpc.command('set_auto_compaction', { enabled: false });
  };
  const close = async () => {
    if (!rpc || segment.closed) return;
    const before = await waitForSourceFinality(segment.ledger, rpc.lifecycle[0].pid);
    await save(join(output, 'source-before-close-' + segment.name + '.json'), before);
    try { await rpc.closeInput(); }
    catch (error) { await rpc.stop().catch(() => {}); throw error; }
    finally {
      segment.closed = true; frames.push(...rpc.frames);
      segment.finality = await waitForSourceFinality(segment.ledger, rpc.lifecycle[0].pid, { hostClosed: true });
      await save(join(output, segment.lifecycle_file), rpc.lifecycle); await save(join(output, segment.frames_file), rpc.frames);
      await save(join(output, 'source-finality-' + segment.name + '.json'), segment.finality);
    }
  };
  const waitHook = async phase => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const found = (await rows(hookFile)).find(event => event.phase === phase);
      if (found) return found;
      assert.ok(Date.now() < deadline, 'Actual controlled provider hook did not arrive: ' + phase);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  try {
    await save(toolPlan, { mode: 'complete' }); await open('initial');
    await ordinary('BASELINE', false); const baseline = await snapshot('baseline', false);
    await save(toolPlan, { mode: 'prepare' });
    await rpc.prompt('SC08_USE_A_B_C Use the available a, b and c Skills with their complete Requires.');
    let captures = await rows(providerFile), prepared = toolResult(captures.at(-1).context, 'sc10-prepare');
    const projection = assertPreparedProjection(prepared, oracle);
    await save(join(output, 'use-projection.json'), projection);
    for (const [name, body] of info.bodies) assert.equal(bodyCount(captures.at(-1).context, body), 1, name);
    const selected = await snapshot('selected', true), originalSession = selected.session_file;
    const user = selected.branch.find(entry => entry.message?.role === 'user' && textContent(entry.message.content).includes('SC08_USE_A_B_C'));
    assert.ok(user);
    assert.equal((await ordinary('READY_AFTER_USE', true)).sdk_body_calls, 0);
    await snapshot('original-ready', true);
    assert.equal((await rpc.command('fork', { entryId: user.id })).cancelled, false);
    const forked = await snapshot('fork-before-use', false); assert.notEqual(forked.session_file, originalSession);
    await ordinary('FORK_WITHOUT_SELECTION', false);
    const oldRef = projection.records.find(record => record.name === 'a').ref, beforeProbe = await bodyOperations();
    await save(toolPlan, { mode: 'lifecycle-probe', id: 'sc08-stale-fork', ref: oldRef });
    await rpc.prompt('SC08_STALE_HANDLE Inspect the supplied handle from the abandoned branch: ' + oldRef);
    captures = await rows(providerFile);
    const rejected = toolResult(captures.at(-1).context, 'sc08-stale-fork');
    assert.equal(rejected?.isError, true); assert.match(textContent(rejected.content), /SHORT_REF_UNKNOWN/u);
    assert.deepEqual(countBodies(captures.at(-1).context), counts(false));
    assert.equal(await bodyOperations(), beforeProbe, 'Unknown branch handle must fail before any body SDK operation');
    steps.push({ label: 'stale-handle', ref: oldRef, tool_call_id: 'sc08-stale-fork', code: 'SHORT_REF_UNKNOWN', sdk_body_calls: 0 });
    assert.equal((await rpc.command('switch_session', { sessionPath: originalSession })).cancelled, false);
    assert.equal((await ordinary('SWITCH_ORIGINAL', true)).sdk_body_calls, 0); await snapshot('switch-original', true);
    assert.equal((await rpc.command('clone')).cancelled, false);
    assert.equal((await ordinary('CLONE_SELECTED', true)).sdk_body_calls, 0);
    const clone = await snapshot('clone-selected', true); assert.notEqual(clone.session_file, originalSession);
    await snapshot('rewind-before-use', false, { action: 'rewind', entryId: baseline.leaf_id });
    await ordinary('REWIND_WITHOUT_SELECTION', false);
    await snapshot('return-to-selected', true, { action: 'rewind', entryId: clone.leaf_id });
    assert.equal((await ordinary('RETURN_SELECTED', true)).sdk_body_calls, 0);
    const beforeCompact = await snapshot('before-compact', true);
    const keep = [...beforeCompact.branch].reverse().find(entry => entry.message?.role === 'user' && textContent(entry.message.content).includes('SC08_RETURN_SELECTED'));
    assert.ok(keep); await save(controlFile, { action: 'compact', firstKeptEntryId: keep.id });
    await save(join(output, 'compact-rpc.json'), await rpc.command('compact', { customInstructions: 'Use the owned controlled lifecycle summary.' }));
    const compacted = await rpc.command('get_messages');
    await save(join(output, 'messages-after-compact-before-restore.json'), compacted);
    assert.deepEqual(countBodies({ messages: compacted.messages }), counts(false), 'Actual Pi compaction must remove the original bodies before restoration');
    await snapshot('compacted-bindings', true);
    const restored = await ordinary('RESTORE_COMPACTED', true);
    assert.equal(restored.sdk_body_calls, 1, 'The fixed active graph is restored in one SDK operation');
    const restoreResults = (await rows(segment.ledger)).filter(event => event.kind === 'sdk_lifecycle_result' && event.value?.preparation?.purpose === 'inspect');
    assert.equal(restoreResults.length, 1);
    await save(join(output, 'fixed-restore.json'), { sdk_operation_id: restoreResults[0].id,
      ...assertLifecycleRestore(restoreResults[0].value, oracle), provider_request_id: restored.provider_request_id });
    const resumedPath = (await snapshot('restored', true)).session_file;
    await close(); await open('resumed', resumedPath);
    const resumed = await ordinary('RESUME_PROCESS', true);
    assert.equal(resumed.sdk_body_calls, 0, 'A persisted restored body must not be prepared again on process resume');
    await snapshot('resumed', true);
    await rpc.command('new_session');
    await snapshot('new-session', false);
    await save(toolPlan, { mode: 'complete', holdResponse: true });
    const pending = rpc.prompt('$a@sdk-fixture SC08_ABORT_AFTER_DISPATCH Apply the selected instructions.').then(
      () => ({ succeeded: true }), error => ({ succeeded: false, message: String(error.message) }));
    const held = await waitHook('response_held'), abort = rpc.command('abort');
    const aborted = await waitHook('signal_aborted'); assert.equal(aborted.requestId, held.requestId); assert.equal(aborted.aborted, true);
    await save(toolPlan, { mode: 'complete' }); await abort;
    const outcome = await pending; assert.equal(outcome.succeeded, false); assert.match(outcome.message, /abort/iu);
    const late = await waitHook('response_callback'); assert.equal(late.requestId, held.requestId); assert.equal(late.aborted, true);
    await snapshot('cancelled-after-response', false, {}, ['a', 'base']);
    await ordinary('AFTER_CANCEL', false);
    const dispatched = (await rows(providerFile)).filter(item => item.requestId === held.requestId);
    assert.equal(dispatched.length, 1);
    assert.deepEqual(countBodies(dispatched[0].context), { a: 1, b: 0, c: 0, base: 1 });
    steps.push({ label: 'cancel-after-dispatch', provider_request_id: held.requestId, actual_provider_inputs: 1,
      source_bodies_dispatched: ['a', 'base'], signal_aborted: true, late_callback_aborted: true, active_commit: false, outcome });
    await close();
    const native = await rows(nativeEvents);
    for (const name of ['session_before_fork', 'session_tree', 'session_compact', 'controlled_compaction'])
      assert.ok(native.some(event => event.type === name), 'Actual Pi lifecycle event is required: ' + name);
    assert.ok(native.some(event => event.type === 'session_start' && event.reason === 'resume'), 'New process must actually resume the owned session');
    assert.ok(native.some(event => event.type === 'session_compact' && event.from_extension === true));
  } catch (error) { failed = { code: error.code ?? error.name, message: String(error.message), stack: error.stack }; }
  finally {
    await save(toolPlan, { mode: 'complete' });
    try { await close(); } catch (error) { failed ??= { code: error.code ?? error.name, message: String(error.message) }; }
    await save(join(output, 'lifecycle-steps.json'), steps);
    await save(join(output, 'rpc-processes.json'), processes.map(({ rpc: _rpc, ledger: _ledger, ...process }) => process));
    archive = await archiveSessions(sessions, output);
  }
  const stable = processes.length > 0 && processes.every(process => process.closed && process.finality?.complete);
  try {
    if (failed) throw Object.assign(new Error(failed.message), failed);
    const captures = await rows(providerFile);
    const hooks = await rows(hookFile);
    assert.equal(new Set(captures.map(capture => capture.requestId)).size, captures.length);
    for (const capture of captures) {
      const actual = hooks.filter(event => event.requestId === capture.requestId);
      const expected = actual.some(event => event.phase === 'response_held')
        ? ['payload_start', 'payload_end', 'response_held', 'signal_aborted', 'response_callback', 'response_end']
        : ['payload_start', 'payload_end', 'response_end'];
      assert.deepEqual(actual.map(event => event.phase), expected);
      assertNativeGuidance(capture.context, env.SC10_PI_BUNDLED_CLI);
    }
    serializer = await replayScenarioHttp(captures, frames, info, output, { expectedErrors: ['sc08-stale-fork'] });
    const observations = [];
    for (const process of processes) {
      const observed = await rows(process.ledger);
      observations.push({ name: process.name, ...reconcile(observed, process.rpc.lifecycle, {
        bodyTransportRequired: observed.some(event => event.kind === 'sdk' && event.event === 'start' && event.operation !== 'list'),
        catalogLifecycle: await rows(nativeEvents) }) });
    }
    const result = { name: 'session-lifecycle', status: 'passed', observer_finality: stable, source_command_configured: false,
      provider_requests: captures.length, actual_pi_processes: processes.length, session_archive_files: archive.files.length,
      session_lifecycle: 'native fork, clone, switch, tree, compact, process resume and post-dispatch abort verified',
      controlled_summary: true, model_summary_quality: 'not_measured', actual_model: false, live_notion: false,
      steps: 'lifecycle-steps.json', process_observations: observations, serializer_http_replay: { status: serializer.status,
        requests: serializer.provider_requests, request_bytes: serializer.request_bytes, tool_calls: serializer.tool_calls,
        all_provider_requests_serialized: serializer.all_provider_requests_serialized, evidence: 'provider-http.json' } };
    await save(join(output, 'result.json'), result); return result;
  } catch (error) {
    const result = { name: 'session-lifecycle', status: 'failed', observer_finality: stable,
      error: failed ?? { code: error.code ?? error.name, message: String(error.message), stack: error.stack } };
    await save(join(output, 'result.json'), result); return result;
  }
}

async function scenario(name, info, scratch, evidence, expectShortRefs, expectCompactContext, expectDirectScalar, expectShortConfirmations) {
  const shortResourceRefs = name === 'resource-batch-short-refs';
  const resourceScenario = name === 'resource-batch' || shortResourceRefs;
  const scalarShortRefs = name === 'resource-scalar-short-refs', scalarScenario = name === 'resource-scalar' || scalarShortRefs;
  const nativeRepeat = name === 'native-repeat';
  const partialEntrypoint = name === 'partial-entrypoint';
  const codemode = ['codemode-hidden', 'codemode-truncated'].includes(name);
  const base = join(scratch, name), output = join(evidence, name);
  await mkdir(base); await mkdir(output, { mode: 0o700 });
  const localSource = join(base, 'source');
  await cp(info.fixture.cwd, localSource, { recursive: true, errorOnExist: true, force: false });
  const agentDir = join(base, 'agent'), sessions = join(base, 'sessions');
  await mkdir(join(agentDir, 'context-broker'), { recursive: true }); await mkdir(sessions);
  const source = { type: 'notion', id: 'sdk-fixture', namespace: 'sdk-fixture', database: info.fixture.database,
    discovery: { offline: true }, activation: { offline: true }, cacheDir: join(base, 'broker-cache'), prefetch: false };
  assert.equal(Object.hasOwn(source, 'command'), false);
  const config = join(agentDir, 'context-broker/config.yml');
  await save(config, { sources: [source] }); await save(join(output, 'source.json'), source);
  const providerFile = join(output, 'provider.jsonl'), hookFile = join(output, 'provider-hooks.jsonl'), ledger = join(output, 'observer.jsonl');
  const toolPlan = join(base, 'tool-plan.json');
  const resourcePlan = resourceScenario ? { owner: info.resourceBatch?.name, refs: info.resourceBatch?.refs,
    paths: info.resourceBatch?.files.map(file => file.path), short_refs: shortResourceRefs } : {};
  if (resourceScenario) assert.ok(info.resourceBatch, 'The fixture must provide the resource-batch scenario');
  const repeatPlan = nativeRepeat ? { owner: info.resourceBatch?.name,
    resource_path: info.resourceBatch?.files.find(file => file.encoding === 'utf8' && file.content.length > 0 && !file.content.startsWith('\ufeff'))?.path } : {};
  if (nativeRepeat) assert.ok(repeatPlan.owner && repeatPlan.resource_path, 'The frozen resource fixture must provide the native repeat owner and text resource');
  if (scalarScenario) {
    assert.ok(info.resourceBatch, 'The fixture must provide fixed scalar resources');
    if (expectDirectScalar) assert.equal(info.runtime.read_output_proof_version, 1, 'Direct scalar evidence requires the versioned SDK output proof');
  }
  const scalarSeed = scalarShortRefs ? await seedScalarResourceSession(info, base, sessions, output) : undefined;
  const scalarCalls = scalarScenario ? resourceScalarCalls(info.resourceBatch, scalarSeed?.handles ?? info.resourceBatch.refs) : [];
  if (partialEntrypoint) assert.ok(info.entrypoint, 'The fixture must provide the complete entrypoint scenario');
  const entrypointPlan = partialEntrypoint ? { owner: info.entrypoint.name, fixed_main_ref: info.entrypoint.ref,
    selected_path: info.entrypoint.files.find(file => file.role === 'selected').path } : {};
  await save(toolPlan, { mode: ['dollar', 'default-view'].includes(name) ? 'search' : name, ...resourcePlan, ...entrypointPlan, ...repeatPlan,
    ...(scalarScenario ? { calls: scalarCalls.map(({ id, args }) => ({ id, args })) } : {}) });
  const fakeProvider = await provider(base), preload = join(base, 'observer.mjs');
  await observer(preload);
  const fixtureEnv = { ...info.fixtureEnv };
  for (const key of ['NTN_SKILLS_HOME', 'NTN_SKILLS_CONFIG_HOME', 'NTN_SKILLS_CACHE_HOME']) {
    const original = resolve(info.fixture.cwd, fixtureEnv[key]);
    assert.ok(original.startsWith(resolve(info.fixture.cwd) + '/'));
    fixtureEnv[key] = join(localSource, original.slice(resolve(info.fixture.cwd).length + 1));
  }
  const entrypointSetup = partialEntrypoint ? await preparePartialEntrypoint(info, localSource, fixtureEnv, output) : undefined;
  const env = isolatedEnv({ base, agentDir, ...fixtureEnv, TMPDIR: await systemTempRoot(),
    NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000', CONTEXT_BROKER_HOST: 'pi', CONTEXT_BROKER_CONFIG: config,
    CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: providerFile, CONTEXT_BROKER_LOG_FILE: join(output, 'decisions.jsonl'),
    BROKER_E2E_PROCESS_LEDGER: join(output, 'owned-processes.jsonl'), SC10_PI_TOOL_PLAN: toolPlan,
    SC10_PI_PROVIDER_HOOKS: hookFile, SC10_PI_OBSERVER: ledger,
    ...(entrypointSetup ? { SC13_PI_OBJECT_ROOT: entrypointSetup.partial.objects }
      : scalarScenario ? { SC13_PI_OBJECT_ROOT: join(fixtureEnv.NTN_SKILLS_HOME, 'objects') } : {}),
    SC10_PI_BUNDLED_CLI: join(info.packageRoot, 'dist/ntn-skills.mjs'), NODE_OPTIONS: `--import=${preload}` });
  const activeTools = name === 'scoped-command' ? scopedCommandTools : codemode ? [...nativeTools, 'codemode'] : nativeTools;
  const argv = ['--no-extensions', '--session-dir', sessions, ...(scalarSeed ? ['--session', scalarSeed.path] : []),
    '--tools', activeTools.join(','), '-e', fakeProvider, '-e', info.extension,
    ...(codemode ? ['-e', join(info.piPackageRoot, 'dist/extensions/codemode/index.js')] : []), '--model', 'context-broker-e2e/fake'];
  await save(join(output, 'launch.json'), { host: info.host, argv, cwd: base, source_command_configured: false,
    source_state: partialEntrypoint ? 'complete controlled current validated by installed SDK, then owned partial cache; fresh Broker cache and Pi session'
      : scalarSeed ? 'cloned warm controlled source; fresh Broker cache and new Pi process restoring a metadata-only short-reference session'
      : 'cloned warm controlled snapshots/current catalog; fresh Broker cache and Pi session', expect_short_refs: expectShortRefs,
    expect_compact_context: expectCompactContext, expect_direct_scalar: expectDirectScalar, expect_short_confirmations: expectShortConfirmations, active_tools: activeTools,
    ...(scalarSeed ? { seed_evidence: 'resource-scalar-seed.json', seed_sha256: scalarSeed.evidence.session_sha256 } : {}) });
  if (name === 'session-lifecycle') return runSdkLifecycle({ info, base, output, sessions, providerFile, hookFile, ledger, toolPlan, env, argv });
  let rpc, failed, last, discovery, beforeClose, finality, preparation, resourceBatchEvidence, resourceScalarEvidence, nativeRepeatEvidence, entrypointEvidence, defaultViewEvidence, serializerContext, archive, dollarProjection, nativeProjection;
  try {
    rpc = await startRpc({ host: 'pi', args: argv, cwd: base, env, timeoutMs: 60000 });
    const prompts = {
      'codemode-hidden': 'Inspect the selected main inside code mode without forwarding it, then load the full a, b and c closure through the top-level use tool.',
      'codemode-truncated': 'Inspect the selected main inside code mode and forward only a short prefix, then load the full a, b and c closure through the top-level use tool.',
      'default-view': 'Discover the authorized Skill directory and retain the default Notion Skill metadata without reading any Skill body.',
      dollar: 'Discover the authorized Skill directory for the controlled task.',
      native: 'Inspect the available a Skill and read its advertised resource.',
      'native-repeat': 'Read the resources Skill main, then its advertised references/guide.md resource. Read the same fixed main and resource again using the handles from that first native directory. Preserve the selected owner and snapshot.',
      prepare: 'Use the available a, b and c Skills together, preparing their required instructions.',
      'resource-batch': 'Read this explicit fixed resource set in one read paths call: ' + JSON.stringify(info.resourceBatch?.refs) + '. Read only those resources without loading or activating the Skill main body.',
      'resource-batch-short-refs': 'Explicitly inspect the resources Skill once. Use its four requested resource handles for ' + JSON.stringify(info.resourceBatch?.files.map(file => file.path)) + ' in one read paths call; preserve that selected owner and snapshot.',
      'resource-scalar': 'Read only these fixed resources in the supplied order, using one native read path call per item: ' + JSON.stringify(scalarCalls.map(call => call.args)) + '. Preserve native pagination and file results. Do not prepare or activate the main Skill.',
      'resource-scalar-short-refs': 'Resume the persisted resource references and read only these fixed resources in the supplied order, using one native read path call per item: ' + JSON.stringify(scalarCalls.map(call => call.args)) + '. Preserve native pagination and file results. Do not prepare or activate the main Skill.',
      'partial-entrypoint': 'Read the supplied fixed entrypoint Skill main, inspect its current candidate directory, then read only the advertised selected text resource. Keep the selected owner and snapshot.',
      'scoped-command': 'For the sdk-fixture source, obtain the host-local command prefix and database scope for a possible maintenance action. Return that metadata only; do not execute commands or read Skill bodies.',
    };
    await rpc.prompt(prompts[name]);
    let captures = await rows(providerFile); assert.ok(captures.length >= 2);
    last = captures.at(-1).context;
    if (name !== 'scoped-command' && !scalarScenario) {
      discovery = parsedResult(toolResult(last, 'sc10-search'));
      assert.equal(discovery.ok, true); assert.equal(discovery.count, info.fixture.catalog_records?.length ?? 4);
      for (const record of discovery.records) if (expectShortRefs) assert.match(record.ref, /^sr:C/u);
    }
    if (name === 'default-view') {
      assert.equal(captures.length, 2);
      await save(toolPlan, { mode: 'complete' });
      await rpc.prompt('Continue the ordinary task using the now available default directory metadata. Do not read any Skill body.');
      captures = await rows(providerFile); last = captures.at(-1).context;
      assert.equal(captures.length, 3, 'Nonblocking startup and one ordinary continuation are both retained');
      defaultViewEvidence = assertDefaultViewProjection(captures, discovery, await rows(ledger), info.fixture, info.bodies);
      defaultViewEvidence.read_schema = assertResourceReadSchema(last);
      await save(join(output, 'default-view.json'), defaultViewEvidence);
    } else if (codemode) {
      assert.equal(captures.length, 4);
      const topCalls = rpc.frames.filter(frame => frame.type === 'tool_execution_start' && !frame.parentToolCallId);
      assert.deepEqual(topCalls.map(call => [call.toolCallId, call.toolName]), [['sc10-search', 'notion_list'], ['sc26-code', 'codemode'], ['sc26-use', 'notion_use']]);
      const nested = rpc.frames.filter(frame => frame.type === 'tool_execution_end' && frame.parentToolCallId === 'sc26-code');
      const reads = nested.filter(frame => frame.toolName === 'read'); assert.equal(reads.length, 1); assert.equal(reads[0].isError, false);
      assert.ok(textContent(reads[0].result.content).startsWith(info.bodies.get('a')), 'The hidden internal read really returned complete bytes');
      assert.ok(nested.every(frame => frame.toolName === 'read' || frame.toolName === 'notion_use' && frame.isError), 'No successful nested use is allowed');
      const code = toolResult(captures[2].context, 'sc26-code'); assert.ok(code && !code.isError);
      assert.match(textContent(code.content), /TOP_LEVEL_USE_REQUIRED/u);
      for (const capture of captures.slice(0, 3)) for (const body of info.bodies.values()) assert.equal(bodyCount(capture.context, body), 0,
        'Internal success and printed/truncated code output cannot count as complete model delivery');
      for (const [key, body] of info.bodies) assert.equal(bodyCount(last, body), 1, key + ': top-level use delivers every complete root/Required once');
      const frame = rpc.frames.find(frame => frame.type === 'tool_execution_end' && frame.toolCallId === 'sc26-use'); assert.ok(frame);
      const raw = { ...frame.result, role: 'toolResult', toolName: frame.toolName, toolCallId: frame.toolCallId, isError: frame.isError };
      const oracle = { snapshots: info.fixture.snapshots.slice(0, 4), bodies: info.bodies };
      const first = assertPreparedProjection(toolResult(last, 'sc26-use'), oracle), original = assertPreparedProjection(raw, oracle);
      assert.deepEqual(first.content, original.content);
      preparation = { first, originalToolResults: [raw], code_mode: { mode: name, nested_reads: 1, internal_complete_body: true,
        before_top_level_complete_bodies: 0, after_top_level_complete_bodies: info.bodies.size } };
    } else if (name === 'dollar') {
      for (const body of info.bodies.values()) assert.equal(bodyCount(last, body), 0, 'Metadata-only discovery must not deliver bodies');
      const selected = discovery.records.filter(record => record.name === 'a' && record.source === source.id);
      assert.equal(selected.length, 1);
      await save(toolPlan, { mode: 'complete' });
      await rpc.prompt(`$${selected[0].name}@${source.namespace} Apply the selected Skill for this controlled task.`);
      captures = await rows(providerFile); last = captures.at(-1).context;
      for (const key of ['a', 'base']) assert.equal(bodyCount(last, info.bodies.get(key)), 1, `${key}: full source body exactly once`);
      for (const key of ['b', 'c']) assert.equal(bodyCount(last, info.bodies.get(key)), 0);
      dollarProjection = assertDollarProjection(last, { bodies: info.bodies, snapshots: info.fixture.snapshots, expectCompact: expectCompactContext });
    } else if (scalarScenario) {
      const batch = info.resourceBatch, calls = rpc.frames.filter(frame => frame.type === 'tool_execution_start');
      assert.equal(captures.length, 6, 'Five direct scalar calls require exactly six provider requests');
      assert.deepEqual(calls.map(frame => ({ id: frame.toolCallId, name: frame.toolName, args: frame.args })),
        scalarCalls.map(call => ({ id: call.id, name: 'read', args: call.args })), 'The measured task reads fixed resources without discovery or inspection tools');
      const originalToolResults = scalarCalls.map(call => {
        const frames = rpc.frames.filter(frame => frame.type === 'tool_execution_end' && frame.toolCallId === call.id); assert.equal(frames.length, 1);
        return { ...frames[0].result, role: 'toolResult', toolName: frames[0].toolName, toolCallId: call.id, isError: frames[0].isError };
      });
      const reads = originalToolResults.map((message, index) => assertResourceScalarResult(message, { batch, call: scalarCalls[index] }));
      for (const capture of captures) {
        assert.equal(bodyCount(capture.context, batch.main), 0, 'No provider request receives the main body');
        for (const file of batch.unselected) assert.equal(bodyCount(capture.context, file.content), 0);
        for (const [index, call] of scalarCalls.entries()) {
          const projected = toolResult(capture.context, call.id);
          if (projected) {
            assertResourceScalarResult(projected, { batch, call });
            assert.deepEqual(projected.content, originalToolResults[index].content);
            assert.deepEqual(projected.details.contextBrokerResource, originalToolResults[index].details.contextBrokerResource);
          }
        }
      }
      resourceScalarEvidence = { reads, originalToolResults, source_cache: 'warm', source_io_before_first_read: 'catalog discovery only; no setup SDK call',
        reference_form: scalarShortRefs ? 'persisted_session_short_resource' : 'canonical_fixed',
        ...(scalarSeed ? { seed: scalarSeed.evidence } : {}), provider_requests: captures.length, main_provider_content_copies: 0,
        image_boundary: 'Fixture binary is not an image; native image/structuredContent/signal forwarding remains covered by pi-read-adapter tests',
        installed_runtime: info.runtime, comparison_scope: 'Installed Broker and bundled CLI/SDK; compare bundle hashes and read_output_proof_version between arms' };
    } else if (nativeRepeat) {
      const starts = rpc.frames.filter(frame => frame.type === 'tool_execution_start');
      assert.deepEqual(starts.map(frame => frame.toolCallId), ['sc10-search', 'sc15-main', 'sc15-resource', 'sc15-main-repeat', 'sc15-resource-repeat']);
      assert.deepEqual(starts.map(frame => frame.toolName), ['notion_list', 'read', 'read', 'read', 'read']);
      const originalToolResults = starts.slice(1).map(start => {
        const frames = rpc.frames.filter(frame => frame.type === 'tool_execution_end' && frame.toolCallId === start.toolCallId); assert.equal(frames.length, 1);
        return { ...frames[0].result, role: 'toolResult', toolName: frames[0].toolName, toolCallId: start.toolCallId, isError: frames[0].isError };
      });
      const controlled = { messages: [] }, owner = discovery.records.filter(record => record.name === repeatPlan.owner && record.source === source.id);
      assert.equal(owner.length, 1);
      for (const [index, original] of originalToolResults.entries()) {
        const call = selectNativeRepeatCall(controlled, { mainRef: owner[0].ref, resourcePath: repeatPlan.resource_path });
        assert.deepEqual({ id: starts[index + 1].toolCallId, name: starts[index + 1].toolName, args: starts[index + 1].args },
          { id: call.id, name: call.name, args: call.arguments }, 'Every call copies the actual search or first native directory handle');
        controlled.messages.push(original);
      }
      assert.equal(selectNativeRepeatCall(controlled, { mainRef: owner[0].ref, resourcePath: repeatPlan.resource_path }), null);
      nativeRepeatEvidence = { ...assertNativeRepeatProjection(captures, originalToolResults,
        { batch: info.resourceBatch, expectShort: expectShortConfirmations }), originalToolResults };
    } else if (partialEntrypoint) {
      const sample = info.entrypoint, selected = sample.files.find(file => file.role === 'selected');
      const fromFrame = id => {
        const frames = rpc.frames.filter(frame => frame.type === 'tool_execution_end' && frame.toolCallId === id);
        assert.equal(frames.length, 1);
        return { ...frames[0].result, role: 'toolResult', toolName: frames[0].toolName, toolCallId: id, isError: frames[0].isError };
      };
      const main = toolResult(last, 'sc13-main'), mainRaw = fromFrame('sc13-main');
      assert.equal(mainRaw.isError, false); assert.equal(main.isError, false);
      assert.ok(textContent(mainRaw.content).startsWith(sample.main));
      const mainProof = mainRaw.details?.contextBrokerRead;
      assert.ok(mainProof); assert.equal(mainProof.toolCallId, 'sc13-main');
      assert.equal(mainProof.snapshotId, sample.snapshot.snapshot_id);
      assert.equal(mainProof.bodySha256, sample.main_file.sha256); assert.equal(mainProof.bytes, sample.main_file.bytes);
      assert.equal(mainProof.binding?.scope, sample.snapshot.scope); assert.equal(mainProof.binding?.record.id, sample.snapshot.record.id);
      assert.equal(mainProof.binding?.version_id, sample.snapshot.version_id);
      const footer = /<skill-directory>\s*([\s\S]*?)\s*<\/skill-directory>/u.exec(textContent(mainRaw.content));
      assert.ok(footer, 'The native main must advertise the complete fixed directory');
      const nativeDirectory = JSON.parse(footer[1]).directory;
      assert.deepEqual(nativeDirectory.files.map(file => file.path), sample.snapshot.files.map(file => file.path));
      const inspection = assertNativeProjection(mainRaw, { snapshot: sample.snapshot, body: sample.main });
      const providerInspection = assertNativeProjection(main, { snapshot: sample.snapshot, body: sample.main });
      assert.deepEqual(main.content, mainRaw.content, 'The single native inspection remains complete in the following provider request');
      assert.equal(bodyCount({ messages: [main] }, sample.main), 1);
      const resource = toolResult(last, 'sc13-resource'), resourceRaw = fromFrame('sc13-resource');
      assert.equal(resourceRaw.isError, false); assert.equal(resource.isError, false);
      const resourceProof = resourceRaw.details?.contextBrokerResource;
      assert.ok(resourceProof); assert.equal(resourceProof.id, sample.snapshot.record.id);
      assert.equal(resourceProof.scope, sample.snapshot.scope); assert.equal(resourceProof.snapshot_id, sample.snapshot.snapshot_id);
      assert.equal(resourceProof.version_id, sample.snapshot.version_id); assert.equal(resourceProof.file_id, selected.file_id);
      assert.equal(resourceProof.path, selected.path); assert.equal(resourceProof.bytes, selected.bytes); assert.equal(resourceProof.sha256, selected.sha256);
      assert.equal(resourceProof.delivered_complete_text, true); assert.equal(textContent(resourceRaw.content), selected.content);
      if (resourceProof.materialization !== undefined) assert.deepEqual(resourceProof.materialization, { manifest_complete: true, local_files_ready: false,
        materialized_paths: [sample.snapshot.entrypoint, selected.path].sort(), loaded: false });
      assert.equal(bodyCount(last, sample.main), 1); assert.equal(bodyCount(last, selected.content), 1);
      const calls = rpc.frames.filter(frame => frame.type === 'tool_execution_start');
      assert.deepEqual(calls.map(call => call.toolCallId), ['sc10-search', 'sc13-main', 'sc13-resource']);
      assert.deepEqual(calls[1].args, { path: sample.ref });
      const candidate = discovery.records.find(record => record.name === sample.name && record.source === source.id);
      assert.deepEqual(calls[2].args, { path: resourceRefsFromNative(main, [selected.path])[0] });
      assert.equal(captures.length, 4, 'List, one fixed main inspection and one resource read need exactly three tool rounds');
      const materialized = await inventory(source.cacheDir);
      for (const file of [sample.main_file, selected]) assert.ok(materialized.some(item => item.path.endsWith('/' + file.path)
        && item.bytes === file.bytes && item.sha256 === file.sha256), file.path + ': exact native materialization');
      for (const file of sample.files.filter(file => file.role !== 'selected'))
        assert.equal(materialized.some(item => item.path.endsWith('/' + file.path)), false, file.path + ': unselected Broker output is absent');
      const partialState = await assertPartialObjectState(entrypointSetup.partial);
      entrypointEvidence = { snapshot_id: sample.snapshot.snapshot_id, main: { bytes: mainProof.bytes, sha256: mainProof.bodySha256 },
        source_state: 'controlled complete validation followed by owned partial cache; no cold-source claim',
        fixed_main_argument: calls[1].args.path, inspected_candidate: candidate.ref,
        directory_files: nativeDirectory.files.length, host_materialization: { manifest_complete: true, local_files_ready: false,
          materialized_paths: [sample.snapshot.entrypoint, selected.path].sort(),
          method: 'independent native main directory and exact cache file inventory', source_receipt: resourceProof.materialization ?? null },
        inspection, provider_inspection: providerInspection, selected_resource: resourceProof, partial_state: partialState,
        originalToolResults: [mainRaw, resourceRaw] };
    } else if (name === 'native') {
      const main = toolResult(last, 'sc10-main'), resource = toolResult(last, 'sc10-resource');
      assert.ok(main && !main.isError); assert.ok(resource && !resource.isError);
      assert.equal(bodyCount(last, info.bodies.get('a')), 1);
      assert.equal(bodyCount(last, info.bodies.get('base')), 0, 'Native inspection must not activate Requires');
      const delivered = resource.details?.contextBrokerResource;
      assert.ok(delivered, 'Resource must have the host owner/version/hash receipt');
      assert.equal(delivered.bytes, info.fixture.resource.bytes); assert.equal(delivered.sha256, info.fixture.resource.sha256);
      const selected = discovery.records.find(record => record.name === 'a' && record.source === source.id);
      const hostRecords = toolResult(last, 'sc10-search').details?.records.filter(record => record.ref === selected.ref && record.name === selected.name);
      assert.equal(hostRecords?.length, 1, 'The selected model ref must retain one complete source identity in host details');
      const fixed = info.fixture.snapshots.find(snapshot => snapshot.record.id === hostRecords[0].id);
      assert.ok(fixed);
      assert.equal(delivered.id, hostRecords[0].id); assert.equal(delivered.scope, info.fixture.scope);
      assert.equal(delivered.snapshot_id, fixed.snapshot_id); assert.equal(delivered.version_id, fixed.version_id);
      assert.equal(delivered.file_id, fixed.file_bindings.find(file => file.path === delivered.path).file_id);
      const frame = rpc.frames.find(frame => frame.type === 'tool_execution_start' && frame.toolCallId === 'sc10-resource');
      if (expectShortRefs) assert.match(frame?.args?.path ?? '', /^sr:R/u);
      nativeProjection = assertNativeProjection(main, { snapshot: fixed, body: info.bodies.get('a'), expectCompact: expectCompactContext });
      if (expectCompactContext) {
        assert.deepEqual(rpc.frames.filter(frame => frame.type === 'tool_execution_start').map(frame => frame.toolCallId),
          ['sc10-search', 'sc10-main', 'sc10-resource'], 'The candidate native footer must avoid an extra inspection round');
        assert.ok(nativeProjection.resource_refs.includes(frame.args.path), 'The resource call copies its actual advertised footer ref');
        assert.equal(captures.length, 4, 'Search, native main and advertised resource require exactly three tool rounds');
      }
      const files = await inventory(source.cacheDir);
      const matches = files.filter(file => file.path.endsWith('/' + delivered.path) && file.bytes === delivered.bytes && file.sha256 === delivered.sha256);
      assert.equal(matches.length, 1, 'Receipt must bind one exact resource in this owned Broker materialization');
      const path = join(source.cacheDir, matches[0].path);
      const bytes = await readFile(path); assert.equal(bytes.length, delivered.bytes); assert.equal(hash(bytes), delivered.sha256);
      assert.equal(delivered.delivered_complete_text, false, 'This binary fixture is not equivalent model text');
      await save(join(output, 'resource.json'), { path, requested_ref: frame?.args?.path, owner: delivered.id, snapshot_id: delivered.snapshot_id, file_id: delivered.file_id,
        bytes: bytes.length, sha256: hash(bytes), delivered_complete_text: delivered.delivered_complete_text,
        interpretation: 'binary source bytes verified at native-read materialization; no complete text-delivery claim' });
    } else if (resourceScenario) {
      const batch = info.resourceBatch;
      const schema = assertResourceReadSchema(captures[0].context);
      await save(join(output, 'resource-read-schema.json'), schema);
      const fromFrame = id => {
        const frames = rpc.frames.filter(frame => frame.type === 'tool_execution_end' && frame.toolCallId === id);
        assert.equal(frames.length, 1);
        return { ...frames[0].result, role: 'toolResult', toolName: frames[0].toolName, toolCallId: id, isError: frames[0].isError };
      };
      const first = toolResult(last, 'sc07-resources'), firstRaw = fromFrame('sc07-resources');
      const firstProof = assertResourceBatchProjection(first, { batch }), rawFirstProof = assertResourceBatchProjection(firstRaw, { batch });
      assert.deepEqual(firstProof.content, rawFirstProof.content);
      let inspection, inspectedRaw, requestedRefs = batch.refs;
      if (shortResourceRefs) {
        const inspected = toolResult(last, 'sc07-resource-inspect'); inspectedRaw = fromFrame('sc07-resource-inspect');
        const oracle = { snapshot: batch.snapshot, body: batch.main };
        inspection = assertNativeProjection(inspected, oracle);
        assert.deepEqual(inspection, assertNativeProjection(inspectedRaw, oracle));
        requestedRefs = resourceRefsFromNative(inspected, batch.files.map(file => file.path));
        for (const file of firstProof.files) assert.match(file.ref, /^sr:R[A-Za-z0-9_-]{22}$/u);
      }
      const firstCalls = rpc.frames.filter(frame => frame.type === 'tool_execution_start' && frame.toolCallId === 'sc07-resources');
      assert.equal(firstCalls.length, 1); assert.deepEqual(firstCalls[0].args, { paths: requestedRefs });
      assert.equal((await rows(ledger)).filter(event => event.kind === 'sdk' && event.event === 'start' && event.operation === 'read-resources').length, 1);
      for (const file of batch.files.filter(file => file.encoding === 'utf8')) {
        assert.equal(resourceTextCopies(last, file), 1, file.path + ': complete source in actual provider content');
        if (file.content.length) assert.equal(bodyCount(last, file.content), 1);
      }
      assert.equal(bodyCount(last, batch.main), shortResourceRefs ? 1 : 0, 'Only the separately requested inspection may deliver the main body');
      for (const file of batch.unselected) assert.equal(bodyCount(last, file.content), 0, 'Unselected resources must not be delivered');
      const binary = firstProof.files.find(file => file.state === 'binary'), expectedBinary = batch.files.find(file => file.encoding === 'base64');
      assert.ok(binary && expectedBinary);
      const actualPath = await realpath(binary.output), cacheRoot = await realpath(source.cacheDir);
      assert.ok(actualPath.startsWith(cacheRoot + '/'), 'Binary output belongs to this owned Broker materialization');
      assert.equal((await lstat(binary.output)).isSymbolicLink(), false);
      const bytes = await readFile(actualPath);
      assert.equal(bytes.length, expectedBinary.bytes); assert.equal(hash(bytes), expectedBinary.sha256);
      assert.deepEqual(bytes, Buffer.from(expectedBinary.content, 'base64'));
      await writeFile(join(output, 'resource-batch.bin'), bytes, { mode: 0o600, flag: 'wx' });
      const materialized = await inventory(source.cacheDir);
      for (const file of batch.unselected) assert.equal(materialized.some(item => item.path.endsWith('/' + file.path)), false, 'Unselected resources are absent from Broker materialization');
      const requestsBeforeRepeat = captures.length; assert.equal(requestsBeforeRepeat, shortResourceRefs ? 4 : 3);
      await save(toolPlan, { mode: 'resource-batch-repeat', ...resourcePlan });
      await rpc.prompt('Read the same fixed resource set again in one read paths call. Keep the same owner and snapshot without activating its main body.');
      captures = await rows(providerFile); last = captures.at(-1).context;
      const repeated = toolResult(last, 'sc07-resources-repeat'), repeatedRaw = fromFrame('sc07-resources-repeat');
      const rawRepeatedProof = assertResourceBatchProjection(repeatedRaw, { batch });
      const repeatedProof = assertResourceBatchProjection(repeated, { batch, state: 'replaced' });
      assert.equal(repeated.details.contextBrokerResource.projection.derived.parentSha256, rawRepeatedProof.content.sha256);
      assert.equal(textContent(toolResult(last, 'sc07-resources').content), textContent(firstRaw.content));
      assert.deepEqual(repeatedProof.files.find(file => file.state === 'binary'), binary, 'Binary metadata and exact materialized path remain stable');
      for (const file of batch.files.filter(file => file.encoding === 'utf8')) {
        assert.equal(resourceTextCopies(last, file), file.content.length ? 1 : 2, 'Only nonempty repeated text needs replacement');
        if (file.content.length) assert.equal(bodyCount(last, file.content), 1);
      }
      assert.equal(bodyCount(last, batch.main), shortResourceRefs ? 1 : 0);
      if (inspectedRaw) assert.equal(textContent(toolResult(last, 'sc07-resource-inspect').content), textContent(inspectedRaw.content));
      for (const file of batch.unselected) assert.equal(bodyCount(last, file.content), 0);
      assert.equal(captures.length, shortResourceRefs ? 6 : 5);
      assert.deepEqual(rpc.frames.filter(frame => frame.type === 'tool_execution_start' && ['sc07-resources', 'sc07-resources-repeat'].includes(frame.toolCallId)).map(frame => frame.args),
        [{ paths: requestedRefs }, { paths: requestedRefs }], 'The repeated native read retains the exact requested resource set');
      const inspectionCalls = rpc.frames.filter(frame => frame.type === 'tool_execution_start' && frame.toolCallId === 'sc07-resource-inspect');
      assert.equal(inspectionCalls.length, shortResourceRefs ? 1 : 0);
      if (shortResourceRefs) {
        assert.equal(inspectionCalls[0].toolName, 'read');
        assert.deepEqual(inspectionCalls[0].args, { path: discovery.records.find(record => record.name === batch.name && record.source === source.id).ref });
      }
      resourceBatchEvidence = { first: firstProof, repeated_raw: rawRepeatedProof, repeated_provider: repeatedProof,
        selected_files: batch.files.length, source_cache: 'warm', main_delivered: shortResourceRefs, main_delivery_reason: shortResourceRefs ? 'explicit_inspect' : 'not_requested', unselected_delivered: false,
        requested_refs: requestedRefs, ...(inspection ? { explicit_inspection: inspection } : {}),
        binary: { path: actualPath, retained_file: 'resource-batch.bin', bytes: bytes.length, sha256: hash(bytes), delivered_complete_text: false },
        requests_before_repeat: requestsBeforeRepeat, requests_after_repeat: captures.length, originalToolResults: [...(inspectedRaw ? [inspectedRaw] : []), firstRaw, repeatedRaw] };
      serializerContext = last;
    } else if (name === 'prepare') {
      const prepared = parsedResult(toolResult(last, 'sc10-prepare'));
      assert.equal(prepared.status, 'ready'); assert.equal(prepared.records.length, 4);
      for (const [key, body] of info.bodies) assert.equal(bodyCount(last, body), 1, `${key}: complete prepared text once`);
      if (expectShortRefs) for (const record of prepared.records) assert.match(record.ref, /^sr:S/u);
      const oracle = { snapshots: info.fixture.snapshots.slice(0, 4), bodies: info.bodies };
      const fromFrame = id => {
        const frames = rpc.frames.filter(frame => frame.type === 'tool_execution_end' && frame.toolCallId === id);
        assert.equal(frames.length, 1);
        const frame = frames[0];
        return { ...frame.result, role: 'toolResult', toolName: frame.toolName, toolCallId: id, isError: frame.isError };
      };
      const first = toolResult(last, 'sc10-prepare'), firstRaw = fromFrame('sc10-prepare');
      const firstProof = assertPreparedProjection(first, oracle), rawFirstProof = assertPreparedProjection(firstRaw, oracle);
      assert.equal(firstProof.content.sha256, rawFirstProof.content.sha256);
      assert.equal(firstProof.records.filter(record => record.name === 'base').length, 1);
      await save(join(output, 'prepared.json'), prepared);
      const requestsBeforeRepeat = captures.length;
      assert.equal(requestsBeforeRepeat, 3, 'Search and first preparation produce two tool rounds');
      await save(toolPlan, { mode: 'prepare-repeat' });
      await rpc.prompt('Use the same a, b and c Skills again, keeping their selected versions.');
      captures = await rows(providerFile); last = captures.at(-1).context;
      const repeated = toolResult(last, 'sc05-prepare-repeat'), repeatedRaw = fromFrame('sc05-prepare-repeat');
      const rawRepeatedProof = assertPreparedProjection(repeatedRaw, oracle);
      const repeatedProof = assertPreparedProjection(repeated, { ...oracle, state: 'replaced' });
      assert.equal(repeated.details.contextBrokerPreparation.projection.derived.parentSha256, rawRepeatedProof.content.sha256);
      assert.equal(textContent(toolResult(last, 'sc10-prepare').content), textContent(firstRaw.content), 'The first complete copy remains available');
      for (const [key, body] of info.bodies) assert.equal(bodyCount(last, body), 1, `${key}: one visible complete body after repeated preparation`);
      preparation = { first: firstProof, repeated_raw: rawRepeatedProof, repeated_provider: repeatedProof,
        requests_before_repeat: requestsBeforeRepeat, requests_after_repeat: captures.length, originalToolResults: [firstRaw, repeatedRaw] };
      assert.equal(captures.length, 5, 'Repeated preparation adds one tool round in the existing session');
      serializerContext = last;
    } else {
      const hostStart = (await rows(ledger)).find(event => event.kind === 'observer_start' && event.observer_pid === rpc.lifecycle[0].pid);
      assert.ok(hostStart, 'Actual owned Pi executable must be observed independently');
      const scope = assertScopedCommand(captures, rpc.frames, { command: [hostStart.exec_path, env.SC10_PI_BUNDLED_CLI], database: source.database });
      for (const body of info.bodies.values()) assert.equal(bodyCount(last, body), 0, 'Command scope lookup must not deliver Skill bodies');
      await save(join(output, 'source-command.json'), scope);
    }
    beforeClose = await waitForSourceFinality(ledger, rpc.lifecycle[0].pid);
    assert.ok(beforeClose.complete, 'Observed source processes must reach actual close/end before EOF');
    await rpc.closeInput();
  } catch (error) {
    failed = { code: error.code ?? error.name, message: String(error.message) };
    if (rpc) {
      beforeClose ??= await waitForSourceFinality(ledger, rpc.lifecycle[0].pid);
      await rpc.stop().catch(() => {});
    }
  } finally {
    if (rpc) {
      finality = await waitForSourceFinality(ledger, rpc.lifecycle[0].pid, { hostClosed: true });
      await save(join(output, 'observer-finalization.json'), { before_close: beforeClose, after_close: finality });
      if (!finality.complete) {
        const snapshot = await readFile(ledger).catch(() => Buffer.alloc(0));
        await writeFile(join(output, 'observer-at-deadline.jsonl'), snapshot, { mode: 0o600 });
        failed ??= { code: 'OBSERVER_TERMINAL_INCOMPLETE', message: 'Owned source/observer terminal remains unresolved; live ledger is not sealed.' };
      }
      await save(join(output, 'rpc.json'), rpc.frames); await save(join(output, 'rpc-lifecycle.json'), rpc.lifecycle);
      archive = await archiveSessions(sessions, output);
    }
  }
  try {
    if (failed) throw new Error(failed.message);
    let serializer;
    if (preparation) {
      for (const original of preparation.originalToolResults) {
        const messages = archive.messages.filter(message => message.role === 'toolResult' && message.toolName === 'notion_use' && message.toolCallId === original.toolCallId);
        assert.equal(messages.length, 1, 'The original session retains each actual tool result');
        assert.equal(textContent(messages[0].content), textContent(original.content));
        assert.deepEqual(messages[0].details, original.details, 'Provider deduplication cannot rewrite the persisted source/projection proof');
      }
      if (codemode) {
        const delivered = archive.entries.findIndex(entry => entry.type === 'message' && entry.message?.toolCallId === 'sc26-use');
        assert.ok(delivered >= 0);
        const active = archive.entries.flatMap((entry, index) => entry.type === 'custom' && entry.customType === 'context-broker-active-sources' ? [index] : []);
        assert.ok(active.length > 0 && active.every(index => index > delivered), 'Actual active state is created only after top-level use has delivered its complete closure');
        preparation.code_mode.active_only_after_top_level_delivery = true;
      }
      const { originalToolResults: _original, ...publicEvidence } = preparation;
      await save(join(output, 'prepare-projection.json'), { ...publicEvidence, original_session_preserved: true });
    }
    if (resourceBatchEvidence) {
      for (const original of resourceBatchEvidence.originalToolResults) {
        const messages = archive.messages.filter(message => message.role === 'toolResult' && message.toolName === original.toolName && message.toolCallId === original.toolCallId);
        assert.equal(messages.length, 1, 'Each original batch result remains in the actual session');
        assert.equal(textContent(messages[0].content), textContent(original.content));
        assert.deepEqual(messages[0].details, original.details, 'Provider deduplication must preserve the original stored byte proof');
      }
      assert.equal(archive.entries.filter(entry => entry.type === 'custom' && entry.customType === 'context-broker-active-sources').length, 0,
        'Native inspection and resource batches cannot activate a use graph');
      const { originalToolResults: _original, ...publicEvidence } = resourceBatchEvidence;
      await save(join(output, 'resource-batch-projection.json'), { ...publicEvidence, original_session_preserved: true });
      serializer = await replayPreparationHttp(serializerContext, info, output, 'resource-batch');
    }
    if (resourceScalarEvidence) {
      for (const original of resourceScalarEvidence.originalToolResults) {
        const messages = archive.messages.filter(message => message.role === 'toolResult' && message.toolCallId === original.toolCallId);
        assert.equal(messages.length, 1, 'The real resumed/new Pi session retains every scalar result exactly once');
        assert.deepEqual(messages[0].content, original.content); assert.deepEqual(messages[0].details, original.details);
      }
      resourceScalarEvidence.session_state = assertResourceScalarSession(archive.entries, { batch: info.resourceBatch });
    }
    if (nativeRepeatEvidence) {
      for (const original of nativeRepeatEvidence.originalToolResults) {
        const messages = archive.messages.filter(message => message.role === 'toolResult' && message.toolCallId === original.toolCallId);
        assert.equal(messages.length, 1); assert.deepEqual(messages[0].content, original.content);
        if (messages[0].structuredContent !== undefined) assert.deepEqual(messages[0].structuredContent, original.structuredContent);
        assert.deepEqual(messages[0].details, original.details, 'Provider confirmation projection cannot rewrite the persisted native result');
      }
      const custom = archive.entries.filter(entry => entry.type === 'custom');
      assert.equal(custom.filter(entry => entry.customType === 'context-broker-active-sources').length, 0);
      assert.equal(bodyCount({ messages: archive.messages }, info.resourceBatch.main), 2, 'The session retains both original main results');
      assert.equal(bodyCount({ messages: archive.messages }, info.resourceBatch.files.find(file => file.path === repeatPlan.resource_path).content), 2);
      const { originalToolResults: _original, ...publicEvidence } = nativeRepeatEvidence;
      await save(join(output, 'native-repeat-projection.json'), { ...publicEvidence, original_session_preserved: true, original_session_preserved_fields: ['content', 'details'],
        session_state: { active_entries: 0, selected_graph_entries: custom.filter(entry => entry.customType === 'context-broker-selected-graph').length,
          main_deliveries: archive.messages.filter(message => message.details?.contextBrokerRead).length,
          main_content_copies: bodyCount({ messages: archive.messages }, info.resourceBatch.main),
          resource_content_copies: bodyCount({ messages: archive.messages }, info.resourceBatch.files.find(file => file.path === repeatPlan.resource_path).content),
          structured_content_present: archive.messages.filter(message => nativeRepeatEvidence.originalToolResults.some(original => original.toolCallId === message.toolCallId)
            && message.structuredContent !== undefined).map(message => message.toolCallId) } });
    }
    if (entrypointEvidence) {
      for (const original of entrypointEvidence.originalToolResults) {
        const messages = archive.messages.filter(message => message.role === 'toolResult' && message.toolName === original.toolName && message.toolCallId === original.toolCallId);
        assert.equal(messages.length, 1, 'The actual Pi session retains each entrypoint/resource result');
        assert.equal(textContent(messages[0].content), textContent(original.content));
        assert.deepEqual(messages[0].details, original.details);
      }
      assert.equal(archive.entries.filter(entry => entry.type === 'custom' && entry.customType === 'context-broker-active-sources').length, 0,
        'A fixed main inspection and its resource read cannot activate a use graph');
      const sample = info.entrypoint, selected = sample.files.find(file => file.role === 'selected');
      const objectReads = assertObjectReadEvidence(await rows(ledger), { selected: [sample.main_file, selected],
        forbidden: sample.files.filter(file => file.role !== 'selected'), requiredPid: rpc.lifecycle[0].pid });
      assert.deepEqual(objectReads.object_sha256s, [sample.main_file.sha256, selected.sha256].sort());
      const { originalToolResults: _original, ...publicEvidence } = entrypointEvidence;
      await save(join(output, 'partial-entrypoint-evidence.json'), { ...publicEvidence, object_reads: objectReads, original_session_preserved: true });
    }
    const captures = await rows(providerFile), hooks = await rows(hookFile);
    for (const capture of captures) assert.deepEqual(hooks.filter(hook => hook.requestId === capture.requestId).map(hook => hook.phase), ['payload_start', 'payload_end', 'response_end']);
    assert.equal(new Set(captures.map(capture => capture.requestId)).size, captures.length);
    const guidance = captures.map(capture => ({ request_id: capture.requestId, ...assertNativeGuidance(capture.context, env.SC10_PI_BUNDLED_CLI) }));
    await save(join(output, 'guidance.json'), guidance);
    const compactScenarios = ['default-view', 'codemode-hidden', 'codemode-truncated', 'dollar', 'native', 'native-repeat', 'prepare', 'resource-batch', 'resource-batch-short-refs', 'partial-entrypoint'];
    if (compactScenarios.includes(name)) {
      const search = captures.flatMap(capture => {
        const message = toolResult(capture.context, 'sc10-search');
        return message ? [{ request_id: capture.requestId, ...assertSearchProjection(message, { expectCompact: expectCompactContext, scope: info.fixture.scope }) }] : [];
      });
      assert.ok(search.length > 0);
      await save(join(output, 'compact-context.json'), { expected: expectCompactContext,
        status: expectCompactContext ? 'verified' : 'not_required_for_baseline', search,
        ...(dollarProjection ? { dollar: dollarProjection } : {}), ...(nativeProjection ? { native: nativeProjection } : {}),
        restart_restore: 'not_exercised_by_this_scenario' });
      serializer = await replayScenarioHttp(captures, codemode ? rpc.frames.filter(frame => !frame.parentToolCallId) : rpc.frames, info, output, { preparation: Boolean(preparation) });
      if (name === 'dollar') {
        assert.deepEqual(serializer.sequence.map(call => call.tool_call_id), ['sc10-search']);
        assert.equal(captures.length, 3, 'Metadata discovery and dollar activation retain the original two-prompt scenario');
      }
    }
    if (scalarScenario) {
      serializer = await replayScenarioHttp(captures, rpc.frames, info, output);
      assert.equal(serializer.provider_requests, 6); assert.equal(serializer.tool_rounds, 5); assert.equal(serializer.tool_calls, 5);
      assert.deepEqual(serializer.sequence.map(call => call.tool_call_id), scalarCalls.map(call => call.id));
    }
    const observations = reconcile(await rows(ledger), rpc.lifecycle, { bodyTransportRequired: !['scoped-command', 'default-view'].includes(name) });
    if (nativeRepeatEvidence) {
      assert.equal(serializer.provider_requests, 6); assert.equal(serializer.tool_rounds, 5); assert.equal(serializer.tool_calls, 5);
      assert.equal(observations.sdk_resource_batches, 0);
    }
    if (resourceBatchEvidence) {
      assert.equal(observations.sdk_body_calls, shortResourceRefs ? 3 : 2); assert.equal(observations.sdk_resource_batches, 2);
      assert.equal(observations.sdk_consumes, shortResourceRefs ? 1 : 0); assert.equal(observations.sdk_reads, 0);
    }
    if (resourceScalarEvidence) {
      const materialized = await inventory(source.cacheDir);
      await save(join(output, 'resource-scalar-cache.json'), materialized);
      const cost = assertResourceScalarCost(await rows(ledger), materialized, observations,
        { batch: info.resourceBatch, requiredPid: rpc.lifecycle[0].pid, expectDirect: expectDirectScalar });
      for (const file of cost.metadata_index_files) {
        const bytes = await readFile(join(source.cacheDir, file.path));
        assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
        assert.equal(bytes.includes(Buffer.from(info.resourceBatch.main)), false, 'Metadata index stubs must not contain the main instructions');
      }
      cost.metadata_index_main_content_copies = 0;
      for (const file of cost.resources) {
        const bytes = await readFile(join(source.cacheDir, file.materialized_paths[0]));
        assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
        const target = join(output, 'resource-scalar-files', file.path); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
      }
      const { originalToolResults: _original, ...publicEvidence } = resourceScalarEvidence;
      const intervals = expectDirectScalar ? assertScalarReadObjectIntervals(await rows(ledger), { calls: scalarCalls, requiredPid: rpc.lifecycle[0].pid }) : undefined;
      await save(join(output, 'resource-scalar-evidence.json'), { ...publicEvidence, cost, ...(intervals ? { sdk_object_intervals: intervals } : {}), original_session_preserved: true,
        native_resource_files_retained: true, all_provider_requests_serialized: true });
    }
    const result = { name, status: 'passed', provider_requests: captures.length, public_provider_hooks: true,
      source_command_configured: false, short_refs: name === 'scoped-command' ? 'not_applicable_metadata_query'
        : scalarScenario ? scalarShortRefs ? 'verified_persisted_resources' : 'not_exercised_canonical_resources'
        : expectShortRefs ? resourceScenario && !shortResourceRefs ? 'verified_discovery_only' : 'verified' : 'not_required_for_baseline',
      ...(resourceScenario ? { resource_request_refs: shortResourceRefs ? 'session_short_resources' : 'canonical_fixed', short_resource_handles: shortResourceRefs ? 'verified' : 'not_exercised' } : {}),
      ...(scalarScenario ? { resource_request_refs: scalarShortRefs ? 'persisted_session_short_resources' : 'canonical_fixed',
        scalar_resource: expectDirectScalar ? 'direct_read_without_main_verified' : 'baseline_costs_recorded',
        read_output_proof_version: info.runtime.read_output_proof_version ?? null, scalar_evidence: 'resource-scalar-evidence.json' } : {}),
      discovery_failures: discovery?.failures ?? null, native_guidance_without_cli_templates: true, observer_finality: finality?.complete === true,
      session_archive_files: archive?.files.length ?? 0, preparation_projection: preparation ? 'verified' : 'not_applicable',
      code_mode: preparation?.code_mode ?? null,
      resource_batch_projection: resourceBatchEvidence ? 'verified' : 'not_applicable',
      native_repeat_projection: nativeRepeatEvidence ? expectShortConfirmations ? 'short_confirmations_verified' : 'baseline_long_confirmations_recorded' : 'not_applicable',
      partial_entrypoint: entrypointEvidence ? 'verified_selected_bytes_with_full_directory' : 'not_applicable',
      compact_context: compactScenarios.includes(name) ? expectCompactContext ? 'verified' : 'not_required_for_baseline' : 'not_exercised',
      serializer_http_replay: serializer ? { status: serializer.status, request_bytes: serializer.request_bytes,
        requests: serializer.provider_requests ?? 1, ...(serializer.sequence ? { tool_rounds: serializer.tool_rounds, tool_calls: serializer.tool_calls,
          all_provider_requests_serialized: serializer.all_provider_requests_serialized, evidence: 'provider-http.json' } : {}), production_network: false } : null,
      default_view: defaultViewEvidence ? 'verified' : 'not_exercised', ...observations };
    await save(join(output, 'result.json'), result); return result;
  } catch (error) {
    const result = { name, status: 'failed', observer_finality: finality?.complete === true, error: failed ?? { code: error.code ?? error.name, message: String(error.message) } };
    await save(join(output, 'result.json'), result); return result;
  }
}

export function liveSourceMetrics(events) {
  const ends = events.filter(event => event.kind === 'sdk' && event.event === 'end');
  assert.ok(ends.length > 0, 'A live observation cannot infer zero requests from an empty ledger');
  const attempts = ends.flatMap(event => {
    assert.equal(event.status, 'completed'); assert.equal(event.metrics_observed, true);
    assert.equal(event.request_metrics?.complete, true);
    const attempts = event.request_metrics.trace.filter(item => item.event === 'attempt');
    assert.equal(attempts.length, event.request_metrics.total_requests, 'Every completed SDK call must account for every actual HTTP attempt');
    return attempts.map(item => ({ sdk_id: event.id, operation: event.operation, ...item }));
  });
  const categories = Object.fromEntries(['notion_metadata', 'notion_body', 'notion_write', 'provider'].map(kind => [kind, attempts.filter(item => item.request_kind === kind).length]));
  assert.equal(Object.values(categories).reduce((total, count) => total + count, 0), attempts.length);
  const bytes = key => attempts.every(item => Number.isSafeInteger(item[key]) && item[key] >= 0)
    ? attempts.reduce((total, item) => total + item[key], 0) : null;
  return { attempts: attempts.length, request_bytes: bytes('request_bytes'), response_bytes: bytes('response_bytes'), categories,
    body_kinds: Object.fromEntries(['current_body', 'retained_body', 'unclassified_body'].map(kind => [kind, attempts.filter(item => item.body_kind === kind).length])),
    trace: attempts, observation: 'Completed installed SDK calls and full actual HTTP attempt traces; retries are counted individually' };
}

async function liveScenario(info, scratch, evidence) {
  const name = 'live-notion', base = join(scratch, name), output = join(evidence, name);
  await mkdir(base); await mkdir(output, { mode: 0o700 });
  const agentDir = join(base, 'agent'), sessions = join(base, 'sessions');
  await mkdir(join(agentDir, 'context-broker'), { recursive: true }); await mkdir(sessions);
  const source = { type: 'notion', ...info.live.source, namespace: info.live.source.id,
    cacheDir: join(base, 'broker-cache'), prefetch: false };
  assert.equal(Object.hasOwn(source, 'command'), false);
  const config = join(agentDir, 'context-broker/config.yml');
  await save(config, { sources: [source] }); await save(join(output, 'source.json'), source);
  await save(join(agentDir, 'settings.json'), { packages: [info.packageRoot] });
  const providerFile = join(output, 'provider.jsonl'), hookFile = join(output, 'provider-hooks.jsonl'), ledger = join(output, 'observer.jsonl');
  const toolPlan = join(base, 'tool-plan.json'), preload = join(base, 'observer.mjs');
  await save(toolPlan, { mode: 'complete' });
  const fakeProvider = await provider(base); await observer(preload);
  const env = isolatedEnv({ base, agentDir, NOTION_API_TOKEN: process.env.NOTION_API_TOKEN,
    NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000', CONTEXT_BROKER_HOST: 'pi', CONTEXT_BROKER_CONFIG: config,
    CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: providerFile, CONTEXT_BROKER_LOG_FILE: join(output, 'decisions.jsonl'),
    BROKER_E2E_PROCESS_LEDGER: join(output, 'owned-processes.jsonl'), SC10_PI_TOOL_PLAN: toolPlan,
    SC10_PI_PROVIDER_HOOKS: hookFile, SC10_PI_OBSERVER: ledger, SC08_PI_LIFECYCLE: '1',
    SC13_PI_OBJECT_ROOT: join(base, 'ntn/state/objects'),
    SC10_PI_BUNDLED_CLI: join(info.packageRoot, 'dist/ntn-skills.mjs'), NODE_OPTIONS: '--import=' + preload });
  const roots = [env.NTN_SKILLS_HOME, env.NTN_SKILLS_CONFIG_HOME, env.NTN_SKILLS_CACHE_HOME, env.NTN_SKILLS_DATA_HOME, source.cacheDir];
  for (const root of roots) await assert.rejects(lstat(root), { code: 'ENOENT' }, 'Live consumer state must start absent');
  assert.deepEqual(await readdir(sessions), []);
  const before = await inventory(base);
  for (const file of before) for (const body of [...info.bodies.values(), info.resource.content])
    assert.equal((await readFile(join(base, file.path))).includes(Buffer.from(body)), false, 'Observer oracle bytes must never seed the consumer');
  await save(join(output, 'cold-start.json'), { absent_roots: roots, empty_sessions: sessions, setup_files: before,
    credentials: 'Inherited local NOTION_API_TOKEN only; no copied auth/config/cache/body', oracle_in_consumer: false });
  const argv = ['--session-dir', sessions, '--tools', nativeTools.join(','), '-e', fakeProvider, '--model', 'context-broker-e2e/fake'];
  await save(join(output, 'launch.json'), { host: info.host, argv, cwd: base, settings_packages: [info.packageRoot],
    source_command_configured: false, target_extension_injected: false, observation_extensions: [fakeProvider, preload] });
  let rpc, failed, finality, beforeClose, defaultView, preparation, resourceProof, autoload, ordinaryBoundary;
  try {
    rpc = await startRpc({ host: info.live.host.path, args: argv, cwd: base, env, timeoutMs: 180000 });
    const commands = await rpc.command('get_commands'); await save(join(output, 'registered-commands.json'), commands);
    const registrations = commands.commands.filter(command => command.name === 'context-broker');
    assert.equal(registrations.length, 1); assert.equal(registrations[0].source, 'extension');
    assert.equal(registrations[0].sourceInfo.origin, 'package'); assert.equal(registrations[0].sourceInfo.scope, 'user');
    assert.equal(await realpath(registrations[0].sourceInfo.baseDir), info.packageRoot);
    assert.equal(await realpath(registrations[0].sourceInfo.source), info.packageRoot);
    const actual = await realpath(registrations[0].sourceInfo.path), actualHash = hash(await readFile(actual));
    assert.equal(actual, await realpath(info.extension), 'The auto-loaded Broker must be this independent installed package');
    assert.ok(info.published.some(file => resolve(info.packageRoot, file.path) === actual && file.sha256 === actualHash));
    autoload = { registration: registrations[0], actual_entry: actual, sha256: actualHash, injected_by_cli: false };
    await rpc.prompt('Reply briefly to this ordinary greeting. No Skill is needed.');
    const deadline = Date.now() + 120000;
    while (!(await rows(ledger)).some(event => event.kind === 'sdk_catalog' && event.value?.view?.id === info.catalog.view.id)) {
      assert.ok(Date.now() < deadline, 'Live Default View metadata did not become available');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    // SDK completion precedes metadata-index publication. The existing public
    // no-argument view command reads local status without refreshing or selecting.
    const publication = [];
    for (;;) {
      assert.ok(Date.now() < deadline, 'Broker Default View publication did not complete');
      const start = rpc.frames.length, acknowledgment = await rpc.command('prompt', { message: '/context-broker view' });
      assert.equal(acknowledgment?.disposition, 'handled');
      const notifications = rpc.frames.slice(start).filter(frame => frame.type === 'extension_ui_request' && frame.method === 'notify').flatMap(strings);
      publication.push({ at: new Date().toISOString(), command: '/context-broker view', notifications });
      assert.equal(notifications.some(text => text.includes('default View failed')), false);
      if (notifications.some(text => text.startsWith(source.id + ':') && text.includes('(' + info.catalog.view.id + ')')
        && text.includes(' · ' + info.catalog.count + ' Skill/Router · ') && !text.includes('partial'))) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await save(join(output, 'startup-publication.json'), { boundary: 'Read-only public host status after SDK catalog, before the next provider request', observations: publication });
    await rpc.prompt('Continue the ordinary conversation. No Skill body is needed.');
    const ordinary = await rows(providerFile), initialEvents = await rows(ledger);
    assert.equal(ordinary.length, 2); assert.equal(rpc.frames.filter(frame => frame.type === 'tool_execution_start').length, 0);
    defaultView = assertDefaultViewProjection(ordinary, undefined, initialEvents, info.fixture, info.bodies, { sourceId: source.id });
    assert.ok(['pending', 'ready'].includes(defaultView.provider_requests[0].state), 'Startup exposes its actual pending or complete ready state');
    defaultView.read_schema = assertResourceReadSchema(ordinary.at(-1).context);
    defaultView.guidance = assertNativeGuidance(ordinary.at(-1).context, env.SC10_PI_BUNDLED_CLI);
    assert.equal(liveSourceMetrics(initialEvents).categories.notion_body, 0, 'Ordinary startup must not read source bodies');
    assert.equal(initialEvents.filter(event => event.kind === 'sdk' && event.event === 'start' && event.operation !== 'list').length, 0);
    ordinaryBoundary = initialEvents.at(-1).sequence;
    await save(join(output, 'default-view.json'), defaultView);
    await save(toolPlan, { mode: 'live-consume', owner: info.root.record.name, source: source.id, resource_path: info.resource.path });
    await rpc.prompt('Find and use ' + info.root.record.name + ' with its complete Requires. Then read the returned ' + info.resource.path + ' resource.');
    let captures = await rows(providerFile);
    const used = captures.find(capture => toolResult(capture.context, 'live-use'));
    const read = captures.find(capture => toolResult(capture.context, 'live-resource'));
    assert.ok(used && read);
    preparation = assertPreparedProjection(toolResult(used.context, 'live-use'),
      { snapshots: info.snapshots, bodies: info.bodies, roots: [info.root.record.name] });
    for (const body of info.bodies.values()) assert.equal(bodyCount(used.context, body), 1, 'The next actual provider receives every complete root/Requires body');
    const resourceCall = rpc.frames.find(frame => frame.type === 'tool_execution_start' && frame.toolCallId === 'live-resource');
    const call = { id: 'live-resource', args: resourceCall.args, expectedText: info.resource.content, completeText: true, file: info.resource };
    resourceProof = assertResourceScalarResult(toolResult(read.context, call.id), { batch: { snapshot: info.root }, call });
    assert.equal(bodyCount(read.context, info.resource.content), 1);
    await save(toolPlan, { mode: 'complete' });
    await rpc.prompt('Continue the ordinary task using the instructions and resource already delivered.');
    captures = await rows(providerFile);
    for (const body of [...info.bodies.values(), info.resource.content]) assert.equal(bodyCount(captures.at(-1).context, body), 1, 'Ordinary continuation retains one complete copy');
    assert.deepEqual(rpc.frames.filter(frame => frame.type === 'tool_execution_start').map(frame => frame.toolName), ['notion_list', 'notion_use', 'read']);
    const events = await rows(ledger), reads = events.filter(event => event.kind === 'sdk' && event.operation === 'read');
    assert.equal(reads.length, 2); assert.equal(reads[1].request_metrics.total_requests, 0, 'A fixed resource must not prepare or fetch the main again');
    const readInterval = events.filter(event => event.sequence >= reads[0].sequence && event.sequence <= reads[1].sequence);
    const resourceCost = assertScalarReadObjectIntervals(readInterval, { calls: [call], requiredPid: rpc.lifecycle[0].pid });
    await save(join(output, 'delivery.json'), { preparation, resource: resourceProof, resource_cost: resourceCost,
      returned_reference: resourceCall.args.path, fixed_canonical: info.resource.ref, continuation_complete_copies: 1,
      oracle: info.live.oracle, observer_only: true });
    beforeClose = await waitForSourceFinality(ledger, rpc.lifecycle[0].pid); assert.ok(beforeClose.complete);
    await rpc.closeInput();
  } catch (error) {
    failed = { code: error.code ?? error.name, message: String(error.message) };
    if (rpc) { beforeClose ??= await waitForSourceFinality(ledger, rpc.lifecycle[0].pid); await rpc.stop().catch(() => {}); }
  } finally {
    if (rpc) {
      finality = await waitForSourceFinality(ledger, rpc.lifecycle[0].pid, { hostClosed: true });
      await save(join(output, 'observer-finalization.json'), { before_close: beforeClose, after_close: finality });
      await save(join(output, 'rpc.json'), rpc.frames); await save(join(output, 'rpc-lifecycle.json'), rpc.lifecycle);
      await archiveSessions(sessions, output);
    }
  }
  try {
    if (failed) throw new Error(failed.message);
    assert.equal(finality?.complete, true);
    const events = await rows(ledger), captures = await rows(providerFile), hooks = await rows(hookFile);
    for (const capture of captures) {
      assert.deepEqual(hooks.filter(hook => hook.requestId === capture.requestId).map(hook => hook.phase), ['payload_start', 'payload_end', 'response_end']);
      assert.deepEqual(currentProviderTools(capture.context).map(tool => tool.name).sort(), [...nativeTools].sort());
    }
    const observations = reconcile(events, rpc.lifecycle, { sourceMode: 'live' });
    assert.equal(observations.sdk_consumes, 1); assert.equal(observations.sdk_reads, 1); assert.equal(observations.sdk_resource_batches, 0);
    const metrics = liveSourceMetrics(events); assert.ok(metrics.categories.notion_body > 0);
    assert.equal(metrics.categories.notion_write, 0); assert.equal(metrics.categories.provider, 0);
    assert.notEqual(metrics.request_bytes, null); assert.notEqual(metrics.response_bytes, null);
    await save(join(output, 'source-metrics.json'), { ...metrics, ordinary_end_sequence: ordinaryBoundary });
    const serializer = await replayScenarioHttp(captures, rpc.frames, info, output, { preparation: true });
    for (const identity of [...Object.values(info.live.oracle), ...info.live.sentinels]) await frozenBytes(identity);
    const result = { name, status: 'passed', acceptance: 'partial_until_source_attribution', observer_finality: true, live_notion: 'verified', real_model: 'not_run',
      default_view: 'verified', default_records: info.catalog.count, source_command_configured: false, prefetch: false,
      cold_consumer: true, autoload, preparation_projection: 'verified', resource_projection: 'verified',
      source_metrics: { ...metrics, trace: undefined }, ...observations, provider_requests: captures.length,
      serializer_http_replay: { status: serializer.status, request_bytes: serializer.request_bytes, requests: serializer.provider_requests },
      unselected_members: { count: info.unselected.length, source_body_exclusion: 'pending_independent_retained_source_attribution',
        proof_boundary: 'Provider delivery and fixed identity passed; this route alone does not establish retained chunk ownership' } };
    await save(join(output, 'result.json'), result); return result;
  } catch (error) {
    const result = { name, status: 'failed', observer_finality: finality?.complete === true, error: failed ?? { code: error.code ?? error.name, message: String(error.message) } };
    await save(join(output, 'result.json'), result); return result;
  }
}

async function retained(evidence, cleanup) {
  const report = await json(join(evidence, 'report.json')), ownership = await json(join(evidence, 'ownership.json'));
  assert.notEqual(report.evidence_stable, false, 'Owned observer terminal is unresolved; this evidence is not sealed or eligible for cleanup');
  const before = await json(join(evidence, 'retained.json'));
  for (const entry of before) assert.equal(hash(await readFile(join(evidence, entry.path))), entry.sha256, entry.path);
  if (cleanup) {
    assert.equal(report.scratch, ownership.scratch); assert.equal(await realpath(ownership.evidence), evidence);
    assert.ok(ownership.scratch.startsWith(await systemTempRoot() + '/notion-sdk-pi-'));
    const plan = await json(join(evidence, 'plan.json'));
    const allowed = plan.input_mode === 'live_notion_sdk' ? ['live-notion'] : scenarioNames;
    assert.ok(Array.isArray(plan.scenarios) && plan.scenarios.length > 0 && plan.scenarios.every(name => allowed.includes(name)));
    assert.equal(new Set(plan.scenarios).size, plan.scenarios.length);
    for (const name of plan.scenarios) {
      const processes = name === 'session-lifecycle' ? await json(join(evidence, name, 'rpc-processes.json'))
        : [{ lifecycle_file: 'rpc-lifecycle.json', observer_file: 'observer.jsonl' }];
      assert.ok(processes.length > 0);
      for (const process of processes) {
        assert.match(process.lifecycle_file, /^rpc-lifecycle(?:-[a-z]+)?\.json$/u);
        assert.match(process.observer_file, /^observer(?:-[a-z]+)?\.jsonl$/u);
        const lifecycle = await json(join(evidence, name, process.lifecycle_file));
        assert.equal(lifecycle.filter(event => event.event === 'spawn').length, 1);
        assert.equal(lifecycle.filter(event => event.event === 'close').length, 1);
        const observed = await rows(join(evidence, name, process.observer_file));
        assert.equal(sourceFinality(observed, lifecycle[0].pid, { hostClosed: true }).complete, true);
      }
    }
    try { await lstat(ownership.scratch); await runCommand('/usr/bin/trash', [ownership.scratch], { cwd: evidence, env: process.env, timeoutMs: 30000 }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await assert.rejects(lstat(ownership.scratch), { code: 'ENOENT' }, 'Cleanup must actually remove the owned scratch from its original location');
    await save(join(evidence, 'cleanup.json'), { status: 'trashed', scratch: ownership.scratch, evidence_preserved: true });
    for (const entry of before) assert.equal(hash(await readFile(join(evidence, entry.path))), entry.sha256, entry.path);
  }
  console.log(JSON.stringify({ status: 'preserved', functional_status: report.status, cleanup, evidence, retained_files: before.length }));
}
async function main(argv) {
const args = [...argv];
if (args.some(value => ['--help', '-h', 'help'].includes(value))) { console.log(usage); return; }
const action = args.shift();
assert.ok(['doctor', 'run', 'evidence', 'cleanup'].includes(action), usage);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  const key = args[index], value = args[index + 1];
  assert.ok(['--package', '--fixture', '--live-input', '--out', '--evidence', '--expect-short-refs', '--expect-compact-context', '--expect-direct-scalar', '--expect-short-confirmations', '--scenario'].includes(key) && value && !Object.hasOwn(options, key), usage);
  if (['--expect-short-refs', '--expect-compact-context', '--expect-direct-scalar', '--expect-short-confirmations'].includes(key)) assert.ok(['true', 'false'].includes(value), usage);
  else if (key === '--scenario') assert.ok(value === 'all' || scenarioNames.includes(value), usage);
  else assert.ok(isAbsolute(value), usage);
  options[key] = value;
}
if (action === 'evidence' || action === 'cleanup') {
  assert.ok(options['--evidence'], usage); await retained(await realpath(options['--evidence']), action === 'cleanup');
} else {
  if (options['--live-input']) assert.equal(options['--scenario'], undefined, 'Explicit live input selects one separate live-notion route; offline all remains unchanged');
  const info = await inspect(options);
  if (action === 'doctor') console.log(JSON.stringify({ status: 'ready', node: process.version, pi: info.pi.version, host: info.host, extension: info.extension, runtime: info.runtime, serializer: info.serializerIdentity,
    fixture: options['--fixture'], live_input: options['--live-input'], authentication: 'not_probed',
    source: info.live ? 'Real Notion; local private oracle never seeds the consumer' : 'controlled offline catalog and snapshots',
    ...(info.live ? { artifact: info.live.artifact, installed_files: info.published, oracle: info.live.oracle, expected_default_records: info.catalog.count } : {}),
    default_view: 'not_verified' }, null, 2));
  else {
    assert.ok(options['--out'], usage);
    await mkdir(options['--out'], { mode: 0o700 });
    const evidence = await realpath(options['--out']);
    const scratch = await mkdtemp(join(await systemTempRoot(), 'notion-sdk-pi-'));
    await save(join(evidence, 'ownership.json'), { version: 1, evidence, scratch });
    const before = await productInventory(info.packageRoot);
    await save(join(evidence, 'package-before.json'), before);
    const expectShortRefs = options['--expect-short-refs'] !== 'false';
    const expectCompactContext = options['--expect-compact-context'] !== 'false';
    const expectDirectScalar = options['--expect-direct-scalar'] !== 'false';
    const expectShortConfirmations = options['--expect-short-confirmations'] !== 'false';
    const scenarios = info.live ? ['live-notion'] : options['--scenario'] && options['--scenario'] !== 'all' ? [options['--scenario']] : scenarioNames;
    await save(join(evidence, 'plan.json'), { version: 1, node: process.version, pi: info.pi.version, package: info.packageRoot, runtime: info.runtime, extension: info.extension, serializer: info.serializerIdentity,
      fixture: options['--fixture'], driver_sha256: hash(await readFile(fileURLToPath(import.meta.url))), source_command_configured: false,
      scenarios, expect_short_refs: expectShortRefs, expect_compact_context: expectCompactContext, expect_direct_scalar: expectDirectScalar, expect_short_confirmations: expectShortConfirmations,
      comparison_scope: 'Installed Broker plus bundled CLI/SDK; a changed runtime manifest or bundle hash is a changed comparison input',
      ...(info.live ? { input_mode: 'live_notion_sdk', live_input: options['--live-input'], live_input_sha256: hash(await readFile(options['--live-input'])),
        artifact: info.live.artifact, published_files: info.published, oracle: info.live.oracle, host: info.host } : {}),
      live_notion: info.live ? 'planned' : 'not_run', real_model: 'not_run', default_view: 'not_verified' });
    const results = [];
    for (const name of scenarios) {
      try { results.push(info.live ? await liveScenario(info, scratch, evidence)
        : await scenario(name, info, scratch, evidence, expectShortRefs, expectCompactContext, expectDirectScalar, expectShortConfirmations)); }
      catch (error) { results.push({ name, status: 'failed', error: { code: error.code ?? error.name, message: String(error.message) } }); }
      await save(join(evidence, 'progress.json'), results); console.log(JSON.stringify(results.at(-1)));
    }
    const after = await productInventory(info.packageRoot); await save(join(evidence, 'package-after.json'), after);
    const unchanged = JSON.stringify(after) === JSON.stringify(before);
    const stable = results.every(result => result.observer_finality === true);
    const report = { version: 1, status: unchanged && results.every(result => result.status === 'passed') ? 'passed' : 'failed', package_unchanged: unchanged, evidence_stable: stable, scratch, evidence, results,
      ...(info.live ? { acceptance: 'partial_until_independent_source_attribution' } : {}),
      not_claimed: [...(info.live ? ['Unselected Member source body exclusion without independent retained-source attribution'] : ['Live Notion', 'Cold source cache']),
        'Real model', 'Native menu', ...(results.some(result => result.default_view === 'verified') ? [] : ['Default View']), 'Binary resource as complete text delivery', 'OMP/Tern'] };
    await save(join(evidence, 'report.json'), report);
    await save(join(evidence, stable ? 'retained.json' : 'retained-incomplete.json'), await inventory(evidence));
    console.log(JSON.stringify({ status: report.status, evidence, scratch })); process.exitCode = report.status === 'passed' ? 0 : 1;
  }
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
