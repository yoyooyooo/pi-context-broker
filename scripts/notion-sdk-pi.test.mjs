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
  for (const scenario of ['http-smart-revalidate', 'http-smart-current'])
    assert.equal(parseArgs(['run', ...options, '--out', '/owned/result', '--scenario', scenario])['--scenario'], scenario);
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
  const metadata = name === 'http-smart-revalidate', expired = name === 'http-warm-directory-expired' || metadata;
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
  if (metadata) warm.push(...['root', 'requires'].map(id => ({ method: 'GET', path: '/v1/pages/' + id, phase: 'warm-restart' })));
  const metrics = (metadata, body) => ({ total_requests: metadata + body,
    requests: { notion_metadata: metadata, notion_body: body, notion_write: 0, provider: 0 },
    body_requests: { current_body: body, retained_body: 0, unclassified_body: 0 } });
  const operation = (id, pid, operation, requestMetrics, value) => [
    { kind: 'context-broker.notion-sdk', event: 'start', id, observer_pid: pid, operation },
    ...(value ? [{ kind: 'context-broker.notion-sdk-result', id, observer_pid: pid, operation, value }] : []),
    { kind: 'context-broker.notion-sdk', event: 'end', id, observer_pid: pid, operation, status: 'completed', request_metrics: requestMetrics },
  ];
  const prepared = (source, revalidated = false) => ({ status: 'ready', preparation: { nodes: ['root', 'requires'].map((id, index) => ({ id, state: 'prepared', source,
    binding: { snapshot_id: 'snapshot-' + id }, body_sha256: hash(originals[index]),
    freshness: { max_age_ms: metadata ? 1000 : 300000, validated_at: metadata ? new Date(revalidated ? 3000 : 1000).toISOString() : 1234,
      age_ms: source === 'notion' ? 0 : 2000, stale: false, ...(revalidated ? { validation: 'metadata' } : {}) } })) } });
  const files = {
    'scenario.json': { status: 'passed', steps: [{ status: 'passed' }] },
    'launch.json': { source: { library: 'library', activation: { maxAge: metadata ? '1s' : '5m' }, discovery: { maxAge: expired ? '1s' : '5m' } } },
    'provider-001.json': wire, 'provider-002.json': wire,
    'provider-index.json': [1, 2].map(n => ({ file: `provider-00${n}.json`, sha256: hash(wire), status: 200 })),
    'wire-source-assertions.json': [1, 2].map(n => ({ provider_file: `provider-00${n}.json`,
      present: originals.map(text => ({ text, bytes: Buffer.byteLength(text), sha256: hash(text) })), absent: [] })),
    'cold-rpc-lifecycle.json': lifecycle(coldPid, '0', '1000000000'),
    'rpc-lifecycle.json': lifecycle(warmPid, '2100000001', '4000000000'),
    'cold-session.json': { session_file: '/owned/cold.jsonl', branch: [] },
    'warm-empty-session.json': { session_file: '/owned/warm.jsonl', branch: [] },
    'warm-restart.json': { cold_pid: coldPid, warm_pid: warmPid, cold_session: '/owned/cold.jsonl', warm_session: '/owned/warm.jsonl',
      max_age_ms: metadata ? 1000 : 300000, directory_max_age_ms: expired ? 1000 : 300000, cold_source_requests: cold.length, warm_source_requests: warm.length },
    'source-http.jsonl': [...cold, ...warm],
    'sdk.jsonl': [
      ...operation('cold-consume', coldPid, 'consume', metrics(1, 2), prepared('notion')),
      ...operation('warm-list', warmPid, 'list', expired ? metrics(2, 1) : metrics(0, 0)),
      ...operation('warm-consume', warmPid, 'consume', metrics(metadata ? 2 : 0, 0), prepared(metadata ? 'notion' : 'local_cache', metadata)),
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

async function smartRevalidationEvidence() {
  const name = 'http-smart-revalidate', directory = await mkdtemp(join(tmpdir(), 'current-pi-revalidation-evidence-test-')), base = join(directory, name);
  await mkdir(base);
  const hash = value => createHash('sha256').update(value).digest('hex'), day = 86400000, now = 1800000000000;
  const phases = ['cold', 'full-warm', 'metadata', 'body-expiry'], owners = ['root', 'requires'];
  const texts = ['Root original 完整正文\n', 'Requires original 完整正文\n'];
  const content = texts.map(text => ({ text, bytes: Buffer.byteLength(text), sha256: hash(text) }));
  const source = { library: 'library', activation: { maxAge: '5m' }, discovery: { maxAge: '5m' } };
  const facts = { root_page_id: 'root', notion: { skills: owners.map((owner, index) => ({ id: owner, properties: {
    Content: { id: 'content', rich_text: [{ plain_text: JSON.stringify({ frontmatter: '' }) }] },
    Requires: { id: 'requires', relation: index === 0 ? [{ id: 'requires' }] : [] },
  } })), bodies: Object.fromEntries(owners.map((owner, index) => [owner, texts[index]])) } };
  const snapshots = owners.map(owner => ({ id: 'snapshot-' + owner, sha256: hash(owner) }));
  const objects = content.map(({ sha256, bytes }) => ({ sha256, bytes }));
  const state = (bodyTime, validatedAt) => ({ captured_at_ms: validatedAt, state_path: join(base, 'ntn/state/state.sqlite'), scope: 'a'.repeat(64),
    native: owners.map((owner, index) => ({ key: 'cache/current-native-bodies/' + owner + '/latest.json', payload: {
      generation: 1, scope: 'a'.repeat(64), library_id: 'library', skill_page_id: owner,
      files: [{ file_id: owner, page_id: owner, path: 'SKILL.md', body_sha256: content[index].sha256, body_verified_at: bodyTime }],
    } })),
    observations: owners.map(owner => ({ id: owner, payload: { snapshot_id: 'snapshot-' + owner, validated_at: validatedAt, shared_body_valid_until: bodyTime + day } })),
    snapshots: structuredClone(snapshots), objects: structuredClone(objects), protected_sqlite: { current_facts: { rows: 2, sha256: hash('original facts') } },
  });
  const receipt = { version: 1, fixture_sha256: hash(JSON.stringify(facts)), owners, full_body_max_age_ms: day,
    processes: [], costs: [], proofs: {}, states: { cold: state(now, now), 'full-warm': state(now, now), metadata: state(now, now + 4000), 'body-expiry': state(now + 7000, now + 7000) } };
  const agedAt = now + 5000, expiredAt = agedAt - day - 1000;
  receipt.aging = { mode: 'owned-cache-body-age', aged_at_ms: agedAt, expired_body_verified_at: expiredAt, full_body_max_age_ms: day,
    before: structuredClone(receipt.states.metadata), aged: state(expiredAt, now + 4000) };
  const files = { 'source-facts.json': facts, 'launch.json': { source },
    'metadata-source-config.json': { sources: [{ ...source, activation: { maxAge: '1s' }, discovery: { maxAge: '1s' } }] },
    'source-http.jsonl': [], 'sdk.jsonl': [], 'provider-index.json': [], 'wire-source-assertions.json': [], 'scenario.json': { status: 'passed', steps: [] } };
  const metrics = (metadata, body) => ({ total_requests: metadata + body, requests: { notion_metadata: metadata, notion_body: body, notion_write: 0, provider: 0 },
    body_requests: { current_body: body, retained_body: 0, unclassified_body: 0 }, request_bytes: (metadata + body) * 4, response_bytes: (metadata + body) * 16,
    unknown_request_bytes: 0, unknown_response_bytes: 0, retry_wait_ms: 0, trace_enabled: true, trace_dropped: 0,
    trace: Array.from({ length: metadata + body }, () => ({ event: 'attempt' })) });
  for (const [index, phase] of phases.entries()) {
    const pid = 101 + index, maxAge = index < 2 ? 300000 : 1000, session = '/owned/' + phase + '.jsonl';
    const lifecycle = [{ event: 'spawn', pid, monotonicNs: String(BigInt(index) * 20000000000n) },
      { event: 'close', pid, monotonicNs: String(BigInt(index) * 20000000000n + 10000000000n), code: 0, signal: null }];
    files[phase + '-rpc-lifecycle.json'] = lifecycle;
    files[phase + '-empty-session.json'] = { session_file: session, branch: [] };
    receipt.processes.push({ phase, pid, session_file: session, max_age_ms: maxAge });
    const wire = JSON.stringify({ messages: [{ role: 'user', content: texts.join('\n') }] }), providerFile = 'provider-00' + (index + 1) + '.json';
    files[providerFile] = wire; files['provider-index.json'].push({ file: providerFile, sha256: hash(wire), status: 200 });
    files['wire-source-assertions.json'].push({ provider_file: providerFile, present: content, absent: [] });
    receipt.proofs[phase] = providerFile;
    const paths = phase === 'cold' ? ['/v1/users/me', '/v1/pages/root/markdown', '/v1/pages/requires/markdown']
      : phase === 'full-warm' ? [] : ['/v1/users/me', '/v1/blocks/library/children', ...owners.map(owner => '/v1/pages/' + owner + (phase === 'metadata' ? '' : '/markdown'))];
    files['source-http.jsonl'].push(...paths.map(path => ({ method: 'GET', path, phase, status: 200 })));
    const value = { status: 'ready', preparation: { nodes: owners.map((owner, ownerIndex) => ({ id: owner, state: 'prepared', source: phase === 'full-warm' ? 'local_cache' : 'notion',
      binding: { snapshot_id: 'snapshot-' + owner }, body_sha256: content[ownerIndex].sha256,
      freshness: { policy: 'max_age', max_age_ms: maxAge, validated_at: new Date(index < 2 ? now : phase === 'metadata' ? now + 4000 : now + 7000).toISOString(),
        age_ms: phase === 'full-warm' ? 2000 : 0, stale: false, ...(phase === 'metadata' ? { validation: 'metadata' } : {}) },
    })) } };
    const body = phase === 'cold' ? 2 : phase === 'metadata' ? 1 : phase === 'body-expiry' ? 3 : 0, metadata = paths.length - body;
    const requestMetrics = metrics(metadata, body), operationId = phase + '-consume';
    files['sdk.jsonl'].push({ kind: 'context-broker.notion-sdk', event: 'start', id: operationId, observer_pid: pid, operation: 'consume' },
      { kind: 'context-broker.notion-sdk-result', id: operationId, observer_pid: pid, operation: 'consume', value },
      { kind: 'context-broker.notion-sdk', event: 'end', id: operationId, observer_pid: pid, operation: 'consume', status: 'completed', request_metrics: requestMetrics });
    receipt.costs.push({ phase, pid, elapsed_ms: 2000, max_age_ms: maxAge, sample_count: 1, content: content.map(({ bytes, sha256 }) => ({ bytes, sha256 })),
      total_requests: paths.length, requests: requestMetrics.requests, markdown_requests: phase === 'cold' || phase === 'body-expiry' ? 2 : 0,
      request_bytes: requestMetrics.request_bytes, response_bytes: requestMetrics.response_bytes, unknown_request_bytes: 0, unknown_response_bytes: 0, retry_wait_ms: 0 });
    files['scenario.json'].steps.push({ label: phase + ': actual body read', status: 'passed', elapsed_ms: 2000 });
    if (index === 3) files['rpc-lifecycle.json'] = lifecycle;
  }
  files['smart-revalidate.json'] = receipt;
  const save = (name, value) => writeFile(join(base, name), name.endsWith('.jsonl') ? value.map(row => JSON.stringify(row)).join('\n') + '\n' : typeof value === 'string' ? value : JSON.stringify(value));
  await writeFile(join(directory, 'result.json'), JSON.stringify({ schema: 2, status: 'passed', identity: { evidence_level: 'controlled-Pi' }, cases: [{ name, status: 'passed' }] }));
  for (const [name, value] of Object.entries(files)) await save(name, value);
  return { directory, files, save };
}

test('four-phase cost evidence requires original body times, actual expiry reads and complete new-Pi delivery', async () => {
  const fixture = await smartRevalidationEvidence();
  await verifyEvidence(fixture.directory);
  const cases = [
    ['sdk.jsonl', rows => { rows.find(row => row.id === 'metadata-consume' && row.value).value.preparation.nodes[0].freshness.validation = undefined; }],
    ['sdk.jsonl', rows => { rows.find(row => row.id === 'metadata-consume' && row.value).value.preparation.nodes[0].freshness.validated_at = new Date(1800000000000).toISOString(); }],
    ['sdk.jsonl', rows => { rows.find(row => row.id === 'metadata-consume' && row.value).value.preparation.nodes[0].body_sha256 = 'changed'; }],
    ['sdk.jsonl', rows => { rows.find(row => row.id === 'metadata-consume' && row.value).value.preparation.nodes[0].source = 'local_cache'; }],
    ['source-http.jsonl', rows => { rows.find(row => row.phase === 'metadata' && row.path === '/v1/pages/root').path += '/markdown'; }],
    ['smart-revalidate.json', row => { row.states.metadata.native[0].payload.files[0].body_verified_at++; }],
    ['smart-revalidate.json', row => { row.aging.aged.observations[0].payload.validated_at++; }],
    ['smart-revalidate.json', row => { row.aging.aged.protected_sqlite.current_facts.sha256 = 'changed'; }],
    ['smart-revalidate.json', row => { row.aging.aged.observations[0].payload.shared_body_valid_until++; }],
    ['smart-revalidate.json', row => { row.states['body-expiry'].native[0].payload.files[0].body_verified_at = row.aging.expired_body_verified_at; }],
    ['smart-revalidate.json', row => { row.costs[3].response_bytes = 0; }],
    ['smart-revalidate.json', row => { row.costs[3].total_requests--; }],
    ['smart-revalidate.json', row => { row.processes[3].pid = row.processes[2].pid; }],
    ['sdk.jsonl', rows => { rows.find(row => row.id === 'body-expiry-consume' && row.value).value.preparation.nodes[0].freshness.policy = 'refresh'; }],
    ['source-http.jsonl', rows => { rows.find(row => row.phase === 'body-expiry' && row.path === '/v1/pages/root/markdown').path = '/v1/pages/root'; }],
    ['wire-source-assertions.json', rows => { rows[3].present.pop(); }],
  ];
  for (const [name, mutate] of cases) {
    const modified = structuredClone(fixture.files[name]); mutate(modified); await fixture.save(name, modified);
    await assert.rejects(verifyEvidence(fixture.directory), name); await fixture.save(name, fixture.files[name]);
  }
});

async function smartEvidence() {
  const name = 'http-smart-current', directory = await mkdtemp(join(tmpdir(), 'current-pi-smart-evidence-test-')), base = join(directory, name);
  await mkdir(base);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const original = text => ({ text, bytes: Buffer.byteLength(text), sha256: hash(text) });
  const bodies = { a1: 'Root v1 完整正文\n', b1: 'Required v1 完整正文\n', b2: 'Required v2 完整正文\n', a3: 'Root v3 完整正文\n', c1: 'Replacement Required 完整正文\n' };
  const labels = ['cold', 'cancelled', 'recovered', 'replacement'];
  const processes = labels.map((label, index) => ({ label, pid: 100 + index, session_file: '/owned/' + label + '.jsonl' }));
  const selection = { cold: ['a1', 'b1'], cancelled: [], recovered: ['a1', 'b2'], pinned: ['a1', 'b2'], replacement: ['a3', 'c1'] };
  const files = { 'scenario.json': { status: 'passed', steps: [{ status: 'passed' }] },
    'launch.json': { source: { activation: { maxAge: '5m' }, discovery: { maxAge: '0' } } },
    'smart-current.json': { version: 1, max_age_ms: 300000, processes, proofs: {}, owners: { a: 'root', b: 'requires' } },
    'provider-index.json': [], 'wire-source-assertions.json': [], 'sdk.jsonl': [],
    'source-http.jsonl': [
      { method: 'GET', path: '/v1/pages/root/markdown', phase: 'setup', status: 200 },
      { method: 'GET', path: '/v1/pages/requires/markdown', phase: 'dirty-cancel', status: 200 },
      { method: 'GET', path: '/v1/pages/requires/markdown', phase: 'dirty-recovery', status: 429 },
      { method: 'GET', path: '/v1/pages/requires/markdown', phase: 'dirty-recovery', status: 200 },
      { method: 'GET', path: '/v1/pages/replacement/markdown', phase: 'membership-current', status: 200 },
    ] };
  for (const [index, [label, present]] of Object.entries(selection).entries()) {
    const file = `provider-${String(index + 1).padStart(3, '0')}.json`, wire = JSON.stringify({ messages: [{ content: present.map(key => bodies[key]).join('\n') }] });
    files[file] = wire; files['smart-current.json'].proofs[label] = file;
    files['provider-index.json'].push({ file, sha256: hash(wire), status: 200 });
    files['wire-source-assertions.json'].push({ provider_file: file, present: present.map(key => original(bodies[key])),
      absent: Object.keys(bodies).filter(key => !present.includes(key)).map(key => original(bodies[key])) });
  }
  for (const [index, process] of processes.entries()) {
    files[process.label === 'replacement' ? 'rpc-lifecycle.json' : process.label + '-rpc-lifecycle.json'] = [
      { event: 'spawn', pid: process.pid, monotonicNs: String(index * 3000000000) },
      { event: 'close', pid: process.pid, monotonicNs: String(index * 3000000000 + 2000000000), code: 0, signal: null },
    ];
    files[process.label + '-empty-session.json'] = { session_file: process.session_file, branch: [] };
    files['sdk.jsonl'].push({ kind: 'context-broker.notion-sdk', event: 'start', operation: 'consume', observer_pid: process.pid, id: process.label });
    if (process.label !== 'cancelled') files['sdk.jsonl'].push({ kind: 'context-broker.notion-sdk-result', operation: 'consume', observer_pid: process.pid, id: process.label,
      value: { status: 'ready', preparation: { nodes: selection[process.label].map((key, index) => ({ id: index ? 'required' : 'root', state: 'prepared',
        record: { name: index ? 'Required' : 'Current demo' }, body_sha256: hash(bodies[key]), binding: { snapshot_id: 'snapshot-' + key },
        freshness: { validated_at: new Date(1000 + index).toISOString() } })) } } });
    files['sdk.jsonl'].push({ kind: 'context-broker.notion-sdk', event: 'end', operation: 'consume', observer_pid: process.pid, id: process.label,
      status: process.label === 'cancelled' ? 'cancelled' : 'completed' });
  }
  const save = (name, value) => writeFile(join(base, name), name.endsWith('.jsonl') ? value.map(row => JSON.stringify(row)).join('\n') + '\n'
    : typeof value === 'string' ? value : JSON.stringify(value));
  await writeFile(join(directory, 'result.json'), JSON.stringify({ schema: 2, status: 'passed', identity: { evidence_level: 'controlled-Pi' }, cases: [{ name, status: 'passed' }] }));
  for (const [name, value] of Object.entries(files)) await save(name, value);
  return { directory, files, save };
}

test('smart current evidence rejects missing dirty acquisition, incomplete closure, pin rewrites and inherited sessions', async () => {
  const fixture = await smartEvidence(); await verifyEvidence(fixture.directory);
  const cases = [
    ['source-http.jsonl', rows => { rows.splice(rows.findIndex(row => row.phase === 'dirty-cancel'), 1); }],
    ['source-http.jsonl', rows => { rows.find(row => row.status === 429).status = 200; }],
    ['source-http.jsonl', rows => { rows.push({ method: 'GET', phase: 'membership-current', path: '/v1/pages/requires/markdown' }); }],
    ['sdk.jsonl', rows => { rows.find(row => row.id === 'recovered' && row.value).value.preparation.nodes.pop(); }],
    ['sdk.jsonl', rows => { rows.find(row => row.id === 'cancelled' && row.event === 'end').status = 'completed'; }],
    ['recovered-empty-session.json', row => { row.branch.push({ customType: 'context-broker-selected-graph' }); }],
    ['smart-current.json', row => { row.processes[2].pid = row.processes[0].pid; }],
  ];
  for (const [name, mutate] of cases) {
    const modified = structuredClone(fixture.files[name]); mutate(modified); await fixture.save(name, modified);
    await assert.rejects(verifyEvidence(fixture.directory), name); await fixture.save(name, fixture.files[name]);
  }
});
