import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { safeRequestMetrics } from './notion-default-context.mjs';

/** Passive public diagnostics in the owned Pi process. No process, stream or SDK
 * method is replaced. Raw CLI stdout is retained only in bounded memory, parsed
 * after an actual close, and discarded; only public safe metrics are written. */
export function observeSourceTransport(settings) {
  const { diagnostics, fs, crypto, path, errorMonitor, output, checkoutRoot, clockId, cliPath, safeRequestMetrics: decodeMetrics } = settings;
  const root = fs.realpathSync(checkoutRoot), parent = fs.realpathSync(path.dirname(output));
  const within = path.relative(root, parent);
  if (!path.isAbsolute(output) || within === '' || within !== '..' && !within.startsWith('..' + path.sep) && !path.isAbsolute(within))
    throw new Error('SOURCE_EVIDENCE_MUST_BE_OUTSIDE_CHECKOUT');
  const canonicalCli = fs.realpathSync(cliPath), maxBytes = settings.maxStdoutBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error('SOURCE_OBSERVER_LIMIT_INVALID');
  const fd = fs.openSync(output, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  fs.fchmodSync(fd, 0o600);
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const operations = new Map(), children = new Map(), unmatched = new Map(), subscriptions = [];
  let sequence = 0, previous = null, nextChild = 0, errors = 0, closed = false, unmatchedChildren = 0;
  const record = (phase, details = {}) => {
    const row = { version: 1, sequence: ++sequence, previousSha256: previous, clockId,
      monotonicNs: process.hrtime.bigint().toString(), phase, ...details };
    row.eventSha256 = hash(JSON.stringify(row)); previous = row.eventSha256;
    fs.writeSync(fd, JSON.stringify(row) + '\n');
  };
  const guarded = (label, callback) => (...args) => {
    if (closed) return;
    try { callback(...args); }
    catch { errors++; try { record('observer_error', { kind: 'observer', channel: label }); } catch {} }
  };
  const subscribe = (name, callback) => {
    const handle = guarded(name, callback);
    diagnostics.subscribe(name, handle); subscriptions.push([name, handle]);
  };
  const metrics = (requestId, value, eligible = true) => {
    const decoded = eligible ? decodeMetrics(value) : undefined;
    if (decoded) for (const event of decoded.trace) {
      const visible = { ...event };
      for (const key of ['request_id', 'rate_limit_reason'])
        if (typeof visible[key] === 'string' && /(?:https?|wss?):\/\//i.test(visible[key])) visible[key] = null;
      record(event.event, { ...visible,
        ...(event.event === 'wait' ? { wait_kind: event.kind } : {}), kind: 'http', requestId });
    }
    record('metrics', { kind: 'metrics', requestId, observed: decoded !== undefined,
      complete: decoded?.complete ?? false, total_requests: decoded?.total_requests ?? null, trace_dropped: decoded?.trace_dropped ?? null });
  };
  const safeCode = value => typeof value === 'string' && /^[A-Z0-9_]{1,80}$/i.test(value) ? value : null;
  record('source_observer_start', { kind: 'observer', pid: process.pid, node: process.versions.node,
    method: 'public-diagnostics-sdk-and-direct-bundled-cli', cliPathSha256: hash(canonicalCli), maxStdoutBytes: maxBytes,
    stdoutMethod: 'data-events-only-after-an-existing-flowing-consumer; no read/resume/pipe',
    unmatchedChildLifecycleVersion: 1,
    coverage: 'owned Pi SDK operations and direct bundled CLI; direct unmatched child lifecycle only, descendant transport remains unknown', wireBytes: null });
  subscribe('context-broker.notion-sdk', event => {
    if (!event || event.version !== 1 || !['start', 'end'].includes(event.event) || !['list', 'files', 'consume', 'read', 'read-resources'].includes(event.operation)
      || typeof event.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(event.id) || event.pid !== process.pid
      || typeof event.monotonic_ns !== 'string' || !/^\d+$/.test(event.monotonic_ns)) throw new Error('SDK_EVENT_INVALID');
    const requestId = 'sdk:' + process.pid + ':' + event.id;
    if (event.event === 'start') {
      if (operations.has(requestId)) throw new Error('SDK_DUPLICATE_START');
      operations.set(requestId, { kind: 'sdk', operation: event.operation, started: event.monotonic_ns, ended: false });
      record('started', { kind: 'sdk', requestId, pid: process.pid, operation: event.operation, sourceMonotonicNs: event.monotonic_ns });
      return;
    }
    const operation = operations.get(requestId);
    if (!operation || operation.ended || operation.operation !== event.operation || BigInt(event.monotonic_ns) < BigInt(operation.started)
      || !['completed', 'failed', 'cancelled'].includes(event.status) || typeof event.sdk_started !== 'boolean' || typeof event.metrics_observed !== 'boolean'
      || typeof event.elapsed_ms !== 'number' || !Number.isFinite(event.elapsed_ms) || event.elapsed_ms < 0) throw new Error('SDK_END_INVALID');
    metrics(requestId, event.request_metrics, event.metrics_observed);
    operation.ended = true;
    record('completed', { kind: 'sdk', requestId, pid: process.pid, operation: event.operation, status: event.status,
      sdkStarted: event.sdk_started, sourceMonotonicNs: event.monotonic_ns, elapsedMs: event.elapsed_ms });
  });
  subscribe('tracing:child_process.spawn:start', ({ process: child, options }) => {
    const args = options?.args;
    let matched = false;
    if (Array.isArray(args) && typeof args[1] === 'string' && path.isAbsolute(args[1])) {
      try { matched = fs.realpathSync(args[1]) === canonicalCli; } catch {}
    }
    if (!matched) {
      if (unmatched.has(child)) throw new Error('CHILD_DUPLICATE_START');
      const childId = 'child:' + process.pid + ':' + (++unmatchedChildren);
      const entry = { childId, childPid: null, closed: false };
      unmatched.set(child, entry);
      const identity = () => ({ kind: 'child', childId, parentPid: process.pid, childPid: entry.childPid });
      const hasArgs = Array.isArray(args) && args.every(value => typeof value === 'string');
      record('unmatched_child_start', { ...identity(), argumentCount: hasArgs ? args.length : null,
        argvSha256: hasArgs ? hash(JSON.stringify(args)) : null, detached: options?.detached === true,
        executableSha256: typeof options?.file === 'string' ? hash(options.file) : null, transport: 'unknown' });
      child.once('spawn', guarded('unmatched_child_spawn', () => {
        entry.childPid = Number.isSafeInteger(child.pid) ? child.pid : null;
        record('unmatched_child_spawn', { ...identity(), boundary: 'child-spawn-event' });
      }));
      // errorMonitor observes the error without installing an error handler that
      // would turn an otherwise fatal unhandled error into a successful host.
      child.on(errorMonitor, guarded('unmatched_child_error', error => {
        record('unmatched_child_error', { ...identity(), code: safeCode(error?.code), boundary: 'child-error-monitor' });
      }));
      child.once('exit', guarded('unmatched_child_exit', (code, signal) => {
        record('unmatched_child_exit', { ...identity(), code, signal, boundary: 'child-exit-event' });
      }));
      child.once('close', guarded('unmatched_child_close', (code, signal) => {
        entry.closed = true;
        record('unmatched_child_close', { ...identity(), code, signal, boundary: 'child-close-event' });
      }));
      return;
    }
    if (children.has(child)) throw new Error('CLI_DUPLICATE_START');
    const requestId = 'cli:' + process.pid + ':' + (++nextChild);
    const command = ['ctl', 'list', 'use', 'prepare', 'read', 'files', 'export'].includes(args[2]) ? args[2] : 'other';
    const policy = args.includes('--refresh') ? 'refresh' : args.includes('--offline') ? 'offline' : args.includes('--max-age') ? 'max_age' : 'default';
    const operation = { kind: 'cli', requestId, ended: false, stdoutObserved: false, stdoutEnded: false,
      stdoutBytes: 0, overflow: false, chunks: [], stdoutHash: crypto.createHash('sha256'), childPid: null };
    children.set(child, operation); operations.set(requestId, operation);
    record('started', { kind: 'cli', requestId, pid: process.pid, command, policy, boundary: 'diagnostics-spawn-start' });
    child.once('spawn', guarded('child_spawn', () => {
      operation.childPid = Number.isSafeInteger(child.pid) ? child.pid : null;
      record('child-started', { kind: 'cli', requestId, childPid: operation.childPid, boundary: 'child-spawn-event' });
      const stream = child.stdout;
      // Adding a data listener to a paused/unconsumed stream would change its
      // behavior. Such stdout is deliberately left unobserved.
      if (!stream || stream.readableFlowing !== true || stream.listenerCount('data') === 0 || stream.readableDidRead) {
        record('stdout_unobserved', { kind: 'cli', requestId, reason: 'no-existing-unread-flowing-consumer' }); return;
      }
      operation.stdoutObserved = true;
      stream.on('data', guarded('child_stdout', chunk => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, stream.readableEncoding ?? 'utf8') : chunk;
        operation.stdoutBytes += bytes.length; operation.stdoutHash.update(bytes);
        if (operation.stdoutBytes <= maxBytes) operation.chunks.push(Buffer.from(bytes));
        else { operation.overflow = true; operation.chunks.length = 0; }
      }));
      stream.once('end', guarded('child_stdout_end', () => { operation.stdoutEnded = true; }));
    }));
    child.once('close', guarded('child_close', (code, signal) => {
      if (operation.ended) throw new Error('CLI_DUPLICATE_CLOSE');
      const stdoutComplete = operation.stdoutObserved && operation.stdoutEnded && !operation.overflow;
      let value;
      if (stdoutComplete) { try { value = JSON.parse(Buffer.concat(operation.chunks).toString('utf8')).request_metrics; } catch {} }
      metrics(requestId, value, stdoutComplete);
      operation.chunks.length = 0; operation.ended = true;
      record('completed', { kind: 'cli', requestId, childPid: operation.childPid, code, signal,
        boundary: 'child-close-event', stdoutObserved: operation.stdoutObserved, stdoutComplete,
        stdoutBytes: operation.stdoutObserved ? operation.stdoutBytes : null,
        stdoutSha256: operation.stdoutObserved ? operation.stdoutHash.digest('hex') : null, stdoutOverflow: operation.overflow });
    }));
  });
  subscribe('tracing:child_process.spawn:error', ({ process: child, error }) => {
    const operation = children.get(child);
    if (operation) record('spawn_error', { kind: 'cli', requestId: operation.requestId, code: safeCode(error?.code) });
  });
  const finish = () => {
    if (closed) return;
    try {
      for (const [name, handle] of subscriptions) diagnostics.unsubscribe(name, handle);
      const pending = [...operations].filter(([, value]) => !value.ended).map(([id]) => id);
      const pendingChildIds = [...unmatched.values()].filter(value => !value.closed).map(value => value.childId);
      record('source_observer_end', { kind: 'observer', errors, complete: errors === 0 && pending.length === 0 && pendingChildIds.length === 0,
        operations: operations.size, sdkStarts: [...operations.values()].filter(value => value.kind === 'sdk').length,
        cliStarts: children.size, unmatchedChildren, unmatchedChildCloses: unmatched.size - pendingChildIds.length,
        pendingChildIds, pendingRequestIds: pending, wireBytes: null });
    } catch { /* A failed evidence write stays a missing terminal, not a host failure. */ }
    finally { closed = true; process.off('exit', finish); try { fs.closeSync(fd); } catch {} }
  };
  process.once('exit', finish);
  return { finish };
}

/** NODE_OPTIONS is inherited by CLI children; PID/entry/thread guards keep the
 * observer in this driver-owned Pi process without changing child environment. */
export function sourceObserverPreloadSource(settings) {
  return "import diagnostics from 'node:diagnostics_channel';\nimport fs from 'node:fs';\nimport crypto from 'node:crypto';\nimport path from 'node:path';\nimport {errorMonitor} from 'node:events';\nimport {isMainThread} from 'node:worker_threads';\n"
    + 'const settings = ' + JSON.stringify(settings) + ';\n'
    + 'let owned=false; try { owned=isMainThread && process.ppid===settings.ownerParentPid && fs.realpathSync(process.argv[1])===fs.realpathSync(settings.ownerEntry); } catch {}\n'
    + 'if(owned) { try { const safeRequestMetrics = (' + safeRequestMetrics.toString() + '); (' + observeSourceTransport.toString() + ')( {...settings,diagnostics,fs,crypto,path,errorMonitor,safeRequestMetrics} ); } catch { /* Missing observation is reported by the driver. */ } }\n';
}

/** Invalid or partial observations remain available to the driver, but never
 * satisfy completeness. This reader does not erase failed or pending samples. */
export async function readSourceObservation(file, { final = true } = {}) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { events: [], complete: false, errors: ['missing-observer'] }; throw error; }
  const errors = [], events = [];
  if (text && !text.endsWith('\n')) errors.push('truncated-line');
  const lines = text.split('\n'); lines.pop();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('invalid-event');
      else events.push(value);
    } catch { errors.push('invalid-json'); }
  }
  let previous = null, last = -1n, clock;
  const operations = new Map(), unmatched = new Map();
  const childVersion = events[0]?.unmatchedChildLifecycleVersion, tracksChildren = childVersion === 1;
  if (childVersion !== undefined && !tracksChildren) errors.push('unknown-child-lifecycle-version');
  const validPid = value => Number.isSafeInteger(value) && value > 0;
  const validHash = value => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const validExit = event => Number.isInteger(event.code) && event.signal === null
    || event.code === null && typeof event.signal === 'string' && /^SIG[A-Z0-9]+$/.test(event.signal);
  for (const [index, event] of events.entries()) {
    const { eventSha256, ...body } = event;
    if (event.version !== 1 || event.sequence !== index + 1 || event.previousSha256 !== previous
      || eventSha256 !== createHash('sha256').update(JSON.stringify(body)).digest('hex')) errors.push('invalid-hash-chain');
    previous = eventSha256;
    if (typeof event.clockId !== 'string' || !event.clockId || clock !== undefined && event.clockId !== clock) errors.push('invalid-clock');
    clock ??= event.clockId;
    if (typeof event.monotonicNs !== 'string' || !/^\d+$/.test(event.monotonicNs) || BigInt(event.monotonicNs) < last) errors.push('invalid-time');
    else last = BigInt(event.monotonicNs);
    if (event.phase === 'unmatched_child_start' && tracksChildren) {
      if (event.kind !== 'child' || typeof event.childId !== 'string' || !/^child:\d+:\d+$/.test(event.childId)
        || unmatched.has(event.childId) || !validPid(event.parentPid) || event.parentPid !== events[0]?.pid
        || event.childPid !== null || event.transport !== 'unknown' || typeof event.detached !== 'boolean'
        || !validHash(event.executableSha256) || !validHash(event.argvSha256)
        || !(event.argumentCount === null && event.argvSha256 === null
          || Number.isSafeInteger(event.argumentCount) && event.argumentCount >= 0 && event.argvSha256 !== null)) {
        errors.push('invalid-child-start'); continue;
      }
      unmatched.set(event.childId, { parentPid: event.parentPid, childPid: null, spawned: false, exited: false, closed: false, errors: 0 });
    } else if (['unmatched_child_spawn','unmatched_child_error','unmatched_child_exit','unmatched_child_close'].includes(event.phase)) {
      const child = unmatched.get(event.childId);
      if (!tracksChildren || !child || child.closed || event.kind !== 'child' || event.parentPid !== child.parentPid) {
        errors.push('unpaired-child-event'); continue;
      }
      if (event.phase === 'unmatched_child_spawn') {
        if (child.spawned || child.exited || !validPid(event.childPid)) errors.push('invalid-child-spawn');
        child.spawned = true; child.childPid = event.childPid;
      } else {
        if (event.childPid !== child.childPid) errors.push('changed-child-pid');
        if (event.phase === 'unmatched_child_error') {
          if (event.code !== null && (typeof event.code !== 'string' || !/^[A-Z0-9_]{1,80}$/i.test(event.code))) errors.push('invalid-child-error');
          child.errors++;
        } else {
          if (!validExit(event)) errors.push('invalid-child-exit-status');
          if (event.phase === 'unmatched_child_exit') {
            if (!child.spawned || child.exited) errors.push('invalid-child-exit');
            child.exited = true; child.code = event.code; child.signal = event.signal;
          } else {
            if (child.spawned ? !child.exited || event.code !== child.code || event.signal !== child.signal : child.errors === 0)
              errors.push('invalid-child-close');
            child.closed = true;
          }
        }
      }
    } else if (event.phase === 'started') {
      if (!['cli', 'sdk'].includes(event.kind) || typeof event.requestId !== 'string' || operations.has(event.requestId)) errors.push('duplicate-or-invalid-start');
      operations.set(event.requestId, { kind: event.kind, completed: 0, metrics: 0, attempts: new Set() });
    } else if (['metrics', 'completed', 'attempt', 'wait', 'child-started', 'stdout_unobserved', 'spawn_error'].includes(event.phase)) {
      const operation = operations.get(event.requestId);
      if (!operation || operation.completed) errors.push('unpaired-operation-event');
      if (event.phase === 'completed' && operation) { operation.completed++; if (event.kind !== operation.kind) errors.push('changed-operation-kind'); }
      if (event.phase === 'attempt' && operation) {
        if (event.kind !== 'http' || !Number.isSafeInteger(event.attempt) || event.attempt < 1 || operation.attempts.has(event.attempt)) errors.push('invalid-attempt');
        operation.attempts.add(event.attempt);
      }
      if (event.phase === 'metrics' && operation) {
        operation.metrics++;
        if (typeof event.observed !== 'boolean' || typeof event.complete !== 'boolean'
          || event.complete && (!event.observed || event.trace_dropped !== 0 || event.total_requests !== operation.attempts.size
            || [...operation.attempts].some(attempt => attempt > event.total_requests))) errors.push('metrics-inconsistent');
      }
    } else if (!['source_observer_start', 'source_observer_end', 'observer_error', 'unmatched_child_start'].includes(event.phase)) errors.push('unknown-phase');
  }
  if (events[0]?.phase !== 'source_observer_start' || events.filter(event => event.phase === 'source_observer_start').length !== 1) errors.push('missing-or-duplicate-start-boundary');
  const end = events.at(-1), terminal = end?.phase === 'source_observer_end';
  const pendingChildIds = [...unmatched].filter(([, value]) => !value.closed).map(([id]) => id);
  if (final && !terminal) errors.push('missing-end-boundary');
  if (events.filter(event => event.phase === 'source_observer_end').length > Number(terminal)) errors.push('misplaced-end-boundary');
  if (terminal) {
    const pending = [...operations].filter(([, value]) => !value.completed).map(([id]) => id);
    if (end.operations !== operations.size || end.sdkStarts !== [...operations.values()].filter(value => value.kind === 'sdk').length
      || end.cliStarts !== [...operations.values()].filter(value => value.kind === 'cli').length
      || end.unmatchedChildren !== events.filter(event => event.phase === 'unmatched_child_start').length
      || end.errors !== events.filter(event => event.phase === 'observer_error').length
      || !Array.isArray(end.pendingRequestIds) || end.pendingRequestIds.length !== pending.length
      || new Set(end.pendingRequestIds).size !== pending.length || end.pendingRequestIds.some(id => !pending.includes(id))
      || end.complete !== (end.errors === 0 && pending.length === 0 && (!tracksChildren || pendingChildIds.length === 0))) errors.push('terminal-inconsistent');
    if (tracksChildren && (end.unmatchedChildCloses !== unmatched.size - pendingChildIds.length
      || !Array.isArray(end.pendingChildIds) || end.pendingChildIds.length !== pendingChildIds.length
      || new Set(end.pendingChildIds).size !== pendingChildIds.length || end.pendingChildIds.some(id => !pendingChildIds.includes(id))))
      errors.push('child-terminal-inconsistent');
    if ([...operations.values()].some(value => value.completed && value.metrics !== 1)) errors.push('missing-or-duplicate-metrics');
  }
  const unmatchedChildLifecycle = tracksChildren ? {
    version: 1, starts: unmatched.size, spawns: [...unmatched.values()].filter(value => value.spawned).length,
    exits: [...unmatched.values()].filter(value => value.exited).length, closes: unmatched.size - pendingChildIds.length,
    errors: [...unmatched.values()].reduce((sum, value) => sum + value.errors, 0), pendingChildIds,
    complete: errors.length === 0 && terminal && end.errors === 0 && pendingChildIds.length === 0, descendants: 'unobserved',
  } : null;
  return { events, complete: errors.length === 0 && terminal && end.complete === true, errors: [...new Set(errors)], unmatchedChildLifecycle };
}
