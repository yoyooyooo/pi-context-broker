import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor, executePlan, freezePlan, measureCommand, metricsSummary, sourceIdentity } from './skill-consumption-source-baseline.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const base = await mkdtemp(join(await realpath(tmpdir()), 'source-baseline-driver-test-'));
after(() => { if (process.platform === 'darwin') assert.equal(spawnSync('/usr/bin/trash', [base]).status, 0); });

test('missing and truncated metrics stay unknown instead of proving zero requests', () => {
  assert.equal(metricsSummary(null).sourceHttpAttempts, null);
  const partial = metricsSummary({ complete: false, total_requests: 2, trace: [{ event: 'attempt', request_bytes: 4, response_bytes: null, request_kind: 'notion_body', outcome: 'failure', duration_ms: 8 }] });
  assert.equal(partial.observedHttpAttempts, 1);
  assert.equal(partial.sourceHttpAttempts, null);
  assert.equal(partial.requestBytes, null);
  assert.equal(partial.responseBytes, null);
  assert.equal(metricsSummary({ complete: true, total_requests: 0, trace: [] }).sourceHttpAttempts, 0);
});

test('spawn failure retains stdout identity, close receipt and unknown metrics', async () => {
  const { receipt } = await measureCommand(['/definitely-not-a-source-cli'], [], { directory: join(base, 'spawn'), id: 'missing', env: process.env, timeoutMs: 1000 });
  assert.equal(receipt.failure, 'SPAWN_FAILED');
  assert.equal(receipt.pid, null);
  assert.equal(receipt.stdout.sha256, hash(''));
  assert.equal(receipt.costs.sourceHttpAttempts, null);
  assert.equal((await stat(receipt.stdout.path)).mode & 0o777, 0o600);
  assert.ok((await readFile(receipt.lifecycle, 'utf8')).includes('"event":"close"'));
});

test('timeout waits for owned process close and retains only redacted stderr', async () => {
  const code = 'process.stdout.write("partial stdout");process.stderr.write("Bearer secret_private-source-token");setInterval(()=>{},1000)';
  const { receipt } = await measureCommand([process.execPath], ['-e', code], { directory: join(base, 'timeout'), id: 'slow', env: process.env, timeoutMs: 200 });
  assert.equal(receipt.failure, 'TIMEOUT');
  assert.ok(receipt.elapsedMs >= 150);
  assert.equal(receipt.stdout.sha256, hash('partial stdout'));
  assert.equal(receipt.stdout.parsedComplete, false);
  assert.equal(receipt.costs.sourceHttpAttempts, null);
  const stderr = await readFile(receipt.stderr.path, 'utf8');
  assert.ok(!stderr.includes('private-source-token'));
  assert.match(stderr, /REDACTED/);
  assert.ok((await readFile(receipt.lifecycle, 'utf8')).includes('"event":"close"'));
});

test('failed CLI response keeps its complete attempt metrics and raw failure stdout', async () => {
  const response = { ok: false, error: { code: 'SNAPSHOT_MISSING' }, request_metrics: { trace_enabled: true, trace: [], total_requests: 0, trace_dropped: 0 } };
  const { receipt } = await measureCommand([process.execPath], ['-e', 'console.log(' + JSON.stringify(JSON.stringify(response)) + ');process.exitCode=1'], { directory: join(base, 'failure'), id: 'failed', env: process.env, timeoutMs: 1000 });
  assert.equal(receipt.failure, 'PROCESS_FAILED');
  assert.equal(receipt.errorCode, 'SNAPSHOT_MISSING');
  assert.equal(receipt.costs.sourceHttpAttempts, 0);
  assert.equal(receipt.providerTotalCost, null);
  assert.deepEqual(JSON.parse(await readFile(receipt.stdout.path, 'utf8')), response);
});

// This child is a driver fixture, never evidence for product performance.
function fixtureCli() {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('--metrics --database --max-age 0, Ns, Nm, Nh --from'); return; }
  if (args.includes('--version')) { console.log('source-driver-fixture v1'); return; }
  const metrics = { trace_enabled: true, trace: [], total_requests: 0, trace_dropped: 0 };
  const send = value => console.log(JSON.stringify({ ...value, request_metrics: metrics }));
  const state = process.env.NTN_SKILLS_HOME;
  const root = 'skill://shared_skill%3Atest%3Aone/SKILL.md', id = 'shared_skill:test:one', scope = 'a'.repeat(64);
  const body = '# Fixture\n', version = digest(body), snapshot = 's_' + digest(JSON.stringify([scope, id, version]));
  const ref = root + '?snapshot=' + snapshot;
  const record = { id, kind: 'skill', name: 'Fixture', alias: 'fixture', description: 'Driver fixture', enabled: true,
    default_context: false, entrypoint: 'SKILL.md', ref: root,
    locator: { type: 'shared_skill', library_id: 'test', skill_id: 'one', page_id: '00000000-0000-4000-8000-000000000002',
      database_id: '00000000-0000-4000-8000-000000000001', data_source_id: '00000000-0000-4000-8000-000000000003' } };
  const binding = { record, scope, snapshot_id: snapshot, version_id: version, body_sha256: digest(body), ref };
  const object = path.join(state, 'objects', digest(body)), cached = fs.existsSync(object), pinned = args[1]?.includes('?snapshot=');
  if (pinned && !cached) { send({ ok: false, error: { code: 'SNAPSHOT_MISSING' } }); process.exitCode = 1; return; }
  if (args[0] === 'prepare') {
    fs.mkdirSync(path.dirname(object), { recursive: true }); fs.writeFileSync(object, body);
    fs.mkdirSync(path.join(state, 'snapshots'), { recursive: true }); fs.writeFileSync(path.join(state, 'snapshots', snapshot + '.json'), JSON.stringify({ record, snapshot }));
    const expired = args.includes('1s'), source = pinned ? 'local_snapshot' : expired || !cached ? 'notion' : 'local_cache';
    const node = { id, ref, state: 'prepared', roles: ['root'], record, kind: 'skill', binding, path: 'SKILL.md', content: body, bytes: Buffer.byteLength(body), body_sha256: digest(body),
      files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(body), sha256: digest(body), ref }], required: [], candidates: [], references: [],
      source, freshness: { policy: pinned ? 'pinned' : 'max_age', max_age_ms: expired ? 1000 : 300000 } };
    const vector = { version: 1, kind: 'observed_version_vector', purpose: 'use', scope, roots: [id], required: [], bindings: [binding] };
    send({ ok: true, version: 1, status: 'ready', purpose: 'use', scope, roots: [{ target: args[1], id, ref, readiness: 'ready' }], nodes: [node],
      graph_lock: { ...vector, sha256: digest(canonical(vector)) }, session_bindings: [binding], required: [], required_closure: [id] });
  } else if (args[0] === 'read') send({ ok: true, record, scope, snapshot_id: snapshot, version_id: version, ref, entrypoint: 'SKILL.md', path: 'SKILL.md',
    content: body, range: { start: 1, end: 2, total_lines: 2 }, has_more: false, freshness: { policy: 'pinned' } });
  else { send({ ok: false, error: { code: 'INVALID_ARGUMENT' } }); process.exitCode = 2; }
}

test('frozen four-state run retains failed partial samples, 1+N boundaries, setup costs and private artifacts', async () => {
  if (process.platform !== 'darwin') return;
  const cli = join(base, 'fixture.cjs'); await writeFile(cli, '(' + fixtureCli.toString() + ')();\n', { mode: 0o600 });
  const config = { command: [process.execPath, cli], database: '00000000-0000-4000-8000-000000000001',
    root: 'skill://shared_skill%3Atest%3Aone/SKILL.md', evidenceRoot: join(base, 'runs'), timeoutMs: 2000,
    samples: { cold: 1, warm: 1, 'expired-unchanged': 1, partial: 1 } };
  const checked = await doctor(config);
  assert.equal(checked.cliVersion, 'source-driver-fixture v1');
  assert.equal(checked.ttl.expired, '1s');
  const plan = await freezePlan(config);
  assert.equal(plan.samples.length, 4);
  assert.equal(plan.modelProviderTotalCost, null);
  const report = await executePlan(plan);
  assert.equal(report.coverageComplete, true);
  assert.equal(report.artifactIntegrity.valid, true);
  assert.equal(report.groups.partial.outcomes.failed, 1);
  assert.equal(report.groups.partial.elapsedMs.p95, null);
  assert.equal(report.groups.warm.cliStarts.median, 2);
  assert.equal(report.setups.length, 2);
  assert.equal(report.productAcceptance, 'not-inferred');
  const samples = JSON.parse(await readFile(join(plan.run, 'samples.json'), 'utf8'));
  const partial = samples.find(sample => sample.group === 'partial');
  assert.equal(partial.executedMainReads, 0);
  assert.equal(partial.plannedMainReads, 1);
  assert.equal(partial.initialState.manifestPreserved, true);
  assert.equal(partial.initialState.original.sha256, hash('# Fixture\n'));
  assert.ok(samples.find(sample => sample.group === 'expired-unchanged').initialState.elapsedMs >= 1000);
  const operations = JSON.parse(await readFile(join(plan.run, 'operations.json'), 'utf8'));
  for (const operation of operations) assert.equal((await stat(operation.receipt.stdout.path)).mode & 0o777, 0o600);
  const failed = operations.find(operation => operation.id === 'partial-001-prepare');
  assert.equal(failed.receipt.errorCode, 'SNAPSHOT_MISSING');
  assert.equal(failed.receipt.costs.sourceHttpAttempts, 0);
  assert.ok(failed.receipt.args[1].includes('?snapshot='));
  await assert.rejects(() => executePlan(plan), /already started/);
  const graph = JSON.parse(await readFile(operations.find(operation => operation.id === 'cold-001-prepare').receipt.stdout.path, 'utf8'));
  const identity = sourceIdentity(graph);
  graph.nodes[0].content = 'truncated';
  assert.throws(() => sourceIdentity(graph));
  assert.equal(identity.bindings.length, 1);
});

// A resource-only fixture establishes two effective files while delivering one.
// Its second isolated state changes source bytes: that attempt must remain failed.
function resourceFixtureCli() {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('--metrics --database --max-age 0, Ns, Nm, Nh --from'); return; }
  if (args.includes('--version')) { console.log('source-resource-fixture v1'); return; }
  const metrics = { trace_enabled: true, trace: [], total_requests: 0, trace_dropped: 0 };
  const send = value => console.log(JSON.stringify({ ...value, request_metrics: metrics }));
  if (args[0] !== 'read' || args[1] !== 'references/example.md' || !args.includes('--from')) {
    send({ ok: false, error: { code: 'UNEXPECTED_EXTRA_CLI' } }); process.exitCode = 1; return;
  }
  const state = process.env.NTN_SKILLS_HOME, changed = state.includes('cold-002');
  const content = changed ? 'Changed resource\n' : 'Resource\n', main = '# Main\n';
  const id = 'shared_skill:test:one', scope = 'a'.repeat(64), root = 'skill://shared_skill%3Atest%3Aone/SKILL.md';
  const version_id = digest(content), snapshot_id = 's_' + digest(version_id);
  const record = { id, ref: root, entrypoint: 'SKILL.md', locator: { database_id: '00000000-0000-4000-8000-000000000001' } };
  const file_bindings = [{ file_id: 'main', path: 'SKILL.md' }, { file_id: 'resource', path: 'references/example.md' }];
  const bodies = [{ path: 'SKILL.md', content: main }, { path: 'references/example.md', content }];
  const files = bodies.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.content), sha256: digest(file.content) }));
  const manifest = { snapshot_id, scope, record, entrypoint: 'SKILL.md', version_id, created_at: new Date().toISOString(), files, file_bindings };
  fs.mkdirSync(path.join(state, 'snapshots'), { recursive: true }); fs.mkdirSync(path.join(state, 'objects'), { recursive: true });
  fs.writeFileSync(path.join(state, 'snapshots', snapshot_id + '.json'), JSON.stringify(manifest));
  for (const file of bodies) fs.writeFileSync(path.join(state, 'objects', digest(file.content)), file.content);
  send({ ok: true, record, scope, snapshot_id, version_id, entrypoint: 'SKILL.md', file_bindings,
    ref: 'skill://shared_skill%3Atest%3Aone/references/example.md?snapshot=' + snapshot_id + '&file_id=resource',
    path: 'references/example.md', content, range: { start: 1, end: 2, total_lines: 2 }, has_more: false, source: 'notion' });
}

test('resource-only cold samples run one read, preserve complete-cache observations and fail changed source without dropping it', async () => {
  const cli = join(base, 'resource-fixture.cjs'); await writeFile(cli, '(' + resourceFixtureCli.toString() + ')();\n', { mode: 0o600 });
  const config = { command: [process.execPath, cli], database: '00000000-0000-4000-8000-000000000001',
    root: 'skill://shared_skill%3Atest%3Aone/SKILL.md', resourcePath: 'references/example.md', pipeline: 'resource-only',
    evidenceRoot: join(base, 'resource-runs'), timeoutMs: 2000, samples: { cold: 2, warm: 0, 'expired-unchanged': 0, partial: 0 } };
  const plan = await freezePlan(config);
  assert.deepEqual(plan.pipeline, ['read-one-current-resource', 'observe-owned-cache-without-another-cli']);
  const report = await executePlan(plan);
  assert.equal(report.artifactIntegrity.valid, true);
  assert.equal(report.operationCount, 2);
  assert.equal(report.setups.length, 0);
  assert.equal(report.groups.cold.outcomes.passed, 1);
  assert.equal(report.groups.cold.outcomes.failed, 1);
  assert.equal(report.groups.cold.elapsedMs.p95, null);
  const samples = JSON.parse(await readFile(join(plan.run, 'samples.json'), 'utf8'));
  assert.equal(samples[0].cliStarts, 1); assert.equal(samples[0].executedMainReads, 0);
  assert.equal(samples[0].materialization.effectiveManifestFiles.length, 2);
  assert.ok(samples[0].materialization.effectiveManifestFiles.every(file => file.present && file.valid));
  assert.equal(samples[0].requestedResourceCount, 1);
  assert.equal(samples[0].preparation, null);
  assert.ok(samples[1].errors.some(error => error.code === 'SOURCE_DRIFT'));
  assert.equal(samples[1].sourceIdentityVerified, false);
});
