import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseArgs, validateCurrentFixture, currentServiceFacts, selectProviderCall, assertWireSources, verifyEvidence } from './notion-sdk-pi.mjs';

const options = ['--package', '/owned/installed', '--fixture', '/owned/current.json', '--source-http-helper', '/owned/current-http.mjs'];
test('current command boundary rejects retired or ambiguous invocation before I/O', () => {
  assert.equal(parseArgs(['doctor', ...options, '--pi', '/owned/pi']).action, 'doctor');
  assert.equal(parseArgs(['run', ...options, '--out', '/owned/result', '--scenario', 'http-cache-recovery'])['--scenario'], 'http-cache-recovery');
  assert.equal(parseArgs(['run', ...options, '--out', '/owned/result', '--scenario', 'http-warm-restart'])['--scenario'], 'http-warm-restart');
  assert.equal(parseArgs(['run', ...options, '--out', '/owned/result', '--scenario', 'http-warm-directory-expired'])['--scenario'], 'http-warm-directory-expired');
  for (const args of [
    ['cleanup', '--evidence', '/owned/result'], ['run', ...options], ['run', ...options, '--out', 'relative'],
    ['run', ...options, '--out', '/owned/result', '--scenario', 'native-repeat'],
    ['doctor', ...options, '--fixture', '/other'], ['doctor', ...options, '--provider-backend', 'in-process'],
    ['doctor', ...options, '--live-input', '/owned/live'], ['doctor', ...options, '--expect-short-refs'],
  ]) assert.throws(() => parseArgs(args));
});

function fixture() {
  const rich = (id, value) => ({ id, type: 'rich_text', rich_text: [{ plain_text: value }] });
  const row = { id: '00000000-0000-4000-8000-000000000001', properties: {
    Name: { id: 'title', title: [{ plain_text: 'Current demo' }] },
    'Skill ID': rich('skill-id', 'demo'), 'Main File ID': rich('main-id', 'main-demo'),
    Content: rich('content', JSON.stringify({ kind: 'native', mode: '100644', frontmatter: '---\nname: a\n---\n' })),
    Enabled: { id: 'enabled', checkbox: true }, 'Default Context': { id: 'default', checkbox: false },
    members: { id: 'members', relation: [] }, requires: { id: 'requires', relation: [] },
  } };
  return { version: 2, kind: 'current-notion-service', root_page_id: row.id, env: '/owned/env.json', database: 'database',
    notion: { main: row, skills: [row], files: [], records: [], sources: [], bodies: { [row.id]: 'A original\n' },
      library: { skills: { data_source_id: 'skills' }, sources: {} } },
    expected: { file_count: 102, catalog_count: 1, files: [{ path: 'SKILL.md', content: 'A original\n' }] } };
}

test('only current service facts are accepted, including rejecting mixed cache payloads', () => {
  assert.equal(validateCurrentFixture(fixture()).version, 2);
  for (const extra of [{ version: 1 }, { snapshots: [] }, { scope: 'a'.repeat(64) }, { cwd: '/old/cache' }])
    assert.throws(() => validateCurrentFixture({ ...fixture(), ...extra }));
});

test('Requires facts use independent source identities, preserve input and never construct consumer snapshots', () => {
  const original = fixture(), before = structuredClone(original);
  const { sample, owners } = currentServiceFacts(original);
  assert.deepEqual(original, before);
  assert.equal(new Set(sample.notion.skills.map(row => row.id)).size, 3);
  assert.equal(new Set(sample.notion.skills.map(row => row.properties['Main File ID'].rich_text[0].plain_text)).size, 3);
  for (const root of [owners.a, owners.c]) assert.deepEqual(sample.notion.skills.find(row => row.id === root).properties.requires.relation, [{ id: owners.b }]);
  assert.deepEqual(sample.notion.skills.find(row => row.id === owners.b).properties.requires.relation, []);
  assert.equal(Object.hasOwn(sample, 'snapshots'), false);
  assert.equal(Object.hasOwn(sample, 'scope'), false);
  assert.deepEqual(Object.keys(sample.notion.bodies).sort(), Object.values(owners).sort());
});

test('controlled tool selection stops only after the exact requested tool result', () => {
  const call = { type: 'toolCall', id: 'this-call', name: 'notion_use', arguments: { ref: 'sr:Cissued' } }, plan = { mode: 'call', call };
  assert.deepEqual(selectProviderCall({ messages: [] }, plan), call);
  assert.deepEqual(selectProviderCall({ messages: [{ role: 'toolResult', toolCallId: 'other-call' }] }, plan), call);
  assert.equal(selectProviderCall({ messages: [{ role: 'toolResult', toolCallId: 'this-call' }] }, plan), null);
  assert.equal(selectProviderCall({ messages: [] }, { mode: 'complete' }), null);
  assert.throws(() => selectProviderCall({ messages: [] }, { mode: 'native-repeat' }));
  assert.throws(() => selectProviderCall({ messages: [] }, { mode: 'call', call: { ...call, name: 'bash' } }));
});

test('wire assertions require complete originals and detect retired versions through nested tool serialization', () => {
  const source = '---\nname: a\n---\n\nUTF-8 完整正文 😀\n', retired = 'retired full body\n';
  const wire = { messages: [{ role: 'tool', content: JSON.stringify({ records: [{ content: source }] }) }] };
  assertWireSources(wire, [source], [retired]);
  assert.throws(() => assertWireSources({ messages: [{ content: source.slice(0, -3) }] }, [source]));
  assert.throws(() => assertWireSources({ messages: [{ content: retired }] }, [], [retired]));
});

test('evidence replay rejects stale schema, modified wire and nonzero Pi exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'current-pi-evidence-test-')), name = 'default-view', base = join(directory, name);
  await mkdir(base);
  const save = (path, value) => writeFile(path, JSON.stringify(value));
  const result = { schema: 2, status: 'passed', identity: { evidence_level: 'controlled-Pi' }, cases: [{ name, status: 'passed' }] };
  await save(join(directory, 'result.json'), result);
  await save(join(base, 'scenario.json'), { status: 'passed', steps: [{ status: 'passed' }] });
  const body = '{"messages":[]}'; await writeFile(join(base, 'provider-001.json'), body);
  await save(join(base, 'provider-index.json'), [{ file: 'provider-001.json', sha256: createHash('sha256').update(body).digest('hex'), status: 200 }]);
  await save(join(base, 'rpc-lifecycle.json'), [{ event: 'close', code: 0, signal: null }]);
  const original = 'not delivered';
  await save(join(base, 'wire-source-assertions.json'), [{ provider_file: 'provider-001.json', present: [], absent: [{ text: original, bytes: Buffer.byteLength(original), sha256: createHash('sha256').update(original).digest('hex') }] }]);
  await writeFile(join(base, 'source-http.jsonl'), JSON.stringify({ method: 'GET', path: '/v1/users/me' }) + '\n');
  await writeFile(join(base, 'sdk.jsonl'), ['start', 'end'].map(event => JSON.stringify({ kind: 'context-broker.notion-sdk', event, id: 'actual-operation' })).join('\n') + '\n');
  assert.equal((await verifyEvidence(directory)).schema, 2);
  await writeFile(join(base, 'provider-001.json'), '{}'); await assert.rejects(verifyEvidence(directory));
  await writeFile(join(base, 'provider-001.json'), body); await save(join(base, 'rpc-lifecycle.json'), [{ event: 'close', code: null, signal: 'SIGTERM' }]);
  await assert.rejects(verifyEvidence(directory));
  await save(join(directory, 'result.json'), { ...result, schema: 1 }); await assert.rejects(verifyEvidence(directory));
});

async function warmEvidence(name) {
  const directory = await mkdtemp(join(tmpdir(), 'current-pi-warm-evidence-test-')), base = join(directory, name);
  await mkdir(base);
  const expired = name === 'http-warm-directory-expired';
  const hash = value => createHash('sha256').update(value).digest('hex');
  const originals = ['Root original 完整正文\n', 'Requires original 完整正文\n'];
  const wire = JSON.stringify({ messages: [{ role: 'user', content: originals.join('\n') }] });
  const coldPid = 101, warmPid = 202;
  const lifecycle = (pid, start, end) => [
    { event: 'spawn', pid, monotonicNs: start },
    { event: 'close', pid, monotonicNs: end, code: 0, signal: null },
  ];
  const cold = ['/v1/users/me', '/v1/pages/root/markdown', '/v1/pages/requires/markdown']
    .map(path => ({ method: 'GET', path, phase: 'setup' }));
  const warm = expired ? [
    { method: 'GET', path: '/v1/users/me', phase: 'warm-restart' },
    { method: 'GET', path: '/v1/blocks/library/children', phase: 'warm-restart' },
    { method: 'POST', path: '/v1/data_sources/skills/query', phase: 'warm-restart' },
  ] : [];
  const metrics = (metadata, body) => ({ total_requests: metadata + body,
    requests: { notion_metadata: metadata, notion_body: body, notion_write: 0, provider: 0 },
    body_requests: { current_body: body, retained_body: 0, unclassified_body: 0 } });
  const operation = (id, pid, operation, requestMetrics, value) => [
    { kind: 'context-broker.notion-sdk', event: 'start', id, observer_pid: pid, operation },
    ...(value ? [{ kind: 'context-broker.notion-sdk-result', id, observer_pid: pid, operation, value }] : []),
    { kind: 'context-broker.notion-sdk', event: 'end', id, observer_pid: pid, operation, status: 'completed', request_metrics: requestMetrics },
  ];
  const prepared = source => ({ status: 'ready', preparation: { nodes: ['root', 'requires'].map(id => ({ id, state: 'prepared', source,
    binding: { snapshot_id: 'snapshot-' + id }, freshness: { max_age_ms: 300000, validated_at: 1234, age_ms: source === 'notion' ? 0 : 2000, stale: false } })) } });
  const files = {
    'scenario.json': { status: 'passed', steps: [{ status: 'passed' }] },
    'launch.json': { source: { library: 'library', activation: { maxAge: '5m' }, discovery: { maxAge: expired ? '1s' : '5m' } } },
    'provider-001.json': wire, 'provider-002.json': wire,
    'provider-index.json': [1, 2].map(n => ({ file: `provider-00${n}.json`, sha256: hash(wire), status: 200 })),
    'wire-source-assertions.json': [1, 2].map(n => ({ provider_file: `provider-00${n}.json`,
      present: originals.map(text => ({ text, bytes: Buffer.byteLength(text), sha256: hash(text) })), absent: [] })),
    'cold-rpc-lifecycle.json': lifecycle(coldPid, '0', '1000000000'),
    'rpc-lifecycle.json': lifecycle(warmPid, '2100000001', '4000000000'),
    'cold-session.json': { session_file: '/owned/cold.jsonl', branch: [] },
    'warm-empty-session.json': { session_file: '/owned/warm.jsonl', branch: [] },
    'warm-restart.json': { cold_pid: coldPid, warm_pid: warmPid, cold_session: '/owned/cold.jsonl', warm_session: '/owned/warm.jsonl',
      max_age_ms: 300000, directory_max_age_ms: expired ? 1000 : 300000, cold_source_requests: cold.length, warm_source_requests: warm.length },
    'source-http.jsonl': [...cold, ...warm],
    'sdk.jsonl': [
      ...operation('cold-consume', coldPid, 'consume', metrics(1, 2), prepared('notion')),
      ...operation('warm-list', warmPid, 'list', expired ? metrics(2, 1) : metrics(0, 0)),
      ...operation('warm-consume', warmPid, 'consume', metrics(0, 0), prepared('local_cache')),
    ],
  };
  const save = (name, value) => writeFile(join(base, name), name.endsWith('.jsonl')
    ? value.map(row => JSON.stringify(row)).join('\n') + '\n' : typeof value === 'string' ? value : JSON.stringify(value));
  await writeFile(join(directory, 'result.json'), JSON.stringify({ schema: 2, status: 'passed', identity: { evidence_level: 'controlled-Pi' }, cases: [{ name, status: 'passed' }] }));
  for (const [name, value] of Object.entries(files)) await save(name, value);
  return { directory, files, save };
}

test('fresh cross-process evidence rejects HTTP hidden outside consume, session reuse and incomplete originals', async () => {
  const fixture = await warmEvidence('http-warm-restart');
  await verifyEvidence(fixture.directory);
  const cases = [
    ['source-http.jsonl', rows => rows.push({ method: 'GET', path: '/v1/users/me', phase: 'warm-restart' })],
    ['sdk.jsonl', rows => { rows.find(row => row.id === 'warm-consume' && row.value).value.preparation.nodes.pop(); }],
    ['sdk.jsonl', rows => { rows.find(row => row.id === 'warm-consume' && row.value).value.preparation.nodes[0].source = 'notion'; }],
    ['sdk.jsonl', rows => { rows.find(row => row.id === 'warm-consume' && row.value).value.preparation.nodes[0].freshness.validated_at++; }],
    ['sdk.jsonl', rows => { rows.find(row => row.id === 'warm-consume' && row.event === 'end').request_metrics.total_requests = 1; }],
    ['sdk.jsonl', rows => { rows.push({ kind: 'context-broker.notion-sdk-result', observer_pid: 202, operation: 'library' }); }],
    ['warm-restart.json', row => { row.warm_pid = row.cold_pid; }],
    ['warm-empty-session.json', row => { row.branch.push({ customType: 'context-broker-selected-graph' }); }],
    ['wire-source-assertions.json', rows => { rows[1].present.pop(); }],
  ];
  for (const [name, mutate] of cases) {
    const modified = structuredClone(fixture.files[name]); mutate(modified); await fixture.save(name, modified);
    await assert.rejects(verifyEvidence(fixture.directory), name);
    await fixture.save(name, fixture.files[name]);
  }
  // Even a matching consume=0 and self-reported request count cannot hide auth HTTP.
  const requests = [...fixture.files['source-http.jsonl'], { method: 'GET', path: '/v1/users/me', phase: 'warm-restart' }];
  await fixture.save('source-http.jsonl', requests);
  await fixture.save('warm-restart.json', { ...fixture.files['warm-restart.json'], warm_source_requests: 1 });
  await assert.rejects(verifyEvidence(fixture.directory), /including background work/);
});

test('expired directory evidence counts every list request without reclassifying root children or refreshing bodies', async () => {
  const fixture = await warmEvidence('http-warm-directory-expired');
  await verifyEvidence(fixture.directory);
  const cases = [
    ['rpc-lifecycle.json', rows => { rows[0].monotonicNs = '1500000000'; }],
    ['launch.json', row => { row.source.discovery.maxAge = '5m'; }],
    ['sdk.jsonl', rows => { rows.find(row => row.id === 'warm-list' && row.event === 'end').request_metrics.total_requests--; }],
    ['sdk.jsonl', rows => { rows.find(row => row.id === 'warm-list' && row.event === 'end').operation = 'resolve'; }],
    ['sdk.jsonl', rows => { rows.find(row => row.id === 'warm-list' && row.event === 'end').request_metrics.requests.notion_body = 0; }],
    ['source-http.jsonl', rows => { rows.find(row => row.path === '/v1/blocks/library/children').path = '/v1/pages/root/markdown'; }],
  ];
  for (const [name, mutate] of cases) {
    const modified = structuredClone(fixture.files[name]); mutate(modified); await fixture.save(name, modified);
    await assert.rejects(verifyEvidence(fixture.directory), name);
    await fixture.save(name, fixture.files[name]);
  }
});
