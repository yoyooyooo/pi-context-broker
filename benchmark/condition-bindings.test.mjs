import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCorpus, bindPublicCaseToFixture } from './corpus/index.mjs';
import { planBenchmarkFixture } from './fixture.mjs';
import { bindMaterializedCases, prepareCases } from './planning.mjs';
import { prepareMaterialOwnership } from './material-ownership.mjs';
import { fingerprint } from './protocol.mjs';
import { CURRENT_SOURCE_CONTRACT } from './current-source-views.mjs';
import { configureComparison } from './configure.mjs';
import { executionForSlot } from './controller.mjs';
import { inventoryPublicInputs } from './subject.mjs';
import { OFFLINE_REVISION_VERIFIER_SOURCE_FILES } from './offline-source-files.mjs';
import { assertConditionMaterialSetup, assertEquivalentConditionMaterial, prepareConditionMaterialBindings,
  freezeConditionMaterialBindings, readConditionMaterialBindings, selectCaseBinding } from './condition-bindings.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFile(path, 'utf8').then(JSON.parse);
async function save(path, value, mode = '100644') {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { mode: mode === '100755' ? 0o700 : 0o600 });
  return { path, sha256: sha(bytes), bytes: bytes.length };
}

// These are local synthetic receipts. They exercise real corpus binding,
// ownership and replay without a Library, credentials, captures or model calls.
async function fixture({ turnRuntime = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-condition-material-'))), control = join(root, 'control/attempt');
  await mkdir(control, { recursive: true });
  await save(join(root, 'environment.json'), { kind: 'paired-development-environment', root, environment_id: 'condition-fixture' });
  const builds = [];
  for (const id of ['reference', 'candidate']) {
    const buildRoot = join(root, 'builds', id), sdk = await save(join(buildRoot, 'cli/dist/sdk.js'), 'export const fixtureSdk = ' + JSON.stringify(id) + ';\n');
    const files = [{ path: 'dist/sdk.js', sha256: sdk.sha256, executable: false }], sourceFiles = [];
    if (turnRuntime) for (const name of ['subject.mjs', 'turn-bridge.mjs', 'runtime/episode-runner.mjs', 'runtime/episode-visibility.mjs']) {
      const path = 'broker/benchmark/' + name, ref = await save(join(buildRoot, 'source', path), await readFile(new URL('./' + name, import.meta.url)));
      sourceFiles.push({ path, sha256: ref.sha256, executable: false });
    }
    const brokerFiles = [{ path: 'synthetic.js', sha256: sha('synthetic'), executable: false }];
    const manifest = { version: 1, kind: 'paired-build', build_id: id, root: buildRoot, environment_id: 'condition-fixture', selected_cli_sha256: sha('cli'),
      packages: { cli: { files, sha256: sha(JSON.stringify(files)) }, broker: { files: brokerFiles, sha256: sha(JSON.stringify(brokerFiles)) } },
      source_tree: { files: sourceFiles, sha256: sha(JSON.stringify(sourceFiles)) } };
    const ref = await save(join(buildRoot, 'build.json'), manifest); builds.push({ id, root: buildRoot, sdk, manifest, reference: ref });
  }
  const plan = planBenchmarkFixture({ corpus: buildCorpus({ seed: 'condition-material-corpus', split: 'development', materialVersion: '2' }),
    caseIds: ['explicit-01-a', 'continuation-01-a'], scopeId: 'condition-material-fixture', controlRoot: join(root, 'fixture-plan'),
    projectPageId: '11111111-1111-4111-8111-111111111111', buildRoot: builds[0].root, node: process.execPath });
  const corpus = plan.corpus, selections = plan.case_ids.map(caseId => ({ caseId, candidateCount: 16 }));
  const unboundCases = await prepareCases({ corpus, selections, root: join(control, 'cases') });
  const publicCorpus = await save(join(root, 'corpus/public.json'), corpus.publicCorpus), privateCorpus = await save(join(root, 'corpus/control.json'), corpus.control);
  const entry = '22222222-2222-4222-8222-222222222222', materials = [];
  for (const build of builds) {
    const source = join(root, 'material-' + build.id), nativeRoot = join(source, 'native'), skillsRoot = join(nativeRoot, '.agents/skills');
    const values = {}, objects = {}, files = [], parity = [];
    for (const [skillId, mapping] of Object.entries(plan.fixture.skill_mapping)) {
      values[mapping.object_id + '.name'] = mapping.name;
      objects[mapping.object_id] = { skillId: 'observed-' + skillId, pageId: sha(skillId).slice(0, 32) };
      for (const item of plan.fixture.expected_inventory.filter(file => file.skill_id === skillId)) {
        const ref = await save(join(skillsRoot, mapping.name, item.path), Buffer.from(item.content, item.encoding), item.mode);
        const receipt = await save(join(source, 'receipts', skillId + '-' + sha(item.path).slice(0, 8) + '.json'), { observed: true });
        files.push({ ...ref, skill_id: skillId, resource_path: item.path, relative_path: relative(nativeRoot, ref.path), mode: item.mode });
        parity.push({ skill_id: skillId, path: item.path, canonical_source: ref, prepared_source: ref, actual_source: ref,
          receipt, raw_receipt: receipt, canonical_sha256: ref.sha256, prepared_sha256: ref.sha256, actual_sha256: ref.sha256,
          method: 'exact-bytes', matched: true, comparison: { matched: true } });
      }
    }
    const fixtureBindings = { public: values, private: { objects } }, prepared = await save(join(source, 'fixture-bindings.json'), fixtureBindings);
    const identity = bindPublicCaseToFixture({ publicCase: unboundCases[0].public_case, skillMapping: plan.fixture.skill_mapping, bindings: fixtureBindings }).identity_map;
    const proof = { schema_version: 1, status: 'passed', parity: { status: 'valid' }, visibility: { status: 'valid' },
      public_sha256: corpus.publicCorpus.content_sha256, source_contract: CURRENT_SOURCE_CONTRACT, source_sdk: build.sdk,
      entry, library_id: entry, parent_page_id: entry, candidate_count: 16, catalog_skill_ids: plan.catalog_skill_ids,
      catalog: { candidates: 16, exhaustive: true }, identity_map: identity, canonical_to_actual: parity, files,
      native_root: nativeRoot, native_skill_root: skillsRoot, fixture_bindings: prepared };
    const proofRef = await save(join(source, 'materialization-proof.json'), proof);
    const materialization = { schema_version: 1, status: 'ready', access: 'shared-readonly', control_root: source,
      public_corpus_path: publicCorpus.path, control_path: privateCorpus.path, public_sha256: corpus.publicCorpus.content_sha256,
      source_contract: CURRENT_SOURCE_CONTRACT, entry, library_id: entry, parent_page_id: entry, case_ids: plan.case_ids,
      catalog_skill_ids: plan.catalog_skill_ids, identity_map: identity, materialization_proof: proofRef, native_skill_root: skillsRoot,
      fixture_bindings_path: prepared.path, prepared_bindings: prepared };
    const reference = await save(join(source, 'binding.json'), materialization); materials.push({ source, proof, materialization, reference });
  }
  const setup = { version: 1, id: 'condition-material-test', environment_root: root, control_root: control,
    materialization_binding_file: materials[0].reference.path,
    candidates: builds.map((build, index) => ({ id: build.id, build_id: build.id, mode: 'broker', notion_entry: entry,
      ...(index ? { materialization_binding_file: materials[index].reference.path } : {}) })),
    corpus: { seed: corpus.publicCorpus.seed, split: corpus.publicCorpus.split, material_version: corpus.publicCorpus.version, selections },
    budget: {}, decision: {}, models: { source_file: join(root, 'credential-must-not-be-read.json') } };
  const cases = await bindMaterializedCases({ cases: unboundCases, materialization: materials[0].materialization });
  return { root, control, builds, materials, setup, cases, unboundCases };
}
const preflight = f => prepareConditionMaterialBindings({ setup: f.setup, cases: f.cases, unboundCases: f.unboundCases, materialization: f.materials[0].materialization });
async function frozen(f) {
  const prepared = await preflight(f), bindings = [];
  for (const binding of f.cases) {
    const materialId = fingerprint({ materialization_proof: binding.materialization_proof, skills_root: binding.skills_root, skill_inventory: binding.skill_inventory });
    bindings.push((await prepareMaterialOwnership({ binding, directory: join(f.control, 'material-ownership', materialId), environmentRoot: f.root })).binding);
  }
  const ref = await save(join(f.control, 'case-bindings.json'), bindings);
  const candidates = Object.fromEntries(f.setup.candidates.map((candidate, index) => ['m0-e' + index, candidate]));
  const execution = { environment_root: f.root, control_root: f.control, case_bindings_file: ref.path, case_bindings_sha256: ref.sha256, conditions: candidates };
  const owned = await freezeConditionMaterialBindings({ prepared, execution, cases: bindings, candidates });
  execution.condition_materials = owned.registration;
  execution.conditions = Object.fromEntries(Object.entries(candidates).map(([id, candidate]) => [id, { ...candidate, case_bindings: owned.references[id],
    expectations: Object.fromEntries(bindings.map(binding => [binding.id, { path: '/synthetic/' + id, sha256: sha(id) }])) }]));
  return { execution, bindings, owned };
}
async function rewriteProof(material, mutate) {
  mutate(material.proof);
  material.materialization.materialization_proof = await save(material.materialization.materialization_proof.path, material.proof);
  material.reference = await save(material.reference.path, material.materialization);
}

test('different paired SDKs retain their own proof while dispatch and reanalysis share the same scientific cases', async () => {
  const f = await fixture(), value = await frozen(f);
  assert.notEqual(f.builds[0].sdk.sha256, f.builds[1].sdk.sha256);
  const plan = { execution: value.execution, protocol: { conditions: Object.keys(value.execution.conditions).map(id => ({ id, model_id: 'unit' })), models: [{ id: 'unit' }] } };
  // Owned snapshots remain usable for offline readers after original material
  // and SDK files leave their old locations. The build manifests stay frozen.
  for (const material of f.materials) await rename(material.source, material.source + '-retired');
  for (const build of f.builds) await rename(join(build.root, 'cli'), join(build.root, 'cli-retired'));
  const loaded = await readConditionMaterialBindings({ execution: value.execution, bindings: value.bindings });
  for (const [index, conditionId] of Object.keys(value.execution.conditions).entries()) for (const canonical of value.bindings) {
    const slot = { slot_id: canonical.id + '-' + conditionId, case_id: canonical.id, condition_id: conditionId };
    const selected = executionForSlot({ plan, bindings: value.bindings, slotBindings: new Map(), conditionBindings: loaded, slot });
    assert.deepEqual(selected.binding.protocol_case, canonical.protocol_case);
    assert.deepEqual(selected.binding.public_case, canonical.public_case);
    assert.equal(selected.binding.oracle_sha256, canonical.oracle_sha256);
    assert.equal((await read(selected.binding.materialization_proof.path)).source_sdk.sha256, f.builds[index].sdk.sha256);
    assert.deepEqual(selectCaseBinding({ execution: value.execution, bindings: value.bindings, conditionBindings: loaded, slot }), selected.binding);
    assert.throws(() => executionForSlot({ plan, bindings: value.bindings, slotBindings: new Map(), slot }), /Verified condition material binding is missing/);
  }
});

test('legacy scalar same-SDK setups use preflight without changing their execution format', async () => {
  const f = await fixture();
  delete f.setup.candidates[1].materialization_binding_file; f.setup.candidates[1].build_id = f.builds[0].id;
  const prepared = await preflight(f); assert.equal(prepared.conditional, false); assert.equal(prepared.candidates.length, 2);
  assert.deepEqual(await readConditionMaterialBindings({ execution: { conditions: { a: {}, b: {} } }, bindings: f.cases }), new Map());
  assert.deepEqual(await freezeConditionMaterialBindings({ prepared }), { references: {}, registration: null, bindings: new Map() });
});

test('the declared portable verifier reads both owned SDK proofs after the original sources leave', async () => {
  const f = await fixture(), value = await frozen(f), isolated = join(f.control, 'portable/benchmark');
  for (const file of OFFLINE_REVISION_VERIFIER_SOURCE_FILES)
    await save(join(isolated, file), await readFile(join(dirname(fileURLToPath(import.meta.url)), file)));
  await save(join(isolated, 'implementation.mjs'), "export function executionImplementation(){throw Error('live source must not be consulted')}\nexport function instrumentationIdentity(){throw Error('live source must not be consulted')}\n");
  const verifier = await import(pathToFileURL(join(isolated, 'revision.mjs')).href);
  assert.equal(typeof verifier.verifyAnalysisRevision, 'function');
  for (const name of ['planning.mjs', 'subject.mjs', 'configure.mjs', 'models.mjs', 'runtime/episode-runner.mjs'])
    await assert.rejects(readFile(join(isolated, name)), { code: 'ENOENT' });
  for (const material of f.materials) await rename(material.source, material.source + '-retired');
  for (const build of f.builds) await rename(join(build.root, 'cli'), join(build.root, 'cli-retired'));
  const offline = await import(pathToFileURL(join(isolated, 'condition-bindings.mjs')).href);
  const loaded = await offline.readConditionMaterialBindings({ execution: value.execution, bindings: value.bindings });
  for (const [index, id] of Object.keys(value.execution.conditions).entries()) {
    const binding = offline.selectCaseBinding({ execution: value.execution, bindings: value.bindings, conditionBindings: loaded,
      slot: { condition_id: id, case_id: value.bindings[0].id } });
    assert.equal((await read(binding.materialization_proof.path)).source_sdk.sha256, f.builds[index].sdk.sha256);
  }
});

test('offline input verification matches subject ordering, binary bytes, executable modes and link rejection', async () => {
  const f = await fixture(), selected = (await preflight(f)).candidates[1].bindings[0], canonical = structuredClone(f.cases[0]);
  const root = join(f.control, 'inventory-contract');
  await save(join(root, 'z/empty.bin'), Buffer.alloc(0));
  await save(join(root, 'a/run.bin'), Buffer.from([0, 255, 10, 13]), '100755');
  await save(join(root, 'a/A.txt'), 'two\nlines\n');
  await save(join(root, 'B.txt'), 'text');
  const expected = await inventoryPublicInputs(root);
  for (const binding of [canonical, selected]) { binding.input_root = root; binding.input_inventory_sha256 = sha(JSON.stringify(expected)); }
  await assertEquivalentConditionMaterial(canonical, selected);
  await symlink(join(root, 'B.txt'), join(root, 'linked.txt'));
  await assert.rejects(inventoryPublicInputs(root), /links/);
  await assert.rejects(assertEquivalentConditionMaterial(canonical, selected), /links/);
});

test('a missing, changed or wrong SDK proof fails before material ownership and capture', async () => {
  for (const change of ['missing-sdk', 'wrong-sdk', 'changed-proof']) {
    const f = await fixture();
    if (change === 'missing-sdk') await rewriteProof(f.materials[1], proof => { delete proof.source_sdk; });
    if (change === 'wrong-sdk') f.setup.candidates[1].materialization_binding_file = f.materials[0].reference.path;
    if (change === 'changed-proof') await writeFile(f.materials[1].materialization.materialization_proof.path, '{}');
    await assert.rejects(preflight(f), /SDK proof is missing|same paired SDK|changed/);
    await assert.rejects(readFile(join(f.control, 'condition-bindings/m0-e1.json')), { code: 'ENOENT' });
  }
});

test('ambiguous SDK inventory and changed actual public SDK bytes are rejected', async () => {
  for (const change of ['duplicate', 'changed-bytes']) {
    const f = await fixture(), build = f.builds[1];
    if (change === 'duplicate') {
      build.manifest.packages.cli.files.push({ ...build.manifest.packages.cli.files[0] });
      build.manifest.packages.cli.sha256 = sha(JSON.stringify(build.manifest.packages.cli.files));
      await save(build.reference.path, build.manifest);
    } else await writeFile(build.sdk.path, 'changed');
    await assert.rejects(preflight(f), /unambiguous|changed/);
  }
});

test('public case, oracle, inputs, Library names and native bytes cannot differ between SDK proofs', async () => {
  const f = await fixture(), selected = (await preflight(f)).candidates[1].bindings[0], canonical = f.cases[0];
  for (const mutate of [
    binding => { binding.public_case.turns[0].prompt += ' changed'; },
    binding => { binding.oracle_sha256 = '0'.repeat(64); },
    binding => { binding.input_inventory_sha256 = '0'.repeat(64); },
    binding => { binding.notion_entry = 'another-library'; },
    binding => { binding.identity_map = {}; },
  ]) { const changed = structuredClone(selected); mutate(changed); await assert.rejects(assertEquivalentConditionMaterial(canonical, changed), /canonical case field/); }
  await rewriteProof(f.materials[1], proof => { proof.identity_map = {}; });
  await assert.rejects(preflight(f), /names differ/);
  const bytesFixture = await fixture(), file = bytesFixture.materials[1].proof.files[0];
  await save(file.path, 'different native material');
  await rewriteProof(bytesFixture.materials[1], proof => {
    file.sha256 = sha('different native material'); file.bytes = Buffer.byteLength('different native material');
    const item = proof.canonical_to_actual.find(item => item.skill_id === file.skill_id && item.path === file.resource_path);
    for (const key of ['canonical', 'prepared', 'actual']) { item[key + '_sha256'] = file.sha256; item[key + '_source'].sha256 = file.sha256; item[key + '_source'].bytes = file.bytes; }
  });
  await assert.rejects(preflight(bytesFixture), /native bytes or names/);
});

test('condition records reject swaps, partial registrations, tampering and wrong build ownership', async () => {
  const f = await fixture(), value = await frozen(f), original = structuredClone(value.execution);
  for (const mutate of [
    execution => { delete execution.conditions['m0-e1'].case_bindings; },
    execution => { execution.conditions['m0-e1'].case_bindings = execution.conditions['m0-e0'].case_bindings; },
    execution => { execution.condition_materials = null; },
    execution => { delete execution.condition_materials; },
    execution => { execution.conditions['m0-e1'].build_id = 'reference'; },
    execution => { execution.episode_fixtures = {}; },
    execution => { execution.resumption = {}; },
  ]) { const execution = structuredClone(original); mutate(execution); await assert.rejects(readConditionMaterialBindings({ execution, bindings: value.bindings })); }
  const ref = original.conditions['m0-e1'].case_bindings;
  await writeFile(ref.path, (await readFile(ref.path, 'utf8')) + ' ');
  await assert.rejects(readConditionMaterialBindings({ execution: original, bindings: value.bindings }), /artifact changed/);
});

test('unsupported fixture, snapshot and continuation combinations stop before setup retention', async () => {
  const f = await fixture();
  for (const change of [{ episode_fixtures: {} }, { resume_after_zero_send: {} }, { campaign_scope: {} }, { pilot_scope: {} },
    { corpus: { ...f.setup.corpus, snapshot: {} } }, { materialization_binding_file: undefined }]) {
    const setup = { ...f.setup, ...change, control_root: join(f.root, 'unsupported-' + Object.keys(change)[0]) };
    assert.throws(() => assertConditionMaterialSetup(setup));
    await assert.rejects(configureComparison(setup));
    await assert.rejects(readFile(join(setup.control_root, 'setup.json')), { code: 'ENOENT' });
  }
  f.cases[0].events.push({ id: 'synthetic-write' });
  await assert.rejects(preflight(f), /stateful cases/);
});

test('configure rejects the wrong SDK before it can read unavailable model credentials or capture', async () => {
  const f = await fixture({ turnRuntime: true });
  f.setup.candidates[1].materialization_binding_file = f.materials[0].reference.path;
  await assert.rejects(configureComparison(f.setup), /Material and selected build must use the same paired SDK before capture/);
  for (const path of ['models.json', 'model-registry.json', 'plan.json']) await assert.rejects(readFile(join(f.control, path)), { code: 'ENOENT' });
  await assert.rejects(readFile(f.setup.models.source_file), { code: 'ENOENT' });
});
