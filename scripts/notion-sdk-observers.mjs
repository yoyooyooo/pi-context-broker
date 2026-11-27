import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

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

export function assertCatalogCancellationBoundary(start, end, lifecycle) {
  assert.equal(start.operation, 'list', 'Only catalogue cancellation can be reconciled at a native session boundary');
  assert.equal(end.operation, start.operation); assert.equal(end.observer_pid, start.observer_pid);
  const boundary = lifecycle.find(event => ['session_tree', 'session_shutdown'].includes(event.type)
    && event.pid === start.observer_pid && typeof event.monotonic_ns === 'string' && /^\d+$/.test(event.monotonic_ns)
    && BigInt(event.monotonic_ns) >= BigInt(start.monotonic_ns) && BigInt(event.monotonic_ns) <= BigInt(end.monotonic_ns));
  assert.ok(boundary, 'Cancelled catalogue must match an actual session boundary inside its exact SDK interval');
  return boundary;
}

function sdkOperationState(bytes, pid) {
  // appendFileSync writes newline-terminated records. A concurrent trailing write
  // is not an observation, even when the bytes already form valid JSON.
  const completeBytes = bytes.lastIndexOf(10) + 1;
  const starts = new Map(), ends = new Set(), matched = new Set(), errors = [];
  let startCount = 0, endCount = 0;
  for (const [index, line] of bytes.subarray(0, completeBytes).toString('utf8').split('\n').slice(0, -1).entries()) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); }
    catch { errors.push({ line: index + 1, code: 'invalid_json' }); continue; }
    if (row?.kind !== 'context-broker.notion-sdk' || row.observer_pid !== pid) continue;
    const issue = code => errors.push({ line: index + 1, code, id: typeof row.id === 'string' ? row.id : null });
    if (row.pid !== pid || typeof row.id !== 'string' || !row.id || typeof row.operation !== 'string' || !row.operation) {
      issue('invalid_operation_identity'); continue;
    }
    if (row.event === 'start') {
      startCount++;
      if (starts.has(row.id)) issue('duplicate_start');
      else starts.set(row.id, row.operation);
    } else if (row.event === 'end') {
      endCount++;
      if (ends.has(row.id)) issue('duplicate_end');
      else if (!starts.has(row.id)) issue('end_without_start');
      else if (starts.get(row.id) !== row.operation) issue('operation_mismatch');
      else matched.add(row.id);
      ends.add(row.id);
    } else issue('unknown_operation_event');
  }
  return { observed_bytes: bytes.length, observed_sha256: createHash('sha256').update(bytes).digest('hex'),
    complete_bytes: completeBytes, partial_tail_bytes: bytes.length - completeBytes,
    start_count: startCount, end_count: endCount, start_ids: [...starts.keys()].sort(), end_ids: [...ends].sort(),
    pending_ids: [...starts.keys()].filter(id => !matched.has(id)).sort(), errors };
}

/** Private verifier boundary: observed SDK completion before this Pi receives EOF.
 * This is a snapshot of real events, not a promise that no later operation starts.
 * The existing post-exit lifecycle assertions remain authoritative for that gap.
 */
export async function waitForSdkOperations(path, pid, { timeoutMs = 10000 } = {}) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'An actual Pi PID is required');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000, 'Invalid SDK settle deadline');
  const started = process.hrtime.bigint();
  let observations = 0, initial;
  for (;;) {
    const bytes = await readFile(path).catch(error => {
      if (error.code === 'ENOENT') return Buffer.alloc(0);
      throw error;
    });
    const state = sdkOperationState(bytes, pid), observed = process.hrtime.bigint();
    const elapsedMs = Number(observed - started) / 1e6;
    observations++;
    initial ??= { observed_sha256: state.observed_sha256, observed_bytes: state.observed_bytes,
      pending_ids: state.pending_ids, partial_tail_bytes: state.partial_tail_bytes };
    const receipt = { version: 1, source_path: path, observer_pid: pid, timeout_ms: timeoutMs,
      started_monotonic_ns: started.toString(), observed_monotonic_ns: observed.toString(),
      elapsed_ms: elapsedMs, observations, initial, ...state };
    const status = state.errors.length ? 'invalid' : elapsedMs >= timeoutMs ? 'timeout'
      : state.start_count > 0 && state.pending_ids.length === 0 && state.partial_tail_bytes === 0 ? 'settled' : undefined;
    if (status === 'settled') return { ...receipt, status };
    if (status) throw Object.assign(new Error('SDK operation settle ' + status + ' for Pi PID ' + pid), {
      code: status === 'timeout' ? 'CURRENT_SDK_SETTLE_TIMEOUT' : 'CURRENT_SDK_SETTLE_INVALID', receipt: { ...receipt, status },
    });
    // Polling only yields to the real writer; elapsed time never establishes completion.
    await delay(Math.min(20, timeoutMs - elapsedMs));
  }
}
