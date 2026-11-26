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
