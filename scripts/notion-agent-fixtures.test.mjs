import test from 'node:test';
import { isAgentSourceHandoff } from './notion-agent-source-handoff.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, realpath, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentFixtureObjectContext, blockShape, readAgentFixture, runAgentFixtureEvent, cleanupAgentFixtures, prepareAgentFilteredView, prepareAgentFixtures } from './notion-agent-fixtures.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const exists = path => access(path).then(() => true, () => false);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, value) => writeFile(path, JSON.stringify(value) + '\n');
const execute = promisify(execFile);
const fixtureLibraryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

async function storeProbeFixture(t, { faultResponse = 'unavailable' } = {}) {
  const value = await fixture(t), { root, state, context, bindings } = value, content = '# Exact selected rule\n';
  await mkdir(join(root, 'commands'));
  context.node = process.execPath; context.cli = join(root, 'public-read.mjs');
  const selected = bindings.private.objects.selected, version = selected.versions.A;
  selected.scope = 'a'.repeat(64); version.version_id = 'c'.repeat(64);
  const digest = hash(content);
  bindings.private.bodies['selected@A/SKILL.md'] = { path: join(state, 'objects', digest), sha256: digest, bytes: Buffer.byteLength(content), object: 'selected', resourcePath: 'SKILL.md' };
  await writeFile(join(state, 'objects', digest), content); await writeFile(join(state, 'state.sqlite'), 'unit SQLite placeholder');
  const result = { ok: true, record: { id: selected.owner }, scope: selected.scope, snapshot_id: version.snapshot_id, version_id: version.version_id,
    path: 'SKILL.md', content, has_more: false, effects: { remote_writes: 'none' }, request_metrics: { total_requests: 0 } };
  await writeFile(context.cli, "import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {join} from 'node:path';\n"
    + 'assert.deepEqual(process.argv.slice(2),' + JSON.stringify(['read', version.snapshot_id, '--offline', '--json', '--metrics']) + ');\n'
    + 'const success=' + JSON.stringify(result) + ';let value=success;try{await readFile(join(process.env.NTN_SKILLS_HOME,"state.sqlite"));}'
    + 'catch(error){assert.equal(error.code,"ENOTDIR");if(' + JSON.stringify(faultResponse) + '!=="unexpected-success"){value={ok:false,error:{code:'
    + JSON.stringify(faultResponse === 'wrong-error' ? 'AUTHENTICATION_FAILED' : 'STATE_UNAVAILABLE')
    + ',details:{phase:"sqlite_state",native_code:"ENOTDIR"}}};process.exitCode=1;}}console.log(JSON.stringify(value));\n');
  return { ...value, runtimeEnv: { NTN_SKILLS_HOME: state, NTN_SKILLS_CONFIG_HOME: join(root, 'runtime-config'),
    NTN_SKILLS_CACHE_HOME: join(root, 'runtime-cache'), NTN_SKILLS_DATA_HOME: join(root, 'runtime-data'), NOTION_API_TOKEN: 'private-unit-test-secret' } };
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

test('fixture teardown retains temporary operation inputs and records their ownership with the evidence', async t => {
  const { root, bindings, context } = await fixture(t);
  context.objects = {};
  context.ownership.temporaryRoot = join(root, 'temporary');
  await mkdir(context.ownership.temporaryRoot);
  await writeJson(join(root, 'ownership.json'), context.ownership);
  const input = join(context.ownership.temporaryRoot, 'unfinished-operation-input.md'), content = '# Exact resumable input\n';
  await writeFile(input, content);
  await writeJson(join(root, 'bindings.json'), bindings); const before = await readFile(join(root, 'bindings.json'));
  await assert.rejects(cleanupAgentFixtures(bindings, { subjectExited: false }), /Stop the owned subject/u);
  // No disposable objects exist: the executable must never be invoked for retained evidence.
  const result = await cleanupAgentFixtures(bindings, { subjectExited: true, trash: process.execPath, preserveBindings: true });
  assert.deepEqual(result.results, []);
  assert.equal(result.retainedEvidence.temporaryRoot, context.ownership.temporaryRoot);
  assert.equal(result.retainedEvidence.policy, 'retain-inputs-oracles-stores-and-temporary-files');
  assert.equal(await readFile(input, 'utf8'), content);
  assert.deepEqual(await readFile(join(root, 'bindings.json')), before);
  const receipt = await json(result.artifact.path);
  assert.deepEqual(receipt.retainedEvidence, result.retainedEvidence);
  assert.equal(hash(await readFile(result.artifact.path)), result.artifact.sha256);
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

test('a supplemental full readback can preserve the original binding bytes', async t => {
  const { root, bindings, context } = await fixture(t), directory = join(root, 'skill'), content = '# Preserved history\n';
  await mkdir(directory); const input = join(directory, 'SKILL.md'); await writeFile(input, content);
  context.objects.selected = { id: 'selected', placement: 'project', directory, currentVersion: 'A',
    versionInputs: { A: { files: [{ path: 'SKILL.md', input, sha256: hash(content), bytes: Buffer.byteLength(content), mode: '100644' }] } } };
  const path = join(root, 'bindings.json'); await writeJson(path, bindings); const original = await readFile(path);
  const result = await readAgentFixture(bindings, 'selected', { version: 'A', preserveBindings: true });
  assert.deepEqual(await readFile(path), original);
  assert.equal(result.status, 'passed'); assert.equal((await json(result.artifact.path)).status, 'passed');
  assert.ok(bindings.private.bodies['selected@A/SKILL.md'], 'Observed identities remain available for a separate supplemental binding');
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

test('Store-unavailable proves the same selected public read fails and recovers without exposing runtime secrets', async t => {
  const { bindings, state, runtimeEnv } = await storeProbeFixture(t);
  await writeFile(join(state, 'objects', 'preserved'), 'bytes');
  const result = await runAgentFixtureEvent({ kind: 'fault', object: 'selected', mode: 'store-unavailable' }, { bindings, ownedStateRoot: state, runtimeEnv });
  assert.equal(result.status, 'passed'); assert.equal((await json(state)).fixtureFault, bindings.private.fixture.ownership.token);
  const fault = bindings.private.fixture.faults[0];
  assert.equal(fault.status, 'active'); assert.equal(fault.proof.before.status, 'passed'); assert.equal(fault.proof.after.status, 'failed');
  assert.equal(fault.proof.after.code, 'STATE_UNAVAILABLE'); assert.equal(fault.proof.blocker.readError, 'ENOTDIR');
  assert.equal(hash(await readFile(fault.proof.before.command.path)), fault.proof.before.command.sha256);
  assert.equal(hash(await readFile(fault.proof.after.command.path)), fault.proof.after.command.sha256);
  assert.equal(hash(await readFile(fault.proof.blocker.artifact.path)), fault.proof.blocker.artifact.sha256);
  assert.doesNotMatch(JSON.stringify(bindings), /private-unit-test-secret/u);
  const originalActiveBindings = structuredClone(bindings);
  await assert.rejects(cleanupAgentFixtures(bindings, { subjectExited: false }), /Stop the owned subject/u);
  if (!(await exists('/usr/bin/trash'))) return;
  await cleanupAgentFixtures(bindings, { subjectExited: true });
  assert.equal(await readFile(join(state, 'objects', 'preserved'), 'utf8'), 'bytes');
  assert.equal(fault.status, 'restored'); assert.equal(fault.restoration.status, 'passed');
  assert.equal(hash(await readFile(fault.restoration.command.path)), fault.restoration.command.sha256);
  assert.equal(hash(await readFile(fault.proof.blocker.artifact.path)), fault.proof.blocker.artifact.sha256, 'Fault evidence must survive Store restoration');
  assert.deepEqual(fault.restoration.observed, fault.proof.before.observed);
  await cleanupAgentFixtures(originalActiveBindings, { subjectExited: true, preserveBindings: true });
  assert.equal(originalActiveBindings.private.fixture.faults[0].status, 'restored', 'A repeated historical teardown must prove the already restored Store again');
});

test('Store outage refuses a different runtime root before moving owned state', async t => {
  const { bindings, state, runtimeEnv } = await storeProbeFixture(t);
  await assert.rejects(runAgentFixtureEvent({ kind: 'fault', object: 'selected', mode: 'store-unavailable' },
    { bindings, ownedStateRoot: state, runtimeEnv: { ...runtimeEnv, NTN_SKILLS_HOME: state + '-other' } }), /actual subject Store environment/u);
  assert.equal(await readFile(join(state, 'state.sqlite'), 'utf8'), 'unit SQLite placeholder');
  assert.equal(bindings.private.fixture.faults, undefined);
});

test('an already unreadable selected body cannot establish a Store outage precondition', async t => {
  const { bindings, state, runtimeEnv } = await storeProbeFixture(t);
  bindings.private.bodies['selected@A/SKILL.md'].sha256 = 'f'.repeat(64);
  await assert.rejects(runAgentFixtureEvent({ kind: 'fault', object: 'selected', mode: 'store-unavailable' }, { bindings, ownedStateRoot: state, runtimeEnv }));
  assert.equal(await readFile(join(state, 'state.sqlite'), 'utf8'), 'unit SQLite placeholder');
  assert.equal(bindings.private.fixture.faults, undefined);
});

for (const faultResponse of ['unexpected-success', 'wrong-error']) test('Store outage does not accept ' + faultResponse + ' as storage failure', async t => {
  const { bindings, state, runtimeEnv } = await storeProbeFixture(t, { faultResponse });
  await assert.rejects(runAgentFixtureEvent({ kind: 'fault', object: 'selected', mode: 'store-unavailable' }, { bindings, ownedStateRoot: state, runtimeEnv }));
  const fault = bindings.private.fixture.faults[0];
  assert.equal(fault.status, 'quarantined', 'An unverified fault must not admit the runtime recovery barrier');
  assert.equal(fault.proof.after, undefined);
  if (!(await exists('/usr/bin/trash'))) return;
  await cleanupAgentFixtures(bindings, { subjectExited: true });
  assert.equal(fault.status, 'restored'); assert.equal(await readFile(join(state, 'state.sqlite'), 'utf8'), 'unit SQLite placeholder');
});

test('external builtin bindings cannot be mutated or included in cleanup writes', async t => {
  const { bindings } = await fixture(t), context = bindings.private.fixture;
  context.objects.selected = { id: 'selected', placement: 'builtin', external: true, readOnly: true };
  await assert.rejects(runAgentFixtureEvent({ kind: 'remove-owned', object: 'selected' }, { bindings }), /read-only/u);
  if (!(await exists('/usr/bin/trash'))) return;
  const cleanup = await cleanupAgentFixtures(bindings, { subjectExited: true });
  assert.deepEqual(cleanup.results, [{ object: 'selected', action: 'external-read-only-preserved', status: 'passed' }]);
});

test('historical teardown can preserve its original binding bytes while recording new control state', async t => {
  if (!(await exists('/usr/bin/trash'))) return;
  const { root, bindings, context } = await fixture(t), directory = join(root, 'owned-project-skill');
  await mkdir(directory); await writeFile(join(directory, 'SKILL.md'), '# Original rule\n');
  await writeJson(join(directory, '.agent-workflow-owner.json'), { runId: context.runId, token: context.ownership.token });
  context.objects.selected = { id: 'selected', placement: 'project', directory };
  await writeJson(join(root, 'bindings.json'), bindings);
  const before = await readFile(join(root, 'bindings.json'));
  context.cli = join(root, 'frozen-selected-cli.js');
  const cleanup = await cleanupAgentFixtures(bindings, { subjectExited: true, preserveBindings: true });
  assert.equal(await exists(directory), false);
  assert.equal(hash(await readFile(join(root, 'bindings.json'))), hash(before), 'The original evidence must not be rewritten');
  assert.ok(cleanup.bindingsArtifacts.length > 0);
  const recorded = await json(cleanup.bindingsArtifacts.at(-1).path);
  assert.equal(recorded.private.fixture.cli, context.cli);
  assert.equal(hash(await readFile(cleanup.bindingsArtifacts.at(-1).path)), cleanup.bindingsArtifacts.at(-1).sha256);
  assert.deepEqual((await json(cleanup.artifact.path)).bindingsArtifacts, cleanup.bindingsArtifacts);
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

test('preserved historical Source bindings stay immutable through its ownership checkpoint', async t => {
  if (!(await exists('/usr/bin/trash'))) return;
  const { root, bindings, context } = await fixture(t);
  context.objects.selected = { id: 'selected', placement: 'source', sourceId: 'owned-source', skillId: 'owned-skill', currentVersion: 'absent' };
  context.library = {
    skills: { data_source_id: '11111111-1111-1111-1111-111111111111', property_ids: { 'Skill ID': 'skill-id' } },
    sources: { data_source_id: '22222222-2222-2222-2222-222222222222', property_ids: { 'Source ID': 'source-id' } },
  };
  await writeJson(join(root, 'bindings.json'), bindings); const originalHash = hash(await readFile(join(root, 'bindings.json')));
  context.cli = join(root, 'frozen-selected-cli.js');
  const previousFetch = globalThis.fetch, previousToken = process.env.NOTION_API_TOKEN;
  process.env.NOTION_API_TOKEN = 'fixture-unit-test-token';
  globalThis.fetch = async (url, options) => {
    assert.equal(options.method, 'POST'); assert.ok(new URL(url).pathname.endsWith('/query'));
    return Response.json({ results: [], has_more: false });
  };
  try {
    const result = await cleanupAgentFixtures(bindings, { subjectExited: true, preserveBindings: true });
    assert.equal(result.bindingsArtifacts.length, 2, 'Keep both the ownership checkpoint and final state');
    assert.equal(hash(await readFile(join(root, 'bindings.json'))), originalHash);
    for (const checkpoint of result.bindingsArtifacts) assert.equal((await json(checkpoint.path)).private.fixture.cli, context.cli);
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


test('View teardown preserves the immediate non-owned inventory across independent fixture lifetimes', async t => {
  if (!(await exists('/usr/bin/trash'))) return;
  for (const mode of ['unchanged', 'reordered', 'lost']) await t.test(mode, async t => {
    const { bindings, context } = await fixture(t);
    const databaseId = '11111111-1111-1111-1111-111111111111', ownedId = '22222222-2222-2222-2222-222222222222';
    const userA = '33333333-3333-3333-3333-333333333333', userB = '44444444-4444-4444-4444-444444444444';
    const retiredOther = '55555555-5555-5555-5555-555555555555', newerOther = '66666666-6666-6666-6666-666666666666';
    context.libraryId = fixtureLibraryId; context.library = { skills: { database_id: databaseId } }; context.objects = {};
    context.viewId = ownedId; context.view = { name: 'owned-view', originalViewIds: [userA, retiredOther, userB] };
    const before = [userA, newerOther, ownedId, userB], preserved = [userA, newerOther, userB];
    const after = mode === 'unchanged' ? preserved : mode === 'reordered' ? [userB, newerOther, userA] : [userA, newerOther];
    const previousFetch = globalThis.fetch, previousToken = process.env.NOTION_API_TOKEN; let lists = 0, deletes = 0;
    process.env.NOTION_API_TOKEN = 'fixture-unit-test-token';
    globalThis.fetch = async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/v1/views') {
        assert.equal(options.method, 'GET');
        return Response.json({ results: (++lists === 1 ? before : after).map(id => ({ id })), has_more: false });
      }
      assert.equal(pathname, '/v1/views/' + ownedId, 'Only the exact owned View can be addressed');
      if (options.method === 'DELETE') { deletes++; return Response.json({ id: ownedId }); }
      assert.equal(options.method, 'GET');
      return Response.json({ id: ownedId, name: 'owned-view', parent: { database_id: databaseId } });
    };
    try {
      if (mode === 'unchanged') {
        const result = await cleanupAgentFixtures(bindings, { subjectExited: true });
        assert.equal(result.results[0].status, 'passed');
        const proof = await json(result.results[0].artifact.path);
        assert.deepEqual(proof.after.map(view => view.id), preserved);
      } else await assert.rejects(cleanupAgentFixtures(bindings, { subjectExited: true }), /View cleanup changed/u);
      assert.equal(deletes, 1); assert.equal(lists, 2);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousToken === undefined) delete process.env.NOTION_API_TOKEN; else process.env.NOTION_API_TOKEN = previousToken;
    }
  });
});

test('fixture mutations retry an explicit rate-limit rejection within one budget', async t => {
  for (const mode of ['recover', 'server-error', 'exhausted', 'long-delay']) await t.test(mode, async t => {
    const { root, bindings, context } = await fixture(t);
    const databaseId = '11111111-1111-1111-1111-111111111111', ownedId = '22222222-2222-2222-2222-222222222222';
    const originalId = '33333333-3333-3333-3333-333333333333';
    context.libraryId = fixtureLibraryId;
    context.library = { skills: { database_id: databaseId, data_source_id: '44444444-4444-4444-4444-444444444444', property_ids: { 'Skill ID': 'skill-id' } } };
    context.node = process.execPath; context.cli = join(root, 'filtered-list.mjs');
    await mkdir(join(root, 'commands'));
    await writeFile(context.cli, 'console.log(JSON.stringify({ok:true,has_more:false,coverage:{exhaustive:true,failed_sources:[]},records:[]}));\n');
    const previousFetch = globalThis.fetch, previousToken = process.env.NOTION_API_TOKEN, calls = [];
    process.env.NOTION_API_TOKEN = 'fixture-unit-test-token'; let created = false;
    globalThis.fetch = async (url, options) => {
      const pathname = new URL(url).pathname;
      if (options.method === 'GET' && pathname === '/v1/views')
        return Response.json({ results: [originalId, ...(created ? [ownedId] : [])].map(id => ({ id })), has_more: false });
      if (options.method === 'GET') {
        assert.equal(pathname, '/v1/views/' + ownedId);
        return Response.json({ id: ownedId, name: context.view.name, parent: { database_id: databaseId } });
      }
      assert.equal(options.method, 'POST'); assert.equal(pathname, '/v1/views');
      calls.push({ at: performance.now(), body: options.body });
      if (mode === 'server-error') return Response.json({ code: 'internal_server_error' }, { status: 500 });
      if (mode !== 'recover' || calls.length === 1)
        return Response.json({ code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': mode === 'long-delay' ? '181' : mode === 'recover' ? '2.01' : '0.001' } });
      created = true; return Response.json({ id: ownedId });
    };
    try {
      if (mode === 'recover') {
        const result = await prepareAgentFilteredView(bindings);
        assert.equal(result.status, 'passed'); assert.equal(result.id, ownedId);
        assert.equal(calls.length, 2); assert.equal(calls[0].body, calls[1].body);
        assert.ok(calls[1].at - calls[0].at >= 2005, 'Honor the server delay instead of capping it at two seconds');
      } else {
        await assert.rejects(prepareAgentFilteredView(bindings), error => error.code === 'AGENT_FIXTURE_NOTION_READBACK');
        assert.equal(calls.length, mode === 'exhausted' ? 3 : 1);
      }
      const attempts = (await readFile(join(root, 'network-attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).filter(row => !row.readOnly);
      assert.equal(attempts.length, calls.length);
      assert.deepEqual(attempts.map(row => row.retry), mode === 'recover' ? [true, false] : mode === 'exhausted' ? [true, true, false] : [false]);
      if (mode === 'recover') assert.equal(attempts[0].retryDelayMs, 2010);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousToken === undefined) delete process.env.NOTION_API_TOKEN; else process.env.NOTION_API_TOKEN = previousToken;
    }
  });
});

test('a rate-limit wait cannot dispatch another fixture write after the total deadline', async t => {
  const { bindings, context } = await fixture(t), databaseId = '11111111-1111-1111-1111-111111111111';
  context.libraryId = fixtureLibraryId;
  context.library = { skills: { database_id: databaseId, data_source_id: '22222222-2222-2222-2222-222222222222', property_ids: { 'Skill ID': 'skill-id' } } };
  const previousFetch = globalThis.fetch, previousToken = process.env.NOTION_API_TOKEN, originalTimeout = setTimeout;
  process.env.NOTION_API_TOKEN = 'fixture-unit-test-token'; let now = 0, creates = 0;
  const time = t.mock.method(performance, 'now', () => now);
  const wait = t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 1000) { now = 180001; return originalTimeout(callback, 0, ...args); }
    return originalTimeout(callback, delay, ...args);
  });
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return Response.json({ results: [{ id: '33333333-3333-3333-3333-333333333333' }], has_more: false });
    creates++;
    if (creates > 1) throw new Error('A late fixture write escaped the total deadline');
    return Response.json({ code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '1' } });
  };
  try {
    await assert.rejects(prepareAgentFilteredView(bindings), error => error.code === 'AGENT_FIXTURE_NOTION_BUDGET');
    assert.equal(creates, 1);
  } finally {
    time.mock.restore(); wait.mock.restore(); globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.NOTION_API_TOKEN; else process.env.NOTION_API_TOKEN = previousToken;
  }
});

test('an unknown View CREATE outcome is recorded and never automatically replayed', async t => {
  const { bindings, context } = await fixture(t), databaseId = '11111111-1111-1111-1111-111111111111';
  context.libraryId = fixtureLibraryId;
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


// Only the control-plane trash event uses this finite API double; it is not live acceptance.
async function projectionTrashHarness(t, { target = 'block', mode = 'lost-trashed' } = {}) {
  const value = await fixture(t), { root, context, bindings } = value;
  const owner = '11111111-1111-4111-8111-111111111111', first = '22222222-2222-4222-8222-222222222222';
  const second = '33333333-3333-4333-8333-333333333333', other = '44444444-4444-4444-8444-444444444444';
  const targetId = target === 'block' ? first : owner, calls = [], trashed = new Set();
  const text = value => ({ rich_text: [{ plain_text: value }] });
  const page = () => ({ object: 'page', id: owner, in_trash: trashed.has(owner), archived: trashed.has(owner),
    properties: { 'Skill ID': text('owned-projection'), 'Current State': text('ready'), Operation: text('') } });
  const block = id => ({ object: 'block', id, parent: { type: 'page_id', page_id: owner },
    in_trash: trashed.has(id), archived: trashed.has(id), type: 'paragraph', has_children: false,
    paragraph: { rich_text: [{ type: 'text', text: { content: 'Generated reading body' } }] } });
  context.libraryId = fixtureLibraryId; context.apiVersion = '2026-03-11'; context.node = process.execPath;
  context.cli = join(root, 'projection-read.mjs');
  context.library = { skills: { property_ids: { 'Skill ID': 'skill-id', 'Current State': 'state', Operation: 'operation' } },
    files: { data_source_id: '55555555-5555-4555-8555-555555555555', property_ids: { Skill: 'skill' } },
    records: { data_source_id: '66666666-6666-4666-8666-666666666666', property_ids: { Skill: 'skill' } } };
  context.objects.selected = { id: 'selected', placement: 'source', pageId: owner, skillId: 'owned-projection',
    currentVersion: 'A', versionInputs: { A: { files: [] } } };
  bindings.private.objects.selected = { kind: 'notion', owner: 'owned-projection', versions: {} };
  await mkdir(join(root, 'commands'));
  const main = { ok: true, has_more: false, path: 'SKILL.md', content: '# Source instruction\n', ref: 'unit-ref',
    snapshot_id: 'unit-snapshot', version_id: 'unit-version', scope: 'unit-scope',
    record: { id: 'owned-projection', name: 'Projection fixture', locator: { page_id: owner, skill_id: 'owned-projection' } },
    effects: { remote_writes: 'none' } };
  await writeFile(context.cli, "import assert from 'node:assert/strict';const args=process.argv.slice(2);"
    + "assert.ok(['read','files'].includes(args[0]));console.log(JSON.stringify(args[0]==='read'?"
    + JSON.stringify(main) + ":" + JSON.stringify({ ok: true, files: [{ path: 'SKILL.md', mode: '100644' }] }) + "));\n");
  const previousFetch = globalThis.fetch, previousToken = process.env.NOTION_API_TOKEN;
  process.env.NOTION_API_TOKEN = 'fixture-unit-test-token';
  let targetPatched = false;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname, id = path.split('/').at(-1);
    calls.push({ method: options.method, path });
    if (options.method === 'POST') {
      assert.ok(path.endsWith('/query')); return Response.json({ results: [], has_more: false });
    }
    if (options.method === 'PATCH') {
      assert.ok([owner, first, second].includes(id)); assert.deepEqual(JSON.parse(options.body), { in_trash: true });
      if (id === targetId && mode.startsWith('http-'))
        return Response.json({ code: 'controlled_rejection' }, { status: Number(mode.slice(5)) });
      if (id !== targetId || mode !== 'lost-live') trashed.add(id);
      if (id === targetId && mode !== 'ack') {
        targetPatched = true;
        throw new TypeError('controlled lost trash acknowledgement', { cause: { code: 'UND_ERR_SOCKET' } });
      }
      return Response.json(id === owner ? page() : block(id));
    }
    assert.equal(options.method, 'GET');
    if (path === '/v1/blocks/' + owner + '/children')
      return Response.json({ results: [first, second].filter(id => !trashed.has(id)).map(block), has_more: false });
    assert.ok(path === '/v1/pages/' + owner || path === '/v1/blocks/' + first);
    const row = id === owner ? page() : block(id);
    if (targetPatched && id === targetId) {
      if (mode === 'get-fail') throw new TypeError('controlled confirmation read failure', { cause: { code: 'UND_ERR_SOCKET' } });
      if (mode === 'wrong-id') row.id = other;
      if (mode === 'wrong-kind') row.object = target === 'block' ? 'page' : 'block';
      if (mode === 'wrong-parent') row.parent.page_id = other;
      if (mode === 'wrong-skill') row.properties['Skill ID'] = text('someone-else');
      if (mode === 'incomplete') { delete row.in_trash; delete row.archived; }
      if (mode === 'lost-trashed') {
        row.id = row.id.replaceAll('-', '').toUpperCase();
        if (row.parent) row.parent.page_id = row.parent.page_id.replaceAll('-', '').toUpperCase();
      }
    }
    return Response.json(row);
  };
  t.after(() => { globalThis.fetch = previousFetch; if (previousToken === undefined) delete process.env.NOTION_API_TOKEN; else process.env.NOTION_API_TOKEN = previousToken; });
  return { ...value, calls, targetId, owner, first, second };
}

test('projection trash observes a lost acknowledgement without replaying the exact mutation', async t => {
  for (const target of ['block', 'page']) await t.test(target, async t => {
    const { bindings, root, calls, targetId } = await projectionTrashHarness(t, { target });
    const result = await runAgentFixtureEvent({ kind: 'trash-projection', object: 'selected' }, { bindings });
    assert.equal(result.status, 'passed');
    const [confirmation] = result.result.confirmations;
    assert.equal(result.result.confirmations.length, 1); assert.equal(confirmation.status, 'observed-state');
    assert.equal(confirmation.acknowledgement, 'unknown');
    assert.equal(confirmation.originalError.code, 'AGENT_FIXTURE_NOTION_TRANSPORT');
    assert.equal(confirmation.originalError.details.outcome, 'unknown-no-automatic-replay');
    assert.equal(confirmation.readback.in_trash, true);
    const targetCalls = calls.filter(call => call.path.endsWith('/' + targetId));
    assert.equal(targetCalls.filter(call => call.method === 'PATCH').length, 1);
    assert.equal(targetCalls.filter(call => call.method === 'GET').length, target === 'block' ? 1 : 3);
    assert.equal(calls.filter(call => call.method === 'PATCH').length, 3);
    assert.deepEqual((await json(result.artifact.path)).result.confirmations, result.result.confirmations);
    const attempts = (await readFile(join(root, 'network-attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const failed = attempts.filter(row => row.method === 'PATCH' && row.error);
    assert.equal(failed.length, 1); assert.equal(failed[0].status, null); assert.equal(failed[0].retry, false);
  });
});

test('projection trash keeps the original unknown outcome when exact readback is live', async t => {
  for (const target of ['block', 'page']) await t.test(target, async t => {
    const { bindings, calls, targetId } = await projectionTrashHarness(t, { target, mode: 'lost-live' });
    let failure;
    await assert.rejects(runAgentFixtureEvent({ kind: 'trash-projection', object: 'selected' }, { bindings }), error => {
      failure = error; return error.code === 'AGENT_FIXTURE_NOTION_TRANSPORT' && error.details.outcome === 'unknown-no-automatic-replay';
    });
    const recorded = await json(failure.fixtureEventArtifact), [confirmation] = recorded.result.confirmations;
    assert.equal(recorded.status, 'failed'); assert.deepEqual(recorded.error, confirmation.originalError);
    assert.equal(confirmation.status, 'failed'); assert.equal(confirmation.readback.in_trash, false);
    assert.ok(confirmation.error.message.includes('trashed'));
    assert.equal(calls.filter(call => call.method === 'PATCH' && call.path.endsWith('/' + targetId)).length, 1);
    assert.equal(calls.filter(call => call.method === 'PATCH').length, target === 'block' ? 1 : 3, 'Do not continue the remaining trash steps');
  });
});

test('projection trash rejects foreign or incomplete confirmation identities', async t => {
  const cases = [{ target: 'block', mode: 'wrong-id' }, { target: 'block', mode: 'wrong-kind' },
    { target: 'block', mode: 'wrong-parent' }, { target: 'block', mode: 'incomplete' },
    { target: 'page', mode: 'wrong-id' }, { target: 'page', mode: 'wrong-kind' },
    { target: 'page', mode: 'wrong-skill' }, { target: 'page', mode: 'incomplete' }];
  for (const options of cases) await t.test(options.target + ':' + options.mode, async t => {
    const { bindings, calls, targetId } = await projectionTrashHarness(t, options); let failure;
    await assert.rejects(runAgentFixtureEvent({ kind: 'trash-projection', object: 'selected' }, { bindings }), error => {
      failure = error; return error.code === 'AGENT_FIXTURE_NOTION_TRANSPORT' && error.details.outcome === 'unknown-no-automatic-replay';
    });
    const recorded = await json(failure.fixtureEventArtifact), [confirmation] = recorded.result.confirmations;
    assert.equal(recorded.status, 'failed'); assert.deepEqual(recorded.error, confirmation.originalError);
    assert.equal(confirmation.status, 'failed'); assert.ok(confirmation.error);
    assert.equal(calls.filter(call => call.method === 'PATCH' && call.path.endsWith('/' + targetId)).length, 1);
  });
});

test('projection trash bounds a failed confirmation read and preserves the original write error', async t => {
  for (const target of ['block', 'page']) await t.test(target, async t => {
    const { bindings, root, calls, targetId } = await projectionTrashHarness(t, { target, mode: 'get-fail' }); let failure;
    await assert.rejects(runAgentFixtureEvent({ kind: 'trash-projection', object: 'selected' }, { bindings }), error => {
      failure = error; return error.code === 'AGENT_FIXTURE_NOTION_TRANSPORT' && error.details.readOnly === false && error.details.attempt === 1;
    });
    const recorded = await json(failure.fixtureEventArtifact), [confirmation] = recorded.result.confirmations;
    assert.deepEqual(recorded.error, confirmation.originalError); assert.equal(confirmation.status, 'failed');
    assert.equal(confirmation.error.code, 'AGENT_FIXTURE_NOTION_TRANSPORT');
    assert.equal(confirmation.error.details.readOnly, true); assert.equal(confirmation.error.details.attempt, 3);
    assert.equal(calls.filter(call => call.method === 'PATCH' && call.path.endsWith('/' + targetId)).length, 1);
    const attempts = (await readFile(join(root, 'network-attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(attempts.filter(row => row.method === 'GET' && row.error).map(row => [row.attempt, row.retry]), [[1, true], [2, true], [3, false]]);
  });
});

test('projection trash retains the normal acknowledged path without extra block reads', async t => {
  const { bindings, calls, owner } = await projectionTrashHarness(t, { mode: 'ack' });
  const result = await runAgentFixtureEvent({ kind: 'trash-projection', object: 'selected' }, { bindings });
  assert.equal(result.status, 'passed'); assert.deepEqual(result.result.confirmations, []);
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 3);
  assert.equal(calls.filter(call => call.method === 'GET' && call.path.startsWith('/v1/blocks/') && !call.path.endsWith('/children')).length, 0);
  assert.equal(calls.filter(call => call.method === 'GET' && call.path === '/v1/pages/' + owner).length, 3);
});

test('projection trash never reconciles a nontransport write rejection', async t => {
  for (const mode of ['http-400', 'http-500']) await t.test(mode, async t => {
    const { bindings, calls, targetId } = await projectionTrashHarness(t, { mode }); let failure;
    await assert.rejects(runAgentFixtureEvent({ kind: 'trash-projection', object: 'selected' }, { bindings }), error => {
      failure = error; return error.code === 'AGENT_FIXTURE_NOTION_READBACK' && error.details.status === Number(mode.slice(5));
    });
    const recorded = await json(failure.fixtureEventArtifact);
    assert.deepEqual(recorded.result.confirmations, []); assert.equal(recorded.status, 'failed');
    assert.deepEqual(calls.filter(call => call.path.endsWith('/' + targetId)).map(call => call.method), ['PATCH']);
  });
});

test('Source lifecycle events require an owned Source and a verified pending intent', async t => {
  const { bindings } = await fixture(t);
  await assert.rejects(runAgentFixtureEvent({ kind: 'interrupt-source-write', object: 'selected' }, { bindings }), /source/u);
  bindings.private.fixture.objects.selected = { id: 'selected', placement: 'source', currentVersion: 'absent' };
  await assert.rejects(runAgentFixtureEvent({ kind: 'resume-source-write', object: 'selected' }, { bindings }), /verified real interruption/u);
  assert.equal(bindings.private.fixture.objects.selected.sourceOperation, undefined);
});

// This finite process/API double checks fixture orchestration, not live Notion acceptance.
async function preparationHarness(t) {
  const { root } = await fixture(t), statePath = join(root, 'public-cli-state.json'), cliPath = join(root, 'public-cli.mjs');
  assert.ok(process.env.NTN_SKILLS_BUILD_ENTRY, 'Fixture regressions require the selected built CLI/SDK');
  const selectedCli = await realpath(process.env.NTN_SKILLS_BUILD_ENTRY), selectedPackage = await json(join(dirname(dirname(selectedCli)), 'package.json'));
  const sdkTarget = selectedPackage.exports['./sdk'].import, sdkPath = join(dirname(dirname(selectedCli)), sdkTarget);
  // The process/API double uses the actual selected public SDK comparator, not a fake parser.
  await writeJson(join(root, 'package.json'), { name: 'ntn-skills', version: selectedPackage.version, type: 'module', bin: { 'ntn-skills': './public-cli.mjs' }, exports: { './sdk': './sdk.mjs' } });
  await writeFile(join(root, 'sdk.mjs'), 'export {SDK_VERSION,PACKAGE_VERSION,compareNativeMarkdown} from ' + JSON.stringify(pathToFileURL(sdkPath).href) + ';\n');
  await writeFile(join(root, 'ref.cjs'), await readFile(join(dirname(selectedCli), 'ref.cjs')));
  const databaseId = '11111111-1111-4111-8111-111111111111', libraryId = fixtureLibraryId;
  const ids = Object.fromEntries(['Name', 'Description', 'Skill ID', 'Current State', 'Operation', 'Enabled', 'Default Context', 'Requires', 'Members'].map(key => [key, key]));
  const library = { library_id: libraryId, skills: { database_id: databaseId, data_source_id: databaseId, property_ids: ids },
    files: { data_source_id: '22222222-2222-4222-8222-222222222222', property_ids: { Skill: 'Skill' } },
    records: { data_source_id: '33333333-3333-4333-8333-333333333333', property_ids: { Skill: 'Skill' } } };
  await writeJson(statePath, { library, records: [], calls: [] });
  await writeFile(cliPath, `import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const path=${JSON.stringify(statePath)},state=JSON.parse(await readFile(path,'utf8')),args=process.argv.slice(2);
const one=key=>args[args.indexOf(key)+1],many=key=>args.flatMap((arg,i)=>arg===key?[args[i+1]]:[]);
state.calls.push(args);
state.stores??=[];state.stores.push(process.env.NTN_SKILLS_HOME);
state.environments??=[];state.environments.push(Object.fromEntries(['NTN_SKILLS_HOME','NTN_SKILLS_CONFIG_HOME','NTN_SKILLS_CACHE_HOME','NTN_SKILLS_DATA_HOME','NTN_SKILLS_SCHEDULER_ROOT'].map(key=>[key,process.env[key]])));
let value;
if(args[0]==='ctl'&&args[2]==='inspect')value={ok:true,library:state.libraries?.[one('--library')]??state.library};
else if(args[0]==='ctl'&&args[2]==='import'){
  const files=[];
  async function walk(root,relative=''){
    for(const item of await readdir(join(root,relative),{withFileTypes:true})){
      const path=relative?relative+'/'+item.name:item.name;
      if(item.isDirectory())await walk(root,path);
      else{const bytes=await readFile(join(root,path));files.push({path,content:bytes.toString(),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),mode:'100644'});}
    }
  }
  await walk(args[3]);
  const record={id:'00000000-0000-4000-8000-'+String(state.records.length+1).padStart(12,'0'),name:one('--name'),description:one('--description'),skillId:one('--skill-id'),content:files.find(file=>file.path==='SKILL.md').content,files,requires:[],members:[],enabled:true,defaultContext:false};
  if(args.includes('--dry-run'))value={ok:true,contract:'current',dry_run:true,library:{library_id:state.library.library_id,database_id:state.library.skills.database_id,data_source_id:state.library.skills.data_source_id},skill_id:record.skillId,page_id:state.importExistingOwner??null,state:null,remote_writes:0,replaces_complete_tree:true,remove:[],metadata:{name:record.name,description:record.description,kind:'skill',enabled:true,default_context:false},files:files.map(file=>({path:file.path,bytes:file.bytes,sha256:file.sha256,page_id:null,previous_authority:null,action:'create',authority:many('--native').includes(file.path)?'native':'resource'}))};
  else{state.records.push(record);value={ok:true,page_id:record.id};}
}
else if(args[0]==='ctl'&&args[2]==='skill'){
  const action=args[3];assert.ok(['create','update'].includes(action));
  const requires=many('--requires'),members=many('--members');
  for(const id of [...requires,...members])assert.ok(state.records.some(row=>row.id===id),'Relation target is not physically ready');
  if(action==='create'){
    const record={id:'00000000-0000-4000-8000-'+String(state.records.length+1).padStart(12,'0'),name:one('--name'),description:one('--description'),skillId:one('--skill-id'),content:await readFile(join(args[4],'SKILL.md'),'utf8'),requires,members,enabled:args.includes('--enabled')?one('--enabled')==='true':true,defaultContext:args.includes('--default-context')?one('--default-context')==='true':false};
    record.libraryId=one('--library');state.records.push(record);value={ok:true,page_id:record.id};
  }else{
    const record=state.records.find(row=>row.id===args[4]);assert.ok(record);
    if(args.includes('--requires'))record.requires=requires;
    if(args.includes('--members'))record.members=members;
    if(args.includes('--enabled'))record.enabled=one('--enabled')==='true';
    if(args.includes('--default-context'))record.defaultContext=one('--default-context')==='true';
    value={ok:true,page_id:record.id};
  }
}else if(args[0]==='read'&&args.includes('--from')){
  const record=state.records.find(row=>'unit:'+row.id===one('--from'));assert.ok(record);
  const file=record.files.find(file=>file.path===args[1]);assert.ok(file);
  await writeFile(one('--output'),state.observedResources?.[file.path]??file.content);
  value={ok:true,effects:{remote_writes:'none'}};
}else if(args[0]==='read'){
  const record=state.records.find(row=>row.id===args[1]);assert.ok(record);assert.equal(record.enabled,true,'Disabled content cannot be consumed');
  if(state.failRead){value={ok:false,error:{code:'STATE_UNAVAILABLE'}};process.exitCode=1;}
  else {if(state.libraries)assert.equal(one('--library'),record.libraryId);const owner=state.libraries?createRequire(import.meta.url)('./ref.cjs').formatSkillIdentity({libraryId:record.libraryId,skillId:record.skillId}):record.skillId;value={ok:true,has_more:false,path:'SKILL.md',content:state.observedContent??record.content,ref:'unit:'+record.id,snapshot_id:'snapshot:'+record.id,version_id:'version:'+record.id,scope:'unit-scope',record:{id:owner,locator:{page_id:record.id,skill_id:record.skillId,library_id:record.libraryId}},effects:{remote_writes:'none'}};}
}else if(args[0]==='files'){
  const record=state.records.find(row=>'snapshot:'+row.id===args[1]);assert.ok(record);
  value={ok:true,files:record.files?.map(file=>({path:file.path,mode:file.mode}))??[{path:'SKILL.md',mode:'100644'}]};
}
else throw Error('Unexpected CLI request '+JSON.stringify(args));
await writeFile(path,JSON.stringify(state));process.stdout.write(JSON.stringify(value)+'\\n');
`);
  const previousFetch = globalThis.fetch, previousToken = process.env.NOTION_API_TOKEN, networkCalls = [];
  process.env.NOTION_API_TOKEN = 'fixture-unit-test-token';
  globalThis.fetch = async (url, options) => {
    const pathname = new URL(url).pathname, state = await json(statePath);
    networkCalls.push({ pathname, method: options.method });
    if (pathname.startsWith('/v1/pages/')) {
      assert.equal(options.method, 'GET'); const row = state.records.find(record => pathname.endsWith(record.id)); assert.ok(row);
      const text = (name, value) => ({ id: name, rich_text: [{ plain_text: value }] });
      return Response.json({ id: row.id, url: 'https://www.notion.so/' + row.id, properties: {
        Name: { id: 'Name', title: [{ plain_text: row.name }] }, Description: text('Description', row.description),
        'Skill ID': text('Skill ID', row.skillId), 'Current State': text('Current State', 'ready'), Operation: text('Operation', ''),
        Enabled: { id: 'Enabled', checkbox: row.enabled }, 'Default Context': { id: 'Default Context', checkbox: row.defaultContext },
        Requires: { id: 'Requires', relation: row.requires.map(id => ({ id })) }, Members: { id: 'Members', relation: row.members.map(id => ({ id })) },
      } });
    }
    assert.ok(pathname.endsWith('/query') || pathname.endsWith('/children'));
    if (pathname.includes(library.files.data_source_id)) return Response.json({ results: state.files ?? [], has_more: false });
    if (pathname.includes(library.records.data_source_id)) return Response.json({ results: state.resources ?? [], has_more: false });
    return Response.json({ results: [], has_more: false });
  };
  t.after(() => { globalThis.fetch = previousFetch; if (previousToken === undefined) delete process.env.NOTION_API_TOKEN; else process.env.NOTION_API_TOKEN = previousToken; });
  return { root, statePath, networkCalls, options: { runId: 'preparation-test', root: join(root, 'prepared'), libraryId, cli: cliPath } };
}

const managedObject = (id, relations = {}) => ({ id, name: id, description: 'Business instructions for ' + id,
  placement: 'notion', initial: 'A', versions: { A: { files: [{ path: 'SKILL.md', content: '# ' + id + '\n\nFollow the business rule.\n' }], ...relations } } });

test('same-ID objects and authored references bind to two independent roots while protected readback catches foreign mutation', async t => {
  const harness = await preparationHarness(t), state = await json(harness.statePath);
  const other = structuredClone(state.library); other.library_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  for (const [name, digit] of [['skills', '5'], ['files', '6'], ['records', '7']]) {
    other[name].data_source_id = digit.repeat(8) + '-' + digit.repeat(4) + '-4' + digit.repeat(3) + '-8' + digit.repeat(3) + '-' + digit.repeat(12);
    if (other[name].database_id) other[name].database_id = other[name].data_source_id;
  }
  state.libraries = { [state.library.library_id]: state.library, [other.library_id]: other }; await writeJson(harness.statePath, state);
  const a = { ...managedObject('alpha'), library: 'A', identityKey: 'same-owner', name: 'same-name' };
  const b = { ...managedObject('beta'), library: 'B', identityKey: 'same-owner', name: 'same-name' };
  b.versions.A.files[0].content = '# Beta\n\nOriginal [A]({{alpha.ref}}), contextual [B]({{beta.shortRef}}).\n';
  const bindings = await prepareAgentFixtures({ ...harness.options, libraries: { A: state.library.library_id, B: other.library_id },
    recipe: { kind: 'library-journey', objects: [a, b] } });
  const context = bindings.private.fixture;
  assert.equal(context.libraryId, state.library.library_id, 'Preparing B must not change the default');
  assert.equal(context.objects.alpha.skillId, context.objects.beta.skillId);
  assert.equal(context.objects.alpha.name, context.objects.beta.name);
  assert.notEqual(bindings.private.objects.alpha.owner, bindings.private.objects.beta.owner);
  assert.equal(agentFixtureObjectContext(context, 'beta').libraryId, other.library_id);
  assert.throws(() => agentFixtureObjectContext(context, 'missing'), /reviewed Library/u);
  const body = await readFile(context.objects.beta.versionInputs.A.files[0].input, 'utf8');
  assert.ok(body.includes('?library=' + state.library.library_id));
  assert.ok(body.includes('(skill://' + context.objects.beta.skillId + ')'));
  assert.equal(Object.keys(bindings.public).some(key => key.endsWith('.ref')), false, 'Authored references must not leak into prompt bindings');
  await readAgentFixture(bindings, 'alpha', { version: 'A', unchanged: true });
  const changed = await json(harness.statePath); changed.records.find(row => row.libraryId === other.library_id).description = 'Changed only B';
  await writeJson(harness.statePath, changed);
  await readAgentFixture(bindings, 'alpha', { version: 'A', unchanged: true });
  changed.records.find(row => row.libraryId === state.library.library_id).description = 'Foreign mutation of A';
  await writeJson(harness.statePath, changed);
  await assert.rejects(readAgentFixture(bindings, 'alpha', { version: 'A', unchanged: true }), /protected object/u);
  const actual = await json(harness.statePath);
  assert.deepEqual(actual.calls.filter(args => args[2] === 'inspect').map(args => args[args.indexOf('--library') + 1]), [state.library.library_id, other.library_id]);
});

test('agent recovery refuses a substituted Store before invoking any writer', async t => {
  const { bindings, context, state } = await fixture(t);
  context.objects.selected.placement = 'source'; context.objects.selected.library = 'B';
  context.libraries = { B: { library_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } };
  await assert.rejects(runAgentFixtureEvent({ kind: 'interrupt-agent-source-write', object: 'selected' }, {
    bindings, ownedStateRoot: state, runtimeEnv: { NTN_SKILLS_HOME: state + '-copy' }, runtimeCli: process.execPath,
  }), /actual subject Store/u);
  assert.equal(context.objects.selected.sourceOperation, undefined);
});

test('explicit resource authoring imports only native main and preserves every auxiliary Markdown byte', async t => {
  for (const changed of [false, true]) await t.test(changed ? 'normalized auxiliary bytes are rejected' : 'exact auxiliary bytes pass', async t => {
    const harness = await preparationHarness(t), object = managedObject('grant');
    object.authoring = 'native-main-exact-resources';
    const expected = '# Rules\n\ngrant_cents is exact.\n';
    object.versions.A.files.push({ path: 'references/rules.md', content: expected });
    if (changed) { const state = await json(harness.statePath); state.observedResources = { 'references/rules.md': expected.replace('grant_cents', 'grant\\_cents') }; await writeJson(harness.statePath, state); }
    const preparing = prepareAgentFixtures({ ...harness.options, recipe: { kind: 'mixed-rules', objects: [object] } });
    if (changed) await assert.rejects(preparing, /Exact source\/resource bytes changed/u);
    else {
      const bindings = await preparing;
      assert.equal(await readFile(bindings.private.bodies['grant@A/references/rules.md'].path, 'utf8'), expected);
      assert.equal(bindings.private.fixture.observedReadbacks.grant.status, 'passed');
      const before = (await json(harness.statePath)).calls.length;
      await assert.rejects(runAgentFixtureEvent({ kind: 'publish-version', object: 'grant', version: 'A' }, { bindings }), /does not support version publication/u);
      assert.equal((await json(harness.statePath)).calls.length, before);
    }
    const state = await json(harness.statePath), imports = state.calls.filter(args => args[2] === 'import');
    assert.equal(imports.length, 2); assert.equal(imports[0].at(-1), '--dry-run');
    assert.deepEqual(imports[1].slice(-2), ['--native', 'SKILL.md']);
    assert.equal(state.calls.some(args => args[2] === 'skill' && args[3] === 'create'), false);
  });
});

test('resource authoring refuses an existing stable owner before the complete import write', async t => {
  const harness = await preparationHarness(t), object = managedObject('grant'); object.authoring = 'native-main-exact-resources';
  const state = await json(harness.statePath); state.importExistingOwner = 'existing-page'; await writeJson(harness.statePath, state);
  await assert.rejects(prepareAgentFixtures({ ...harness.options, recipe: { kind: 'mixed-rules', objects: [object] } }), /cannot replace an existing owner/u);
  const actual = await json(harness.statePath);
  assert.equal(actual.calls.filter(args => args[2] === 'import').length, 1);
  assert.equal(actual.calls.at(-1).at(-1), '--dry-run'); assert.deepEqual(actual.records, []);
});

test('unsupported resource-authoring semantics fail before ownership, CLI or API work', async t => {
  const harness = await preparationHarness(t), object = managedObject('grant', { enabled: false }); object.authoring = 'native-main-exact-resources';
  await assert.rejects(prepareAgentFixtures({ ...harness.options, recipe: { kind: 'mixed-rules', objects: [object] } }), /does not support enabled/u);
  assert.equal(await exists(harness.options.root), false); assert.deepEqual((await json(harness.statePath)).calls, []); assert.deepEqual(harness.networkCalls, []);
});

test('Native readback accepts canonical escapes through the selected public SDK and rejects changed complete content', async t => {
  const expected = '# Invoice\n\nRead total_cents and `last_invoice_id`.\n\n[Policy](https://example.com/a)\n';
  const canonical = expected.replace('total_cents', 'total\\_cents');
  for (const [name, observed, passes] of [
    ['canonical underscore', canonical, true],
    ['changed text', canonical.replace('total\\_cents', 'total\\_dollars'), false],
    ['changed link', canonical.replace('example.com/a', 'example.com/b'), false],
    ['changed code', canonical.replace('`last_invoice_id`', '`last\\_invoice_id`'), false],
    ['truncated document', '# Invoice\n', false],
  ]) await t.test(name, async t => {
    const harness = await preparationHarness(t), object = managedObject('invoice');
    object.versions.A.files[0].content = expected;
    const state = await json(harness.statePath); state.observedContent = observed; await writeJson(harness.statePath, state);
    const preparing = prepareAgentFixtures({ ...harness.options, recipe: { kind: 'native-management', objects: [object] } });
    if (!passes) { await assert.rejects(preparing, /Native content changed meaning/u); return; }
    const bindings = await preparing, selected = bindings.private.fixture.nativeMarkdownSdk;
    assert.equal(selected.sdk.sha256, hash(await readFile(selected.sdk.path)));
    assert.equal(await readFile(bindings.private.bodies['invoice@A/SKILL.md'].path, 'utf8'), observed);
    await writeFile(selected.sdk.path, '\n', { flag: 'a' });
    await assert.rejects(readAgentFixture(bindings, 'invoice', { version: 'A' }), /build identity changed/u);
  });
});

test('missing or mismatched SDK and wrapper inputs fail before fixture creation', async t => {
  for (const kind of ['missing export', 'wrong SDK package', 'shell wrapper']) await t.test(kind, async t => {
    const harness = await preparationHarness(t);
    if (kind === 'missing export') await writeFile(join(harness.root, 'sdk.mjs'), 'export const SDK_VERSION=3,PACKAGE_VERSION="0.1.0";\n');
    if (kind === 'wrong SDK package') {
      const path = join(harness.root, 'package.json'), manifest = await json(path); manifest.version = '999.0.0'; await writeJson(path, manifest);
    }
    if (kind === 'shell wrapper') {
      const path = join(harness.root, 'wrapper.sh'); await writeFile(path, '#!/bin/sh\nexit 1\n'); harness.options.cli = path;
    }
    await assert.rejects(prepareAgentFixtures({ ...harness.options, recipe: { kind: 'native-management', objects: [managedObject('missing')] } }), error => kind === 'shell wrapper'
      ? /differs from its public package bin/u.test(error.message) : error.code === 'AGENT_FIXTURE_NATIVE_COMPARISON_UNAVAILABLE');
    assert.deepEqual((await json(harness.statePath)).calls, []);
  });
});

test('preparation and later readback keep config and scheduler in the owned fixture despite inherited roots', async t => {
  const harness = await preparationHarness(t);
  const directories = { NTN_SKILLS_HOME: 'state', NTN_SKILLS_CONFIG_HOME: 'config', NTN_SKILLS_CACHE_HOME: 'cache', NTN_SKILLS_DATA_HOME: 'data', NTN_SKILLS_SCHEDULER_ROOT: 'scheduler' };
  const inherited = Object.fromEntries(Object.keys(directories).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(inherited)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const [key, directory] of Object.entries(directories)) process.env[key] = join(harness.root, 'inherited-' + directory);
  const caller = Object.fromEntries(Object.keys(directories).map(key => [key, process.env[key]]));
  const bindings = await prepareAgentFixtures({ ...harness.options, recipe: { kind: 'versioned-graph', objects: [managedObject('owned')] } });
  await readAgentFixture(bindings, 'owned', { version: 'A', key: 'later-owned-readback' });
  const expected = Object.fromEntries(Object.entries(directories).map(([key, directory]) => [key, join(harness.options.root, directory)]));
  const observed = (await json(harness.statePath)).environments;
  assert.ok(observed.length > 1, 'Observe preparation and the later public CLI readback subprocesses');
  for (const environment of observed) assert.deepEqual(environment, expected);
  assert.deepEqual(bindings.private.fixture.env, expected, 'Retained bindings keep the same private scheduler for later events');
  for (const [key, value] of Object.entries(caller)) assert.equal(process.env[key], value, 'Do not mutate the caller environment');
});

test('preparation creates a forward Member and Requires before their consumer through public CLI arguments', async t => {
  const harness = await preparationHarness(t);
  const recipe = { kind: 'versioned-graph', objects: [managedObject('required'), managedObject('consumer', { requires: ['required'], members: ['optional'] }), managedObject('optional')] };
  const bindings = await prepareAgentFixtures({ ...harness.options, recipe });
  const state = await json(harness.statePath), creates = state.calls.filter(args => args[3] === 'create');
  assert.equal(creates.length, 3);
  assert.deepEqual(state.records.map(row => row.name.split('-').slice(0, -1).join('-')), ['required', 'optional', 'consumer']);
  const consumer = state.records.find(row => row.skillId.endsWith('-consumer'));
  assert.deepEqual(consumer.requires, [bindings.private.objects.required.pageId]);
  assert.deepEqual(consumer.members, [bindings.private.objects.optional.pageId]);
  assert.equal(state.calls.some(args => args[3] === 'update'), false, 'An acyclic graph needs no second write phase');
  assert.equal(bindings.private.fixture.observedReadbacks.consumer.status, 'passed');
});

test('Members cycles use a second public write phase without weakening Requires ordering', async t => {
  for (const kind of ['members-only', 'members-and-requires']) await t.test(kind, async t => {
    const harness = await preparationHarness(t);
    const left = kind === 'members-only' ? { members: ['right'] } : { requires: ['right'] };
    const recipe = { kind: 'versioned-graph', objects: [managedObject('left', left), managedObject('right', { members: ['left'] })] };
    const bindings = await prepareAgentFixtures({ ...harness.options, recipe }), state = await json(harness.statePath);
    const updates = state.calls.filter(args => args[3] === 'update');
    assert.equal(updates.length, 1); assert.equal(updates[0].includes('--requires'), false, 'Deferred Members must not replace Requires');
    assert.ok(state.calls.findIndex(args => args[0] === 'read') > state.calls.findIndex(args => args[3] === 'update'),
      'Version readbacks must observe the completed graph');
    for (const object of recipe.objects) {
      const record = state.records.find(row => row.skillId.endsWith('-' + object.id));
      for (const field of ['requires', 'members']) assert.deepEqual(record[field],
        (object.versions.A[field] ?? []).map(alias => bindings.private.objects[alias].pageId));
      assert.equal(bindings.private.fixture.observedReadbacks[object.id].status, 'passed');
    }
  });
});

test('invalid initial relation graphs fail before inspecting or creating a remote object', async t => {
  const cases = [
    { name: 'requires-cycle', objects: [managedObject('left', { requires: ['right'] }), managedObject('right', { requires: ['left'] })], code: 'AGENT_FIXTURE_RELATION_CYCLE' },
    { name: 'self-member', objects: [managedObject('left', { members: ['left'] })], code: 'AGENT_FIXTURE_RELATION_INVALID' },
    ...['absent', 'unmanaged', 'local', 'disabled'].map(name => {
      const target = managedObject('target');
      if (['absent', 'unmanaged'].includes(name)) target.initial = name;
      if (name === 'local') target.placement = 'project';
      if (name === 'disabled') target.versions.A.enabled = false;
      return { name, objects: [managedObject('owner', { members: ['target'] }), target], code: 'AGENT_FIXTURE_RELATION_INVALID' };
    }),
  ];
  for (const example of cases) await t.test(example.name, async t => {
    const harness = await preparationHarness(t);
    await assert.rejects(prepareAgentFixtures({ ...harness.options, recipe: { kind: 'versioned-graph', objects: example.objects } }), error => error.code === example.code);
    assert.equal(await exists(harness.options.root), false, 'Reject an impossible setup before creating ownership or changing state');
    assert.deepEqual((await json(harness.statePath)).calls, []);
  });
});

test('disabled preparation verifies metadata and owned child identities without consuming a body version', async t => {
  const harness = await preparationHarness(t), object = managedObject('off', { enabled: false, defaultContext: true });
  object.versions.A.files.push({ path: 'references/details.md', content: '# Supporting details\n' });
  const state = await json(harness.statePath);
  state.files = [{ id: '44444444-4444-4444-8444-444444444444' }];
  state.resources = [{ id: '55555555-5555-4555-8555-555555555555' }];
  await writeJson(harness.statePath, state);
  const bindings = await prepareAgentFixtures({ ...harness.options, recipe: { kind: 'native-management', objects: [object] } });
  const receipt = bindings.private.fixture.observedReadbacks.off;
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.observed.metadataOnly, true);
  assert.deepEqual(receipt.observed.properties, { enabled: false, defaultContext: true });
  assert.deepEqual(bindings.private.fixture.objects.off.knownChildren.map(child => child.pageId).sort(), [...state.files, ...state.resources].map(row => row.id).sort());
  assert.equal(bindings.private.objects.off.versions.A.version_id, undefined, 'Metadata is not proof of a consumed content version');
  await assert.rejects(readAgentFixture(bindings, 'off', { version: 'A' }), /A disabled body cannot be read as current content/u);
  await assert.rejects(readAgentFixture(bindings, 'off', { version: 'A', properties: { enabled: false } }), /Metadata-only disabled readback cannot prove a new content version/u);
  assert.equal((await json(harness.statePath)).calls.some(args => ['read', 'files', 'use'].includes(args[0])), false);
  assert.equal(harness.networkCalls.some(call => call.pathname.endsWith('/children')), false, 'Disabled verification must not inspect author body blocks');
});

test('enabling an initially disabled Skill binds its actual current body and persists independent flag expectations', async t => {
  const harness = await preparationHarness(t), object = managedObject('off', { enabled: false, defaultContext: false });
  const bindings = await prepareAgentFixtures({ ...harness.options, recipe: { kind: 'native-management', objects: [object] } });
  assert.equal(bindings.private.objects.off.versions.A.snapshot_id, undefined);
  const result = await runAgentFixtureEvent({ kind: 'set-enabled', object: 'off', enabled: true, defaultContext: true }, { bindings });
  assert.equal(result.status, 'passed'); assert.equal(result.result.readback.status, 'passed');
  assert.deepEqual(result.result.readback.observed.properties, { enabled: true, defaultContext: true });
  const page = bindings.private.objects.off.pageId, selected = bindings.private.objects.off.versions.A;
  assert.equal(selected.snapshot_id, 'snapshot:' + page); assert.equal(selected.version_id, 'version:' + page);
  const observed = bindings.private.bodies['off@A/SKILL.md'];
  assert.equal(hash(await readFile(observed.path)), observed.sha256);
  assert.equal(bindings.private.fixture.objects.off.versionInputs.A.enabled, false, 'The initial version recipe is immutable evidence');
  const restored = await json(join(harness.options.root, 'bindings.json'));
  const later = await readAgentFixture(restored, 'off', { version: 'A', key: 'current-enabled' });
  assert.equal(later.object.snapshot_id, selected.snapshot_id);
  const state = await json(harness.statePath);
  assert.ok(state.calls.some(args => args[0] === 'read'));
  assert.ok(state.calls.some(args => args[0] === 'files'));
  assert.ok(state.stores.every(root => root === join(harness.options.root, 'state')), 'Only the control Store receives readback snapshots');
  const beforeDisable = state.calls.filter(args => ['read', 'files'].includes(args[0])).length;
  await runAgentFixtureEvent({ kind: 'set-enabled', object: 'off', enabled: false }, { bindings: restored });
  assert.equal((await json(harness.statePath)).calls.filter(args => ['read', 'files'].includes(args[0])).length, beforeDisable);
  assert.equal(restored.private.objects.off.versions.A.snapshot_id, selected.snapshot_id, 'Disabling preserves historical evidence without a new current read');
});

test('a failed current read after enabling cannot publish a body version', async t => {
  const harness = await preparationHarness(t), object = managedObject('off', { enabled: false });
  const bindings = await prepareAgentFixtures({ ...harness.options, recipe: { kind: 'native-management', objects: [object] } });
  const state = await json(harness.statePath); state.failRead = true; await writeJson(harness.statePath, state);
  await assert.rejects(runAgentFixtureEvent({ kind: 'set-enabled', object: 'off', enabled: true }, { bindings }), error => error.code === 'AGENT_FIXTURE_CLI_FAILED');
  assert.equal(bindings.private.objects.off.versions.A.snapshot_id, undefined);
  assert.equal(bindings.private.objects.off.versions.A.version_id, undefined);
  assert.equal((await json(harness.statePath)).records[0].enabled, true, 'The successful public mutation remains visible even though evidence acquisition failed');
});


test('Source handoff permits observing an already-created never-replay request', () => {
  const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sourcePageId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const record = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sourceId = 'owned-source', inputSha256 = '1'.repeat(64);
  const library = { library_id: fixtureLibraryId, sources: { property_ids: { 'Source ID': 'source-id', Status: 'status', Operation: 'operation' } } };
  const input = { operationId, sourcePageId, sourceId, inputSha256, library,
    inspection: { ok: true, status: 'observed', library: { library_id: fixtureLibraryId }, operation: {
      intent: { operation_id: operationId, owner: { kind: 'source', id: sourceId }, input_sha256: inputSha256 },
      owner_state: { state: 'applying', operation_id: operationId }, owner_page_id: sourcePageId, owner_in_trash: false,
      record_observed: true, record_page_id: record, local_lifecycle: { phase: 'active', record_page_id: record },
      in_flight: { key: 'source:create', replay: 'never', request_sha256: '2'.repeat(64) }, source_progress: { next_index: 0, child_started: false },
    } },
    interrupted: { after: { skill: null, source: { id: sourcePageId, properties: Object.fromEntries(Object.entries({ 'Source ID': sourceId, Status: 'applying', Operation: operationId })
      .map(([key, text]) => [key, { id: library.sources.property_ids[key], rich_text: [{ text: { content: text } }] }])) } },
      cli: { ok: false, error: { code: 'REQUEST_BUDGET_EXHAUSTED', details: { operation_id: operationId, source_id: sourceId, source_page_id: sourcePageId, input_sha256: inputSha256 } } } },
  };
  assert.equal(isAgentSourceHandoff(input), true);
  const idle = structuredClone(input); idle.inspection.operation.in_flight = null; delete idle.interrupted;
  assert.equal(isAgentSourceHandoff(idle), true, 'The existing no-pending-request case remains eligible');
  for (const [label, change] of [
    ['another pending action', row => { row.inspection.operation.in_flight.key = 'source:update'; }],
    ['another Source operation', row => { row.inspection.operation.owner_state.operation_id = 'other'; }],
    ['another physical Source', row => { row.interrupted.after.source.id = fixtureLibraryId; }],
    ['missing independent Source', row => { delete row.interrupted.after.source; }],
    ['another Source state', row => { row.interrupted.after.source.properties.Status.rich_text[0].text.content = 'ready'; }],
    ['changed input', row => { row.inputSha256 = '3'.repeat(64); }],
    ['another Library', row => { row.inspection.library.library_id = sourcePageId; }],
  ]) {
    const changed = structuredClone(input); change(changed);
    assert.equal(isAgentSourceHandoff(changed), false, label);
  }
});
