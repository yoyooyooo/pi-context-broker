import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv, writeFakeProvider } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { createRequestLedger, nativeEntries } from './notion-default-context.mjs';

const helper = fileURLToPath(import.meta.url);
const sha = text => createHash('sha256').update(text).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const rows = async path => { try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const log = (path, value) => appendFile(path, JSON.stringify({ ...value, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
const pause = ms => new Promise(accept => setTimeout(accept, ms));
const uuid = number => `b5610000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const graphDatabase = uuid(100);
const graphDataSource = uuid(101);
const graphView = { id: uuid(102), name: 'Root only', type: 'table', database_id: graphDatabase, data_source_id: graphDataSource, url: `https://notion.so/${graphDatabase}?v=${uuid(102)}` };
const token = 'controlled-skill-graph-no-remote-credential';
const fileRef = (id, path, snapshot, fileId) => `skill://${encodeURIComponent(id)}/${path.split('/').map(encodeURIComponent).join('/')}${snapshot || fileId ? '?' : ''}${[snapshot ? `snapshot=${snapshot}` : '', fileId ? `file_id=${encodeURIComponent(fileId)}` : ''].filter(Boolean).join('&')}`;

// These frozen manifests are fixture input, not a dependency resolver. The
// installed CLI performs all graph traversal, pin checks, budgets and hashing.
function frozenGraph(scope, { broken = false, renamed = false, invalidRequiredKind } = {}) {
  assert.ok(invalidRequiredKind === undefined || ['router', 'prompt'].includes(invalidRequiredKind));
  const libraryId = renamed ? 'cobalt-library-73' : 'controlled-graph';
  const pageId = number => uuid(number + (renamed ? 50000 : 0));
  const database = pageId(100), dataSource = pageId(101);
  const view = { ...graphView, id: pageId(102), database_id: database, data_source_id: dataSource, url: `https://notion.so/${database}?v=${pageId(102)}` };
  const renamedNames = { 'graph-base': 'mint-check', 'graph-left': 'indigo-rule', 'graph-right': 'silver-rule', 'graph-member': 'copper-reference', 'graph-root': 'cobalt-workflow', 'graph-secondary': 'amber-workflow', 'graph-bom': 'violet-bytes', 'graph-invalid': 'ochre-boundary' };
  const nodes = new Map();
  const identity = (key, number) => ({ name: renamed ? renamedNames[key] : key, skillId: renamed ? `unit-${number * 37}` : key, fileId: index => renamed ? `${index ? 'resource' : 'main'}-opaque-${number * 71}-${index}` : index ? `resource-${key}-${index}` : `main-${key}` });
  const make = (key, number, { kind = 'skill', required = [], members = [], body, resources = [], revision = 1 } = {}) => {
    const { name, skillId, fileId } = identity(key, number);
    const id = `shared_skill:${libraryId}:${skillId}`;
    const entrypoint = kind === 'router' ? 'ROUTER.md' : kind === 'prompt' ? 'PROMPT.md' : 'SKILL.md';
    const record = { id, kind, name, alias: name, description: `${name} controlled graph instructions`, enabled: true, default_context: key === 'graph-root', entrypoint, ref: fileRef(id, entrypoint), locator: { type: 'shared_skill', library_id: libraryId, skill_id: skillId, page_id: pageId(number), database_id: database, data_source_id: dataSource } };
    const main = body ?? `# ${name}\nGRAPH_INSTRUCTION_${name.toUpperCase().replaceAll('-', '_')}\nFollow this complete instruction before applying its dependent workflow.\n`;
    const data = [{ path: entrypoint, content: main }, ...resources];
    const files = data.map(({ path, content }) => ({ path, bytes: Buffer.byteLength(content), sha256: sha(content) }));
    const relation = target => ({ id: target.record.id, ref: fileRef(target.record.id, target.entrypoint, target.snapshot_id, target.file_bindings.find(file => file.path === target.entrypoint).file_id), metadata: target.record });
    const requiredDirectory = required.map(target => typeof target === 'string' ? { id: target, ref: fileRef(target, 'SKILL.md', 's_' + 'f'.repeat(64)), metadata: { kind: 'skill', name: 'Missing prerequisite', description: 'Deliberately absent frozen dependency' } } : relation(target));
    const memberDirectory = members.map(relation);
    const version = sha(JSON.stringify([record, files, requiredDirectory, memberDirectory, revision]));
    const snapshot = { scope, snapshot_id: `s_${sha(JSON.stringify([scope, id, version]))}`, version_id: version, created_at: 1000, record, entrypoint, files, file_bindings: data.map(({ path }, index) => ({ file_id: fileId(index), page_id: index === 0 ? record.locator.page_id : pageId(number * 10 + index + 200), path })), required: requiredDirectory, members: memberDirectory, ...(kind === 'router' ? { router_members: memberDirectory } : {}), markdown_files: { main: entrypoint } };
    const value = { ...snapshot, body: main, data };
    nodes.set(key, value);
    return value;
  };
  const base = make('graph-base', 1);
  const left = make('graph-left', 2, { required: [base] });
  const right = make('graph-right', 3, { required: [base] });
  const memberIdentity = identity('graph-member', 4);
  const memberId = `shared_skill:${libraryId}:${memberIdentity.skillId}`;
  const resource = { path: renamed ? 'references/copper-report.md' : 'references/ledger.md', content: 'GRAPH_MEMBER_RESOURCE_COMPLETE\nEntry: 29\nApproved ledger explanation.\n' };
  // The spelling is stale intentionally. Its stable file_id binds the current
  // resource path; neither the provider nor the runner guesses that path.
  const member = make('graph-member', 4, { body: `# ${memberIdentity.name}\nGRAPH_MEMBER_OPTIONAL_BODY\nRead [the ledger evidence](${fileRef(memberId, renamed ? 'references/former-copper.md' : 'references/previous-ledger.md', undefined, memberIdentity.fileId(1))}) to explain the entry.\n`, resources: [resource] });
  const memberRef = fileRef(member.record.id, member.entrypoint, member.snapshot_id, memberIdentity.fileId(0));
  const rootBody = `# ${identity('graph-root', 5).name}\nGRAPH_ROOT_WORKFLOW_COMPLETE\nApply the prerequisite instructions. The Members directory contains an optional reference for a separate explanation.\n\n## Members\n\n- [${memberIdentity.name}](${memberRef}) — Optional ledger explanation\n`;
  const invalidRequired = invalidRequiredKind ? make('graph-invalid', 8, { kind: invalidRequiredKind, required: [base], members: [member] }) : undefined;
  const required = broken ? [`shared_skill:${libraryId}:missing`] : invalidRequired ? [left, invalidRequired] : [left, right];
  const root = make('graph-root', 5, { required, members: [member], body: rootBody });
  const oldRoot = root;
  const changedRoot = make('graph-root', 5, { required, members: [member], body: rootBody.replace('GRAPH_ROOT_WORKFLOW_COMPLETE', 'GRAPH_ROOT_WORKFLOW_REVISION_TWO'), revision: 2 });
  nodes.set('graph-root', root);
  const secondary = make('graph-secondary', 6, { required: [base] });
  const bom = make('graph-bom', 7, { body: '\ufeff# graph-bom\r\nPreserve UTF-8 BOM, CRLF and 雪 exactly.\r\n' });
  return { nodes: [...nodes.values()], oldRoot, changedRoot, root, secondary, base, left, right, member, bom, resource, invalidRequired, database, dataSource, view, identityVariant: renamed ? 'cobalt-independent-names-and-identities' : 'baseline', useIds: [root, left, base, right].map(node => node.record.id) };
}

async function runChild(command, args, { env, cwd, callsPath, receipts, category, passthrough = false } = {}) {
  const requestId = randomUUID();
  const child = spawn(command[0], [...command.slice(1), ...args], { env, cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => { stdout.push(chunk); if (passthrough) process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { stderr.push(chunk); if (passthrough) process.stderr.write(chunk); });
  const signals = [];
  const handlers = ['SIGTERM', 'SIGINT'].map(signal => [signal, () => { const forwarded = child.kill(signal); signals.push(log(callsPath, { phase: 'signal-forwarded', category, requestId, pid: process.pid, childPid: child.pid, signal, forwarded })); }]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const closed = new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })); });
  await log(callsPath, { phase: 'cli-spawned', category, requestId, pid: process.pid, childPid: child.pid, command: command[0], args: [...command.slice(1), ...args] });
  const result = { ...await closed, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
  await Promise.all(signals);
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  await log(callsPath, { phase: 'cli-completed', category, requestId, pid: process.pid, childPid: child.pid, code: result.code, signal: result.signal, stdout_bytes: Buffer.byteLength(result.stdout), stderr_bytes: Buffer.byteLength(result.stderr) });
  await save(join(receipts, `${requestId}.json`), { category, command, args, ...result });
  return result;
}

async function seedSqlite(statePath) {
  const state = await json(statePath);
  const require = createRequire(join(state.cliSource, 'packages/cli/package.json'));
  const [{ Effect, Layer }, NodeServices, { Store, StoreLive }, { currentMaterializationVersion }] = await Promise.all([
    import(pathToFileURL(require.resolve('effect')).href),
    import(pathToFileURL(require.resolve('@effect/platform-node/NodeServices')).href),
    import(pathToFileURL(join(state.cliSource, 'packages/core/src/store.ts')).href),
    import(pathToFileURL(join(state.cliSource, 'packages/core/src/materialization.ts')).href),
  ]);
  const frozen = await json(state.frozenPath);
  const current = frozen.nodes.map(node => node.record.id === frozen.root.record.id && state.revision === 2 ? frozen.changedRoot : node);
  const all = [...frozen.nodes, frozen.changedRoot];
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* Store;
    yield* store.writeJson(`cache/identities/${sha(JSON.stringify([sha(token), '', state.origin]))}.json`, { scope: state.scope });
    for (const node of all) {
      const { body: _body, data, ...snapshot } = node;
      for (const file of data) yield* store.writeBytes(`objects/${sha(file.content)}`, new TextEncoder().encode(file.content));
      yield* store.writeJson(`snapshots/${snapshot.snapshot_id}.json`, snapshot);
    }
    const now = Date.now();
    for (const node of current) {
      yield* store.writeJson(`cache/latest/${state.scope}/${node.record.id}/${randomUUID()}.json`, { record_identity: node.record.id, scope: state.scope, started_at: now, generation: state.revision, materialization_version: currentMaterializationVersion(node.record.id), validated_at: now, snapshot_id: node.snapshot_id, default_context: node.record.default_context, invalidated: false, shared_body_valid_until: now + 3600000 });
      yield* store.writeJson(`cache/shared-page-identities/${state.scope}/${node.record.locator.page_id}.json`, { version: 1, scope: state.scope, page_id: node.record.locator.page_id, record_identity: node.record.id });
    }
  })).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer)))));
  console.log(JSON.stringify({ ok: true, storage: 'Node SQLite StoreLive', snapshots: all.length, current_records: current.length, revision: state.revision, scope: state.scope }));
}

export async function createGraphFixture({ directory, evidence, cliCommand, cliSource, broken = false, revision = 1, renamed = false, invalidRequiredKind }) {
  assert.ok(isAbsolute(cliSource), 'The controlled seed requires an absolute CLI source checkout');
  assert.ok(Array.isArray(cliCommand) && cliCommand.length > 1 && cliCommand.every(value => typeof value === 'string'), 'The consumer requires an explicit installed Node CLI argument array');
  await mkdir(directory, { recursive: true });
  await mkdir(evidence, { recursive: true });
  const receipts = join(evidence, 'cli-receipts');
  await mkdir(receipts);
  const callsPath = join(evidence, 'source-cli-calls.jsonl');
  const httpPath = join(evidence, 'loopback-http.jsonl');
  await Promise.all([writeFile(callsPath, ''), writeFile(httpPath, '')]);
  const pending = new Set();
  const server = createServer((request, response) => {
    const requestId = randomUUID();
    log(httpPath, { phase: 'request', requestId, method: request.method, path: request.url });
    const timer = setTimeout(() => { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ object: 'error', status: 503, code: 'service_unavailable', message: 'Controlled pending request completed' })); }, 30000);
    pending.add(response);
    response.on('close', () => { clearTimeout(timer); pending.delete(response); log(httpPath, { phase: 'closed', requestId, complete: response.writableFinished }); });
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  server.unref();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const scope = sha(JSON.stringify(['controlled-graph', '', origin, sha(token)]));
  const graph = frozenGraph(scope, { broken, renamed, invalidRequiredKind });
  const frozenPath = join(evidence, 'frozen-input.json');
  await save(frozenPath, graph);
  const statePath = join(directory, 'graph-source-state.json');
  const cliEnv = isolatedEnv({ base: directory, agentDir: join(directory, 'unused-agent'), NOTION_API_TOKEN: token, NOTION_WORKSPACE_ID: '', NOTION_API_BASE_URL: origin, NTN_SKILLS_REQUEST_TIMEOUT_MS: '60000', NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000' });
  const state = { version: 1, cliCommand, cliSource, cliEnv, origin, scope, frozenPath, callsPath, receipts, scenario: 'normal', revision };
  await save(statePath, state);
  const seed = await runChild([process.execPath, helper], ['--seed', statePath], { env: cliEnv, cwd: directory, callsPath, receipts, category: 'fixture-sqlite-seed' });
  if (seed.code !== 0) { await new Promise(accept => server.close(accept)); assert.fail(`Node SQLite fixture seed failed: ${seed.stderr}`); }
  const setState = async changes => { Object.assign(state, changes); await save(statePath, state); };
  const invoke = args => runChild([process.execPath, helper], ['--source', statePath, ...args], { env: cliEnv, cwd: directory, callsPath, receipts, category: 'fixture-public-command' });
  return {
    command: [process.execPath, helper, '--source', statePath], scope, statePath, callsPath, httpPath, graph, directory, evidence, cliEnv, cliCommand,
    setState, invoke,
    async revise() { await setState({ revision: 2 }); const result = await runChild([process.execPath, helper], ['--seed', statePath], { env: cliEnv, cwd: directory, callsPath, receipts, category: 'fixture-sqlite-seed' }); assert.equal(result.code, 0, result.stderr); },
    async close() { for (const response of pending) response.destroy(); await new Promise(accept => server.close(accept)); },
  };
}

async function sourceCommand(statePath, args) {
  const state = await json(statePath);
  const frozen = await json(state.frozenPath);
  const database = frozen.database ?? graphDatabase, dataSource = frozen.dataSource ?? graphDataSource, view = frozen.view ?? graphView;
  const command = args[0];
  await log(state.callsPath, { phase: 'source-entered', pid: process.pid, command, args: args.slice(1), scenario: state.scenario });
  const out = value => console.log(JSON.stringify(value));
  if (command === 'ctl' && args[1] === 'doctor') { out({ ok: true, transport: 'direct_http', notion_api_version: '2026-03-11', authentication: 'available' }); return; }
  if (command === 'ctl' && args[1] === 'cache' && args[2] === 'identity') { out({ ok: true, identity: sha(JSON.stringify([state.scope, database])), catalog_max_age_ms: 60000 }); return; }
  if (command === 'views') { out({ ok: true, views: [view], count: 1 }); return; }
  if (command === 'list') {
    const selectedView = args.includes('--default-view') || args.includes('--view');
    const records = frozen.nodes.filter(node => node !== frozen.bom && node.record.id !== frozen.bom.record.id).map(node => node.record).filter(record => !selectedView || record.default_context);
    out({ ok: true, scope: state.scope, source: 'notion', fetched_at: Date.now(), databases: [{ database_id: database, title: 'Controlled graph', alias: frozen.root.record.locator.library_id, data_source_ids: [dataSource] }], records, count: records.length, coverage: { method: selectedView ? 'explicit_view' : 'explicit_database', exhaustive: true, queried_data_sources: [dataSource], failed_sources: [], search_index_limited: false }, freshness: { policy: 'default', validated_at: new Date().toISOString(), age_ms: 0, max_age_ms: 60000, stale: false }, ...(selectedView ? { view, view_selection: args.includes('--view') ? 'explicit' : 'first', view_query: null } : {}) });
    return;
  }
  assert.ok(['prepare', 'read', 'export', 'schema'].includes(command), `Unsupported graph fixture command: ${command}`);
  let forwarded = args;
  if (command === 'prepare' && state.scenario === 'pending-http') {
    forwarded = args.filter((arg, index) => arg !== '--offline' && arg !== '--max-age' && args[index - 1] !== '--max-age');
    if (!forwarded.includes('--refresh')) forwarded.push('--refresh');
    await log(state.callsPath, { phase: 'controlled-policy', command, original: args, forwarded, purpose: 'A real CLI HTTP wait for native lifecycle cancellation' });
  }
  const result = await runChild(state.cliCommand, forwarded, { env: { ...process.env, ...state.cliEnv }, cwd: dirname(statePath), callsPath: state.callsPath, receipts: state.receipts, category: 'installed-cli-' + command, passthrough: true });
  process.exitCode = result.code ?? 1;
}

export async function smokeGraphFixture(options) {
  const fixture = await createGraphFixture(options);
  const observations = [];
  try {
    const prepared = await fixture.invoke(['prepare', fixture.graph.root.record.ref, '--offline', '--metrics']);
    assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
    const ready = JSON.parse(prepared.stdout);
    assert.equal(ready.status, 'ready');
    assert.deepEqual(new Set(ready.nodes.filter(node => node.state === 'prepared').map(node => node.id)), new Set(fixture.graph.useIds));
    assert.equal(ready.nodes.find(node => node.id === fixture.graph.member.record.id)?.state, 'known');
    const inspected = await fixture.invoke(['prepare', fixture.graph.root.record.ref, '--purpose', 'inspect', '--offline', '--metrics']);
    const inspection = JSON.parse(inspected.stdout);
    assert.equal(inspected.code, 0, inspected.stdout);
    assert.equal(inspection.usage.prepared_nodes, 1);
    assert.deepEqual(inspection.required_closure, []);
    const bindings = join(fixture.directory, 'session-bindings.json');
    await save(bindings, ready.session_bindings);
    await fixture.revise();
    const pinned = await fixture.invoke(['prepare', fixture.graph.root.record.ref, '--offline', '--session-bindings', bindings]);
    assert.equal(pinned.code, 0, pinned.stdout);
    assert.equal(JSON.parse(pinned.stdout).nodes.find(node => node.id === fixture.graph.root.record.id).binding.snapshot_id, fixture.graph.root.snapshot_id);
    const fixed = fileRef(fixture.graph.root.record.id, fixture.graph.root.entrypoint, fixture.graph.root.snapshot_id, fixture.graph.root.file_bindings.find(file => file.path === fixture.graph.root.entrypoint).file_id);
    const read = await fixture.invoke(['read', fixed, '--offline', '--metrics']);
    assert.equal(read.code, 0, read.stdout);
    assert.equal(JSON.parse(read.stdout).content, fixture.graph.root.body);
    const exported = await fixture.invoke(['export', fixture.graph.root.snapshot_id, '--projection', 'snapshot', '--format', 'directory', '--output', join(fixture.directory, 'root-export')]);
    assert.equal(exported.code, 0, exported.stdout);
    assert.equal(await readFile(join(JSON.parse(exported.stdout).output, fixture.graph.root.entrypoint), 'utf8'), fixture.graph.root.body);
    const bomPrepare = await fixture.invoke(['prepare', fileRef(fixture.graph.bom.record.id, 'SKILL.md', fixture.graph.bom.snapshot_id), '--offline']);
    const bomRead = await fixture.invoke(['read', fileRef(fixture.graph.bom.record.id, 'SKILL.md', fixture.graph.bom.snapshot_id), '--offline']);
    assert.equal(bomPrepare.code, 0, bomPrepare.stdout);
    assert.equal(bomRead.code, 0, bomRead.stdout);
    const bomPrepared = JSON.parse(bomPrepare.stdout).nodes.find(node => node.state === 'prepared');
    const bomContent = JSON.parse(bomRead.stdout).content;
    observations.push({ action: 'BOM public prepare/read consistency', expected_sha256: sha(fixture.graph.bom.body), prepare_sha256: sha(bomPrepared.content), read_sha256: sha(bomContent), expected_bytes: Buffer.byteLength(fixture.graph.bom.body), read_bytes: Buffer.byteLength(bomContent), matches: bomContent === fixture.graph.bom.body });
    assert.equal((await rows(fixture.httpPath)).length, 0, 'Offline fixture consumer must not issue HTTP');
    const result = { status: observations.every(item => item.matches !== false) ? 'passed' : 'failed', graph_status: 'passed', layer: 'real installed Node CLI + SQLite; controlled frozen source', use_nodes: ready.usage.prepared_nodes, inspect_nodes: inspection.usage.prepared_nodes, historical_session_binding: 'preserved', main_file_id: JSON.parse(read.stdout).ref, observations };
    await save(join(fixture.evidence, 'fixture-smoke.json'), result);
    return result;
  } finally { await fixture.close(); }
}

// This function is copied into the controlled provider. Every read target is
// derived from the visible catalog or preceding tool result. Only the explicit
// historical-pin case supplies a public root ref in its fixture plan.
function nextGraphTool(context, plan) {
  const text = content => typeof content === 'string' ? content : (content ?? []).filter(part => part.type === 'text').map(part => String(part.text ?? '')).join('\n');
  const result = id => context.messages.find(message => message.role === 'toolResult' && message.toolCallId === id);
  const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
  if (plan.mode === 'none') return null;
  if (plan.mode === 'native-chain') {
    const root = result('graph-root-read');
    if (!root) {
      const metadata = [typeof context.systemPrompt === 'string' ? context.systemPrompt : (context.systemPrompt ?? []).join('\n'), ...context.messages.filter(message => message.role === 'system').map(message => text(message.content) + '\n' + String(message.sections?.skills ?? ''))].join('\n');
      const advertised = [...metadata.matchAll(/<skill>\s*<name>\s*[^<]+\s*<\/name>[\s\S]*?<location>\s*([^<]+)\s*<\/location>/g)];
      if (advertised.length !== 1) throw new Error('The visible native catalog must advertise exactly one root');
      const location = advertised[0]?.[1]?.trim();
      if (!location) throw new Error('The visible native catalog did not advertise the graph root');
      return call('graph-root-read', 'read', { path: location });
    }
    if (root.isError) throw new Error('The native root read failed');
    const member = result('graph-member-read');
    if (!member) {
      const ref = [...text(root.content).matchAll(/skill:\/\/[^\s)<>"\]]+/g)].map(match => match[0].replaceAll('&amp;', '&')).find(ref => ref.split('?')[0].endsWith('/SKILL.md'));
      if (!ref) throw new Error('The visible root result did not provide an exact Member ref');
      return call('graph-member-read', 'read', { path: ref });
    }
    if (member.isError) throw new Error('The exact Member read failed');
    const resource = result('graph-resource-read');
    if (!resource) {
      const ref = [...text(member.content).matchAll(/skill:\/\/[^\s)<>"\]]+/g)].map(match => match[0].replaceAll('&amp;', '&')).find(ref => !/\/(?:SKILL|ROUTER)\.md(?:\?|$)/.test(ref));
      if (!ref) throw new Error('The visible Member result did not provide an exact resource ref');
      return call('graph-resource-read', 'read', { path: ref });
    }
    if (resource.isError) throw new Error('The exact resource read failed');
    return null;
  }
  const searched = result('graph-search');
  if (!searched) return call('graph-search', 'skill_search', { query: '', limit: 100 });
  if (searched.isError) throw new Error('Metadata search failed');
  const catalog = JSON.parse(text(searched.content));
  const root = catalog.records.find(record => record.in_default_view === true);
  if (!root?.ref) throw new Error('The visible search result has no default View root');
  if (!result('graph-prepare')) return call('graph-prepare', 'skill_prepare', { roots: [plan.rootPin ?? root.ref], purpose: plan.mode === 'prepare-inspect' ? 'inspect' : 'use' });
  if (result('graph-prepare').isError) throw new Error('Explicit graph preparation failed');
  return null;
}

async function graphProvider(directory) {
  const path = await writeFakeProvider(directory);
  let source = await readFile(path, 'utf8');
  source = source.replace('import { appendFileSync }', 'import { appendFileSync, readFileSync }');
  source = source.replace('function stream(model, context) {', nextGraphTool.toString() + '\nfunction stream(model, context) {');
  source = source.replace('  const output = {', "  const call = nextGraphTool(context, JSON.parse(readFileSync(process.env.BROKER_GRAPH_PLAN, 'utf8')));\n  const output = {");
  source = source.replace('content: [{ type: "text", text: "OK" }]', 'content: call ? [call] : [{ type: "text", text: "OK" }]');
  source = source.replace('stopReason: "stop"', 'stopReason: call ? "toolUse" : "stop"');
  source = source.replace('for (const event of events) yield event;', "if (call) { yield {type:'start',partial:output}; yield {type:'toolcall_start',contentIndex:0,partial:output}; yield {type:'toolcall_end',contentIndex:0,toolCall:call,partial:output}; yield {type:'done',reason:'toolUse',message:output}; } else for (const event of events) yield event;");
  await writeFile(path, source);
  return path;
}

const textContent = content => typeof content === 'string' ? content : (content ?? []).filter(part => part.type === 'text').map(part => String(part.text ?? '')).join('\n');
const unescapeXml = value => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
function visibleText(context) {
  return context.messages.flatMap(message => {
    const text = textContent(message.content);
    try { const value = JSON.parse(text); if (Array.isArray(value.records) && value.records.some(record => typeof record.content === 'string')) return value.records.flatMap(record => typeof record.content === 'string' ? [record.content] : []); } catch { /* Ordinary native messages are text. */ }
    return [unescapeXml(text)];
  });
}
function verifyBodies(context, graph, expected, { root = graph.root, resource = false } = {}) {
  const texts = visibleText(context);
  const selected = new Set(expected);
  const result = graph.nodes.filter(node => node.record.id !== graph.bom.record.id).map(original => {
    const node = original.record.id === root.record.id ? root : original;
    const copies = texts.reduce((sum, text) => sum + text.split(node.body).length - 1, 0);
    assert.equal(copies, selected.has(node.record.id) ? 1 : 0, `Provider must contain ${selected.has(node.record.id) ? 'one complete' : 'no'} body for ${node.record.id}`);
    return { id: node.record.id, scope: node.scope, snapshot_id: node.snapshot_id, bytes: Buffer.byteLength(node.body), body_sha256: sha(node.body), copies };
  });
  if (resource) assert.equal(texts.reduce((sum, text) => sum + text.split(graph.resource.content).length - 1, 0), 1, 'Native resource bytes must reach the provider exactly once');
  return result;
}
function verifyNoShell(context) {
  const names = [...new Set([...(context.tools ?? []), ...context.messages.flatMap(message => message.toolsAdded ?? [])].map(tool => tool.name ?? tool.tool?.name).filter(Boolean))];
  assert.ok(names.includes('read'), 'The actual native read tool must be enabled');
  assert.ok(!names.some(name => /^(?:bash|exec|shell|execute|terminal)$/i.test(name)), 'The controlled Agent has no shell execution tool');
  return names;
}
function verifySessionReceipts(messages, nodes) {
  const verified = [];
  for (const message of messages) {
    const details = message.details;
    if (!details) continue;
    const group = details.contextBrokerPreparation ?? details;
    let content = textContent(message.content);
    if (typeof group.nativePromptSha256 === 'string') content = textContent(messages.find(candidate => candidate.role === 'user' && sha(textContent(candidate.content)) === group.nativePromptSha256)?.content);
    const candidates = Array.isArray(group.records) ? group.records : details.contextBrokerRead ? [details.contextBrokerRead] : [];
    for (const receipt of candidates) {
      if (receipt.version !== 2 || !receipt.contentIdentity) continue;
      const identity = JSON.parse(receipt.contentIdentity);
      const node = nodes.find(node => identity[0] === node.scope && identity[1] === node.record.id);
      if (!node) continue;
      let body = content;
      if (receipt.delivery) { const span = content.slice(receipt.delivery.start, receipt.delivery.end); body = receipt.delivery.encoding === 'xml' ? unescapeXml(span) : receipt.delivery.encoding === 'json' ? JSON.parse('"' + span + '"') : span; }
      assert.equal(body, node.body, 'Receipt must name an actual full body span');
      assert.equal(receipt.bodySha256, sha(body));
      assert.equal(receipt.bytes, Buffer.byteLength(body));
      assert.equal(receipt.snapshotId, node.snapshot_id);
      if (receipt.binding) { assert.equal(receipt.binding.scope, node.scope); assert.equal(receipt.binding.record.id, node.record.id); assert.equal(receipt.binding.snapshot_id, node.snapshot_id); assert.equal(receipt.binding.body_sha256, sha(body)); assert.ok(receipt.binding.ref.includes('file_id=main-'), 'Graph main binding preserves its stable file id'); }
      verified.push({ id: node.record.id, scope: node.scope, snapshot_id: node.snapshot_id, body_sha256: receipt.bodySha256, bytes: receipt.bytes, encoding: receipt.delivery?.encoding ?? 'raw' });
    }
  }
  for (const node of nodes) assert.ok(verified.some(receipt => receipt.id === node.record.id), `Session needs a verified complete body receipt for ${node.record.id}`);
  return verified;
}
async function filesWithin(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await filesWithin(join(directory, entry.name), path));
    else result.push(path);
  }
  return result;
}
async function until(label, probe, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await pause(50); }
  assert.fail(`Timed out waiting for ${label}`);
}
const exited = pid => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } };
export const graphCaseNames = ['metadata', 'cold-dollar', 'cold-native', 'multi-root', 'tool-use', 'tool-inspect', 'native-chain', 'cold-pin', 'renamed-identities', 'required-router', 'required-prompt', 'missing', 'budget', 'rpc-abort', 'new-session', 'eof'];

export async function runSkillGraph({ host, root, scratch, evidence, extension, cliCommand, cliSource, cases = graphCaseNames }) {
  assert.equal(host, 'pi', 'This graph acceptance branch exercises actual installed Pi only');
  assert.ok(cases.length && cases.every(name => graphCaseNames.includes(name)), 'Unknown graph case');
  const label = 'pi-skill-graph';
  const output = join(evidence, label);
  await mkdir(output);
  const result = { host, mode: 'skill-graph', status: 'running', consumer: 'installed extension + actual Pi RPC + controlled provider', source: 'real installed Node CLI with isolated SQLite frozen fixtures; metadata wrapper only', cases: [], files: [], notRun: ['Real Notion graph creation and remote cold-cache acceptance', 'Real model selection', 'Native composer Stop/TUI; RPC abort is measured separately', ...graphCaseNames.filter(name => !cases.includes(name)).map(name => 'Unselected graph case: ' + name)] };
  try {
    for (const name of cases) {
      const base = join(scratch, label, name), retained = join(output, name), agentDir = join(base, 'agent');
      await mkdir(join(agentDir, 'context-broker'), { recursive: true });
      await mkdir(join(base, 'sessions'));
      await mkdir(retained, { recursive: true });
      const fixture = await createGraphFixture({ directory: join(base, 'cli'), evidence: join(retained, 'source'), cliCommand, cliSource, broken: name === 'missing', revision: name === 'cold-pin' ? 2 : 1, renamed: name === 'renamed-identities', invalidRequiredKind: name === 'required-router' ? 'router' : name === 'required-prompt' ? 'prompt' : undefined });
      const rootToken = `$${fixture.graph.root.record.alias}@notion`, nativeName = `notion-${fixture.graph.root.record.alias}`;
      const ledger = await createRequestLedger({ scratch: base, evidence: retained, command: fixture.command });
      const providerFile = join(retained, 'pi-provider.jsonl'), decisionsFile = join(retained, 'pi-decisions.jsonl'), lifecycleFile = join(retained, 'pi-lifecycle.jsonl');
      await Promise.all([writeFile(providerFile, ''), writeFile(decisionsFile, ''), writeFile(lifecycleFile, '')]);
      const provider = await graphProvider(base), planPath = join(base, 'graph-plan.json');
      await save(planPath, { mode: name === 'native-chain' ? 'native-chain' : name === 'tool-inspect' ? 'prepare-inspect' : ['tool-use', 'cold-pin'].includes(name) ? 'prepare-use' : 'none', ...(name === 'cold-pin' ? { rootPin: fileRef(fixture.graph.root.record.id, fixture.graph.root.entrypoint, fixture.graph.root.snapshot_id, 'main-graph-root') } : {}) });
      await save(join(agentDir, 'context-broker', 'config.yml'), { sources: [{ type: 'notion', id: 'notion', namespace: 'notion', command: ledger.command, database: fixture.graph.database, cacheDir: join(base, 'broker-cache'), prefetch: false, activation: { offline: true }, requestTimeoutMs: 45000, ...(name === 'budget' ? { preparation: { maxNodes: 2 } } : {}) }] });
      const compactMode = join(base, 'compaction-mode.txt');
      await writeFile(compactMode, 'remove');
      const env = isolatedEnv({ base, agentDir, CONTEXT_BROKER_HOST: host, CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: providerFile, CONTEXT_BROKER_LOG_FILE: decisionsFile, BROKER_GRAPH_PLAN: planPath, CONTEXT_BROKER_E2E_LIFECYCLE_FILE: lifecycleFile, CONTEXT_BROKER_E2E_COMPACTION_MODE_FILE: compactMode });
      const activeTools = ['tool-use', 'tool-inspect', 'cold-pin'].includes(name) ? 'read,skill_search,skill_prepare' : 'read';
      const args = ['--no-extensions', '--session-dir', join(base, 'sessions'), '--tools', activeTools, '-e', provider, '-e', join(root, 'packages/context-broker/scripts/context-broker-lifecycle-fixture.mjs'), '-e', extension, '--model', 'context-broker-e2e/fake'];
      const observation = { name, status: 'running', isolation: { host: 'fresh', broker: 'fresh', cli: 'separate seeded immutable SQLite fixture, no prior prepare/read/export', prefetch: false }, observations: [] };
      result.cases.push(observation);
      let rpc;
      try {
        if (['rpc-abort', 'new-session', 'eof'].includes(name)) await fixture.setState({ scenario: 'pending-http' });
        rpc = await startRpc({ host, cwd: base, env, args, timeoutMs: 60000 });
        if (['rpc-abort', 'new-session', 'eof'].includes(name)) {
          let settled = false;
          const requested = name === 'eof' ? rpc.command('prompt', { message: '$graph-root@notion CANCEL_DEFAULT_CONTEXT_SELECTION' }) : rpc.prompt('$graph-root@notion CANCEL_DEFAULT_CONTEXT_SELECTION');
          const submission = requested.then(value => ({ value }), error => ({ error: error.message })).finally(() => { settled = true; });
          const cli = await until('real installed CLI pending HTTP', async () => {
            if (!(await rows(fixture.httpPath)).some(event => event.phase === 'request')) return undefined;
            return (await rows(fixture.callsPath)).find(event => event.phase === 'cli-spawned' && event.category === 'installed-cli-prepare');
          });
          const wrapper = await until('source wrapper child', async () => (await rows(ledger.ledger)).find(event => event.command === 'prepare' && event.phase === 'child-started'));
          assert.equal((await rows(providerFile)).length, 0, 'Pending preparation must block the first provider request');
          assert.equal(settled, false);
          if (name === 'rpc-abort') {
            const response = await rpc.command('abort');
            await pause(200);
            const cancelled = settled && exited(cli.childPid);
            observation.observations.push({ route: 'RPC abort', response, cancelled_pending_input_hook: cancelled, provider_requests: (await rows(providerFile)).length, composer_stop_claimed: false });
            if (!cancelled) observation.observations.push({ route: 'cleanup only', method: 'new_session', reason: 'RPC abort did not cancel the pending extension input hook' });
            await rpc.command('new_session');
          } else if (name === 'new-session') await rpc.command('new_session');
          else { const closing = rpc; await closing.closeInput(); await save(join(retained, 'pi-rpc.json'), closing.frames); rpc = undefined; }
          if (name !== 'eof') await until('pending submission settles after lifecycle boundary', async () => settled);
          const submitted = name === 'eof' && !settled ? { channel_closed: true, terminal_reply_observed: false, boundary: 'Natural EOF closed the actual host; no RPC terminal reply is promised after transport shutdown' } : await submission;
          await until('all owned prepare descendants exit', async () => [wrapper.pid, wrapper.childPid, cli.childPid].every(exited));
          const completed = await until('prepare exit receipt', async () => (await rows(ledger.ledger)).find(event => event.requestId === wrapper.requestId && event.phase === 'completed'));
          assert.notEqual(completed.code, 0, 'Lifecycle cancellation cannot complete as a successful prepare');
          assert.ok((await rows(lifecycleFile)).some(event => event.event === 'session_shutdown'), 'The actual Pi session shutdown hook must run');
          assert.equal((await rows(providerFile)).length, 0);
          const messages = rpc ? (await rpc.command('get_messages')).messages : [];
          assert.equal(messages.some(message => textContent(message.content).includes('GRAPH_ROOT_WORKFLOW_COMPLETE')), false, 'Cancelled work must not publish a late body');
          observation.observations.push({ route: name === 'eof' ? 'native RPC stdin EOF' : name === 'rpc-abort' ? 'post-probe new_session cleanup' : 'new_session', provider_requests: 0, body_receipts: 0, wrapper_pid: wrapper.pid, fixture_pid: wrapper.childPid, actual_cli_pid: cli.childPid, exit: completed.code, signal: completed.signal, submission: submitted });
          if (name === 'new-session') { await fixture.setState({ scenario: 'normal' }); await rpc.prompt('$graph-root@notion Retry the selected workflow in this new session.'); const captures = await rows(providerFile); observation.retry = verifyBodies(captures.at(-1).context, fixture.graph, fixture.graph.useIds); }
        } else if (['missing', 'budget', 'required-router', 'required-prompt'].includes(name)) {
          let reported;
          try { await rpc.prompt(`${rootToken} Apply the selected workflow.`); } catch (error) { reported = error.message; }
          assert.equal((await rows(providerFile)).length, 0, 'Incomplete Required closure must block the first provider request');
          const failed = (await rows(fixture.callsPath)).filter(event => event.phase === 'cli-completed' && event.category === 'installed-cli-prepare');
          assert.equal(failed.length, 1, 'Failure must reach one actual public prepare request');
          assert.notEqual(failed[0].code, 0);
          const failureReceipt = await json(join(retained, 'source', 'cli-receipts', failed[0].requestId + '.json'));
          const failure = JSON.parse(failureReceipt.stdout);
          assert.equal(failure.ok, false);
          assert.notEqual(failure.error.details?.preparation?.status, 'ready');
          assert.equal(failure.error.details?.preparation?.graph_lock, undefined, 'An incomplete graph cannot publish a usable lock');
          if (fixture.graph.invalidRequired) {
            assert.equal(failure.error.code, 'PREPARE_REQUIRED_KIND');
            assert.equal(failure.error.details.kind, fixture.graph.invalidRequired.record.kind);
            assert.equal(failure.error.details.path.at(-1), fixture.graph.invalidRequired.record.id);
            assert.ok(!(await rows(fixture.callsPath)).some(event => event.phase === 'source-entered' && ['read', 'export'].includes(event.command)), 'Invalid Required content cannot reach body delivery');
          }
          const messages = (await rpc.command('get_messages')).messages;
          assert.ok(!messages.some(message => message.details?.contextBrokerPreparation || (message.details?.records ?? []).some(record => record.loaded === true)), 'Failure cannot create loaded graph receipts');
          observation.observations.push({ provider_requests: 0, code: failure.error.code, preparation_status: failure.error.details?.preparation?.status, reported: reported ?? 'host handled blocked input' });
        } else {
          const prompt = ['cold-dollar', 'renamed-identities'].includes(name) ? `${rootToken} Apply the selected workflow.` : name === 'cold-native' ? `/skill:${nativeName} Apply the selected workflow.` : name === 'multi-root' ? `${rootToken} $${fixture.graph.secondary.record.alias}@notion Apply both selected workflows.` : name === 'native-chain' ? 'Read the available root, then follow its optional directory to explain the linked ledger evidence.' : name === 'tool-inspect' ? 'Inspect the available root without executing its workflow.' : ['tool-use', 'cold-pin'].includes(name) ? 'Prepare the available workflow before using it.' : 'Describe only the available skill names. Do not open files.';
          await rpc.prompt(prompt);
          const captures = await rows(providerFile);
          assert.ok(captures.length);
          observation.tool_names = verifyNoShell(captures[0].context);
          const entries = nativeEntries(host, captures[0].context);
          assert.deepEqual(entries.map(entry => entry.name), [nativeName], 'The default native View presents only the root');
          const firstUse = ['cold-dollar', 'cold-native', 'multi-root', 'renamed-identities'].includes(name);
          observation.first_provider = verifyBodies(captures[0].context, fixture.graph, firstUse ? name === 'multi-root' ? [...fixture.graph.useIds, fixture.graph.secondary.record.id] : fixture.graph.useIds : []);
          if (name === 'metadata') {
            assert.equal((await rows(fixture.callsPath)).filter(event => event.phase === 'cli-spawned' && event.category?.startsWith('installed-cli-')).length, 0, 'Metadata discovery must not prepare or read bodies');
          } else {
            const expected = name === 'native-chain' ? [fixture.graph.root.record.id, fixture.graph.member.record.id] : name === 'tool-inspect' ? [fixture.graph.root.record.id] : name === 'multi-root' ? [...fixture.graph.useIds, fixture.graph.secondary.record.id] : fixture.graph.useIds;
            observation.last_provider = verifyBodies(captures.at(-1).context, fixture.graph, expected, { resource: name === 'native-chain' });
            const messages = (await rpc.command('get_messages')).messages;
            await save(join(retained, 'session-messages.json'), messages);
            observation.receipts = verifySessionReceipts(messages, fixture.graph.nodes.filter(node => expected.includes(node.record.id)));
            if (name === 'native-chain') {
              const calls = messages.filter(message => message.role === 'assistant').flatMap(message => (message.content ?? []).filter(part => part.type === 'toolCall'));
              assert.deepEqual(calls.map(call => call.name), ['read', 'read', 'read']);
              assert.ok(calls[1].arguments.path.startsWith('skill://') && calls[2].arguments.path.includes('file_id=resource-graph-member-1'));
              observation.observations.push({ directory_target: 'derived from actual root read', resource_target: 'derived from actual Member read; stable file_id resolves renamed path', requires_bodies: 0 });
            }
            if (['cold-dollar', 'multi-root', 'renamed-identities'].includes(name)) {
              const prepareCalls = (await rows(fixture.callsPath)).filter(event => event.phase === 'source-entered' && event.command === 'prepare');
              assert.equal(prepareCalls.length, 1, 'The submission must batch its roots into one graph preparation');
              if (name === 'multi-root') assert.equal(prepareCalls[0].args.filter(arg => arg.startsWith('skill://')).length, 2);
            }
            if (name === 'cold-pin') observation.observations.push({ current_snapshot: fixture.graph.changedRoot.snapshot_id, selected_snapshot: fixture.graph.root.snapshot_id, historical_pin_preserved: true });
            if (name === 'renamed-identities') {
              await rpc.command('new_session');
              await save(planPath, { mode: 'native-chain' });
              const before = (await rows(providerFile)).length;
              await rpc.prompt('Read the available root, then follow its optional directory to explain the linked ledger evidence.');
              const renamedCaptures = (await rows(providerFile)).slice(before);
              assert.ok(renamedCaptures.length);
              const selected = [fixture.graph.root.record.id, fixture.graph.member.record.id];
              observation.renamed_native = { first_provider: verifyBodies(renamedCaptures[0].context, fixture.graph, []), last_provider: verifyBodies(renamedCaptures.at(-1).context, fixture.graph, selected, { resource: true }) };
              const renamedMessages = (await rpc.command('get_messages')).messages;
              await save(join(retained, 'renamed-native-session-messages.json'), renamedMessages);
              observation.renamed_native.receipts = verifySessionReceipts(renamedMessages, fixture.graph.nodes.filter(node => selected.includes(node.record.id)));
              const calls = renamedMessages.filter(message => message.role === 'assistant').flatMap(message => (message.content ?? []).filter(part => part.type === 'toolCall'));
              assert.deepEqual(calls.map(call => call.name), ['read', 'read', 'read']);
              const resourceId = fixture.graph.member.file_bindings.find(file => file.path === fixture.graph.resource.path).file_id;
              assert.equal(new URL(calls[2].arguments.path).searchParams.get('file_id'), resourceId);
              observation.observations.push({ identity_variant: fixture.graph.identityVariant, changed: ['names', 'aliases', 'library_id', 'skill_ids', 'page_ids', 'database_id', 'data_source_id', 'view_id', 'file_ids', 'resource_paths'], first_use: 'complete deduplicated closure', later_native_selection: 'public catalog and body links only; no target in provider plan', required_bodies_in_inspect: 0 });
            }
          }
          assert.equal((await rows(fixture.httpPath)).length, 0, 'Offline graph consumer must not contact the loopback HTTP probe');
          observation.provider_requests = captures.length;
        }
        observation.status = 'passed';
      } catch (error) { observation.status = 'failed'; observation.error = error.stack ?? error.message; throw error; }
      finally {
        if (rpc) { await save(join(retained, 'pi-rpc.json'), rpc.frames); await rpc.stop(); }
        await fixture.close();
        const calls = await rows(fixture.callsPath), requests = await rows(ledger.ledger);
        observation.processes = { source_wrappers: requests.filter(event => event.phase === 'started' && event.kind === 'cli').length, fixture_processes: new Set(calls.filter(event => event.phase === 'source-entered').map(event => event.pid)).size, actual_cli_processes: calls.filter(event => event.phase === 'cli-spawned' && event.category?.startsWith('installed-cli-')).length, seed_processes: calls.filter(event => event.phase === 'cli-spawned' && event.category === 'fixture-sqlite-seed').length, claim: 'One graph request plus separate fixed read/export processes; all retained, not a single-process claim' };
        observation.metrics = requests.filter(event => event.phase === 'metrics').map(({ command, observed, complete, total_requests, trace_dropped }) => ({ command, observed, complete, total_requests, trace_dropped }));
        await save(join(retained, 'case-result.json'), observation);
        await save(join(output, 'result.json'), result);
      }
    }
    result.status = 'passed';
    return result;
  } catch (error) { result.status = 'failed'; result.error = error.message; error.results = [result]; throw error; }
  finally { result.files = (await filesWithin(output)).map(path => join(label, path)); if (!result.files.includes(join(label, 'result.json'))) result.files.push(join(label, 'result.json')); await save(join(output, 'result.json'), result); }
}

if (process.argv[1] && resolve(process.argv[1]) === helper) {
  if (process.argv[2] === '--seed') await seedSqlite(process.argv[3]);
  else if (process.argv[2] === '--source') await sourceCommand(process.argv[3], process.argv.slice(4));
  else throw new Error('Use the public integration runner with --skill-graph true, or import smokeGraphFixture for the CLI boundary check');
}
