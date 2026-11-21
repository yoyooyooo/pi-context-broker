import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { loadAgentCorpus, bindAgentScenario, bindAgentTurn } from './notion-agent-scenarios.mjs';
import { consumptionCostExtensionSource, readConsumptionCostEvents } from './skill-consumption-cost.mjs';
import { providerTransportExtensionSource, readProviderTransport } from './skill-consumption-provider.mjs';
import { sourceObserverPreloadSource, readSourceObservation } from './skill-consumption-source-observer.mjs';
import { observeGraphSdk } from './notion-skill-graph-model-evidence.mjs';
import { safeRequestMetrics } from './notion-default-context.mjs';
import { verifyBundledRuntime } from './verify-package-closure.mjs';
import { candidateSourceConfig, inspectCandidatePackageRegistration, candidatePayloadBodies, observeCandidateTask, candidateTransportCoverage } from './verify-pi-daily-candidate.mjs';

// This is an implementation of the existing candidate entry, not another host
// driver. Pi is always started and controlled by the shared native RPC helper.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = path => access(path).then(() => true, () => false);
const inside = (base, path) => { const part = relative(base, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const identity = async path => { const bytes = await readFile(path); return { path, realpath: await realpath(path), bytes: bytes.length, sha256: sha(bytes) }; };
const rows = async path => {
  if (!await exists(path)) return [];
  const text = await readFile(path, 'utf8'), end = text.lastIndexOf('\n');
  return end < 0 ? [] : text.slice(0, end).split('\n').filter(Boolean).map(JSON.parse);
};
const time = row => BigInt(row.monotonicNs ?? row.monotonic_ns ?? '0');
const slice = (events, start, end) => events.filter(row => time(row) >= BigInt(start) && time(row) <= BigInt(end));

export function workflowSourceSlice(events, startedNs, endedNs) {
  const ids = new Set(events.filter(row => row.phase === 'started' && time(row) <= BigInt(endedNs) &&
    events.some(end => end.phase === 'completed' && end.requestId === row.requestId && time(end) >= BigInt(startedNs))).map(row => row.requestId));
  return events.filter(row => ids.has(row.requestId) || !row.requestId && time(row) >= BigInt(startedNs) && time(row) <= BigInt(endedNs));
}

async function awaitCatalog(file, timeoutMs) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const events = await rows(file);
    const completed = events.find(row => row.phase === 'completed' && row.kind === 'sdk' && row.operation === 'list');
    if (completed) { assert.equal(completed.status, 'completed', 'Normal catalog preparation failed'); return { requestId: completed.requestId, completedNs: completed.monotonicNs, waitedMs: performance.now() - started }; }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  throw new Error('Normal source catalog did not finish within its bounded startup window');
}

async function command(argv, cwd) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', value => { out += value; }); child.stderr.on('data', value => { err += value; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveCommand(out.trimEnd()) : reject(new Error(argv[0] + ' failed: ' + err.slice(-2000))));
  });
}

export function agentWorkflowArgs(config, sessions, extensions) {
  assert.equal(config.model, 'magpie/group/worker', 'Real Agent workflows require magpie/group/worker');
  assert.equal(config.thinkingLevel, 'high');
  assert.ok(['daily', 'no-native-skills'].includes(config.profile), 'Use daily or no-native-skills');
  return [...(config.profile === 'no-native-skills' ? ['-ns'] : []), '--approve', '--session-dir', sessions,
    '--provider', 'magpie', '--model', 'group/worker', '--thinking', 'high', ...extensions.flatMap(path => ['-e', path])];
}

async function input(config) {
  assert.equal(config.version, 1); assert.equal(config.scope, 'notion-agent-workflow');
  const fields = ['version', 'scope', 'scenarioFile', 'scenarioId', 'profile', 'bindingsFile', 'brokerRoot', 'cliRoot', 'sourceId', 'database', 'packageIndex', 'evidenceRoot', 'model', 'thinkingLevel', 'timeoutMs', 'catalogTimeoutMs', 'viewId', 'retestOf'];
  assert.ok(Object.keys(config).every(key => fields.includes(key)), 'Unsupported natural workflow configuration field');
  for (const key of ['scenarioFile', 'bindingsFile', 'brokerRoot', 'cliRoot', 'evidenceRoot']) assert.ok(isAbsolute(config[key]), key + ' must be absolute');
  assert.ok(!inside(root, config.evidenceRoot), 'Keep run evidence outside the checkout');
  agentWorkflowArgs(config, '/sessions', []);
  const corpus = await loadAgentCorpus(config.scenarioFile), bindings = await json(config.bindingsFile);
  const scenario = bindAgentScenario(corpus, config.scenarioId, bindings, { profile: config.profile });
  assert.ok(bindings.private.fixture?.root && bindings.private.fixture?.runId, 'Use a real owned fixture binding');
  assert.equal(bindings.private.fixture.entry.replaceAll('-', ''), config.database.replaceAll('-', ''), 'The fixture and candidate must use the same library');
  return { corpus, bindings, scenario };
}

export async function planAgentWorkflow(config) {
  const { scenario } = await input(config);
  return { version: 1, scope: config.scope, status: 'prepared_not_executed', scenario: scenario.id,
    contracts: scenario.contract_ids, profile: config.profile, provider: 'magpie', model: 'group/worker', thinkingLevel: 'high',
    turns: scenario.turns.map(turn => ({ id: turn.id, promptSha256: sha(turn.prompt), events: (turn.before ?? []).map(event => event.kind), assertions: turn.expect.map(expect => expect.kind) })),
    preserved: ['normal HOME and global native roots', 'normal extensions and MCP', 'normal Broker local roots', 'original natural prompts'],
    differences: config.profile === 'no-native-skills' ? ['-ns disables default Pi native discovery; Broker local and explicit reads remain'] : [],
    oracle: 'controller-only files; no tools, expected answers or verification Skill inserted into subject prompts',
    scopeBoundary: 'project candidate using the real daily environment; not a two-machine installed-delivery result' };
}

async function sourceIdentity(path, repository) {
  const cwd = await command(['git', '-C', path, 'rev-parse', '--show-toplevel'], root);
  const commit = await command(['git', 'rev-parse', 'HEAD'], cwd);
  const status = await command(['git', 'status', '--porcelain=v1'], cwd);
  const files = (await command(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd)).split('\0').filter(Boolean);
  const hashes = [];
  for (const name of files.sort()) {
    const path = join(cwd, name);
    if (await exists(path)) hashes.push([name, sha(await readFile(path))]);
    else hashes.push([name, 'absent']);
  }
  return { repository, commit, dirty: status.length > 0, tree_sha256: sha(JSON.stringify(hashes)) };
}

async function writeObservers(control, config, host, sourceCache, bodies, index) {
  await mkdir(control, { recursive: true, mode: 0o700 });
  const payloads = join(control, 'payloads'), branches = join(control, 'branches'), responses = join(control, 'sdk-responses');
  for (const path of [payloads, branches, responses]) await mkdir(path, { mode: 0o700 });
  const files = Object.fromEntries(['cost', 'transport', 'tasks', 'source', 'sdk'].map(name => [name, join(control, name + '.jsonl')]));
  const extensions = ['cost', 'transport', 'tasks'].map(name => join(control, name + '.mjs'));
  const clockId = randomUUID();
  await writeFile(extensions[0], consumptionCostExtensionSource({ output: files.cost, checkoutRoot: root, runId: config.runId, sampleId: config.scenarioId + '-' + index, clockId }), { flag: 'wx', mode: 0o600 });
  await writeFile(extensions[1], providerTransportExtensionSource({ output: files.transport, checkoutRoot: root, clockId }), { flag: 'wx', mode: 0o600 });
  await writeFile(extensions[2], "import fs from 'node:fs';import crypto from 'node:crypto';const inspectPayload=" + candidatePayloadBodies.toString()
    + ';export default api=>(' + observeCandidateTask.toString() + ')(api,{fs,crypto,inspectPayload,output:' + JSON.stringify(files.tasks)
    + ',bodyFiles:' + JSON.stringify(bodies.filter(body => body.bytes > 0)) + ',payloadDirectory:' + JSON.stringify(payloads) + ',branchDirectory:' + JSON.stringify(branches) + '});\n', { flag: 'wx', mode: 0o600 });
  const sourcePreload = join(control, 'source.mjs'), sdkPreload = join(control, 'sdk.mjs');
  await writeFile(sourcePreload, sourceObserverPreloadSource({ output: files.source, checkoutRoot: root, clockId,
    cliPath: join(config.brokerRoot, 'dist/ntn-skills.mjs'), ownerParentPid: process.pid, ownerEntry: host.path }), { flag: 'wx', mode: 0o600 });
  await writeFile(sdkPreload, "import fs from 'node:fs';import {channel} from 'node:diagnostics_channel';import {createHash} from 'node:crypto';import {isMainThread} from 'node:worker_threads';const hash=value=>createHash('sha256').update(value).digest('hex');\n"
    + safeRequestMetrics.toString() + '\nif(isMainThread&&process.ppid===' + process.pid + '){const sdk=(' + observeGraphSdk.toString()
    + ')({channel,fs,safeMetrics:safeRequestMetrics,paths:' + JSON.stringify({ ledger: files.sdk, responses, outputRoot: sourceCache })
    + '});let done=false;const finish=()=>{if(!done){done=true;sdk.close();}};process.once("beforeExit",finish);process.once("exit",finish);}\n', { flag: 'wx', mode: 0o600 });
  return { files, extensions, preloads: [sourcePreload, sdkPreload] };
}

/** Invoke through candidate-run --live. All private event handling stays here. */
export async function runAgentWorkflow(config) {
  const { corpus, bindings, scenario } = await input(config);
  const { analyzeNotionAgentTurn, inspectNotionAgentSession, captureNotionAgentSelection } = await import('./notion-agent-analysis.mjs');
  const { runAgentFixtureEvent } = await import('./notion-agent-fixtures.mjs');
  assert.ok(process.env.NOTION_API_TOKEN?.trim(), 'Use the already authorized Notion identity');
  assert.ok(!process.env.PI_CODING_AGENT_DIR && !process.env.CONTEXT_BROKER_CONFIG, 'Keep the normal HOME and Pi agent configuration');
  const plan = await planAgentWorkflow(config), runId = randomUUID();
  await mkdir(config.evidenceRoot, { recursive: true, mode: 0o700 });
  const evidence = await mkdtemp(join(config.evidenceRoot, config.profile + '-' + config.scenarioId + '-'));
  const fixture = bindings.private.fixture;
  const ownership = await json(join(fixture.root, 'ownership.json'));
  assert.equal(ownership.runId, fixture.runId); assert.equal(ownership.token, fixture.ownership.token);
  const settingsPath = join(homedir(), '.pi/agent/settings.json'), sourcePath = join(homedir(), '.pi/agent/context-broker/config.yml');
  const settings = await json(settingsPath), before = { settings: await identity(settingsPath), source: await identity(sourcePath) };
  const { parse } = createRequire(new URL('../packages/context-broker/package.json', import.meta.url))('yaml');
  const source = parse(await readFile(sourcePath, 'utf8'));
  const secretKeys = value => value && typeof value === 'object' && Object.entries(value).some(([key, child]) => /token|secret|password|authorization|api.?key/iu.test(key) || secretKeys(child));
  assert.ok(!secretKeys(source), 'Do not save a source configuration containing credentials');
  const baseline = await Promise.all(['package.json', 'src/index.ts', 'dist/ntn-skills.mjs', 'dist/ntn-skills-sdk.mjs', 'dist/ntn-skills-runtime.json'].map(path => identity(join(config.brokerRoot, path))));
  const cliManifest = await json(join(config.cliRoot, 'package.json'));
  const sdkExport = cliManifest.exports?.['./sdk'];
  const sdkEntry = typeof sdkExport === 'string' ? sdkExport : sdkExport?.import;
  assert.ok(typeof sdkEntry === 'string' && sdkEntry.startsWith('./'), 'The paired package must export its current SDK');
  const cliFiles = await Promise.all(['package.json', 'dist/ntn-skills.js', sdkEntry].map(path => identity(join(config.cliRoot, path))));
  const runtime = await json(baseline[4].path);
  verifyBundledRuntime({ manifest: runtime, cliBytes: await readFile(baseline[2].path), sdkBytes: await readFile(baseline[3].path), expectedVersion: cliManifest.version });
  const build = await json(join(config.brokerRoot, 'dist/next-build.json'));
  for (const file of build.selected_cli.files) assert.equal((await identity(join(config.cliRoot, file.path))).sha256, file.sha256, 'Selected CLI/SDK build input changed: ' + file.path);
  for (const file of build.artifacts.files) assert.equal((await identity(join(config.brokerRoot, file.path))).sha256, file.sha256, 'Embedded build artifact changed: ' + file.path);
  const registration = await inspectCandidatePackageRegistration(settings.packages, { packageIndex: config.packageIndex ?? 1,
    agentDir: join(homedir(), '.pi/agent'), brokerRoot: config.brokerRoot, brokerEntry: baseline[1] });
  const cwd = fixture.projectRoot ?? join(evidence, 'workspace'), sessions = join(evidence, 'sessions'), stateRoot = join(evidence, 'owned-state');
  for (const path of [cwd, join(cwd, '.pi'), sessions, stateRoot]) await mkdir(path, { recursive: true, mode: 0o700 });
  const projectSettings = join(cwd, '.pi/settings.json');
  assert.equal(await exists(projectSettings), false, 'The owned project must not contain an earlier candidate configuration');
  await save(projectSettings, registration.projectSettings);
  const ownedStateRoot = join(stateRoot, 'state'); await mkdir(ownedStateRoot, { mode: 0o700 });
  await save(join(ownedStateRoot, 'agent-workflow-owner.json'), { runId: fixture.runId, fixtureRoot: fixture.root, token: fixture.ownership.token });
  const sourceCache = join(stateRoot, 'broker-cache'), sourceConfigPath = join(evidence, 'source-config.json');
  const candidateSource = candidateSourceConfig(source, { sourceId: config.sourceId, database: config.database, cacheDir: sourceCache, viewId: config.viewId });
  if (scenario.fixture.environment?.offline === true) candidateSource.sources.find(item => item.id === config.sourceId).discovery = { ...candidateSource.sources.find(item => item.id === config.sourceId).discovery, offline: true };
  await save(sourceConfigPath, candidateSource);
  const env = { ...process.env, CONTEXT_BROKER_CONFIG: sourceConfigPath, NTN_SKILLS_HOME: ownedStateRoot,
    NTN_SKILLS_CONFIG_HOME: join(stateRoot, 'config'), NTN_SKILLS_CACHE_HOME: join(stateRoot, 'cache'), NTN_SKILLS_DATA_HOME: join(stateRoot, 'data'),
    NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000', BROKER_E2E_PROCESS_LEDGER: join(evidence, 'owned-processes.jsonl') };
  delete env.NTN_SKILLS_DEV_ROOT;
  if (scenario.fixture.environment?.catalog === 'unauthorized') env.NOTION_API_TOKEN = 'secret_owned_agent_workflow_invalid_identity';
  if (scenario.fixture.environment?.catalog === 'partial-view') assert.ok(config.viewId, 'A partial-view scenario requires a real owned Notion View binding');
  const host = await resolveHost('pi'), { createJiti } = createRequire(host.identity)('jiti');
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
  const { reduceSessionSelection } = await jiti.import(join(config.brokerRoot, 'src/session-graph.ts'));
  const { reduceActiveSources } = await jiti.import(join(config.brokerRoot, 'src/session-active.ts'));
  const { reduceSessionShortRefs } = await jiti.import(join(config.brokerRoot, 'src/session-short-ref.ts'));
  const selection = value => captureNotionAgentSelection({ sessionId: value.sessionId, leafId: value.leafId, branchSha256: sha(JSON.stringify(value.entries)),
    selection: reduceSessionSelection(value.entries), active: reduceActiveSources(value.entries), shortRefs: reduceSessionShortRefs(value.entries) });
  const result = { version: 1, scope: config.scope, status: 'running', runId, evidence, startedAt: new Date().toISOString(), plan,
    sourceTuple: await Promise.all([sourceIdentity(config.brokerRoot, 'broker'), sourceIdentity(config.cliRoot, 'cli')]),
    baseline, cliFiles, runtime, build, host, hostArtifact: await identity(host.identity), before, registration,
    configuration: { normalHome: true, normalAgentDir: true, normalMcpAndExtensions: true, profile: config.profile, ownStateOnly: true, model: 'magpie/group/worker', thinkingLevel: 'high' },
    segments: [], events: [], turns: scenario.turns.map(turn => ({ id: turn.id, status: 'not_run' })), retestOf: config.retestOf ?? null };
  await save(join(evidence, 'config.json'), config); await save(join(evidence, 'initial-bindings.json'), bindings); await save(join(evidence, 'initial-state.json'), { cache: 'cold', stateRoot, ownedStateRoot, sourceCache, oracle: 'independent', createdAt: result.startedAt });
  await save(join(evidence, 'started.json'), result);
  let rpc, segment, currentSession, segmentIndex = 0;
  const forkBindings = new Map();
  const start = async resume => {
    const control = join(evidence, 'observation-' + (++segmentIndex));
    const observer = await writeObservers(control, { ...config, runId }, host, sourceCache, Object.values(bindings.private.bodies), segmentIndex);
    const args = agentWorkflowArgs(config, sessions, observer.extensions);
    if (resume) args.push('--session', resume);
    const actualEnv = { ...env, NODE_OPTIONS: [process.env.NODE_OPTIONS, ...observer.preloads.map(path => '--import=' + JSON.stringify(path))].filter(Boolean).join(' ') };
    rpc = await startRpc({ host: 'pi', cwd, env: actualEnv, args, timeoutMs: config.timeoutMs ?? 600000 });
    const state = await rpc.command('get_state');
    assert.equal(state.model?.provider, 'magpie'); assert.equal(state.model?.id, 'group/worker'); assert.equal(state.thinkingLevel, 'high');
    assert.ok(inside(sessions, resolve(state.sessionFile)), 'Pi must persist the owned session');
    const commands = (await rpc.command('get_commands')).commands;
    const brokers = commands.filter(item => item.name === 'context-broker'); assert.equal(brokers.length, 1);
    assert.ok(inside(await realpath(config.brokerRoot), await realpath(brokers[0].sourceInfo.path)), 'Pi loaded a different Broker');
    segment = { index: segmentIndex, control, observer, sessionId: state.sessionId, sessionFile: state.sessionFile, args, cwd, pid: rpc.lifecycle[0].pid,
      commands: commands.map(item => ({ name: item.name, source: item.source, sourceInfo: item.sourceInfo })), lifecycle: rpc.lifecycle };
    result.segments.push(segment); currentSession = state;
    for (const [file, phase] of [[observer.files.cost, 'observer_start'], [observer.files.transport, 'transport_start'], [observer.files.tasks, 'task_observer_start'], [observer.files.source, 'source_observer_start'], [observer.files.sdk, 'sdk-observer-start']])
      assert.equal((await rows(file))[0]?.phase, phase, 'A required observer did not start');
    await save(join(control, 'commands.json'), segment.commands);
    segment.commandsArtifact = await identity(join(control, 'commands.json'));
    const catalogMode = scenario.fixture.environment?.catalog ?? 'normal';
    if (catalogMode === 'normal' && !scenario.fixture.environment?.offline)
      segment.catalogBarrier = await awaitCatalog(observer.files.source, config.catalogTimeoutMs ?? 90000);
    else segment.catalogBarrier = { mode: catalogMode, waited: false };
  };
  const close = async () => {
    if (!rpc) return;
    await rpc.closeInput();
    segment.cost = await readConsumptionCostEvents(segment.observer.files.cost);
    segment.transport = await readProviderTransport(segment.observer.files.transport);
    segment.source = await readSourceObservation(segment.observer.files.source);
    segment.transportCoverage = candidateTransportCoverage(segment.transport);
    assert.equal(segment.source.complete, true); assert.deepEqual(segment.source.errors, []);
    assert.ok(segment.cost.events.at(-1)?.complete);
    assert.ok((await rows(segment.observer.files.tasks)).at(-1)?.complete);
    rpc = undefined;
  };
  try {
    await start();
    for (let index = 0; index < scenario.turns.length; index++) {
      const declared = corpus.scenarios.find(item => item.id === scenario.id).turns[index], receipt = result.turns[index];
      receipt.status = 'running';
      for (const event of declared.before ?? []) {
        const action = { event, startedNs: process.hrtime.bigint().toString(), afterTurn: index ? result.turns[index - 1].id : null };
        if (event.kind === 'restart') {
          const old = currentSession; await close(); await start(event.mode === 'resume' ? old.sessionFile : undefined);
          assert.equal(currentSession.sessionId === old.sessionId, event.mode === 'resume');
          action.result = { mode: event.mode, priorSessionId: old.sessionId, sessionId: currentSession.sessionId, pid: segment.pid };
        } else if (event.kind === 'fork') {
          const prior = result.turns.find(turn => turn.id === event.turn); assert.ok(prior?.userEntryId, 'Fork requires the actual prior user entry');
          const parentEntries = await rpc.command('get_entries'), byId = new Map(parentEntries.entries.map(entry => [entry.id, entry]));
          const target = byId.get(prior.userEntryId); assert.ok(target, 'Fork target is not in the current native tree');
          const retained = [];
          for (let item = byId.get(target.parentId); item; item = byId.get(item.parentId)) retained.push(item);
          retained.reverse(); assert.ok(retained.length, 'Use a fork with an actual prior history');
          const fork = await rpc.command('fork', { entryId: prior.userEntryId }); assert.equal(fork.cancelled, false);
          const old = currentSession; currentSession = await rpc.command('get_state'); assert.notEqual(currentSession.sessionId, old.sessionId);
          const forkLines = (await readFile(currentSession.sessionFile, 'utf8')).trimEnd().split('\n');
          const header = JSON.parse(forkLines[0]), historyLines = forkLines.slice(1, 1 + retained.length);
          assert.deepEqual(historyLines.map(JSON.parse), retained, 'Public fork retained a different ancestor branch');
          assert.equal(header.parentSession, old.sessionFile);
          const historyBytes = Buffer.from(historyLines.join('\n') + '\n');
          const binding = { parentSession: old.sessionFile, sourceSessionId: old.sessionId, cwd: header.cwd,
            history: { bytes: historyBytes.length, sha256: sha(historyBytes), entries: retained.length } };
          forkBindings.set(currentSession.sessionId, binding);
          action.result = { priorSessionId: old.sessionId, sessionId: currentSession.sessionId, entryId: prior.userEntryId, binding };
        } else if (event.kind === 'compact') {
          action.result = await rpc.command('compact');
          const entries = await rpc.command('get_entries'); assert.ok(entries.entries.some(entry => entry.type === 'compaction'), 'RPC compact did not persist a compaction');
        } else action.result = await runAgentFixtureEvent(event, { bindings, bindingsPath: config.bindingsFile, ownedStateRoot });
        action.finishedNs = process.hrtime.bigint().toString(); result.events.push(action);
        await save(join(evidence, 'event-' + result.events.length + '.json'), action);
      }
      const turn = bindAgentTurn(declared, bindings), startedNs = process.hrtime.bigint().toString();
      Object.assign(receipt, { startedNs, segment: segment.index, sessionId: currentSession.sessionId, promptSha256: sha(turn.prompt) });
      await rpc.prompt(turn.prompt);
      const endedNs = process.hrtime.bigint().toString(), state = await rpc.command('get_state');
      assert.equal(state.isStreaming, false); assert.equal(state.sessionId, currentSession.sessionId);
      const entries = await rpc.command('get_entries');
      const byId = new Map(entries.entries.map(entry => [entry.id, entry])), branch = [];
      for (let node = byId.get(entries.leafId); node; node = node.parentId ? byId.get(node.parentId) : undefined) branch.push(node);
      branch.reverse();
      const users = branch.filter(entry => entry.type === 'message' && entry.message?.role === 'user');
      receipt.userEntryId = users.at(-1)?.id;
      const nativeText = await readFile(state.sessionFile, 'utf8');
      const native = inspectNotionAgentSession(nativeText, { provider: 'magpie', model: 'group/worker', leafId: entries.leafId, fork: forkBindings.get(state.sessionId) });
      const snapshot = selection({ sessionId: state.sessionId, leafId: entries.leafId, entries: branch });
      const observed = { costs: slice(await rows(segment.observer.files.cost), startedNs, endedNs), transport: slice(await rows(segment.observer.files.transport), startedNs, endedNs),
        tasks: slice(await rows(segment.observer.files.tasks), startedNs, endedNs), source: await rows(segment.observer.files.source),
        session: native, selection: snapshot, selectionSnapshots: [], readbacks: {}, sourceCoverage: false,
        visibility: { nativeCommands: segment.commandsArtifact } };
      for (const payload of observed.tasks.filter(event => event.phase === 'provider_payload')) {
        assert.ok(payload.branch); const actual = await identity(payload.branch.path); assert.equal(actual.sha256, payload.branch.sha256);
        observed.selectionSnapshots.push({ payloadSha256: payload.sha256, selection: selection(await json(actual.path)) });
      }
      for (const assertion of turn.expect.filter(expect => expect.kind === 'business-readback')) {
        const declaration = bindings.private.readbacks[assertion.receipt];
        const readback = await runAgentFixtureEvent({ kind: 'readback', object: declaration.object, receipt: assertion.receipt }, { bindings, bindingsPath: config.bindingsFile, ownedStateRoot });
        observed.readbacks[assertion.receipt] = readback.result;
      }
      await writeFile(join(evidence, 'turn-' + turn.id + '-session.jsonl'), nativeText, { flag: 'wx', mode: 0o600 });
      await save(join(evidence, 'turn-' + turn.id + '-bindings.json'), bindings);
      await save(join(evidence, 'turn-' + turn.id + '-observed.json'), observed);
      receipt.endedNs = endedNs;
      receipt.status = 'observed';
      await save(join(evidence, 'turn-' + turn.id + '-input.json'), turn);
    }
    await close();
    for (const receipt of result.turns) {
      const observed = await json(join(evidence, 'turn-' + receipt.id + '-observed.json'));
      const owner = result.segments.find(item => item.index === receipt.segment);
      observed.source = workflowSourceSlice(owner.source.events, receipt.startedNs, receipt.endedNs);
      observed.backgroundSource = owner.source.events.filter(event => !observed.source.includes(event));
      observed.sourceCoverage = owner.source.complete && owner.source.errors.length === 0;
      const frozenBindings = await json(join(evidence, 'turn-' + receipt.id + '-bindings.json'));
      const turn = await json(join(evidence, 'turn-' + receipt.id + '-input.json'));
      receipt.analysis = await analyzeNotionAgentTurn(turn, observed, frozenBindings, { inspectPayload: candidatePayloadBodies });
      receipt.status = receipt.analysis.status;
      await save(join(evidence, 'turn-' + receipt.id + '-analysis.json'), { observed, analysis: receipt.analysis });
      await save(join(evidence, 'turn-' + receipt.id + '-verdict.json'), receipt);
    }
    result.status = result.turns.every(turn => turn.status === 'passed') ? 'passed'
      : result.turns.some(turn => turn.status === 'failed') ? 'failed' : 'blocked';
  } catch (error) {
    result.status = 'failed'; result.error = { code: error.code ?? error.name, message: error.message };
    const active = result.turns.find(turn => turn.status === 'running'); if (active) { active.status = 'failed'; active.error = result.error; }
  } finally {
    if (rpc) { await rpc.stop().catch(error => { result.shutdownError = error.message; }); rpc = undefined; }
    result.normalConfigurationUnchanged = (await identity(settingsPath)).sha256 === before.settings.sha256 && (await identity(sourcePath)).sha256 === before.source.sha256;
    result.loadedFilesUnchanged = (await Promise.all([...baseline, ...cliFiles].map(async file => (await identity(file.path)).sha256 === file.sha256))).every(Boolean);
    result.sourceTupleAfter = await Promise.all([sourceIdentity(config.brokerRoot, 'broker'), sourceIdentity(config.cliRoot, 'cli')]);
    result.sourceUnchanged = JSON.stringify(result.sourceTupleAfter) === JSON.stringify(result.sourceTuple);
    if (!result.normalConfigurationUnchanged || !result.loadedFilesUnchanged || !result.sourceUnchanged) result.status = 'failed';
    for (const item of result.segments) {
      if (await exists(item.sessionFile)) item.sessionArtifact = await identity(item.sessionFile);
      await save(join(item.control, 'lifecycle.json'), item.lifecycle);
    }
    result.finishedAt = new Date().toISOString(); await save(join(evidence, 'result.json'), result);
    await writeWorkflowReceipts(result, config);
  }
  return { status: result.status, evidence, runId, error: result.error, turns: result.turns };
}

async function writeWorkflowReceipts(result, config) {
  const cliCheckout = await command(['git', '-C', config.cliRoot, 'rev-parse', '--show-toplevel'], root);
  const index = await json(join(cliCheckout, 'verification/skill-domains.json'));
  const { assertRunReceipt } = await import(pathToFileURL(join(cliCheckout, 'verification/run-receipt.mjs')).href);
  const sourceIds = result.plan.contracts.filter(id => id.startsWith('C'));
  const scenarioIds = result.plan.contracts.filter(id => id.startsWith('T'));
  assert.ok(scenarioIds.length, 'Natural journeys must bind at least one existing T scenario');
  const evidence = await identity(join(result.evidence, 'result.json'));
  const initial = await identity(join(result.evidence, 'initial-state.json'));
  for (const scenarioId of scenarioIds) {
    const scenario = index.scenarios.find(item => item.id === scenarioId); assert.ok(scenario, 'Unknown current contract scenario');
    const contracts = sourceIds.filter(id => scenario.contracts.includes(id)); assert.ok(contracts.length, 'A selected T scenario must cover an explicit C contract');
    const receipt = { version: 1, run_id: result.runId + '-' + scenarioId, contract_ids: contracts, scenario_id: scenarioId,
      status: result.status, command: { argv: [process.execPath, ...process.argv.slice(1)], cwd: process.cwd() },
      started_at: result.startedAt, finished_at: result.finishedAt, source_tuple: result.sourceTuple,
      loaded_artifacts: [...result.baseline.map((file, i) => ({ role: ['broker-package', 'broker-entry', 'embedded-cli', 'embedded-sdk', 'runtime-manifest'][i], path: file.realpath, sha256: file.sha256 })),
        { role: 'pi', path: result.hostArtifact.realpath, sha256: result.hostArtifact.sha256 }],
      environment: { machine: hostname(), runtime: process.version, scope_fingerprint: sha(JSON.stringify({ profile: config.profile, source: result.before.source, settings: result.before.settings, library: config.database })) },
      initial_state: { cache: 'cold', session: 'fresh-session; declared lifecycle events retained in raw evidence', oracle: 'independent', proof: { uri: initial.path, sha256: initial.sha256 } },
      evidence: { layer: 'natural', notion: 'live', host: 'pi', provider: 'live', prompt_kind: 'natural' },
      raw_evidence: [{ uri: evidence.path, sha256: evidence.sha256 }, { uri: initial.path, sha256: initial.sha256 }],
      retest_of: result.retestOf ? result.retestOf + '-' + scenarioId : null,
      reason: result.status === 'passed' ? null : result.error?.message ?? 'At least one exact journey assertion did not pass; inspect turn verdicts.' };
    assertRunReceipt(receipt); await save(join(result.evidence, 'receipt-' + scenarioId + '.json'), receipt);
  }
}
