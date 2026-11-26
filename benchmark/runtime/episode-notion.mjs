import assert from 'node:assert/strict';
import diagnostics from 'node:diagnostics_channel';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { errorMonitor } from 'node:events';
import { observeSourceTransport, readSourceObservation } from '../../scripts/skill-consumption-source-observer.mjs';
import { catalogFacets, observeGraphSdk } from '../../scripts/notion-skill-graph-model-evidence.mjs';
import { safeRequestMetrics } from '../../scripts/notion-default-context.mjs';
import { canonical } from './episode-evidence.mjs';

const metricChannel = 'context-broker.notion-sdk';
const resultChannel = 'context-broker.notion-sdk-result';
const operationsAllowed = new Set(['library-selection', 'library', 'list', 'files', 'consume', 'read', 'read-resources', 'resolve', 'content-search']);
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id);

const currentViewDirectory = value => validId(value.library_id) && value.coverage?.method === 'explicit_view'
  && value.view !== null && typeof value.view === 'object' && !Array.isArray(value.view) && validId(value.view.id);

/** Public listCatalog can return both projections or a single selected View.
 * Cache delivery and an explicit refresh are observations of that same metadata;
 * freshness bounds, staleness, identities, versions and query semantics stay. */
export function stableNotionCatalog(value) {
  return catalogFacets(value).map(outcome => {
    if (!outcome.ok) return structuredClone(outcome);
    const copy = structuredClone(outcome.value);
    const facet = outcome.facet === 'flat' && currentViewDirectory(copy) ? 'directory' : outcome.facet;
    delete copy.fetched_at;
    delete copy.request_metrics;
    if (copy.freshness) {
      delete copy.freshness.validated_at;
      delete copy.freshness.age_ms;
    }
    // Current SDK source and refresh/default policy identify how this metadata
    // was obtained, not its content. Keep offline/pinned/max_age and unknown
    // values visible, and retain the exact raw observation in every SDK receipt.
    if (validId(copy.library_id) && (facet === 'catalog' || facet === 'directory')) {
      if (copy.source === 'notion' || copy.source === 'local_cache') delete copy.source;
      if (copy.freshness?.policy === 'default' || copy.freshness?.policy === 'refresh') delete copy.freshness.policy;
    }
    // The service allocates a new directory query handle and expiry on each
    // invocation. Keep view identity, query semantics, counts and pagination.
    if (facet === 'directory' && copy.view_query && typeof copy.view_query === 'object' && !Array.isArray(copy.view_query)) {
      delete copy.view_query.id;
      delete copy.view_query.expires_at;
    }
    return { ...outcome, facet, value: copy };
  });
}

/** Passive public SDK diagnostics and maintained HTTP/source observers. There is
 * no transport replacement, extra source fetch, or inference of tool consumption. */
export function observeEpisodeNotion({ config, recorder, context = () => ({ stage: 'prepare', active_tool_call_ids: [] }) }) {
  const paths = {
    source: path.join(config.controlDir, 'notion-source.jsonl'),
    ledger: path.join(config.controlDir, 'notion-sdk.jsonl'),
    responses: path.join(config.controlDir, 'notion-responses'),
    outputRoot: config.runRoot,
  };
  fs.mkdirSync(paths.responses, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.ledger, '', { flag: 'wx', mode: 0o600 });
  const operations = new Map(), callbacks = new Map(), idleWaiters = new Set();
  let errors = 0, closed = false, lastActivity = performance.now(), source, graph, finished;
  const fail = (channel, error) => {
    errors++;
    try { recorder.record('notion_observer_error', { channel, message: String(error?.message ?? error) }); } catch {}
  };
  const guarded = (name, callback) => {
    const wrapped = event => {
      if (closed) return;
      try { callback(name === metricChannel || name === resultChannel ? recorder.scrub(event) : event); }
      catch (error) { fail(name, error); }
      finally { for (const check of idleWaiters) check(); }
    };
    callbacks.set(callback, wrapped); return wrapped;
  };
  const subscribe = (name, callback) => diagnostics.subscribe(name, guarded(name, callback));
  const unsubscribe = (name, callback) => { const wrapped = callbacks.get(callback); if (wrapped) diagnostics.unsubscribe(name, wrapped); callbacks.delete(callback); };
  const channel = name => ({ subscribe: callback => subscribe(name, callback), unsubscribe: callback => unsubscribe(name, callback) });
  const scrubJSON = text => {
    const original = JSON.parse(text), clean = recorder.scrub(original);
    if (JSON.stringify(original) !== JSON.stringify(clean)) recorder.record('notion_evidence_redaction', { scope: 'SDK artifact', original_content_hashes_are_retained: true });
    return JSON.stringify(clean) + '\n';
  };
  const graphFs = { ...fs,
    appendFileSync(file, text, options) { return fs.appendFileSync(file, scrubJSON(text), options); },
    writeFileSync(file, text, options) { return fs.writeFileSync(file, scrubJSON(text), options); },
  };
  const metrics = event => {
    assert.equal(event.version, 1); assert.ok(validId(event.id) && operationsAllowed.has(event.operation));
    lastActivity = performance.now();
    if (event.event === 'start') {
      assert.ok(!operations.has(event.id), 'BENCHMARK_NOTION_DUPLICATE_START');
      const observedContext = structuredClone(context());
      const operation = { operation_id: event.id, source_request_id: 'sdk:' + event.pid + ':' + event.id,
        operation: event.operation, source_id: event.source_id ?? null, library: event.library ?? null,
        ...observedContext, tool_call_id: null, tool_association: 'active calls are temporal context; causal tool binding requires returned source proof',
        status: 'pending', result_observed: false };
      operation.start_ref = recorder.record('notion_sdk_event', { ...operation, event });
      operations.set(event.id, operation); return;
    }
    assert.equal(event.event, 'end');
    const operation = operations.get(event.id);
    assert.ok(operation && operation.operation === event.operation && operation.status === 'pending', 'BENCHMARK_NOTION_UNPAIRED_END');
    operation.status = event.status;
    operation.metrics = event.metrics_observed ? safeRequestMetrics(event.request_metrics) ?? null : null;
    operation.end_ref = recorder.record('notion_sdk_event', {
      operation_id: event.id, source_request_id: operation.source_request_id,
      stage: operation.stage, active_tool_call_ids: operation.active_tool_call_ids, event,
    });
  };
  const result = event => {
    const operation = operations.get(event.id);
    assert.ok(event.version === 1 && operation && operation.status === 'pending' && operation.operation === event.operation && !operation.result_observed,
      'BENCHMARK_NOTION_UNPAIRED_RESULT');
    lastActivity = performance.now();
    operation.result_observed = true;
    operation.value = structuredClone(event.value);
    operation.result_ref = recorder.record('notion_sdk_result', {
      operation_id: event.id, source_request_id: operation.source_request_id,
      stage: operation.stage, active_tool_call_ids: operation.active_tool_call_ids, event,
    });
  };
  try {
    source = observeSourceTransport({ diagnostics: { subscribe, unsubscribe }, fs, crypto, path, errorMonitor,
      output: paths.source, checkoutRoot: path.join(config.runRoot, 'subject-runtime'),
      clockId: config.correlation.episode_id, cliPath: process.env.PAIRED_CLI_ENTRY,
      safeRequestMetrics: value => { const decoded = safeRequestMetrics(value); return decoded && recorder.scrub(decoded); },
    });
    graph = observeGraphSdk({ channel, fs: graphFs, paths, safeMetrics: value => safeRequestMetrics(value), processInfo: process });
    subscribe(metricChannel, metrics); subscribe(resultChannel, result);
  } catch (error) {
    graph?.close(); source?.finish();
    for (const name of [metricChannel, resultChannel]) for (const wrapped of callbacks.values()) diagnostics.unsubscribe(name, wrapped);
    throw error;
  }
  const pending = () => [...operations.values()].filter(operation => operation.status === 'pending');
  return {
    paths,
    waitIdle(timeoutMs = null, { signal } = {}) {
      assert.ok(timeoutMs === null || Number.isFinite(timeoutMs) && timeoutMs >= 0, 'BENCHMARK_NOTION_IDLE_TIMEOUT_INVALID');
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        let timeout, quiet;
        const finish = (value, error) => {
          clearTimeout(timeout); clearTimeout(quiet); idleWaiters.delete(check);
          signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(value);
        };
        const abort = () => finish(false, signal.reason ?? new Error('BENCHMARK_NOTION_IDLE_CANCELLED'));
        const check = () => {
          clearTimeout(quiet);
          if (errors) return finish(false, new Error('BENCHMARK_NOTION_OBSERVER_ERROR'));
          if (closed) return finish(pending().length === 0);
          if (pending().length) return;
          // Retain the short diagnostic quiet window, not a startup deadline.
          const remaining = 25 - (performance.now() - lastActivity);
          if (remaining > 0) quiet = setTimeout(check, remaining);
          else finish(true);
        };
        if (timeoutMs !== null) timeout = setTimeout(() => finish(false), timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        idleWaiters.add(check); check();
      });
    },
    candidate(sources = []) {
      const selected = new Map(), evidence = [];
      for (const operation of operations.values()) {
        if (operation.operation !== 'list' || operation.status !== 'completed' || !operation.result_observed) continue;
        const facets = stableNotionCatalog(operation.value);
        const key = JSON.stringify(canonical([operation.source_id, operation.library]));
        const previous = selected.get(key);
        const merged = new Map((previous?.facets ?? []).map(facet => [facet.facet, facet]));
        for (const facet of facets) merged.set(facet.facet, facet);
        selected.set(key, { source_id: operation.source_id, library: operation.library,
          facets: [...merged.values()].sort((a, b) => a.facet.localeCompare(b.facet)),
        });
        evidence.push({ operation_id: operation.operation_id, start_ref: operation.start_ref, end_ref: operation.end_ref, result_ref: operation.result_ref });
      }
      const catalogs = [...selected.values()].sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))));
      const required = sources.filter(source => source.type === 'notion' && source.enabled !== false);
      for (const source of required) {
        const matching = catalogs.filter(catalog => catalog.source_id === source.id);
        assert.ok(matching.length > 0 && matching.every(catalog => catalog.facets.every(facet => facet.ok)), 'BENCHMARK_NOTION_CATALOG_UNAVAILABLE: ' + source.id);
      }
      assert.equal(errors, 0, 'BENCHMARK_NOTION_OBSERVER_ERROR');
      assert.equal(pending().length, 0, 'BENCHMARK_NOTION_STARTUP_PENDING');
      return { projection: { observed: catalogs.length > 0, catalogs }, evidence,
        scope: 'actual SDK catalog metadata; body delivery and deferred tool availability are established separately by final payload and tool/session results' };
    },
    async finish() {
      if (finished) return finished;
      try { graph.close(); } catch (error) { fail('graph-close', error); }
      source.finish();
      unsubscribe(metricChannel, metrics); unsubscribe(resultChannel, result);
      for (const name of [metricChannel, resultChannel, 'tracing:child_process.spawn:start', 'tracing:child_process.spawn:error'])
        for (const wrapped of callbacks.values()) diagnostics.unsubscribe(name, wrapped);
      callbacks.clear(); closed = true;
      for (const check of idleWaiters) check();
      const observed = await readSourceObservation(paths.source);
      await recorder.addArtifact('notion-source', paths.source, 'jsonl');
      await recorder.addArtifact('notion-sdk', paths.ledger, 'jsonl');
      const ledger = fs.readFileSync(paths.ledger, 'utf8').trimEnd().split('\n').map(JSON.parse);
      const receipts = new Map(), own = [];
      for (const name of fs.readdirSync(paths.responses).sort()) {
        assert.match(name, /^[a-f0-9-]{36}\.json$/i);
        const id = name.slice(0, -5), artifactId = 'notion-response-' + id, file = path.join(paths.responses, name);
        const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(receipt.requestId, id);
        await recorder.addArtifact(artifactId, file, 'notion-sdk-receipt');
        receipts.set(id, { value: receipt, ref: { artifact_id: artifactId, pointer: '' } });
      }
      for (const operation of operations.values()) {
        const { value, metrics, ...item } = operation;
        const receipt = receipts.get(operation.operation_id);
        own.push({ ...item, receipt_ref: receipt?.ref ?? null, metrics_complete: metrics?.complete === true,
          http_attempts: metrics?.complete === true ? metrics.total_requests : null });
      }
      const sdkComplete = errors === 0 && pending().length === 0 && !ledger.some(row => row.phase === 'sdk-observer-error')
        && ledger.at(-1)?.phase === 'sdk-observer-end' && ledger.at(-1)?.pending === 0
        && receipts.size === operations.size && own.every(operation => operation.receipt_ref && operation.end_ref && (operation.status !== 'completed' || operation.result_observed));
      const metricRows = observed.events.filter(row => row.phase === 'metrics');
      const httpComplete = sdkComplete && observed.complete && metricRows.every(row => row.observed && row.complete);
      const terminal = observed.events.at(-1);
      const coverage = { sdk: sdkComplete ? 'complete' : 'partial', owned_http: httpComplete ? 'complete' : 'partial',
        child_lifecycle: observed.unmatchedChildLifecycle?.complete ? 'complete' : 'partial', descendant_transport: 'unobserved' };
      const refs = { source_terminal: terminal?.phase === 'source_observer_end' ? { artifact_id: 'notion-source', line: terminal.sequence } : null,
        sdk_terminal: { artifact_id: 'notion-sdk', line: ledger.length } };
      const ref = recorder.record('notion_observation_end', { coverage, operations: own.length,
        observed_owned_http_attempts: observed.events.filter(row => row.phase === 'attempt' && row.kind === 'http').length,
        errors, source_validation_errors: observed.errors, refs });
      finished = { source_contract: 'notion-sdk-v3/library-root-v1/resource-read-v1/skill-ref-v2/preparation-evidence-v2',
        operations: own, coverage, refs: { ...refs, end: ref },
        source_scope: 'owned Pi SDK operations and directly observed bundled CLI; other descendants transport remains unknown',
        paths: { source: paths.source, sdk: paths.ledger, responses: paths.responses } };
      return finished;
    },
  };
}
