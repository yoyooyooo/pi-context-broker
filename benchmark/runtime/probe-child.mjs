import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startRpc } from '../../packages/context-broker/scripts/context-broker-rpc-harness.mjs';

const limitations = [
  'Public RPC and ExtensionAPI expose registered resource sources, not a complete census of silent extensions.',
  'Tool registry definitions and active names are not the final provider wire declarations.',
  'The selected Phase 0 model and thinking level do not establish a paid backend or final request parameters.',
  'The initial system prompt precedes per-task before_agent_start and provider transformations.',
  'The no-request provider and observer cover Pi Agent requests; this is not an independent machine-wide network ledger.',
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const saveNew = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', {
  flag: 'wx', mode: 0o600,
});
const describeFile = async path => {
  const bytes = await readFile(path);
  return { path, sha256: sha256(bytes), bytes: bytes.length };
};
const failureInfo = error => ({
  name: error?.name ?? 'Error',
  message: String(error?.message ?? error),
  ...(typeof error?.code === 'string' ? { code: error.code } : {}),
});

const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

// startRpc owns its pipes and detached child. This owner adds one budget for
// the entire probe, and keeps cancellation alive until a pending handle arrives.
function createProbeOwner(deadlineMs) {
  requireThat(Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 120000,
    'BENCHMARK_INVALID_TOTAL_DEADLINE');
  let rpc;
  let termination;
  let cleanupPromise;
  let resolveCancellation;
  const cancelled = new Promise(resolveCancel => { resolveCancellation = resolveCancel; });
  const started = performance.now();
  const groupAlive = pid => {
    try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  const stop = () => {
    if (!rpc) return Promise.resolve(null);
    return cleanupPromise ??= (async () => {
      const pid = rpc.lifecycle.find(event => event.event === 'spawn')?.pid;
      const ownedPid = Number.isSafeInteger(pid) && pid > 0 ? pid : null;
      const result = { owned_pid: ownedPid, group_kill_fallback: false, converged: false };
      const killOwnedGroup = () => {
        if (ownedPid === null) return;
        try {
          process.kill(process.platform === 'win32' ? ownedPid : -ownedPid, 'SIGKILL');
          result.group_kill_fallback = true;
        } catch (error) { if (error.code !== 'ESRCH') result.kill_error = failureInfo(error); }
      };
      // The shared helper escalates after two seconds. Its direct child can
      // already have exited while a descendant still holds the RPC pipes open;
      // only that recorded detached group is eligible for this fallback.
      const fallback = setTimeout(killOwnedGroup, 2500);
      let cleanupTimer;
      try {
        const stopped = rpc.stop().then(() => ({ settled: true }), error => ({
          settled: true, rpc_stop_error: failureInfo(error),
        }));
        const outcome = await Promise.race([stopped, new Promise(resolveTimeout => {
          cleanupTimer = setTimeout(() => {
            killOwnedGroup();
            resolveTimeout({ settled: false });
          }, 4500);
        })]);
        if (outcome.rpc_stop_error) result.rpc_stop_error = outcome.rpc_stop_error;
        if (ownedPid !== null && groupAlive(ownedPid)) {
          killOwnedGroup();
          const until = performance.now() + 500;
          while (groupAlive(ownedPid) && performance.now() < until) await wait(20);
        }
        result.converged = outcome.settled && (ownedPid === null || !groupAlive(ownedPid));
        return result;
      } catch (error) {
        result.cleanup_error = failureInfo(error);
        killOwnedGroup();
        return result;
      } finally { clearTimeout(fallback); clearTimeout(cleanupTimer); }
    })();
  };
  const cancel = (kind, signal) => {
    if (termination) return;
    termination = {
      kind, ...(signal ? { signal } : {}), elapsed_ms: Math.round(performance.now() - started),
      code: signal ? 'BENCHMARK_PROBE_SIGNAL_' + signal : 'BENCHMARK_PROBE_TOTAL_DEADLINE',
    };
    resolveCancellation();
    void stop();
  };
  const onTerm = () => cancel('signal', 'SIGTERM');
  const onInt = () => cancel('signal', 'SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  const deadline = setTimeout(() => cancel('deadline'), deadlineMs);
  const assertRunning = () => {
    if (termination) throw Object.assign(new Error(termination.code), { code: termination.code });
  };
  return {
    deadlineMs,
    get termination() { return termination; },
    assertRunning,
    adopt(handle) { rpc = handle; if (termination) void stop(); },
    async during(operation) {
      assertRunning();
      return Promise.race([operation, cancelled.then(() => { assertRunning(); })]);
    },
    stop,
    dispose() {
      clearTimeout(deadline);
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
    },
  };
}

export async function runPhaseZeroProbe({
  args = process.argv.slice(2), deadlineMs = 110000, startRpcForTesting = startRpc,
} = {}) {
  const owner = createProbeOwner(deadlineMs);
  try { return await collectProbe({ args, owner, start: startRpcForTesting }); }
  finally { owner.dispose(); }
}

async function collectProbe({ args, owner, start }) {
  const runRoot = process.env.PAIRED_RUN_ROOT;
  requireThat(runRoot && isAbsolute(runRoot), 'BENCHMARK_PAIRED_RUN_ROOT_REQUIRED');
  requireThat((await lstat(runRoot)).isDirectory() && await realpath(runRoot) === runRoot,
    'BENCHMARK_PAIRED_RUN_ROOT_NOT_CANONICAL');
  const evidenceRoot = join(runRoot, 'benchmark');
  try { await mkdir(evidenceRoot, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  requireThat((await lstat(evidenceRoot)).isDirectory() && await realpath(evidenceRoot) === evidenceRoot,
    'BENCHMARK_EVIDENCE_ROOT_NOT_CANONICAL');
  const eventsPath = join(evidenceRoot, 'observer-events.jsonl');
  await writeFile(eventsPath, '', { flag: 'wx', mode: 0o600 });

  const [nonce, observerPath, ...extra] = args;
  let rpc;
  let pendingStart;
  let cleanup;
  let snapshot;
  let expectedObserver;
  let state;
  let commands;
  let acknowledgement;
  let messages;
  let closedNormally = false;
  const errors = [];
  const controlCommands = [];
  const command = async (type, fields = {}) => {
    owner.assertRunning();
    controlCommands.push({ type, ...fields });
    return owner.during(rpc.command(type, fields));
  };
  const snapshotPath = /^[a-f0-9]{32}$/.test(nonce ?? '')
    ? join(evidenceRoot, `observation-${nonce}.json`) : null;
  const rejectActivity = () => {
    requireThat(!rpc.frames.some(frame => frame.type === 'extension_error'),
      'BENCHMARK_EXTENSION_ERROR');
    requireThat(!rpc.frames.some(frame => frame.type === 'agent_start'),
      'BENCHMARK_UNEXPECTED_AGENT_START');
  };

  try {
    owner.assertRunning();
    requireThat(extra.length === 0 && snapshotPath !== null,
      'BENCHMARK_EXPECTED_NONCE_AND_OBSERVER_ONLY');
    requireThat(observerPath && isAbsolute(observerPath) && (await lstat(observerPath)).isFile(),
      'BENCHMARK_OBSERVER_ABSOLUTE_FILE_REQUIRED');
    expectedObserver = {
      path: await realpath(observerPath), sha256: sha256(await readFile(observerPath)),
    };
    const piWrapper = join(runRoot, 'bin', 'pi');
    requireThat((await lstat(piWrapper)).isFile() && await realpath(piWrapper) === piWrapper,
      'BENCHMARK_PRIVATE_PI_WRAPPER_REQUIRED');
    owner.assertRunning();
    pendingStart = start({
      host: piWrapper,
      args: ['--provider', 'benchmark-phase0', '--model', 'no-request', '--thinking', 'off'],
      cwd: process.cwd(),
      env: { ...process.env, BENCHMARK_PHASE_ZERO_NONCE: nonce },
      timeoutMs: 60000,
      // Retain the RPC handle even if the first handshake fails.
      waitForState: false,
    }).then(handle => {
      rpc = handle;
      owner.adopt(handle);
      return handle;
    });
    await owner.during(pendingStart);
    state = await command('get_state');
    requireThat(state?.model?.provider === 'benchmark-phase0' && state.model.id === 'no-request' &&
      state.thinkingLevel === 'off', 'BENCHMARK_PHASE_ZERO_MODEL_NOT_SELECTED');
    requireThat(state.isStreaming === false && state.isCompacting === false &&
      state.pendingMessageCount === 0, 'BENCHMARK_STARTUP_NOT_IDLE');
    commands = await command('get_commands');
    const inspections = commands?.commands?.filter(item => item.name === 'benchmark-inspect') ?? [];
    requireThat(inspections.length === 1 && inspections[0].source === 'extension' &&
      typeof inspections[0].sourceInfo?.path === 'string',
    'BENCHMARK_INSPECTION_COMMAND_NOT_REGISTERED');
    requireThat(await realpath(inspections[0].sourceInfo.path) === expectedObserver.path,
      'BENCHMARK_INSPECTION_COMMAND_SOURCE_MISMATCH');
    rejectActivity();

    acknowledgement = await command('prompt', { message: `/benchmark-inspect ${nonce}` });
    requireThat(acknowledgement?.disposition === 'handled',
      'BENCHMARK_INSPECTION_WAS_NOT_HANDLED_LOCALLY');
    rejectActivity();
    snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    requireThat(snapshot?.schema_version === 1 && snapshot.kind === 'benchmark-pi-observation' &&
      snapshot.nonce === nonce && snapshot.roots?.PAIRED_RUN_ROOT === runRoot,
    'BENCHMARK_OBSERVATION_BINDING_MISMATCH');
    requireThat(snapshot.observer?.path === expectedObserver.path &&
      snapshot.observer?.sha256 === expectedObserver.sha256,
    'BENCHMARK_OBSERVER_IDENTITY_MISMATCH');
    requireThat(snapshot.model_selection?.provider === 'benchmark-phase0' &&
      snapshot.model_selection?.id === 'no-request' && snapshot.thinking_level === 'off',
    'BENCHMARK_OBSERVED_MODEL_MISMATCH');

    messages = await command('get_messages');
    requireThat(Array.isArray(messages?.messages) &&
      messages.messages.every(message => message?.role === 'system'),
    'BENCHMARK_UNEXPECTED_INITIAL_BUSINESS_MESSAGES');
    const finalState = await command('get_state');
    requireThat(finalState.isStreaming === false && finalState.isCompacting === false &&
      finalState.pendingMessageCount === 0, 'BENCHMARK_INSPECTION_DID_NOT_SETTLE');
    rejectActivity();
    await owner.during(rpc.closeInput());
    closedNormally = true;
    rejectActivity();
  } catch (error) {
    errors.push(failureInfo(error));
  } finally {
    // If a signal won the race with startRpc, do not discard the eventual
    // detached child handle. adopt() immediately stops it while cancelled.
    if (pendingStart) {
      try { await pendingStart; }
      catch (error) { errors.push(failureInfo(error)); }
    }
    cleanup = await owner.stop();
    if (cleanup && !cleanup.converged) errors.push({
      name: 'Error', message: 'BENCHMARK_OWNED_RPC_CLEANUP_DID_NOT_CONVERGE',
    });
    if (owner.termination && !errors.some(error => error.code === owner.termination.code)) {
      errors.push({ name: 'Error', message: owner.termination.code, code: owner.termination.code });
    }
  }

  let events = [];
  try {
    const text = await readFile(eventsPath, 'utf8');
    events = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    requireThat(events.every(event => event.nonce === nonce),
      'BENCHMARK_OBSERVER_EVENT_NONCE_MISMATCH');
    requireThat(events.filter(event => event.event === 'observer_ready').length === 1 &&
      events.filter(event => event.event === 'snapshot_written').length === 1 &&
      events.some(event => event.event === 'session_start') &&
      events.some(event => event.event === 'session_shutdown'),
    'BENCHMARK_OBSERVER_LIFECYCLE_INCOMPLETE');
    requireThat(!events.some(event => [
      'before_agent_start', 'agent_start', 'before_provider_request',
      'after_provider_response', 'unexpected_provider_invocation', 'inspection_rejected',
    ].includes(event.event)), 'BENCHMARK_UNEXPECTED_MODEL_ACTIVITY');
  } catch (error) { errors.push(failureInfo(error)); }

  const framesPath = join(evidenceRoot, 'rpc-frames.json');
  const lifecyclePath = join(evidenceRoot, 'lifecycle.json');
  await saveNew(framesPath, rpc?.frames ?? []);
  await saveNew(lifecyclePath, rpc?.lifecycle ?? []);
  const rawFiles = await Promise.all([framesPath, lifecyclePath, eventsPath].map(describeFile));
  let snapshotFile = null;
  if (snapshotPath) {
    try { snapshotFile = await describeFile(snapshotPath); }
    catch (error) { if (error.code !== 'ENOENT') errors.push(failureInfo(error)); }
  }
  const observerReady = events.some(event => event.event === 'observer_ready');
  const providerInvocations = events.filter(event => event.event === 'unexpected_provider_invocation').length;
  const providerRequestEvents = events.filter(event => event.event === 'before_provider_request').length;
  if (owner.termination && !errors.some(error => error.code === owner.termination.code)) {
    errors.push({ name: 'Error', message: owner.termination.code, code: owner.termination.code });
  }
  const result = {
    schema_version: 1,
    kind: 'benchmark-phase-zero-probe',
    status: errors.length === 0 && closedNormally ? 'passed' : 'failed',
    nonce: nonce ?? null,
    snapshot: snapshotFile,
    observer: expectedObserver ?? null,
    raw_files: rawFiles,
    control_scope: {
      purpose: 'local_loading_inspection_only',
      commands: controlCommands,
      business_tasks_submitted: 0,
      manifest_approval: 'not_performed',
    },
    // Two observation points may describe the same attempted request. Preserve
    // their counts separately; only the verified no-request case is a scalar.
    model_requests: observerReady && providerInvocations === 0 && providerRequestEvents === 0 ? 0 : null,
    model_request_observation: {
      scope: 'phase_zero_provider_invocations_and_observer_events',
      provider_invocations: providerInvocations,
      before_provider_request_events: providerRequestEvents,
      agent_start_frames: rpc?.frames.filter(frame => frame.type === 'agent_start').length ?? 0,
      observer_ready: observerReady,
    },
    graceful_eof: closedNormally,
    lifecycle_control: {
      total_deadline_ms: owner.deadlineMs,
      termination: owner.termination ?? null,
      cleanup,
    },
    collection_limitations: limitations,
    errors,
  };
  await saveNew(join(evidenceRoot, 'probe.json'), result);
  return { ...result, probe_path: join(evidenceRoot, 'probe.json') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPhaseZeroProbe().then(result => {
    process.stdout.write(JSON.stringify({
      status: result.status, probe: result.probe_path, snapshot: result.snapshot?.path ?? null,
    }) + '\n');
    if (result.status !== 'passed') process.exitCode = 1;
  }, error => {
    process.stderr.write(JSON.stringify({ error: failureInfo(error) }) + '\n');
    process.exitCode = 1;
  });
}
