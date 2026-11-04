import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { observeConsumptionCost, consumptionCostExtensionSource, readConsumptionCostEvents, freezeConsumptionPlan,
  summarizeConsumptionSource, summarizeConsumptionSample, consumptionMetricStats, compareConsumptionRuns } from './skill-consumption-cost.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = fs.mkdtempSync(path.join(tmpdir(), 'skill-cost-test-'));
after(() => { if (fs.existsSync('/usr/bin/trash')) execFileSync('/usr/bin/trash', [scratch]); });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
let serial = 0;
const output = () => path.join(scratch, 'events-' + ++serial + '.jsonl');
const conditions = Object.fromEntries(['prompt', 'model', 'modelParameters', 'data', 'package', 'freshness', 'network', 'tools', 'observer'].map(key => [key + 'Sha256', sha(key)]));
Object.assign(conditions, { nodeVersion: '24.20.0', piVersion: '1.4.0' });
const scenario = { id: 'a', cache: 'cold', cacheSha256: sha('empty-cache'), session: 'new', entry: 'ordinary-input', intent: 'answer' };
const outcome = { status: 'passed', taskVerified: true, assertionsSha256: sha('assertions'),
  providerCapture: { verified: true, method: 'last-hook', evidenceSha256: sha('extension-order') } };
const reportedUsage = { input: 120, output: 9, cacheRead: 20, cacheWrite: 5, totalTokens: 154,
  reasoning: 2, cost: { input: 0.1, output: 0.02, cacheRead: 0.01, cacheWrite: 0.01, total: 0.14 } };
const attempt = (number, kind = 'notion_metadata', fields = {}) => ({ event: 'attempt', attempt: number, kind,
  method: 'GET', target: null, body_kind: null, started_ms: number * 10, duration_ms: 8,
  outcome: 'success', request_bytes: 11, response_bytes: 101, http_status: 200,
  request_id: 'https://private.invalid/sk-secret', rate_limit_reason: null, retry_after_seconds: null, ...fields });
const receipt = (id, trace, fields = {}) => ({ id, operationId: id, execution: 'cli', purpose: 'foreground', started: true, closed: true,
  requestMetrics: { trace_enabled: true, total_requests: trace.filter(row => row.event === 'attempt').length, trace_dropped: 0, trace }, ...fields });
const source = () => ({ coverage: { complete: true, truncated: false, evidenceSha256: sha('independent-inventory'),
  dimensions: ['notion', 'attachments', 'prefetch', 'retries', 'other-http', 'model-http'], modelMode: 'controlled',
  receiptIds: ['content', 'prefetch'], prefetchReceiptIds: ['prefetch'], attachmentAttempts: ['content:2'], modelAttempts: [], otherProviderAttempts: [] },
  receipts: [receipt('content', [attempt(1, 'notion_body', { body_kind: 'current_body', outcome: 'failure', http_status: 429, retry_after_seconds: 0.023 }),
    { event: 'wait', kind: 'queue', milliseconds: 19 }, { event: 'wait', kind: 'retry', milliseconds: 23 }, attempt(2, 'provider')]),
  receipt('prefetch', [attempt(1)], { purpose: 'prefetch', execution: 'sdk' })] });

async function observe({ final = 'Task completed with the requested answer.', usage = reportedUsage, payload = { messages: [{ role: 'user', content: 'task' }], tools: [] },
  tool = false, ioFailure = false } = {}) {
  const handlers = new Map(), mutations = [], file = output();
  const api = new Proxy({ on: (name, callback) => handlers.set(name, callback) }, { get(target, key) {
    if (key !== 'on') { mutations.push(String(key)); throw new Error('Observer accessed a non-observation API'); }
    return target[key];
  } });
  let clock = 1000000000n;
  const io = ioFailure ? { ...fs, writeSync: (...args) => {
    if (JSON.parse(args[1]).phase === 'provider_request') throw new Error('disk unavailable https://secret.invalid/token');
    return fs.writeSync(...args);
  } } : fs;
  const observer = observeConsumptionCost(api, { fs: io, crypto, path, output: file, checkoutRoot: root,
    runId: 'run', sampleId: 'a', clockId: 'host-boot', clock: () => (clock += 1000000n) });
  const emit = (name, event = {}) => {
    const before = copy(event); deepFreeze(event);
    assert.equal(handlers.get(name)(event), undefined, name + ' must not replace/block a hook value');
    assert.deepEqual(event, before, name + ' mutated caller data');
  };
  const submission = { promptSha256: conditions.promptSha256, monotonicNs: clock.toString(), clockId: 'host-boot', evidenceSha256: sha('driver-original-prompt-and-submit') };
  emit('input', { text: 'secret-value https://secret.invalid/path?token=hidden', images: [{ data: 'PRIVATE_IMAGE' }], source: 'rpc' });
  emit('agent_start');
  const body = 'private skill <body> bytes', content = '<body>' + body + '</body>';
  const messages = [{ role: 'system', content: 'system' }, { role: 'custom', content,
    details: { records: [{ bodySha256: sha(body), bytes: Buffer.byteLength(body), delivery: { start: 6, end: 6 + body.length, encoding: 'raw' } }] } }];
  emit('context', { messages }); emit('context_with_system', { messages });
  emit('before_provider_request', { payload }); emit('after_provider_response', { status: 200, headers: { authorization: 'Bearer secret-value' } });
  if (tool) {
    emit('tool_call', { toolCallId: 'call-secret', toolName: 'read', input: { path: 'https://secret.invalid/file' } });
    emit('tool_result', { toolCallId: 'call-secret', toolName: 'read', content: [{ type: 'text', text: 'secret tool result' }], isError: false });
  }
  const assistant = { role: 'assistant', content: [{ type: 'text', text: final }], usage, stopReason: 'stop' };
  emit('message_update', { message: assistant, assistantMessageEvent: { type: 'text_delta', delta: '  ' } });
  emit('message_update', { message: assistant, assistantMessageEvent: { type: 'text_delta', delta: final } });
  emit('message_end', { message: assistant }); emit('agent_end', { messages: [assistant] }); emit('session_shutdown');
  assert.equal(observer.status().closed, true); assert.deepEqual(mutations, []);
  const observed = await readConsumptionCostEvents(file);
  return { ...observed, file, submission };
}
const sample = (observed, overrides = {}) => summarizeConsumptionSample({ id: 'a', scenario, conditions,
  events: observed.events, submission: observed.submission, source: source(), outcome, ...overrides });
const run = samples => ({ plan: freezeConsumptionPlan({ conditions, samples: samples.map(item => item.scenario) }), samples });

test('observing real hook shapes is neutral, private, byte-exact, and uses actual usage', async () => {
  const payload = { messages: [{ content: '<ntn-skills-view-catalog>目录</ntn-skills-view-catalog> https://secret.invalid/path?token=hidden' }],
    tools: [{ name: 'read', parameters: { key: 'secret-value' } }], arbitraryPrivateKey: 'Bearer secret-value' };
  const observed = await observe({ payload, tool: true });
  assert.equal(fs.statSync(observed.file).mode & 0o777, 0o600);
  const raw = fs.readFileSync(observed.file, 'utf8');
  for (const secret of ['secret-value', 'secret.invalid', 'PRIVATE_IMAGE', 'arbitraryPrivateKey', 'call-secret', 'secret tool result']) assert.ok(!raw.includes(secret), secret);
  const request = observed.events.find(event => event.phase === 'provider_request');
  assert.equal(request.payload.bytes, Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(request.payload.sha256, sha(JSON.stringify(payload)));
  assert.equal(request.payload.wireBytes, null);
  assert.equal(request.payload.tokens, null);
  assert.equal(request.payload.diagnosticSpans.filter(item => item.kind === 'catalog').length, 1);
  assert.equal(request.payload.components.reduce((total, item) => total + item.bytes, request.payload.jsonStructureBytes), request.payload.bytes);
  const result = sample(observed);
  assert.equal(result.valid, true, result.errors.join(','));
  assert.equal(result.costs.input, 120); assert.equal(result.costs.output, 9); assert.equal(result.costs.totalTokens, 154);
  assert.equal(result.costs.knownUsageRequests, 1); assert.equal(result.costs.toolCalls, 1);
  assert.ok(result.costs.timings.submitToFirstEffectiveTextMs > result.costs.timings.submitToFirstProviderMs);
  assert.equal(result.costs.transport.wireBytes, null);
});

test('the serialized extension is self-contained and neither returns a policy nor needs the checkout at runtime', async () => {
  const file = output(), extension = path.join(scratch, 'owned-observer.mjs'), handlers = new Map();
  fs.writeFileSync(extension, consumptionCostExtensionSource({ output: file, checkoutRoot: root, runId: 'run', sampleId: 'a', clockId: 'host-boot' }), { mode: 0o600 });
  const module = await import(pathToFileURL(extension).href);
  assert.equal(module.default({ on: (name, callback) => handlers.set(name, callback) }), undefined);
  handlers.get('session_shutdown')({});
  assert.equal((await readConsumptionCostEvents(file)).events.at(-1).complete, true);
  assert.throws(() => consumptionCostExtensionSource({ output: file, apiKey: 'secret' }), /SETTINGS_INVALID/);
  assert.throws(() => observeConsumptionCost({ on() {} }, { fs, crypto, path, output: path.join(root, 'forbidden-evidence.jsonl'), checkoutRoot: root,
    runId: 'run', sampleId: 'a', clockId: 'host-boot' }), /OUTSIDE_CHECKOUT/);
});

test('observer I/O failure preserves product behavior and invalidates the evidence', async () => {
  const observed = await observe({ ioFailure: true });
  const result = sample(observed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('COST_OBSERVER_FAILED'));
  assert.ok(!fs.readFileSync(observed.file, 'utf8').includes('secret.invalid'));
});

test('all-zero provider usage stays unknown, and p95 is not invented for small samples', async () => {
  const observed = await observe({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } });
  const result = sample(observed);
  assert.equal(result.valid, true); assert.equal(result.costs.input, null); assert.equal(result.costs.totalTokens, null);
  assert.equal(result.costs.unknownUsageRequests, 1);
  assert.equal(consumptionMetricStats(Array.from({ length: 19 }, (_, index) => index + 1)).p95, null);
  assert.equal(consumptionMetricStats(Array.from({ length: 20 }, (_, index) => index + 1)).p95, 19);
  assert.deepEqual(consumptionMetricStats([1, null, 5]).values, [1, null, 5]);
  assert.equal(consumptionMetricStats([1, null, 5]).median, 3);
});

test('source receipts retain attempts, waits, decoded bytes, failures and prefetch without leaking labels', () => {
  const result = summarizeConsumptionSource(source());
  assert.equal(result.valid, true, result.errors.join(','));
  assert.equal(result.costs.httpAttempts, 3); assert.equal(result.costs.failedHttpAttempts, 1);
  assert.equal(result.costs.logicalOperations, 2); assert.equal(result.costs.cliStarts, 1); assert.equal(result.costs.sdkCalls, 1);
  assert.equal(result.costs.queueWaitMs, 19); assert.equal(result.costs.retryWaitMs, 23);
  assert.equal(result.costs.decodedResponseBytes, 303); assert.equal(result.costs.attachmentDecodedBytes, 101);
  assert.equal(result.costs.prefetchHttpAttempts, 1); assert.equal(result.costs.modelHttpAttempts, 0);
  assert.equal(result.costs.trace.length, 5); assert.equal(result.costs.wireBytes, null);
  assert.ok(!JSON.stringify(result).includes('private.invalid'));
  const unknown = source(); unknown.receipts[0].requestMetrics.trace[0].response_bytes = null;
  assert.equal(summarizeConsumptionSource(unknown).costs.decodedResponseBytes, null);
});

test('missing attachments, prefetch, retries, failed operations or truncated receipts reject comparison', () => {
  const fixtures = [
    value => { delete value.coverage.attachmentAttempts; },
    value => { value.coverage.attachmentAttempts = []; },
    value => { delete value.coverage.prefetchReceiptIds; },
    value => { value.receipts.pop(); },
    value => { value.receipts[0].requestMetrics.trace.shift(); },
    value => { value.receipts[0].requestMetrics.trace_dropped = 1; },
    value => { value.coverage.dimensions = value.coverage.dimensions.filter(item => item !== 'retries'); },
    value => { value.coverage.truncated = true; },
    value => { value.receipts[0].closed = false; },
  ];
  for (const mutate of fixtures) { const value = source(); mutate(value); assert.equal(summarizeConsumptionSource(value).valid, false); }
});

test('partial evidence remains available for baseline diagnosis while comparisons reject its cost claim', async () => {
  const observed = await observe(), missingCoverage = source(); delete missingCoverage.coverage;
  const partial = sample(observed, { source: missingCoverage });
  assert.equal(partial.valid, false); assert.equal(partial.costs.input, 120);
  assert.equal(partial.costs.transport.httpAttempts, 3); assert.equal(partial.costs.transport.retryWaitMs, 23);
  assert.equal(partial.costs.transport.complete, false);
  const result = compareConsumptionRuns({ baseline: run([partial]), candidate: run([partial]) });
  assert.equal(result.status, 'rejected'); assert.equal(result.baseline.costs.input.observed, 1);
  assert.equal(result.baseline.transport.httpAttempts.median, 3); assert.equal(result.baseline.incompleteSamples, 1);
  const truncated = source(); truncated.receipts[0].requestMetrics.trace_dropped = 1;
  assert.equal(summarizeConsumptionSource(truncated).costs.httpAttempts, 3);
});

test('plans describe the complete cache and session matrix without pretending it was executed', () => {
  const samples = ['cold', 'warm', 'expired-unchanged', 'expired-changed', 'partial'].flatMap(cache =>
    ['new', 'existing', 'restart', 'resume', 'fork', 'rewind', 'compacted'].map(session => ({ ...scenario, id: cache + '-' + session, cache, session })));
  const plan = freezeConsumptionPlan({ conditions, samples });
  assert.equal(plan.samples.length, 35);
  const incomplete = compareConsumptionRuns({ baseline: { plan, samples: [] }, candidate: { plan, samples: [] } });
  assert.equal(incomplete.status, 'rejected'); assert.equal(incomplete.baseline.planned, 35); assert.equal(incomplete.baseline.n, 0);
});

test('missing event rows, incomplete JSONL, unproven last-hook position and HTTP coverage cannot pass', async () => {
  const observed = await observe();
  const missing = copy(observed); missing.events.splice(3, 1);
  assert.ok(sample(missing).errors.includes('COST_TRACE_CHAIN_INVALID'));
  const truncatedFile = output(); fs.writeFileSync(truncatedFile, fs.readFileSync(observed.file).subarray(0, -1), { mode: 0o600 });
  await assert.rejects(readConsumptionCostEvents(truncatedFile), /COST_TRACE_TRUNCATED/);
  assert.ok(sample(observed, { outcome: { ...outcome, providerCapture: undefined } }).errors.includes('COST_PROVIDER_FINALITY_UNPROVEN'));
  const live = source(); live.coverage.modelMode = 'real';
  assert.ok(sample(observed, { source: live }).errors.includes('COST_MODEL_HTTP_ATTEMPTS_MISSING'));
  assert.ok(sample(observed, { submission: { ...observed.submission, clockId: 'other-machine' } }).errors.includes('COST_SUBMISSION_RECEIPT_MISSING'));
});

test('empty final and permission-only text never become task success from exit status or asserted success', async () => {
  for (const final of ['', 'Please approve this action before I can continue.', '请先授权后我才能继续。']) {
    const result = sample(await observe({ final }));
    assert.equal(result.valid, false); assert.ok(result.errors.includes('COST_TASK_SUCCESS_UNPROVEN'));
  }
  const result = sample(await observe(), { outcome: { ...outcome, taskVerified: false } });
  assert.equal(result.valid, false);
});

test('a frozen paired plan retains failed samples and refuses mismatched model, freshness, cache or undeclared packages', async () => {
  const good = sample(await observe()), failed = { ...copy(good), id: 'b', scenario: { ...scenario, id: 'b' }, status: 'failed' };
  const baseline = run([good, failed]), candidate = copy(baseline);
  const comparable = compareConsumptionRuns({ baseline, candidate });
  assert.equal(comparable.status, 'comparable'); assert.equal(comparable.baseline.n, 2); assert.equal(comparable.baseline.outcomes.failed, 1);
  assert.equal(comparable.baseline.costs.input.n, 2); assert.equal(comparable.baseline.costs.input.values.length, 2);
  const removed = copy(candidate); removed.samples.pop();
  assert.ok(compareConsumptionRuns({ baseline, candidate: removed }).errors.includes('COST_PLANNED_SAMPLE_MISSING_OR_REORDERED'));
  for (const key of ['modelSha256', 'freshnessSha256', 'packageSha256']) {
    const changed = copy(candidate); changed.plan.conditions[key] = sha('different');
    changed.samples.forEach(item => { item.conditions[key] = sha('different'); });
    changed.plan = freezeConsumptionPlan(changed.plan);
    assert.ok(compareConsumptionRuns({ baseline, candidate: changed }).errors.includes('COST_NON_EQUIVALENT_' + key));
  }
  const warm = copy(candidate); warm.plan.samples[0].cache = 'warm'; warm.samples[0].scenario.cache = 'warm'; warm.plan = freezeConsumptionPlan(warm.plan);
  assert.ok(compareConsumptionRuns({ baseline, candidate: warm }).errors.includes('COST_NON_EQUIVALENT_SCENARIOS'));
});

test('shrinking only the first request cannot conceal more tool rounds or higher total task bytes', async () => {
  const baseline = run([sample(await observe())]), candidate = copy(baseline);
  candidate.samples[0].costs.firstProviderPayloadJsonBytes--;
  candidate.samples[0].costs.providerPayloadJsonBytes += 500;
  candidate.samples[0].costs.toolRounds++;
  const result = compareConsumptionRuns({ baseline, candidate });
  assert.equal(result.status, 'rejected'); assert.equal(result.regressions[0].code, 'COST_FIRST_REQUEST_ONLY_IMPROVEMENT');
  const failed = copy(baseline); failed.samples[0].status = 'failed';
  assert.ok(compareConsumptionRuns({ baseline, candidate: failed }).regressions.some(item => item.code === 'COST_TASK_SUCCESS_REGRESSION'));
});
