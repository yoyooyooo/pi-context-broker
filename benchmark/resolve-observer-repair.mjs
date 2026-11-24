import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { checkEnvironment } from '../scripts/paired-environment.mjs';
import { fingerprint } from './protocol.mjs';
import { instrumentationIdentity } from './implementation.mjs';

export const RESOLVE_OBSERVER_FILES = Object.freeze([
  'benchmark/runtime/episode-notion.mjs',
  'scripts/notion-skill-graph-model-evidence.mjs',
  'scripts/skill-consumption-source-observer.mjs',
]);
const beforeOperations = "['list', 'files', 'consume', 'read', 'read-resources']";
const afterOperations = "['list', 'files', 'consume', 'read', 'read-resources', 'resolve']";
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clean = ref => ({ path: ref.path, sha256: ref.sha256 });
const id = value => { assert.match(value, /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/); return value; };
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'RESOLVE_REPAIR_SHAPE');
async function file(path) {
  assert.ok(isAbsolute(path) && resolve(path) === path); assert.equal(await realpath(path), path);
  const first = await lstat(path); assert.ok(first.isFile() && !first.isSymbolicLink());
  const bytes = await readFile(path), last = await lstat(path);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(first[key], last[key], 'RESOLVE_REPAIR_READ_CHANGED');
  return { bytes, reference: { path, sha256: sha(bytes), bytes: bytes.length } };
}
async function checked(reference) {
  const actual = await file(reference.path); assert.deepEqual(clean(actual.reference), clean(reference), 'RESOLVE_REPAIR_REFERENCE_CHANGED');
  if (reference.bytes !== undefined) assert.equal(actual.bytes.length, reference.bytes);
  return actual;
}
function inventory(value) {
  assert.ok(Array.isArray(value.files) && value.files.length); assert.equal(sha(JSON.stringify(value.files)), value.sha256);
  assert.equal(new Set(value.files.map(item => item.path)).size, value.files.length);
  return new Map(value.files.map(item => [item.path, item]));
}
function identity(build, reference) {
  const sdk = build.packages.cli.files.filter(item => item.path === 'dist/sdk.js'); assert.equal(sdk.length, 1);
  return { id: build.build_id, receipt_sha256: reference.sha256,
    cli: { commit: build.sources.cli.commit, source_sha256: build.sources.cli.sha256,
      package_sha256: build.packages.cli.sha256, sdk_sha256: sdk[0].sha256 },
    broker: { commit: build.sources.broker.commit, source_sha256: build.sources.broker.sha256,
      package_sha256: build.packages.broker.sha256 } };
}
async function build(root, buildId) {
  const path = join(root, 'builds', id(buildId)), artifact = await file(join(path, 'build.json'));
  const value = JSON.parse(artifact.bytes);
  assert.equal(value.version, 1); assert.equal(value.kind, 'paired-build'); assert.equal(value.root, path); assert.equal(value.build_id, buildId);
  for (const role of ['cli', 'broker']) { inventory(value.sources[role]); inventory(value.packages[role]); }
  const tree = inventory(value.source_tree);
  for (const role of ['cli', 'broker']) for (const item of value.sources[role].files)
    assert.equal(tree.get(role + '/' + item.path)?.sha256, item.sha256, 'RESOLVE_REPAIR_SOURCE_NOT_IN_BUILD');
  return { root: path, value, tree, reference: artifact.reference, identity: identity(value, artifact.reference) };
}

/** Exactly the supported operation is added; this is not an arbitrary source allowlist. */
export function assertResolveObserverSource(before, after) {
  assert.equal(before.split(beforeOperations).length, 2, 'RESOLVE_REPAIR_EXPECTED_SOURCE_REQUIRED');
  assert.equal(after, before.replace(beforeOperations, afterOperations), 'RESOLVE_REPAIR_UNDECLARED_SOURCE_CHANGE');
}

async function buildPair(environmentRoot, sourceBuildId, targetBuildId) {
  assert.notEqual(sourceBuildId, targetBuildId, 'RESOLVE_REPAIR_NEW_BUILD_REQUIRED');
  const source = await build(environmentRoot, sourceBuildId), target = await build(environmentRoot, targetBuildId);
  assert.equal(source.value.environment_id, target.value.environment_id);
  for (const role of ['cli', 'broker']) assert.deepEqual(target.value.packages[role], source.value.packages[role], 'RESOLVE_REPAIR_PRODUCT_CHANGED');
  assert.equal(target.value.selected_cli_sha256, source.value.selected_cli_sha256, 'RESOLVE_REPAIR_CLI_PAIR_CHANGED');
  assert.deepEqual(target.value.tools, source.value.tools, 'RESOLVE_REPAIR_TOOLCHAIN_CHANGED');
  assert.equal(target.value.sources.cli.commit, source.value.sources.cli.commit, 'RESOLVE_REPAIR_CLI_SOURCE_CHANGED');
  const paths = [...new Set([...source.tree.keys(), ...target.tree.keys()])].sort();
  const differences = paths.filter(path => JSON.stringify(source.tree.get(path)) !== JSON.stringify(target.tree.get(path)));
  assert.deepEqual(differences, RESOLVE_OBSERVER_FILES.map(path => 'broker/' + path).sort(), 'RESOLVE_REPAIR_UNDECLARED_BUILD_CHANGE');
  const changes = [];
  for (const path of RESOLVE_OBSERVER_FILES) {
    const before = await file(join(source.root, 'source/broker', path)), after = await file(join(target.root, 'source/broker', path));
    const a = source.tree.get('broker/' + path), b = target.tree.get('broker/' + path);
    assert.equal(a.sha256, before.reference.sha256); assert.equal(b.sha256, after.reference.sha256);
    assert.deepEqual({ ...a, sha256: b.sha256 }, b, 'RESOLVE_REPAIR_MODE_OR_PATH_CHANGED');
    assertResolveObserverSource(before.bytes.toString('utf8'), after.bytes.toString('utf8'));
    changes.push({ path, before: before.reference, after: after.reference });
  }
  for (const role of ['cli', 'broker']) {
    const expected = source.value.sources[role].files.map(item => {
      const change = role === 'broker' && changes.find(change => change.path === item.path);
      return change ? { ...item, sha256: change.after.sha256 } : item;
    });
    assert.deepEqual(target.value.sources[role].files, expected, 'RESOLVE_REPAIR_SOURCE_INPUT_CHANGED');
  }
  return { source: { id: sourceBuildId, reference: source.reference, identity: source.identity },
    target: { id: targetBuildId, reference: target.reference, identity: target.identity }, changes };
}

/** Read-only proof over real immutable builds. Caller saves it under a new identity. */
export async function createResolveObserverRepair({ environmentRoot, builds }) {
  assert.ok(isAbsolute(environmentRoot) && resolve(environmentRoot) === environmentRoot); assert.equal(await realpath(environmentRoot), environmentRoot);
  assert.ok(Array.isArray(builds) && builds.length > 0);
  assert.equal(new Set(builds.map(item => item.sourceBuildId)).size, builds.length, 'RESOLVE_REPAIR_DUPLICATE_SOURCE');
  assert.equal(new Set(builds.map(item => item.targetBuildId)).size, builds.length, 'RESOLVE_REPAIR_DUPLICATE_TARGET');
  const pairs = [];
  for (const pair of builds) {
    keys(pair, ['sourceBuildId', 'targetBuildId']);
    const value = await buildPair(environmentRoot, pair.sourceBuildId, pair.targetBuildId);
    for (const buildId of [pair.sourceBuildId, pair.targetBuildId])
      assert.equal((await checkEnvironment({ root: environmentRoot, build: buildId })).status, 'passed', 'RESOLVE_REPAIR_ACTUAL_BUILD_FAILED');
    pairs.push(value);
  }
  // Both conditions use the same observation repair, without changing either product.
  for (const pair of pairs.slice(1)) assert.deepEqual(pair.changes.map(item => [item.path, item.before.sha256, item.after.sha256]),
    pairs[0].changes.map(item => [item.path, item.before.sha256, item.after.sha256]), 'RESOLVE_REPAIR_ASYMMETRIC_OBSERVERS');
  return { version: 1, kind: 'benchmark-resolve-observer-repair', environment_root: environmentRoot,
    builds: pairs, validation: 'actual paired check for each source and target', model_requests: 0 };
}

/** Every use verifies the bound manifests and exact changed bytes. Normal launch also checks the complete build. */
export async function verifyResolveObserverRepair(reference, environmentRoot) {
  assert.ok(reference.path.startsWith(environmentRoot + '/control/'), 'RESOLVE_REPAIR_OUTSIDE_OWNER');
  const value = JSON.parse((await checked(reference)).bytes);
  keys(value, ['version', 'kind', 'environment_root', 'builds', 'validation', 'model_requests']);
  assert.equal(value.version, 1); assert.equal(value.kind, 'benchmark-resolve-observer-repair'); assert.equal(value.environment_root, environmentRoot);
  assert.equal(value.validation, 'actual paired check for each source and target'); assert.equal(value.model_requests, 0);
  assert.ok(value.builds.length > 0); assert.equal(new Set(value.builds.map(item => item.source.id)).size, value.builds.length);
  assert.equal(new Set(value.builds.map(item => item.target.id)).size, value.builds.length);
  for (const pair of value.builds) assert.deepEqual(await buildPair(environmentRoot, pair.source.id, pair.target.id), pair, 'RESOLVE_REPAIR_BUILD_CHANGED');
  for (const pair of value.builds.slice(1)) assert.deepEqual(pair.changes.map(item => [item.path, item.before.sha256, item.after.sha256]),
    value.builds[0].changes.map(item => [item.path, item.before.sha256, item.after.sha256]), 'RESOLVE_REPAIR_ASYMMETRIC_OBSERVERS');
  return value;
}

export function resolveRepairBuild(repair, sourceBuildId, targetBuildId) {
  const matches = repair.builds.filter(item => item.source.id === sourceBuildId && item.target.id === targetBuildId);
  assert.equal(matches.length, 1, 'RESOLVE_REPAIR_BUILD_PAIR_REQUIRED'); return matches[0];
}

/** Normalize only receipt and exact observation-module identities, then compare the entire captured contract. */
export function assertResolveRepairExpectation(current, original, pair) {
  const copy = structuredClone(current), before = original.projection, after = copy.projection;
  for (const [projection, build] of [[before, pair.source], [after, pair.target]]) {
    assert.equal(projection.build.path, '$BUILD/build.json'); assert.equal(projection.build.realpath, '$BUILD/build.json');
    assert.equal(projection.build.sha256, build.reference.sha256); assert.equal(projection.build.bytes, build.reference.bytes);
  }
  after.build = structuredClone(before.build);
  const oldProjection = before.visibility.projection, newProjection = after.visibility.projection;
  // Runtime inventory hashes these fields before normalizeCandidate sorts object
  // keys for persistence. Reconstruct that wire format without reordering files.
  const projectionHash = files => sha(JSON.stringify(files.map(item => {
    keys(item, ['path', 'sha256', 'bytes']);
    return { path: item.path, sha256: item.sha256, bytes: item.bytes };
  })));
  assert.equal(oldProjection.sha256, projectionHash(oldProjection.files), 'RESOLVE_REPAIR_CAPTURE_INVENTORY_CHANGED');
  assert.equal(newProjection.sha256, projectionHash(newProjection.files), 'RESOLVE_REPAIR_CAPTURE_INVENTORY_CHANGED');
  assert.deepEqual(newProjection.files, oldProjection.files.map(item => {
    const change = pair.changes.find(change => change.path === item.path);
    if (!change) return item;
    assert.equal(item.sha256, change.before.sha256); assert.equal(item.bytes, change.before.bytes);
    return { ...item, sha256: change.after.sha256, bytes: change.after.bytes };
  }), 'RESOLVE_REPAIR_CAPTURE_MODULE_CHANGED');
  assert.ok(pair.changes.every(change => oldProjection.files.some(item => item.path === change.path)), 'RESOLVE_REPAIR_CAPTURE_MODULE_MISSING');
  after.visibility.projection = structuredClone(oldProjection);
  assert.deepEqual(copy, original, 'RESOLVE_REPAIR_CAPTURE_CONTRACT_CHANGED');
}

export function assertResolveRepairInstrumentation(current, original, repair) {
  const changes = repair.builds[0].changes;
  const permittedDependencies = ['benchmark/campaign-selection.mjs', 'benchmark/protocol.mjs', 'benchmark/schemas/protocol.schema.json'];
  for (const value of [current, original]) {
    assert.equal(value.collector_sha256, fingerprint(value.collector_files));
    assert.ok(value.runtime_sha256.length > 0 && value.runtime_sha256.every(hash => /^[a-f0-9]{64}$/.test(hash)));
  }
  const normalize = (value, target) => ({ ...value, runtime_sha256: null, collector_sha256: null,
    collector_files: value.collector_files.filter(item => !permittedDependencies.includes(item.path)).map(item => {
      const change = changes.find(change => change.path === item.path); if (!change) return item;
      const ref = target ? change.after : change.before;
      assert.equal(item.sha256, ref.sha256); assert.equal(item.bytes, ref.bytes);
      return { ...item, sha256: null, bytes: null };
    }) });
  assert.deepEqual(normalize(current, true), normalize(original, false), 'RESOLVE_REPAIR_COLLECTOR_CHANGED');
}

export async function verifyResolveRepairInstrumentation(execution, original, repair) {
  assert.deepEqual(execution.instrumentation, await instrumentationIdentity(execution), 'RESOLVE_REPAIR_CURRENT_INSTRUMENTATION_CHANGED');
  assertResolveRepairInstrumentation(execution.instrumentation, original, repair);
}
