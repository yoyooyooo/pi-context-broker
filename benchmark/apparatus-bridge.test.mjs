import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkEnvironment, inventory } from '../scripts/paired-environment.mjs';
import { fileInventory, selectedCliInputs } from '../scripts/next-build-identity.mjs';
import { createApparatusBridge, verifyApparatusBridge } from './apparatus-bridge.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); };
const reference = async path => { const bytes = await readFile(path); return { path, sha256: sha(bytes), bytes: bytes.length }; };
const before = 'export const label = "old";\n', after = 'export const label = "reviewed-group";\n';
const sourceChanges = [{ path: 'broker/benchmark/reported-model.mjs', before_sha256: sha(before), after_sha256: sha(after) }];
const buildIdentitySource = await readFile(new URL('../scripts/next-build-identity.mjs', import.meta.url), 'utf8');

async function fixture(t, variation = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'apparatus-bridge-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const heads = {};
  for (const role of ['cli', 'broker']) {
    const cwd = join(root, role); await mkdir(cwd);
    execFileSync('git', ['init', '--quiet'], { cwd }); await save(join(cwd, 'fixture.txt'), 'owned test repository\n');
    execFileSync('git', ['add', 'fixture.txt'], { cwd });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'owned fixture'], { cwd });
    heads[role] = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  }
  await save(join(root, 'environment.json'), { version: 1, kind: 'paired-development-environment', root, environment_id: 'fixture-env' });
  for (const [buildId, updated] of [['old', false], ['new', true]]) {
    const buildRoot = join(root, 'builds', buildId);
    const cliFiles = { 'package.json': '{"name":"fixture-cli"}\n', 'README.md': updated && variation.metadata ? 'changed metadata\n' : 'same metadata\n',
      'dist/ntn-skills.js': 'same CLI bytes\n', 'dist/sdk.js': updated && variation.sdk ? 'changed SDK bytes\n' : 'same SDK bytes\n',
      'dist/management.js': updated && variation.management ? 'changed management bytes\n' : 'same management bytes\n',
      'dist/ref.cjs': 'same Skill reference module\n', 'skills/fixture/SKILL.md': '# Controlled fixture Skill\n',
      'THIRD_PARTY_NOTICES.md': 'Same dependency notices\n',
      'node_modules/dependency/index.js': updated && variation.dependency ? 'changed installed dependency\n' : 'same installed dependency\n',
      'dist/next-build.json': JSON.stringify({ version: 1, kind: 'cli-build', input_roots: ['product.mjs'], source: 'same product inputs', toolchain: 'same' }) };
    for (const [path, bytes] of Object.entries(cliFiles)) await save(join(buildRoot, 'cli', path), bytes);
    const selected = await fileInventory(join(buildRoot, 'cli'), selectedCliInputs);
    await save(join(buildRoot, 'broker/package.json'), '{"name":"fixture-broker"}\n');
    await save(join(buildRoot, 'broker/src/index.ts'), 'export default 0;\n');
    await save(join(buildRoot, 'broker/dist/next-build.json'), { version: 1, kind: 'broker-build', selected_cli: selected });
    for (const role of ['cli', 'broker']) {
      await save(join(buildRoot, 'source', role, 'product.mjs'), updated && variation.productSource && role === 'broker' ? 'changed product source\n' : 'same product source\n');
      await save(join(buildRoot, 'source', role, 'node_modules/build-dependency/index.js'), updated && variation.buildDependency && role === 'cli' ? 'changed build dependency\n' : 'same build dependency\n');
    }
    await save(join(buildRoot, 'source/broker/scripts/next-build-identity.mjs'), buildIdentitySource);
    await save(join(buildRoot, 'source/broker/benchmark/reported-model.mjs'), updated ? after : before);
    const sources = {}, packages = {};
    for (const role of ['cli', 'broker']) {
      const source = await inventory(join(buildRoot, 'source', role));
      const files = source.files.filter(file => !file.path.startsWith('node_modules/')).map(({ path, sha256 }) => ({ path, sha256 }));
      sources[role] = { commit: heads[role], branch: 'fixture', files, sha256: sha(JSON.stringify(files)) };
      packages[role] = await inventory(join(buildRoot, role));
    }
    await save(join(buildRoot, 'build.json'), { version: 1, kind: 'paired-build', environment_id: 'fixture-env', build_id: buildId,
      root: buildRoot, sources, packages, source_tree: await inventory(join(buildRoot, 'source')), selected_cli_sha256: selected.sha256 });
  }
  const options = { environmentRoot: root, sourceBuildId: 'old', targetBuildId: 'new' };
  return { root, options, async proof() {
    const value = await createApparatusBridge({ ...options, sourceChanges });
    const path = join(root, 'control/bridge.json'); await save(path, value); return { value, reference: await reference(path) };
  } };
}

test('only the declared instrumentation changes while actual public checker verifies both frozen products', async t => {
  const f = await fixture(t), proof = await f.proof();
  const result = await verifyApparatusBridge(proof.reference, f.options);
  assert.equal(result.status, 'passed'); assert.equal(result.model_calls, 0);
  assert.equal(result.source_build.identity.id, 'old'); assert.equal(result.target_build.identity.id, 'new');
  assert.notEqual(result.source_build.identity.receipt_sha256, result.target_build.identity.receipt_sha256);
  assert.equal(result.source_build.identity.cli.package_sha256, result.target_build.identity.cli.package_sha256);
  assert.equal(result.source_build.identity.cli.sdk_sha256, result.target_build.identity.cli.sdk_sha256);
  assert.deepEqual(result.source_changes, sourceChanges);
  assert.equal(result.checker.receipts.source.status, 'passed'); assert.equal(result.checker.receipts.target.status, 'passed');
});

for (const [name, variation] of [['SDK', { sdk: true }], ['management', { management: true }], ['metadata', { metadata: true }], ['installed dependency', { dependency: true }]]) {
  test('a separately valid paired build cannot bridge changed ' + name, async t => {
    const f = await fixture(t, variation);
    assert.equal((await checkEnvironment({ root: f.root, build: 'new' })).status, 'passed');
    await assert.rejects(() => f.proof(), /Product package inventory differs/);
  });
}
for (const [name, variation] of [['product source', { productSource: true }], ['build dependency', { buildDependency: true }]]) {
  test('the complete frozen source rejects an extra ' + name + ' change', async t => {
    const f = await fixture(t, variation);
    assert.equal((await checkEnvironment({ root: f.root, build: 'new' })).status, 'passed');
    await assert.rejects(() => f.proof(), /Undeclared source or build-dependency change/);
  });
}

test('callers cannot expand the instrumentation exception or change its exact before/after hashes', async t => {
  const f = await fixture(t);
  for (const change of [{ ...sourceChanges[0], path: 'broker/product.mjs' }, { ...sourceChanges[0], after_sha256: 'a'.repeat(64) }])
    await assert.rejects(() => createApparatusBridge({ ...f.options, sourceChanges: [change] }));
  await assert.rejects(() => createApparatusBridge({ ...f.options, sourceChanges: [...sourceChanges, { ...sourceChanges[0] }] }));
});

test('a bridge is bound to exact build IDs and actual build-receipt bytes', async t => {
  const f = await fixture(t), proof = await f.proof();
  await assert.rejects(() => verifyApparatusBridge(proof.reference, { ...f.options, targetBuildId: 'another' }));
  const path = join(f.root, 'builds/new/build.json'); await writeFile(path, (await readFile(path, 'utf8')) + ' ');
  await assert.rejects(() => verifyApparatusBridge(proof.reference, f.options), /evidence changed/);
});

test('old checker success cannot hide a changed actual package file', async t => {
  const f = await fixture(t), proof = await f.proof();
  await writeFile(join(f.root, 'builds/new/cli/node_modules/dependency/index.js'), 'changed after proof\n');
  await assert.rejects(() => verifyApparatusBridge(proof.reference, f.options), /Frozen package changed/);
});

test('checker claims are checked against the actual public result and implementation', async t => {
  const f = await fixture(t), proof = await f.proof();
  proof.value.checker.receipts.target.status = 'invented-pass';
  await save(proof.reference.path, proof.value);
  const altered = await reference(proof.reference.path);
  await assert.rejects(() => verifyApparatusBridge(altered, f.options), /Actual public checker proof differs/);
});
