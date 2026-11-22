#!/usr/bin/env node
/** Paired task clones, immutable build generations, and disposable run state.
 * This is process configuration isolation, not an OS or remote-permission sandbox.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, copyFile, cp, lstat, mkdir, readFile, readdir, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureRuntimeIdentity, compareRuntimeIdentity } from './paired-runtime-identity.mjs';
import { verifyArchiveInstallation, verifyBundledNotices } from './verify-package-closure.mjs';

const DEFAULTS = {
  cli: 'https://github.com/yoyooyooo/notion-skills-cli.git',
  broker: 'https://github.com/yoyooyooo/pi-context-broker.git',
};
const VERSION = 1;
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const own = (root, path) => path === root || (path.startsWith(root + sep));
const id = prefix => prefix + '-' + new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8);
const validId = value => { assert.match(value, /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, 'Use a simple build/run ID'); return value; };
const output = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }).trim();

export const HELP = `Usage:
  node scripts/paired-environment.mjs create --root ABSOLUTE_NEW_DIRECTORY
    [--cli-repository URL --broker-repository URL --cli-ref next --broker-ref next]
    [--pi-entry ABSOLUTE_PI_JS]
  node scripts/paired-environment.mjs build --root ROOT [--id BUILD_ID]
    [--install-mode directory|packed] [--pass-env ENV_NAME ...]
  node scripts/paired-environment.mjs check --root ROOT --build BUILD_ID
  node scripts/paired-environment.mjs run --root ROOT --build BUILD_ID
    --target cli|pi|command [--id RUN_ID] [--cwd workspace|cli|broker]
    [--entry TEST_SKILLS_DATABASE_UUID | --parent TEST_PARENT_UUID]
    [--skills ABSOLUTE_DIRECTORY] [--models ABSOLUTE_MODELS_JSON]
    [--pi-mode broker|native] [--native-skills ABSOLUTE_DIRECTORY]
    [--pi-extension ABSOLUTE_ENTRY ...]
    [--pass-env ENV_NAME ...] [--timeout-ms MILLISECONDS]
    [--stdin inherit|ignore] -- ARGUMENTS

create freezes both refs in independent clones with a task branch. build copies
current source into its own source/cli and source/broker snapshots, installs
private dependencies, and seals complete CLI/Broker packages. No implicit latest
build, global install, automatic pull, cleanup, or release is performed.
The optional packed install mode packs both packages, installs each archive in
a new private npm consumer, verifies installed bytes against the archive, and
freezes the archives, installed dependency trees and public runtime entries.
Every run of that build selects those installed entries through the usual wrapper.

run starts with private CLI/Broker config, cache, state, scheduler, Pi agent/session,
skill, working and temporary directories. HOME is unchanged. Pi uses a single
declared launch profile for both direct runs and the private pi wrapper. The
default broker mode loads the paired Broker; native mode requires --native-skills
and loads that copied root through Pi's own --skill path, without the Broker.
Both disable automatic resource discovery. Declare common observers/extensions
with repeatable --pi-extension; resource and session overrides after -- are rejected.
Credentials are
absent unless named by --pass-env. --models accepts environment variable references
for credentials, never literal keys or shell commands. --skills copies a selected
corpus for Broker discovery; local originals remain untouched. --entry records
PAIRED_NOTION_ENTRY and adds that Broker source; --parent records
PAIRED_NOTION_PARENT for explicit initialization. CLI arguments are unchanged:
pass --database ENTRY after a consumption command; follow each management command's
help, such as ctl library init --entry ENTRY. Neither launcher option restricts a
token's remote permissions.
A default run has no remote source.

Node, Pi, Bun and Git are machine prerequisites, not installed per task. The selected
entries, versions and declared file identities are observed in the run environment
before and after execution. Drift or an unavailable check fails the run receipt,
while retaining the command's own exit code, timeout and stdout/stderr separately.
This bounded observation does not freeze the entire toolchain installation.
create locates Pi from its executable or npm global root;
use --pi-entry if your normal command is a custom shell wrapper. Upgrade the shared
baseline normally; each build/run records and uses the current tool identities.
Command stdout/stderr go to runs/<id>/*.log; the launcher prints a JSON result.
Command tests receive their own copy of both source snapshots and dependencies;
--cwd cli|broker selects that run's copy. Stdin defaults to ignore for headless
commands; use --stdin inherit for RPC or explicit piped input. An optional timeout
stops only this run's owned process group.
This is isolated-development evidence, not the strict current-next/daily gate.
`;

export function parseArgs(args) {
  const [command, ...rest] = args;
  const allowed = {
    create: ['root', 'cli-repository', 'broker-repository', 'cli-ref', 'broker-ref', 'pi-entry'],
    build: ['root', 'id', 'pass-env', 'install-mode'], check: ['root', 'build'],
    run: ['root', 'build', 'target', 'id', 'cwd', 'entry', 'parent', 'skills', 'models', 'pass-env', 'timeout-ms', 'stdin',
      'pi-mode', 'native-skills', 'pi-extension'],
  };
  assert.ok(allowed[command], 'Choose create, build, check, or run; see --help');
  const options = { command, args: [], 'pass-env': [], 'pi-extension': [] };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === '--') { options.args = rest.slice(index + 1); break; }
    const key = arg.slice(2);
    assert.ok(arg.startsWith('--') && allowed[command].includes(key), 'Unknown option: ' + arg);
    const value = rest[++index];
    assert.ok(value && !value.startsWith('--'), 'Missing value for ' + arg);
    if (key === 'pass-env' || key === 'pi-extension') options[key].push(value);
    else { assert.equal(options[key], undefined, 'Repeated option: ' + arg); options[key] = value; }
  }
  assert.ok(options.root && isAbsolute(options.root), '--root must be an absolute path');
  options.root = resolve(options.root);
  if (command !== 'run') assert.equal(options.args.length, 0, 'Only run accepts command arguments');
  return options;
}

async function executable(name) {
  for (const base of (process.env.PATH ?? '').split(delimiter)) {
    const path = resolve(base, name);
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return await realpath(path); } catch {}
  }
  throw new Error('Required executable is missing: ' + name);
}

async function toolIdentity(path) {
  const actual = await realpath(path);
  return { path: actual, sha256: hash(await readFile(actual)) };
}

function supportedNode() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  assert.ok((major === 22 && (minor > 22 || (minor === 22 && patch >= 3))) ||
    (major === 24 && minor >= 20) || major > 24, 'Use Node ^22.22.3 or >=24.20.0');
}

async function findPi(explicit, npm) {
  async function inspect(candidate) {
    try {
      const path = await realpath(candidate);
      let parent = dirname(path);
      while (parent !== dirname(parent)) {
        try {
          const pkg = await json(join(parent, 'package.json'));
          if (pkg.name === '@earendil-works/pi-coding-agent') return { path, version: pkg.version, package_root: parent };
        } catch {}
        parent = dirname(parent);
      }
    } catch {}
  }
  if (explicit) {
    assert.ok(isAbsolute(explicit), '--pi-entry must be absolute');
    const found = await inspect(explicit); if (found) return found;
  } else {
    try { const found = await inspect(await executable('pi')); if (found) return found; } catch {}
    const globalRoot = execFileSync(process.execPath, [npm, 'root', '--global'],
      { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const found = await inspect(join(globalRoot, '@earendil-works/pi-coding-agent/dist/bundle/cli.js'));
    if (found) return found;
  }
  throw new Error('Cannot locate the Pi JavaScript entry; pass --pi-entry ABSOLUTE_PI_JS');
}

async function fresh(path) {
  await mkdir(dirname(path), { recursive: true });
  assert.equal(await realpath(dirname(path)), dirname(path), 'Use a canonical path without symlink ancestors');
  await mkdir(path, { mode: 0o700 }); // Exclusive; never reuse another environment/generation/run.
}

async function readEnvironment(root) {
  assert.equal(await realpath(root), root, 'Environment root moved or is a symlink');
  const env = await json(join(root, 'environment.json'));
  assert.equal(env.version, VERSION);
  assert.equal(env.root, root, 'Environment identity belongs to a different root');
  assert.equal(env.kind, 'paired-development-environment');
  return env;
}

/** Inventory exact file bytes and symlink targets; reject external mutable links. */
export async function inventory(root) {
  assert.equal(await realpath(root), root, 'Inventory root must not be a symlink or alias');
  const files = [];
  async function walk(name) {
    const path = join(root, name), info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await realpath(path);
      assert.ok(own(root, target), 'External symlink in frozen artifact: ' + name);
      files.push({ path: name, link: await readlink(path) });
    } else if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await walk(name ? name + '/' + child : child);
    } else {
      assert.ok(info.isFile(), 'Only ordinary files are supported: ' + name);
      files.push({ path: name, sha256: hash(await readFile(path)), executable: Boolean(info.mode & 0o111) });
    }
  }
  await walk('');
  return { sha256: hash(JSON.stringify(files)), files };
}

async function copyTree(source, destination, entries) {
  await mkdir(destination, { recursive: true });
  for (const file of entries.files) {
    const target = join(destination, file.path);
    await mkdir(dirname(target), { recursive: true });
    if (file.link !== undefined) {
      const actual = await realpath(join(source, file.path));
      assert.ok(own(source, actual), 'Source symlink escaped the frozen snapshot');
      await symlink(relative(dirname(target), join(destination, relative(source, actual))), target);
    } else {
      await copyFile(join(source, file.path), target, constants.COPYFILE_EXCL);
      await chmod(target, (await stat(join(source, file.path))).mode);
    }
  }
}

/** Child-local allowlist; never inherit NODE_OPTIONS, BASH_ENV, config, or credentials. */
export function runtimeEnvironment(runRoot, buildRoot, inherited, passNames = [], node = process.execPath, selected = {}) {
  const env = {};
  for (const name of ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'SystemRoot']) {
    if (inherited[name] !== undefined) env[name] = inherited[name];
  }
  for (const name of passNames) {
    assert.match(name, /^[A-Z][A-Z0-9_]*$/, 'Pass environment variable names, not values');
    assert.ok((name === 'NODE_EXTRA_CA_CERTS' || !/^(NTN_SKILLS_|CONTEXT_BROKER_|PI_|XDG_|PAIRED_|NODE_|BUN_|NPM_|NPM_CONFIG_|GIT_|SSH_|DYLD_|LD_)/.test(name)) &&
      !['PATH', 'HOME', 'USERPROFILE', 'BASH_ENV', 'ENV', 'TMP', 'TEMP', 'TMPDIR', 'SHELL'].includes(name),
    'Cannot override an isolation or executable setting: ' + name);
    assert.ok(inherited[name], 'Environment variable is not set: ' + name);
    if (name === 'NODE_EXTRA_CA_CERTS') assert.ok(isAbsolute(inherited[name]), 'Additional CA certificates must use an absolute path');
    env[name] = inherited[name];
  }
  Object.assign(env, {
    PATH: [join(runRoot, 'bin'), dirname(node), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
    TMPDIR: join(runRoot, 'tmp'), TMP: join(runRoot, 'tmp'), TEMP: join(runRoot, 'tmp'),
    XDG_CONFIG_HOME: join(runRoot, 'xdg/config'), XDG_STATE_HOME: join(runRoot, 'xdg/state'),
    XDG_CACHE_HOME: join(runRoot, 'xdg/cache'), XDG_DATA_HOME: join(runRoot, 'xdg/data'),
    NTN_SKILLS_CONFIG_HOME: join(runRoot, 'config/cli'), NTN_SKILLS_HOME: join(runRoot, 'state/cli'),
    NTN_SKILLS_CACHE_HOME: join(runRoot, 'cache/cli'), NTN_SKILLS_DATA_HOME: join(runRoot, 'data/cli'),
    NTN_SKILLS_SCHEDULER_ROOT: join(runRoot, 'state/scheduler'),
    CONTEXT_BROKER_CONFIG: join(runRoot, 'config/broker.json'),
    PI_CODING_AGENT_DIR: join(runRoot, 'pi-agent'), PI_CODING_AGENT_SESSION_DIR: join(runRoot, 'sessions'),
    BUN_INSTALL_CACHE_DIR: join(runRoot, 'cache/bun'), npm_config_cache: join(runRoot, 'cache/npm'),
    npm_config_userconfig: join(runRoot, 'config/npmrc'),
    PAIRED_RUN_ROOT: runRoot, PAIRED_BUILD_ROOT: buildRoot,
    PAIRED_CLI_SOURCE: join(buildRoot, 'source/cli'), PAIRED_BROKER_SOURCE: join(buildRoot, 'source/broker'),
    PAIRED_CLI_ENTRY: selected.cli ?? join(buildRoot, 'cli/dist/ntn-skills.js'),
    PAIRED_BROKER_ENTRY: selected.broker ?? join(buildRoot, 'broker/src/index.ts'),
  });
  return env;
}

async function child(command, args, { cwd, env, log, timeout = 600_000, stdin = false }) {
  const out = await import('node:fs').then(fs => fs.createWriteStream(log + '.stdout.log', { flags: 'wx', mode: 0o600 }));
  const err = await import('node:fs').then(fs => fs.createWriteStream(log + '.stderr.log', { flags: 'wx', mode: 0o600 }));
  let timedOut = false, closed = false, spawnError;
  const proc = spawn(command, args, { cwd, env, detached: true, stdio: [stdin ? 'inherit' : 'ignore', 'pipe', 'pipe'] });
  const completion = new Promise(resolveChild => {
    proc.once('error', error => { spawnError = error.message; });
    proc.once('close', (code, signal) => {
      closed = true;
      resolveChild({ exit_code: code ?? 1, signal, timed_out: timedOut, spawned: Boolean(proc.pid), ...(spawnError ? { error: spawnError } : {}) });
    });
  });
  // A parent can exit while its descendants still own the pipes/process group.
  const stop = signal => { if (!closed && proc.pid) { try { process.kill(-proc.pid, signal); } catch {} } };
  const onSignal = () => stop('SIGTERM');
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  proc.stdout.pipe(out); proc.stderr.pipe(err);
  if (proc.pid) await save(log + '.process.json', { pid: proc.pid, process_group: proc.pid, started_at: new Date().toISOString(), command });
  let killTimer;
  const timer = setTimeout(() => { timedOut = true; stop('SIGTERM'); killTimer = setTimeout(() => stop('SIGKILL'), 3000); }, timeout);
  try {
    const result = await completion;
    await Promise.all([out, err].map(stream => stream.writableFinished ? undefined : new Promise((done, reject) => { stream.once('finish', done); stream.once('error', reject); })));
    return result;
  } finally {
    clearTimeout(timer); clearTimeout(killTimer);
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  }
}

async function step(command, args, options) {
  const result = await child(command, args, options);
  assert.ok(result.exit_code === 0 && !result.timed_out, 'Step failed; inspect ' + options.log + '.stderr.log');
}

export async function createEnvironment(options) {
  supportedNode();
  const root = options.root;
  const environmentId = randomUUID();
  const node = await toolIdentity(process.execPath), bun = await toolIdentity(await executable('bun'));
  const selectedGit = await toolIdentity(await executable('git'));
  // Use npm shipped with this Node, not a Volta/Proto executable shim as JavaScript.
  const npm = await realpath(join(dirname(node.path), 'npm'));
  assert.ok(npm.endsWith('.js'), 'The selected Node must provide its npm JavaScript entry');
  const pi = await findPi(options['pi-entry'], npm);
  await fresh(root);
  await mkdir(join(root, 'logs'));
  const repositories = {};
  for (const name of ['cli', 'broker']) {
    const repository = options[name + '-repository'] ?? DEFAULTS[name];
    assert.ok(!repository.startsWith('-'), 'Invalid repository');
    if (/^https?:/.test(repository)) { const url = new URL(repository); assert.ok(!url.username && !url.password, 'Do not put credentials in repository URLs'); }
    const ref = options[name + '-ref'] ?? 'next';
    assert.ok(!ref.startsWith('-'), 'Invalid ref');
    const path = join(root, name);
    await step('git', ['clone', '--no-hardlinks', '--no-checkout', '--', repository, path],
      { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, log: join(root, 'logs/clone-' + name) });
    const commit = git(path, 'rev-parse', '--verify', (ref.match(/^[a-f0-9]{40}$/) ? ref : 'origin/' + ref) + '^{commit}');
    const taskName = root.split(sep).at(-1).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60) || 'task';
    const branch = 'work/' + taskName + '-' + environmentId.slice(0, 8);
    await step('git', ['-C', path, 'switch', '-c', branch, commit],
      { cwd: root, env: process.env, log: join(root, 'logs/branch-' + name) });
    assert.equal(await realpath(join(path, '.git')), join(path, '.git'), 'Independent Git metadata is required');
    repositories[name] = { repository, ref, commit, branch, path };
  }
  const environment = { version: VERSION, kind: 'paired-development-environment', root,
    environment_id: environmentId, created_at: new Date().toISOString(), repositories,
    tools: { node: { ...node, version: process.version }, bun, git: selectedGit, npm, pi } };
  await save(join(root, 'environment.json'), environment);
  return { status: 'created', root, environment_id: environment.environment_id, repositories };
}

async function snapshot(source, destination) {
  const names = [...new Set(execFileSync('git', ['-C', source, 'ls-files', '-c', '-o', '--exclude-standard', '-z'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean))].sort();
  const commit = git(source, 'rev-parse', 'HEAD'), files = [];
  await mkdir(destination, { recursive: true });
  for (const name of names) {
    assert.ok(!isAbsolute(name) && !name.split('/').includes('..'));
    const path = join(source, name);
    let info;
    try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    assert.ok(info.isFile(), 'Source snapshots require ordinary files (no submodule/symlink): ' + name);
    const bytes = await readFile(path);
    files.push({ path: name, sha256: hash(bytes) });
    await mkdir(dirname(join(destination, name)), { recursive: true });
    await writeFile(join(destination, name), bytes, { mode: info.mode, flag: 'wx' });
  }
  for (const file of files) assert.equal(hash(await readFile(join(source, file.path))), file.sha256, 'Source changed while snapshotting: ' + file.path);
  assert.equal(git(source, 'rev-parse', 'HEAD'), commit, 'HEAD changed while snapshotting');
  const namesAfter = [...new Set(execFileSync('git', ['-C', source, 'ls-files', '-c', '-o', '--exclude-standard', '-z'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean))].sort();
  assert.deepEqual(namesAfter, names, 'Source file list changed while snapshotting');
  return { commit, branch: git(source, 'branch', '--show-current'), files, sha256: hash(JSON.stringify(files)) };
}

async function currentTools(environment) {
  supportedNode();
  const node = { ...await toolIdentity(process.execPath), version: process.version };
  const bun = await toolIdentity(await executable('bun'));
  const npm = await realpath(join(dirname(node.path), 'npm'));
  assert.ok(npm.endsWith('.js'), 'The current Node must provide its npm JavaScript entry');
  return { node, bun, git: await toolIdentity(await executable('git')), npm, pi: await findPi(environment.tools.pi.path, npm) };
}

/** Standard npm archives and fresh consumers; no wrapper or frozen-file substitution. */
export async function installPackedPair(root, tools, env) {
  const installRoot = join(root, 'installed'), archives = join(root, 'archives'), packages = {};
  await mkdir(installRoot); await mkdir(archives);
  for (const [role, name] of [['cli', 'ntn-skills'], ['broker', 'pi-context-broker']]) {
    const built = join(root, role), manifest = await json(join(built, 'package.json'));
    assert.equal(manifest.name, name);
    await step(tools.node.path, [tools.npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', archives],
      { cwd: built, env, log: join(root, 'logs/pack-' + role) });
    const packed = JSON.parse(await readFile(join(root, 'logs/pack-' + role + '.stdout.log'), 'utf8'));
    assert.equal(packed.length, 1); assert.equal(packed[0].name, name); assert.equal(packed[0].version, manifest.version);
    assert.ok(packed[0].filename && !packed[0].filename.includes('/') && packed[0].filename.endsWith('.tgz'));
    const archive = join(archives, packed[0].filename), consumer = join(installRoot, role);
    await mkdir(consumer);
    await save(join(consumer, 'package.json'), { private: true, dependencies: { [name]: 'file:' + archive } });
    await step(tools.node.path, [tools.npm, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: consumer, env, log: join(root, 'logs/install-packed-' + role) });
    const installed = join(consumer, 'node_modules', name);
    const closure = await verifyArchiveInstallation(installed, archive, hash(await readFile(archive)));
    for (const member of closure.files) assert.equal(hash(await readFile(join(built, member.path))), member.sha256,
      'Packed member differs from the selected build: ' + role + '/' + member.path);
    const actual = await json(join(installed, 'package.json'));
    assert.equal(actual.name, name); assert.equal(actual.version, manifest.version);
    const relativeEntry = role === 'cli' ? actual.bin?.['ntn-skills'] : actual.pi?.extensions?.[0];
    assert.ok(typeof relativeEntry === 'string', 'The installed package must declare its public entry');
    const entry = resolve(installed, relativeEntry);
    assert.ok(own(installed, entry)); await toolIdentity(entry);
    const sdkExport = actual.exports?.['./sdk'];
    const sdk = role === 'cli' ? resolve(installed, typeof sdkExport === 'string' ? sdkExport : sdkExport?.import ?? '') : join(installed, 'dist/ntn-skills-sdk.mjs');
    assert.ok(own(installed, sdk) && sdk !== installed, 'The installed CLI must export its SDK'); await toolIdentity(sdk);
    packages[role] = { name, version: actual.version, root: installed, entry, sdk, closure };
  }
  const notices = verifyBundledNotices({ selectedNoticesBytes: await readFile(join(packages.cli.root, 'THIRD_PARTY_NOTICES.md')),
    bundledNoticesBytes: await readFile(join(packages.broker.root, 'dist/NOTICES.txt')),
    expectedSha256: packages.cli.closure.files.find(file => file.path === 'THIRD_PARTY_NOTICES.md')?.sha256 });
  return { mode: 'packed', root: installRoot, packages, notices, tree: await inventory(installRoot), archives: await inventory(archives) };
}

export async function buildEnvironment(options) {
  const installMode = options['install-mode'] ?? 'directory';
  assert.ok(['directory', 'packed'].includes(installMode), '--install-mode must be directory or packed');
  const environment = await readEnvironment(options.root);
  environment.tools = await currentTools(environment);
  const buildId = validId(options.id ?? id('build')), root = join(options.root, 'builds', buildId);
  await fresh(root);
  await mkdir(join(root, 'logs')); await mkdir(join(root, 'cache'));
  const sources = {};
  try {
    for (const name of ['cli', 'broker']) sources[name] = await snapshot(join(options.root, name), join(root, 'source', name));
    const env = runtimeEnvironment(join(root, 'build-state'), root, process.env, options['pass-env'] ?? [], environment.tools.node.path);
    // Git authentication is not needed for the public locked dependency installs.
    for (const path of ['tmp', 'config', 'bin']) await mkdir(join(root, 'build-state', path), { recursive: true });
    await symlink(environment.tools.git.path, join(root, 'build-state/bin/git'));
    await writeFile(env.npm_config_userconfig, '', { flag: 'wx', mode: 0o600 });
    env.PATH = [join(root, 'build-state/bin'), dirname(environment.tools.node.path), dirname(environment.tools.bun.path), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);
    for (const name of ['cli', 'broker']) {
      await step(environment.tools.bun.path, ['install', '--frozen-lockfile', '--ignore-scripts', '--backend', 'copyfile', '--cache-dir', join(root, 'cache', name)],
        { cwd: join(root, 'source', name), env, log: join(root, 'logs/install-source-' + name) });
    }
    await step(environment.tools.bun.path, ['packages/cli/build.ts', '--outdir', join(root, 'cli')],
      { cwd: join(root, 'source/cli'), env, log: join(root, 'logs/build-cli') });
    const install = async name => step(environment.tools.node.path, [environment.tools.npm, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: join(root, name), env, log: join(root, 'logs/install-runtime-' + name) });
    await install('cli');
    await step(environment.tools.bun.path, ['run', '--cwd', 'packages/context-broker', 'typecheck'],
      { cwd: join(root, 'source/broker'), env, log: join(root, 'logs/typecheck-broker') });
    await step(environment.tools.bun.path, ['scripts/build-tern.mjs', '--target', 'broker', '--package-out', join(root, 'broker')],
      { cwd: join(root, 'source/broker'), env: { ...env, NTN_SKILLS_BUILD_ENTRY: join(root, 'cli/dist/ntn-skills.js') }, log: join(root, 'logs/build-broker') });
    await install('broker');
    const { verifyCurrentBuild } = await import(pathToFileURL(join(root, 'source/broker/scripts/verify-next-worktrees.mjs')));
    const { fileInventory, selectedCliInputs } = await import(pathToFileURL(join(root, 'source/broker/scripts/next-build-identity.mjs')));
    await verifyCurrentBuild(join(root, 'source/cli'), join(root, 'cli'), 'cli-build');
    const brokerReceipt = await verifyCurrentBuild(join(root, 'source/broker'), join(root, 'broker'), 'broker-build');
    assert.deepEqual(await fileInventory(join(root, 'cli'), selectedCliInputs), brokerReceipt.selected_cli,
      'The built Broker does not contain this generation\'s CLI/SDK');
    const candidate = installMode === 'packed' ? await installPackedPair(root, environment.tools, env) : { mode: 'directory' };
    const packages = {};
    for (const name of ['cli', 'broker']) packages[name] = await inventory(join(root, name));
    const sourceTree = await inventory(join(root, 'source'));
    await save(join(root, 'build.json'), { version: VERSION, kind: 'paired-build', environment_id: environment.environment_id,
      build_id: buildId, root, created_at: new Date().toISOString(), sources, packages,
      source_tree: sourceTree, selected_cli_sha256: brokerReceipt.selected_cli.sha256, tools: environment.tools, candidate,
      passed_environment_names: options['pass-env'] ?? [],
      launcher: await toolIdentity(fileURLToPath(import.meta.url)) });
    return { status: 'built', root, build_id: buildId, selected_cli_sha256: brokerReceipt.selected_cli.sha256 };
  } catch (error) {
    await save(join(root, 'failure.json'), { status: 'failed', error: error.message }); throw error;
  }
}

export async function checkEnvironment(options) {
  const environment = await readEnvironment(options.root), buildId = validId(options.build);
  const root = join(options.root, 'builds', buildId);
  assert.equal(await realpath(root), root, 'Build path is a symlink');
  const build = await json(join(root, 'build.json'));
  assert.equal(build.version, VERSION); assert.equal(build.kind, 'paired-build');
  assert.equal(build.environment_id, environment.environment_id); assert.equal(build.root, root); assert.equal(build.build_id, buildId);
  for (const name of ['cli', 'broker']) assert.equal((await inventory(join(root, name))).sha256, build.packages[name].sha256, 'Frozen package changed: ' + name);
  assert.equal((await inventory(join(root, 'source'))).sha256, build.source_tree.sha256, 'Frozen source/dependency snapshot changed');
  const selected = { cli: join(root, 'cli/dist/ntn-skills.js'), broker: join(root, 'broker/src/index.ts') };
  if (build.candidate?.mode === 'packed') {
    assert.equal(build.candidate.root, join(root, 'installed'));
    assert.equal((await inventory(build.candidate.root)).sha256, build.candidate.tree.sha256, 'Frozen installed candidate changed');
    assert.equal((await inventory(join(root, 'archives'))).sha256, build.candidate.archives.sha256, 'Frozen candidate archive changed');
    for (const [role, name] of [['cli', 'ntn-skills'], ['broker', 'pi-context-broker']]) {
      const candidate = build.candidate.packages[role], installed = join(root, 'installed', role, 'node_modules', name);
      assert.equal(candidate.root, installed); assert.equal(candidate.name, name);
      const manifest = await json(join(installed, 'package.json'));
      assert.equal(candidate.version, manifest.version);
      assert.equal(candidate.entry, resolve(installed, role === 'cli' ? manifest.bin['ntn-skills'] : manifest.pi.extensions[0]));
      assert.ok(own(installed, candidate.entry)); selected[role] = candidate.entry;
      for (const file of candidate.closure.files) assert.equal(hash(await readFile(join(installed, file.path))), file.sha256, 'Installed archive member changed: ' + file.path);
    }
  } else assert.ok(build.candidate === undefined || build.candidate.mode === 'directory', 'Unknown candidate installation mode');
  // Check pairing independently of the mutable checkout, using the sealed build receipt.
  const brokerReceipt = await json(join(root, 'broker/dist/next-build.json'));
  assert.equal(brokerReceipt.selected_cli.sha256, build.selected_cli_sha256);
  for (const file of brokerReceipt.selected_cli.files) {
    assert.ok(!isAbsolute(file.path) && !file.path.split('/').includes('..'));
    assert.equal(hash(await readFile(join(root, 'cli', file.path))), file.sha256, 'CLI/SDK pair was swapped: ' + file.path);
  }
  const currentHeads = {};
  for (const name of ['cli', 'broker']) currentHeads[name] = git(join(options.root, name), 'rev-parse', 'HEAD');
  return { status: 'passed', scope: 'isolated-development-artifacts', root, build_id: buildId,
    source_heads_at_build: Object.fromEntries(Object.entries(build.sources).map(([name, source]) => [name, source.commit])),
    current_source_heads: currentHeads, source_changes_invalidate_frozen_build: false,
    selected_cli_sha256: build.selected_cli_sha256, candidate_mode: build.candidate?.mode ?? 'directory', selected_entries: selected, actual_pi_process: 'not_run' };
}

function validUuid(value) { assert.match(value, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, 'Use a canonical Notion UUID'); return value; }

async function copyModels(path, destination, passNames) {
  assert.ok(isAbsolute(path), '--models must be absolute');
  const models = await json(path);
  function inspect(value, key = '') {
    if (['apiKey', 'accessToken', 'refreshToken', 'token'].includes(key)) {
      assert.ok(typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value) && passNames.includes(value), 'Model credentials must reference an explicitly passed environment variable');
    } else if (key === 'headers') assert.equal(Object.keys(value).length, 0, 'Use provider apiKey environment references, not credential headers');
    else if (typeof value === 'string') {
      assert.ok(!value.startsWith('!'), 'Shell configuration expressions are not allowed');
      if (/^https?:/.test(value)) { const url = new URL(value); assert.ok(!url.username && !url.password && !url.search, 'Model URLs must not contain credentials or query parameters'); }
    } else if (value && typeof value === 'object') for (const [name, child] of Object.entries(value)) inspect(child, name);
  }
  inspect(models); await save(destination, models);
}

// Used by the direct target and embedded verbatim in its private wrapper.
// An arbitrary command can still launch another executable; this is not a sandbox.
export function validatePiArguments(args) {
  const managed = new Set(['--session-dir', '--session', '-s', '--resume', '-r', '--continue', '-c', '--fork', '--session-id', '--no-session',
    '--extension', '-e', '--skill', '--no-skills', '-ns', '--no-extensions', '-ne',
    '--prompt-template', '--no-prompt-templates', '-np', '--theme', '--no-themes',
    '--no-context-files', '-nc', '--no-mcp', '--approve', '-a', '--no-approve', '-na']);
  for (const arg of args) {
    if (arg === '--') break;
    if (managed.has(arg.split('=')[0])) {
      throw new Error('Pi resource and session selection belongs to the isolated launcher; use its declared Pi inputs: ' + arg.split('=')[0]);
    }
  }
}

async function piLaunchDefinition(options, root, buildRoot, pi, selectedBroker = join(buildRoot, 'broker/src/index.ts')) {
  const mode = options['pi-mode'] ?? 'broker';
  assert.ok(['broker', 'native'].includes(mode), '--pi-mode must be broker or native');
  assert.ok(mode !== 'native' || options['native-skills'], 'Native Pi requires --native-skills');
  assert.ok(mode !== 'native' || !options.skills, '--skills is for Broker discovery; use --native-skills in native mode');
  assert.ok(mode !== 'broker' || !options['native-skills'], '--native-skills requires --pi-mode native');
  const nativeRoots = [];
  let nativeCorpus = null;
  if (options['native-skills']) {
    const source = options['native-skills'];
    assert.ok(isAbsolute(source) && (await stat(source)).isDirectory(), '--native-skills must be an absolute directory');
    const before = await inventory(source);
    const destination = join(root, 'skills/native');
    await copyTree(source, destination, before);
    const copied = await inventory(destination);
    for (const file of before.files) if (file.sha256) {
      assert.equal(copied.files.find(copy => copy.path === file.path)?.sha256, file.sha256, 'Native Skill copy differs: ' + file.path);
    }
    assert.equal((await inventory(source)).sha256, before.sha256, 'Native Skill input changed while copying');
    nativeRoots.push(destination);
    nativeCorpus = { source, source_sha256: before.sha256, root: destination, copied_sha256: copied.sha256 };
  }
  const extensions = [];
  if (mode === 'broker') extensions.push({ ...await toolIdentity(selectedBroker), role: 'broker' });
  for (const selected of options['pi-extension'] ?? []) {
    assert.ok(isAbsolute(selected), '--pi-extension must be an absolute file or directory');
    const path = await realpath(selected);
    assert.ok(mode !== 'native' || path !== selectedBroker && !own(join(buildRoot, 'broker'), path) && !own(join(buildRoot, 'installed/broker'), path), 'Native Pi cannot select the paired Broker as a common extension');
    assert.ok(!extensions.some(extension => extension.path === path), 'Repeated Pi extension: ' + path);
    const info = await stat(path);
    assert.ok(info.isFile() || info.isDirectory(), 'Pi extension must be an ordinary file or directory');
    const identity = info.isDirectory()
      ? { path, sha256: (await inventory(path)).sha256, identity_scope: 'declared_directory' }
      : { ...await toolIdentity(path), identity_scope: 'entry_file_only' };
    extensions.push({ ...identity, role: 'common' });
  }
  const settings = { packages: [], enableSkillCommands: mode === 'native' };
  const argv = ['--offline', '-ne', '-ns', '-nc', '--no-mcp', '--no-prompt-templates', '--no-approve',
    ...extensions.flatMap(extension => ['-e', extension.path]),
    ...nativeRoots.flatMap(path => ['--skill', path]), '--session-dir', join(root, 'sessions')];
  return { version: 1, mode, entry: pi.path, argv, settings, extensions,
    native_skill_roots: nativeRoots, native_corpus: nativeCorpus,
    observation_scope: 'declared launch inputs; actual resource loading requires a host observer' };
}

async function wrapper(path, node, entry, fixedArgs, validator) {
  const text = '#!' + node + '\n' +
    'const {spawn}=require("node:child_process");\n' +
    (validator ? '(' + validator.toString() + ')(process.argv.slice(2));\n' : '') +
    'const p=spawn(' + JSON.stringify(node) + ',' + JSON.stringify([entry, ...fixedArgs]) + '.concat(process.argv.slice(2)),{stdio:"inherit",env:process.env});\n' +
    'p.on("error",e=>{console.error(e.message);process.exitCode=1});p.on("exit",(code)=>{process.exitCode=code??1});\n';
  await writeFile(path, text, { mode: 0o700, flag: 'wx' });
}

export async function runEnvironment(options) {
  const environment = await readEnvironment(options.root);
  environment.tools = await currentTools(environment);
  const checked = await checkEnvironment(options), buildRoot = checked.root;
  assert.ok(['cli', 'pi', 'command'].includes(options.target), '--target must be cli, pi, or command');
  assert.ok(!options.entry || !options.parent, 'Select --entry or --parent, not both');
  if (options.entry) validUuid(options.entry); if (options.parent) validUuid(options.parent);
  const cwdChoice = options.cwd ?? 'workspace';
  assert.ok(['workspace', 'cli', 'broker'].includes(cwdChoice), '--cwd must be workspace, cli, or broker');
  assert.ok(options.target === 'command' || cwdChoice === 'workspace', '--cwd is only for command tests');
  if (options.target === 'pi') validatePiArguments(options.args);
  const timeout = Number(options['timeout-ms'] ?? 600_000);
  assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 3_600_000, 'Timeout must be 1..3600000 milliseconds');
  const stdin = options.stdin ?? 'ignore';
  assert.ok(['inherit', 'ignore'].includes(stdin), '--stdin must be inherit or ignore');
  const runId = validId(options.id ?? id('run')), root = join(options.root, 'runs', runId);
  await fresh(root);
  const env = runtimeEnvironment(root, buildRoot, process.env, options['pass-env'], environment.tools.node.path, checked.selected_entries);
  for (const path of ['bin', 'tmp', 'config/cli', 'state/cli', 'cache/cli', 'data/cli', 'state/scheduler', 'cache/broker',
    'xdg/config', 'xdg/state', 'xdg/cache', 'xdg/data', 'pi-agent', 'sessions', 'skills', 'workspace']) await mkdir(join(root, path), { recursive: true });
  await writeFile(env.npm_config_userconfig, '', { mode: 0o600, flag: 'wx' });
  await save(join(root, 'config/cli/config.json'), { sources: [] });
  const skillRoots = [];
  if (options.skills) {
    assert.ok(isAbsolute(options.skills), '--skills must be absolute');
    await inventory(options.skills); // Reject links into shared trees before copying.
    const destination = join(root, 'skills/selected');
    await cp(options.skills, destination, { recursive: true, dereference: true, errorOnExist: true, force: false });
    skillRoots.push(destination);
  }
  const sources = options.entry ? [{ id: 'notion', type: 'notion', namespace: 'notion', database: options.entry,
    cacheDir: join(root, 'cache/broker'), prefetch: false }] : [];
  const pi = environment.tools.pi;
  const piLaunch = await piLaunchDefinition(options, root, buildRoot, pi, env.PAIRED_BROKER_ENTRY);
  await save(env.CONTEXT_BROKER_CONFIG, { sources, skillRoots, extraSkillRoots: [], ruleRoots: [], discoveryCatalogs: [], extraDiscoveryCatalogs: [], requireAutoload: false });
  await save(join(root, 'pi-agent/settings.json'), piLaunch.settings);
  await save(join(root, 'pi-launch.json'), piLaunch);
  if (options.models) await copyModels(options.models, join(root, 'pi-agent/models.json'), options['pass-env']);
  if (options.entry) env.PAIRED_NOTION_ENTRY = options.entry;
  if (options.parent) env.PAIRED_NOTION_PARENT = options.parent;
  await symlink(environment.tools.bun.path, join(root, 'bin/bun'));
  await symlink(environment.tools.git.path, join(root, 'bin/git'));
  await wrapper(join(root, 'bin/ntn-skills'), environment.tools.node.path, env.PAIRED_CLI_ENTRY, []);
  await wrapper(join(root, 'bin/pi'), environment.tools.node.path, piLaunch.entry, piLaunch.argv, validatePiArguments);
  let command = environment.tools.node.path, args;
  if (options.target === 'cli') args = [env.PAIRED_CLI_ENTRY, ...options.args];
  else if (options.target === 'pi') args = [piLaunch.entry, ...piLaunch.argv, ...options.args];
  else {
    assert.ok(options.args.length, '--target command requires a command after --');
    [command, ...args] = options.args;
    if (command === 'node') command = environment.tools.node.path;
    else if (command === 'bun') command = environment.tools.bun.path;
    else if (command === 'ntn-skills' || command === 'pi' || command === 'git') command = join(root, 'bin', command);
  }
  if (options.target === 'command') {
    const build = await json(join(buildRoot, 'build.json'));
    await copyTree(join(buildRoot, 'source'), join(root, 'source'), build.source_tree);
    env.PAIRED_CLI_SOURCE = join(root, 'source/cli');
    env.PAIRED_BROKER_SOURCE = join(root, 'source/broker');
    env.CONTEXT_BROKER_GRAPH_CORE = join(env.PAIRED_CLI_SOURCE, 'packages/core/src');
    env.NTN_SKILLS_BUILD_ENTRY = env.PAIRED_CLI_ENTRY;
  }
  const cwd = cwdChoice === 'workspace' ? join(root, 'workspace') : join(root, 'source', cwdChoice);
  const runtimeSelection = { node: environment.tools.node.path, pi, bun: join(root, 'bin/bun'), git: join(root, 'bin/git'), env, cwd,
    launchers: { pi: join(root, 'bin/pi'), cli: join(root, 'bin/ntn-skills') },
    usage: { node: options.target === 'command' ? 'potential' : 'requested',
      pi: options.target === 'pi' ? 'requested' : options.target === 'command' ? 'potential' : 'not_requested',
      bun: options.target === 'command' ? 'potential' : 'not_requested', git: 'available' } };
  const runtime = await captureRuntimeIdentity(runtimeSelection);
  await save(join(root, 'run.json'), { version: VERSION, kind: 'isolated-development-run', environment_id: environment.environment_id,
    run_id: runId, root, build_id: options.build, build_root: buildRoot, target: options.target, cwd,
    runtime, pi_launch: piLaunch, candidate: { mode: checked.candidate_mode, entries: checked.selected_entries }, launcher: await toolIdentity(fileURLToPath(import.meta.url)),
    runtime_observer: await toolIdentity(fileURLToPath(new URL('./paired-runtime-identity.mjs', import.meta.url))), stdin,
    argument_sha256: hash(JSON.stringify(args)), passed_environment_names: options['pass-env'],
    remote: { entry: options.entry ?? null, parent: options.parent ?? null },
    paths: Object.fromEntries(Object.entries(env).filter(([name, value]) => name !== 'PATH' && typeof value === 'string' && own(root, value))) });
  const result = await child(command, args, { cwd, env, log: join(root, 'command'), timeout, stdin: stdin === 'inherit' });
  const runtimeAfter = await captureRuntimeIdentity(runtimeSelection);
  const runtimeCheck = { ...compareRuntimeIdentity(runtime, runtimeAfter), before: runtime, after: runtimeAfter };
  let artifactStatus = 'passed';
  try { await checkEnvironment(options); } catch { artifactStatus = 'changed'; }
  const receipt = { status: result.exit_code === 0 && !result.timed_out && artifactStatus === 'passed' && runtimeCheck.status === 'unchanged' ? 'passed' : 'failed',
    scope: 'isolated-development-run', root, run_id: runId, build_id: options.build,
    ...result, command_status: result.timed_out ? 'timed_out' : result.exit_code === 0 ? 'succeeded' : 'failed',
    runtime_check: runtimeCheck, frozen_artifacts: artifactStatus,
    actual_pi_process: options.target === 'pi' && result.spawned ? 'launched' : 'not_asserted',
    stdout: join(root, 'command.stdout.log'), stderr: join(root, 'command.stderr.log') };
  await save(join(root, 'result.json'), receipt);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(arg => ['--help', '-h'].includes(arg)) && process.argv.length <= 4) process.stdout.write(HELP);
  else {
    try {
      const options = parseArgs(process.argv.slice(2));
      const action = { create: createEnvironment, build: buildEnvironment, check: checkEnvironment, run: runEnvironment }[options.command];
      const result = await action(options); output(result);
      if (result.status === 'failed') process.exitCode = result.exit_code || 1;
    } catch (error) { output({ status: 'failed', error: error.message }); process.exitCode = 1; }
  }
}
