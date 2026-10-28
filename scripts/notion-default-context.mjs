import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { database as fixtureDatabase, unflaggedAlias, unflaggedCanary, missingAlias, missingCanary } from './notion-integration-fixture.mjs';

const helper = fileURLToPath(import.meta.url);
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const rows = async path => { try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const count = (value, marker) => JSON.stringify(value).split(marker).length - 1;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pageKey = value => String(value ?? '').replaceAll('-', '').toLowerCase();

// Only argument arrays are executed. This ledger deliberately excludes environment,
// stdin, stdout, stderr, API payloads, query values, and authentication material.
export async function runLedger(configPath, args) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const requestId = `${process.pid}-${Date.now()}`;
  const apiPath = args[0] === 'api' ? args[1]?.split('?')[0] : undefined;
  const methodAt = args.indexOf('-X');
  const safe = config.kind === 'ntn'
    ? { kind: 'ntn', method: methodAt < 0 ? 'GET' : args[methodAt + 1], path: apiPath ?? null, command: args[0] }
    : { kind: 'cli', command: args[0], ref: args[1]?.startsWith('skill://') || args[1]?.startsWith('s_') ? args[1] : null, policy: args.includes('--refresh') ? 'refresh' : args.includes('--max-age') ? args[args.indexOf('--max-age') + 1] : 'default' };
  const log = (phase, details = {}) => appendFile(config.ledger, JSON.stringify({ ...safe, requestId, pid: process.pid, phase, ...details, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  await log('started');
  const child = spawn(config.command[0], [...config.command.slice(1), ...args], { env: { ...process.env, ...(config.ntnBin ? { NTN_SKILLS_NTN_BIN: config.ntnBin } : {}) }, shell: false, stdio: 'inherit' });
  const signals = [];
  const handlers = new Map(['SIGTERM', 'SIGINT'].map(signal => [signal, () => {
    const forwarded = child.kill(signal);
    signals.push(log('signal-forwarded', { signal, childPid: child.pid, forwarded }));
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  await log('child-started', { childPid: child.pid });
  const result = await closed;
  await Promise.all(signals);
  await log('completed', { ...result, childPid: child.pid });
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  process.exitCode = result.code ?? 1;
}

export async function createRequestLedger({ scratch, evidence, command, ntnCommand }) {
  const ledger = join(evidence, 'safe-source-requests.jsonl');
  const config = join(scratch, 'source-ledger.json');
  let ntnBin;
  if (ntnCommand) {
    const ntnConfig = join(scratch, 'ntn-ledger.json');
    await save(ntnConfig, { kind: 'ntn', command: ntnCommand, ledger });
    ntnBin = join(scratch, 'ntn-ledger.mjs');
    await writeFile(ntnBin, `#!${process.execPath}\nimport { runLedger } from ${JSON.stringify(new URL(import.meta.url).href)};\nawait runLedger(${JSON.stringify(ntnConfig)}, process.argv.slice(2));\n`, { mode: 0o700 });
    await chmod(ntnBin, 0o700);
  }
  await save(config, { kind: 'cli', command, ledger, ntnBin });
  return { command: [process.execPath, helper, '--request-ledger', config], ntnCommand: ntnBin ? [ntnBin] : undefined, ledger };
}

export function nativeEntries(host, context) {
  let skills = '';
  const content = host === 'omp' ? [Array.isArray(context.systemPrompt) ? context.systemPrompt.join('\n') : context.systemPrompt ?? ''] : [];
  for (const message of context.messages) {
    if (message.role !== 'system') continue;
    if (message.sections && Object.hasOwn(message.sections, 'skills')) skills = message.sections.skills ?? '';
    const text = typeof message.content === 'string' ? message.content : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (text) content.push(text);
  }
  const text = [...content, skills].join('\n');
  const metadata = [...text.matchAll(/<skill>\s*<name>\s*([^<]+)\s*<\/name>[\s\S]*?<location>\s*([^<]+)\s*<\/location>[\s\S]*?<\/skill>/g)].map(match => ({ name: match[1].trim(), filePath: match[2].trim(), catalog: 'prompt-metadata' }));
  const native = host === 'omp' ? (context.tools ?? []).flatMap(tool => tool.tool?.session?.skills ?? []).map(item => ({ ...item, catalog: 'host-native' })) : [];
  return [...new Map([...metadata, ...native].map(item => [item.name, item])).values()];
}
const contentRequests = requests => requests.filter(row => row.kind === 'ntn' && row.phase === 'started' && row.method === 'GET' && /(?:^|\/)(?:blocks\/|ai\/skills\/|pages\/[^/]+\/markdown(?:$|\/))/.test(row.path ?? ''));
const exportsStarted = requests => requests.filter(row => row.kind === 'cli' && row.phase === 'started' && row.command === 'export');

// Invoked only by the explicit --default-context true option. Provider/RPC are
// actual installed Pi/OMP boundaries; controlled CLI responses are labelled.
export async function runDefaultContext({ host, root, scratch, evidence, fixture, extension, database, ledger, scriptedProvider }) {
  const label = `${host}-default-context`;
  const files = ['provider.jsonl', 'rpc.json', 'decisions.jsonl', 'result.json'].map(suffix => `${label}-${suffix}`);
  const [providerFile, rpcFile, decisionsFile, resultFile] = files.map(file => join(evidence, file));
  const lifecycleFile = join(evidence, `${label}-lifecycle.jsonl`);
  files.push(`${label}-lifecycle.jsonl`);
  const result = { host, mode: 'default-context', status: 'running', files, observations: [], notRun: ['real model', 'Tern UI and detached completion'] };
  const firstRequest = (await rows(ledger)).length;
  let rpc;
  const frames = [];
  let launch;
  let phase = 'startup';
  const captures = () => rows(providerFile);
  const requests = async () => (await rows(ledger)).slice(firstRequest);
  const until = async (label, probe, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value) return value;
      await pause(50);
    }
    assert.fail(`Timed out waiting for ${label}`);
  };
  const observe = (action, details = {}) => result.observations.push({ action, ...details });
  const stop = async () => { if (rpc) { const active = rpc; rpc = undefined; try { await active.stop(); } finally { frames.push(...active.frames); } } };
  const boot = async (name, activation, { start = true, cacheDir, providerOutput = providerFile } = {}) => {
    if (start) await stop();
    const base = join(scratch, `${label}-${name}`);
    const agentDir = join(base, 'agent');
    await mkdir(join(agentDir, 'context-broker'), { recursive: true });
    await mkdir(join(base, 'sessions'), { recursive: true });
    await save(join(agentDir, 'context-broker', 'config.yml'), { sources: [{ type: 'notion', id: 'notion', namespace: 'notion', command: fixture.command, database: database ?? fixtureDatabase, cacheDir: cacheDir ?? join(base, 'source-cache'), requestTimeoutMs: 30000, ...(activation ? { activation } : {}) }] });
    const provider = await scriptedProvider(base);
    const plan = join(base, 'tool-plan.json');
    await save(plan, { trigger: 'NEVER', id: `${label}-${name}`, path: '/nonexistent' });
    const compactMode = join(base, 'compaction-mode.txt');
    await writeFile(compactMode, 'remove', { mode: 0o600 });
    const env = isolatedEnv({ base, agentDir, CONTEXT_BROKER_HOST: host, CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: providerOutput, CONTEXT_BROKER_LOG_FILE: decisionsFile, BROKER_NOTION_TOOL_PLAN: plan });
    env.CONTEXT_BROKER_E2E_COMPACTION_MODE_FILE = compactMode;
    env.CONTEXT_BROKER_E2E_LIFECYCLE_FILE = lifecycleFile;
    if (fixture.live) {
      for (const [key, value] of Object.entries(process.env)) if (/^(NOTION_|NTN_|XDG_)/.test(key)) env[key] = value;
      env.NTN_SKILLS_CONFIG_HOME = process.env.NTN_SKILLS_CONFIG_HOME ?? join(process.env.HOME, '.config', 'ntn-skills');
      env.NTN_SKILLS_HOME = process.env.NTN_SKILLS_HOME ?? join(process.env.HOME, '.local', 'state', 'ntn-skills');
      env.NTN_SKILLS_CACHE_HOME = process.env.NTN_SKILLS_CACHE_HOME ?? join(process.env.HOME, '.cache', 'ntn-skills');
    }
    const args = ['--no-extensions', '--session-dir', join(base, 'sessions'), '--tools', 'read', '-e', provider, '-e', join(root, 'packages/context-broker/scripts/context-broker-lifecycle-fixture.mjs'), '-e', extension, '--model', 'context-broker-e2e/fake', ...(host === 'omp' ? ['--no-title', '--no-rules'] : [])];
    const preparedLaunch = { host, cwd: base, env, args };
    if (start) { launch = preparedLaunch; rpc = await startRpc(preparedLaunch); }
    return { plan, launch: preparedLaunch };
  };
  const diagnostic = async (active = rpc, output = providerFile) => {
    const before = active.frames.length;
    const beforeProviders = (await rows(output)).length;
    await active.prompt('/context-broker sources');
    assert.equal((await rows(output)).length, beforeProviders, 'Source diagnostics must never invoke provider');
    const text = active.frames.slice(before).map(frame => frame.message ?? '').find(message => message.startsWith('context-broker sources: '));
    assert.ok(text, 'Runtime must expose Default Context prefetch diagnostics');
    const value = JSON.parse(text.slice('context-broker sources: '.length));
    assert.ok(Array.isArray(value.prefetch), 'Runtime prefetch diagnostics must expose jobs');
    return value.prefetch;
  };
  const waitState = async (expected, timeout = 90000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const jobs = await diagnostic();
      const job = jobs.find(item => pageKey(item.recordId?.split(":").at(-1)) === pageKey(fixture.skillRef.split('/')[2]));
      if (job?.state === expected) { observe(`prefetch ${expected}`, { job }); return job; }
      if (job?.state === 'error' && expected !== 'error') assert.fail(`Prefetch failed: ${job.error}`);
      await pause(100);
    }
    assert.fail(`Prefetch never reached ${expected}`);
  };
  const baseline = async (expectEmpty = true) => {
    const before = (await captures()).length;
    await rpc.prompt('List available ledger skill names without reading files.');
    const context = (await captures())[before]?.context;
    assert.ok(context, 'Actual provider must capture baseline metadata');
    if (expectEmpty) for (const marker of [fixture.marker, unflaggedCanary, missingCanary]) assert.equal(count(context, marker), 0, 'No source body before activation');
    return context;
  };
  const nativeName = `notion-${fixture.alias}`.replace(/[^a-z0-9-]/g, '-');
  const setState = async options => fixture.setScenario?.('normal', { includeUnflagged: true, ...options });
  const lifecycle = async () => {
    phase = 'native branch and compaction recovery';
    const baseContext = await baseline();
    assert.equal(count(baseContext, fixture.marker), 0);
    const points = await rpc.command(host === 'pi' ? 'get_fork_messages' : 'get_branch_messages');
    const target = points.messages?.at(-1)?.entryId;
    assert.ok(target, 'Native branch must expose an actual entry before activation');
    await rpc.prompt(`$${fixture.alias}@notion Apply the selected lifecycle contract.`);
    assert.equal(count((await captures()).at(-1).context.messages, fixture.marker), 1);
    const branched = await rpc.command(host === 'pi' ? 'fork' : 'branch', { entryId: target });
    assert.notEqual(branched.cancelled, true, 'Native branch must complete');
    assert.equal(count((await rpc.command('get_messages')).messages, fixture.marker), 0, 'Branch before activation must remove effective body');
    await rpc.prompt(`$${fixture.alias}@notion Reload after native branch.`);
    assert.equal(count((await captures()).at(-1).context.messages, fixture.marker), 1);
    await rpc.prompt('These ordinary notes discuss the weather and scheduling. '.repeat(2400));
    const compacted = await rpc.command('compact');
    assert.ok(compacted.firstKeptEntryId, 'Native compaction must keep a real entry');
    assert.equal(count((await rpc.command('get_messages')).messages, fixture.marker), 0, 'Native compaction must remove effective skill body');
    await rpc.prompt(`$${fixture.alias}@notion Reload after native compaction.`);
    assert.equal(count((await captures()).at(-1).context.messages, fixture.marker), 1, 'Compacted body must be available on explicit activation');
    observe(phase, { branchEntryId: target, compactedEntryId: compacted.firstKeptEntryId });
  };
  try {
    await setState({});
    const { plan } = await boot('prepared');
    phase = 'flagged native metadata only';
    const context = await baseline();
    const entries = nativeEntries(host, context);
    const entry = entries.find(item => item.name === nativeName);
    assert.ok(entry?.filePath, 'Flagged page must appear in actual native catalog');
    for (const name of [unflaggedAlias, missingAlias]) assert.ok(!entries.some(item => item.name === `notion-${name}`), 'Unchecked/missing checkbox must stay outside native catalog');
    const beforeProviders = (await captures()).length;
    const ready = await waitState('ready');
    assert.ok(ready.snapshotId, 'Prepared diagnostic must identify immutable snapshot');
    assert.equal((await captures()).length, beforeProviders, 'Background preparation must never call provider');
    assert.equal(count(await readFile(entry.filePath, 'utf8'), fixture.marker), 0, 'Prepared native index must remain metadata only');
    const preparedMessages = (await rpc.command('get_messages')).messages;
    assert.equal(count(preparedMessages, fixture.marker), 0, 'Prepared body must never enter session');
    assert.ok(!JSON.stringify(preparedMessages).includes('context-broker-source-read'), 'Background must never persist foreground Read records');
    assert.ok(!rpc.frames.some(frame => /Read ntn-skills:\/\//.test(JSON.stringify(frame))), 'Background must never report foreground activation');
    const sessionFile = (await rpc.command('get_state')).sessionFile;
    assert.ok(sessionFile, 'Native session must expose persisted evidence');
    const persisted = await readFile(sessionFile, 'utf8');
    const preparedSessionEvidence = `${label}-prepared-session.jsonl`;
    await writeFile(join(evidence, preparedSessionEvidence), persisted, { mode: 0o600 });
    files.push(preparedSessionEvidence);
    assert.ok(!persisted.includes('context-broker-source-read'), 'Background must not persist running/done activation records');
    assert.ok(!persisted.includes(fixture.marker), 'Prepared body must stay outside persisted session');
    const preparedRequests = await requests();
    const preparedExports = exportsStarted(preparedRequests).filter(row => row.ref === ready.snapshotId);
    assert.equal(preparedExports.length, 1, 'One complete owned-page prefetch export is required');
    assert.ok(preparedRequests.some(row => row.kind === 'cli' && row.command === 'export' && row.ref === ready.snapshotId && row.phase === 'completed' && row.code === 0), 'Prefetch export must complete');
    observe(phase, { nativeName, nativePath: entry.filePath, providerRequestsDuringPrefetch: 0, exports: 1 });
    phase = 'prepared native activation and resource';
    const remoteBefore = contentRequests(await requests()).length;
    await rpc.prompt(`/skill:${nativeName}`);
    assert.equal(count((await captures()).at(-1).context.messages, fixture.marker), 1, 'Activation must provide exactly one complete body');
    await save(plan, { trigger: 'OPEN_DEFAULT_RESOURCE', id: `${label}-resource`, path: join(dirname(entry.filePath), fixture.resourcePath ?? 'references/ledger.md') });
    await rpc.prompt('OPEN_DEFAULT_RESOURCE: read the linked ledger guide.');
    assert.ok(JSON.stringify((await captures()).at(-1).context.messages).includes(fixture.resourceCanary), 'Actual native read must return complete resource bytes');
    assert.equal(exportsStarted(await requests()).filter(row => row.ref === ready.snapshotId).length, 1, 'Activation must reuse complete prepared export');
    assert.equal(contentRequests(await requests()).length, remoteBefore, 'Prepared activation/resource must not refetch remote content');
    observe(phase, { redundantRemoteContentRequests: 0, redundantExports: 0 });
    if (fixture.setScenario) {
      phase = 'unchecked and missing metadata explicit dollar';
      for (const [alias, marker] of [[unflaggedAlias, unflaggedCanary], [missingAlias, missingCanary]]) {
        await rpc.prompt(`$${alias}@notion Apply this available contract.`);
        assert.equal(count((await captures()).at(-1).context.messages, marker), 1, 'Every discovered page must remain explicit-dollar eligible');
      }
      observe(phase);
    }
    phase = 'refresh uncheck';
    if (fixture.setDefaultContext) await fixture.setDefaultContext(false); else await setState({ defaultContext: false });
    const providersBeforeRefresh = (await captures()).length;
    await rpc.prompt('/context-broker refresh');
    assert.equal((await captures()).length, providersBeforeRefresh, 'Refresh must not invoke provider');
    const refreshed = await baseline(false);
    assert.ok(!nativeEntries(host, refreshed).some(item => item.name === nativeName), 'Uncheck + refresh must remove native catalog entry');
    await boot('unchecked-cold');
    const uncheckedCold = await baseline();
    assert.ok(!nativeEntries(host, uncheckedCold).some(item => item.name === nativeName), 'Unchecked page must remain excluded after restart');
    await rpc.prompt(`$${fixture.alias}@notion Apply the explicitly selected contract.`);
    assert.equal(count((await captures()).at(-1).context.messages, fixture.marker), 1, 'Uncheck must preserve explicit selection');
    assert.ok((await requests()).some(row => row.command === 'list' && row.policy === 'refresh'), 'Refresh must query fresh CLI metadata');
    observe(phase);
    if (fixture.setDefaultContext) await fixture.setDefaultContext(true);
    await setState({});
    await boot('lifecycle');
    await lifecycle();
    if (fixture.setScenario) {
      phase = 'foreground overlaps background';
      await setState({ delayMs: 4000 });
      const before = (await requests()).length;
      await boot('overlap');
      await baseline();
      await waitState('running');
      await rpc.prompt(`$${fixture.alias}@notion Apply while preparation runs.`);
      await waitState('ready');
      const overlap = (await requests()).slice(before);
      assert.equal(overlap.filter(row => row.kind === 'cli' && row.phase === 'started' && row.command === 'read').length, 1, 'Foreground and background must share download');
      assert.equal(exportsStarted(overlap).length, 1, 'Foreground and background must share full materialization');
      assert.equal(count((await captures()).at(-1).context.messages, fixture.marker), 1);
      observe(phase, { reads: 1, exports: 1 });
      phase = 'native session boundary cancels pending foreground';
      await setState({ delayMs: 12000 });
      const boundaryStart = (await requests()).length;
      await boot('consumer-session-switch');
      const boundaryContext = await baseline();
      const boundaryEntry = nativeEntries(host, boundaryContext).find(item => item.name === nativeName);
      await waitState('running');
      const sourceRead = await until('owned delayed read process', async () => (await requests()).slice(boundaryStart).find(row => row.kind === 'cli' && row.command === 'read' && row.phase === 'child-started'));
      const providersAtBoundary = (await captures()).length;
      const lifecycleStart = (await rows(lifecycleFile)).length;
      let submissionSettled = false;
      const submission = rpc.prompt(`$${fixture.alias}@notion CANCEL_DEFAULT_CONTEXT_SELECTION`).then(value => ({ value }), error => ({ error: error.message })).finally(() => { submissionSettled = true; });
      await until('native selected input entry', async () => (await rows(lifecycleFile)).slice(lifecycleStart).some(row => row.event === 'selected-input-entered'));
      await pause(100);
      assert.equal(submissionSettled, false, 'Foreground selection must still be pending before session boundary');
      assert.equal((await captures()).length, providersAtBoundary, 'Pending selection must not dispatch provider');
      const switched = await rpc.command('new_session');
      assert.notEqual(switched?.cancelled, true, 'Native new_session must complete');
      await submission;
      assert.equal((await captures()).length, providersAtBoundary, 'Cancelled selection must never dispatch provider');
      assert.equal(count((await rpc.command('get_messages')).messages, fixture.marker), 0, 'Cancelled selection must not activate body');
      if (host === 'omp') {
        const surviving = await waitState('ready');
        const shared = (await requests()).slice(boundaryStart);
        assert.equal(shared.filter(row => row.kind === 'cli' && row.phase === 'started' && row.command === 'read').length, 1, 'Session-cancelled consumer must share the single background read');
        assert.equal(exportsStarted(shared).length, 1, 'Surviving background must complete exactly one export');
        await rpc.prompt(`$${fixture.alias}@notion Retry after the previous session submission was cancelled.`);
        assert.equal(count((await captures()).at(-1).context.messages, fixture.marker), 1, 'Retry must consume complete prepared body');
        await save(join(scratch, `${label}-consumer-session-switch`, 'tool-plan.json'), { trigger: 'OPEN_CANCEL_RESOURCE', id: `${label}-cancel-resource`, path: join(dirname(boundaryEntry.filePath), fixture.resourcePath ?? 'references/ledger.md') });
        await rpc.prompt('OPEN_CANCEL_RESOURCE: read the prepared ledger guide.');
        assert.ok(JSON.stringify((await captures()).at(-1).context.messages).includes(fixture.resourceCanary), 'Retry must consume complete prepared resource');
        observe(phase, { route: 'new_session', cancelledProviderRequests: 0, cancelledActivatedBodies: 0, readsBeforeRetry: 1, exportsBeforeRetry: 1, survivingSnapshotId: surviving.snapshotId });
      } else {
        const ended = await until('Pi session shutdown terminates owned read', async () => (await requests()).find(row => row.requestId === sourceRead.requestId && row.phase === 'completed'));
        assert.notEqual(ended.code, 0, 'Pi session disposal must terminate its in-flight read');
        assert.ok((await rows(lifecycleFile)).slice(lifecycleStart).some(row => row.event === 'session_shutdown'), 'Pi new_session must emit actual session_shutdown');
        await until('outgoing Pi source process exit', async () => [sourceRead.pid, sourceRead.childPid].every(pid => {
          try { process.kill(pid, 0); return false; }
          catch (error) { if (error.code === 'ESRCH') return true; throw error; }
        }));
        observe(phase, { route: 'new_session', cancelledProviderRequests: 0, cancelledActivatedBodies: 0, terminatedRequestId: ended.requestId, pid: sourceRead.pid, childPid: sourceRead.childPid, code: ended.code, signal: ended.signal, limit: 'Pi new_session disposes the outgoing runtime and recreates the extension; single-consumer background survival requires native composer cancellation, unavailable through RPC abort' });
      }
      phase = 'owned graceful EOF shutdown terminates background';
      await setState({ delayMs: 30000 });
      const shutdownStart = (await requests()).length;
      await boot('owned-shutdown');
      await baseline();
      await waitState('running');
      const owned = await until('shutdown-owned source child', async () => (await requests()).slice(shutdownStart).find(row => row.kind === 'cli' && row.command === 'read' && row.phase === 'child-started'));
      const shutdownEvents = (await rows(lifecycleFile)).length;
      const providersAtShutdown = (await captures()).length;
      const closing = rpc;
      await closing.closeInput();
      frames.push(...closing.frames);
      rpc = undefined;
      const terminated = await until('owned source termination', async () => (await requests()).find(row => row.requestId === owned.requestId && row.phase === 'completed'));
      assert.ok(terminated.signal || terminated.code !== 0, 'Owned read must terminate without a successful response');
      assert.ok((await rows(lifecycleFile)).slice(shutdownEvents).some(row => row.event === 'session_shutdown'), 'Native EOF must emit real session_shutdown');
      await until('owned source process exit', async () => [owned.pid, owned.childPid].every(pid => {
        try { process.kill(pid, 0); return false; }
        catch (error) { if (error.code === 'ESRCH') return true; throw error; }
      }));
      assert.equal(exportsStarted((await requests()).slice(shutdownStart)).length, 0, 'Terminated source cannot publish a later completed export');
      assert.equal((await captures()).length, providersAtShutdown, 'Owned shutdown must not invoke provider');
      observe(phase, { route: 'native RPC stdin EOF', requestId: owned.requestId, pid: owned.pid, childPid: owned.childPid, code: terminated.code, signal: terminated.signal, completedExports: 0, providerRequests: 0 });
      result.notRun.push('RPC abort does not cancel a pending extension input hook; native composer Stop is a separate acceptance route');
      phase = 'background failure then foreground recovery';
      await setState({ failRead: true });
      await boot('failure');
      await baseline();
      const failed = await waitState('error');
      assert.match(failed.error ?? '', /^[A-Z_]+$/, 'Failure diagnostics must be safe codes');
      assert.equal(count((await rpc.command('get_messages')).messages, fixture.marker), 0);
      await setState({});
      await rpc.prompt(`$${fixture.alias}@notion Retry the selected skill.`);
      assert.equal(count((await captures()).at(-1).context.messages, fixture.marker), 1, 'Failure cannot poison later foreground recovery');
      observe(phase);
      phase = 'refresh cancels late prefetch';
      await setState({ delayMs: 3000 });
      await boot('cancel');
      await baseline();
      await waitState('running');
      await setState({ defaultContext: false });
      await rpc.prompt('/context-broker refresh');
      await pause(3500);
      const cancelledCatalog = await baseline();
      assert.ok(!nativeEntries(host, cancelledCatalog).some(item => item.name === nativeName), 'Cancelled old generation must not restore unchecked native entry');
      assert.equal(count((await rpc.command('get_messages')).messages, fixture.marker), 0, 'Cancelled job must not publish a body');
      observe(phase);
      phase = 'expired preparation validates without stale fallback';
      await setState({});
      await boot('expiry', { maxAge: '0s' });
      await baseline();
      await waitState('ready');
      const expiryStart = (await requests()).length;
      await setState({ failRead: true });
      const providersBeforeFailure = (await captures()).length;
      try { await rpc.prompt(`$${fixture.alias}@notion Validate expired instructions.`); } catch {}
      assert.equal((await captures()).length, providersBeforeFailure, 'Expired failed validation must block provider instead of using stale prepared body');
      const expiryCalls = (await requests()).slice(expiryStart);
      assert.ok(expiryCalls.some(row => row.kind === 'cli' && row.command === 'read' && row.policy === '0s'), 'Activation freshness must reach CLI validation');
      observe(phase, { providerRequests: 0 });
      await setState({});
    } else result.notRun.push('controlled overlap, failure, cancellation, expiry (deterministic fixture only)');
    phase = 'restart reuses immutable cache';
    await boot('shared-cache');
    await baseline();
    await waitState('ready');
    const restartExports = exportsStarted(await requests()).length;
    await stop();
    rpc = await startRpc(launch);
    await baseline();
    await waitState('ready');
    await rpc.prompt(`$${fixture.alias}@notion Apply after process restart.`);
    assert.equal(count((await captures()).at(-1).context.messages, fixture.marker), 1);
    assert.equal(exportsStarted(await requests()).length, restartExports, 'Restart must reuse verified complete immutable export');
    observe(phase, { redundantExports: 0 });
    phase = 'cold simultaneous shared-cache publication';
    await stop();
    await setState({ delayMs: 1500 });
    const coldCache = join(scratch, `${label}-cold-shared-cache`);
    const coldStarts = [];
    for (const suffix of ['a', 'b']) {
      const outputName = `${label}-cold-race-${suffix}-provider.jsonl`;
      const rpcName = `${label}-cold-race-${suffix}-rpc.json`;
      files.push(outputName, rpcName);
      const output = join(evidence, outputName);
      const prepared = await boot(`cold-race-${suffix}`, undefined, { start: false, cacheDir: coldCache, providerOutput: output });
      coldStarts.push({ ...prepared, output, rpcName });
    }
    const racers = [];
    const coldFailures = [];
    try {
      // Both fresh processes receive distinct session/provider paths and one empty
      // source cache. Starting both before awaiting forces the publication race.
      const settled = await Promise.allSettled(coldStarts.map(async item => {
        const active = await startRpc(item.launch);
        const racer = { ...item, active };
        racers.push(racer);
        await active.prompt('List available ledger skill names without opening files.');
        const context = (await rows(item.output))[0]?.context;
        assert.ok(context, 'Cold race must capture actual provider metadata');
        assert.equal(count(context, fixture.marker), 0, 'Cold background race must remain session-neutral');
        const entry = nativeEntries(host, context).find(value => value.name === nativeName);
        assert.ok(entry?.filePath, 'Cold race native entry must exist in both processes');
        const deadline = Date.now() + 90000;
        let ready;
        while (Date.now() < deadline) {
          const job = (await diagnostic(active, item.output)).find(value => pageKey(value.recordId?.split(":").at(-1)) === pageKey(fixture.skillRef.split('/')[2]));
          assert.notEqual(job?.state, 'error', `Cold shared cache preparation failed: ${job?.error}`);
          if (job?.state === 'ready') { ready = job; break; }
          await pause(100);
        }
        assert.ok(ready?.snapshotId, 'Both cold processes must complete full prefetch');
        assert.equal(count((await active.command('get_messages')).messages, fixture.marker), 0);
        await active.prompt(`$${fixture.alias}@notion Apply from the concurrently prepared cache.`);
        assert.equal(count((await rows(item.output)).at(-1).context.messages, fixture.marker), 1);
        await save(item.plan, { trigger: 'OPEN_COLD_RACE_RESOURCE', id: `${label}-cold-race-${racers.indexOf(racer)}`, path: join(dirname(entry.filePath), fixture.resourcePath ?? 'references/ledger.md') });
        await active.prompt('OPEN_COLD_RACE_RESOURCE: read the complete linked ledger guide.');
        assert.ok(JSON.stringify((await rows(item.output)).at(-1).context.messages).includes(fixture.resourceCanary), 'Each process must read the complete resource');
        assert.ok(!JSON.stringify(active.frames).includes('SOURCE_OUTPUT_CONFLICT'), 'Concurrent publication cannot produce spurious storage conflicts');
        return { snapshotId: ready.snapshotId };
      }));
      for (const outcome of settled) if (outcome.status === 'rejected') coldFailures.push(outcome.reason);
      if (coldFailures.length) throw new AggregateError(coldFailures, coldFailures.map(error => error.message).join('; '));
      observe(phase, { processes: 2, coldCache, snapshots: settled.map(outcome => outcome.value.snapshotId), separateSessions: true, completeResources: true });
    } finally {
      const stopped = await Promise.allSettled(racers.map(async racer => { try { await racer.active.stop(); } finally { await save(join(evidence, racer.rpcName), racer.active.frames); } }));
      const shutdownFailure = stopped.find(outcome => outcome.status === 'rejected');
      if (shutdownFailure && !coldFailures.length) throw shutdownFailure.reason;
      await setState({});
    }
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.failedAction = phase; result.error = error.message;
  } finally {
    try { await stop(); } catch (error) { result.status = 'failed'; result.shutdownError = error.message; }
    await save(rpcFile, frames);
    result.requests = { cli: (await requests()).filter(row => row.kind === 'cli' && row.phase === 'started').length, remoteContent: contentRequests(await requests()).length };
    result.finishedAt = new Date().toISOString();
    await save(resultFile, result);
  }
  if (result.status !== 'passed') { const error = new Error(`${label}: ${result.error ?? result.shutdownError}; see ${files[3]}`); error.results = [result]; throw error; }
  return result;
}

if (process.argv[2] === '--request-ledger') await runLedger(process.argv[3], process.argv.slice(4));
