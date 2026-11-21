import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, realpath, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockShape, fixtureTextMeaning, readAgentFixture, runAgentFixtureEvent, cleanupAgentFixtures } from './notion-agent-fixtures.mjs';

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
