import assert from 'node:assert/strict';

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

