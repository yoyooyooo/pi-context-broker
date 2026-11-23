import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEnvironment } from '../scripts/paired-environment.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const SOURCE_PATH = 'broker/benchmark/reported-model.mjs';
const CHECKER_FILES = ['paired-environment.mjs', 'paired-closeout.mjs', 'paired-runtime-identity.mjs'];
const id = value => { assert.match(value, /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u); return value; };
const digest = value => assert.match(value, /^[a-f0-9]{64}$/u);
const own = (root, path) => path.startsWith(root + '/');
const json = async path => JSON.parse(await readFile(path, 'utf8'));

async function artifact(path) {
  assert.ok(isAbsolute(path) && resolve(path) === path);
  assert.equal(await realpath(path), path, 'Apparatus bridge evidence cannot traverse a symlink');
  const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024 * 1024);
  const bytes = await readFile(path); return { path, sha256: sha(bytes), bytes: bytes.length };
}
async function checked(reference) {
  assert.ok(reference && typeof reference.path === 'string'); digest(reference.sha256);
  const actual = await artifact(reference.path); assert.equal(actual.sha256, reference.sha256, 'Apparatus bridge evidence changed');
  if (reference.bytes !== undefined) assert.equal(actual.bytes, reference.bytes);
  return actual;
}
function inventory(value) {
  assert.ok(value && Array.isArray(value.files) && value.files.length > 0); digest(value.sha256);
  assert.equal(sha(JSON.stringify(value.files)), value.sha256, 'Apparatus bridge inventory fingerprint differs');
  assert.equal(new Set(value.files.map(file => file.path)).size, value.files.length, 'Duplicate apparatus bridge inventory path');
  return new Map(value.files.map(file => [file.path, file]));
}
function changes(sourceChanges) {
  assert.ok(Array.isArray(sourceChanges) && sourceChanges.length === 1, 'This bridge permits only the reviewed reported-model instrumentation change');
  const change = sourceChanges[0];
  assert.deepEqual(Object.keys(change).sort(), ['after_sha256', 'before_sha256', 'path']);
  assert.equal(change.path, SOURCE_PATH, 'Product source is outside the apparatus bridge');
  digest(change.before_sha256); digest(change.after_sha256); assert.notEqual(change.before_sha256, change.after_sha256);
  return structuredClone(sourceChanges);
}
function buildIdentity(build, reference) {
  const sdk = build.packages.cli.files.filter(file => file.path === 'dist/sdk.js');
  assert.equal(sdk.length, 1); digest(sdk[0].sha256);
  return { id: build.build_id, receipt_sha256: reference.sha256,
    cli: { commit: build.sources.cli.commit, source_sha256: build.sources.cli.sha256,
      package_sha256: build.packages.cli.sha256, sdk_sha256: sdk[0].sha256 },
    broker: { commit: build.sources.broker.commit, source_sha256: build.sources.broker.sha256,
      package_sha256: build.packages.broker.sha256 } };
}
async function readBuild(environmentRoot, buildId) {
  const root = join(environmentRoot, 'builds', id(buildId)), reference = await artifact(join(root, 'build.json'));
  const build = await json(reference.path);
  assert.equal(build.version, 1); assert.equal(build.kind, 'paired-build'); assert.equal(build.root, root); assert.equal(build.build_id, buildId);
  try { await lstat(join(root, 'failure.json')); assert.fail('A failed build cannot provide an apparatus bridge'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const role of ['cli', 'broker']) inventory(build.packages[role]);
  const tree = inventory(build.source_tree);
  for (const role of ['cli', 'broker']) {
    const source = build.sources[role]; assert.match(source.commit, /^[a-f0-9]{40}$/u); inventory(source);
    for (const file of source.files) assert.equal(tree.get(role + '/' + file.path)?.sha256, file.sha256, 'Recorded source input is not in the actual frozen tree');
  }
  digest(build.selected_cli_sha256);
  return { build, tree, reference, identity: buildIdentity(build, reference) };
}
async function checkerIdentity() {
  return Promise.all(CHECKER_FILES.map(async name => ({ name, ...await artifact(fileURLToPath(new URL('../scripts/' + name, import.meta.url))) })));
}
function stableCheck(result) {
  const { current_source_heads: _current, ...stable } = result;
  return stable;
}

/** Read actual immutable products and run the existing public checker. Writes no artifact. */
export async function createApparatusBridge({ environmentRoot, sourceBuildId, targetBuildId, sourceChanges } = {}) {
  assert.ok(isAbsolute(environmentRoot) && resolve(environmentRoot) === environmentRoot);
  assert.equal(await realpath(environmentRoot), environmentRoot); assert.notEqual(sourceBuildId, targetBuildId);
  const declared = changes(sourceChanges);
  const source = await readBuild(environmentRoot, sourceBuildId), target = await readBuild(environmentRoot, targetBuildId);
  assert.equal(source.build.environment_id, target.build.environment_id);
  // This is an exact installed-product check. There are no metadata, README,
  // dependency, lock transport, SDK, or build-provenance exemptions.
  for (const role of ['cli', 'broker']) assert.deepEqual(target.build.packages[role], source.build.packages[role], 'Product package inventory differs: ' + role);
  assert.equal(target.build.selected_cli_sha256, source.build.selected_cli_sha256, 'Selected CLI/SDK pair differs');
  assert.equal(target.build.sources.cli.commit, source.build.sources.cli.commit, 'The gate CLI source revision must stay fixed');
  const paths = [...new Set([...source.tree.keys(), ...target.tree.keys()])].sort();
  const differences = paths.filter(path => JSON.stringify(source.tree.get(path)) !== JSON.stringify(target.tree.get(path)));
  assert.deepEqual(differences, declared.map(change => change.path), 'Undeclared source or build-dependency change');
  for (const change of declared) {
    const before = source.tree.get(change.path), after = target.tree.get(change.path);
    assert.ok(before && after && before.sha256 && after.sha256, 'Instrumentation must remain an ordinary existing file');
    assert.equal(before.sha256, change.before_sha256); assert.equal(after.sha256, change.after_sha256);
    assert.deepEqual({ ...before, sha256: after.sha256 }, after, 'Instrumentation mode or path changed');
  }
  for (const role of ['cli', 'broker']) {
    const before = source.build.sources[role].files, after = target.build.sources[role].files;
    const expected = before.map(file => role + '/' + file.path === SOURCE_PATH ? { ...file, sha256: declared[0].after_sha256 } : file);
    assert.deepEqual(after, expected, 'Source input manifest has an undeclared change');
  }
  const checkerFiles = await checkerIdentity();
  const sourceCheck = await checkEnvironment({ root: environmentRoot, build: sourceBuildId });
  const targetCheck = await checkEnvironment({ root: environmentRoot, build: targetBuildId });
  for (const result of [sourceCheck, targetCheck]) assert.equal(result.status, 'passed');
  await checked(source.reference); await checked(target.reference);
  return { version: 1, kind: 'benchmark-apparatus-bridge', created_at: new Date().toISOString(), environment_root: environmentRoot,
    source_build: { id: sourceBuildId, reference: source.reference, identity: source.identity },
    target_build: { id: targetBuildId, reference: target.reference, identity: target.identity }, source_changes: declared,
    checker: { implementation: checkerFiles[0], dependencies: checkerFiles.slice(1),
      receipts: { source: sourceCheck, target: targetCheck } } };
}

/** A revision may name this precise bridge; it never licenses a generic build difference. */
export async function verifyApparatusBridge(reference, { environmentRoot, sourceBuildId, targetBuildId } = {}) {
  const actual = await checked(reference); assert.ok(own(environmentRoot, actual.path), 'Keep the bridge in its owned environment');
  const value = await json(actual.path);
  assert.deepEqual(Object.keys(value).sort(), ['checker', 'created_at', 'environment_root', 'kind', 'source_build', 'source_changes', 'target_build', 'version']);
  assert.equal(value.version, 1); assert.equal(value.kind, 'benchmark-apparatus-bridge'); assert.equal(value.environment_root, environmentRoot);
  assert.equal(value.source_build.id, sourceBuildId); assert.equal(value.target_build.id, targetBuildId);
  await checked(value.source_build.reference); await checked(value.target_build.reference);
  const fresh = await createApparatusBridge({ environmentRoot, sourceBuildId, targetBuildId, sourceChanges: value.source_changes });
  assert.deepEqual(value.source_build, fresh.source_build); assert.deepEqual(value.target_build, fresh.target_build);
  const oldFiles = [value.checker.implementation, ...value.checker.dependencies], newFiles = [fresh.checker.implementation, ...fresh.checker.dependencies];
  assert.deepEqual(oldFiles.map(file => file.name), newFiles.map(file => file.name));
  for (const [index, file] of oldFiles.entries()) { await checked(file); assert.equal(file.sha256, newFiles[index].sha256, 'Apparatus bridge checker changed'); }
  for (const role of ['source', 'target']) assert.deepEqual(stableCheck(value.checker.receipts[role]), stableCheck(fresh.checker.receipts[role]), 'Actual public checker proof differs');
  return { status: 'passed', bridge: actual, source_build: fresh.source_build, target_build: fresh.target_build,
    source_changes: fresh.source_changes, checker: fresh.checker, model_calls: 0 };
}
