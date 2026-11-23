import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, fingerprint } from './protocol.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const encode = value => Buffer.from(canonicalJson(value) + '\n');
const manifestName = 'material-ownership.json';
const proofKeys = new Set(('schema_version status completed_at scope_id evidence_scope public_sha256 entry parent_page_id candidate_count actual_remote_candidates actual_local_candidates initially_absent_skill_ids case_ids catalog_skill_ids parity canonical_to_actual identity_map public_cases files evidence visibility catalog source_materials native_root native_skill_root fixture_bindings fidelity controller_git model_calls remote_repairs preparation_reconciled').split(' '));
const itemKeys = new Set(('skill_id path canonical_sha256 prepared_sha256 actual_sha256 canonical_source prepared_source actual_source receipt raw_receipt matched comparison method public_name_binding public_sdk_path public_sdk_sha256 frontmatter_matches_prepared actual_header_sha256 prepared_header_sha256 canonical_body_comparison prepared_body_comparison').split(' '));
const fileKeys = new Set(['path', 'sha256', 'bytes', 'relative_path', 'skill_id', 'resource_path', 'mode']);
const sourceKeys = ['canonical_source', 'prepared_source', 'actual_source', 'receipt', 'raw_receipt'];

function keys(value, allowed, label) {
  assert.ok(object(value), 'Material ownership needs ' + label);
  assert.ok(Object.keys(value).every(key => allowed.has(key)), 'Unknown material ownership ' + label + ' field');
}
function absolute(path) {
  assert.ok(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'Material ownership needs a canonical absolute path');
  return path;
}
function descriptor(value, { sdk = false } = {}) {
  keys(value, new Set(sdk ? ['path', 'sha256'] : ['path', 'sha256', 'bytes']), 'descriptor');
  absolute(value.path); assert.ok(hashPattern.test(value.sha256 ?? ''), 'Material descriptor needs SHA256');
  if (!sdk) assert.ok(Number.isSafeInteger(value.bytes) && value.bytes >= 0, 'Material descriptor needs byte count');
  return value;
}
function materialFields(binding) {
  assert.ok(object(binding), 'Material ownership needs a binding');
  descriptor(binding.materialization_proof); absolute(binding.skills_root);
  assert.ok(Array.isArray(binding.skill_inventory), 'Material ownership needs a skill inventory');
  return structuredClone({ materialization_proof: binding.materialization_proof, skills_root: binding.skills_root, skill_inventory: binding.skill_inventory });
}
async function ownedRoot(environmentRoot) {
  absolute(environmentRoot);
  const owned = await realpath(environmentRoot);
  assert.equal(owned, environmentRoot, 'Material environment root must not contain symlinks');
  assert.ok((await lstat(owned)).isDirectory(), 'Material environment root must be a directory');
  return owned;
}
async function directoryWithin(owned, directory, create) {
  absolute(directory); assert.ok(inside(owned, directory) && directory !== owned, 'Material destination must be inside its environment');
  let current = owned;
  for (const part of relative(owned, directory).split(sep)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return;
      try { await mkdir(current, { mode: 0o700 }); } catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
      info = await lstat(current);
    }
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Material destination ancestor must be an ordinary directory');
    assert.equal(await realpath(current), current, 'Material destination ancestor changed');
  }
}
async function readVerified(ref, { root = null, mode = null } = {}) {
  absolute(ref.path);
  if (root) assert.ok(inside(root, ref.path), 'Material snapshot escapes its owned directory');
  const before = await lstat(ref.path);
  assert.ok(before.isFile() && !before.isSymbolicLink(), 'Material source must be an ordinary file, not a symlink');
  assert.equal(await realpath(ref.path), ref.path, 'Material source ancestors must not contain symlinks');
  const bytes = await readFile(ref.path), after = await lstat(ref.path);
  assert.ok(after.isFile() && !after.isSymbolicLink(), 'Material source changed while reading');
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key], 'Material source changed while reading');
  assert.equal(await realpath(ref.path), ref.path, 'Material source path changed while reading');
  assert.equal(sha(bytes), ref.sha256, 'Material source SHA256 changed');
  if (ref.bytes !== undefined) assert.equal(bytes.length, ref.bytes, 'Material source byte count changed');
  const observedMode = after.mode & 0o111 ? '100755' : '100644';
  if (mode !== null) assert.equal(observedMode, mode, 'Material executable mode changed');
  return { bytes, mode: observedMode };
}
async function writeOnce(owned, path, bytes, mode = '100644') {
  await directoryWithin(owned, dirname(path), true);
  try { await writeFile(path, bytes, { flag: 'wx', mode: mode === '100755' ? 0o700 : 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await readVerified({ path, sha256: sha(bytes), bytes: bytes.length }, { root: owned, mode });
}

// Enumerate only the file fields consumed by the unchanged collector. Other
// proof metadata remains byte-preserved origin provenance; it is never followed.
function projection(material, proof, directory) {
  keys(proof, proofKeys, 'proof'); assert.equal(proof.schema_version, 1, 'Unknown material proof schema');
  assert.equal(proof.status, 'passed'); assert.equal(proof.parity?.status, 'valid');
  assert.ok(Array.isArray(proof.canonical_to_actual) && proof.canonical_to_actual.length > 0);
  assert.ok(Array.isArray(proof.files) && proof.files.length > 0);
  absolute(proof.native_root); absolute(proof.native_skill_root);
  assert.ok(inside(proof.native_root, proof.native_skill_root));
  assert.equal(material.skills_root, proof.native_skill_root, 'Material native root differs from its proof');
  assert.ok(!inside(material.skills_root, directory), 'Material destination would modify the native source tree');
  const files = [], locations = [], byPath = new Map(), identities = new Set();
  const add = (ref, location, { sdk = false, mode = null } = {}) => {
    descriptor(ref, { sdk });
    assert.ok(!inside(directory, ref.path), 'Material destination must not contain an original source');
    const previous = byPath.get(ref.path);
    if (previous) {
      assert.equal(previous.sha256, ref.sha256, 'Conflicting material descriptor SHA256');
      if (previous.bytes !== undefined && ref.bytes !== undefined) assert.equal(previous.bytes, ref.bytes, 'Conflicting material descriptor size');
      if (previous.mode !== null && mode !== null) assert.equal(previous.mode, mode, 'Conflicting material descriptor mode');
      if (previous.bytes === undefined && ref.bytes !== undefined) previous.bytes = ref.bytes;
      if (previous.mode === null && mode !== null) previous.mode = mode;
    } else { const item = { ...ref, mode }; files.push(item); byPath.set(ref.path, item); }
    if (location) locations.push({ location, origin_path: ref.path });
  };
  add(material.materialization_proof, null);
  for (const [index, item] of proof.canonical_to_actual.entries()) {
    keys(item, itemKeys, 'parity item');
    assert.ok(typeof item.skill_id === 'string' && item.skill_id && typeof item.path === 'string' && item.path);
    const identity = canonicalJson([item.skill_id, item.path]); assert.ok(!identities.has(identity), 'Duplicate material parity identity'); identities.add(identity);
    for (const name of sourceKeys) add(item[name], '/canonical_to_actual/' + index + '/' + name + '/path');
    for (const name of ['canonical', 'prepared', 'actual']) assert.equal(item[name + '_source'].sha256, item[name + '_sha256']);
    assert.equal(item.matched, true); assert.equal(item.comparison?.matched, true);
    if (item.method === 'exact-bytes') assert.equal(item.actual_sha256, item.canonical_sha256);
    else {
      assert.equal(item.method, 'public-sdk-native-structural-equivalence', 'Unknown material parity method');
      assert.equal(item.frontmatter_matches_prepared, true); assert.equal(item.actual_header_sha256, item.prepared_header_sha256);
      assert.ok(hashPattern.test(item.actual_header_sha256 ?? ''), 'Material header needs SHA256');
      assert.ok(['exact', 'normalized'].includes(item.canonical_body_comparison) && ['exact', 'normalized'].includes(item.prepared_body_comparison));
      add({ path: item.public_sdk_path, sha256: item.public_sdk_sha256 }, '/canonical_to_actual/' + index + '/public_sdk_path', { sdk: true });
    }
  }
  const nativeIdentities = new Set();
  for (const [index, file] of proof.files.entries()) {
    keys(file, fileKeys, 'native file');
    const identity = canonicalJson([file.skill_id, file.resource_path]);
    assert.ok(identities.has(identity) && !nativeIdentities.has(identity), 'Unknown or duplicate native material identity'); nativeIdentities.add(identity);
    assert.ok(['100644', '100755'].includes(file.mode), 'Unknown native material mode');
    assert.ok(inside(material.skills_root, absolute(file.path)) && file.path !== material.skills_root, 'Native material escapes its declared tree');
    assert.equal(relative(proof.native_root, file.path).split(sep).join('/'), file.relative_path, 'Native material relative path changed');
    add({ path: file.path, sha256: file.sha256, bytes: file.bytes }, '/files/' + index + '/path', { mode: file.mode });
  }
  assert.equal(nativeIdentities.size, identities.size, 'Material native inventory is incomplete');
  assert.deepEqual(material.skill_inventory, proof.files, 'Material skill inventory differs from its proof');
  let commonRoot = dirname(files[0].path);
  for (const path of [...files.map(file => file.path), proof.native_root, proof.native_skill_root]) while (!inside(commonRoot, path)) {
    const parent = dirname(commonRoot); assert.notEqual(parent, commonRoot, 'Material sources need a common filesystem path root'); commonRoot = parent;
  }
  const mapped = path => {
    assert.ok(inside(commonRoot, path));
    const destination = join(directory, 'sources', relative(commonRoot, path));
    assert.ok(inside(directory, destination) && destination !== directory); return destination;
  };
  const projectedProof = structuredClone(proof), pathMappings = [];
  for (const { location, origin_path } of locations) {
    const parts = location.slice(1).split('/'); let target = projectedProof;
    for (const key of parts.slice(0, -1)) target = target[key];
    target[parts.at(-1)] = mapped(origin_path);
    pathMappings.push({ document: 'proof', pointer: location, origin_path, owned_path: mapped(origin_path) });
  }
  for (const key of ['native_root', 'native_skill_root']) {
    projectedProof[key] = mapped(proof[key]);
    pathMappings.push({ document: 'proof', pointer: '/' + key, origin_path: proof[key], owned_path: projectedProof[key] });
  }
  const proofBytes = encode(projectedProof), projectedProofRef = { path: join(directory, 'materialization-proof.projected.json'), sha256: sha(proofBytes), bytes: proofBytes.length };
  const projectedMaterial = { materialization_proof: projectedProofRef, skills_root: mapped(material.skills_root),
    skill_inventory: material.skill_inventory.map(file => ({ ...file, path: mapped(file.path) })) };
  pathMappings.push({ document: 'material-binding', pointer: '/materialization_proof/path', origin_path: material.materialization_proof.path, owned_path: projectedProofRef.path });
  pathMappings.push({ document: 'material-binding', pointer: '/skills_root', origin_path: material.skills_root, owned_path: projectedMaterial.skills_root });
  for (const [index, file] of material.skill_inventory.entries()) pathMappings.push({ document: 'material-binding', pointer: '/skill_inventory/' + index + '/path', origin_path: file.path, owned_path: mapped(file.path) });
  const nativeRelativePaths = material.skill_inventory.map(file => {
    const original = relative(material.skills_root, file.path), projected = relative(projectedMaterial.skills_root, mapped(file.path));
    assert.equal(projected, original, 'Material projection changed native read mapping');
    return { skill_id: file.skill_id, resource_path: file.resource_path, relative_path: original.split(sep).join('/'), unchanged: true };
  });
  return { files, commonRoot, mapped, projectedMaterial, proofBytes, pathMappings, nativeRelativePaths };
}
function manifestFor(material, plan, inventory, directory, environmentRoot) {
  return { schema_version: 1, kind: 'benchmark-material-ownership-projection', directory, environment_root: environmentRoot,
    material_sha256: fingerprint(material), original_material: material,
    source_policy: 'ordinary canonical files; no source or destination symlinks; original bytes and executable modes retained',
    projection_scope: 'collector material descriptor paths only; other proof metadata remains origin provenance',
    source_common_root: plan.commonRoot,
    original_proof: { ...material.materialization_proof, path: plan.mapped(material.materialization_proof.path) },
    projected_material: plan.projectedMaterial, path_mappings: plan.pathMappings,
    native_relative_paths: plan.nativeRelativePaths, files: inventory };
}
function inventoryRow(file, data, plan) {
  return { origin_path: file.path, origin_realpath: file.path, owned_path: plan.mapped(file.path), sha256: file.sha256, bytes: data.bytes.length, mode: data.mode };
}

/** Import one shared material binding. Case inputs, oracle, protocol identity and
 * all other binding fields are returned unchanged. The directory is keyed by
 * fingerprint({materialization_proof, skills_root, skill_inventory}) by callers,
 * so cases sharing material also share the native path and capture grouping.
 * This projection is for collection; a retained subject run keeps its original
 * frozen binding. No original file, ledger or plan is changed. */
export async function prepareMaterialOwnership({ binding, directory, environmentRoot }) {
  const material = materialFields(binding), owned = await ownedRoot(environmentRoot);
  await directoryWithin(owned, directory, false);
  const path = join(directory, manifestName);
  let retained = null;
  try {
    const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink(), 'Material manifest must be an ordinary file');
    assert.equal(await realpath(path), path, 'Material manifest ancestors changed');
    retained = await readFile(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (retained) return verifyMaterialOwnership({ binding, reference: { path, sha256: sha(retained), bytes: retained.length }, environmentRoot });
  const originalProof = await readVerified(material.materialization_proof);
  const plan = projection(material, JSON.parse(originalProof.bytes), directory), sources = [];
  for (const file of plan.files) sources.push({ file, data: await readVerified(file, { mode: file.mode }) });
  // Validate the whole closure before creating any destination files.
  for (const { file, data } of sources) await writeOnce(owned, plan.mapped(file.path), data.bytes, data.mode);
  await writeOnce(owned, plan.projectedMaterial.materialization_proof.path, plan.proofBytes);
  const manifest = manifestFor(material, plan, sources.map(({ file, data }) => inventoryRow(file, data, plan)), directory, owned);
  const bytes = encode(manifest); await writeOnce(owned, path, bytes);
  return verifyMaterialOwnership({ binding, reference: { path, sha256: sha(bytes), bytes: bytes.length }, environmentRoot });
}

/** Verify only owned snapshots: source paths are provenance and may no longer
 * exist. Reconstruct the allowed projection from the retained ORIGINAL proof,
 * rather than trusting a manifest's proposed mappings or derived proof. */
export async function verifyMaterialOwnership({ binding, reference, environmentRoot }) {
  const material = materialFields(binding), owned = await ownedRoot(environmentRoot);
  descriptor(reference); const directory = dirname(reference.path);
  assert.equal(reference.path, join(directory, manifestName), 'Unexpected material ownership manifest name');
  await directoryWithin(owned, directory, false);
  const { bytes } = await readVerified(reference, { root: directory, mode: '100644' }), manifest = JSON.parse(bytes);
  assert.equal(manifest.schema_version, 1, 'Unknown material ownership manifest schema');
  assert.equal(manifest.kind, 'benchmark-material-ownership-projection');
  assert.equal(manifest.material_sha256, fingerprint(material), 'Material ownership binding changed');
  assert.deepEqual(manifest.original_material, material);
  descriptor(manifest.original_proof);
  assert.equal(manifest.original_proof.sha256, material.materialization_proof.sha256);
  assert.equal(manifest.original_proof.bytes, material.materialization_proof.bytes);
  const originalProof = await readVerified(manifest.original_proof, { root: directory });
  const plan = projection(material, JSON.parse(originalProof.bytes), directory), inventory = [];
  for (const file of plan.files) {
    const data = await readVerified({ ...file, path: plan.mapped(file.path) }, { root: directory, mode: file.mode });
    inventory.push(inventoryRow(file, data, plan));
  }
  const derived = await readVerified(plan.projectedMaterial.materialization_proof, { root: directory, mode: '100644' });
  assert.ok(derived.bytes.equals(plan.proofBytes), 'Derived material proof differs from the allowed path projection');
  const expected = manifestFor(material, plan, inventory, directory, owned);
  assert.deepEqual(manifest, expected, 'Material ownership manifest differs from the complete reconstructed projection');
  assert.ok(bytes.equals(encode(expected)), 'Material ownership manifest must use its canonical encoding');
  return { binding: { ...structuredClone(binding), ...plan.projectedMaterial }, reference: structuredClone(reference), manifest };
}
