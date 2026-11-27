import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { buildCorpus, sealCorpus } from './corpus/index.mjs';
import { fingerprint } from './protocol.mjs';
import { planBenchmarkFixture, prepareBenchmarkFixture, inspectBenchmarkFixture, applyBenchmarkFixtureEvent, reconcileBenchmarkFixtureEvent,
  resumeBenchmarkFixturePreparation, preparationResumeDecision, readPreparationDispatches, refreshReadonlyBenchmarkFixture, rebindReadonlyFixtureCases } from './fixture.mjs';

const corpus = buildCorpus({ seed: 'benchmark-route-gate-v1', split: 'development', materialVersion: '2' });
const sharedCases = ['no-skill-01-a','no-skill-02-a','no-skill-03-a','explicit-01-a',
  'implicit-01-a','ambiguity-01-a','equivalent-01-a','references-01-a','scripts-assets-01-a',
  'complementary-01-a','continuation-01-a','task-switch-01-a'];
const sha = value => createHash('sha256').update(value).digest('hex');
function options(caseIds = ['explicit-01-a'], extra = {}) {
  return { corpus, caseIds, scopeId: 'benchmark-fixture-test', controlRoot: '/owned-benchmark-controls/fixture-test',
    projectPageId: '12345678-1234-1234-1234-123456789abc', buildRoot: '/immutable-benchmark-build',
    node: process.execPath, ...extra };
}
function sourceBinding(skillId) {
  const skill = corpus.publicCorpus.skills.find(item => item.id === skillId), member = 'benchmark/fixtures/upstream-skills/v2-route-gate/' + skill.name;
  return { memberKey: member, declaration: { version: 1, definition: { version: 1, source_id: 'public-test-material',
    name: skill.name, description: skill.description, enabled: true, policy: 'pinned',
    adapter: { type: 'git', url: 'https://github.com/yoyooyooo/pi-context-broker.git', ref: 'c8b49c1c1dfac65257b07e8d249f187405e0e7f4' },
    selection: { roots: [member], include: [], exclude: [], mapping: {} }, options: {} }, contributions: [] } };
}
async function retainPlan(plan) {
  await mkdir(plan.control_root, { recursive: true, mode: 0o700 });
  await writeFile(join(plan.control_root, 'owner.json'), JSON.stringify({ kind: 'benchmark-controller-fixture', plan_sha256: plan.plan_sha256 }));
  await writeFile(join(plan.control_root, 'plan.json'), JSON.stringify(plan));
}
async function scratch() { return realpath(await mkdtemp(join(tmpdir(), 'benchmark-fixture-test-'))); }
function offlineWorkerCredential(t) {
  const previous = process.env.NOTION_API_TOKEN;
  process.env.NOTION_API_TOKEN = 'synthetic-offline-fixture-test-with-no-authority';
  t.after(() => {
    if (previous === undefined) delete process.env.NOTION_API_TOKEN;
    else process.env.NOTION_API_TOKEN = previous;
  });
}

test('current read-only refresh rejects a mutable retained plan before allocating a new control root', async () => {
  const root = await scratch(), plan = planBenchmarkFixture(options(['continuation-02-a'], {
    controlRoot: join(root, 'old'), access: 'episode-owned', episodeId: 'mutable-retained' }));
  await retainPlan(plan);
  const path = join(root, 'binding.json'), bytes = JSON.stringify({ status: 'ready', control_root: plan.control_root, access: 'episode-owned' });
  await writeFile(path, bytes);
  await assert.rejects(refreshReadonlyBenchmarkFixture({ retainedBinding: { path, sha256: sha(bytes) },
    controlRoot: join(root, 'new'), buildRoot: '/unused-build', node: process.execPath }), /shared-readonly/);
  assert.ok(!(await readdir(root)).includes('new'));
});

function renewCorpusIdentity(value) {
  for (const item of value.publicCorpus.cases) {
    const { content_sha256: ignored, ...body } = item;
    item.content_sha256 = fingerprint(body);
    for (const oracle of Object.values(value.control.cases.find(control => control.case_id === item.id).oracles))
      oracle.public_sha256 = item.content_sha256;
  }
  const { content_sha256: ignored, ...body } = value.publicCorpus;
  value.publicCorpus.content_sha256 = fingerprint(body);
  value.control.public_sha256 = value.publicCorpus.content_sha256;
  return value;
}

test('read-only refresh can bind different cases to the identical retained catalog', () => {
  const original = planBenchmarkFixture(options(['implicit-01-a', 'explicit-01-a']));
  const before = structuredClone(original);
  const revised = rebindReadonlyFixtureCases(original, { corpus, caseIds: ['implicit-01-a'] });
  assert.deepEqual(revised.case_ids, ['implicit-01-a']);
  assert.deepEqual(revised.required_skill_ids, ['implicit-01-a-routing']);
  assert.deepEqual(revised.catalog_skill_ids, original.catalog_skill_ids);
  assert.deepEqual(revised.fixture, original.fixture);
  assert.deepEqual([...revised.case_plans[0].publicCase.catalog.skill_ids].sort(), [...original.catalog_skill_ids].sort());
  assert.deepEqual(original, before, 'The original frozen declaration stays unchanged');
  assert.equal(rebindReadonlyFixtureCases(original), original);
});

test('read-only case reuse rejects changed catalog semantics and unsupported case authority', () => {
  const original = planBenchmarkFixture(options(['implicit-01-a', 'explicit-01-a']));
  const select = changed => rebindReadonlyFixtureCases(original, { corpus: renewCorpusIdentity(changed), caseIds: ['implicit-01-a'] });
  for (const change of [
    skill => { skill.name += '-changed'; },
    skill => { skill.description += ' changed'; },
    skill => { skill.requires = ['explicit-01-a-refund']; },
    skill => { skill.versions.unobserved = structuredClone(skill.versions[skill.initial_version]); },
    skill => { const file = skill.versions[skill.initial_version].files[0]; file.content += '\nchanged';
      file.bytes = Buffer.byteLength(file.content); file.sha256 = sha(file.content); },
  ]) {
    const changed = structuredClone(corpus); change(changed.publicCorpus.skills.find(skill => skill.id === 'implicit-01-a-routing'));
    assert.throws(() => select(changed), /cannot change any catalog Skill/);
  }
  const event = structuredClone(corpus);
  event.control.cases.find(item => item.case_id === 'implicit-01-a').events.push({ id: 'unexpected-event' });
  assert.throws(() => select(event), /cannot introduce remote events/);
  const remote = structuredClone(corpus);
  remote.publicCorpus.cases.find(item => item.id === 'implicit-01-a').authorization.remote_write = true;
  assert.throws(() => select(remote), /cannot authorize remote writes/);
  assert.throws(() => rebindReadonlyFixtureCases(original, { corpus, caseIds: ['references-01-a'] }), /omits a required case Skill/);
  assert.throws(() => rebindReadonlyFixtureCases(original, { corpus }), /both corpus and caseIds/);
});

test('all forty cases have complete plans and mutable journeys require independent episodes', () => {
  for (const item of corpus.publicCorpus.cases) {
    const mutable = corpus.control.cases.find(value => value.case_id === item.id).events.length > 0;
    const plan = planBenchmarkFixture(options([item.id], mutable ? { access: 'episode-owned', episodeId: item.id } : {}));
    assert.equal(plan.catalog_skill_ids.length, 16);
    assert.equal(new Set(plan.catalog_skill_ids).size, 16);
    assert.ok(plan.fixture.expected_inventory.some(file => file.path === 'SKILL.md'));
    assert.ok(plan.required_skill_ids.every(id => plan.catalog_skill_ids.includes(id)));
    assert.equal(plan.case_plans[0].publicCase.turns.length, item.turns.length);
    for (const file of plan.fixture.expected_inventory) assert.equal(sha(Buffer.from(file.content, file.encoding)), file.sha256);
  }
  assert.throws(() => planBenchmarkFixture(options(['continuation-02-a'])), /isolated per episode/);
});

test('twelve selected cases share one sixteen-candidate catalog without changing tasks or inputs', () => {
  const plan = planBenchmarkFixture(options(sharedCases));
  assert.equal(plan.required_skill_ids.length, 11);
  assert.equal(plan.catalog_skill_ids.length, 16);
  assert.equal(new Set(plan.case_plans.map(item => item.publicCase.family)).size, 10);
  for (const selected of plan.case_plans) {
    const before = corpus.publicCorpus.cases.find(item => item.id === selected.publicCase.id);
    assert.deepEqual(selected.publicCase.turns, before.turns);
    assert.deepEqual(selected.publicCase.attachments, before.attachments);
    assert.deepEqual([...selected.publicCase.catalog.skill_ids].sort(), [...plan.catalog_skill_ids].sort());
  }
  assert.equal(plan.events.length, 0);
  assert.equal(plan.access, 'shared-readonly');
});

test('real pinned source recipes retain full canonical bytes and complete independent inventory', () => {
  const skillId = 'scripts-assets-01-a-manifest';
  const plan = planBenchmarkFixture(options(['scripts-assets-01-a'], { sourceBindings: { [skillId]: sourceBinding(skillId) } }));
  const alias = plan.fixture.skill_mapping[skillId].object_id, object = plan.fixture.recipe.objects.find(item => item.id === alias);
  assert.equal(object.placement, 'source');
  assert.equal(object.versions.v1.files.length, 5);
  assert.equal(object.versions.v1.files.find(item => item.path === 'SKILL.md').content, corpus.publicCorpus.skills.find(item => item.id === skillId).versions.v1.files.find(item => item.path === 'SKILL.md').content);
  const expected = plan.fixture.expected_inventory.filter(item => item.skill_id === skillId);
  assert.equal(expected.length, 5);
  assert.ok(expected.some(item => item.path === 'scripts/normalize.mjs' && item.mode === '100755'));
  assert.ok(expected.some(item => item.path === 'assets/format-marker.bin' && item.encoding === 'base64'));
  assert.ok(expected.some(item => item.path === 'assets/empty.txt' && item.bytes === 0));
  assert.equal(plan.fixture.source_claim, 'requires-public-readback');
});

test('exact-resource authoring is explicit, freezes only native owners and rejects unsupported relations or versions', () => {
  const ordinary = planBenchmarkFixture(options(['references-01-a']));
  const exact = planBenchmarkFixture(options(['references-01-a'], { authoring: 'native-main-exact-resources' }));
  assert.equal(ordinary.authoring, undefined); assert.ok(ordinary.fixture.recipe.objects.every(object => object.authoring === undefined));
  assert.equal(exact.authoring, 'native-main-exact-resources');
  assert.ok(exact.fixture.recipe.objects.every(object => object.authoring === exact.authoring));
  assert.deepEqual(exact.corpus, ordinary.corpus); assert.deepEqual(exact.fixture.expected_inventory, ordinary.fixture.expected_inventory);
  assert.notEqual(exact.plan_sha256, ordinary.plan_sha256);
  const skillId = 'scripts-assets-01-a-manifest';
  const source = planBenchmarkFixture(options(['scripts-assets-01-a'], { authoring: exact.authoring, sourceBindings: { [skillId]: sourceBinding(skillId) } }));
  assert.ok(source.fixture.recipe.objects.filter(object => object.placement === 'source').every(object => object.authoring === undefined));
  assert.throws(() => planBenchmarkFixture(options(['complementary-01-a'], { authoring: exact.authoring })), /does not support requires/);
  assert.throws(() => planBenchmarkFixture(options(['continuation-02-a'], { authoring: exact.authoring, access: 'episode-owned', episodeId: 'versioned' })), /one immutable version/);
  assert.throws(() => planBenchmarkFixture(options(['references-01-a'], { authoring: 'unknown' })), /Unknown fixture authoring/);
});

test('an explicit per-Skill authoring map preserves every unselected object and its relations', () => {
  const policy = 'native-main-exact-resources', selectedId = 'references-01-a-grant';
  const original = planBenchmarkFixture(options(sharedCases));
  const selected = planBenchmarkFixture(options(sharedCases, { authoringBySkill: { [selectedId]: policy } }));
  assert.equal(selected.authoring, undefined); assert.deepEqual(selected.authoring_by_skill, { [selectedId]: policy });
  assert.deepEqual(selected.corpus, original.corpus); assert.deepEqual(selected.fixture.expected_inventory, original.fixture.expected_inventory);
  const alias = selected.fixture.skill_mapping[selectedId].object_id;
  for (const object of selected.fixture.recipe.objects) {
    const previous = original.fixture.recipe.objects.find(item => item.id === object.id);
    assert.deepEqual(object, object.id === alias ? { ...previous, authoring: policy } : previous);
  }
  const relationId = selected.fixture.skill_mapping['complementary-01-a-privacy'].object_id;
  assert.ok(selected.fixture.recipe.objects.find(object => object.id === relationId).versions.v1.requires.length > 0);
  for (const extra of [
    { authoring: policy, authoringBySkill: { [selectedId]: policy } },
    { authoringBySkill: {} }, { authoringBySkill: { s008: policy } },
    { authoringBySkill: { [selectedId]: 'unknown' } },
    { authoringBySkill: { 'complementary-01-a-privacy': policy } },
  ]) assert.throws(() => planBenchmarkFixture(options(sharedCases, extra)));
  const sourceId = 'scripts-assets-01-a-manifest';
  assert.throws(() => planBenchmarkFixture(options(['scripts-assets-01-a'], { sourceBindings: { [sourceId]: sourceBinding(sourceId) },
    authoringBySkill: { [sourceId]: policy } })), /requires a Notion object/);
});

test('retained unknown imports count as writes while dry-run and other-owner receipts do not', async () => {
  const control_root = await scratch(), owned = { skillId: 'owned-import' }, commandRoot = join(control_root, 'objects/commands');
  await mkdir(commandRoot, { recursive: true }); await mkdir(join(control_root, 'commands'));
  const command = [process.execPath, '/selected/cli.mjs', 'ctl', 'library', 'import', '/complete/input', '--entry', 'entry', '--skill-id', owned.skillId, '--native', 'SKILL.md'];
  const records = [
    { command: [...command, '--dry-run'], code: 0, stdout: '{"ok":true}' },
    { command: command.map(value => value === owned.skillId ? 'another-owner' : value), code: 1, stdout: '' },
    { command: [process.execPath, '/selected/cli.mjs', 'help', 'create', '--skill-id', owned.skillId], code: 0, stdout: '' },
  ];
  for (const [i, record] of records.entries()) await writeFile(join(commandRoot, i + '.json'), JSON.stringify(record));
  assert.deepEqual(await readPreparationDispatches({ control_root }, owned), []);
  const retained = { command, code: 1, stdout: 'incomplete acknowledgement', dispatch_intent: { path: '/owned/intent.json', sha256: 'a'.repeat(64) } };
  const path = join(control_root, 'commands/resume-import.json'); await writeFile(path, JSON.stringify(retained));
  const dispatches = await readPreparationDispatches({ control_root }, owned);
  assert.equal(dispatches.length, 1); assert.equal(dispatches[0].native, true); assert.equal(dispatches[0].value, undefined);
  assert.equal(dispatches[0].receipt.sha256, sha(await readFile(path))); assert.deepEqual(dispatches[0].dispatch_intent, retained.dispatch_intent);
  assert.equal(preparationResumeDecision({ absence: { status: 'passed', observed: { absent: true }, artifact: { sha256: 'b'.repeat(64) } },
    operation: { status: 'not_found', operation: null }, allClaimsAccounted: true, knownNeverDispatched: dispatches.length === 0 }), 'unknown');
});

test('unreviewed or credential-bearing upstream members fail before any provider action', () => {
  const id = 'references-01-a-grant';
  for (const change of [
    source => { source.declaration.definition.adapter.ref = 'main'; },
    source => { source.declaration.definition.adapter.url = 'https://secret@example.org/repo'; },
    source => { source.declaration.definition.selection.roots = ['another-member']; },
    source => { source.declaration.definition.selection.mapping = { 'SKILL.md': 'other.md' }; },
  ]) {
    const binding = sourceBinding(id); change(binding);
    assert.throws(() => planBenchmarkFixture(options(['references-01-a'], { sourceBindings: { [id]: binding } })));
  }
});

test('declared scale and round anchors produce their full catalog and actual turn counts', () => {
  for (const candidateCount of [16,64,256]) for (const roundCount of [1,2,4,8]) {
    const plan = planBenchmarkFixture(options(['implicit-01-a'], { candidateCount, roundCount }));
    assert.equal(plan.catalog_skill_ids.length, candidateCount);
    assert.equal(plan.case_plans[0].publicCase.turns.length, roundCount);
    assert.equal(plan.fixture.recipe.objects.length, candidateCount);
  }
  assert.throws(() => planBenchmarkFixture(options(['explicit-01-a'], { candidateCount: 64 })));
  assert.throws(() => planBenchmarkFixture(options(sharedCases, { candidateCount: 64 })), /one declared journey/);
});

test('sealed confirmation cannot be prepared or silently rebound', () => {
  const confirmation = buildCorpus({ seed: 'unseen-fixture-confirmation', split: 'confirmation', materialVersion: '2' });
  const sealed = sealCorpus({ corpus: confirmation, sealedAt: '2026-11-22T00:00:00Z' });
  assert.throws(() => planBenchmarkFixture(options(['explicit-01-a'], { corpus: sealed })), /remains sealed/);
});

test('events are finite, owned and bound to one frozen episode', () => {
  assert.throws(() => planBenchmarkFixture(options(['explicit-01-a'], { events: [{ id: 'bad', kind: 'remove-owned', skill_id: 'explicit-01-a-refund' }] })), /supported operation/);
  assert.throws(() => planBenchmarkFixture(options(['explicit-01-a'], { events: [{ id: 'bad', kind: 'fault', mode: 'store-unavailable', skill_id: 'explicit-01-a-refund' }] })), /isolated per episode/);
  assert.throws(() => planBenchmarkFixture(options(['explicit-01-a'], { access: 'episode-owned', episodeId: null })), /explicit episode/);
  const plan = planBenchmarkFixture(options(['continuation-02-a'], { access: 'episode-owned', episodeId: 'episode-a' }));
  assert.equal(plan.events[0].id, 'policy-v2');
  assert.deepEqual(plan.events[0].logical_operation, { skill_id: 'continuation-02-a-routing', path: 'SKILL.md', intent: 'publish-version' });
});

test('an interrupted preparation never invokes a new public create or init', async t => {
  offlineWorkerCredential(t);
  const root = await scratch(), controlRoot = join(root, 'control'), buildRoot = join(root, 'build');
  const plan = planBenchmarkFixture(options(['explicit-01-a'], { controlRoot, buildRoot }));
  await retainPlan(plan);
  await writeFile(join(controlRoot, 'library.json'), JSON.stringify({ entry: '12345678-1234-1234-1234-123456789abc', parent_page_id: '12345678-1234-1234-1234-123456789abc' }));
  await writeFile(join(controlRoot, 'objects-started.json'), JSON.stringify({ dispatched: true }));
  await assert.rejects(prepareBenchmarkFixture(plan), { code: 'BENCHMARK_FIXTURE_CURRENT_PATH_UNSUPPORTED' });
  const entries = await readdir(controlRoot);
  assert.ok(!entries.includes('remote-parent') && !entries.includes('commands'));
  assert.equal((await inspectBenchmarkFixture({ controlRoot })).status, 'pending-reconciliation');
  await assert.rejects(prepareBenchmarkFixture(plan), { code: 'BENCHMARK_FIXTURE_CURRENT_PATH_UNSUPPORTED' });
  await assert.rejects(resumeBenchmarkFixturePreparation({ controlRoot }), { code: 'BENCHMARK_FIXTURE_CURRENT_PATH_UNSUPPORTED' });
  assert.ok(!(await readdir(controlRoot)).includes('commands'));
});

test('a known unknown event terminal is retained and never automatically re-dispatched', async () => {
  const root = await scratch();
  const plan = planBenchmarkFixture(options(['continuation-02-a'], { controlRoot: join(root, 'control'), buildRoot: join(root, 'build'), access: 'episode-owned', episodeId: 'one-episode' }));
  await retainPlan(plan);
  const directory = join(plan.control_root, 'events', 'policy-v2-' + sha('one-episode').slice(0,12));
  await mkdir(directory, { recursive: true });
  const terminal = { schema_version: 1, event_id: 'policy-v2', episode_id: 'one-episode', status: 'unknown', effect_unknown: true, effect_verified: false };
  await writeFile(join(directory, 'terminal.json'), JSON.stringify(terminal));
  const result = await applyBenchmarkFixtureEvent({ controlRoot: plan.control_root, eventId: 'policy-v2', episodeId: 'one-episode' });
  assert.equal(result.status, 'unknown'); assert.equal(result.reused, true);
  assert.equal(result.receipt.sha256, sha(await readFile(result.receipt.path)));
  assert.ok(!(await readdir(plan.control_root)).includes('requests'));
  await assert.rejects(applyBenchmarkFixtureEvent({ controlRoot: plan.control_root, eventId: 'policy-v2', episodeId: 'another-episode' }), /frozen episode/);
});

test('forged success or changed effect evidence is rejected before event reuse', async () => {
  const root = await scratch();
  const plan = planBenchmarkFixture(options(['continuation-02-a'], { controlRoot: join(root,'control'), buildRoot: join(root,'build'), access:'episode-owned', episodeId:'one-episode' }));
  await retainPlan(plan);
  const directory = join(plan.control_root,'events','policy-v2-' + sha('one-episode').slice(0,12));
  await mkdir(directory,{recursive:true});
  const evidencePath=join(directory,'independent-readback.json'); await writeFile(evidencePath,'changed');
  await writeFile(join(directory,'terminal.json'),JSON.stringify({event_id:'policy-v2',episode_id:'one-episode',status:'applied',effect_verified:true,effect_evidence:[{path:evidencePath,sha256:sha('original')}]}));
  await assert.rejects(applyBenchmarkFixtureEvent({controlRoot:plan.control_root,eventId:'policy-v2',episodeId:'one-episode'}),/evidence changed/);
});


test('operation not_found cannot substitute for independently observed owner absence', () => {
  const clear = { status:'not_found', operation:null };
  const input = { operation:clear, allClaimsAccounted:true, knownNeverDispatched:true };
  assert.equal(preparationResumeDecision(input),'unknown');
  const absence={status:'passed',observed:{absent:true},artifact:{sha256:'a'.repeat(64)}};
  assert.equal(preparationResumeDecision({...input,absence}),'absent-before-write');
  assert.equal(preparationResumeDecision({...input,absence,allClaimsAccounted:false}),'unknown');
  assert.equal(preparationResumeDecision({...input,absence,knownNeverDispatched:false}),'unknown');
  assert.equal(preparationResumeDecision({...input,absence,operation:{status:'observed',operation:{id:'pending'}}}),'unknown');
  assert.equal(preparationResumeDecision({...input,absence,sourceRequired:true,sourceOperation:clear}),'unknown');
  assert.equal(preparationResumeDecision({...input,absence,sourceRequired:true,sourceOperation:clear,sourceInventory:{rows:[],receipt:{sha256:'b'.repeat(64)}}}),'absent-before-write');
  assert.equal(preparationResumeDecision({...input,absence,sourceRequired:true,sourceOperation:clear,sourceInventory:{rows:[{page_id:'existing'}],receipt:{sha256:'b'.repeat(64)}}}),'unknown');
});


test('unmigrated fresh and stateful entry points reject before local allocation or remote dispatch', async t => {
  offlineWorkerCredential(t);
  const root=await scratch(), controlRoot=join(root,'control'), buildRoot=join(root,'build');
  const plan=planBenchmarkFixture(options(['scripts-assets-01-a'],{controlRoot,buildRoot,
    sourceBindings:{'scripts-assets-01-a-manifest':sourceBinding('scripts-assets-01-a-manifest')}}));
  await assert.rejects(prepareBenchmarkFixture(plan), error => error.code === 'BENCHMARK_FIXTURE_CURRENT_PATH_UNSUPPORTED'
    && error.details.remote_dispatched === false);
  assert.ok(!(await readdir(root)).includes('control'));
  const mutable = planBenchmarkFixture(options(['continuation-02-a'], { controlRoot, buildRoot, access: 'episode-owned', episodeId: 'one-episode' }));
  await retainPlan(mutable);
  for (const invoke of [applyBenchmarkFixtureEvent, reconcileBenchmarkFixtureEvent])
    await assert.rejects(invoke({ controlRoot, eventId: 'policy-v2', episodeId: 'one-episode' }), { code: 'BENCHMARK_FIXTURE_CURRENT_PATH_UNSUPPORTED' });
  assert.deepEqual((await readdir(controlRoot)).sort(), ['owner.json', 'plan.json']);
});

test('direct worker dispatch cannot bypass the unsupported current mutation boundary', async t => {
  offlineWorkerCredential(t);
  const root = await scratch(), controlRoot = join(root, 'control'), buildRoot = join(root, 'build');
  const plan = planBenchmarkFixture(options(['continuation-02-a'], { controlRoot, buildRoot, access: 'episode-owned', episodeId: 'one-episode' }));
  await retainPlan(plan); await mkdir(join(controlRoot, 'requests'));
  const marker = join(root, 'remote-dispatched'), preload = join(root, 'deny-remote.mjs');
  await writeFile(preload, `import{writeFileSync}from'node:fs';globalThis.fetch=async()=>{writeFileSync(${JSON.stringify(marker)},'fetch');throw new Error('Remote dispatch forbidden in this test');};`);
  await mkdir(dirname(plan.cli), { recursive: true });
  await writeFile(plan.cli, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'cli');process.exitCode=1;`);
  for (const action of ['prepare', 'resume', 'event', 'reconcile-event']) {
    const requestPath = join(controlRoot, 'requests', action + '.json');
    await writeFile(requestPath, JSON.stringify({ action, control_root: controlRoot, eventId: 'policy-v2', episodeId: 'one-episode' }));
    const child = spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL('./fixture.mjs', import.meta.url)), '--fixture-worker', requestPath],
      { env: process.env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(await readFile(requestPath + '.result.json', 'utf8'));
    assert.equal(result.status, 'blocked'); assert.equal(result.effect_unknown, false); assert.equal(result.remote_dispatched, false);
    assert.equal(result.error.code, 'BENCHMARK_FIXTURE_CURRENT_PATH_UNSUPPORTED');
  }
  assert.ok(!(await readdir(root)).includes('remote-dispatched'));
  assert.ok(!(await readdir(controlRoot)).some(path => ['commands', 'remote-parent', 'init-started.json'].includes(path)));
});
