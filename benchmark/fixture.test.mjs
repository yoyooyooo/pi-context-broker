import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCorpus, sealCorpus } from './corpus/index.mjs';
import { planBenchmarkFixture, prepareBenchmarkFixture, inspectBenchmarkFixture, applyBenchmarkFixtureEvent, preparationResumeDecision } from './fixture.mjs';

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

test('an interrupted preparation never invokes a new public create or init', async () => {
  const root = await scratch(), controlRoot = join(root, 'control'), buildRoot = join(root, 'build');
  const plan = planBenchmarkFixture(options(['explicit-01-a'], { controlRoot, buildRoot }));
  await retainPlan(plan);
  await writeFile(join(controlRoot, 'library.json'), JSON.stringify({ entry: '12345678-1234-1234-1234-123456789abc', parent_page_id: '12345678-1234-1234-1234-123456789abc' }));
  await writeFile(join(controlRoot, 'objects-started.json'), JSON.stringify({ dispatched: true }));
  const result = await prepareBenchmarkFixture(plan);
  assert.equal(result.status, 'unknown');
  assert.equal(result.effect_unknown, true);
  const entries = await readdir(controlRoot);
  assert.ok(!entries.includes('remote-parent') && !entries.includes('commands'));
  assert.equal((await inspectBenchmarkFixture({ controlRoot })).status, 'pending-reconciliation');
  const second = await prepareBenchmarkFixture(plan);
  assert.equal(second.status, 'unknown');
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


test('source runtime preflight creates private temp roots and stops before remote allocation without selected Git', async () => {
  const root=await scratch(), controlRoot=join(root,'control'), buildRoot=join(root,'build');
  const plan=planBenchmarkFixture(options(['scripts-assets-01-a'],{controlRoot,buildRoot,
    sourceBindings:{'scripts-assets-01-a-manifest':sourceBinding('scripts-assets-01-a-manifest')}}));
  const result=await prepareBenchmarkFixture(plan);
  assert.equal(result.status,'unknown');
  assert.match(result.error.message,/explicitly selected supported Git/);
  assert.ok((await readdir(join(controlRoot,'controller'))).includes('tmp'));
  assert.ok(!(await readdir(controlRoot)).includes('remote-parent'));
  assert.ok(!(await readdir(controlRoot)).includes('init-started.json'));
});
