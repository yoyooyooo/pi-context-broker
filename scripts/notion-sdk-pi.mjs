#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, resolveHost, runCommand, writeFakeProvider } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { safeRequestMetrics } from './notion-default-context.mjs';
import { systemTempRoot } from './verification-paths.mjs';

const usage = 'Usage: node scripts/notion-sdk-pi.mjs doctor|run --package ABSOLUTE_INSTALLED_BROKER --fixture ABSOLUTE_FIXTURE_JSON [--expect-short-refs true|false] [--out NEW_ABSOLUTE_EVIDENCE]; evidence|cleanup --evidence ABSOLUTE_EVIDENCE. Real Pi 1.4 RPC, controlled provider with public onPayload/onResponse hooks, offline source, default bundled SDK (source.command is absent). Default View, native menu, live Notion and real model are not claimed.';
const scenarioNames = ['dollar', 'native', 'prepare', 'scoped-command'];
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
function bodyCount(context, body) { return strings(context.messages).reduce((total, text) => total + text.split(body).length - 1, 0); }

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
  return { packageRoot, manifest, extension, runtime, host, pi, fixture, fixtureEnv, bodies };
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
  if (plan.mode === 'prepare') {
    if (!find('sc10-prepare')) return call('sc10-prepare', 'skill_prepare', { roots: ['a', 'b', 'c'].map(name => selected(name).ref), purpose: 'use' });
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
    files = parsed(inspected).records.find(record => record.id === selected('a').id).directory.files;
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
  replace('function stream(model, context) {', `${selectProviderCall.toString()}\nlet nextRequest = 0;\nfunction stream(model, context) {\n  const requestId = String(process.pid) + ':' + String(++nextRequest);\n  const hook = phase => appendFileSync(process.env.SC10_PI_PROVIDER_HOOKS, JSON.stringify({ requestId, phase, pid: process.pid, monotonic_ns: process.hrtime.bigint().toString() }) + '\\n', { mode: 0o600 });`);
  replace('const payload = await options?.onPayload?.({ model: model.id, context }, model);', 'if (typeof options?.onPayload !== "function" || typeof options?.onResponse !== "function") throw new Error("PUBLIC_PROVIDER_HOOKS_REQUIRED");\n      hook("payload_start");\n      const payload = await options.onPayload({ model: model.id, context }, model);\n      hook("payload_end");');
  replace('JSON.stringify({ model: model.id, context })', 'JSON.stringify({ requestId, model: model.id, context })');
  replace('await options?.onResponse?.({ status: 200, headers: { "x-fixture": "deterministic" } }, model);', 'await options.onResponse({ status: 200, headers: { "x-fixture": "deterministic" } }, model);\n      hook("response_end");');
  replace('let sent = false;', `let sent = false;\n  let call, prepared = false;\n  async function prepareOutput() {\n    await request();\n    if (!prepared) { call = selectProviderCall(context); if (call) { output.content = [call]; output.stopReason = 'toolUse'; } prepared = true; }\n    return output;\n  }`);
  replace('result: async () => { await request(); return output; }', 'result: prepareOutput');
  replace('await request();\n      for (const event of events) yield event;', `await prepareOutput();\n      if (call) {\n        yield { type: 'start', partial: output };\n        yield { type: 'toolcall_start', contentIndex: 0, partial: output };\n        yield { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: output };\n        yield { type: 'done', reason: 'toolUse', message: output };\n      } else for (const event of events) yield event;`);
  await writeFile(path, source, { mode: 0o600 });
  return path;
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
  process.once('exit', code => record({ kind: 'observer_end', code, active_sdk: activeSdk.size, active_children: activeChildren.size }));
}
async function observer(path) {
  await writeFile(path, `import childProcess from 'node:child_process';\nimport { createHash } from 'node:crypto';\nimport { channel } from 'node:diagnostics_channel';\nimport { appendFileSync } from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\n${safeRequestMetrics.toString()}\n(${observe.toString()})();\n`, { mode: 0o600 });
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
    if (ended.length !== 1 || ended[0].active_sdk !== 0 || ended[0].active_children !== 0) pending.push({ kind: 'observer_end', pid: start.observer_pid });
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
  for (const last of chains.values()) { assert.equal(last.kind, 'observer_end'); assert.equal(last.active_sdk, 0); assert.equal(last.active_children, 0); }
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
    cli_catalog_children: starts.filter(event => event.bundled && event.operation === 'list').length,
    cli_prepare_read_export_children: 0, cli_http: cliCloses.every(event => event.request_metrics?.complete) ? cliCloses.reduce((total, event) => total + event.request_metrics.total_requests, 0) : null,
    observer_processes: chains.size, source_children_closed: starts.length, eof_closed: true,
    default_body_transport: bodyTransportRequired ? 'verified_sdk' : 'not_applicable_metadata_query' };
}

async function scenario(name, info, scratch, evidence, expectShortRefs) {
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
  await save(toolPlan, { mode: name === 'dollar' ? 'search' : name });
  const fakeProvider = await provider(base), preload = join(base, 'observer.mjs');
  await observer(preload);
  const fixtureEnv = { ...info.fixtureEnv };
  for (const key of ['NTN_SKILLS_HOME', 'NTN_SKILLS_CONFIG_HOME', 'NTN_SKILLS_CACHE_HOME']) {
    const original = resolve(info.fixture.cwd, fixtureEnv[key]);
    assert.ok(original.startsWith(resolve(info.fixture.cwd) + '/'));
    fixtureEnv[key] = join(localSource, original.slice(resolve(info.fixture.cwd).length + 1));
  }
  const env = isolatedEnv({ base, agentDir, ...fixtureEnv, TMPDIR: await systemTempRoot(),
    NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000', CONTEXT_BROKER_HOST: 'pi', CONTEXT_BROKER_CONFIG: config,
    CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: providerFile, CONTEXT_BROKER_LOG_FILE: join(output, 'decisions.jsonl'),
    BROKER_E2E_PROCESS_LEDGER: join(output, 'owned-processes.jsonl'), SC10_PI_TOOL_PLAN: toolPlan,
    SC10_PI_PROVIDER_HOOKS: hookFile, SC10_PI_OBSERVER: ledger,
    SC10_PI_BUNDLED_CLI: join(info.packageRoot, 'dist/ntn-skills.mjs'), NODE_OPTIONS: `--import=${preload}` });
  const activeTools = name === 'scoped-command' ? scopedCommandTools : nativeTools;
  const argv = ['--no-extensions', '--session-dir', sessions, '--tools', activeTools.join(','), '-e', fakeProvider, '-e', info.extension, '--model', 'context-broker-e2e/fake'];
  await save(join(output, 'launch.json'), { host: info.host, argv, cwd: base, source_command_configured: false,
    source_state: 'cloned warm controlled snapshots/current catalog; fresh Broker cache and Pi session', expect_short_refs: expectShortRefs, active_tools: activeTools });
  let rpc, failed, last, discovery, beforeClose, finality;
  try {
    rpc = await startRpc({ host: 'pi', args: argv, cwd: base, env, timeoutMs: 60000 });
    await rpc.prompt(name === 'dollar' ? 'Discover the authorized Skill directory for the controlled task.' : name === 'native' ? 'Inspect the available a Skill and read its advertised resource.' : name === 'prepare' ? 'Use the available a, b and c Skills together, preparing their required instructions.' : 'For the sdk-fixture source, obtain the host-local command prefix and database scope for a possible maintenance action. Return that metadata only; do not execute commands or read Skill bodies.');
    let captures = await rows(providerFile); assert.ok(captures.length >= 2);
    last = captures.at(-1).context;
    if (name !== 'scoped-command') {
      discovery = parsedResult(toolResult(last, 'sc10-search'));
      assert.equal(discovery.ok, true); assert.equal(discovery.count, 4);
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
    } else if (name === 'prepare') {
      const prepared = parsedResult(toolResult(last, 'sc10-prepare'));
      assert.equal(prepared.status, 'ready'); assert.equal(prepared.records.length, 4);
      assert.equal(prepared.records.filter(record => record.id.endsWith(':base')).length, 1);
      for (const [key, body] of info.bodies) assert.equal(bodyCount(last, body), 1, `${key}: complete prepared text once`);
      if (expectShortRefs) for (const record of prepared.records) assert.match(record.ref, /^sr:S/u);
      await save(join(output, 'prepared.json'), prepared);
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
    }
  }
  try {
    if (failed) throw new Error(failed.message);
    const captures = await rows(providerFile), hooks = await rows(hookFile);
    for (const capture of captures) assert.deepEqual(hooks.filter(hook => hook.requestId === capture.requestId).map(hook => hook.phase), ['payload_start', 'payload_end', 'response_end']);
    assert.equal(new Set(captures.map(capture => capture.requestId)).size, captures.length);
    const guidance = captures.map(capture => ({ request_id: capture.requestId, ...assertNativeGuidance(capture.context, env.SC10_PI_BUNDLED_CLI) }));
    await save(join(output, 'guidance.json'), guidance);
    const observations = reconcile(await rows(ledger), rpc.lifecycle, { bodyTransportRequired: name !== 'scoped-command' });
    const result = { name, status: 'passed', provider_requests: captures.length, public_provider_hooks: true,
      source_command_configured: false, short_refs: name === 'scoped-command' ? 'not_applicable_metadata_query' : expectShortRefs ? 'verified' : 'not_required_for_baseline',
      discovery_failures: discovery?.failures ?? null, native_guidance_without_cli_templates: true, observer_finality: finality?.complete === true, default_view: 'not_verified', ...observations };
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
  assert.ok(['--package', '--fixture', '--out', '--evidence', '--expect-short-refs'].includes(key) && value && !Object.hasOwn(options, key), usage);
  if (key === '--expect-short-refs') assert.ok(['true', 'false'].includes(value), usage);
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
    await save(join(evidence, 'plan.json'), { version: 1, node: process.version, pi: info.pi.version, package: info.packageRoot, runtime: info.runtime, extension: info.extension,
      fixture: options['--fixture'], driver_sha256: hash(await readFile(fileURLToPath(import.meta.url))), source_command_configured: false,
      scenarios: scenarioNames, expect_short_refs: expectShortRefs, live_notion: 'not_run', real_model: 'not_run', default_view: 'not_verified' });
    const results = [];
    for (const name of scenarioNames) {
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
