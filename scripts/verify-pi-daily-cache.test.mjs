import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { completeGraph, findSelection, validateCacheConfig, validateCacheReuse } from './verify-pi-daily-cache.mjs';

const library = '00000000-0000-4000-8000-000000000001';
const page = '00000000-0000-4000-8000-000000000002';
const hash = value => createHash('sha256').update(value).digest('hex');
const fresh = () => ({ validated_at: '2026-01-01T00:00:00.000Z', max_age_ms: 300000,
  age_ms: 1000, stale: false, current_eligibility_max_age_ms: 300000 });
function graph() {
  const node = (id, content, required) => ({ id, state: 'prepared', source: 'local_cache',
    record: { locator: { page_id: id === 'root' ? page : '00000000-0000-4000-8000-000000000003', library_id: library } },
    content, bytes: Buffer.byteLength(content), body_sha256: hash(content),
    binding: { scope: 'credential-library', snapshot_id: 'snapshot-' + id, version_id: 'version-' + id, body_sha256: hash(content) },
    required, freshness: fresh() });
  return { status: 'ready', scope: 'credential-library', roots: [{ id: 'root' }],
    required_closure: ['dependency'], required: [{ from: 'root', to: 'dependency' }],
    nodes: [node('root', '# Root\n\n完整正文。\n', [{ id: 'dependency' }]), node('dependency', '# Required\n\nComplete dependency.\n', [])] };
}
function receipts() {
  const baseGraph = graph();
  const phase = (name, pid) => ({
    phase: name, status: 'passed', host: { pid, observed_exit: true,
      entry: { sha256: 'pi-entry' }, package: { version: '1.6.0', root: '/ordinary/pi' }, node: { sha256: 'node' } },
    initial_session: { sessionId: 'session-' + name, messageCount: 0 },
    initial_branch: { selected_graphs: 0 }, final_branch: { session_file: '/owned/' + name + '.jsonl' },
    consume: { source_id: 'notion', library, http_requests: 0 },
    operations: [{ operation: 'consume' }, { operation: 'list' }],
    http: { consumption_requests: 0, notion_body_requests: 0, library_root_structure_requests: 0 },
    provider: { all_complete_bodies_present: true, requests: [{ sha256: 'actual-wire' }] },
    graph: { ...baseGraph, nodes: baseGraph.nodes.map(node => ({
      id: node.id, source: node.source, bytes: node.bytes, body_sha256: node.body_sha256,
      binding_scope: node.binding.scope, snapshot_id: node.binding.snapshot_id, version_id: node.binding.version_id,
      freshness: { ...node.freshness },
    })) },
  });
  return [phase('D', 101), phase('A', 102), phase('B', 103)];
}

test('ordinary cache configuration declares its own scope and expected TTL', () => {
  const config = { version: 1, scope: 'ordinary-pi-cache-reuse', brokerRoot: '/installed/broker',
    evidenceRoot: '/owned/proof', library, query: 'test-skill', expectedMaxAgeMs: 3600000 };
  assert.equal(validateCacheConfig(config).maxAgeMs, 3600000);
  for (const invalid of [
    { scope: 'project-scoped-candidate-precheck' }, { expectedMaxAgeMs: undefined },
    { expectedMaxAgeMs: 0 }, { evidenceRoot: 'relative' }, { pi: 'another-command' },
  ]) assert.throws(() => validateCacheConfig({ ...config, ...invalid }));
});

test('live alias comes from an unambiguous actual find notification', () => {
  const report = 'context-broker find:\n$test-skill@notion\n  kind: skill\n  source: notion\n  page: ' + page;
  assert.equal(findSelection([report], 'test-skill').page, page);
  assert.throws(() => findSelection([report.replace(page, 'missing-page')], 'test-skill'));
  assert.throws(() => findSelection([report, report.replace(page, library)], 'test-skill'), /ambiguity/);
});

test('actual consumption graph must include complete root and transitive Requires bodies within the original TTL', () => {
  const run = g => completeGraph({ value: { status: 'ready', preparation: g } }, { page }, { library, maxAgeMs: 300000 });
  assert.equal(run(graph()).prepared.length, 2);
  for (const mutate of [
    g => { g.nodes.pop(); },
    g => { g.nodes[1].content = '# Required'; },
    g => { g.nodes[1].binding.body_sha256 = 'wrong'; },
    g => { g.nodes[1].freshness.age_ms = 300000; },
    g => { g.nodes[1].freshness.max_age_ms = 3600000; },
    g => { g.nodes[0].record.locator.library_id = page; },
    g => { g.nodes[1].required = [{ id: 'missing-transitive-node' }]; },
  ]) {
    const g = graph(); mutate(g); assert.throws(() => run(g));
  }
});

test('fresh ordinary Pi sessions reuse original root and Requires versions, including during separately counted root-structure refresh', () => {
  const phases = receipts();
  validateCacheReuse(...phases, 300000);
  phases[2].http.notion_body_requests = 2;
  phases[2].http.library_root_structure_requests = 2;
  validateCacheReuse(...phases, 300000);
});

test('ordinary cache receipt rejects per-process reuse, hidden revalidation, missing wire and changed original identity', () => {
  const mutations = [
    ([, a, b]) => { b.host.pid = a.host.pid; },
    ([, a, b]) => { b.initial_session.sessionId = a.initial_session.sessionId; },
    ([,, b]) => { b.initial_branch.selected_graphs = 1; },
    ([,, b]) => { b.host.observed_exit = false; },
    ([,, b]) => { b.host.package.version = 'another-Pi'; },
    ([,, b]) => { b.consume.http_requests = 1; },
    ([,, b]) => { b.http.consumption_requests = 1; },
    ([,, b]) => { b.operations.push({ operation: 'library' }); },
    ([,, b]) => { b.http.notion_body_requests = 1; },
    ([,, b]) => { b.graph.nodes[1].source = 'remote'; },
    ([,, b]) => { b.graph.nodes[1].freshness.validated_at = '2026-01-01T00:00:01.000Z'; },
    ([,, b]) => { b.graph.nodes[1].snapshot_id = 'refreshed'; },
    ([,, b]) => { b.graph.nodes[1].body_sha256 = 'another-body'; },
    ([,, b]) => { b.graph.nodes.pop(); },
    ([,, b]) => { b.graph.scope = 'another-credential'; },
    ([,, b]) => { b.provider.all_complete_bodies_present = false; },
    ([,, b]) => { b.provider.requests = []; },
  ];
  for (const mutate of mutations) {
    const phases = receipts(); mutate(phases);
    assert.throws(() => validateCacheReuse(...phases, 300000));
  }
});
