import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceVisibility } from './runtime/episode-visibility.mjs';

export const CURRENT_SOURCE_CONTRACT = 'notion-sdk-v3/library-root-v1/resource-read-v1/skill-ref-v2/preparation-evidence-v2';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };

/** The current interpreter comes from the exact public observer projection,
 * with its paired reference producer. Historical evidence never enters here. */
export async function loadCurrentSourceViews({ runRoot, buildRoot, candidate }) {
  assert.deepEqual(sourceVisibility(candidate.snapshot.visibility), sourceVisibility(candidate.projection.visibility), 'Current source visibility changed');
  const files = candidate.snapshot.visibility.projection.files;
  assert.deepEqual(files, candidate.projection.visibility.projection.files);
  const root = join(runRoot, 'subject-runtime'), artifacts = [];
  const readPinned = async (path, sha256) => {
    assert.equal(await realpath(path), path, 'Current source evidence cannot resolve through a link');
    const bytes = await readFile(path); assert.equal(hash(bytes), sha256, 'Current source interpreter evidence changed');
    artifacts.push({ path, sha256, bytes: bytes.length }); return bytes;
  };
  const pinned = new Map();
  for (const file of files) {
    const path = resolve(root, file.path); assert.ok(within(root, path) && path !== root);
    assert.ok(!pinned.has(file.path)); pinned.set(file.path, await readPinned(path, file.sha256));
  }
  const runtimeName = 'packages/context-broker/src/ntn-skills-runtime.json';
  const producer = JSON.parse(pinned.get(runtimeName));
  assert.equal(producer.version, 1); assert.equal(producer.package, 'ntn-skills');
  assert.equal(producer.sdk_version, 3); assert.equal(producer.skill_ref_version, 2);
  assert.equal(producer.resource_read_contract_version, 1);
  assert.equal(producer.ref_sha256, hash(pinned.get('packages/context-broker/src/ntn-skills-ref.cjs')));
  assert.equal(candidate.snapshot.build.path, join(buildRoot, 'build.json'));
  const build = JSON.parse(await readPinned(candidate.snapshot.build.path, candidate.snapshot.build.sha256));
  const sdkFile = build.packages.cli.files.find(file => file.path === 'dist/sdk.js');
  const bundleFile = build.packages.broker.files.find(file => file.path === 'dist/ntn-skills-sdk.mjs');
  const refFile = build.packages.cli.files.find(file => file.path === 'dist/ref.cjs');
  assert.equal(bundleFile.sha256, producer.sdk_sha256, 'Current source parser must match the measured paired SDK bundle');
  assert.equal(refFile.sha256, producer.ref_sha256, 'Current source parser must match the paired public reference export');
  await readPinned(join(buildRoot, 'broker/dist/ntn-skills-sdk.mjs'), producer.sdk_sha256);
  await readPinned(join(buildRoot, 'cli/dist/sdk.js'), sdkFile.sha256);
  await readPinned(join(buildRoot, 'cli/dist/ref.cjs'), producer.ref_sha256);
  const module = async path => {
    assert.ok(pinned.has(path), 'Current source interpreter is absent from the captured public projection');
    return import(pathToFileURL(join(root, path)).href);
  };
  const [graph, preparation, refs] = await Promise.all([
    module('scripts/notion-skill-graph-model-evidence.mjs'), module('scripts/skill-preparation-evidence.mjs'),
    module('packages/context-broker/src/native-reference.ts'),
  ]);
  return { contract: CURRENT_SOURCE_CONTRACT, graphSourceViews: graph.graphSourceViews,
    verifyPreparationEvidence: preparation.verifyPreparationEvidence, parseReference: refs.parseNativeReference,
    producer: { ...producer, public_sdk_sha256: sdkFile.sha256 }, artifacts,
    scope: 'captured SDK3 public observer and exact paired Skill-ref-v2 producer' };
}
