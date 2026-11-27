import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { dailyObserverPreloadSource, observedRows, ownedPiProcesses, observedDailyHostProcess } from './pi-host-observation.mjs';
import { sourceObserverPreloadSource, readSourceObservation } from './skill-consumption-source-observer.mjs';
import { startLoopbackMock, renderHttpWrapper, fixtureProviderId, fixtureModelId, httpBaseUrlEnv } from './mock-provider-adapter.mjs';
import { resolveInstalledPiSerializer, assertWireSources } from './notion-sdk-pi.mjs';
import { fileInventory } from './next-build-identity.mjs';
import { verifyBundledRuntime } from './verify-package-closure.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checkoutRoot = resolve(here, '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const inside = (root, path) => { const local = relative(root, path); return local === '' || local !== '..' && !local.startsWith('..' + sep) && !isAbsolute(local); };
const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const safeState = value => ({ sessionId: value.sessionId, sessionFile: value.sessionFile, messageCount: value.messageCount, isStreaming: value.isStreaming, isCompacting: value.isCompacting });
const identity = async path => { const bytes = await readFile(path); return { path: resolve(path), realpath: await realpath(path), bytes: bytes.length, sha256: hash(bytes) }; };
const readLines = async path => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
export function validateCacheConfig(config) {
  assert.equal(config?.version, 1);
  assert.equal(config.scope, 'ordinary-pi-cache-reuse');
  for (const key of ['brokerRoot', 'evidenceRoot'])
    assert.ok(typeof config[key] === 'string' && isAbsolute(config[key]), key + ' must be absolute');
  assert.match(config.library ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.match(config.query ?? '', /^[a-z0-9][a-z0-9-]{0,79}$/);
  assert.ok(Number.isSafeInteger(config.expectedMaxAgeMs) && config.expectedMaxAgeMs > 0, 'Declare the expected body TTL');
  assert.ok(config.pi === undefined || config.pi === 'pi' || typeof config.pi === 'string' && isAbsolute(config.pi));
  assert.ok(config.cwd === undefined || typeof config.cwd === 'string' && isAbsolute(config.cwd));
  return { package: resolve(config.brokerRoot), out: resolve(config.evidenceRoot), library: config.library,
    query: config.query, maxAgeMs: config.expectedMaxAgeMs, pi: config.pi ?? 'pi',
    cwd: config.cwd ?? process.cwd(), home: userInfo().homedir };
}

async function configFiles(agentDir) {
  const candidates = ['settings.json', 'context-broker/config.yml', 'context-broker/config.yaml', 'context-broker/config.json'];
  const files = [];
  for (const name of candidates) {
    try { files.push(await identity(join(agentDir, name))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.ok(files.some(file => basename(file.path) === 'settings.json') && files.length >= 2, 'Existing daily settings and Broker source configuration are required');
  return files;
}

async function inspect(opt) {
  const ordinaryHome = await realpath(userInfo().homedir);
  assert.equal(await realpath(homedir()), ordinaryHome, 'Do not replace HOME');
  assert.equal(await realpath(process.env.HOME ?? process.env.USERPROFILE), ordinaryHome, 'HOME must remain the daily home');
  const agentDir = join(ordinaryHome, '.pi/agent');
  if (process.env.PI_CODING_AGENT_DIR)
    assert.equal(await realpath(process.env.PI_CODING_AGENT_DIR), await realpath(agentDir), 'Use the ordinary daily Pi agent directory');
  assert.ok(!process.env.CONTEXT_BROKER_CONFIG, 'Use the ordinary Broker source configuration');
  const notionOrigin = new URL(process.env.NOTION_API_BASE_URL || 'https://api.notion.com');
  assert.ok(notionOrigin.origin === 'https://api.notion.com' && notionOrigin.pathname === '/' && !notionOrigin.search && !notionOrigin.hash && !notionOrigin.username && !notionOrigin.password, 'Live proof requires the official Notion origin');
  const packageRoot = await realpath(opt.package), meta = await json(join(packageRoot, 'package.json'));
  assert.equal(meta.name, 'pi-context-broker');
  assert.ok(!inside(checkoutRoot, packageRoot), 'Select an independent ordinary installed package');
  assert.ok(!inside(checkoutRoot, opt.out) && !inside(packageRoot, opt.out), 'Evidence must be outside source and installed package');
  const settingsPath = join(agentDir, 'settings.json'), settings = await json(settingsPath);
  const matching = [];
  for (const entry of settings.packages ?? []) {
    const spec = typeof entry === 'string' ? entry : entry?.source;
    if (typeof spec !== 'string' || !isAbsolute(spec) && !spec.startsWith('.')) continue;
    const resolved = await realpath(resolve(agentDir, spec)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (resolved === packageRoot) matching.push(spec);
  }
  assert.equal(matching.length, 1, 'Daily settings must register the selected installed Broker once');
  const runtime = await json(join(packageRoot, 'dist/ntn-skills-runtime.json'));
  const runtimeHashes = verifyBundledRuntime({ manifest: runtime, expectedVersion: runtime.package_version,
    cliBytes: await readFile(join(packageRoot, 'dist/ntn-skills.mjs')),
    sdkBytes: await readFile(join(packageRoot, 'dist/ntn-skills-sdk.mjs')),
    refBytes: await readFile(join(packageRoot, 'dist/ntn-skills-ref.cjs')) });
  const host = { ...await resolveHost(opt.pi) };
  host.launcher = await identity(host.path); host.parent_pid = process.pid;
  await access(opt.cwd);
  const inventory = await fileInventory(packageRoot, ['package.json', 'src', 'dist']);
  const files = await Promise.all(inventory.files.map(file => identity(join(packageRoot, file.path))));
  return { packageRoot, packageVersion: meta.version, agentDir, notion_api_origin: notionOrigin.origin,
    configuration: await configFiles(agentDir), host, files, inventory, runtimeHashes };
}

function resultPreload(output, ownerParentPid) {
  return [
    "const fs=require('node:fs'),dc=require('node:diagnostics_channel');",
    "if(require('node:worker_threads').isMainThread && process.ppid===" + ownerParentPid + ") {",
    "const fd=fs.openSync(" + JSON.stringify(output) + ",'wx',0o600);let errors=0,count=0;",
    "const write=v=>fs.writeSync(fd,JSON.stringify({pid:process.pid,at:new Date().toISOString(),...v})+'\\n');",
    "write({event:'start'});",
    "dc.subscribe('context-broker.notion-sdk-result',event=>{if(event.operation!=='consume')return;try{const line=JSON.stringify({event:'result',...event});if(Buffer.byteLength(line)>16777216)throw Error('RESULT_TOO_LARGE');write({event:'result',...event});count++;}catch{errors++;write({event:'error'});}});",
    "process.once('exit',()=>{write({event:'end',count,errors,complete:errors===0});fs.closeSync(fd);});",
    "}", ""
  ].join('\n');
}

function sessionObserver() {
  return [
    "import {writeFileSync} from 'node:fs';",
    "import {join} from 'node:path';",
    "export default function observer(pi){",
    "pi.registerCommand('normal-cache-proof',{description:'Snapshot the owned cache proof session.',handler:async(label,ctx)=>{",
    "if(!/^(initial|final)$/.test(label))throw Error('Invalid proof snapshot');",
    "await ctx.waitForIdle();",
    "writeFileSync(join(process.env.NORMAL_CACHE_PROOF_PHASE,'session-'+label+'.json'),JSON.stringify({pid:process.pid,session_file:ctx.sessionManager.getSessionFile(),branch:ctx.sessionManager.getBranch(),projection:ctx.sessionManager.buildSessionProjection?.()},null,2)+'\\n',{flag:'wx',mode:0o600});",
    "}});", "}", ""
  ].join('\n');
}

export function findSelection(reports, query) {
  const records = [];
  for (const report of reports) {
    let record;
    for (const line of report.split('\n')) {
      const selection = /^\$(\S+)$/u.exec(line);
      if (selection) { record = { selection: selection[1] }; records.push(record); continue; }
      const field = /^\s+(kind|source|page): (.+)$/u.exec(line);
      if (field && record) record[field[1]] = field[2];
    }
  }
  const candidates = records.filter(row => row.selection.split('@')[0] === query && row.kind === 'skill' && row.source === 'notion');
  const unique = [...new Map(candidates.map(row => [JSON.stringify(row), row])).values()];
  assert.equal(unique.length, 1, 'Freeze one actual live Notion Skill alias from find; ambiguity requires review');
  assert.match(unique[0].page ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  return unique[0];
}

async function snapshot(rpc, phaseDir, label) {
  const acknowledgment = await rpc.command('prompt', { message: '/normal-cache-proof ' + label });
  assert.equal(acknowledgment?.disposition, 'handled');
  return json(join(phaseDir, 'session-' + label + '.json'));
}

export function completeGraph(event, target, opt) {
  assert.equal(event.value?.status, 'ready', 'Skill consumption must complete');
  const graph = event.value.preparation;
  assert.equal(graph?.status, 'ready');
  assert.equal(graph.roots.length, 1);
  const prepared = graph.nodes.filter(node => node.state === 'prepared');
  const root = prepared.find(node => node.id === graph.roots[0].id);
  assert.ok(root);
  assert.equal(root.record?.locator?.page_id, target.page, 'Actual graph root must match the live find record');
  assert.equal(root.record?.locator?.library_id, opt.library);
  const required = new Set([...graph.roots.map(node => node.id), ...graph.required_closure]);
  assert.deepEqual([...new Set(prepared.map(node => node.id))].sort(), [...required].sort(), 'Every root and transitive Requires body must be prepared');
  for (const edge of graph.required) assert.ok(required.has(edge.from) && required.has(edge.to));
  for (const node of prepared) {
    assert.ok(typeof node.content === 'string' && node.content.length > 0);
    assert.equal(Buffer.byteLength(node.content), node.bytes);
    assert.equal(hash(node.content), node.body_sha256);
    assert.equal(node.binding.body_sha256, node.body_sha256);
    assert.ok(node.binding.scope && node.binding.snapshot_id);
    assert.ok(Number.isFinite(Date.parse(node.freshness?.validated_at)), 'Actual validation timestamp is required');
    assert.equal(node.freshness.max_age_ms, opt.maxAgeMs);
    assert.equal(node.freshness.stale, false);
    assert.ok(node.freshness.age_ms >= 0 && node.freshness.age_ms < opt.maxAgeMs);
    for (const child of node.required) assert.ok(required.has(child.id), 'An actual required edge is missing from the graph');
  }
  return { graph, prepared, root };
}

async function phase(name, opt, info, classifyDailyHttp, target, serializer) {
  const phaseDir = join(opt.out, name);
  await mkdir(phaseDir, { mode: 0o700 });
  const observerDir = join(phaseDir, 'http'), sessions = join(phaseDir, 'sessions');
  await mkdir(observerDir, { mode: 0o700 }); await mkdir(sessions, { mode: 0o700 });
  const cli = info.files.find(file => file.path === join(info.packageRoot, 'dist', 'ntn-skills.mjs'));
  const processLedger = join(phaseDir, 'processes.jsonl'), sourceLedger = join(phaseDir, 'source.jsonl');
  const resultLedger = join(phaseDir, 'consume-results.jsonl');
  const httpPreload = join(phaseDir, 'http.cjs'), sourcePreload = join(phaseDir, 'source.mjs'), consumePreload = join(phaseDir, 'consume.cjs');
  await writeFile(processLedger, '', { mode: 0o600, flag: 'wx' });
  await writeFile(httpPreload, dailyObserverPreloadSource({ directory: observerDir, cliEntry: cli.realpath, ownerParentPid: process.pid, library: opt.library }), { mode: 0o600, flag: 'wx' });
  await writeFile(sourcePreload, sourceObserverPreloadSource({ output: sourceLedger, checkoutRoot, clockId: randomUUID(), cliPath: cli.realpath, ownerParentPid: process.pid, ownerPackage: { packageName: '@earendil-works/pi-coding-agent', binName: 'pi' } }), { mode: 0o600, flag: 'wx' });
  await writeFile(consumePreload, resultPreload(resultLedger, process.pid), { mode: 0o600, flag: 'wx' });
  const env = { ...process.env, BROKER_E2E_PROCESS_LEDGER: processLedger, NORMAL_CACHE_PROOF_PHASE: phaseDir,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require=' + JSON.stringify(httpPreload), '--require=' + JSON.stringify(consumePreload), '--import=' + JSON.stringify(sourcePreload)].filter(Boolean).join(' ') };
  const args = ['--session-dir', sessions];
  let provider, rpc;
  const providerBodies = [];
  const receipt = { phase: name, evidence_level: 'ordinary-Pi/live-Notion/controlled-provider', status: 'failed', started_at: new Date().toISOString(),
    launch: { host: opt.pi, cwd: opt.cwd, args, daily_home: opt.home, normal_plugins: true, installed_broker_injected: false, existing_cache_preserved: true } };
  try {
    if (name !== 'D') {
      const observerPath = join(phaseDir, 'session-observer.mjs'), providerPath = join(phaseDir, 'provider.mjs');
      await writeFile(observerPath, sessionObserver(), { mode: 0o600, flag: 'wx' });
      await writeFile(providerPath, renderHttpWrapper({ helperUrl: pathToFileURL(join(here, 'mock-provider-adapter.mjs')).href, serializerUrl: pathToFileURL(serializer.serializer.path).href }), { mode: 0o600, flag: 'wx' });
      provider = await startLoopbackMock({ selectCall: () => null, limits: { maxRequests: 8 }, onBody: async (record, bytes) => {
        const file = 'provider-wire-' + (providerBodies.length + 1) + '.json';
        const body = JSON.parse(bytes.toString('utf8'));
        providerBodies.push({ file, bytes: bytes.length, sha256: hash(bytes), body });
        await writeFile(join(phaseDir, file), bytes, { mode: 0o600, flag: 'wx' });
      } });
      env[httpBaseUrlEnv] = provider.baseUrl;
      args.push('-e', observerPath, '-e', providerPath, '--provider', fixtureProviderId, '--model', fixtureModelId);
    }
    receipt.launch.args = ['--mode', 'rpc', ...args];
    rpc = await startRpc({ host: opt.pi, cwd: opt.cwd, env, args, timeoutMs: 120000 });
    receipt.initial_session = safeState(await rpc.command('get_state'));
    assert.ok(receipt.initial_session.sessionId && !receipt.initial_session.isStreaming && !receipt.initial_session.isCompacting);
    assert.equal(receipt.initial_session.messageCount, 0, 'The proof requires a fresh session');
    if (receipt.initial_session.sessionFile) assert.ok(inside(sessions, resolve(receipt.initial_session.sessionFile)));
    const registered = (await rpc.command('get_commands')).commands.filter(command => command.name === 'context-broker');
    assert.equal(registered.length, 1);
    assert.equal(registered[0].source, 'extension');
    const entry = await identity(registered[0].sourceInfo.path);
    assert.ok(inside(info.packageRoot, entry.realpath), 'Ordinary Pi loaded a different Broker');
    const expected = info.files.find(file => file.realpath === entry.realpath);
    assert.ok(expected && expected.sha256 === entry.sha256, 'Loaded Broker must match the independent installed bytes');
    receipt.autoload = { name: 'context-broker', entry, source: 'extension', injected_by_cli: false };
    if (name === 'D') {
      const diagnostics = [];
      for (const message of ['/context-broker find ' + opt.query, '/context-broker doctor']) {
        const start = rpc.frames.length;
        const acknowledgment = await rpc.command('prompt', { message });
        assert.equal(acknowledgment?.disposition, 'handled', 'Diagnostic commands must not dispatch to a model');
        const reports = rpc.frames.slice(start).filter(frame => frame.type === 'extension_ui_request' && frame.method === 'notify').flatMap(strings).filter(text => /^(context-broker find:|Context Broker Doctor)/u.test(text));
        assert.ok(reports.length, 'Actual command notification is missing');
        diagnostics.push({ message, reports, disposition: acknowledgment.disposition });
        if (message.startsWith('/context-broker find ')) receipt.selection = findSelection(reports, opt.query);
        else {
          const lines = reports.flatMap(report => report.split('\n'));
          assert.ok(lines.includes('Config diagnostics: ok'));
          assert.ok(reports.some(text => text.includes('direct Notion API 2026-03-11, authentication available')));
          receipt.doctor = { configuration: 'ok', authentication: 'available', namespace_status: lines.includes('Namespace: failed') ? 'failed' : 'ok', namespace_failures: lines.filter(line => /^\s+fail /u.test(line)) };
        }
      }
      await save(join(phaseDir, 'diagnostics.json'), diagnostics);
      assert.equal(rpc.frames.filter(frame => ['agent_start', 'tool_execution_start'].includes(frame.type) || frame.type === 'message_start' && frame.message?.role === 'assistant').length, 0);
    } else {
      const initial = await snapshot(rpc, phaseDir, 'initial');
      assert.equal(initial.branch.some(entry => entry.customType === 'context-broker-selected-graph'), false, 'Fresh process must not inherit a selected graph');
      receipt.initial_branch = { pid: initial.pid, session_file: initial.session_file, selected_graphs: 0 };
      const started = performance.now();
      await rpc.prompt('$' + target.selection + ' Apply this Skill to this task.');
      receipt.prompt_elapsed_ms = performance.now() - started;
      receipt.final_branch = await snapshot(rpc, phaseDir, 'final').then(value => ({ pid: value.pid, session_file: value.session_file, selected_graphs: value.branch.filter(entry => entry.customType === 'context-broker-selected-graph').length }));
    }
    receipt.final_session = safeState(await rpc.command('get_state'));
    assert.equal(receipt.final_session.sessionId, receipt.initial_session.sessionId);
    assert.equal(receipt.final_session.isStreaming, false);
    await rpc.closeInput();
    await save(join(phaseDir, 'rpc.json'), rpc.frames);
    await save(join(phaseDir, 'lifecycle.json'), rpc.lifecycle);
    const observed = await observedRows(observerDir), owned = await ownedPiProcesses(processLedger);
    receipt.host = observedDailyHostProcess(info.host, owned, observed, receipt.launch.args);
    const sourceObservation = await readSourceObservation(sourceLedger);
    assert.equal(sourceObservation.events[0]?.pid, receipt.host.pid);
    const sourcePids = new Set(observed.filter(row => row.event === 'process_start' && row.real_entry === cli.realpath).map(row => row.pid));
    for (const row of observed.filter(row => row.event === 'child_close' && sourcePids.has(row.child_pid))) {
      assert.equal(row.code, 0); assert.equal(row.signal, null); assert.equal(row.receipt?.ok, true);
    }
    const partition = classifyDailyHttp(observed, sourcePids, new Set([receipt.host.pid]), {
      sourceObservation, sdkAttemptPolicy: 'recovered-metadata-rate-limit',
    });
    const sourceEvents = sourceObservation.events;
    const operations = sourceEvents.filter(row => row.phase === 'started' && row.kind === 'sdk').map(row => ({
      requestId: row.requestId, operation: row.operation, source_id: row.source_id, library: row.library,
      elapsed_ms: sourceEvents.find(event => event.phase === 'completed' && event.requestId === row.requestId)?.elapsedMs,
      http_requests: sourceEvents.find(event => event.phase === 'metrics' && event.requestId === row.requestId)?.total_requests,
    }));
    const terminal = observed.filter(row => row.pid === receipt.host.pid && row.event === 'http_observer_end');
    assert.equal(terminal.length, 1); assert.equal(terminal[0].errors, 0);
    const pending = observed.filter(row => row.event === 'http_created' && row.origin === 'https://api.notion.com' && !observed.some(end => ['http_end', 'http_error'].includes(end.event) && end.pid === row.pid && end.id === row.id));
    assert.equal(pending.length, 0, 'Unfinished Notion HTTP cannot prove cache reuse');
    receipt.operations = operations;
    receipt.http = { sdk_requests: partition.sdk.length, doctor_cli_requests: partition.source.length - partition.sdk.length,
      directory_requests: partition.sdk.filter(row => row.attribution.operation === 'list').length,
      metadata_requests: partition.sdk.filter(row => row.attribution.request_kind !== 'notion_body').length,
      notion_body_requests: partition.sdk.filter(row => row.attribution.request_kind === 'notion_body').length,
      library_root_structure_requests: partition.sdk.filter(row => row.attribution.request_kind === 'notion_body'
        && row.attribution.target?.block_id === opt.library && row.structure?.kind === 'root-children' && row.structure.root === opt.library).length,
      consumption_requests: partition.sdk.filter(row => !['library-selection', 'candidates', 'library', 'list'].includes(row.attribution.operation)).length,
      all_target_requests: partition.source.length,
      sdk_attempts_all_succeeded: partition.recoveredRateLimits.length === 0,
      recovered_rate_limit_requests: partition.recoveredRateLimits.length,
      recovered_rate_limits: partition.recoveredRateLimits,
      other_plugin_requests: partition.otherPlugins.length, unattributed_host_requests: partition.unattributedHostHttp.length,
      proxy_tunnels: partition.proxyTunnels.length, host_transport_end: terminal[0],
      scope: 'Actual owned Pi SDK plus bundled doctor CLI; independent HTTP matched by PID and response request ID. Other plugins, non-Notion host HTTP and proxy CONNECT are separate. Worker transport is outside this observer.' };
    await save(join(phaseDir, 'http-partition.json'), partition);
    const consumeRows = await readLines(resultLedger);
    assert.equal(consumeRows[0]?.event, 'start'); assert.equal(consumeRows.at(-1)?.event, 'end'); assert.equal(consumeRows.at(-1)?.complete, true);
    assert.ok(consumeRows.every(row => row.pid === receipt.host.pid));
    const consumes = consumeRows.filter(row => row.event === 'result' && row.operation === 'consume');
    if (name === 'D') assert.equal(consumes.length, 0);
    else {
      assert.equal(sourcePids.size, 0, 'Body phases must use SDK consumption, without a doctor subprocess');
      const relevant = consumes.filter(row => row.value?.preparation?.nodes?.some(node => node.state === 'prepared' && node.record?.locator?.page_id === target.page));
      assert.equal(relevant.length, 1, 'One actual root consumption graph is required');
      const event = relevant[0], proof = completeGraph(event, target, opt);
      const operation = operations.find(row => row.requestId === 'sdk:' + receipt.host.pid + ':' + event.id);
      assert.ok(operation && operation.operation === 'consume' && operation.library === opt.library && typeof operation.source_id === 'string');
      assert.ok(providerBodies.length > 0);
      for (const body of providerBodies) assertWireSources(body.body, proof.prepared.map(node => node.content));
      assert.ok(provider.requests.every(row => row.phase === 'responded' && row.status === 200));
      receipt.selection = target;
      receipt.consume = operation;
      receipt.graph = { scope: proof.graph.scope, required: proof.graph.required, roots: proof.graph.roots, required_closure: proof.graph.required_closure,
        nodes: proof.prepared.map(node => ({ id: node.id, source: node.source, bytes: node.bytes, body_sha256: node.body_sha256, binding_scope: node.binding.scope, snapshot_id: node.binding.snapshot_id, version_id: node.binding.version_id, freshness: node.freshness })) };
      receipt.provider = { kind: 'controlled-loopback', actual_pi_serializer: serializer, requests: providerBodies.map(({ body, ...record }) => record), all_complete_bodies_present: true };
      if (name === 'B') {
        assert.equal(operation.http_requests, 0, 'Warm consume issued HTTP');
        assert.equal(receipt.http.consumption_requests, 0, 'Warm body operations issued HTTP');
        assert.equal(operations.some(row => row.operation === 'library'), false, 'Local routing started separate remote Library validation');
        assert.ok(receipt.graph.nodes.every(node => node.source === 'local_cache'));
        assert.equal(receipt.http.notion_body_requests, receipt.http.library_root_structure_requests,
          'Warm directory refresh must not fetch Skill or Requires bodies');
        assert.ok(partition.sdk.every(row => row.attribution.operation === 'list'), 'Every warm SDK request must belong to directory refresh');
      }
    }
    receipt.status = 'passed'; receipt.completed_at = new Date().toISOString();
    return receipt;
  } catch (error) {
    receipt.error = { message: error.message };
    throw error;
  } finally {
    let cleanupError;
    if (rpc && !rpc.lifecycle.some(row => row.event === 'close')) {
      try { await rpc.stop(); }
      catch (error) { cleanupError = error; }
      if (!rpc.lifecycle.some(row => row.event === 'close')) cleanupError ??= new Error('Owned Pi exit was not observed');
    }
    if (rpc) for (const [file, value] of [['rpc.json', rpc.frames], ['lifecycle.json', rpc.lifecycle]]) {
      if (!await access(join(phaseDir, file)).then(() => true, () => false)) await save(join(phaseDir, file), value);
    }
    if (provider) try { await provider.close(); } catch (error) { cleanupError ??= error; }
    if (cleanupError) {
      receipt.status = 'failed'; receipt.cleanup_error = { message: cleanupError.message };
    }
    await save(join(phaseDir, 'result.json'), receipt);
    if (cleanupError) throw cleanupError;
  }
}

/** Receipt checks shared by the live action and its rejection tests. Raw body and
 * independent HTTP checks happen in phase() before a receipt can pass. */
export function validateCacheReuse(d, a, b, maxAgeMs) {
  for (const phase of [d, a, b]) {
    assert.equal(phase.status, 'passed');
    assert.equal(phase.host.observed_exit, true, 'Every owned Pi must close');
    assert.equal(phase.initial_session.messageCount, 0, 'Require fresh sessions');
    for (const key of ['entry', 'package', 'node'])
      assert.deepEqual(phase.host[key], d.host[key], 'All sessions must use the same observed Pi and Node');
  }
  assert.equal(new Set([d.host.pid, a.host.pid, b.host.pid]).size, 3, 'Require separate Pi processes');
  assert.equal(new Set([d.initial_session.sessionId, a.initial_session.sessionId, b.initial_session.sessionId]).size, 3, 'Require separate Pi sessions');
  assert.notEqual(a.final_branch.session_file, b.final_branch.session_file);
  assert.deepEqual([b.consume.source_id, b.consume.library, b.graph.scope], [a.consume.source_id, a.consume.library, a.graph.scope]);
  for (const phase of [a, b]) {
    assert.equal(phase.initial_branch.selected_graphs, 0, 'Do not inherit an active graph');
    assert.equal(phase.provider.all_complete_bodies_present, true);
    assert.ok(phase.provider.requests.length > 0, 'Actual provider wire is required');
    for (const node of phase.graph.nodes) {
      assert.equal(node.freshness.max_age_ms, maxAgeMs);
      assert.equal(node.freshness.stale, false);
      assert.ok(node.freshness.age_ms >= 0 && node.freshness.age_ms < maxAgeMs);
    }
  }
  assert.equal(b.consume.http_requests, 0, 'Warm consume issued HTTP');
  assert.equal(b.http.consumption_requests, 0, 'Warm body operations issued HTTP');
  assert.equal(b.http.notion_body_requests, b.http.library_root_structure_requests, 'Warm Skill bodies must not be fetched');
  assert.equal(b.operations.some(row => row.operation === 'library'), false, 'Local routing must not verify Library remotely');
  assert.ok(b.graph.nodes.length > 0 && b.graph.nodes.every(node => node.source === 'local_cache'));
  assert.deepEqual(b.graph.roots, a.graph.roots);
  assert.deepEqual(b.graph.required, a.graph.required);
  assert.deepEqual(b.graph.required_closure, a.graph.required_closure);
  const stable = phase => phase.graph.nodes.map(node => ({
    id: node.id, bytes: node.bytes, body_sha256: node.body_sha256, binding_scope: node.binding_scope,
    snapshot_id: node.snapshot_id, version_id: node.version_id, validated_at: node.freshness.validated_at,
    policy: node.freshness.policy, policy_source: node.freshness.policy_source,
    profile_fingerprint: node.freshness.profile_fingerprint,
    current_eligibility_max_age_ms: node.freshness.current_eligibility_max_age_ms,
  })).sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(stable(b), stable(a), 'Warm reuse must preserve original versions, full bodies and validation timestamps');
}

function describePlan(opt, info) {
  return { version: 1, kind: 'ordinary-pi-cache-reuse', status: 'prepared_not_executed',
    installed_broker: info.packageRoot, pi: info.host.path, home: opt.home, library: opt.library,
    query: opt.query, evidence: opt.out,
    phases: ['D ordinary Pi doctor/find, no model', 'A fresh ordinary Pi baseline body consumption', 'B fresh ordinary Pi same live alias, zero consumption HTTP'],
    expected_body_max_age_ms: opt.maxAgeMs, existing_cache: 'preserved',
    controlled_provider: 'loopback, actual installed Pi serializer; Notion remains live',
    observation: 'Complete root and transitive Requires bodies, original snapshot and validation time, independent HTTP from process start through close. Directory and root-structure refresh are counted separately; this action does not assert global Pi HTTP is zero.',
    not_proven: ['natural-model behavior', 'another machine', 'current-next delivery aggregate', 'live positive Requires when selected graph has no required edges'] };
}
export async function cachePlan(config) {
  const opt = validateCacheConfig(config);
  return describePlan(opt, await inspect(opt));
}
export async function runCache(config, { classifyDailyHttp }) {
  assert.equal(typeof classifyDailyHttp, 'function');
  const opt = validateCacheConfig(config), info = await inspect(opt);
  await mkdir(opt.out, { recursive: false, mode: 0o700 });
  const result = { version: 1, kind: 'ordinary-pi-cache-reuse', status: 'failed', started_at: new Date().toISOString(),
    evidence: opt.out, plan: describePlan(opt, info), identity: info, phases: [] };
  try {
    const d = await phase('D', opt, info, classifyDailyHttp); result.phases.push(d);
    await save(join(opt.out, 'frozen-selection.json'), d.selection);
    const serializer = await resolveInstalledPiSerializer(d.host.package.root, d.host.package.version);
    const a = await phase('A', opt, info, classifyDailyHttp, d.selection, serializer); result.phases.push(a);
    const b = await phase('B', opt, info, classifyDailyHttp, d.selection, serializer); result.phases.push(b);
    validateCacheReuse(d, a, b, opt.maxAgeMs);
    for (const file of [info.host.launcher, d.host.entry, d.host.node, d.host.package.manifest, serializer.serializer]) {
      assert.equal(hash(await readFile(file.path)), file.sha256, 'Pi launcher, runtime or serializer changed during proof');
      assert.equal(await realpath(file.path), file.realpath ?? file.path, 'Pi runtime selection changed during proof');
    }
    assert.deepEqual(await fileInventory(info.packageRoot, ['package.json', 'src', 'dist']), info.inventory, 'Installed package changed during proof');
    assert.deepEqual(await configFiles(info.agentDir), info.configuration, 'Daily configuration changed during proof');
    result.summary = { alias: '$' + d.selection.selection, page: d.selection.page, body_max_age_ms: opt.maxAgeMs,
      baseline_pid: a.host.pid, warm_pid: b.host.pid, prepared_nodes: b.graph.nodes.length, required_edges: b.graph.required.length,
      baseline_sdk_http: a.http.sdk_requests, warm_sdk_http: b.http.sdk_requests,
      recovered_rate_limit_requests: result.phases.reduce((sum, phase) => sum + phase.http.recovered_rate_limit_requests, 0),
      warm_directory_http: b.http.directory_requests, warm_metadata_http: b.http.metadata_requests,
      warm_library_root_structure_http: b.http.library_root_structure_requests,
      warm_consume_http: b.consume.http_requests, warm_all_consumption_operations_http: b.http.consumption_requests,
      warm_consume_elapsed_ms: b.consume.elapsed_ms, warm_prompt_elapsed_ms: b.prompt_elapsed_ms,
      original_validated_at_preserved: true, complete_root_and_requires_in_actual_provider_wire: true,
      baseline_is_not_assumed_cold: true, directory_refresh_necessity: 'not asserted by this ordinary-installation action',
      actual_freshness: b.graph.nodes.map(node => ({ id: node.id, ...node.freshness })),
      diagnostic_namespace_status: d.doctor.namespace_status };
    result.status = 'passed';
  } catch (error) {
    result.error = { message: error.message };
  } finally {
    result.completed_at = new Date().toISOString();
    await save(join(opt.out, 'result.json'), result);
  }
  return result;
}
