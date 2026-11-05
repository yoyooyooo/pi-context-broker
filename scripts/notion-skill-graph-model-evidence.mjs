import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';

/** Views of captured source facts, never fabricated CLI calls or extra HTTP receipts.
 * A consume entry carries its own immutable manifest and original body range.
 * The caller still checks actual provider delivery and the private source oracle. */
export function graphSourceViews(receipts) {
  const directories = [], preparations = [], entries = [], resources = [];
  for (const receipt of receipts) {
    const sdk = receipt.transport === 'sdk';
    const value = sdk ? receipt.value : receipt.response;
    if (!value || (sdk ? receipt.status !== 'completed' || receipt.resultObserved !== true : receipt.code !== undefined && receipt.code !== 0)) continue;
    const operation = sdk ? receipt.operation : receipt.command;
    const observed = { requestId: receipt.requestId, transport: sdk ? 'sdk' : 'command', operation };
    if (operation === 'list' && Array.isArray(value.records)) directories.push({ ...observed, value });
    if (operation === 'read' && value.record && typeof value.scope === 'string') entries.push({ ...observed, value, ...(receipt.outputEvidence ? { outputEvidence: receipt.outputEvidence } : {}) });
    if (operation === 'prepare' && value.status === 'ready') preparations.push({ ...observed, value });
    if (sdk && operation === 'read-resources' && value.status === 'ready') {
      const manifest = value.manifest, selection = value.selection;
      assert.equal(value.version, 1); assert.equal(manifest?.complete, true);
      assert.equal(hash(canonical(manifest)), value.manifest_sha256, 'Observed resource manifest hash');
      assert.deepEqual(selection, { scope: manifest.scope, owner: manifest.record.id, snapshot_id: manifest.snapshot_id, version_id: manifest.version_id });
      assert.ok(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 16);
      const paths = new Set(), identities = new Set();
      for (const file of value.files) {
        const declared = manifest.files.filter(item => item.path === file.path), binding = manifest.file_bindings?.find(item => item.path === file.path);
        assert.equal(declared.length, 1); assert.notEqual(file.path, manifest.entrypoint);
        assert.equal(file.file_id, binding?.file_id); assert.ok(['utf8', 'base64'].includes(file.encoding));
        assert.equal(typeof file.content, 'string'); assert.equal(typeof file.requested_ref, 'string');
        const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
        assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
        assert.equal(declared[0].bytes, file.bytes); assert.equal(declared[0].sha256, file.sha256);
        const ref = new URL(file.ref), requested = new URL(file.requested_ref);
        for (const parsed of [ref, requested]) {
          assert.equal(parsed.protocol, 'skill:'); assert.equal(decodeURIComponent(parsed.hostname), selection.owner);
          assert.equal(parsed.searchParams.get('snapshot'), selection.snapshot_id);
        }
        assert.equal(ref.searchParams.get('file_id') ?? undefined, file.file_id);
        if (requested.searchParams.has('file_id')) assert.equal(requested.searchParams.get('file_id'), file.file_id);
        else assert.equal(requested.pathname, ref.pathname);
        assert.equal(ref.pathname.slice(1).split('/').map(decodeURIComponent).join('/'), file.path);
        const identity = file.file_id ?? file.path;
        assert.ok(!paths.has(file.path) && !identities.has(identity), 'A resource operation cannot duplicate a selected file');
        paths.add(file.path); identities.add(identity);
      }
      resources.push({ ...observed, value });
    }
    if (operation !== 'consume' || value.status !== 'ready') continue;
    assert.equal(value.version, 1, 'Observed SDK consumption contract version');
    const ready = value.preparation;
    assert.equal(ready?.status, 'ready');
    assert.ok(Array.isArray(ready.nodes) && Array.isArray(value.entries));
    const nodes = ready.nodes.filter(node => node.state === 'prepared');
    assert.deepEqual(value.entries.map(entry => entry.id).sort(), nodes.map(node => node.id).sort(), 'Observed SDK entries match the entire prepared closure');
    preparations.push({ ...observed, value: ready });
    for (const entry of value.entries) {
      const node = nodes.find(node => node.id === entry.id), manifest = entry.manifest, body = entry.source_body;
      assert.equal(manifest?.complete, true); assert.equal(manifest.scope, ready.scope);
      assert.equal(hash(canonical(manifest)), entry.manifest_sha256, 'Observed SDK manifest hash');
      assert.deepEqual(manifest.record, node.record);
      assert.equal(manifest.snapshot_id, node.binding.snapshot_id); assert.equal(manifest.version_id, node.binding.version_id);
      assert.equal(manifest.entrypoint, node.path); assert.equal(body?.kind, 'verified_snapshot_entry');
      assert.equal(body.ref, node.binding.ref); assert.equal(body.path, node.path);
      assert.equal(body.has_more, false); assert.equal(body.range?.start, 1); assert.equal(body.range?.end, body.range?.total_lines);
      assert.ok(Number.isSafeInteger(body.range?.end) && body.range.end > 0);
      assert.equal(body.range.total_lines, node.content.split('\n').length, 'Observed complete source range');
      assert.equal(body.sha256, node.body_sha256); assert.equal(body.bytes, node.bytes);
      assert.equal(hash(node.content), body.sha256); assert.equal(Buffer.byteLength(node.content), body.bytes);
      const main = manifest.files.find(file => file.path === manifest.entrypoint);
      assert.equal(main?.sha256, body.sha256); assert.equal(main?.bytes, body.bytes);
      assert.ok(['entry_ready', 'all_files_ready'].includes(entry.materialization?.status));
      assert.ok(entry.materialization.paths.includes(node.path));
      assert.equal(entry.projection?.status, 'identity'); assert.equal(entry.projection.compiler, 'source-identity/v1');
      assert.equal(entry.projection.source_body_sha256, body.sha256); assert.equal(entry.projection.projection_sha256, body.sha256);
      assert.equal(entry.projection.bytes, body.bytes);
      entries.push({ ...observed, evidence: 'consume.entries', manifest, value: {
        record: manifest.record, scope: manifest.scope, snapshot_id: manifest.snapshot_id, version_id: manifest.version_id,
        path: body.path, ref: body.ref, content: node.content, bytes: body.bytes, sha256: body.sha256,
        file_bindings: manifest.file_bindings, range: body.range, has_more: body.has_more,
      } });
    }
  }
  return { directories, preparations, entries, resources };
}

/** A subscriber sees the actual SDK result and its matching completed metrics.
 * Nothing is supplied to the SDK, model, or consumer cache by this observer. */
export function observeGraphSdk({ channel, fs, paths, safeMetrics, processInfo = process }) {
  const pending = new Map();
  const record = value => fs.appendFileSync(paths.ledger, JSON.stringify({ ...value, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  const fail = (reason, id) => record({ phase: 'sdk-observer-error', reason, requestId: id });
  const metrics = event => {
    if (event.version !== 1 || typeof event.id !== 'string') { fail('invalid sdk event', event.id); return; }
    if (event.event === 'start') {
      if (pending.has(event.id)) { fail('duplicate sdk start', event.id); return; }
      pending.set(event.id, { operation: event.operation });
      record({ phase: 'sdk-start', transport: 'sdk', requestId: event.id, operation: event.operation, pid: event.pid, monotonic_ns: event.monotonic_ns });
      return;
    }
    if (event.event !== 'end') { fail('unknown sdk event', event.id); return; }
    const started = pending.get(event.id);
    if (!started || started.operation !== event.operation) { fail('sdk end has no matching start', event.id); return; }
    pending.delete(event.id);
    const measured = safeMetrics(event.request_metrics) ?? null;
    const receipt = { version: 2, transport: 'sdk', requestId: event.id, operation: event.operation, status: event.status,
      value: started.value ?? null, resultObserved: started.resultObserved === true, metrics: measured,
      ...(started.outputEvidence ? { outputEvidence: started.outputEvidence } : {}),
      elapsed_ms: event.elapsed_ms, sdk_started: event.sdk_started, metrics_observed: event.metrics_observed };
    const file = event.id + '.json';
    fs.writeFileSync(paths.responses + '/' + file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    record({ phase: 'sdk-end', transport: 'sdk', requestId: event.id, operation: event.operation, pid: event.pid,
      status: event.status, responseFile: file, metricsComplete: measured?.complete === true, resultObserved: receipt.resultObserved,
      monotonic_ns: event.monotonic_ns });
  };
  const result = event => {
    const started = pending.get(event.id);
    if (event.version !== 1 || !started || started.operation !== event.operation || started.resultObserved) {
      fail('sdk result has no unique matching start', event.id); return;
    }
    started.value = JSON.parse(JSON.stringify(event.value)); started.resultObserved = true;
    if (event.operation === 'read' && typeof event.value?.output === 'string') {
      const root = fs.realpathSync(paths.outputRoot), output = fs.realpathSync(event.value.output);
      if (!output.startsWith(root + '/') || fs.lstatSync(event.value.output).isSymbolicLink() || !fs.statSync(output).isFile()) {
        fail('SDK output escaped the owned Broker cache', event.id); return;
      }
      const bytes = fs.readFileSync(output), sha256 = hash(bytes);
      if (bytes.length !== event.value.bytes || sha256 !== event.value.sha256) { fail('SDK output bytes differ from its returned proof', event.id); return; }
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { /* Binary is retained by its source proof, never treated as text. */ }
      started.outputEvidence = { path: output, bytes: bytes.length, sha256, ...(content === undefined ? {} : { content }), observation: 'after SDK output completed, before host materialization; not an extra source request' };
    }
  };
  channel('context-broker.notion-sdk').subscribe(metrics);
  channel('context-broker.notion-sdk-result').subscribe(result);
  record({ phase: 'sdk-observer-start', pid: processInfo.pid, channels: ['context-broker.notion-sdk', 'context-broker.notion-sdk-result'] });
  return { close() {
    record({ phase: 'sdk-observer-end', pid: processInfo.pid, pending: pending.size });
    channel('context-broker.notion-sdk').unsubscribe(metrics); channel('context-broker.notion-sdk-result').unsubscribe(result);
  } };
}

export function observeGraphChildren({ childProcess, syncBuiltinESMExports, fs, ledger, cliEntries }) {
  const original = childProcess.spawn;
  let next = 0;
  const active = new Set();
  const record = value => fs.appendFileSync(ledger, JSON.stringify({ ...value, observerPid: process.pid, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  const isSource = (command, args) => cliEntries.includes(command) || String(command).split('/').at(-1) === 'ntn-skills'
    || args.some(value => cliEntries.includes(value));
  childProcess.spawn = function(...args) {
    const id = process.pid + ':' + ++next, argv = Array.isArray(args[1]) ? args[1] : [];
    const source = isSource(args[0], argv);
    const operation = source ? argv.find(value => ['list', 'views', 'ctl', 'prepare', 'use', 'read', 'files', 'export'].includes(value)) ?? 'unknown' : null;
    const child = original.apply(this, args);
    active.add(id);
    record({ phase: 'child-spawn', id, pid: child.pid ?? null, source, operation, executable: args[0] });
    child.once('error', error => record({ phase: 'child-error', id, code: error.code ?? 'UNKNOWN' }));
    child.once('close', (code, signal) => { active.delete(id); record({ phase: 'child-close', id, pid: child.pid ?? null, code, signal }); });
    return child;
  };
  const alternate = new Map();
  for (const name of ['exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']) {
    alternate.set(name, childProcess[name]);
    childProcess[name] = function(...args) {
      record({ phase: 'alternate-child-api', api: name, source: isSource(args[0], Array.isArray(args[1]) ? args[1] : []) });
      return alternate.get(name).apply(this, args);
    };
  }
  syncBuiltinESMExports();
  record({ phase: 'child-observer-start' });
  return { close() {
    record({ phase: 'child-observer-end', pending: active.size });
    childProcess.spawn = original;
    for (const [name, method] of alternate) childProcess[name] = method;
    syncBuiltinESMExports();
  } };
}

export function graphSourceAccounting(events, receipts, { sourceMode, requireConsumption = false }) {
  const observed = events.filter(event => event.phase === 'sdk-observer-start');
  assert.ok(observed.length > 0, 'A missing source observer cannot imply zero requests');
  assert.ok(!events.some(event => event.phase === 'sdk-observer-error'), 'SDK observation is incomplete or inconsistent');
  for (const start of observed) {
    const ends = events.filter(event => event.phase === 'sdk-observer-end' && event.pid === start.pid);
    assert.equal(ends.length, 1, 'Every source observer must close'); assert.equal(ends[0].pending, 0);
  }
  for (const start of events.filter(event => event.phase === 'sdk-start')) {
    const ends = events.filter(event => event.phase === 'sdk-end' && event.requestId === start.requestId);
    const captured = receipts.filter(receipt => receipt.transport === 'sdk' && receipt.requestId === start.requestId);
    assert.equal(ends.length, 1, 'Every SDK operation must finish'); assert.equal(captured.length, 1, 'Every SDK result must have one raw receipt');
    assert.equal(captured[0].operation, start.operation); assert.equal(captured[0].metrics?.complete, true, 'SDK HTTP metrics must be complete');
    if (captured[0].status === 'completed') assert.equal(captured[0].resultObserved, true, 'SDK success without its actual return value is not evidence');
  }
  for (const start of events.filter(event => event.phase === 'child-spawn')) assert.equal(events.filter(event => event.phase === 'child-close' && event.id === start.id).length, 1, 'Every observed child must close');
  const sdk = receipts.filter(receipt => receipt.transport === 'sdk');
  const sdkOperations = ['list', 'files', 'consume', 'read', 'read-resources'];
  assert.ok(sdk.every(receipt => sdkOperations.includes(receipt.operation)), 'Unknown SDK operation cannot disappear from source accounting');
  const childCalls = events.filter(event => (event.phase === 'child-spawn' || event.phase === 'alternate-child-api') && event.source);
  if (sourceMode === 'sdk') {
    assert.equal(childCalls.length, 0, 'Default bundled SDK cannot silently invoke a CLI child');
    assert.equal(receipts.filter(receipt => receipt.transport !== 'sdk').length, 0, 'Default SDK cannot borrow command receipts');
    assert.ok(sdk.some(receipt => receipt.operation === 'list'), 'Default metadata must actually use the catalog SDK');
    if (requireConsumption) assert.ok(sdk.some(receipt => receipt.operation === 'consume'), 'The real consumer must reach the bundled SDK');
  }
  return { sourceMode, sdk_calls: Object.fromEntries(sdkOperations.map(operation => [operation, sdk.filter(receipt => receipt.operation === operation).length])),
    cli_children: childCalls.length, actual_http_attempts: receipts.every(receipt => receipt.metrics?.complete)
      ? receipts.reduce((sum, receipt) => sum + receipt.metrics.trace.filter(event => event.event === 'attempt').length, 0) : null,
    source_results_observed: sdk.filter(receipt => receipt.resultObserved).length };
}
