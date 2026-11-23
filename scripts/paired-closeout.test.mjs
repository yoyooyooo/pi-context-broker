import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { closeoutEnvironment } from './paired-closeout.mjs';
import { parseArgs } from './paired-environment.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
async function ref(path) { const bytes = await readFile(path); return { path, sha256: sha(bytes), bytes: bytes.length }; }
function git(path, ...args) { return execFileSync('git', ['-c', 'user.name=Closeout fixture', '-c', 'user.email=closeout@example.invalid', '-c', 'core.fsmonitor=false', '-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function inventory(root) {
  const found = [];
  async function walk(path) {
    for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, item.name); if (item.isDirectory()) await walk(child); else found.push([child, sha(await readFile(child))]);
    }
  }
  await walk(root); return found;
}
async function fixture({ build = true } = {}) {
  const parent = await realpath(process.env.PAIRED_CLOSEOUT_TEST_ROOT || tmpdir());
  const root = await mkdtemp(join(parent, 'paired-closeout-'));
  await mkdir(join(root, 'control')); const repositories = {}, heads = {};
  for (const name of ['cli', 'broker']) {
    const path = join(root, name); await mkdir(path); git(path, 'init', '--initial-branch=next');
    await writeFile(join(path, 'source.txt'), name + '\n'); git(path, 'add', 'source.txt'); git(path, 'commit', '-m', 'fixture');
    heads[name] = git(path, 'rev-parse', 'HEAD'); git(path, 'update-ref', 'refs/remotes/origin/next', heads[name]);
    repositories[name] = { path };
  }
  const environment = { version: 1, kind: 'paired-development-environment', root, environment_id: randomUUID(), repositories };
  await save(join(root, 'environment.json'), environment);
  const value = { root, environment, heads };
  if (build) await addBuild(value);
  return value;
}
async function addBuild(f) {
  const root = join(f.root, 'builds', 'retained-1'); await mkdir(root, { recursive: true });
  await save(join(root, 'build.json'), { version: 1, kind: 'paired-build', root, build_id: 'retained-1', environment_id: f.environment.environment_id,
    sources: { cli: { commit: '0'.repeat(40) }, broker: { commit: '1'.repeat(40) } } });
}
async function manifest(f) {
  const snapshot = await closeoutEnvironment({ root: f.root });
  const sources = Object.fromEntries(['cli', 'broker'].map(name => [name, {
    head: f.heads[name], integration: { target_ref: 'refs/remotes/origin/next', target_commit: f.heads[name], merged_commit: f.heads[name], method: 'ancestor' },
    references: snapshot.sources[name].references,
    disposition: { kind: 'retained', owner: 'fixture-owner', release_condition: { kind: 'environment_retired', description: 'Retire the environment only after its retained evidence is released.' } },
  }]));
  const value = { version: 1, kind: 'paired-source-closeout', environment: snapshot.environment, sources };
  return { path: join(f.root, 'control', 'manifest.json'), value };
}
async function run(f, m, options = {}) { await save(m.path, m.value); return closeoutEnvironment({ root: f.root, manifest: m.path, ...options }); }
async function trashFixture({ hiddenBranch = false } = {}) {
  const f = await fixture({ build: false }), m = await manifest(f), source = join(f.root, 'cli');
  const live = join(f.root, 'control', 'live-operation.json'); await save(live, { source: join(f.root, 'broker') });
  const descriptor = await ref(live);
  m.value.sources.broker.references = [{ kind: 'owned_json_reference', path: live, sha256: descriptor.sha256, pointer: '/source', target: 'source' }];
  m.value.sources.broker.disposition.release_condition.kind = 'references_retired';
  m.value.sources.cli.disposition = null;
  if (hiddenBranch) {
    git(source, 'checkout', '-b', 'unmerged'); await writeFile(join(source, 'unique.txt'), 'retain me'); git(source, 'add', 'unique.txt'); git(source, 'commit', '-m', 'unmerged fixture'); git(source, 'checkout', 'next');
  }
  const beforePath = join(f.root, 'control', 'pre-trash-audit.json'); await run(f, m, { receipt: beforePath });
  const before = await ref(beforePath);
  // Test fixtures retain the source bytes under control; this is not a real OS Trash operation.
  await rename(source, join(f.root, 'control', 'retained-cli-fixture'));
  const destination = join(homedir(), '.Trash', 'unit-fixture-' + f.environment.environment_id);
  const native = { version: 1, kind: 'paired-source-system-trash', environment_id: f.environment.environment_id, source_path: source, source_head: f.heads.cli,
    pre_audit: before, command: { path: '/usr/bin/trash', args: ['-v', source] }, exit_code: 0,
    stdout: 'Synthetic unit fixture native acknowledgement: ' + destination, stderr: '', destination_path: destination };
  const nativePath = join(f.root, 'control', 'synthetic-native-receipt.json'); await save(nativePath, native);
  m.value.sources.cli.disposition = { kind: 'trashed', pre_audit: before, trash_receipt: await ref(nativePath) };
  return { f, m, native, nativePath };
}

test('inspection and the public CLI are read-only and review_required is non-final', async () => {
  const f = await fixture(), before = await inventory(f.root);
  const result = await closeoutEnvironment({ root: f.root }); assert.equal(result.status, 'review_required');
  assert.equal(result.coverage.foreign_references, 'not_scanned'); assert.equal(result.coverage.deletion_performed, false);
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'paired-environment.mjs');
  const child = spawnSync(process.execPath, [cli, 'closeout', '--root', f.root], { encoding: 'utf8' });
  assert.equal(child.status, 2, child.stderr + child.stdout); assert.equal(JSON.parse(child.stdout).status, 'review_required');
  assert.deepEqual(await inventory(f.root), before);
  assert.equal(parseArgs(['closeout', '--root', f.root]).command, 'closeout');
  assert.throws(() => parseArgs(['closeout', '--root', f.root, '--delete', 'yes']), /Unknown option/);
});

test('retained current clean sources may differ from historical build heads', async () => {
  const f = await fixture(), m = await manifest(f), result = await run(f, m);
  assert.equal(result.status, 'reviewed_with_retained_sources');
  assert.equal(result.sources.cli.head, f.heads.cli); assert.equal(result.sources.cli.references.length, 1);
  const build = JSON.parse(await readFile(join(f.root, 'builds/retained-1/build.json'))); assert.notEqual(build.sources.cli.commit, result.sources.cli.head);
});

test('an explicit receipt is exclusive and missing disposition remains review_required', async () => {
  const f = await fixture(), m = await manifest(f); m.value.sources.cli.disposition = null;
  const receipt = join(f.root, 'control', 'audit.json'); const result = await run(f, m, { receipt }); assert.equal(result.status, 'review_required');
  const bytes = await readFile(receipt); await assert.rejects(run(f, m, { receipt }), /EEXIST/); assert.deepEqual(await readFile(receipt), bytes);
  delete m.value.sources.broker; await assert.rejects(run(f, m), /Missing field: broker/);
});

test('dirty or changed source HEAD cannot pass a completed manifest', async () => {
  const f = await fixture(), m = await manifest(f); await writeFile(join(f.root, 'cli/source.txt'), 'dirty');
  await assert.rejects(run(f, m), /dirty/); git(join(f.root, 'cli'), 'add', 'source.txt'); git(join(f.root, 'cli'), 'commit', '-m', 'changed fixture');
  await assert.rejects(run(f, m), /HEAD changed/);
});

test('tampered or omitted frozen-build references are rejected', async () => {
  const f = await fixture(), m = await manifest(f); m.value.sources.cli.references = [];
  await assert.rejects(run(f, m), /Missing retained frozen-build/);
  const fresh = await manifest(f), path = join(f.root, 'builds/retained-1/build.json'); const value = JSON.parse(await readFile(path)); value.note = 'changed'; await save(path, value);
  await assert.rejects(run(f, fresh), /Frozen build reference changed/);
});

test('unowned paths and wrong JSON dependency pointers cannot justify retention', async () => {
  const f = await fixture({ build: false }), m = await manifest(f);
  m.value.sources.cli.references = [{ kind: 'owned_json_reference', path: join(f.root, 'outside.json'), sha256: 'a'.repeat(64), pointer: '/source', target: 'source' }];
  await assert.rejects(run(f, m), /owned by this environment/);
  const path = join(f.root, 'control', 'wrong.json'); await save(path, { source: '/someone/else' });
  m.value.sources.cli.references[0] = { ...m.value.sources.cli.references[0], path, sha256: (await ref(path)).sha256 };
  await assert.rejects(run(f, m), /does not reference this paired source/);
});

test('source ownership and symlink evidence or output paths are rejected', async () => {
  const f = await fixture(), m = await manifest(f), outside = join(f.root, 'outside'); await mkdir(outside);
  const linked = join(f.root, 'control', 'linked'); await symlink(outside, linked);
  await assert.rejects(run(f, m, { receipt: join(linked, 'audit.json') }), /Symlink paths/);
  const other = await fixture({ build: false }), n = await manifest(other), actual = join(other.root, 'target.json'); await save(actual, { source: join(other.root, 'cli') });
  const link = join(other.root, 'control', 'link.json'); await symlink(actual, link);
  n.value.sources.cli.references = [{ kind: 'owned_json_reference', path: link, sha256: (await ref(actual)).sha256, pointer: '/source', target: 'source' }];
  await assert.rejects(run(other, n), /Symlink paths/);
  f.environment.repositories.cli.path = '/unowned/clone'; await save(join(f.root, 'environment.json'), f.environment);
  await assert.rejects(closeoutEnvironment({ root: f.root }), /owned paired path/);
});

test('a present source cannot claim Trash and an absent source needs bound evidence', async () => {
  const f = await fixture({ build: false }), m = await manifest(f);
  m.value.sources.cli.disposition = { kind: 'trashed', pre_audit: {}, trash_receipt: {} };
  await assert.rejects(run(f, m), /present source checkout/);
  await rename(join(f.root, 'cli'), join(f.root, 'control', 'retained-source'));
  m.value.sources.cli.disposition = { kind: 'retained', owner: 'fixture', release_condition: { kind: 'references_retired', description: 'after fixture' } };
  await assert.rejects(run(f, m), /Missing source needs/);
});

test('bound pre-audit plus native acknowledgement records only its actual verification level', async () => {
  const { f, m } = await trashFixture(), result = await run(f, m);
  assert.equal(result.status, 'reviewed_with_retained_sources'); assert.equal(result.sources.cli.trash_verification.source_absent, true);
  assert.equal(result.sources.cli.trash_verification.destination_bytes, 'not_verified');
});

test('missing native acknowledgement and tampered pre-audit are rejected', async () => {
  const { f, m, native, nativePath } = await trashFixture(); native.stdout = ''; await save(nativePath, native);
  m.value.sources.cli.disposition.trash_receipt = await ref(nativePath);
  await assert.rejects(run(f, m), /Native Trash acknowledgement/);
  const before = m.value.sources.cli.disposition.pre_audit; await writeFile(before.path, '{}');
  await assert.rejects(run(f, m), /Retained evidence hash changed/);
});

test('a new retained frozen build prevents a previously unreferenced source from claiming Trash', async () => {
  const { f, m } = await trashFixture(); await addBuild(f);
  await assert.rejects(run(f, m), /Missing retained frozen-build/);
});

test('unmerged local branch evidence prevents a trashed disposition', async () => {
  const { f, m } = await trashFixture({ hiddenBranch: true });
  await assert.rejects(run(f, m), /Pre-trash integration proof/);
});

test('a changed integration target or unsupported proof is rejected', async () => {
  const f = await fixture(), m = await manifest(f); m.value.sources.cli.integration.target_commit = '0'.repeat(40);
  await assert.rejects(run(f, m), /Local target ref changed/);
  m.value.sources.cli.integration.target_commit = f.heads.cli; m.value.sources.cli.integration.method = 'assume_merged';
  await assert.rejects(run(f, m), /Unsupported integration proof/);
});
