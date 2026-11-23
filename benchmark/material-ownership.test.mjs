import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { canonicalJson, fingerprint } from './protocol.mjs';
import { prepareMaterialOwnership, verifyMaterialOwnership } from './material-ownership.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(canonicalJson(value) + '\n');
async function save(path, value, executable = false) {
  const bytes = Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value) : encode(value);
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { flag: 'wx', mode: executable ? 0o700 : 0o600 });
  return { path, sha256: sha(bytes), bytes: bytes.length };
}
async function fixture({ structural = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-material-ownership-')));
  const source = join(root, 'source'), environmentRoot = join(root, 'owned'); await mkdir(environmentRoot);
  const nativeRoot = join(source, 'native'), skills = join(nativeRoot, '.agents', 'skills');
  const body = '# Unit skill\nUse the supplied input.\n';
  const canonical = await save(join(source, 'canonical', 'SKILL.md'), body);
  const prepared = await save(join(source, 'prepared', 'SKILL.md'), body);
  const actual = await save(join(source, 'readback', 'SKILL.md'), body);
  const receipt = await save(join(source, 'receipt.json'), { status: 'passed', source: actual.path });
  const raw = await save(join(source, 'raw-receipt.json'), { observed: true, source: actual.path });
  const native = { ...await save(join(skills, 'unit-name', 'SKILL.md'), body, true), relative_path: '.agents/skills/unit-name/SKILL.md', skill_id: 'unit', resource_path: 'SKILL.md', mode: '100755' };
  const item = { skill_id: 'unit', path: 'SKILL.md', canonical_sha256: canonical.sha256, prepared_sha256: prepared.sha256, actual_sha256: actual.sha256,
    canonical_source: canonical, prepared_source: prepared, actual_source: actual, receipt, raw_receipt: raw, matched: true, comparison: { matched: true }, method: 'exact-bytes' };
  if (structural) {
    const sdk = await save(join(source, 'build', 'sdk.js'), 'export const version = 2;\n');
    Object.assign(item, { method: 'public-sdk-native-structural-equivalence', public_sdk_path: sdk.path, public_sdk_sha256: sdk.sha256,
      frontmatter_matches_prepared: true, actual_header_sha256: sha('header'), prepared_header_sha256: sha('header'), canonical_body_comparison: 'exact', prepared_body_comparison: 'normalized' });
  }
  const proof = { schema_version: 1, status: 'passed', parity: { status: 'valid' }, visibility: { status: 'valid' },
    canonical_to_actual: [item], files: [native], native_root: nativeRoot, native_skill_root: skills, identity_map: {} };
  const proofRef = await save(join(source, 'proof.json'), proof);
  const binding = { id: 'case-one', materialization_proof: proofRef, skills_root: skills, skill_inventory: [native],
    public_case: { title: 'Unit case' }, oracle_path: '/private/oracle.json', protocol_case: { content_sha256: sha('frozen-content') }, events: [] };
  return { root, source, environmentRoot, directory: join(environmentRoot, 'projection'), proof, binding };
}
const prepare = f => prepareMaterialOwnership({ binding: f.binding, directory: f.directory, environmentRoot: f.environmentRoot });
async function replaceProof(f, mutate) {
  mutate(f.proof); const bytes = encode(f.proof); await writeFile(f.binding.materialization_proof.path, bytes);
  f.binding.materialization_proof.sha256 = sha(bytes); f.binding.materialization_proof.bytes = bytes.length;
}

test('owned projection preserves original bytes, SDK closure, executable modes and native relative mapping', async () => {
  const f = await fixture({ structural: true }), before = structuredClone(f.binding), result = await prepare(f);
  assert.deepEqual(f.binding, before); assert.deepEqual(result.binding.public_case, before.public_case);
  assert.deepEqual(result.binding.protocol_case, before.protocol_case); assert.equal(result.binding.oracle_path, before.oracle_path);
  assert.equal(result.manifest.files.length, 8);
  assert.ok((await readFile(result.manifest.original_proof.path)).equals(await readFile(before.materialization_proof.path)));
  assert.notEqual(result.binding.materialization_proof.sha256, before.materialization_proof.sha256);
  const derived = JSON.parse(await readFile(result.binding.materialization_proof.path));
  assert.equal(derived.canonical_to_actual[0].actual_sha256, f.proof.canonical_to_actual[0].actual_sha256);
  assert.equal(relative(before.skills_root, before.skill_inventory[0].path), relative(result.binding.skills_root, result.binding.skill_inventory[0].path));
  for (const file of result.manifest.files) {
    assert.ok((await readFile(file.origin_path)).equals(await readFile(file.owned_path)));
    assert.notEqual((await lstat(file.origin_path)).ino, (await lstat(file.owned_path)).ino);
    assert.equal(Boolean((await lstat(file.owned_path)).mode & 0o111), file.mode === '100755');
  }
  assert.equal(result.manifest.native_relative_paths[0].unchanged, true);
  assert.deepEqual(await verifyMaterialOwnership({ binding: before, reference: result.reference, environmentRoot: f.environmentRoot }), result);
});

test('same material is shared across cases and verifies after all original sources are moved away', async () => {
  const f = await fixture(), first = await prepare(f);
  const next = { ...f.binding, id: 'case-two', public_case: { title: 'Another case' }, oracle_path: '/another/oracle.json' };
  await rename(f.source, f.source + '-retired');
  const second = await prepareMaterialOwnership({ binding: next, directory: f.directory, environmentRoot: f.environmentRoot });
  assert.deepEqual(second.reference, first.reference); assert.equal(second.binding.skills_root, first.binding.skills_root);
  assert.equal(second.binding.id, 'case-two'); assert.equal(second.binding.oracle_path, '/another/oracle.json');
  assert.deepEqual(second.manifest, first.manifest); assert.ok(!Object.hasOwn(second.manifest, 'case_id'));
});

test('changed source SHA is rejected before creating the destination', async () => {
  const f = await fixture(); await writeFile(f.proof.canonical_to_actual[0].actual_source.path, 'changed');
  await assert.rejects(prepare(f), /SHA256 changed/); await assert.rejects(lstat(f.directory), { code: 'ENOENT' });
});

test('native source executable mode is frozen', async () => {
  const f = await fixture(); await chmod(f.binding.skill_inventory[0].path, 0o600);
  await assert.rejects(prepare(f), /executable mode changed/); await assert.rejects(lstat(f.directory), { code: 'ENOENT' });
});

test('source file and ancestor symlinks are rejected even when bytes match', async () => {
  for (const ancestor of [false, true]) {
    const f = await fixture(), path = ancestor ? dirname(f.proof.canonical_to_actual[0].actual_source.path) : f.proof.canonical_to_actual[0].actual_source.path;
    await rename(path, path + '-real'); await symlink(path + '-real', path);
    await assert.rejects(prepare(f), /symlink/); await assert.rejects(lstat(f.directory), { code: 'ENOENT' });
  }
});

test('destination symlink ancestors cannot write outside ownership', async () => {
  const f = await fixture(), outside = join(f.root, 'outside'); await mkdir(outside); await symlink(outside, f.directory);
  await assert.rejects(prepare(f), /ordinary directory/); await assert.rejects(lstat(join(outside, 'sources')), { code: 'ENOENT' });
});

test('tampered owned source content or mode fails verification', async () => {
  for (const modeOnly of [false, true]) {
    const f = await fixture(), result = await prepare(f), leaf = result.binding.skill_inventory[0].path;
    if (modeOnly) await chmod(leaf, 0o600); else await writeFile(leaf, 'tampered');
    await assert.rejects(verifyMaterialOwnership({ binding: f.binding, reference: result.reference, environmentRoot: f.environmentRoot }), /changed/);
  }
});

test('an existing manifest with a missing snapshot is rejected, not silently reimported', async () => {
  const f = await fixture(), result = await prepare(f), path = result.binding.skill_inventory[0].path;
  await rename(path, path + '-retired');
  await assert.rejects(prepare(f), { code: 'ENOENT' });
  await assert.rejects(lstat(path), { code: 'ENOENT' });
});

test('derived proof cannot change facts even with a newly hashed manifest', async () => {
  const f = await fixture(), result = await prepare(f), projected = JSON.parse(await readFile(result.binding.materialization_proof.path));
  projected.canonical_to_actual[0].matched = false; const derived = encode(projected); await writeFile(result.binding.materialization_proof.path, derived);
  result.manifest.projected_material.materialization_proof.sha256 = sha(derived); result.manifest.projected_material.materialization_proof.bytes = derived.length;
  const manifestBytes = encode(result.manifest); await writeFile(result.reference.path, manifestBytes);
  await assert.rejects(verifyMaterialOwnership({ binding: f.binding, reference: { ...result.reference, sha256: sha(manifestBytes), bytes: manifestBytes.length }, environmentRoot: f.environmentRoot }), /SHA256 changed/);
});

test('unknown proof schema and descriptor fields fail closed', async () => {
  for (const mutation of [p => { p.schema_version = 2; }, p => { p.canonical_to_actual[0].actual_source.extra = true; }, p => { p.unrecognized_descriptor = { path: '/outside' }; }]) {
    const f = await fixture(); await replaceProof(f, mutation);
    await assert.rejects(prepare(f), /Unknown/); await assert.rejects(lstat(f.directory), { code: 'ENOENT' });
  }
});

test('an existing material directory cannot be rebound to another frozen material', async () => {
  const f = await fixture(), first = await prepare(f), binding = structuredClone(f.binding); binding.skills_root += '-changed';
  await assert.rejects(prepareMaterialOwnership({ binding, directory: f.directory, environmentRoot: f.environmentRoot }), /binding changed/);
  assert.equal(sha(await readFile(first.reference.path)), first.reference.sha256);
});

test('a missing typed leaf and a conflicting descriptor are rejected without partial output', async () => {
  for (const conflict of [false, true]) {
    const f = await fixture();
    if (conflict) await replaceProof(f, p => { p.canonical_to_actual[0].receipt.path = p.canonical_to_actual[0].actual_source.path; });
    else await rename(f.proof.canonical_to_actual[0].raw_receipt.path, f.proof.canonical_to_actual[0].raw_receipt.path + '-retired');
    await assert.rejects(prepare(f), conflict ? /Conflicting/ : { code: 'ENOENT' });
    await assert.rejects(lstat(f.directory), { code: 'ENOENT' });
  }
});

test('native source names and protocol fingerprints stay unchanged through projection', async () => {
  const f = await fixture(), before = fingerprint(f.binding.protocol_case), result = await prepare(f);
  const originalRead = join('/retained/run/skills', relative(f.binding.skills_root, f.binding.skill_inventory[0].path));
  const projectedRead = join('/retained/run/skills', relative(result.binding.skills_root, result.binding.skill_inventory[0].path));
  assert.equal(originalRead, projectedRead); assert.equal(fingerprint(result.binding.protocol_case), before);
});
