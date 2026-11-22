import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { buildCorpus, bindPublicCaseToFixture } from './corpus/index.mjs';
import { comparisonPairs, prepareCases } from './planning.mjs';
import { scheduleProtocol } from './batch.mjs';
import { fingerprint } from './protocol.mjs';
import { prepareEpisodeFixtures, readEpisodeFixtureBindings, validateEpisodeFixturePolicy } from './fixture-dispatch.mjs';
import { verifyRetainedSlotCapture } from './configure.mjs';
import { executionForSlot } from './controller.mjs';

// Controlled filesystem receipts exercise ownership and freezing, not Notion
// material parity or model quality. Live parity remains the public CLI's job.
const sha = value => createHash('sha256').update(value).digest('hex');
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true }); const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); return { path, sha256: sha(bytes), bytes: bytes.length };
}
async function fixture(repetitions = 2) {
  const environmentRoot = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-slot-fixtures-'))), controlRoot = join(environmentRoot, 'control/batch');
  const corpus = buildCorpus({ seed: 'slot-fixture-apparatus', split: 'development', materialVersion: '2' });
  const caseId = corpus.control.cases.find(item => item.events.some(event => event.kind === 'publish-version')).case_id;
  const cases = await prepareCases({ corpus, selections: [{ caseId, candidateCount: 16 }], root: join(controlRoot, 'cases') });
  const models = [{ id: 'controlled' }], slots = scheduleProtocol({ pairs: comparisonPairs({ models, cases, repetitions, orderingSeed: 17 }), assessments: [], policies: { ordering: { seed: 17 } } });
  return { id: 'controlled-slots', environmentRoot, controlRoot, corpus, cases, slots,
    candidates: { 'm0-e0': { build_id: 'candidate', mode: 'broker' }, 'm0-e1': { build_id: 'reference', mode: 'native' } },
    runtime: { node: process.execPath }, policy: { version: 1, project_page_id: '11111111-1111-4111-8111-111111111111' } };
}
async function materialize(plan) {
  const root = plan.control_root; await save(join(root, 'plan.json'), plan);
  const publicValues = {}, privateObjects = {}, files = [], suffix = sha(plan.scope_id).slice(0, 8);
  const skillMapping = plan.fixture.skill_mapping;
  for (const [skillId, mapping] of Object.entries(skillMapping)) {
    const name = mapping.name + '-' + suffix;
    publicValues[mapping.object_id + '.name'] = name;
    privateObjects[mapping.object_id] = { skillId: 'owned-' + plan.scope_id + '-' + mapping.object_id,
      pageId: sha(plan.scope_id + skillId).slice(0, 32) };
    for (const file of plan.fixture.expected_inventory.filter(item => item.skill_id === skillId)) {
      const bytes = Buffer.from(file.content, file.encoding), ref = await save(join(root, 'verified/native', name, file.path), bytes.toString('utf8'));
      files.push({ ...ref, skill_id: skillId, resource_path: file.path, mode: file.mode });
    }
  }
  const fixtureBindings = { public: publicValues, private: { objects: privateObjects } };
  const prepared = await save(join(root, 'verified/fixture-bindings.json'), fixtureBindings);
  const mutable = await save(join(root, 'objects/bindings.json'), fixtureBindings);
  const entry = sha(plan.scope_id).slice(0, 32), identity = bindPublicCaseToFixture({ publicCase: plan.case_plans[0].publicCase, skillMapping, bindings: fixtureBindings }).identity_map;
  const proof = await save(join(root, 'verified/materialization-proof.json'), { status: 'passed', parity: { status: 'valid' },
    visibility: { status: 'valid' }, entry, catalog: { candidates: 16, exhaustive: true }, files });
  const value = { status: 'ready', access: 'episode-owned', episode_id: plan.episode_id, control_root: root,
    public_sha256: plan.corpus.publicCorpus.content_sha256, entry, case_ids: plan.case_ids, catalog_skill_ids: plan.catalog_skill_ids,
    identity_map: identity, materialization_proof: proof, native_skill_root: join(root, 'verified/native'),
    fixture_bindings_path: mutable.path, prepared_bindings: prepared };
  const binding = await save(join(root, 'verified/binding.json'), value);
  return { status: 'ready', effect_unknown: false, binding_path: binding.path, binding };
}
const read = (args, registration) => readEpisodeFixtureBindings({ ...args, registration });

test('two conditions and repeats receive distinct owned fixtures without changing canonical slots', async () => {
  const args = await fixture(), before = fingerprint(args.slots), canonical = structuredClone(args.cases), plans = [];
  const prepared = await prepareEpisodeFixtures(args, { prepare: async plan => { plans.push(plan); return materialize(plan); },
    reconcile: async () => { throw new Error('Fresh preparation must not reconcile'); } });
  assert.equal(plans.length, 4); assert.equal(new Set(plans.map(plan => plan.scope_id)).size, 4);
  assert.equal(new Set(plans.map(plan => plan.owned_runtime_root)).size, 4);
  assert.equal(prepared.slots.size, 4); assert.equal(fingerprint(args.slots), before); assert.deepEqual(args.cases, canonical);
  for (const slot of args.slots) {
    const item = prepared.slots.get(slot.slot_id);
    assert.equal(item.record.run_id, args.id + '-' + String(slot.order + 1).padStart(3, '0'));
    assert.deepEqual(item.binding.protocol_case, canonical[0].protocol_case);
    assert.equal(item.record.public_prompt_sha256, fingerprint(item.binding.public_case.turns));
    assert.equal(item.record.slot_sha256, fingerprint(slot));
  }
  assert.equal(new Set([...prepared.slots.values()].map(value => value.binding.notion_entry)).size, 4);
  const loaded = await read(args, prepared.registration); assert.equal(loaded.size, 4);
  const plan = { protocol: { models: [{ id: 'controlled' }], conditions: Object.keys(args.candidates).map(id => ({ id, model_id: 'controlled' })) },
    execution: { conditions: Object.fromEntries(Object.entries(args.candidates).map(([id, candidate]) => [id, { ...candidate,
      expectations: Object.fromEntries(args.slots.filter(slot => slot.condition_id === id).map(slot => [slot.slot_id, { path: '/controlled/' + slot.slot_id, sha256: fingerprint(slot) }])) }])) } };
  for (const slot of args.slots) assert.equal(executionForSlot({ plan, bindings: args.cases, slotBindings: loaded, slot }).expectation.path, '/controlled/' + slot.slot_id);
  const first = args.slots[0], candidate = plan.execution.conditions[first.condition_id];
  candidate.expectations[first.case_id] = candidate.expectations[first.slot_id]; delete candidate.expectations[first.slot_id];
  assert.throws(() => executionForSlot({ plan, bindings: args.cases, slotBindings: loaded, slot: first }), /Writable slot/);
  const again = await prepareEpisodeFixtures(args, { prepare: () => { throw new Error('must not recreate'); }, reconcile: () => { throw new Error('must not touch remote'); } });
  assert.deepEqual(again.registration, prepared.registration);
  // Later events may update mutable provider bindings. The initial snapshot is
  // still the exact evidence used by recovery and offline analysis.
  await writeFile(join(plans[0].control_root, 'objects/bindings.json'), '{"after_event":true}\n');
  assert.equal((await read(args, prepared.registration)).size, 4);
});

test('declared per-slot bindings reject omissions, crossed ownership and changed initial material', async () => {
  const args = await fixture(1), prepared = await prepareEpisodeFixtures(args, { prepare: materialize });
  const missing = structuredClone(prepared.registration); delete missing.slot_bindings[args.slots[0].slot_id];
  await assert.rejects(read(args, missing), /exactly the writable/);
  const crossed = structuredClone(prepared.registration); crossed.slot_bindings[args.slots[0].slot_id] = crossed.slot_bindings[args.slots[1].slot_id];
  await assert.rejects(read(args, crossed));
  const changed = structuredClone(args); changed.slots[0].repeat += 1;
  await assert.rejects(read(changed, prepared.registration));
  const item = prepared.slots.get(args.slots[0].slot_id);
  await writeFile(item.binding.skill_inventory[0].path, 'changed initial bytes');
  await assert.rejects(read(args, prepared.registration), /Observed native equivalent changed/);
});

test('an ambiguous preparation is retained and only read-only reconciliation is reachable on re-entry', async () => {
  const args = await fixture(1); args.slots = [args.slots[0]];
  let starts = 0, checks = 0, retainedPlan;
  const operations = { prepare: async plan => { starts++; retainedPlan = plan; return { status: 'unknown', effect_unknown: true }; },
    reconcile: async () => { checks++; return { status: 'unknown', effect_unknown: true }; } };
  await assert.rejects(prepareEpisodeFixtures(args, operations), /unresolved/);
  await assert.rejects(prepareEpisodeFixtures(args, operations), /unresolved/);
  assert.equal(starts, 1); assert.equal(checks, 1);
  const completed = await materialize(retainedPlan);
  const result = await prepareEpisodeFixtures(args, { ...operations, reconcile: async () => { checks++; return completed; } });
  assert.equal(result.slots.size, 1); assert.equal(starts, 1); assert.equal(checks, 2);
});

test('a lost ready acknowledgement reconciles the same scope without preparing it twice', async () => {
  const args = await fixture(1); args.slots = [args.slots[0]];
  let preparations = 0, retained, ownedRoot, reconciliations = 0;
  await assert.rejects(prepareEpisodeFixtures(args, { prepare: async plan => {
    preparations++; ownedRoot = plan.control_root; retained = await materialize(plan); throw new Error('lost worker acknowledgement');
  } }), /unresolved/);
  const recovered = await prepareEpisodeFixtures(args, { prepare: () => { preparations++; throw new Error('cannot replay preparation'); },
    reconcile: async ({ controlRoot }) => { reconciliations++; assert.equal(controlRoot, ownedRoot); return retained; } });
  assert.equal(preparations, 1); assert.equal(reconciliations, 1); assert.equal(recovered.slots.size, 1);
  assert.equal((await read(args, recovered.registration)).size, 1);
});

test('read-only cases require no fixture policy or effects; unsupported placement is rejected before preparation', async () => {
  const args = await fixture(1); args.cases[0].events = [];
  const result = await prepareEpisodeFixtures({ ...args, policy: undefined }, { prepare: () => { throw new Error('no writes'); } });
  assert.equal(result.registration, null); assert.equal((await read({ ...args, policy: undefined }, null)).size, 0);
  assert.throws(() => validateEpisodeFixturePolicy({ ...args.policy, placement: 'mixed' }), /complete Notion/);
  assert.throws(() => validateEpisodeFixturePolicy({ ...args.policy, placement: 'project' }), /complete Notion/);
  const stateful = await fixture(1); let writes = 0;
  await assert.rejects(prepareEpisodeFixtures({ ...stateful, policy: undefined }, { prepare: () => { writes++; } }), /episode_fixtures/);
  assert.equal(writes, 0);
});

test('retained slot captures bind the actual entry, native root, physical prompt and input inventory', () => {
  const binding = { id: 'case', input_root: '/owned/inputs', input_inventory_sha256: 'a'.repeat(64), notion_entry: 'entry-one',
    skills_root: '/owned/native-one', public_case: { turns: [{ id: 'one', prompt: 'Use owned-material-one' }] } };
  const launch = { input_root: binding.input_root, input_inventory_sha256: binding.input_inventory_sha256,
    runtime_config: { turns: structuredClone(binding.public_case.turns), correlation: { candidate_id: 'm0-e0', task_id: binding.id } } };
  const candidate = { build_id: 'build', mode: 'broker' }, run = { build_id: 'build', pi_launch: { mode: 'broker' }, remote: { entry: 'entry-one' } };
  const args = { binding, launch, candidate, run, conditionId: 'm0-e0' };
  verifyRetainedSlotCapture(args);
  for (const mutate of [value => { value.run.remote.entry = 'entry-two'; }, value => { value.launch.runtime_config.turns[0].prompt = 'another physical fixture'; },
    value => { value.launch.input_inventory_sha256 = 'b'.repeat(64); }]) { const wrong = structuredClone(args); mutate(wrong); assert.throws(() => verifyRetainedSlotCapture(wrong)); }
  const native = structuredClone(args); native.candidate.mode = 'native'; native.run.pi_launch = { mode: 'native', native_corpus: { source: binding.skills_root } }; native.run.remote.entry = null;
  verifyRetainedSlotCapture(native); native.run.pi_launch.native_corpus.source = '/owned/native-two'; assert.throws(() => verifyRetainedSlotCapture(native));
});
