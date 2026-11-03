import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequestLedger, safeRequestMetrics } from './notion-default-context.mjs';
import { requestCounts } from './verify-pi-notion-model-cache.mjs';

const event = { event: 'attempt', attempt: 1, kind: 'notion_body', body_kind: 'retained_body', method: 'POST', started_ms: 1, duration_ms: 2, outcome: 'success', request_bytes: 3, response_bytes: 4, http_status: 200, request_id: 'request-1', rate_limit_reason: null, retry_after_seconds: null };
const metrics = trace => ({ trace_enabled: true, total_requests: trace.filter(row => row.event === 'attempt').length, trace, trace_dropped: 0 });

test('HTTP attempts are read from the engine and opaque response fields never enter the ledger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'broker-http-ledger-'));
  const output = { ok: true, content: 'PRIVATE_BODY_SENTINEL', request_metrics: metrics([{ ...event, path: 'PRIVATE_PATH_SENTINEL', authorization: 'PRIVATE_AUTH_SENTINEL' }]) };
  const command = [process.execPath, '-e', `console.log(${JSON.stringify(JSON.stringify(output))})`, '--'];
  const ledger = await createRequestLedger({ scratch: directory, evidence: directory, command });
  const result = await promisify(execFile)(ledger.command[0], [...ledger.command.slice(1), 'read', 'skill://selected/SKILL.md']);
  assert.deepEqual(JSON.parse(result.stdout), output, 'Tracing preserves the original CLI stdout');
  const retained = await readFile(ledger.ledger, 'utf8');
  assert.ok(!/PRIVATE_BODY|PRIVATE_PATH|PRIVATE_AUTH/.test(retained));
  const rows = retained.trim().split('\n').map(JSON.parse);
  assert.deepEqual(requestCounts(rows), { complete: true, cli: 1, reads: 1, exports: 0, notion: 1, notionBody: 1, notionWrites: 0 });
  assert.equal(rows.find(row => row.phase === 'attempt').body_kind, 'retained_body');
});

test('an explicitly observed complete empty trace proves zero requests', () => {
  assert.deepEqual(safeRequestMetrics(metrics([])), { trace: [], complete: true, total_requests: 0, trace_dropped: 0 });
  const rows = [{ kind: 'cli', phase: 'started', requestId: 'empty' }, { kind: 'metrics', phase: 'metrics', observed: true, complete: true, total_requests: 0, requestId: 'empty' }];
  assert.equal(requestCounts(rows).notion, 0);
  assert.equal(requestCounts(rows).complete, true);
});

test('missing, malformed or truncated evidence cannot prove a zero-request result', () => {
  assert.equal(safeRequestMetrics(undefined), undefined);
  assert.equal(safeRequestMetrics({ ...metrics([]), trace_enabled: false }), undefined);
  assert.equal(safeRequestMetrics({ ...metrics([event]), trace_dropped: 1 }).complete, false);
  assert.equal(safeRequestMetrics({ ...metrics([event]), total_requests: 2 }).complete, false);
  assert.equal(safeRequestMetrics(metrics([event, event])).complete, false);
  assert.equal(safeRequestMetrics({ ...metrics([]), trace: [null] }), undefined);
  assert.equal(safeRequestMetrics(metrics(Array(10001).fill(event))), undefined);
  assert.equal(requestCounts([{ kind: 'cli', phase: 'started', requestId: 'missing' }]).complete, false);
});
