import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fingerprint } from './protocol.mjs';
import { prepareMaterialOwnership, verifyMaterialOwnership } from './material-ownership.mjs';
import { CURRENT_SOURCE_CONTRACT } from './current-source-views.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safe = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const inside = (root, path) => { const child = relative(root, path); return child !== '..' && !child.startsWith('../') && !isAbsolute(child); };
const explicit = setup => setup.candidates.some(candidate => candidate.materialization_binding_file !== undefined);

// Match the subject's public-input inventory without importing its launcher
// into an offline verifier. Cross-boundary tests compare these actual bytes,
// path order and executable flags with inventoryPublicInputs.
async function publicInputs(root, prefix = '') {
  const files = [];
  for (const item of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? prefix + '/' + item.name : item.name;
    assert.ok(!item.isSymbolicLink(), 'Condition material public input cannot contain links: ' + path);
    if (item.isDirectory()) files.push(...await publicInputs(root, path));
    else {
      assert.ok(item.isFile(), 'Condition material public input must be an ordinary file');
      const bytes = await readFile(join(root, path));
      files.push({ path, sha256: sha(bytes), bytes: bytes.length, executable: Boolean((await lstat(join(root, path))).mode & 0o111) });
    }
  }
  return files;
}

async function artifact(path, expected, root) {
  assert.ok(isAbsolute(path ?? ''), 'Condition material requires an absolute artifact path');
  if (root) assert.ok(inside(root, path), 'Condition material artifact escaped its owned root');
  assert.equal(await realpath(path), path, 'Condition material artifact cannot traverse a symlink');
  const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024 * 1024);
  const bytes = await readFile(path), reference = { path, sha256: sha(bytes), bytes: bytes.length };
  if (expected) {
    assert.match(expected.sha256, /^[a-f0-9]{64}$/);
    assert.equal(reference.sha256, expected.sha256, 'Condition material artifact changed: ' + path);
    if (expected.bytes !== undefined) assert.equal(reference.bytes, expected.bytes);
  }
  return { bytes, reference, mode: info.mode & 0o111 ? '100755' : '100644' };
}

/** A candidate override is a read-only material proof, never fixture allocation
 * or a way to change a previously authorized continuation's physical inputs. */
export function assertConditionMaterialSetup(setup) {
  if (!explicit(setup)) return false;
  assert.ok(isAbsolute(setup.materialization_binding_file ?? ''), 'Condition material requires a canonical/default materialization binding');
  assert.equal(setup.corpus?.snapshot, undefined, 'Condition material cannot also select a corpus snapshot');
  assert.equal(setup.episode_fixtures, undefined, 'Condition material cannot be combined with episode-owned fixtures');
  assert.equal(setup.campaign_scope, undefined, 'Condition material cannot override a finite campaign continuation');
  assert.equal(setup.pilot_scope, undefined, 'Condition material cannot override a legacy pilot scope');
  assert.equal(setup.resume_after_zero_send, undefined, 'Condition material cannot override a retained resumption');
  for (const candidate of setup.candidates) if (candidate.materialization_binding_file !== undefined)
    assert.ok(typeof candidate.materialization_binding_file === 'string' && isAbsolute(candidate.materialization_binding_file), 'Candidate materialization binding must be an absolute file');
  return true;
}

async function buildPublicSdk(environmentRoot, buildId, { verifyBytes = true } = {}) {
  assert.ok(safe(buildId), 'Condition material build identity is invalid');
  const root = join(environmentRoot, 'builds', buildId), path = join(root, 'build.json');
  const selected = await artifact(path, null, environmentRoot), build = JSON.parse(selected.bytes);
  assert.equal(build.version, 1); assert.equal(build.kind, 'paired-build');
  assert.equal(build.build_id, buildId); assert.equal(build.root, root);
  const inventory = build.packages?.cli;
  assert.ok(Array.isArray(inventory?.files));
  assert.equal(sha(JSON.stringify(inventory.files)), inventory.sha256, 'Condition material CLI inventory changed');
  const matches = inventory.files.filter(file => file.path === 'dist/sdk.js');
  assert.equal(matches.length, 1, 'Condition material requires one unambiguous paired public SDK');
  const sdk = matches[0]; assert.match(sdk.sha256, /^[a-f0-9]{64}$/);
  const reference = { path: join(root, 'cli/dist/sdk.js'), sha256: sdk.sha256 };
  if (verifyBytes) await artifact(reference.path, reference, root);
  return { build: selected.reference, public_sdk: reference };
}

async function materialProof(binding) {
  assert.equal(binding.source_contract, CURRENT_SOURCE_CONTRACT, 'Condition material requires the current explicit source contract');
  assert.ok(binding.materialization_proof, 'Condition material proof is missing');
  const proof = JSON.parse((await artifact(binding.materialization_proof.path, binding.materialization_proof)).bytes);
  assert.equal(proof.source_contract, CURRENT_SOURCE_CONTRACT);
  assert.equal(proof.status, 'passed'); assert.equal(proof.parity?.status, 'valid'); assert.equal(proof.visibility?.status, 'valid');
  assert.ok(proof.source_sdk, 'Condition material SDK proof is missing');
  await artifact(proof.source_sdk.path, proof.source_sdk);
  assert.equal(proof.entry, binding.notion_entry); assert.equal(proof.library_id, binding.notion_entry);
  assert.deepEqual(proof.identity_map, binding.identity_map, 'Condition material names differ from the proven identity map');
  assert.deepEqual(proof.files.filter(file => file.skill_id), binding.skill_inventory);
  return proof;
}

async function nativeInventory(binding) {
  const entries = [], identities = new Set();
  for (const file of binding.skill_inventory) {
    const identity = file.skill_id + '/' + file.resource_path;
    assert.ok(!identities.has(identity), 'Condition material native resource is ambiguous'); identities.add(identity);
    const actual = await artifact(file.path, file, binding.skills_root);
    assert.equal(actual.mode, file.mode, 'Condition material native executable mode changed');
    entries.push({ skill_id: file.skill_id, resource_path: file.resource_path, native_path: relative(binding.skills_root, file.path),
      sha256: file.sha256, bytes: actual.bytes.length, mode: file.mode });
  }
  return entries.sort((a, b) => (a.skill_id + '/' + a.resource_path).localeCompare(b.skill_id + '/' + b.resource_path));
}

function canonicalResources(proof) {
  assert.ok(Array.isArray(proof.canonical_to_actual) && proof.canonical_to_actual.length > 0);
  const identities = new Set();
  return proof.canonical_to_actual.map(item => {
    const id = item.skill_id + '/' + item.path; assert.ok(!identities.has(id), 'Condition material canonical resource is ambiguous'); identities.add(id);
    assert.equal(item.matched, true);
    return { skill_id: item.skill_id, path: item.path, canonical_sha256: item.canonical_sha256,
      prepared_sha256: item.prepared_sha256, actual_sha256: item.actual_sha256 };
  }).sort((a, b) => (a.skill_id + '/' + a.path).localeCompare(b.skill_id + '/' + b.path));
}

/** Only provenance and SDK producer may differ. The subject's public inputs,
 * oracle, Library names and exact native bytes are the same scientific case. */
export async function assertEquivalentConditionMaterial(canonical, selected) {
  for (const key of ['id', 'base_case_id', 'variant', 'public_case', 'oracle_sha256', 'input_inventory_sha256',
    'events', 'clarification', 'identity_map', 'notion_entry', 'source_contract'])
    assert.deepEqual(selected[key], canonical[key], 'Condition material changes canonical case field: ' + key);
  for (const binding of [canonical, selected]) {
    await artifact(binding.oracle_path, { sha256: binding.oracle_sha256 });
    assert.equal(sha(JSON.stringify(await publicInputs(binding.input_root))), binding.input_inventory_sha256, 'Condition material public input bytes changed');
  }
  assert.deepEqual(await nativeInventory(selected), await nativeInventory(canonical), 'Condition material changes native bytes or names');
  const a = await materialProof(canonical), b = await materialProof(selected);
  for (const key of ['public_sha256', 'entry', 'library_id', 'parent_page_id', 'candidate_count', 'catalog_skill_ids', 'identity_map'])
    assert.deepEqual(b[key], a[key], 'Condition material changes proven catalog field: ' + key);
  assert.deepEqual(canonicalResources(b), canonicalResources(a), 'Condition material changes canonical resources');
  // bindMaterializedCases includes its own proof hash in content_sha256. That
  // physical provenance stays in the execution record, as with slot fixtures.
  const scientific = ({ content_sha256: _content, initial_state_sha256: _initial, ...value }) => value;
  assert.deepEqual(scientific(selected.protocol_case), scientific(canonical.protocol_case), 'Condition material changes scientific case identity');
}

/** Run before credentials, capture or remote fixture preparation. Scalar
 * setups use the same SDK check while retaining their existing plan format. */
export async function prepareConditionMaterialBindings({ setup, cases, unboundCases, materialization }) {
  const conditional = assertConditionMaterialSetup(setup);
  if (conditional) {
    assert.equal(materialization?.access, 'shared-readonly');
    assert.ok(cases.every(binding => binding.events.length === 0 && !binding.fixture_control), 'Condition material cannot be combined with stateful cases');
    assert.equal(new Set(setup.candidates.map(candidate => candidate.id)).size, setup.candidates.length, 'Condition material candidate identities must be unique');
  }
  // Preparation is never called by offline readers. The live controller still
  // freezes planning through configure.mjs's existing static import closure.
  const bindMaterializedCases = conditional ? (await import('./planning.mjs')).bindMaterializedCases : null;
  const candidates = [];
  for (const candidate of setup.candidates) {
    let bindings = cases;
    if (conditional) {
      const source = candidate.materialization_binding_file ?? setup.materialization_binding_file;
      const selected = JSON.parse((await artifact(source)).bytes);
      assert.equal(selected.access, 'shared-readonly'); assert.equal(selected.status, 'ready');
      for (const key of ['public_sha256', 'entry', 'library_id', 'parent_page_id', 'case_ids', 'catalog_skill_ids', 'identity_map', 'source_contract'])
        assert.deepEqual(selected[key], materialization[key], 'Condition materialization changes canonical field: ' + key);
      assert.ok(selected.prepared_bindings, 'Condition material requires immutable fixture bindings');
      await artifact(selected.prepared_bindings.path, selected.prepared_bindings);
      const selectedProof = JSON.parse((await artifact(selected.materialization_proof?.path, selected.materialization_proof)).bytes);
      assert.equal(selectedProof.fixture_bindings?.sha256, selected.prepared_bindings.sha256, 'Condition material fixture bindings differ from their proof');
      assert.deepEqual(selectedProof.identity_map, selected.identity_map, 'Condition materialization names differ from their proof');
      bindings = await bindMaterializedCases({ cases: unboundCases, materialization: { ...selected, fixture_bindings_path: selected.prepared_bindings.path } });
      assert.equal(bindings.length, cases.length);
      for (const [index, binding] of bindings.entries()) {
        await assertEquivalentConditionMaterial(cases[index], binding);
        binding.protocol_case = structuredClone(cases[index].protocol_case);
      }
    }
    const current = bindings.filter(binding => binding.source_contract === CURRENT_SOURCE_CONTRACT);
    if (!current.length) { assert.equal(conditional, false, 'Condition material SDK proof is missing'); continue; }
    const build = await buildPublicSdk(setup.environment_root, candidate.build_id);
    for (const binding of current) {
      const proof = await materialProof(binding);
      assert.equal(proof.source_sdk.sha256, build.public_sdk.sha256, 'Material and selected build must use the same paired SDK before capture');
      if (candidate.mode === 'broker') assert.equal(candidate.notion_entry, binding.notion_entry);
    }
    candidates.push({ candidate_id: candidate.id, build_id: candidate.build_id, ...build, bindings });
  }
  return { conditional, candidates };
}

export function hasConditionMaterialBindings(execution) {
  return execution.condition_materials !== undefined || Object.values(execution.conditions ?? {}).some(condition => condition.case_bindings !== undefined);
}

async function save(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  assert.equal(await realpath(dirname(path)), dirname(path), 'Condition material destination cannot traverse a symlink');
  const bytes = JSON.stringify(value, null, 2) + '\n';
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await readFile(path, 'utf8'), bytes, 'Existing condition material differs'); }
  return (await artifact(path)).reference;
}

/** Freeze owned proof closures under condition identities. No source tree or
 * remote fixture is copied; existing material ownership deduplicates cases. */
export async function freezeConditionMaterialBindings({ prepared, execution, cases, candidates }) {
  if (!prepared.conditional) return { references: {}, registration: null, bindings: new Map() };
  const references = {}, root = execution.control_root;
  for (const [conditionId, candidate] of Object.entries(candidates)) {
    assert.ok(safe(conditionId));
    const selected = prepared.candidates.find(item => item.candidate_id === candidate.id); assert.ok(selected);
    assert.equal(selected.build_id, candidate.build_id);
    const bindings = [], ownership = [];
    for (const original of selected.bindings) {
      const materialId = fingerprint({ materialization_proof: original.materialization_proof, skills_root: original.skills_root, skill_inventory: original.skill_inventory });
      const projected = await prepareMaterialOwnership({ binding: original, directory: join(root, 'material-ownership', materialId), environmentRoot: execution.environment_root });
      const canonical = cases.find(binding => binding.id === original.id); assert.ok(canonical);
      await assertEquivalentConditionMaterial(canonical, projected.binding);
      assert.deepEqual(projected.binding.protocol_case, canonical.protocol_case);
      bindings.push(projected.binding); ownership.push({ case_id: original.id, reference: projected.reference });
    }
    const record = { version: 1, kind: 'benchmark-condition-materialization', condition_id: conditionId, build_id: selected.build_id,
      build: selected.build, public_sdk: selected.public_sdk,
      canonical_bindings: { path: execution.case_bindings_file, sha256: execution.case_bindings_sha256 },
      original_bindings: selected.bindings, material_ownership: ownership, bindings };
    references[conditionId] = await save(join(root, 'condition-bindings', conditionId + '.json'), record);
  }
  const registration = { version: 1, condition_ids: Object.keys(candidates).sort() };
  const value = { ...execution, condition_materials: registration,
    conditions: Object.fromEntries(Object.entries(candidates).map(([id, candidate]) => [id, { ...candidate, case_bindings: references[id] }])) };
  return { references, registration, bindings: await readConditionMaterialBindings({ execution: value, bindings: cases }) };
}

/** Verify only owned proof snapshots on replay. The frozen build manifest
 * supplies its SDK identity; execution still performs the full build check. */
export async function readConditionMaterialBindings({ execution, bindings }) {
  const loaded = new Map();
  if (!hasConditionMaterialBindings(execution)) return loaded;
  assert.equal(execution.condition_materials?.version, 1, 'Condition material registration is missing');
  assert.deepEqual(execution.condition_materials.condition_ids, Object.keys(execution.conditions).sort(), 'Condition material registration is incomplete');
  assert.equal(execution.episode_fixtures, undefined, 'Condition material cannot be combined with episode-owned fixtures');
  for (const field of ['resumption', 'campaign_scope', 'pilot_scope', 'corpus_snapshot'])
    assert.equal(execution[field], undefined, 'Condition material cannot override a retained ' + field);
  assert.ok(bindings.every(binding => binding.events.length === 0 && !binding.fixture_control), 'Condition material cannot be combined with stateful cases');
  const root = execution.control_root;
  const canonical = await artifact(execution.case_bindings_file, { sha256: execution.case_bindings_sha256 }, root);
  assert.deepEqual(bindings, JSON.parse(canonical.bytes), 'Condition material canonical bindings changed');
  assert.equal(new Set(bindings.map(binding => binding.id)).size, bindings.length);
  for (const [conditionId, condition] of Object.entries(execution.conditions)) {
    assert.ok(safe(conditionId));
    const ref = condition.case_bindings; assert.ok(ref, 'Condition material binding is missing');
    assert.equal(ref.path, join(root, 'condition-bindings', conditionId + '.json'), 'Condition material belongs to another condition');
    const record = JSON.parse((await artifact(ref.path, ref, root)).bytes);
    assert.equal(record.version, 1); assert.equal(record.kind, 'benchmark-condition-materialization');
    assert.equal(record.condition_id, conditionId, 'Condition material belongs to another condition');
    assert.equal(record.build_id, condition.build_id, 'Condition material belongs to another build');
    assert.deepEqual(record.canonical_bindings, { path: execution.case_bindings_file, sha256: execution.case_bindings_sha256 });
    const build = await buildPublicSdk(execution.environment_root, condition.build_id, { verifyBytes: false });
    assert.deepEqual(record.build, build.build); assert.deepEqual(record.public_sdk, build.public_sdk);
    for (const list of [record.bindings, record.original_bindings, record.material_ownership])
      assert.deepEqual(list.map(item => item.id ?? item.case_id), bindings.map(binding => binding.id), 'Condition material case coverage changed');
    for (const [index, binding] of record.bindings.entries()) {
      const original = record.original_bindings[index], ownership = record.material_ownership[index];
      const projected = await verifyMaterialOwnership({ binding: original, reference: ownership.reference, environmentRoot: execution.environment_root });
      assert.deepEqual(projected.binding, binding, 'Condition material differs from its owned projection');
      await assertEquivalentConditionMaterial(bindings[index], binding);
      assert.deepEqual(binding.protocol_case, bindings[index].protocol_case, 'Condition material changed common scientific identity');
      assert.equal((await materialProof(binding)).source_sdk.sha256, record.public_sdk.sha256, 'Condition material proof belongs to another SDK');
      if (condition.mode === 'broker') assert.equal(binding.notion_entry, condition.notion_entry);
    }
    loaded.set(conditionId, { reference: ref, record, bindings: record.bindings });
  }
  return loaded;
}

/** Dispatch and offline reanalysis select exactly the same frozen proof. An
 * incomplete conditional registration must never fall back to a global case. */
export function selectCaseBinding({ execution, bindings, conditionBindings, slotBindings = new Map(), slot }) {
  if (hasConditionMaterialBindings(execution)) {
    assert.equal(slotBindings.size, 0, 'Condition material cannot be combined with slot fixtures');
    assert.ok(conditionBindings instanceof Map && conditionBindings.has(slot.condition_id), 'Verified condition material binding is missing');
    const selected = conditionBindings.get(slot.condition_id);
    assert.equal(selected.record.condition_id, slot.condition_id);
    assert.equal(selected.record.build_id, execution.conditions[slot.condition_id]?.build_id);
    const binding = selected.bindings.find(binding => binding.id === slot.case_id); assert.ok(binding, 'Condition material case is missing');
    return binding;
  }
  return slotBindings.get(slot.slot_id)?.binding ?? bindings.find(binding => binding.id === slot.case_id);
}
