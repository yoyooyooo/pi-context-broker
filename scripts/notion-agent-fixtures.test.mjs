import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, realpath, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockShape, fixtureTextMeaning, readAgentFixture, runAgentFixtureEvent, cleanupAgentFixtures, prepareAgentFilteredView } from './notion-agent-fixtures.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const exists = path => access(path).then(() => true, () => false);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, value) => writeFile(path, JSON.stringify(value) + '\n');
const execute = promisify(execFile);

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notion-agent-fixtures-test-'))), token = randomUUID(), runId = 'fixture-test';
  if (await exists('/usr/bin/trash')) t.after(() => execute('/usr/bin/trash', [root]));
  const ownership = { runId, root, token, createdAt: new Date().toISOString(), globalDirectories: [] };
  await writeJson(join(root, 'ownership.json'), ownership);
  for (const directory of ['readbacks', 'quarantine', 'state/objects', 'state/snapshots']) await mkdir(join(root, directory), { recursive: true });
  const context = { version: 1, root, runId, ownership, objects: { selected: { id: 'selected', placement: 'project', currentVersion: 'A' } }, observedReadbacks: {} };
  const bindings = { version: 1, public: {}, private: { fixture: context, objects: {
    selected: { kind: 'local', owner: 'local:' + join(root, 'SKILL.md'), currentVersion: 'A', versions: {
      A: { snapshot_id: 's_' + 'b'.repeat(64), bodyKeys: ['selected@A/SKILL.md'] },
    } },
  }, bodies: {}, facts: {}, readbacks: {} } };
  await writeJson(join(root, 'state/agent-workflow-owner.json'), { runId, fixtureRoot: root, token });
  return { root, bindings, context, state: join(root, 'state') };
}

test('projection comparison removes page identity while retaining nested text and links', () => {
  const source = [{ id: 'old', created_time: 'before', type: 'paragraph', paragraph: {
    rich_text: [{ type: 'text', text: { content: 'Read policy', link: { url: 'https://example.com/policy' } } }],
  }, children: [{ id: 'nested-old', type: 'code', code: { language: 'python', rich_text: [{ text: { content: 'print(1)' } }] } }] }];
  const restored = structuredClone(source); restored[0].id = 'new'; restored[0].created_time = 'after'; restored[0].children[0].id = 'nested-new';
  assert.deepEqual(blockShape(source), blockShape(restored));
  restored[0].children[0].code.rich_text[0].text.content = 'print(2)';
  assert.notDeepEqual(blockShape(source), blockShape(restored));
});

test('native meaning normalization permits line endings but keeps words and syntax', () => {
  assert.equal(fixtureTextMeaning('---\nname: sample\n---\n# Title\r\n\r\nBody.\r\n'), '# Title\n\nBody.');
  assert.notEqual(fixtureTextMeaning('# Title\n\nA [link](https://a.example)'), fixtureTextMeaning('# Title\n\nA [link](https://b.example)'));
});

test('readback seals the actual receipt and binds local body keys to relative paths', async t => {
  const { root, bindings, context } = await fixture(t);
  const directory = join(root, 'skill'), input = join(root, 'input.md'), content = '# Real local rule\n';
  await mkdir(directory); await writeFile(input, content); await writeFile(join(directory, 'SKILL.md'), content);
  context.objects.selected = { id: 'selected', placement: 'project', directory, currentVersion: 'A',
    versionInputs: { A: { files: [{ path: 'SKILL.md', input, sha256: hash(content), bytes: Buffer.byteLength(content), mode: '100644' }] } } };
  const result = await readAgentFixture(bindings, 'selected', { version: 'A', key: 'local-ready' });
  assert.equal(result.status, 'passed'); assert.equal(result.observed.state, 'present');
  assert.deepEqual(bindings.private.objects.selected.versions.A.bodyKeys, ['selected@A/SKILL.md']);
  assert.ok(bindings.private.bodies['selected@A/SKILL.md'].path.startsWith(root + '/oracles/'));
  assert.equal(bindings.private.bodies['selected@A/SKILL.md'].observedPath, join(directory, 'SKILL.md'));
  assert.equal(await readFile(bindings.private.bodies['selected@A/SKILL.md'].path, 'utf8'), content);
  const saved = await json(result.artifact.path), { artifact, ...receipt } = result;
  assert.deepEqual(saved, receipt); assert.equal(hash(await readFile(artifact.path)), artifact.sha256);
  await writeFile(join(directory, 'SKILL.md'), '# Changed rule\n');
  await assert.rejects(readAgentFixture(bindings, 'selected', { version: 'A' }), /differs from the chosen version/u);
});

test('unknown event and arbitrary command fields are rejected before touching state', async t => {
  const { bindings, state } = await fixture(t);
  await assert.rejects(runAgentFixtureEvent({ kind: 'shell', object: 'selected', command: 'false' }, { bindings, ownedStateRoot: state }), /Unsupported fixture event/u);
  await assert.rejects(runAgentFixtureEvent({ kind: 'fault', object: 'selected', mode: 'missing-object', command: 'false' }, { bindings, ownedStateRoot: state }), /Unknown fixture event field/u);
  assert.deepEqual(await json(join(state, 'agent-workflow-owner.json')), {
    runId: bindings.private.fixture.runId, fixtureRoot: bindings.private.fixture.root, token: bindings.private.fixture.ownership.token,
  });
});

test('missing-object event quarantines only the selected exact object', async t => {
  const { bindings, state } = await fixture(t), content = '# Selected bytes\n', digest = hash(content);
  bindings.private.bodies['selected@A/SKILL.md'] = { path: join(state, 'objects', digest), sha256: digest, bytes: content.length, object: 'selected', resourcePath: 'SKILL.md' };
  await writeFile(join(state, 'objects', digest), content); await writeFile(join(state, 'objects', 'unrelated'), 'preserve');
  const result = await runAgentFixtureEvent({ kind: 'fault', object: 'selected', mode: 'missing-object' }, { bindings, ownedStateRoot: state });
  assert.equal(result.status, 'passed'); assert.equal(await exists(join(state, 'objects', digest)), false);
  assert.equal(await readFile(result.result.quarantine, 'utf8'), content); assert.equal(await readFile(join(state, 'objects', 'unrelated'), 'utf8'), 'preserve');
  assert.equal((await json(result.artifact.path)).actor, 'fixture-controller');
});

test('foreign Store ownership blocks fault injection without moving its manifest', async t => {
  const { bindings, state } = await fixture(t), manifest = join(state, 'snapshots', 's_' + 'b'.repeat(64) + '.json');
  await writeJson(manifest, { preserved: true });
  await writeJson(join(state, 'agent-workflow-owner.json'), { runId: 'someone-else', fixtureRoot: bindings.private.fixture.root, token: bindings.private.fixture.ownership.token });
  await assert.rejects(runAgentFixtureEvent({ kind: 'fault', object: 'selected', mode: 'missing-manifest' }, { bindings, ownedStateRoot: state }));
  assert.deepEqual(await json(manifest), { preserved: true });
});

test('Store-unavailable event is reversible and cleanup requires exited subject', async t => {
  const { bindings, state } = await fixture(t);
  await writeFile(join(state, 'objects', 'preserved'), 'bytes');
  const result = await runAgentFixtureEvent({ kind: 'fault', object: 'selected', mode: 'store-unavailable' }, { bindings, ownedStateRoot: state });
  assert.equal(result.status, 'passed'); assert.equal((await json(state)).fixtureFault, bindings.private.fixture.ownership.token);
  await assert.rejects(cleanupAgentFixtures(bindings, { subjectExited: false }), /Stop the owned subject/u);
  if (!(await exists('/usr/bin/trash'))) return;
  await cleanupAgentFixtures(bindings, { subjectExited: true });
  assert.equal(await readFile(join(state, 'objects', 'preserved'), 'utf8'), 'bytes');
});

test('external builtin bindings cannot be mutated or included in cleanup writes', async t => {
  const { bindings } = await fixture(t), context = bindings.private.fixture;
  context.objects.selected = { id: 'selected', placement: 'builtin', external: true, readOnly: true };
  await assert.rejects(runAgentFixtureEvent({ kind: 'remove-owned', object: 'selected' }, { bindings }), /read-only/u);
  if (!(await exists('/usr/bin/trash'))) return;
  const cleanup = await cleanupAgentFixtures(bindings, { subjectExited: true });
  assert.deepEqual(cleanup.results, [{ object: 'selected', action: 'external-read-only-preserved', status: 'passed' }]);
});


test('bounded reader retries and repeated teardown do not resurrect a retired Source', async t => {
  if (!(await exists('/usr/bin/trash'))) return;
  const { bindings, context } = await fixture(t);
  const sourcePageId = '11111111-1111-1111-1111-111111111111', skillPageId = '22222222-2222-2222-2222-222222222222';
  const filePageId = '33333333-3333-3333-3333-333333333333', recordPageId = '44444444-4444-4444-4444-444444444444';
  context.objects.selected = { id: 'selected', placement: 'source', sourceId: 'owned-source', sourcePageId, pageId: skillPageId,
    knownChildren: [{ kind: 'file', pageId: filePageId }], sourceRecordIds: [recordPageId] };
  context.library = { sources: { property_ids: { 'Source ID': 'source-id' } },
    records: { data_source_id: '55555555-5555-5555-5555-555555555555', property_ids: { Origin: 'origin' } } };
  const previousFetch = globalThis.fetch, previousToken = process.env.NOTION_API_TOKEN, reads = [];
  process.env.NOTION_API_TOKEN = 'fixture-unit-test-token';
  let transportFailures = 0;
  globalThis.fetch = async (url, options) => {
    if (transportFailures++ < 2) throw new TypeError('controlled read transport failure');
    const pathname = new URL(url).pathname;
    if (options.method === 'POST') {
      assert.ok(pathname.endsWith('/query'), 'Teardown must not create anything after Source retirement');
      return Response.json({ results: [], has_more: false });
    }
    assert.equal(options.method, 'GET', 'Teardown must not mutate an already retired Source');
    const id = pathname.split('/').at(-1);
    assert.ok([sourcePageId, skillPageId, filePageId, recordPageId].includes(id)); reads.push(id);
    return Response.json({ id, in_trash: true, properties: id === sourcePageId ? {
      'Source ID': { id: 'source-id', rich_text: [{ plain_text: 'owned-source' }] },
    } : {} });
  };
  try {
    for (let count = 0; count < 2; count++) {
      const result = await cleanupAgentFixtures(bindings, { subjectExited: true });
      assert.deepEqual(result.results[0].commands, []);
      const proof = await json(result.results[0].readback.path);
      assert.deepEqual(proof.retired.map(row => row.id).sort(), [sourcePageId, skillPageId, filePageId, recordPageId].sort());
    }
    assert.equal(reads.length, 10);
    const attempts = (await readFile(join(context.root, 'network-attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(attempts.slice(0, 3).map(value => [value.attempt, value.retry]), [[1, true], [2, true], [3, false]]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.NOTION_API_TOKEN; else process.env.NOTION_API_TOKEN = previousToken;
  }
});

test('View teardown refuses an identity from the pre-existing view inventory', async t => {
  if (!(await exists('/usr/bin/trash'))) return;
  const { bindings, context } = await fixture(t), viewId = '11111111-1111-1111-1111-111111111111';
  context.library = { skills: { database_id: '22222222-2222-2222-2222-222222222222' } };
  context.viewId = viewId; context.view = { name: 'fixture-owned-name', originalViewIds: [viewId] };
  const previousFetch = globalThis.fetch, previousToken = process.env.NOTION_API_TOKEN;
  process.env.NOTION_API_TOKEN = 'fixture-unit-test-token';
  globalThis.fetch = async (url, options) => {
    assert.equal(options.method, 'GET'); assert.equal(new URL(url).pathname, '/v1/views');
    return Response.json({ results: [{ id: viewId }], has_more: false });
  };
  try { await assert.rejects(cleanupAgentFixtures(bindings, { subjectExited: true }), /Never delete a pre-existing View/u); }
  finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.NOTION_API_TOKEN; else process.env.NOTION_API_TOKEN = previousToken;
  }
});


test('an unknown View CREATE outcome is recorded and never automatically replayed', async t => {
  const { bindings, context } = await fixture(t), databaseId = '11111111-1111-1111-1111-111111111111';
  context.entry = databaseId;
  context.library = { skills: { database_id: databaseId, data_source_id: '22222222-2222-2222-2222-222222222222', property_ids: { 'Skill ID': 'skill-id' } } };
  const previousFetch = globalThis.fetch, previousToken = process.env.NOTION_API_TOKEN;
  process.env.NOTION_API_TOKEN = 'fixture-unit-test-token'; let creates = 0;
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return Response.json({ results: [{ id: '33333333-3333-3333-3333-333333333333' }], has_more: false });
    assert.equal(options.method, 'POST'); creates++; throw new TypeError('controlled unknown create outcome');
  };
  try {
    await assert.rejects(prepareAgentFilteredView(bindings), error => error.code === 'AGENT_FIXTURE_NOTION_TRANSPORT'
      && error.details.outcome === 'unknown-no-automatic-replay' && error.details.attempt === 1);
    assert.equal(creates, 1);
    assert.equal((await json(join(context.root, 'bindings.json'))).private.fixture.view.name, context.view.name, 'Ownership intent must survive an unknown response');
    const attempts = (await readFile(join(context.root, 'network-attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(attempts.at(-1).retry, false); assert.equal(attempts.at(-1).readOnly, false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.NOTION_API_TOKEN; else process.env.NOTION_API_TOKEN = previousToken;
  }
});


test('Source lifecycle events require an owned Source and a verified pending intent', async t => {
  const { bindings } = await fixture(t);
  await assert.rejects(runAgentFixtureEvent({ kind: 'interrupt-source-write', object: 'selected' }, { bindings }), /source/u);
  bindings.private.fixture.objects.selected = { id: 'selected', placement: 'source', currentVersion: 'absent' };
  await assert.rejects(runAgentFixtureEvent({ kind: 'resume-source-write', object: 'selected' }, { bindings }), /verified real interruption/u);
  assert.equal(bindings.private.fixture.objects.selected.sourceOperation, undefined);
});
