import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileInventory, verifyInventory } from './next-build-identity.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
async function checkout(spec, packageRoot, packagePath) {
  assert.ok(spec && isAbsolute(spec.root) && /^[a-f0-9]{40}$/.test(spec.commit), 'Bind each next checkout to a complete target commit');
  const root = await realpath(spec.root);
  assert.equal(await realpath(git(root, 'rev-parse', '--show-toplevel')), root, 'The selected path must be the checkout root');
  assert.equal(git(root, 'branch', '--show-current'), 'next', 'Daily delivery must use the next branch');
  const commit = git(root, 'rev-parse', 'HEAD');
  assert.equal(commit, spec.commit, 'The machine has not reached the target next commit');
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), '', 'Commit or isolate unfinished work before daily delivery');
  assert.equal(await realpath(packageRoot), await realpath(join(root, packagePath)), 'The daily package points outside the target next worktree');
  return { root, commit, branch: 'next', package_root: await realpath(packageRoot) };
}
export async function verifyCurrentBuild(sourceRoot, packageRoot, kind) {
  const receipt = await json(join(packageRoot, 'dist/next-build.json'));
  assert.equal(receipt.version, 1); assert.equal(receipt.kind, kind);
  assert.ok(Array.isArray(receipt.input_roots) && receipt.input_roots.length > 0);
  for (const name of receipt.input_roots) assert.ok(typeof name === 'string' && name && !isAbsolute(name) && !name.split('/').includes('..'));
  await verifyInventory(sourceRoot, receipt.source);
  assert.deepEqual(await fileInventory(sourceRoot, receipt.input_roots), receipt.source, 'Source files were added or removed after this build');
  await verifyInventory(packageRoot, receipt.artifacts);
  return receipt;
}
/** This checks source/build correspondence. The existing daily runner must
 * still launch a fresh ordinary pi -ns process and inspect its actual entry. */
export async function verifyNextWorktreePair(config) {
  assert.ok(config.worktrees && config.cliRoot && config.brokerRoot, 'Daily verification requires the paired next worktree config');
  const cli = await checkout(config.worktrees.cli, config.cliRoot, 'packages/cli');
  const broker = await checkout(config.worktrees.broker, config.brokerRoot, 'packages/context-broker');
  const cliBuild = await verifyCurrentBuild(cli.root, cli.package_root, 'cli-build');
  const brokerBuild = await verifyCurrentBuild(broker.root, broker.package_root, 'broker-build');
  await verifyInventory(cli.package_root, brokerBuild.selected_cli);
  assert.deepEqual(await fileInventory(cli.package_root, ['package.json', 'dist/ntn-skills.js', 'dist/sdk.js', 'skills']), brokerBuild.selected_cli,
    'The Broker was not rebuilt against the current raw CLI/SDK');
  return { version: 1, scope: 'next-worktree-source-and-build', status: 'passed',
    cli: { ...cli, source_sha256: cliBuild.source.sha256, artifacts_sha256: cliBuild.artifacts.sha256 },
    broker: { ...broker, source_sha256: brokerBuild.source.sha256, artifacts_sha256: brokerBuild.artifacts.sha256,
      selected_cli_sha256: brokerBuild.selected_cli.sha256 },
    runtime: { node: process.version, executable: process.execPath },
    actual_pi_process: 'not_run' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], '--config'); assert.equal(process.argv.length, 4);
  const result = await verifyNextWorktreePair(await json(resolve(process.argv[3])));
  console.log(JSON.stringify(result, null, 2));
}
