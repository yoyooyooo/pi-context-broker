import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import diagnostics from 'node:diagnostics_channel';
import { randomUUID } from 'node:crypto';
import { createEpisodeRecorder, sha256 } from './episode-evidence.mjs';
import { observeEpisodeNotion, stableNotionCatalog } from './episode-notion.mjs';
import { graphSourceAccounting } from '../../scripts/notion-skill-graph-model-evidence.mjs';

const publish = (name, value) => diagnostics.channel(name).publish(value);
const metricChannel = 'context-broker.notion-sdk', resultChannel = 'context-broker.notion-sdk-result';
const catalog = () => ({ scope: 'scope-actual', fetched_at: '2026-11-22T12:00:00Z',
  records: [{ id: 'stable-skill', name: 'Refund', description: 'Resolve a refund', body_sha256: 'a'.repeat(64) }], databases: [], count: 1,
  freshness: { policy: 'default', validated_at: '2026-11-22T12:00:00Z', age_ms: 0, stale: false, max_age_ms: 300000 },
  request_metrics: { total_requests: 2 } });

test('catalog comparison ignores observation clocks while preserving identity, text, policy and body hashes', () => {
  const first = catalog(), second = structuredClone(first);
  second.fetched_at = '2026-11-22T13:00:00Z'; second.freshness.age_ms = 50;
  second.freshness.validated_at = '2026-11-22T13:00:00Z'; second.request_metrics.total_requests = 3;
  assert.deepEqual(stableNotionCatalog(first), stableNotionCatalog(second));
  for (const mutate of [value => value.records[0].description = 'Different', value => value.records[0].body_sha256 = 'b'.repeat(64), value => value.freshness.max_age_ms = 600000]) {
    const changed = structuredClone(second); mutate(changed);
    assert.notDeepEqual(stableNotionCatalog(first), stableNotionCatalog(changed));
  }
  assert.equal(first.fetched_at, '2026-11-22T12:00:00Z');
});

test('observed directory shape excludes only per-request query UUID and expiry, preserving source, page, skill and query semantics', () => {
  // Shape observed in benchmark-route-gate-1-001; identifiers here are controlled.
  const record = { id: 'shared_skill:library-fixture:skill-1', kind: 'skill',
    locator: { type: 'shared_skill', page_id: 'page-1', database_id: 'database-1', data_source_id: 'source-1', library_id: 'library-fixture', skill_id: 'skill-1' },
    name: 'refund', alias: 'refund', description: 'Refund policy', default_context: false, enabled: true, entrypoint: 'SKILL.md',
    ref: 'skill://shared_skill%3Alibrary-fixture%3Askill-1/SKILL.md', body_sha256: 'a'.repeat(64) };
  const full = { scope: 'scope-fixture', records: [record], databases: [], count: 1 };
  const first = { version: 1, catalog: { ok: true, value: full }, directory: { ok: true, value: {
    ...structuredClone(full), view_selection: 'first',
    view: { id: 'view-1', name: 'Default view', type: 'table', database_id: 'database-1', data_source_id: 'source-1', url: 'https://app.notion.com/p/database-1?v=view-1' },
    view_query: { id: '9dae14e3-3a5e-4c97-828c-825b87a9e474', expires_at: '2026-11-22T11:58:38.102+00:00', total_count: 16 },
  } } };
  const next = structuredClone(first);
  next.directory.value.view_query.id = 'f56c2c7b-8512-477a-b834-a01edbdaa083';
  next.directory.value.view_query.expires_at = '2026-11-22T12:05:00.000+00:00';
  assert.deepEqual(stableNotionCatalog(first), stableNotionCatalog(next));
  for (const mutate of [
    value => value.view.id = 'view-2', value => value.view.data_source_id = 'source-2',
    value => value.records[0].locator.page_id = 'page-2', value => value.records[0].locator.skill_id = 'skill-2',
    value => value.records[0].body_sha256 = 'b'.repeat(64), value => value.records[0].description = 'Changed policy',
    value => value.view_query.total_count = 17, value => value.view_query.query = 'different query',
    value => value.view_query.filter = { enabled: false }, value => value.view_query.next_cursor = 'next-page',
    value => value.view_selection = 'named',
  ]) {
    const changed = structuredClone(next); mutate(changed.directory.value);
    assert.notDeepEqual(stableNotionCatalog(first), stableNotionCatalog(changed));
  }
  assert.equal(first.directory.value.view_query.id, '9dae14e3-3a5e-4c97-828c-825b87a9e474');
  assert.equal(first.directory.value.view_query.expires_at, '2026-11-22T11:58:38.102+00:00');
  const flat = { ...full, view_query: { id: 'flat-must-stay', expires_at: 'also-retained' } };
  assert.deepEqual(stableNotionCatalog(flat)[0].value.view_query, flat.view_query);
});

async function fixture() {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-notion-observer-'));
  const controlDir = path.join(runRoot, 'control');
  fs.mkdirSync(path.join(runRoot, 'subject-runtime'));
  const cli = path.join(runRoot, 'cli.mjs'); fs.writeFileSync(cli, '// owned observer apparatus\n');
  const previous = process.env.PAIRED_CLI_ENTRY;
  process.env.PAIRED_CLI_ENTRY = cli;
  const recorder = await createEpisodeRecorder(controlDir, { episode_id: 'notion-observer-apparatus' }, ['test-token-not-a-real-credential']);
  let stage = 'prepare';
  const observer = observeEpisodeNotion({ config: { runRoot, controlDir, correlation: { episode_id: 'notion-observer-apparatus' } }, recorder,
    context: () => ({ stage, turn_id: stage === 'user_task' ? 'turn-1' : null, model_request_id: null, active_tool_call_ids: stage === 'user_task' ? ['parent-1', 'child-1'] : [] }) });
  const operation = (name, value, { metricsObserved = true, completeResult = true, trace = [], id = randomUUID(), sequence = rows => rows } = {}) => {
    const common = { version: 1, id, operation: name, source_id: 'notion', database: 'fixture-database', pid: process.pid };
    const rows = [[metricChannel, { ...common, event: 'start', monotonic_ns: process.hrtime.bigint().toString() }]];
    if (completeResult) rows.push([resultChannel, { version: 1, id, operation: name, value }]);
    rows.push([metricChannel, { ...common, event: 'end', monotonic_ns: process.hrtime.bigint().toString(), status: 'completed',
      elapsed_ms: 1, error_code: null, sdk_started: true, metrics_observed: metricsObserved,
      request_metrics: metricsObserved ? { trace_enabled: true, trace, total_requests: trace.filter(event => event.event === 'attempt').length, trace_dropped: 0 } : undefined }]);
    for (const [name, event] of sequence(rows)) publish(name, event);
    return id;
  };
  return { runRoot, controlDir, recorder, observer, operation, stage(next) { stage = next; },
    async close() {
      try { return await observer.finish(); }
      finally {
        try { await recorder.close(); }
        finally { if (previous === undefined) delete process.env.PAIRED_CLI_ENTRY; else process.env.PAIRED_CLI_ENTRY = previous; }
      }
    } };
}

test('a legal resolve sequence retains all five SDK operations and zero-request resolution', async () => {
  const f = await fixture();
  f.operation('list', catalog());
  const candidate = f.observer.candidate([{ type: 'notion', id: 'notion', enabled: true }]);
  assert.equal(candidate.projection.catalogs.length, 1);
  f.stage('user_task');
  f.operation('consume', { version: 1, status: 'ready' });
  const resolved = { version: 1, from: 'fixture-reference', ref: 'skill://fixture/SKILL.md', effects: [] };
  const resolveId = f.operation('resolve', resolved);
  const content = '# Controlled source\nComplete fixture body.\n', output = path.join(f.runRoot, 'source.md');
  fs.writeFileSync(output, content);
  f.operation('read', { output, bytes: Buffer.byteLength(content), sha256: sha256(content), record: { id: 'fixture' }, scope: 'scope-actual' });
  f.operation('read-resources', { version: 1, status: 'ready', files: [] });
  const result = await f.close();
  assert.equal(result.coverage.sdk, 'complete'); assert.equal(result.coverage.owned_http, 'complete');
  assert.deepEqual(result.operations.map(item => item.operation), ['list', 'consume', 'resolve', 'read', 'read-resources']);
  const resolve = result.operations.find(item => item.operation_id === resolveId);
  assert.equal(resolve.status, 'completed'); assert.equal(resolve.result_observed, true);
  assert.equal(resolve.metrics_complete, true); assert.equal(resolve.http_attempts, 0);
  assert.ok(resolve.start_ref && resolve.result_ref && resolve.end_ref && resolve.receipt_ref);
  const receipts = fs.readdirSync(result.paths.responses).map(name => JSON.parse(fs.readFileSync(path.join(result.paths.responses, name), 'utf8')));
  assert.deepEqual(receipts.find(item => item.requestId === resolveId).value, resolved);
  const ledger = fs.readFileSync(result.paths.sdk, 'utf8').trim().split('\n').map(JSON.parse);
  const source = fs.readFileSync(result.paths.source, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(source.at(-1).operations, 5); assert.equal(source.at(-1).sdkStarts, 5);
  assert.equal(source.at(-1).errors, 0); assert.equal(source.at(-1).complete, true);
  const accounting = graphSourceAccounting(ledger, receipts, { sourceMode: 'sdk', requireConsumption: true });
  assert.deepEqual(accounting.sdk_calls, { list: 1, files: 0, consume: 1, read: 1, 'read-resources': 1, resolve: 1 });
  assert.equal(accounting.actual_http_attempts, 0);
});

test('resolve observation keeps unknown operation, identity, pairing and terminal guards', async t => {
  const cases = [
    ['unknown operation', 'unsupported-operation', {}],
    ['unpaired result and end', 'resolve', { sequence: rows => rows.slice(1) }],
    ['missing end', 'resolve', { sequence: rows => rows.slice(0, -1) }],
    ['missing completed result', 'resolve', { completeResult: false }],
    ['duplicate start', 'resolve', { sequence: rows => [rows[0], ...rows] }],
    ['duplicate result', 'resolve', { sequence: rows => [rows[0], rows[1], rows[1], rows[2]] }],
    ['duplicate end', 'resolve', { sequence: rows => [...rows, rows[2]] }],
    ['changed result operation', 'resolve', { sequence: rows => { rows[1][1].operation = 'read'; return rows; } }],
  ];
  for (const [name, operation, options] of cases) await t.test(name, async () => {
    const f = await fixture(); f.operation(operation, { version: 1, ref: 'skill://fixture/SKILL.md' }, options);
    const result = await f.close();
    assert.equal(result.coverage.sdk, 'partial'); assert.equal(result.coverage.owned_http, 'partial');
    const ledger = fs.readFileSync(result.paths.sdk, 'utf8').trim().split('\n').map(JSON.parse);
    const receipts = fs.readdirSync(result.paths.responses).map(name => JSON.parse(fs.readFileSync(path.join(result.paths.responses, name), 'utf8')));
    assert.throws(() => graphSourceAccounting(ledger, receipts, { sourceMode: 'sdk' }));
  });
  await t.test('invalid UUID stays rejected', async () => {
    const f = await fixture(); f.operation('resolve', { version: 1 }, { id: 'not-a-uuid' });
    await assert.rejects(f.close());
  });
});

test('public diagnostic apparatus retains actual output-file bytes, stage, HTTP and uncertain causal tool association', async () => {
  const f = await fixture();
  f.operation('list', catalog());
  const actual = f.observer.candidate([{ type: 'notion', id: 'notion', enabled: true }]);
  assert.equal(actual.projection.catalogs[0].facets[0].value.records.length, 1);
  assert.throws(() => f.observer.candidate([{ type: 'notion', id: 'missing' }]), /CATALOG_UNAVAILABLE/);
  f.stage('user_task');
  const content = '# Verified source\nOne actual file.\n', output = path.join(f.runRoot, 'source.md');
  fs.writeFileSync(output, content);
  const id = f.operation('read', { output, bytes: Buffer.byteLength(content), sha256: sha256(content), record: { id: 'stable-skill' }, scope: 'scope-actual' }, { trace: [{
    event: 'attempt', attempt: 1, kind: 'notion_body', method: 'GET', outcome: 'success', started_ms: 1, duration_ms: 3,
    request_bytes: 0, response_bytes: Buffer.byteLength(content), http_status: 200, retry_after_seconds: null, request_id: 'fixture-http-1', rate_limit_reason: null,
    target: { page_id: '4205636c-236e-8191-8d01-c62958f19576' }, body_kind: 'retained_body',
  }] });
  const result = await f.close();
  assert.equal(result.coverage.sdk, 'complete'); assert.equal(result.coverage.owned_http, 'complete');
  assert.equal(result.coverage.descendant_transport, 'unobserved');
  const read = result.operations.find(item => item.operation_id === id);
  assert.equal(read.stage, 'user_task'); assert.equal(read.http_attempts, 1);
  assert.equal(read.tool_call_id, null); assert.deepEqual(read.active_tool_call_ids, ['parent-1', 'child-1']);
  const artifact = f.recorder.artifacts.find(item => item.id === read.receipt_ref.artifact_id);
  const receipt = JSON.parse(fs.readFileSync(artifact.path, 'utf8'));
  assert.equal(receipt.outputEvidence.content, content); assert.equal(receipt.outputEvidence.sha256, sha256(content));
  assert.equal(receipt.outputEvidence.bytes, Buffer.byteLength(content));
  const source = fs.readFileSync(result.paths.source, 'utf8').trim().split('\n').map(JSON.parse);
  const http = source.find(row => row.phase === 'attempt');
  assert.equal(http.requestId, read.source_request_id); assert.equal(http.request_kind, 'notion_body');
});

test('missing metrics or successful-result evidence stay partial and never imply zero requests', async () => {
  const f = await fixture();
  f.operation('files', { files: [] }, { metricsObserved: false });
  f.operation('read', null, { completeResult: false });
  const result = await f.close();
  assert.equal(result.coverage.sdk, 'partial'); assert.equal(result.coverage.owned_http, 'partial');
  assert.equal(result.operations[0].http_attempts, null);
  assert.equal(result.operations[1].result_observed, false);
});

test('credential boundary scrubs diagnostic strings and graph output artifacts', async () => {
  const f = await fixture();
  f.operation('files', { comment: 'test-token-not-a-real-credential', authorization: 'another-private-value' });
  const result = await f.close();
  assert.equal(result.coverage.sdk, 'complete');
  for (const artifact of f.recorder.artifacts) {
    const value = fs.readFileSync(artifact.path, 'utf8');
    assert.ok(!value.includes('test-token-not-a-real-credential'));
    assert.ok(!value.includes('another-private-value'));
  }
});
