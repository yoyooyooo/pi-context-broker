import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedEnv, writeFakeProvider } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { database as fixtureDatabase } from './notion-integration-fixture.mjs';

const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const rows = async path => {
  try { return (await readFile(path, 'utf8')).split('\n').filter(line => line.trim()).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const occurrences = (value, marker) => JSON.stringify(value).split(marker).length - 1;
const filler = 'These ordinary conversation notes discuss schedules and weather. '.repeat(2400);

export async function runSourceLifecycle({ root, scratch, evidence, fixture, extension }) {
  assert.ok(fixture.command?.length && fixture.marker && fixture.callsPath, 'Source lifecycle requires a controlled Notion fixture with body marker and CLI capture');
  assert.equal(fixture.alias, 'ui-alpha', 'Source lifecycle requires the ui-alpha fixture');
  const base = await mkdtemp(join(scratch, 'omp-source-lifecycle-'));
  const agentDir = join(base, 'agent');
  const sessions = join(base, 'sessions');
  const config = join(base, 'broker.json');
  const modeFile = join(base, 'compaction-mode.txt');
  const files = [
    'omp-source-lifecycle-provider.jsonl',
    'omp-source-lifecycle-decisions.jsonl',
    'omp-source-lifecycle-rpc.json',
    'omp-source-lifecycle-cli-calls.jsonl',
    'omp-source-lifecycle-result.json',
  ];
  const [providerFile, decisionsFile, rpcFile, callsFile, resultFile] = files.map(file => join(evidence, file));
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await writeFile(providerFile, '', { mode: 0o600 });
  await writeFile(decisionsFile, '', { mode: 0o600 });
  await writeFile(callsFile, '', { mode: 0o600 });
  await save(config, { sources: [{ type: 'notion', id: 'notion', namespace: 'notion', command: fixture.command, database: fixtureDatabase, cacheDir: join(base, 'source-cache'), requestTimeoutMs: 1500 }] });
  await writeFile(modeFile, 'remove', { mode: 0o600 });
  await writeFile(join(agentDir, 'config.yml'), 'compaction:\n  enabled: false\n  keepRecentTokens: 1024\n  reserveTokens: 4096\n', { mode: 0o600 });
  const provider = await writeFakeProvider(base);
  const env = isolatedEnv({
    base, agentDir,
    CONTEXT_BROKER_HOST: 'omp',
    CONTEXT_BROKER_CONFIG: config,
    CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: providerFile,
    CONTEXT_BROKER_LOG_FILE: decisionsFile,
    CONTEXT_BROKER_E2E_COMPACTION_MODE_FILE: modeFile,
  });
  const args = [
    '--no-ui', '--no-title', '--tools', 'read', '--no-extensions', '--no-rules',
    '--session-dir', sessions,
    '-e', provider,
    '-e', extension ?? join(root, 'packages/context-broker/src/index.ts'),
    '-e', join(root, 'packages/context-broker/scripts/context-broker-lifecycle-fixture.mjs'),
    '--model', 'context-broker-e2e/fake',
  ];
  const result = { host: 'omp', mode: 'source-lifecycle', status: 'running', scratch: base, files, observations: [], sourceErrors: [] };
  const firstCall = (await rows(fixture.callsPath)).length;
  const invocation = '$ui-alpha@notion Apply the available UI alpha contract.';
  let rpc;
  let failure;
  let phase = 'startup';
  const turn = async (message, expectedBodies, label, expectedDecision) => {
    phase = label;
    const before = (await rows(providerFile)).length;
    const beforeDecisions = (await rows(decisionsFile)).length;
    await rpc.prompt(message);
    const captures = await rows(providerFile);
    assert.equal(captures.length, before + 1, `${label}: expected one actual provider request`);
    const context = captures.at(-1).context;
    assert.ok(Array.isArray(context.messages), `${label}: actual provider messages must be captured`);
    const bodies = occurrences(context.messages, fixture.marker);
    result.observations.push({ action: label, providerRequests: captures.length - before, bodies });
    assert.equal(bodies, expectedBodies, `${label}: source body canary count`);
    if (expectedDecision) {
      const decisions = (await rows(decisionsFile)).slice(beforeDecisions);
      assert.equal(decisions.length, 1, `${label}: expected one broker decision`);
      assert.equal(decisions[0].decision, expectedDecision, `${label}: broker decision`);
      if (expectedDecision === 'skip') assert.equal(decisions[0].reason, 'already-loaded', `${label}: skip must follow the retained body`);
    }
    return context;
  };
  try {
    rpc = await startRpc({ host: 'omp', cwd: base, env, args });
    await rpc.command('set_auto_compaction', { enabled: false });
    const baseline = await turn('Describe available UI skill names without opening anything.', 0, 'baseline');
    assert.equal(occurrences(baseline, fixture.marker), 0, 'Baseline metadata must not contain the body anywhere');
    assert.ok(JSON.stringify(baseline).includes(fixture.alias), 'Baseline metadata must advertise the remote alias');
    await turn(invocation, 1, 'first dollar activation', 'inject');
    phase = 'capture branch points';
    const points = await rpc.command('get_branch_messages');
    assert.equal(points.messages.length, 2, 'Baseline and first activation must yield native branch points');
    const rewindEntry = points.messages[1].entryId;
    assert.ok(rewindEntry, 'First activation must have a native branch point');
    await turn(invocation, 1, 'repeat dollar activation', 'skip');

    phase = 'fork';
    const originalSession = (await rpc.command('get_state')).sessionFile;
    assert.ok(originalSession, 'Original native session must be persisted');
    const fork = await rpc.command('fork');
    result.observations.push({ action: 'fork', response: fork });
    assert.equal(fork.cancelled, false, 'Native fork must complete');
    const forkSession = (await rpc.command('get_state')).sessionFile;
    assert.ok(forkSession && forkSession !== originalSession, 'Fork must create a distinct native session');
    await turn(invocation, 1, 'fork retains source body', 'skip');

    phase = 'branch before first activation';
    const branch = await rpc.command('branch', { entryId: rewindEntry });
    assert.equal(branch.cancelled, false, 'Native branch must complete');
    const branched = await rpc.command('get_messages');
    const branchedBodies = occurrences(branched.messages, fixture.marker);
    result.observations.push({ action: phase, response: branch, bodies: branchedBodies });
    assert.equal(branchedBodies, 0, 'Branch before first activation must remove the source body');
    await turn(invocation, 1, 'branch reloads source body', 'inject');

    await turn(filler, 1, 'large neutral filler');
    phase = 'large native context';
    const large = await rpc.command('get_messages');
    assert.ok(JSON.stringify(large).length > 65_536, 'Neutral filler must exercise a native RPC frame larger than 64 KiB');
    assert.equal(occurrences(large.messages, fixture.marker), 1, 'Large context must retain exactly one body');
    phase = 'compact remove';
    const compacted = await rpc.command('compact');
    assert.ok(compacted.firstKeptEntryId, 'Compaction must retain a real native entry');
    assert.doesNotMatch(compacted.summary, /<context-broker-record/, 'Remove summary must contain no broker record');
    assert.equal(occurrences(compacted.summary, fixture.marker), 0, 'Remove summary must contain no source body');
    const afterCompact = await rpc.command('get_messages');
    const compactedBodies = occurrences(afterCompact.messages, fixture.marker);
    result.observations.push({ action: phase, response: compacted, bodies: compactedBodies });
    assert.equal(compactedBodies, 0, 'Native remove compaction must remove the source body');
    await turn(invocation, 1, 'post-compaction reloads source body', 'inject');

    phase = 'source metadata refresh';
    const beforeRefresh = (await rows(fixture.callsPath)).length;
    const beforeProviders = (await rows(providerFile)).length;
    const beforeFrames = rpc.frames.length;
    let refreshError;
    try { await rpc.prompt('/context-broker refresh'); }
    catch (error) { refreshError = error; }
    const refreshCalls = (await rows(fixture.callsPath)).slice(beforeRefresh);
    const refreshFrames = rpc.frames.slice(beforeFrames);
    const refresh = {
      action: phase,
      status: refreshError ? 'failed' : 'completed',
      cliCalls: refreshCalls,
      providerRequests: (await rows(providerFile)).length - beforeProviders,
      error: refreshError?.message ?? null,
      errorFrames: refreshFrames.filter(frame => frame.error || frame.success === false || frame.type === 'extension_error'
        || (frame.type === 'extension_ui_request' && frame.method === 'notify'
          && (frame.notifyType === 'error' || frame.level === 'error' || frame.severity === 'error' || /context-broker activation failed \(/.test(frame.message ?? '')))),
    };
    result.observations.push(refresh);
    if (refreshError) result.sourceErrors.push({ action: phase, message: refreshError.message });
    for (const frame of refresh.errorFrames) result.sourceErrors.push({ action: phase, frame });
    assert.ok(refreshCalls.some(call => call.command === 'list' && call.args.includes('--refresh')), 'Refresh must actually call CLI list with --refresh');
    // Refresh may now prepare flagged bodies in background; it must remain session-neutral.
    const refreshedMessages = await rpc.command('get_messages');
    assert.equal(occurrences(refreshedMessages.messages, fixture.marker), 1, 'Background refresh must not duplicate the already active body');
    assert.ok(!refreshFrames.some(frame => /Read ntn-skills:\/\//.test(frame.message ?? '')), 'Background refresh must not publish foreground activation records');
    assert.equal(refresh.providerRequests, 0, 'Metadata refresh must be handled without invoking the provider');
    if (refreshError) throw refreshError;
    assert.equal(result.sourceErrors.length, 0, 'Refresh must not conceal source or host errors');
    result.status = 'passed';
  } catch (error) {
    failure = error;
    result.status = 'failed';
    result.error = error.message;
    result.failedAction = phase;
  } finally {
    if (rpc) {
      try { await rpc.stop(); }
      catch (error) {
        result.shutdownError = error.message;
        result.status = 'failed';
        failure ??= error;
        result.error ??= error.message;
      }
    }
    await save(rpcFile, rpc?.frames ?? []);
    const calls = (await rows(fixture.callsPath)).slice(firstCall);
    await writeFile(callsFile, calls.map(call => JSON.stringify(call) + '\n').join(''), { mode: 0o600 });
    result.providerRequests = (await rows(providerFile)).length;
    result.finishedAt = new Date().toISOString();
    await save(resultFile, result);
  }
  if (failure) {
    const error = new Error(`Notion source lifecycle failed: ${result.error}; see ${files[4]}`, { cause: failure });
    error.result = result;
    throw error;
  }
  return result;
}
