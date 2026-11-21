import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileInventory } from './next-build-identity.mjs';
import { verifyCurrentBuild, verifyNextWorktreePair } from './verify-next-worktrees.mjs';

const save = (path, value) => writeFile(path, JSON.stringify(value) + '\n');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'next-worktree-gate-'));
  const cli = join(parent, 'cli'), broker = join(parent, 'broker');
  const cliRoot = join(cli, 'packages/cli'), brokerRoot = join(broker, 'packages/context-broker');
  for (const [root, pkg] of [[cli, cliRoot], [broker, brokerRoot]]) {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(pkg, 'dist'), { recursive: true });
    await writeFile(join(root, 'src/current.ts'), 'export const version = 1;\n');
    await writeFile(join(pkg, 'package.json'), '{"type":"module"}\n');
    git(root, 'init', '--initial-branch=next');
  }
  await mkdir(join(cliRoot, 'skills'));
  await writeFile(join(cliRoot, 'skills/SKILL.md'), 'current skill\n');
  await writeFile(join(cliRoot, 'dist/ntn-skills.js'), 'current CLI\n');
  await writeFile(join(cliRoot, 'dist/sdk.js'), 'current SDK\n');
  await writeFile(join(brokerRoot, 'dist/ntn-skills-sdk.mjs'), 'embedded current SDK\n');
  async function cliBuild() {
    await save(join(cliRoot, 'dist/next-build.json'), { version: 1, kind: 'cli-build', input_roots: ['src'],
      source: await fileInventory(cli, ['src']), artifacts: await fileInventory(cliRoot, ['dist/ntn-skills.js', 'dist/sdk.js', 'skills']) });
  }
  await cliBuild();
  await save(join(brokerRoot, 'dist/next-build.json'), { version: 1, kind: 'broker-build', input_roots: ['src'],
    source: await fileInventory(broker, ['src']), artifacts: await fileInventory(brokerRoot, ['dist/ntn-skills-sdk.mjs']),
    selected_cli: await fileInventory(cliRoot, ['package.json', 'dist/ntn-skills.js', 'dist/sdk.js', 'skills']) });
  function commit(root) {
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Next gate fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
    return git(root, 'rev-parse', 'HEAD');
  }
  const config = { cliRoot, brokerRoot, worktrees: { cli: { root: cli, commit: commit(cli) }, broker: { root: broker, commit: commit(broker) } } };
  return { cli, broker, cliRoot, brokerRoot, config, commit, cliBuild };
}
test('source and paired builds pass without claiming a real Pi launch', async () => {
  const f = await fixture(), result = await verifyNextWorktreePair(f.config);
  assert.equal(result.status, 'passed'); assert.equal(result.actual_pi_process, 'not_run');
  assert.equal(result.cli.commit, f.config.worktrees.cli.commit);
});
test('committing new source does not make an old build current', async () => {
  const f = await fixture();
  await writeFile(join(f.cli, 'src/current.ts'), 'export const version = 2;\n');
  f.config.worktrees.cli.commit = f.commit(f.cli);
  await assert.rejects(verifyNextWorktreePair(f.config), /Source or artifact differs/);
});
test('new source files and overwritten build artifacts are rejected independently', async () => {
  const f = await fixture();
  await writeFile(join(f.cli, 'src/new.ts'), 'export const added = true;\n');
  await assert.rejects(verifyCurrentBuild(f.cli, f.cliRoot, 'cli-build'), /added or removed/);
  await writeFile(join(f.brokerRoot, 'dist/ntn-skills-sdk.mjs'), 'stale or altered SDK\n');
  await assert.rejects(verifyCurrentBuild(f.broker, f.brokerRoot, 'broker-build'), /Source or artifact differs/);
});
test('a newly built CLI cannot pass with the previous embedded SDK', async () => {
  const f = await fixture();
  await writeFile(join(f.cliRoot, 'dist/sdk.js'), 'new raw SDK\n');
  await f.cliBuild(); f.config.worktrees.cli.commit = f.commit(f.cli);
  await assert.rejects(verifyNextWorktreePair(f.config), /Source or artifact differs.*dist\/sdk/);
});
test('next branch, exact target commit and actual package path are mandatory', async () => {
  const f = await fixture();
  await assert.rejects(verifyNextWorktreePair({ ...f.config, cliRoot: f.brokerRoot }), /outside the target/);
  await assert.rejects(verifyNextWorktreePair({ ...f.config, worktrees: { ...f.config.worktrees, cli: { root: f.cli, commit: '0'.repeat(40) } } }), /not reached the target/);
  git(f.cli, 'switch', '-c', 'older-entry');
  await assert.rejects(verifyNextWorktreePair(f.config), /next branch/);
});
test('unfinished work cannot be reported as a completed daily delivery', async () => {
  const f = await fixture();
  await writeFile(join(f.cli, 'src/uncommitted.ts'), 'unfinished\n');
  await assert.rejects(verifyNextWorktreePair(f.config), /unfinished work/);
  const receipt = JSON.parse(await readFile(join(f.cliRoot, 'dist/next-build.json'), 'utf8'));
  assert.equal(receipt.kind, 'cli-build');
});
