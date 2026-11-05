#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs';
import fsPromises, { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, resolveHost, runCommand, writeFakeProvider } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { safeRequestMetrics } from './notion-default-context.mjs';
import { systemTempRoot } from './verification-paths.mjs';
import { verifyPreparationEvidence } from './skill-preparation-evidence.mjs';

const usage = 'Usage: node scripts/notion-sdk-pi.mjs doctor|run --package ABSOLUTE_INSTALLED_BROKER --fixture ABSOLUTE_FIXTURE_JSON [--expect-short-refs true|false] [--scenario all|dollar|native|prepare|scoped-command|resource-batch|resource-batch-short-refs|partial-entrypoint] [--out NEW_ABSOLUTE_EVIDENCE]; evidence|cleanup --evidence ABSOLUTE_EVIDENCE. Real Pi 1.4 RPC, controlled provider with public onPayload/onResponse hooks, offline source, default bundled SDK (source.command is absent). Default View, native menu, live Notion and real model are not claimed.';
const scenarioNames = ['dollar', 'native', 'prepare', 'scoped-command', 'resource-batch', 'resource-batch-short-refs', 'partial-entrypoint'];
const nativeTools = ['read', 'skill_search', 'skill_prepare'];
const scopedCommandTools = [...nativeTools, 'bash', 'skill_graph'];
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
  assert.equal(message?.role, 'toolResult'); assert.equal(message.toolName, 'skill_prepare');
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
  return assertToolHttpRequest(payload, body, context, 'skill_prepare', 'contextBrokerPreparation');
}

export function assertResourceHttpRequest(payload, body, context) {
  return assertToolHttpRequest(payload, body, context, 'read', 'contextBrokerResource');
}

function assertToolHttpRequest(payload, body, context, toolName, proofField) {
  const encoded = Buffer.from(JSON.stringify(payload));
  assert.deepEqual(body, encoded, 'The public serializer hook must match the actual HTTP request bytes');
  assert.ok(Array.isArray(payload.messages));
  const preparations = (context.messages ?? []).filter(message => message.role === 'toolResult' && message.toolName === toolName);
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

async function replayPreparationHttp(context, info, output, kind = 'prepare') {
  const modulePath = await realpath(join(info.piPackageRoot, 'node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js'));
  const packagePath = resolve(dirname(modulePath), '../../package.json'), packageInfo = await json(packagePath);
  assert.equal(packageInfo.name, '@earendil-works/pi-ai'); assert.equal(packageInfo.version, info.pi.version);
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
    const verification = kind === 'prepare' ? assertPreparedHttpRequest(payload, requests[0].body, context) : assertResourceHttpRequest(payload, requests[0].body, context);
    assert.equal(JSON.stringify(context), original, 'Replaying the provider serializer must not mutate the captured transcript');
    await writeFile(join(output, kind + '-serializer-request.json'), requests[0].body, { mode: 0o600 });
    const result = { status: 'passed', boundary: 'Actual Pi capture replayed through installed pi-ai serializer and localhost HTTP; no real model or production API call',
      api_package: { name: packageInfo.name, version: packageInfo.version, path: packagePath },
      serializer: { path: modulePath, sha256: hash(await readFile(modulePath)) }, ...verification,
      response: { status: 200, stop_reason: final.stopReason, source: 'controlled local SSE', usage: 'not_real_model_usage' } };
    await save(join(output, kind + '-serializer.json'), result);
    return result;
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
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
  assert.deepEqual(batch.required, ['paths']); assert.equal(batch.additionalProperties, false);
  assert.deepEqual(Object.keys(batch.properties), ['paths']); assert.deepEqual(batch.properties.paths, paths);
  return { tool: 'read', paths_supported: true, path_and_paths_exclusive: true, batch_range_options: false,
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
  assert.equal(starts[0].toolName, 'skill_graph');
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
  const entries = await inventory(root), messages = [];
  for (const entry of entries) {
    const original = await readFile(join(root, entry.path)), target = join(output, 'sessions', entry.path);
    assert.equal(hash(original), entry.sha256);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, original, { mode: 0o600, flag: 'wx' });
    assert.equal(hash(await readFile(target)), entry.sha256);
    if (entry.path.endsWith('.jsonl')) {
      for (const line of original.toString('utf8').split('\n').filter(Boolean)) {
        const entry = JSON.parse(line);
        if (entry.message) messages.push(entry.message);
      }
    }
  }
  await save(join(output, 'session-archives.json'), { files: entries, preserved: true });
  return { files: entries, messages };
}
async function inspect(options) {
  assert.ok(options['--package'] && options['--fixture'], usage);
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
  const host = await resolveHost('pi');
  let current = dirname(host.identity), pi;
  for (;;) {
    try { const candidate = await json(join(current, 'package.json')); if (candidate.name === '@earendil-works/pi-coding-agent') { pi = candidate; break; } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.notEqual(current, dirname(current), 'Cannot identify installed Pi package'); current = dirname(current);
  }
  assert.match(pi.version, /^1\.4\./u, 'This controlled route is frozen for Pi 1.4');
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
  return { packageRoot, manifest, extension, runtime, host, pi, piPackageRoot: current, fixture, fixtureEnv, bodies, resourceBatch, entrypoint };
}

export function resourceRefsFromInspection(prepared, owner, paths) {
  if (prepared?.status !== 'ready' || prepared.purpose !== 'inspect' || !Array.isArray(prepared.roots) || prepared.roots.length !== 1
    || !Array.isArray(prepared.records) || !Array.isArray(paths) || !paths.length || new Set(paths).size !== paths.length)
    throw new Error('CONTROLLED_RESOURCE_INSPECTION_INVALID');
  const records = prepared.records.filter(record => record.name === owner && record.ref === prepared.roots[0]);
  if (records.length !== 1 || !Array.isArray(records[0].directory?.files)) throw new Error('CONTROLLED_RESOURCE_OWNER_NOT_UNIQUE');
  const refs = paths.map(path => {
    const files = records[0].directory.files.filter(file => file.path === path);
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
  if (plan.mode === 'scoped-command') {
    const scope = find('sc05-source-command');
    if (!scope) return call('sc05-source-command', 'skill_graph', { cli_source: 'sdk-fixture' });
    parsed(scope);
    return null;
  }
  const search = find('sc10-search');
  if (!search) return call('sc10-search', 'skill_search', { query: '', source: 'sdk-fixture', limit: 20 });
  const directory = parsed(search);
  const selected = name => {
    const matches = directory.records.filter(record => record.name === name && record.source === 'sdk-fixture' && record.availability === 'available');
    if (matches.length !== 1) throw new Error('CONTROLLED_DIRECTORY_SELECTION_NOT_UNIQUE');
    return matches[0];
  };
  if (plan.mode === 'search') return null;
  if (plan.mode === 'partial-entrypoint') {
    const owner = selected(plan.owner);
    const main = find('sc13-main');
    if (!main) return call('sc13-main', 'read', { path: plan.fixed_main_ref });
    if (main.isError) throw new Error('CONTROLLED_MAIN_READ_FAILED');
    const inspected = find('sc13-inspect');
    if (!inspected) return call('sc13-inspect', 'skill_prepare', { roots: [owner.ref], purpose: 'inspect' });
    const refs = resourceRefsFromInspection(parsed(inspected), plan.owner, [plan.selected_path]);
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
      if (!inspected) return call('sc07-resource-inspect', 'skill_prepare', { roots: [selected(plan.owner).ref], purpose: 'inspect' });
      refs = resourceRefsFromInspection(parsed(inspected), plan.owner, plan.paths);
    }
    const id = plan.mode === 'resource-batch-repeat' ? 'sc07-resources-repeat' : 'sc07-resources';
    if (!find(id)) return call(id, 'read', { paths: refs });
    parsed(find(id));
    return null;
  }
  if (plan.mode === 'prepare' || plan.mode === 'prepare-repeat') {
    const id = plan.mode === 'prepare' ? 'sc10-prepare' : 'sc05-prepare-repeat';
    if (!find(id)) return call(id, 'skill_prepare', { roots: ['a', 'b', 'c'].map(name => selected(name).ref), purpose: 'use' });
    return null;
  }
  if (plan.mode !== 'native') throw new Error('CONTROLLED_PLAN_INVALID');
  const main = find('sc10-main');
  if (!main) return call('sc10-main', 'read', { path: selected('a').ref });
  if (main.isError) throw new Error('CONTROLLED_MAIN_READ_FAILED');
  let files;
  const footer = /<skill-directory>\s*([\s\S]*?)\s*<\/skill-directory>/u.exec(text(main.content));
  if (footer) files = JSON.parse(footer[1]).directory.files;
  else {
    const inspected = find('sc10-resource-directory');
    if (!inspected) return call('sc10-resource-directory', 'skill_prepare', { roots: [selected('a').ref], purpose: 'inspect' });
    const prepared = parsed(inspected);
    if (prepared.roots.length !== 1) throw new Error('CONTROLLED_INSPECT_ROOT_NOT_UNIQUE');
    files = prepared.records.find(record => record.ref === prepared.roots[0]).directory.files;
  }
  const resources = files.filter(file => file.path !== 'SKILL.md');
  if (resources.length !== 1) throw new Error('CONTROLLED_RESOURCE_SELECTION_NOT_UNIQUE');
  if (!find('sc10-resource')) return call('sc10-resource', 'read', { path: resources[0].ref });
  return null;
}
async function provider(base) {
  const path = await writeFakeProvider(base);
  let source = await readFile(path, 'utf8');
  const replace = (before, after) => { assert.equal(source.split(before).length, 2, 'Provider fixture shape changed'); source = source.replace(before, after); };
  replace('import { appendFileSync }', 'import { appendFileSync, readFileSync }');
  replace('function stream(model, context) {', `${resourceRefsFromInspection.toString()}\n${selectProviderCall.toString()}\nlet nextRequest = 0;\nfunction stream(model, context) {\n  const requestId = String(process.pid) + ':' + String(++nextRequest);\n  const hook = phase => appendFileSync(process.env.SC10_PI_PROVIDER_HOOKS, JSON.stringify({ requestId, phase, pid: process.pid, monotonic_ns: process.hrtime.bigint().toString() }) + '\\n', { mode: 0o600 });`);
  replace('const payload = await options?.onPayload?.({ model: model.id, context }, model);', 'if (typeof options?.onPayload !== "function" || typeof options?.onResponse !== "function") throw new Error("PUBLIC_PROVIDER_HOOKS_REQUIRED");\n      hook("payload_start");\n      const payload = await options.onPayload({ model: model.id, context }, model);\n      hook("payload_end");');
  replace('JSON.stringify({ model: model.id, context })', 'JSON.stringify({ requestId, model: model.id, context })');
  replace('await options?.onResponse?.({ status: 200, headers: { "x-fixture": "deterministic" } }, model);', 'await options.onResponse({ status: 200, headers: { "x-fixture": "deterministic" } }, model);\n      hook("response_end");');
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
  await writeFile(path, `import childProcess from 'node:child_process';\nimport { createHash } from 'node:crypto';\nimport { channel } from 'node:diagnostics_channel';\nimport fs, { appendFileSync } from 'node:fs';\nimport fsPromises from 'node:fs/promises';\nimport { syncBuiltinESMExports } from 'node:module';\n${safeRequestMetrics.toString()}\n${observeOwnedObjectReads.toString()}\n(${observe.toString()})();\n`, { mode: 0o600 });
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

export function reconcile(events, lifecycle, { bodyTransportRequired = true } = {}) {
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
  if (bodyTransportRequired) assert.ok(starts.some(event => event.bundled && event.operation === 'list'), 'Actual bundled catalog CLI must be observed');
  else for (const start of starts) {
    const ctl = start.argv.indexOf('ctl');
    assert.ok(start.bundled && (start.operation === 'list' || start.operation === 'ctl' && start.argv[ctl + 1] === 'cache' && start.argv[ctl + 2] === 'identity'),
      'A scope metadata query may only coexist with the separately accounted background catalog/identity commands');
  }
  for (const start of starts) assert.equal(events.filter(event => event.kind === 'child_close' && event.id === start.id).length, 1);
  assert.equal(events.filter(event => event.kind === 'alternate_child_api').length, 0, 'Unexpected child APIs require explicit accounting');
  assert.equal(starts.filter(event => ['prepare', 'read', 'export'].includes(event.operation)).length, 0, 'Default preparation/resource path must not spawn CLI children');
  const sdk = events.filter(event => event.kind === 'sdk' && event.event === 'start');
  if (bodyTransportRequired) assert.ok(sdk.length > 0, 'An empty SDK observation cannot establish default transport');
  else assert.equal(sdk.length, 0, 'A host-local command metadata query must not consume source bodies');
  let http = 0;
  for (const start of sdk) {
    const ends = events.filter(event => event.kind === 'sdk' && event.event === 'end' && event.id === start.id);
    assert.equal(ends.length, 1); assert.equal(ends[0].status, 'completed'); assert.equal(ends[0].sdk_started, true);
    assert.equal(ends[0].metrics_observed, true); assert.equal(ends[0].request_metrics?.complete, true);
    http += ends[0].request_metrics.total_requests;
  }
  assert.equal(http, 0, 'The controlled SDK source must stay offline');
  const cliCloses = events.filter(event => event.kind === 'child_close');
  return { sdk_calls: sdk.length, sdk_consumes: sdk.filter(event => event.operation === 'consume').length,
    sdk_reads: sdk.filter(event => event.operation === 'read').length, sdk_http: http,
    sdk_resource_batches: sdk.filter(event => event.operation === 'read-resources').length,
    cli_catalog_children: starts.filter(event => event.bundled && event.operation === 'list').length,
    cli_prepare_read_export_children: 0, cli_http: cliCloses.every(event => event.request_metrics?.complete) ? cliCloses.reduce((total, event) => total + event.request_metrics.total_requests, 0) : null,
    observer_processes: chains.size, source_children_closed: starts.length, eof_closed: true,
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

async function scenario(name, info, scratch, evidence, expectShortRefs) {
  const shortResourceRefs = name === 'resource-batch-short-refs';
  const resourceScenario = name === 'resource-batch' || shortResourceRefs;
  const partialEntrypoint = name === 'partial-entrypoint';
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
  if (partialEntrypoint) assert.ok(info.entrypoint, 'The fixture must provide the complete entrypoint scenario');
  const entrypointPlan = partialEntrypoint ? { owner: info.entrypoint.name, fixed_main_ref: info.entrypoint.ref,
    selected_path: info.entrypoint.files.find(file => file.role === 'selected').path } : {};
  await save(toolPlan, { mode: name === 'dollar' ? 'search' : name, ...resourcePlan, ...entrypointPlan });
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
    ...(entrypointSetup ? { SC13_PI_OBJECT_ROOT: entrypointSetup.partial.objects } : {}),
    SC10_PI_BUNDLED_CLI: join(info.packageRoot, 'dist/ntn-skills.mjs'), NODE_OPTIONS: `--import=${preload}` });
  const activeTools = name === 'scoped-command' ? scopedCommandTools : nativeTools;
  const argv = ['--no-extensions', '--session-dir', sessions, '--tools', activeTools.join(','), '-e', fakeProvider, '-e', info.extension, '--model', 'context-broker-e2e/fake'];
  await save(join(output, 'launch.json'), { host: info.host, argv, cwd: base, source_command_configured: false,
    source_state: partialEntrypoint ? 'complete controlled current validated by installed SDK, then owned partial cache; fresh Broker cache and Pi session'
      : 'cloned warm controlled snapshots/current catalog; fresh Broker cache and Pi session', expect_short_refs: expectShortRefs, active_tools: activeTools });
  let rpc, failed, last, discovery, beforeClose, finality, preparation, resourceBatchEvidence, entrypointEvidence, serializerContext, archive;
  try {
    rpc = await startRpc({ host: 'pi', args: argv, cwd: base, env, timeoutMs: 60000 });
    const prompts = {
      dollar: 'Discover the authorized Skill directory for the controlled task.',
      native: 'Inspect the available a Skill and read its advertised resource.',
      prepare: 'Use the available a, b and c Skills together, preparing their required instructions.',
      'resource-batch': 'Read this explicit fixed resource set in one read paths call: ' + JSON.stringify(info.resourceBatch?.refs) + '. Read only those resources without loading or activating the Skill main body.',
      'resource-batch-short-refs': 'Explicitly inspect the resources Skill once. Use its four requested resource handles for ' + JSON.stringify(info.resourceBatch?.files.map(file => file.path)) + ' in one read paths call; preserve that selected owner and snapshot.',
      'partial-entrypoint': 'Read the supplied fixed entrypoint Skill main, inspect its current candidate directory, then read only the advertised selected text resource. Keep the selected owner and snapshot.',
      'scoped-command': 'For the sdk-fixture source, obtain the host-local command prefix and database scope for a possible maintenance action. Return that metadata only; do not execute commands or read Skill bodies.',
    };
    await rpc.prompt(prompts[name]);
    let captures = await rows(providerFile); assert.ok(captures.length >= 2);
    last = captures.at(-1).context;
    if (name !== 'scoped-command') {
      discovery = parsedResult(toolResult(last, 'sc10-search'));
      assert.equal(discovery.ok, true); assert.equal(discovery.count, info.fixture.catalog_records?.length ?? 4);
      for (const record of discovery.records) if (expectShortRefs) assert.match(record.ref, /^sr:C/u);
    }
    if (name === 'dollar') {
      for (const body of info.bodies.values()) assert.equal(bodyCount(last, body), 0, 'Metadata-only discovery must not deliver bodies');
      const selected = discovery.records.filter(record => record.name === 'a' && record.source === source.id);
      assert.equal(selected.length, 1);
      await save(toolPlan, { mode: 'complete' });
      await rpc.prompt(`$${selected[0].name}@${source.namespace} Apply the selected Skill for this controlled task.`);
      captures = await rows(providerFile); last = captures.at(-1).context;
      for (const key of ['a', 'base']) assert.equal(bodyCount(last, info.bodies.get(key)), 1, `${key}: full source body exactly once`);
      for (const key of ['b', 'c']) assert.equal(bodyCount(last, info.bodies.get(key)), 0);
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
      const inspected = toolResult(last, 'sc13-inspect'), inspectedRaw = fromFrame('sc13-inspect');
      const oracle = { snapshots: [sample.snapshot], bodies: new Map([[sample.name, sample.main]]), roots: [sample.name], purpose: 'inspect' };
      const inspection = assertPreparedProjection(inspectedRaw, oracle);
      const providerInspection = assertPreparedProjection(inspected, oracle);
      // Explicit complete instruction deliveries take priority over native read copies.
      assert.deepEqual(inspected.content, inspectedRaw.content);
      assert.deepEqual(inspected.details.contextBrokerPreparation.projection, inspectedRaw.details.contextBrokerPreparation.projection);
      assert.equal(bodyCount({ messages: [main] }, sample.main), 0, 'The native provider copy is replaced after explicit inspection');
      assert.ok(textContent(main.content).endsWith(textContent(mainRaw.content).slice(mainProof.delivery.end)), 'The native fixed directory is preserved');
      const prepared = parsedResult(inspectedRaw), receipt = inspectedRaw.details.contextBrokerPreparation.records[0];
      assert.deepEqual(prepared.records[0].directory.files.map(file => file.path), sample.snapshot.files.map(file => file.path));
      assert.deepEqual(receipt.materialization, { manifest_complete: true, local_files_ready: false,
        materialized_paths: [sample.snapshot.entrypoint], loaded: false });
      const resource = toolResult(last, 'sc13-resource'), resourceRaw = fromFrame('sc13-resource');
      assert.equal(resourceRaw.isError, false); assert.equal(resource.isError, false);
      const resourceProof = resourceRaw.details?.contextBrokerResource;
      assert.ok(resourceProof); assert.equal(resourceProof.id, sample.snapshot.record.id);
      assert.equal(resourceProof.scope, sample.snapshot.scope); assert.equal(resourceProof.snapshot_id, sample.snapshot.snapshot_id);
      assert.equal(resourceProof.version_id, sample.snapshot.version_id); assert.equal(resourceProof.file_id, selected.file_id);
      assert.equal(resourceProof.path, selected.path); assert.equal(resourceProof.bytes, selected.bytes); assert.equal(resourceProof.sha256, selected.sha256);
      assert.equal(resourceProof.delivered_complete_text, true); assert.equal(textContent(resourceRaw.content), selected.content);
      assert.deepEqual(resourceProof.materialization, { manifest_complete: true, local_files_ready: false,
        materialized_paths: [sample.snapshot.entrypoint, selected.path].sort(), loaded: false });
      assert.equal(bodyCount(last, sample.main), 1); assert.equal(bodyCount(last, selected.content), 1);
      const calls = rpc.frames.filter(frame => frame.type === 'tool_execution_start');
      assert.deepEqual(calls.map(call => call.toolCallId), ['sc10-search', 'sc13-main', 'sc13-inspect', 'sc13-resource']);
      assert.deepEqual(calls[1].args, { path: sample.ref });
      const candidate = discovery.records.find(record => record.name === sample.name && record.source === source.id);
      assert.deepEqual(calls[2].args, { roots: [candidate.ref], purpose: 'inspect' });
      assert.deepEqual(calls[3].args, { path: resourceRefsFromInspection(parsedResult(inspected), sample.name, [selected.path])[0] });
      const materialized = await inventory(source.cacheDir);
      for (const file of [sample.main_file, selected]) assert.ok(materialized.some(item => item.path.endsWith('/' + file.path)
        && item.bytes === file.bytes && item.sha256 === file.sha256), file.path + ': exact native materialization');
      for (const file of sample.files.filter(file => file.role !== 'selected'))
        assert.equal(materialized.some(item => item.path.endsWith('/' + file.path)), false, file.path + ': unselected Broker output is absent');
      const partialState = await assertPartialObjectState(entrypointSetup.partial);
      entrypointEvidence = { snapshot_id: sample.snapshot.snapshot_id, main: { bytes: mainProof.bytes, sha256: mainProof.bodySha256 },
        source_state: 'controlled complete validation followed by owned partial cache; no cold-source claim',
        fixed_main_argument: calls[1].args.path, inspected_candidate: candidate.ref,
        directory_files: prepared.records[0].directory.files.length, host_materialization: receipt.materialization,
        inspection, provider_inspection: providerInspection, selected_resource: resourceProof, partial_state: partialState,
        originalToolResults: [mainRaw, inspectedRaw, resourceRaw] };
    } else if (name === 'native') {
      const main = toolResult(last, 'sc10-main'), resource = toolResult(last, 'sc10-resource');
      assert.ok(main && !main.isError); assert.ok(resource && !resource.isError);
      assert.equal(bodyCount(last, info.bodies.get('a')), 1);
      assert.equal(bodyCount(last, info.bodies.get('base')), 0, 'Native inspection must not activate Requires');
      const delivered = resource.details?.contextBrokerResource;
      assert.ok(delivered, 'Resource must have the host owner/version/hash receipt');
      assert.equal(delivered.bytes, info.fixture.resource.bytes); assert.equal(delivered.sha256, info.fixture.resource.sha256);
      const selected = discovery.records.find(record => record.name === 'a' && record.source === source.id);
      const fixed = info.fixture.snapshots.find(snapshot => snapshot.record.id === selected.id);
      assert.equal(delivered.id, selected.id); assert.equal(delivered.scope, info.fixture.scope);
      assert.equal(delivered.snapshot_id, fixed.snapshot_id); assert.equal(delivered.version_id, fixed.version_id);
      assert.equal(delivered.file_id, fixed.file_bindings.find(file => file.path === delivered.path).file_id);
      const frame = rpc.frames.find(frame => frame.type === 'tool_execution_start' && frame.toolCallId === 'sc10-resource');
      if (expectShortRefs) assert.match(frame?.args?.path ?? '', /^sr:R/u);
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
        const oracle = { snapshots: [batch.snapshot], bodies: new Map([[batch.name, batch.main]]), roots: [batch.name], purpose: 'inspect' };
        inspection = assertPreparedProjection(inspected, oracle);
        assert.deepEqual(inspection.content, assertPreparedProjection(inspectedRaw, oracle).content);
        requestedRefs = resourceRefsFromInspection(parsedResult(inspected), batch.name, batch.files.map(file => file.path));
        for (const file of firstProof.files) assert.match(file.ref, /^sr:R[A-Za-z0-9_-]{22}$/u);
      }
      const firstCalls = rpc.frames.filter(frame => frame.type === 'tool_execution_start' && frame.toolName === 'read');
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
      assert.deepEqual(rpc.frames.filter(frame => frame.type === 'tool_execution_start' && frame.toolName === 'read').map(frame => frame.args),
        [{ paths: requestedRefs }, { paths: requestedRefs }], 'The repeated native read retains the exact requested resource set');
      const inspectionCalls = rpc.frames.filter(frame => frame.type === 'tool_execution_start' && frame.toolName === 'skill_prepare');
      assert.equal(inspectionCalls.length, shortResourceRefs ? 1 : 0);
      if (shortResourceRefs) assert.equal(inspectionCalls[0].args.purpose, 'inspect');
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
      await rpc.prompt('Prepare the same a, b and c Skills again with purpose use, keeping their selected versions.');
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
        const messages = archive.messages.filter(message => message.role === 'toolResult' && message.toolName === 'skill_prepare' && message.toolCallId === original.toolCallId);
        assert.equal(messages.length, 1, 'The original session retains each actual tool result');
        assert.equal(textContent(messages[0].content), textContent(original.content));
        assert.deepEqual(messages[0].details, original.details, 'Provider deduplication cannot rewrite the persisted source/projection proof');
      }
      const { originalToolResults: _original, ...publicEvidence } = preparation;
      await save(join(output, 'prepare-projection.json'), { ...publicEvidence, original_session_preserved: true });
      serializer = await replayPreparationHttp(serializerContext, info, output);
    }
    if (resourceBatchEvidence) {
      for (const original of resourceBatchEvidence.originalToolResults) {
        const messages = archive.messages.filter(message => message.role === 'toolResult' && message.toolName === original.toolName && message.toolCallId === original.toolCallId);
        assert.equal(messages.length, 1, 'Each original batch result remains in the actual session');
        assert.equal(textContent(messages[0].content), textContent(original.content));
        assert.deepEqual(messages[0].details, original.details, 'Provider deduplication must preserve the original stored byte proof');
      }
      const { originalToolResults: _original, ...publicEvidence } = resourceBatchEvidence;
      await save(join(output, 'resource-batch-projection.json'), { ...publicEvidence, original_session_preserved: true });
      serializer = await replayPreparationHttp(serializerContext, info, output, 'resource-batch');
    }
    if (entrypointEvidence) {
      for (const original of entrypointEvidence.originalToolResults) {
        const messages = archive.messages.filter(message => message.role === 'toolResult' && message.toolName === original.toolName && message.toolCallId === original.toolCallId);
        assert.equal(messages.length, 1, 'The actual Pi session retains each entrypoint/resource result');
        assert.equal(textContent(messages[0].content), textContent(original.content));
        assert.deepEqual(messages[0].details, original.details);
      }
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
    const observations = reconcile(await rows(ledger), rpc.lifecycle, { bodyTransportRequired: name !== 'scoped-command' });
    if (resourceBatchEvidence) {
      assert.equal(observations.sdk_calls, shortResourceRefs ? 3 : 2); assert.equal(observations.sdk_resource_batches, 2);
      assert.equal(observations.sdk_consumes, shortResourceRefs ? 1 : 0); assert.equal(observations.sdk_reads, 0);
    }
    const result = { name, status: 'passed', provider_requests: captures.length, public_provider_hooks: true,
      source_command_configured: false, short_refs: name === 'scoped-command' ? 'not_applicable_metadata_query' : expectShortRefs ? resourceScenario && !shortResourceRefs ? 'verified_discovery_only' : 'verified' : 'not_required_for_baseline',
      ...(resourceScenario ? { resource_request_refs: shortResourceRefs ? 'session_short_resources' : 'canonical_fixed', short_resource_handles: shortResourceRefs ? 'verified' : 'not_exercised' } : {}),
      discovery_failures: discovery?.failures ?? null, native_guidance_without_cli_templates: true, observer_finality: finality?.complete === true,
      session_archive_files: archive?.files.length ?? 0, preparation_projection: preparation ? 'verified' : 'not_applicable',
      resource_batch_projection: resourceBatchEvidence ? 'verified' : 'not_applicable',
      partial_entrypoint: entrypointEvidence ? 'verified_selected_bytes_with_full_directory' : 'not_applicable',
      serializer_http_replay: serializer ? { status: serializer.status, request_bytes: serializer.request_bytes, requests: 1, production_network: false } : null,
      default_view: 'not_verified', ...observations };
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
    assert.equal(report.scratch, ownership.scratch); assert.equal(ownership.evidence, evidence);
    assert.ok(ownership.scratch.startsWith(await systemTempRoot() + '/notion-sdk-pi-'));
    const plan = await json(join(evidence, 'plan.json'));
    assert.ok(Array.isArray(plan.scenarios) && plan.scenarios.length > 0 && plan.scenarios.every(name => scenarioNames.includes(name)));
    assert.equal(new Set(plan.scenarios).size, plan.scenarios.length);
    for (const name of plan.scenarios) {
      const lifecycle = await json(join(evidence, name, 'rpc-lifecycle.json'));
      assert.equal(lifecycle.filter(event => event.event === 'spawn').length, 1);
      assert.equal(lifecycle.filter(event => event.event === 'close').length, 1);
      const observed = await rows(join(evidence, name, 'observer.jsonl'));
      assert.ok(observed.length); assert.ok(observed.some(event => event.kind === 'observer_end' && event.observer_pid === lifecycle[0].pid && event.active_sdk === 0 && event.active_children === 0));
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
  assert.ok(['--package', '--fixture', '--out', '--evidence', '--expect-short-refs', '--scenario'].includes(key) && value && !Object.hasOwn(options, key), usage);
  if (key === '--expect-short-refs') assert.ok(['true', 'false'].includes(value), usage);
  else if (key === '--scenario') assert.ok(value === 'all' || scenarioNames.includes(value), usage);
  else assert.ok(isAbsolute(value), usage);
  options[key] = value;
}
if (action === 'evidence' || action === 'cleanup') {
  assert.ok(options['--evidence'], usage); await retained(await realpath(options['--evidence']), action === 'cleanup');
} else {
  const info = await inspect(options);
  if (action === 'doctor') console.log(JSON.stringify({ status: 'ready', node: process.version, pi: info.pi.version, host: info.host, extension: info.extension, runtime: info.runtime,
    fixture: options['--fixture'], authentication: 'not_probed', source: 'controlled offline catalog and snapshots', default_view: 'not_verified' }, null, 2));
  else {
    assert.ok(options['--out'], usage);
    const evidence = options['--out']; await mkdir(evidence, { mode: 0o700 });
    const scratch = await mkdtemp(join(await systemTempRoot(), 'notion-sdk-pi-'));
    await save(join(evidence, 'ownership.json'), { version: 1, evidence, scratch });
    const before = await productInventory(info.packageRoot);
    await save(join(evidence, 'package-before.json'), before);
    const expectShortRefs = options['--expect-short-refs'] !== 'false';
    const scenarios = options['--scenario'] && options['--scenario'] !== 'all' ? [options['--scenario']] : scenarioNames;
    await save(join(evidence, 'plan.json'), { version: 1, node: process.version, pi: info.pi.version, package: info.packageRoot, runtime: info.runtime, extension: info.extension,
      fixture: options['--fixture'], driver_sha256: hash(await readFile(fileURLToPath(import.meta.url))), source_command_configured: false,
      scenarios, expect_short_refs: expectShortRefs, live_notion: 'not_run', real_model: 'not_run', default_view: 'not_verified' });
    const results = [];
    for (const name of scenarios) {
      try { results.push(await scenario(name, info, scratch, evidence, expectShortRefs)); }
      catch (error) { results.push({ name, status: 'failed', error: { code: error.code ?? error.name, message: String(error.message) } }); }
      await save(join(evidence, 'progress.json'), results); console.log(JSON.stringify(results.at(-1)));
    }
    const after = await productInventory(info.packageRoot); await save(join(evidence, 'package-after.json'), after);
    const unchanged = JSON.stringify(after) === JSON.stringify(before);
    const stable = results.every(result => result.observer_finality === true);
    const report = { version: 1, status: unchanged && results.every(result => result.status === 'passed') ? 'passed' : 'failed', package_unchanged: unchanged, evidence_stable: stable, scratch, evidence, results,
      not_claimed: ['Live Notion', 'Real model', 'Default View/menu', 'Cold source cache', 'Binary resource as complete text delivery', 'OMP/Tern'] };
    await save(join(evidence, 'report.json'), report);
    await save(join(evidence, stable ? 'retained.json' : 'retained-incomplete.json'), await inventory(evidence));
    console.log(JSON.stringify({ status: report.status, evidence, scratch })); process.exitCode = report.status === 'passed' ? 0 : 1;
  }
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
