import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileInventory, verifyInventory } from './next-build-identity.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const blocked = (code, message) => Object.assign(new Error(message), { code, status: 'blocked' });
const ORIGIN_TIMEOUT_MS = 10_000;

/** Only the domain-separated digest leaves this function; never retain raw host IDs. */
export async function machineFingerprint() {
  const platform = process.platform;
  let identity;
  try {
    if (platform === 'darwin') {
      const output = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'],
        { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      identity = output.match(/"IOPlatformUUID"\s*=\s*"([a-f0-9-]{36})"/i)?.[1];
    } else if (platform === 'linux') identity = (await readFile('/etc/machine-id', 'utf8')).trim();
    else throw new Error('unsupported');
    assert.ok(identity && /^[a-f0-9]{32}$/i.test(identity.replaceAll('-', '')) && !/^0+$/.test(identity.replaceAll('-', '')));
  } catch {
    throw blocked('MACHINE_ID_UNAVAILABLE', 'A stable machine identity is required; this host cannot provide one. No hostname fallback is allowed.');
  }
  return { scheme: 'machine-id-sha256-v1', platform,
    sha256: createHash('sha256').update('context-broker:daily-machine:v1\0' + platform + '\0' + identity.toLowerCase()).digest('hex') };
}

/** Query the real origin, never a possibly stale refs/remotes/origin/next. */
async function originNext(root) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, 'ls-remote', '--exit-code', 'origin', 'refs/heads/next'],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never' } });
    let output = '', settled = false, timer;
    const finish = (error, commit) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error && child.pid && child.exitCode === null && child.signalCode === null) {
        // The process group belongs to this query, including Git's SSH/HTTP helpers.
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
      child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error); else resolve(commit);
    };
    const unavailable = () => blocked('ORIGIN_NEXT_UNAVAILABLE', 'Could not verify the real origin/next within the 10-second non-interactive query budget.');
    timer = setTimeout(() => finish(unavailable()), ORIGIN_TIMEOUT_MS);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.length > 4096) finish(unavailable());
    });
    child.stdout.on('error', () => finish(unavailable()));
    child.stderr.on('error', () => finish(unavailable()));
    child.stderr.resume();
    child.on('error', () => finish(unavailable()));
    child.on('close', (code, signal) => {
      const match = output.trim().match(/^([a-f0-9]{40})\s+refs\/heads\/next$/);
      if (code !== 0 || signal || !match) finish(unavailable());
      else finish(undefined, match[1]);
    });
  });
}
async function checkout(spec, packageRoot, packagePath) {
  assert.ok(spec && isAbsolute(spec.root) && /^[a-f0-9]{40}$/.test(spec.commit), 'Bind each next checkout to a complete target commit');
  const root = await realpath(spec.root);
  assert.equal(await realpath(git(root, 'rev-parse', '--show-toplevel')), root, 'The selected path must be the checkout root');
  assert.equal(git(root, 'branch', '--show-current'), 'next', 'Daily delivery must use the next branch');
  const commit = git(root, 'rev-parse', 'HEAD');
  assert.equal(commit, spec.commit, 'The machine has not reached the target next commit');
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), '', 'Commit or isolate unfinished work before daily delivery');
  assert.equal(await realpath(packageRoot), await realpath(join(root, packagePath)), 'The daily package points outside the target next worktree');
  const origin = await originNext(root);
  assert.equal(origin, spec.commit, 'The real origin/next no longer matches the declared target');
  return { root, commit, branch: 'next', origin_next: origin, package_root: await realpath(packageRoot) };
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
  const machine = await machineFingerprint();
  const cli = await checkout(config.worktrees.cli, config.cliRoot, 'packages/cli');
  const broker = await checkout(config.worktrees.broker, config.brokerRoot, 'packages/context-broker');
  const cliBuild = await verifyCurrentBuild(cli.root, cli.package_root, 'cli-build');
  const brokerBuild = await verifyCurrentBuild(broker.root, broker.package_root, 'broker-build');
  await verifyInventory(cli.package_root, brokerBuild.selected_cli);
  assert.deepEqual(await fileInventory(cli.package_root, ['package.json', 'dist/ntn-skills.js', 'dist/sdk.js', 'skills']), brokerBuild.selected_cli,
    'The Broker was not rebuilt against the current raw CLI/SDK');
  return { version: 2, scope: 'next-worktree-source-and-build', status: 'passed', machine,
    cli: { ...cli, source_sha256: cliBuild.source.sha256, artifacts_sha256: cliBuild.artifacts.sha256 },
    broker: { ...broker, source_sha256: brokerBuild.source.sha256, artifacts_sha256: brokerBuild.artifacts.sha256,
      selected_cli_sha256: brokerBuild.selected_cli.sha256 },
    runtime: { node: process.version, executable: process.execPath },
    actual_pi_process: 'not_run' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], '--config'); assert.equal(process.argv.length, 4);
  try { console.log(JSON.stringify(await verifyNextWorktreePair(await json(resolve(process.argv[3]))), null, 2)); }
  catch (error) {
    console.log(JSON.stringify({ version: 2, scope: 'next-worktree-source-and-build', status: error.status === 'blocked' ? 'blocked' : 'failed',
      actual_pi_process: 'not_run', error: { code: error.code ?? 'WORKTREE_VERIFICATION_FAILED', message: error.message } }, null, 2));
    process.exitCode = 1;
  }
}
