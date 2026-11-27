import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import {
  buildEnvironment, checkEnvironment, createEnvironment, installPackedPair, inventory, parseArgs, runEnvironment, runtimeEnvironment, seedBunCache, seedNpmCache, snapshotSource, validatePiArguments, verifySelectedCliPair,
} from './paired-environment.mjs';
import { fileInventory, selectedCliInputs } from './next-build-identity.mjs';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, value) => writeFile(path, JSON.stringify(value) + '\n');
const inside = (root, path) => path.startsWith(root + sep);
const legacyCliInputs = ['package.json', 'dist/ntn-skills.js', 'dist/sdk.js', 'skills'];
const selectedRefBytes = await readFile(new URL('../packages/context-broker/dist/ntn-skills-ref.cjs', import.meta.url));
const identitySource = await readFile(new URL('./next-build-identity.mjs', import.meta.url), 'utf8');
const legacyIdentitySource = identitySource.replace(/^export const selectedCliInputs = .*;\n/m, '');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 'Paired fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Paired fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
}).trim();

async function sourceRepository(root, name) {
  await mkdir(root, { recursive: true });
  git(root, 'init', '--initial-branch=next');
  await writeFile(join(root, 'README.md'), name + '\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'Local fixture');
  return git(root, 'rev-parse', 'HEAD');
}

// This is a sealed artifact fixture, not a mock of the checker. It contains
// executable CLI content, a Broker source entry, a binding receipt and real Git
// clones, so mutations exercise the public check/run contract end to end.
async function sealedBuild(root, buildId = 'fixture', realCliEntry) {
  const environment = await readJson(join(root, 'environment.json'));
  const buildRoot = join(root, 'builds', buildId);
  for (const path of ['cli/dist', 'cli/skills', 'broker/dist', 'broker/src', 'source/cli', 'source/broker/scripts']) {
    await mkdir(join(buildRoot, path), { recursive: true });
  }
  await writeJson(join(buildRoot, 'cli/package.json'), { name: 'paired-cli-fixture', version: '0.0.0', type: 'module' });
  await writeFile(join(buildRoot, 'cli/dist/ntn-skills.js'), realCliEntry
    ? 'import {spawnSync} from "node:child_process";\n' +
      'const result=spawnSync(process.execPath,[' + JSON.stringify(realCliEntry) +
      ',...process.argv.slice(2)],{stdio:"inherit",env:process.env});\n' +
      'if(result.error)console.error(result.error.message);process.exitCode=result.status??1;\n'
    : 'console.log(JSON.stringify({fixture:"cli",args:process.argv.slice(2)}));\n');
  await writeFile(join(buildRoot, 'cli/dist/sdk.js'), 'export const fixture = true;\n');
  await writeFile(join(buildRoot, 'cli/dist/management.js'), 'export const SOURCE_MATERIALIZATION_VERSION = 1;\n');
  await writeFile(join(buildRoot, 'cli/dist/ref.cjs'), selectedRefBytes);
  await writeFile(join(buildRoot, 'cli/skills/SKILL.md'), '# Fixture\n');
  await writeJson(join(buildRoot, 'broker/package.json'), { name: 'paired-broker-fixture', version: '0.0.0', type: 'module' });
  await writeFile(join(buildRoot, 'broker/src/index.ts'), 'export const fixture = true;\n');
  for (const name of ['cli', 'broker']) {
    await writeFile(join(buildRoot, 'source', name, 'README.md'), name + ' source snapshot\n');
  }
  await mkdir(join(buildRoot, 'source/broker/node_modules/fixture'), { recursive: true });
  await mkdir(join(buildRoot, 'source/broker/node_modules/.bin'), { recursive: true });
  await writeFile(join(buildRoot, 'source/broker/node_modules/fixture/index.js'), 'original dependency\n');
  await symlink('../fixture/index.js', join(buildRoot, 'source/broker/node_modules/.bin/fixture'));
  await writeFile(join(buildRoot, 'source/broker/scripts/next-build-identity.mjs'), legacyIdentitySource);
  const selectedCli = await fileInventory(join(buildRoot, 'cli'), legacyCliInputs);
  await writeJson(join(buildRoot, 'broker/dist/next-build.json'), { selected_cli: selectedCli });
  const packages = {};
  for (const name of ['cli', 'broker']) packages[name] = await inventory(join(buildRoot, name));
  await writeJson(join(buildRoot, 'build.json'), {
    version: 1, kind: 'paired-build', environment_id: environment.environment_id,
    build_id: buildId, root: buildRoot, selected_cli_sha256: selectedCli.sha256,
    sources: Object.fromEntries(['cli', 'broker'].map(name => [name, { commit: git(join(root, name), 'rev-parse', 'HEAD') }])),
    source_tree: await inventory(join(buildRoot, 'source')), packages, tools: environment.tools,
  });
  return buildRoot;
}

async function resealPair(root, selectedCli) {
  await writeJson(join(root, 'broker/dist/next-build.json'), { selected_cli: selectedCli });
  const build = await readJson(join(root, 'build.json'));
  build.selected_cli_sha256 = selectedCli.sha256;
  for (const name of ['cli', 'broker']) build.packages[name] = await inventory(join(root, name));
  build.source_tree = await inventory(join(root, 'source'));
  await writeJson(join(root, 'build.json'), build);
}

test('source snapshots omit only Broker historical results and retain independent complete selected files', async t => {
  const retained = await realpath(await mkdtemp(join(tmpdir(), 'paired-source-projection-test-')));
  t.diagnostic('Owned projection fixtures retained for system-Trash cleanup: ' + retained);
  const source = join(retained, 'source');
  const commit = await sourceRepository(source, 'Snapshot fixture');
  const inputs = {
    '.gitignore': 'ignored.txt\n',
    'benchmark/results/release/sentinel.json': 'tracked historical archive\n',
    'benchmark/results/untracked.json': 'untracked historical archive\n',
    'benchmark/results-extra/keep.mjs': 'export const nearby = true;\n',
    'benchmark/runtime/episode-runner.mjs': 'export const runtime = true;\n',
    'benchmark/runtime/nested/benchmark/results/keep.json': 'nested runtime input\n',
    'benchmark/projection.test.mjs': 'retained test source\n',
    'docs/runtime.md': 'retained documentation\n',
    'ignored.txt': 'ignored file\n',
  };
  for (const [name, content] of Object.entries(inputs)) {
    await mkdir(join(source, name, '..'), { recursive: true });
    await writeFile(join(source, name), content);
  }
  git(source, 'add', 'benchmark/results/release/sentinel.json');
  await chmod(join(source, 'benchmark/runtime/episode-runner.mjs'), 0o755);
  const destinations = ['first', 'second'].map(name => join(retained, name));
  const copies = await Promise.all(destinations.map(destination => snapshotSource(source, destination, 'broker')));
  const expected = ['README.md', ...Object.keys(inputs).filter(name => name !== 'ignored.txt' && !name.startsWith('benchmark/results/'))].sort();
  for (const [index, copy] of copies.entries()) {
    assert.equal(copy.commit, commit);
    assert.deepEqual(copy.projection, { version: 1, selection: 'git-tracked-and-nonignored-untracked', excluded_roots: ['benchmark/results'] });
    assert.deepEqual(copy.files.map(file => file.path), expected);
    assert.equal(copy.sha256, createHash('sha256').update(JSON.stringify(copy.files)).digest('hex'));
    for (const file of copy.files) assert.equal(createHash('sha256').update(await readFile(join(destinations[index], file.path))).digest('hex'), file.sha256);
    await assert.rejects(stat(join(destinations[index], 'benchmark/results')), { code: 'ENOENT' });
    assert.ok((await stat(join(destinations[index], 'benchmark/runtime/episode-runner.mjs'))).mode & 0o100);
  }
  assert.deepEqual(copies[0], copies[1]);
  await writeFile(join(destinations[0], 'benchmark/runtime/episode-runner.mjs'), 'private copy edit\n');
  assert.equal(await readFile(join(source, 'benchmark/runtime/episode-runner.mjs'), 'utf8'), inputs['benchmark/runtime/episode-runner.mjs']);
  assert.equal(await readFile(join(destinations[1], 'benchmark/runtime/episode-runner.mjs'), 'utf8'), inputs['benchmark/runtime/episode-runner.mjs']);
  await assert.rejects(snapshotSource(source, destinations[1], 'broker'), { code: 'EEXIST' });
  const cli = await snapshotSource(source, join(retained, 'cli-copy'), 'cli');
  assert.deepEqual(cli.projection.excluded_roots, []);
  assert.ok(cli.files.some(file => file.path === 'benchmark/results/release/sentinel.json'));
  assert.ok(cli.files.some(file => file.path === 'benchmark/results/untracked.json'));
  await writeFile(join(source, 'benchmark/runtime/episode-runner.mjs'), 'new source revision\n');
  await writeFile(join(source, 'benchmark/new-runtime.mjs'), 'new selected file\n');
  const changed = await snapshotSource(source, join(retained, 'new-revision'), 'broker');
  assert.notEqual(changed.sha256, copies[1].sha256);
  assert.ok(changed.files.some(file => file.path === 'benchmark/new-runtime.mjs'));
  assert.equal(await readFile(join(destinations[1], 'benchmark/runtime/episode-runner.mjs'), 'utf8'), inputs['benchmark/runtime/episode-runner.mjs']);
  await symlink('runtime/episode-runner.mjs', join(source, 'benchmark/linked-runtime'));
  await assert.rejects(snapshotSource(source, join(retained, 'linked-source'), 'broker'), /ordinary files/);
});

test('paired environments isolate writable state and detect artifact changes', async t => {
  const retained = await realpath(await mkdtemp(join(tmpdir(), 'paired-environment-test-')));
  t.diagnostic('Retained test fixtures (no permanent deletion): ' + retained);

  await t.test('runtime environment drops inherited credentials and redirects every application root', () => {
    const inherited = Object.freeze({
      HOME: '/Users/unchanged-home', USER: 'fixture', PATH: '/shared/bin',
      NOTION_API_TOKEN: 'fixture-secret', OPENAI_API_KEY: 'fixture-model-key',
      DEV_ROOT: '/shared/dev', NTN_SKILLS_DEV_ROOT: '/shared/cli',
      CONTEXT_BROKER_CONFIG: '/shared/broker.json', PI_CODING_AGENT_DIR: '/shared/pi',
      NODE_OPTIONS: '--require=/shared/inject.js', BASH_ENV: '/shared/profile',
      GIT_CONFIG_GLOBAL: '/shared/gitconfig', SSH_AUTH_SOCK: '/shared/ssh.sock',
      npm_config_userconfig: '/shared/npmrc', TMPDIR: '/shared/tmp',
      HTTPS_PROXY: 'http://proxy.example.invalid:3128', NODE_EXTRA_CA_CERTS: '/shared/trusted-ca.pem',
    });
    const runA = join(retained, 'run-a'), runB = join(retained, 'run-b');
    const envA = runtimeEnvironment(runA, join(retained, 'build-a'), inherited);
    const envB = runtimeEnvironment(runB, join(retained, 'build-b'), inherited);
    assert.equal(envA.HOME, inherited.HOME);
    assert.equal(inherited.PI_CODING_AGENT_DIR, '/shared/pi');
    for (const name of ['NOTION_API_TOKEN', 'OPENAI_API_KEY', 'DEV_ROOT', 'NTN_SKILLS_DEV_ROOT',
      'NODE_OPTIONS', 'BASH_ENV', 'GIT_CONFIG_GLOBAL', 'SSH_AUTH_SOCK']) assert.equal(envA[name], undefined, name);
    const privateRoots = ['NTN_SKILLS_CONFIG_HOME', 'NTN_SKILLS_HOME', 'NTN_SKILLS_CACHE_HOME',
      'NTN_SKILLS_DATA_HOME', 'NTN_SKILLS_SCHEDULER_ROOT', 'CONTEXT_BROKER_CONFIG',
      'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'XDG_CONFIG_HOME',
      'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'TMP', 'TEMP',
      'BUN_INSTALL_CACHE_DIR', 'npm_config_cache', 'npm_config_userconfig'];
    for (const name of privateRoots) {
      assert.ok(inside(runA, envA[name]), name + ' belongs to A');
      assert.ok(inside(runB, envB[name]), name + ' belongs to B');
      assert.notEqual(envA[name], envB[name], name);
    }
    assert.ok(!envA.PATH.split(':').includes('/shared/bin'));
    const explicit = runtimeEnvironment(runA, join(retained, 'build-a'), inherited, ['OPENAI_API_KEY']);
    assert.equal(explicit.OPENAI_API_KEY, inherited.OPENAI_API_KEY);
    assert.equal(explicit.NOTION_API_TOKEN, undefined);
    const network = runtimeEnvironment(runA, retained, inherited, ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS']);
    assert.equal(network.HTTPS_PROXY, inherited.HTTPS_PROXY);
    assert.equal(network.NODE_EXTRA_CA_CERTS, inherited.NODE_EXTRA_CA_CERTS);
    assert.equal(envA.HTTPS_PROXY, undefined);
    assert.equal(envA.NODE_EXTRA_CA_CERTS, undefined);
    for (const name of ['HOME', 'PATH', 'NODE_OPTIONS', 'BASH_ENV', 'NTN_SKILLS_DEV_ROOT',
      'PI_CODING_AGENT_DIR', 'GIT_CONFIG_GLOBAL', 'SSH_AUTH_SOCK']) {
      assert.throws(() => runtimeEnvironment(runA, retained, inherited, [name]), /Cannot override/);
    }
  });

  await t.test('argument boundary retains target flags but rejects ambiguous launcher options', () => {
    const parsed = parseArgs(['run', '--root', retained, '--build', 'b1', '--target', 'cli',
      '--pass-env', 'ONE', '--pass-env', 'TWO', '--', '--library', 'target-owned', '--help']);
    assert.deepEqual(parsed.args, ['--library', 'target-owned', '--help']);
    assert.deepEqual(parsed['pass-env'], ['ONE', 'TWO']);
    assert.throws(() => parseArgs(['run', '--root', retained, '--root', retained]), /Repeated/);
    assert.throws(() => parseArgs(['build', '--root', retained, '--latest', 'true']), /Unknown/);
    assert.throws(() => parseArgs(['check', '--root', 'relative']), /absolute/);
    assert.throws(() => parseArgs(['build', '--root', retained, '--', 'unexpected']), /Only run/);
    assert.deepEqual(parseArgs(['build', '--root', retained, '--pass-env', 'HTTPS_PROXY'])['pass-env'], ['HTTPS_PROXY']);
    for (const kind of ['bun', 'npm']) {
      assert.equal(parseArgs(['build', '--root', retained])[kind + '-cache-from'], undefined);
      assert.throws(() => parseArgs(['build', '--root', retained, '--' + kind + '-cache-from', retained]), /together/);
      assert.throws(() => parseArgs(['build', '--root', retained, '--' + kind + '-cache-sha256', 'a'.repeat(64)]), /together/);
      assert.throws(() => parseArgs(['build', '--root', retained, '--' + kind + '-cache-from', 'relative', '--' + kind + '-cache-sha256', 'a'.repeat(64)]), /absolute/);
      assert.throws(() => parseArgs(['build', '--root', retained, '--' + kind + '-cache-from', retained, '--' + kind + '-cache-sha256', 'bad']), /SHA-256/);
      assert.equal(parseArgs(['build', '--root', retained, '--' + kind + '-cache-from', retained, '--' + kind + '-cache-sha256', 'a'.repeat(64)])[kind + '-cache-sha256'], 'a'.repeat(64));
    }
  });

  await t.test('inventory detects executable/content changes and rejects external links', async () => {
    const root = join(retained, 'inventory'), outside = join(retained, 'outside');
    await mkdir(root); await mkdir(outside);
    await writeFile(join(root, 'entry.js'), 'original\n');
    const original = await inventory(root);
    await chmod(join(root, 'entry.js'), 0o700);
    assert.notEqual((await inventory(root)).sha256, original.sha256);
    await writeFile(join(root, 'entry.js'), 'changed\n');
    const changed = await inventory(root);
    assert.notEqual(changed.files[0].sha256, original.files[0].sha256);
    await symlink('entry.js', join(root, 'internal.js'));
    assert.ok((await inventory(root)).files.some(file => file.path === 'internal.js' && file.link === 'entry.js'));
    await writeFile(join(outside, 'shared.js'), 'shared\n');
    await symlink(join(outside, 'shared.js'), join(root, 'external.js'));
    await assert.rejects(inventory(root), /External symlink/);
  });

  const upstreamCli = join(retained, 'upstream-cli'), upstreamBroker = join(retained, 'upstream-broker');
  const commits = {
    cli: await sourceRepository(upstreamCli, 'CLI'),
    broker: await sourceRepository(upstreamBroker, 'Broker'),
  };
  const piPackage = join(retained, 'pi-fixture');
  await mkdir(piPackage);
  await writeJson(join(piPackage, 'package.json'), { name: '@earendil-works/pi-coding-agent', version: '0.0.0-fixture', type: 'module' });
  const piEntry = join(piPackage, 'cli.js');
  await writeFile(piEntry, 'if(process.argv.includes("--version"))console.log("0.0.0-fixture");' +
    'else console.log(JSON.stringify({fixture:"pi-launcher",args:process.argv.slice(2)}));\n');
  const roots = [join(retained, 'pair-a'), join(retained, 'pair-b')];
  const created = await Promise.all(roots.map(root => createEnvironment(parseArgs([
    'create', '--root', root, '--cli-repository', upstreamCli, '--broker-repository', upstreamBroker,
    '--pi-entry', piEntry, '--capacity-estimate-bytes', String(8 * 1024 * 1024),
  ]))));
  const [rootA, rootB] = roots;
  const [buildA, buildB] = await Promise.all(roots.map(root => sealedBuild(root)));

  await t.test('capacity policy blocks create, build and run before reserving their destination or launching work', async () => {
    const policy = join(retained, 'refusal-policy.json');
    await writeJson(policy, { version: 1, min_free_bytes: Number.MAX_SAFE_INTEGER });
    const denied = { 'capacity-policy': policy };
    const newRoot = join(retained, 'capacity-refused-create');
    await assert.rejects(createEnvironment({ root: newRoot, ...denied }), error => error.code === 'PAIRED_CAPACITY_REFUSED');
    await assert.rejects(stat(newRoot), { code: 'ENOENT' });
    await assert.rejects(buildEnvironment({ root: rootA, id: 'capacity-refused-build', ...denied }), error => error.code === 'PAIRED_CAPACITY_REFUSED');
    await assert.rejects(stat(join(rootA, 'builds/capacity-refused-build')), { code: 'ENOENT' });
    for (const source of ['copy', 'none']) {
      await assert.rejects(runEnvironment({ root: rootA, build: 'fixture', target: 'command', id: 'capacity-refused-' + source,
        'command-source': source, args: ['node', '-e', 'throw new Error("must not launch")'], ...denied }), error => error.code === 'PAIRED_CAPACITY_REFUSED');
      await assert.rejects(stat(join(rootA, 'runs/capacity-refused-' + source)), { code: 'ENOENT' });
    }
    assert.equal((await checkEnvironment({ root: rootA, build: 'fixture' })).status, 'passed');
  });

  await t.test('build capacity estimates use the same source projection as snapshots', async () => {
    const policy = join(retained, 'projection-refusal-policy.json');
    await writeJson(policy, { version: 1, min_free_bytes: Number.MAX_SAFE_INTEGER });
    const estimate = async () => {
      let bytes;
      await assert.rejects(buildEnvironment({ root: rootA, id: 'projection-capacity', 'capacity-policy': policy }), error => {
        assert.equal(error.code, 'PAIRED_CAPACITY_REFUSED');
        bytes = error.capacity.estimate.known_copy_bytes;
        return true;
      });
      await assert.rejects(stat(join(rootA, 'builds/projection-capacity')), { code: 'ENOENT' });
      return bytes;
    };
    const baseline = await estimate(), source = join(rootA, 'broker/benchmark');
    await mkdir(join(source, 'results'), { recursive: true });
    try {
      await writeFile(join(source, 'results/sentinel'), Buffer.alloc(1024 * 1024));
      assert.equal(await estimate(), baseline, 'Historical archive bytes are not a planned source copy');
      const runtime = 'export const retainedRuntime = true;\n';
      await writeFile(join(source, 'runtime.mjs'), runtime);
      assert.equal(await estimate(), baseline + Buffer.byteLength(runtime), 'Runtime input bytes remain in the capacity estimate');
    } finally { await rename(source, join(retained, 'projection-capacity-input')); }
  });

  await t.test('runtime-only commands retain private CLI/Pi launch and state without source or dependency copies', async () => {
    const skill = join(retained, 'runtime-only-native-skills'); await mkdir(skill);
    await writeFile(join(skill, 'SKILL.md'), '---\nname: runtime-fixture\ndescription: runtime fixture\n---\n# Selected runtime fixture\n');
    const payload = `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const run=process.env.PAIRED_RUN_ROOT;
if(fs.existsSync(path.join(run,'source')))throw new Error('Unexpected source copy');
for(const key of ['PAIRED_CLI_SOURCE','PAIRED_BROKER_SOURCE','CONTEXT_BROKER_GRAPH_CORE','NTN_SKILLS_BUILD_ENTRY'])if(process.env[key])throw new Error('Unexpected source binding '+key);
const cli=cp.spawnSync('ntn-skills',['--help'],{encoding:'utf8'});if(cli.status!==0)throw new Error(cli.stderr);
const pi=cp.spawnSync('pi',['--version'],{encoding:'utf8'});if(pi.status!==0)throw new Error(pi.stderr);
fs.writeFileSync(path.join(process.env.NTN_SKILLS_HOME,'owner'),run);
console.log(JSON.stringify({cwd:process.cwd(),state:process.env.NTN_SKILLS_HOME,cli:JSON.parse(cli.stdout),pi:pi.stdout.trim()}));`;
    const receipts = await Promise.all(['broker', 'native'].map((mode, index) => runEnvironment({ root: roots[index], build: 'fixture',
      target: 'command', id: 'runtime-only-' + mode, 'command-source': 'none', 'pi-mode': mode,
      ...(mode === 'native' ? { 'native-skills': skill } : {}), args: ['node', '-e', payload] })));
    for (const receipt of receipts) {
      assert.equal(receipt.status, 'passed');
      const record = await readJson(join(receipt.root, 'run.json'));
      assert.equal(record.command_source, 'none');
      assert.ok(record.capacity.estimated_additional_bytes < 1024, 'Runtime-only preparation must not include the frozen source tree');
      assert.equal(record.capacity.status, 'allowed');
      await assert.rejects(stat(join(receipt.root, 'source')), { code: 'ENOENT' });
      const result = await readJson(receipt.stdout);
      assert.equal(result.cwd, join(receipt.root, 'workspace'));
      assert.ok(inside(receipt.root, result.state));
      assert.deepEqual(result.cli.args, ['--help']);
      assert.equal(result.pi, '0.0.0-fixture');
      assert.equal(await readFile(join(result.state, 'owner'), 'utf8'), receipt.root);
    }
    for (const cwd of ['cli', 'broker']) await assert.rejects(runEnvironment({ root: rootA, build: 'fixture', target: 'command',
      'command-source': 'none', cwd, id: 'invalid-runtime-cwd-' + cwd, args: ['node', '--version'] }), /requires --cwd workspace/);
    await assert.rejects(runEnvironment({ root: rootA, build: 'fixture', target: 'cli', 'command-source': 'none', args: [] }), /only for command/);
    assert.equal((await checkEnvironment({ root: rootA, build: 'fixture' })).status, 'passed');
    assert.equal((await checkEnvironment({ root: rootB, build: 'fixture' })).status, 'passed');
  });

  await t.test('preparation failure preserves its phase and original error and never retries over the root', async () => {
    const broken = join(retained, 'broken-models.json'); await writeFile(broken, 'not JSON');
    const options = { root: rootA, build: 'fixture', target: 'command', 'command-source': 'none', id: 'failed-preparation', models: broken,
      args: ['node', '-e', 'throw new Error("must not launch")'] };
    await assert.rejects(runEnvironment(options), /JSON/);
    const failurePath = join(rootA, 'runs/failed-preparation/failure.json'), before = await readFile(failurePath, 'utf8');
    const failure = JSON.parse(before);
    assert.equal(failure.phase, 'run-preparation'); assert.match(failure.error, /JSON/);
    await assert.rejects(stat(join(rootA, 'runs/failed-preparation/command.process.json')), { code: 'ENOENT' });
    await assert.rejects(runEnvironment(options), /EEXIST/);
    assert.equal(await readFile(failurePath, 'utf8'), before);
  });

  await t.test('Broker Skill copies preserve internal links without duplicating bytes or exposing the input', async () => {
    const selected = join(retained, 'linked-skill-input'); await mkdir(selected);
    const skillText = '---\nname: linked-fixture\ndescription: linked input fixture\n---\nRead [fixture](alias/payload).\n';
    await writeFile(join(selected, 'SKILL.md'), skillText);
    await mkdir(join(selected, 'resources'));
    await writeFile(join(selected, 'resources/payload'), Buffer.alloc(65536, 42));
    await symlink('resources', join(selected, 'alias'));
    const payload = `const fs=require('node:fs'),path=require('node:path');
const selected=JSON.parse(fs.readFileSync(process.env.CONTEXT_BROKER_CONFIG)).skillRoots[0];
const alias=path.join(selected,'alias');
if(!fs.lstatSync(alias).isSymbolicLink())throw new Error('Skill target was duplicated');
if(fs.realpathSync(alias)!==path.join(selected,'resources'))throw new Error('Skill link escaped');
const referenced=path.join(selected,fs.readFileSync(path.join(selected,'SKILL.md'),'utf8').split('](')[1].split(')')[0]);
if(fs.readFileSync(referenced).length!==65536)throw new Error('Relative Skill reference failed');
fs.writeFileSync(referenced,'run-owned change');console.log('private skill link');`;
    const receipt = await runEnvironment({ root: rootA, build: 'fixture', target: 'command', id: 'linked-runtime-input',
      'command-source': 'none', skills: selected, args: ['node', '-e', payload] });
    assert.equal(receipt.status, 'passed');
    const capacity = await readJson(join(receipt.root, 'capacity.json'));
    assert.equal(capacity.estimated_additional_bytes, 65536 + Buffer.byteLength(skillText));
    assert.deepEqual(await readFile(join(selected, 'resources/payload')), Buffer.alloc(65536, 42));
  });

  await t.test('the caller-selected Git remains selected after the run PATH is isolated', async () => {
    const originalPath = process.env.PATH;
    const selected = (await readJson(join(rootA, 'environment.json'))).tools.git.path;
    const bin = join(retained, 'selected-git-bin'), calls = join(retained, 'selected-git-calls.jsonl');
    await mkdir(bin);
    const entry = join(bin, 'git');
    await writeFile(entry, '#!' + process.execPath + '\n' +
      'import {appendFileSync} from "node:fs"; import {spawnSync} from "node:child_process";\n' +
      'appendFileSync(' + JSON.stringify(calls) + ',JSON.stringify(process.argv.slice(2))+"\\n");\n' +
      'const r=spawnSync(' + JSON.stringify(selected) + ',process.argv.slice(2),{stdio:"inherit",env:process.env});process.exit(r.status??1);\n', { mode: 0o700 });
    let receipt;
    try {
      process.env.PATH = bin + ':' + originalPath;
      receipt = await runEnvironment({ root: rootA, build: 'fixture', target: 'command',
        id: 'caller-selected-git', 'pass-env': [], args: ['node', '-e',
          'const {execFileSync}=require("node:child_process");' +
          'execFileSync("git",["init","--initial-branch=fixture","owned-repository"],{stdio:"pipe"});' +
          'console.log(execFileSync("git",["-C","owned-repository","symbolic-ref","--short","HEAD"],{encoding:"utf8"}).trim());'] });
    } finally { process.env.PATH = originalPath; }
    assert.equal(receipt.status, 'passed');
    assert.equal((await readFile(receipt.stdout, 'utf8')).trim(), 'fixture');
    assert.equal(receipt.runtime_check.before.git.path, entry);
    assert.equal(receipt.runtime_check.after.git.path, entry);
    assert.equal(receipt.runtime_check.before.git.usage, 'available');
    assert.equal(await realpath(join(receipt.root, 'bin/git')), entry);
    const invoked = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(invoked.some(args => args[0] === 'init'), 'The actual target must use selected Git, not only its version probe');
    assert.equal(receipt.frozen_artifacts, 'passed');
  });

  await t.test('clones own refs, Git objects and editable files independently of other tasks', async () => {
    assert.notEqual(created[0].environment_id, created[1].environment_id);
    for (const name of ['cli', 'broker']) {
      const a = join(rootA, name), b = join(rootB, name);
      assert.equal(await realpath(join(a, '.git')), join(a, '.git'));
      assert.equal(await realpath(join(b, '.git')), join(b, '.git'));
      assert.notEqual(git(a, 'rev-parse', '--absolute-git-dir'), git(b, 'rev-parse', '--absolute-git-dir'));
      assert.equal(created[0].repositories[name].commit, commits[name]);
      const objectPath = join('.git', 'objects', commits[name].slice(0, 2), commits[name].slice(2));
      const upstream = name === 'cli' ? upstreamCli : upstreamBroker;
      const upstreamObject = await stat(join(upstream, objectPath)), cloneObject = await stat(join(a, objectPath));
      assert.notDeepEqual([upstreamObject.dev, upstreamObject.ino], [cloneObject.dev, cloneObject.ino], 'No shared writable Git object hardlinks');
      await writeFile(join(a, 'task-only.txt'), name + ' A change\n');
      git(a, 'add', 'task-only.txt'); git(a, 'commit', '-m', 'Advance only task A');
      assert.equal(git(b, 'rev-parse', 'HEAD'), commits[name]);
      assert.equal(git(upstream, 'rev-parse', 'HEAD'), commits[name]);
      assert.equal(git(b, 'status', '--porcelain'), '');
    }
    const checked = await checkEnvironment({ root: rootA, build: 'fixture' });
    assert.equal(checked.status, 'passed', 'Editable clone changes must not invalidate a frozen generation');
    assert.notEqual(checked.current_source_heads.cli, checked.source_heads_at_build.cli);
    await assert.rejects(checkEnvironment({ root: rootA }), /simple build\/run ID|type string/);
  });

  await t.test('selected CLI pairing accepts absent legacy export and the explicit management-inclusive input contract', async () => {
    await verifySelectedCliPair(buildA, await readJson(join(buildA, 'broker/dist/next-build.json')));
    const buildId = 'explicit-cli-inputs', root = await sealedBuild(rootA, buildId);
    await writeFile(join(root, 'cli/THIRD_PARTY_NOTICES.md'), 'Selected notice bytes\n');
    await writeFile(join(root, 'source/broker/scripts/next-build-identity.mjs'), identitySource);
    const selectedCli = await fileInventory(join(root, 'cli'), selectedCliInputs);
    await resealPair(root, selectedCli);
    await verifySelectedCliPair(root, { selected_cli: selectedCli });
    assert.equal((await checkEnvironment({ root: rootA, build: buildId })).status, 'passed');
    await assert.rejects(verifySelectedCliPair(root, { selected_cli: await fileInventory(join(root, 'cli'), legacyCliInputs) }), /complete selected CLI\/SDK/);
    await assert.rejects(verifySelectedCliPair(root, {
      selected_cli: await fileInventory(join(root, 'cli'), selectedCliInputs.filter(name => name !== 'dist/ref.cjs')),
    }), /complete selected CLI\/SDK/);
  });

  await t.test('selected CLI pairing does not fall back for null or incomplete explicit declarations', async () => {
    for (const [id, declaration] of [['null', null], ['missing-sdk', legacyCliInputs.filter(name => name !== 'dist/sdk.js')]]) {
      const root = await sealedBuild(rootA, 'invalid-cli-inputs-' + id);
      await writeFile(join(root, 'source/broker/scripts/next-build-identity.mjs'),
        legacyIdentitySource + '\nexport const selectedCliInputs = ' + JSON.stringify(declaration) + ';\n');
      const selectedCli = await fileInventory(join(root, 'cli'), declaration ?? legacyCliInputs);
      await assert.rejects(verifySelectedCliPair(root, { selected_cli: selectedCli }), /selected CLI input declaration|Selected CLI input declaration/);
    }
  });

  await t.test('ordinary checks reject omitted selected files and changed CLI bytes despite matching outer inventories', async () => {
    for (const action of ['omit-sdk', 'replace-sdk']) {
      const buildId = 'pairing-' + action, root = await sealedBuild(rootA, buildId);
      const selectedCli = action === 'omit-sdk'
        ? await fileInventory(join(root, 'cli'), legacyCliInputs.filter(name => name !== 'dist/sdk.js'))
        : (await readJson(join(root, 'broker/dist/next-build.json'))).selected_cli;
      if (action === 'replace-sdk') await writeFile(join(root, 'cli/dist/sdk.js'), 'export const replaced = true;\n');
      await resealPair(root, selectedCli);
      await assert.rejects(checkEnvironment({ root: rootA, build: buildId }), /complete selected CLI\/SDK/);
    }
  });

  for (const kind of ['bun', 'npm']) await t.test(kind + ' cache seed receipt remains bound without depending on the retained source cache', async () => {
    const buildId = kind + '-seed-receipt', root = await sealedBuild(rootA, buildId), receipt = join(root, kind + '-cache-seed.json');
    await writeJson(receipt, { source: { cache_root: '/unavailable/retired-build/cache' }, validation_scope: 'Fixture receipt' });
    const build = await readJson(join(root, 'build.json'));
    build[kind + '_cache_seed'] = { path: receipt, sha256: (await inventory(root)).files.find(file => file.path === kind + '-cache-seed.json').sha256 };
    await writeJson(join(root, 'build.json'), build);
    assert.equal((await checkEnvironment({ root: rootA, build: buildId })).status, 'passed');
    await writeJson(receipt, { source: { cache_root: '/changed-source/cache' } });
    await assert.rejects(checkEnvironment({ root: rootA, build: buildId }), /Cache seed receipt changed/);
  });

  await t.test('packed candidates run actual clean-installed entries and freeze archives and dependencies', async () => {
    const buildId = 'packed-candidate', root = await sealedBuild(rootA, buildId);
    await writeJson(join(root, 'cli/package.json'), { name: 'ntn-skills', version: '0.0.0', type: 'module',
      bin: { 'ntn-skills': './dist/ntn-skills.js' }, exports: { './sdk': { import: './dist/sdk.js' }, './management': { import: './dist/management.js' }, './ref': { require: './dist/ref.cjs' } } });
    await writeJson(join(root, 'broker/package.json'), { name: 'pi-context-broker', version: '0.0.0', type: 'module', pi: { extensions: ['./src/index.ts'] } });
    await writeFile(join(root, 'broker/dist/ntn-skills-sdk.mjs'), 'export const SDK_VERSION=3;\n');
    await writeFile(join(root, 'broker/dist/ntn-skills-management.mjs'), 'export const SOURCE_MATERIALIZATION_VERSION=1;\n');
    await writeFile(join(root, 'cli/THIRD_PARTY_NOTICES.md'), 'Complete selected CLI notice fixture\n');
    await writeFile(join(root, 'broker/dist/NOTICES.txt'), 'Other notices\nComplete selected CLI notice fixture\n');
    await writeFile(join(root, 'source/broker/scripts/next-build-identity.mjs'), identitySource);
    const selectedCli = await fileInventory(join(root, 'cli'), selectedCliInputs);
    await writeJson(join(root, 'broker/dist/next-build.json'), { selected_cli: selectedCli });
    await mkdir(join(root, 'logs')); await mkdir(join(root, 'build-state/config'), { recursive: true }); await mkdir(join(root, 'build-state/tmp'));
    const environment = await readJson(join(rootA, 'environment.json'));
    const env = runtimeEnvironment(join(root, 'build-state'), root, process.env, [], environment.tools.node.path);
    await writeFile(env.npm_config_userconfig, '');
    const candidate = await installPackedPair(root, environment.tools, env);
    const build = await readJson(join(root, 'build.json'));
    build.selected_cli_sha256 = selectedCli.sha256; build.candidate = candidate;
    for (const name of ['cli', 'broker']) build.packages[name] = await inventory(join(root, name));
    build.source_tree = await inventory(join(root, 'source'));
    await writeJson(join(root, 'build.json'), build);
    const checked = await checkEnvironment({ root: rootA, build: buildId });
    assert.equal(checked.candidate_mode, 'packed');
    assert.equal(checked.selected_entries.cli, join(root, 'installed/cli/node_modules/ntn-skills/dist/ntn-skills.js'));
    for (const target of ['cli', 'command']) {
      const receipt = await runEnvironment({ root: rootA, build: buildId, target, id: 'packed-' + target, 'pass-env': [],
        args: target === 'cli' ? ['--help'] : ['ntn-skills', '--help'] });
      assert.equal(receipt.status, 'passed'); assert.deepEqual((await readJson(receipt.stdout)).args, ['--help']);
      assert.deepEqual((await readJson(join(receipt.root, 'run.json'))).candidate.entries, checked.selected_entries);
    }
    const original = await readFile(checked.selected_entries.cli);
    await writeFile(checked.selected_entries.cli, 'throw new Error("replaced candidate")');
    await assert.rejects(checkEnvironment({ root: rootA, build: buildId }), /Frozen installed candidate changed/);
    await assert.rejects(runEnvironment({ root: rootA, build: buildId, target: 'cli', id: 'packed-must-not-start', 'pass-env': [], args: [] }), /Frozen installed candidate changed/);
    await writeFile(checked.selected_entries.cli, original);
    await writeFile(candidate.packages.cli.closure.archive.path, 'changed archive');
    await assert.rejects(checkEnvironment({ root: rootA, build: buildId }), /Frozen candidate archive changed/);
  });

  await t.test('concurrent runs own state, preserve HOME and refuse to reuse an occupied run', async () => {
    const payload = `const fs = require('node:fs'), path = require('node:path');
const names = ['NTN_SKILLS_HOME','NTN_SKILLS_CACHE_HOME','NTN_SKILLS_SCHEDULER_ROOT',
'PI_CODING_AGENT_DIR','PI_CODING_AGENT_SESSION_DIR','XDG_STATE_HOME','TMPDIR'];
const paths = Object.fromEntries(names.map(name => [name, process.env[name]]));
for (const dir of Object.values(paths)) { fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'owner'),process.env.PAIRED_RUN_ROOT); }
console.log(JSON.stringify({home:process.env.HOME,cwd:process.cwd(),paths,
cli:JSON.parse(fs.readFileSync(path.join(process.env.NTN_SKILLS_CONFIG_HOME,'config.json'))),
broker:JSON.parse(fs.readFileSync(process.env.CONTEXT_BROKER_CONFIG)),
pi:JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'settings.json')))}));`;
    const receipts = await Promise.all(roots.map(root => runEnvironment({
      root, build: 'fixture', target: 'command', id: 'same-id-in-distinct-environments',
      'pass-env': [], args: ['node', '-e', payload],
    })));
    const states = await Promise.all(receipts.map(receipt => readJson(receipt.stdout)));
    for (let index = 0; index < receipts.length; index++) {
      assert.equal(receipts[index].status, 'passed');
      const state = states[index], runRoot = receipts[index].root;
      assert.equal(state.home, process.env.HOME);
      assert.equal(state.cwd, join(runRoot, 'workspace'));
      assert.deepEqual(state.cli, {});
      assert.deepEqual(state.broker.sources, []);
      assert.deepEqual(state.broker.skillRoots, []);
      assert.deepEqual(state.pi.packages, []);
      for (const path of Object.values(state.paths)) {
        assert.ok(inside(runRoot, path));
        assert.equal(await readFile(join(path, 'owner'), 'utf8'), runRoot);
      }
    }
    for (const key of Object.keys(states[0].paths)) assert.notEqual(states[0].paths[key], states[1].paths[key]);
    const evidencePaths = ['run.json', 'result.json', 'command.stdout.log', 'command.stderr.log'];
    const before = await Promise.all(evidencePaths.map(path => readFile(join(receipts[0].root, path), 'utf8')));
    await assert.rejects(runEnvironment({
      root: rootA, build: 'fixture', target: 'cli', id: 'same-id-in-distinct-environments', 'pass-env': [], args: ['--help'],
    }), /EEXIST/);
    const after = await Promise.all(evidencePaths.map(path => readFile(join(receipts[0].root, path), 'utf8')));
    assert.deepEqual(after, before, 'Duplicate IDs must leave existing evidence untouched');
  });

  await t.test('concurrent source checks copy dependencies and remap internal links per run', async () => {
    const payload = `const fs = require('node:fs'), path = require('node:path');
const dependency = path.join(process.cwd(),'node_modules/.bin/fixture');
fs.writeFileSync('README.md',process.env.PAIRED_RUN_ROOT);
fs.writeFileSync(dependency,process.env.PAIRED_RUN_ROOT);
console.log(JSON.stringify({cwd:process.cwd(),source:process.env.PAIRED_BROKER_SOURCE,
dependency:fs.realpathSync(dependency),owner:fs.readFileSync(dependency,'utf8')}));`;
    const runs = await Promise.all(['copy-a', 'copy-b'].map(id => runEnvironment({
      root: rootA, build: 'fixture', target: 'command', cwd: 'broker', id,
      'pass-env': [], args: ['node', '-e', payload],
    })));
    const originalDependency = join(buildA, 'source/broker/node_modules/fixture/index.js');
    for (const receipt of runs) {
      assert.equal(receipt.status, 'passed');
      const result = await readJson(receipt.stdout);
      assert.equal(result.cwd, join(receipt.root, 'source/broker'));
      assert.equal(result.source, result.cwd);
      assert.ok(inside(receipt.root, result.dependency));
      assert.equal(result.owner, receipt.root);
      const original = await stat(originalDependency), copy = await stat(result.dependency);
      assert.notDeepEqual([original.dev, original.ino], [copy.dev, copy.ino], 'Runtime dependencies must not share writable hardlinks');
    }
    assert.equal(await readFile(originalDependency, 'utf8'), 'original dependency\n');
    assert.equal(await readFile(join(buildA, 'source/broker/README.md'), 'utf8'), 'broker source snapshot\n');
    assert.equal((await checkEnvironment({ root: rootA, build: 'fixture' })).status, 'passed');
  });

  await t.test('source copies keep independent bytes and modes when either side changes', async () => {
    const buildId = 'copy-write-isolation', root = await sealedBuild(rootA, buildId);
    const runs = await Promise.all(['copy-isolation-a', 'copy-isolation-b'].map(id => runEnvironment({
      root: rootA, build: buildId, target: 'command', id,
      'pass-env': [], args: ['node', '-e', 'console.log("source copy ready")'],
    })));
    for (const run of runs) assert.equal(run.status, 'passed');
    const original = join(root, 'source/broker/README.md');
    const copies = runs.map(run => join(run.root, 'source/broker/README.md'));
    const paths = [original, ...copies];
    const before = await Promise.all(paths.map(path => stat(path)));
    assert.equal(new Set(before.map(info => info.dev + ':' + info.ino)).size, paths.length);
    for (const path of paths) assert.equal(await readFile(path, 'utf8'), 'broker source snapshot\n');
    for (const info of before) assert.equal(info.mode, before[0].mode);

    await writeFile(copies[0], 'first run changes its copy\n');
    await chmod(copies[0], 0o600);
    assert.equal(await readFile(original, 'utf8'), 'broker source snapshot\n');
    assert.equal(await readFile(copies[1], 'utf8'), 'broker source snapshot\n');
    assert.equal((await stat(original)).mode, before[0].mode);
    assert.equal((await stat(copies[1])).mode, before[2].mode);
    assert.equal((await checkEnvironment({ root: rootA, build: buildId })).status, 'passed');

    // This dedicated fixture also proves reverse isolation and frozen-source rejection.
    await writeFile(original, 'frozen source mutation must be rejected\n');
    assert.equal(await readFile(copies[0], 'utf8'), 'first run changes its copy\n');
    assert.equal(await readFile(copies[1], 'utf8'), 'broker source snapshot\n');
    await assert.rejects(checkEnvironment({ root: rootA, build: buildId }), /Frozen source\/dependency snapshot changed/);
  });

  await t.test('a mutated build source dependency fails before any command launches', async () => {
    const buildId = 'source-dependency-mutation', root = await sealedBuild(rootA, buildId);
    await writeFile(join(root, 'source/broker/node_modules/fixture/index.js'), 'changed shared dependency\n');
    await assert.rejects(checkEnvironment({ root: rootA, build: buildId }), /Frozen source\/dependency snapshot changed/);
    await assert.rejects(runEnvironment({ root: rootA, build: buildId, target: 'command',
      id: 'must-not-start', 'pass-env': [], args: ['node', '-e', 'throw new Error("launched")'] }),
    /Frozen source\/dependency snapshot changed/);
    await assert.rejects(stat(join(rootA, 'runs/must-not-start')), { code: 'ENOENT' });
  });

  await t.test('run deadline selection preserves bounded defaults and starts no run timer for explicit none or null', async t => {
    let probeTimers;
    for (const [name, input, expected] of [
      ['default', undefined, 600_000], ['maximum', 3_600_000, 3_600_000],
      ['none', 'none', null], ['null', null, null],
    ]) {
      const options = parseArgs(['run', '--root', rootA, '--build', 'fixture', '--target', 'command',
        '--id', 'deadline-' + name, ...(typeof input === 'string' ? ['--timeout-ms', input] : []),
        '--', 'node', '-e', 'setTimeout(() => console.log("child completed"), 100)']);
      if (typeof input !== 'string') options['timeout-ms'] = input;
      const deadlines = [], realSetTimeout = globalThis.setTimeout;
      const timer = t.mock.method(globalThis, 'setTimeout', (...args) => {
        deadlines.push(args[1]);
        return realSetTimeout(...args);
      });
      let receipt;
      try { receipt = await runEnvironment(options); } finally { timer.mock.restore(); }
      assert.equal(receipt.status, 'passed', name);
      assert.equal(receipt.timed_out, false, name);
      assert.equal(receipt.timeout_ms, expected, name);
      assert.equal((await readJson(join(receipt.root, 'run.json'))).timeout_ms, expected, name);
      assert.equal((await readFile(receipt.stdout, 'utf8')).trim(), 'child completed', name);
      if (expected !== null) assert.equal(deadlines.filter(delay => delay === expected).length, 1,
        name + ' must install exactly the selected wall timer');
      const remaining = expected === null ? deadlines : deadlines.filter(delay => delay !== expected);
      if (name === 'default') probeTimers = remaining;
      else assert.deepEqual(remaining, probeTimers, name + ' must keep only the unchanged runtime probe timers');
    }
    for (const value of [0, '0', Infinity, 'Infinity', NaN, -1, 1.5, 3_600_001, '', 'null', 'None', true, false, [], {}]) {
      await assert.rejects(runEnvironment({ root: rootA, build: 'fixture', target: 'command',
        id: 'invalid-deadline', 'timeout-ms': value, 'pass-env': [], args: ['node', '-e', 'throw new Error("launched")'] }),
      /Timeout must be/);
    }
    await assert.rejects(stat(join(rootA, 'runs/invalid-deadline')), { code: 'ENOENT' });
  });

  await t.test('unbounded CLI runs reap owned signal-resistant descendants on SIGINT and SIGTERM', { timeout: 20_000 }, async t => {
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const sentinelClosed = new Promise(resolve => sentinel.once('close', resolve));
    const launchers = [], runRoots = [];
    t.after(async () => {
      for (const { process: launcher } of launchers) if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
      const groups = [];
      for (const runRoot of runRoots) {
        const owned = await readJson(join(runRoot, 'command.process.json')).catch(error => {
          if (error.code === 'ENOENT') return undefined; throw error;
        });
        if (owned) groups.push(owned.process_group);
      }
      for (const pid of [...groups, sentinel.pid]) {
        try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await Promise.all([sentinelClosed, ...launchers.map(item => item.closed)]);
    });
    await new Promise((resolve, reject) => { sentinel.once('spawn', resolve); sentinel.once('error', reject); });
    const alive = pid => {
      try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    const waitFor = async (read, message) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const value = await read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail(message);
    };
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const runId = 'unbounded-' + signal.toLowerCase(), runRoot = join(rootA, 'runs', runId);
      runRoots.push(runRoot);
      const payload = `const {spawn} = require('node:child_process'), fs = require('node:fs');
process.on('SIGTERM', () => {});
const descendant = spawn(process.execPath, ['-e',
  'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'],
  {stdio: ['ignore', 'pipe', 'inherit']});
descendant.stdout.once('data', () => {
  const ready = process.env.PAIRED_RUN_ROOT + '/descendant.json';
  fs.writeFileSync(ready + '.pending', JSON.stringify({pid: descendant.pid, parent: process.pid}));
  fs.renameSync(ready + '.pending', ready);
});
descendant.stdout.pipe(process.stdout);
setInterval(() => {}, 1000);`;
      const launcher = spawn(process.execPath, [new URL('./paired-environment.mjs', import.meta.url).pathname,
        'run', '--root', rootA, '--build', 'fixture', '--target', 'command', '--id', runId,
        '--timeout-ms', 'none', '--', 'node', '-e', payload], { stdio: ['ignore', 'pipe', 'pipe'] });
      const closed = new Promise((resolve, reject) => { launcher.once('close', (code, received) => resolve({ code, signal: received })); launcher.once('error', reject); });
      launchers.push({ process: launcher, closed });
      let stdout = '', stderr = '';
      launcher.stdout.on('data', data => { stdout += data; }); launcher.stderr.on('data', data => { stderr += data; });
      const descendant = await waitFor(() => readJson(join(runRoot, 'descendant.json')).catch(error => {
        if (error.code === 'ENOENT') return undefined; throw error;
      }), 'The actual owned descendant must become ready');
      const owned = await readJson(join(runRoot, 'command.process.json'));
      assert.equal(descendant.parent, owned.pid);
      assert.equal(launcher.kill(signal), true);
      const exit = await closed;
      assert.equal(exit.signal, null, stderr);
      assert.notEqual(exit.code, 0, stdout);
      const receipt = await readJson(join(runRoot, 'result.json'));
      assert.equal(receipt.timeout_ms, null);
      assert.equal(receipt.timed_out, false, 'Cancellation must not be relabelled as a deadline');
      assert.equal(receipt.signal, 'SIGKILL', 'A signal-resistant group must be reaped after the cancellation grace period');
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.frozen_artifacts, 'passed');
      assert.doesNotThrow(() => process.kill(sentinel.pid, 0), 'An unrelated owned sentinel must stay alive');
      await waitFor(() => !alive(descendant.pid) && !alive(owned.pid), 'The owned parent and descendant must not survive cancellation');
    }
  });

  await t.test('timeout reaps owned descendants after their parent exits without killing another process', { timeout: 5000 }, async t => {
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore',
    });
    const sentinelClosed = new Promise(resolve => sentinel.once('close', resolve));
    const runRoot = join(rootA, 'runs/parent-exits-before-descendant');
    t.after(async () => {
      // Both process groups originate in this test; never inspect or stop peers.
      try { process.kill(-sentinel.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await sentinelClosed;
      let owned;
      try { owned = await readJson(join(runRoot, 'command.process.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (owned) try { process.kill(-owned.process_group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    });
    await new Promise((resolve, reject) => { sentinel.once('spawn', resolve); sentinel.once('error', reject); });
    const payload = `const {spawn} = require('node:child_process'), fs = require('node:fs');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: ['ignore', 'inherit', 'inherit']
});
fs.writeFileSync(process.env.PAIRED_RUN_ROOT + '/descendant.json',
  JSON.stringify({pid: descendant.pid, parent: process.pid}));
descendant.unref();
process.exit(0);`;
    const receipt = await runEnvironment({
      root: rootA, build: 'fixture', target: 'command', id: 'parent-exits-before-descendant',
      'timeout-ms': '500', 'pass-env': [], args: ['node', '-e', payload],
    });
    assert.equal(receipt.timed_out, true, 'An exited parent must not cancel the deadline for descendants holding pipes');
    assert.equal(receipt.timeout_ms, 500);
    assert.equal(receipt.status, 'failed', 'A timeout must fail even when the parent exited zero');
    assert.equal(receipt.frozen_artifacts, 'passed');
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0), 'The unrelated process must stay alive');
    const descendant = await readJson(join(runRoot, 'descendant.json'));
    const alive = pid => {
      try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    // Allow the OS to reap the orphan before testing liveness.
    const deadline = Date.now() + 1000;
    while (alive(descendant.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(alive(descendant.pid), false, 'The owned descendant must not survive the timed-out invocation');
    assert.deepEqual(await readJson(join(runRoot, 'result.json')), receipt);
  });

  await t.test('a nonexistent executable returns and persists a structured failed result', { timeout: 5000 }, async () => {
    const receipt = await runEnvironment({
      root: rootB, build: 'fixture', target: 'command', id: 'missing-executable',
      'timeout-ms': '1000', 'pass-env': [], args: [join(retained, 'does-not-exist')],
    });
    assert.equal(receipt.status, 'failed');
    assert.notEqual(receipt.exit_code, 0);
    assert.equal(receipt.timed_out, false);
    assert.equal(receipt.frozen_artifacts, 'passed');
    assert.match(receipt.error, /ENOENT|no such file|not found/i);
    assert.deepEqual(await readJson(join(receipt.root, 'result.json')), receipt);
    assert.equal((await readJson(join(receipt.root, 'run.json'))).target, 'command');
  });

  await t.test('remote declarations preserve CLI arguments and configure the selected Broker source', async () => {
    const entry = '11111111-2222-3333-4444-555555555555';
    const receipt = await runEnvironment({ root: rootA, build: 'fixture', target: 'cli',
      id: 'entry', library: entry, 'pass-env': [], args: ['--help'] });
    assert.equal(receipt.status, 'passed');
    assert.deepEqual((await readJson(receipt.stdout)).args, ['--help']);
    const broker = await readJson(join(receipt.root, 'config/broker.json'));
    assert.equal(broker.sources[0].library, entry);
    assert.equal((await readJson(join(receipt.root, 'config/cli/config.json'))).default_library, entry);
    assert.ok(inside(receipt.root, broker.sources[0].cacheDir));
    assert.equal((await readJson(join(receipt.root, 'run.json'))).remote.library, entry);
    for (const [name, args] of [
      ['consume', ['list', '--library', entry, '--json']],
      ['read', ['read', 'selected-skill', '--library', entry, '--json']],
      ['manage', ['ctl', 'library', 'init', '--library', entry]],
    ]) {
      for (const target of ['cli', 'command']) {
        const result = await runEnvironment({ root: rootA, build: 'fixture', target,
          id: 'entry-' + name + '-' + target, library: entry, 'pass-env': [],
          args: target === 'cli' ? args : ['ntn-skills', ...args] });
        assert.equal(result.status, 'passed');
        assert.deepEqual((await readJson(result.stdout)).args, args);
      }
    }
    const declared = await runEnvironment({ root: rootA, build: 'fixture', target: 'command',
      id: 'entry-declaration', library: entry, 'pass-env': [], args: ['node', '-e',
        'console.log(JSON.stringify({entry:process.env.PAIRED_NOTION_LIBRARY}));'] });
    assert.equal((await readJson(declared.stdout)).entry, entry);
  });

  await t.test('a selected real CLI accepts consumption and management flags through both targets', {
    skip: !process.env.NTN_SKILLS_BUILD_ENTRY && 'Set NTN_SKILLS_BUILD_ENTRY to the selected packaged CLI entry',
  }, async () => {
    const entry = '11111111-2222-3333-4444-555555555555';
    const realCliEntry = await realpath(process.env.NTN_SKILLS_BUILD_ENTRY);
    const before = await readFile(realCliEntry);
    await sealedBuild(rootA, 'real-cli-parser', realCliEntry);
    // The fixture adapter calls the supplied product CLI with the run's empty
    // credentials and private state; the real parser, not argv echo, decides.
    for (const [name, args, help] of [
      ['help', ['--help'], /ntn-skills/],
      ['consume', ['list', '--library', entry, '--help'], /--library/],
      ['read', ['read', 'selected-skill', '--library', entry, '--help'], /--library/],
      ['manage', ['ctl', 'library', 'init', '--library', entry, '--help'], /--library/],
    ]) {
      for (const target of ['cli', 'command']) {
        const result = await runEnvironment({ root: rootA, build: 'real-cli-parser', target,
          id: 'real-entry-' + name + '-' + target, library: entry, 'pass-env': [],
          args: target === 'cli' ? args : ['ntn-skills', ...args] });
        assert.equal(result.status, 'passed', await readFile(result.stderr, 'utf8'));
        assert.match(await readFile(result.stdout, 'utf8'), help);
      }
    }
    assert.deepEqual(await readFile(realCliEntry), before, 'The selected product entry must stay unchanged');
  });

  await t.test('Pi flags stay within the selected run', async () => {
    const pi = await runEnvironment({ root: rootB, build: 'fixture', target: 'pi',
      id: 'pi-flags', 'pass-env': [], args: ['--help'] });
    const args = (await readJson(pi.stdout)).args;
    for (const flag of ['-ne', '-ns', '-nc', '--no-mcp', '--no-prompt-templates']) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf('-e') + 1], join(buildB, 'broker/src/index.ts'));
    assert.equal(args[args.indexOf('--session-dir') + 1], join(pi.root, 'sessions'));
    // The fixture proves launcher arguments only; actual Pi loading has a separate integration run.
  });

  await t.test('direct Pi and the private wrapper share declared broker/native launch inputs', async () => {
    const corpus = join(retained, 'native-corpus');
    await mkdir(corpus);
    await writeFile(join(corpus, 'SKILL.md'), '---\nname: local-fixture\ndescription: A selected fixture.\n---\n\nNative fixture body.\n');
    const extension = join(retained, 'common-observer.mjs');
    await writeFile(extension, 'export default function observer() {}\n');
    for (const mode of ['broker', 'native']) {
      for (const target of ['pi', 'command']) {
        const receipt = await runEnvironment({ root: rootB, build: 'fixture', target,
          id: 'declared-' + mode + '-' + target, 'pi-mode': mode,
          ...(mode === 'native' ? { 'native-skills': corpus } : { skills: corpus }),
          'pi-extension': [extension], 'pass-env': [], args: target === 'pi' ? ['--help'] : ['pi', '--help'] });
        assert.equal(receipt.status, 'passed');
        const run = await readJson(join(receipt.root, 'run.json'));
        const launch = await readJson(join(receipt.root, 'pi-launch.json'));
        assert.deepEqual(run.pi_launch, launch);
        const actual = await readJson(receipt.stdout);
        assert.deepEqual(actual.args, [...launch.argv, '--help']);
        assert.equal(launch.entry, piEntry);
        assert.equal(launch.mode, mode);
        assert.deepEqual(await readJson(join(receipt.root, 'pi-agent/settings.json')), launch.settings);
        assert.equal(launch.settings.enableSkillCommands, mode === 'native');
        assert.ok(launch.argv.includes('-ns'));
        assert.ok(launch.argv.includes('--no-approve'));
        assert.ok(launch.argv.includes(extension));
        assert.equal(launch.argv.includes(join(buildB, 'broker/src/index.ts')), mode === 'broker');
        assert.equal(launch.native_skill_roots.length, mode === 'native' ? 1 : 0);
        if (mode === 'native') {
          const copied = launch.native_skill_roots[0];
          assert.ok(inside(receipt.root, copied));
          assert.ok(launch.argv.includes(copied));
          assert.equal(await readFile(join(copied, 'SKILL.md'), 'utf8'), await readFile(join(corpus, 'SKILL.md'), 'utf8'));
          assert.deepEqual((await readJson(join(receipt.root, 'config/broker.json'))).skillRoots, []);
        }
        assert.equal(receipt.runtime_check.status, 'unchanged');
        assert.deepEqual(receipt.runtime_check.before, run.runtime);
        assert.equal(receipt.command_status, 'succeeded');
      }
    }
    for (const [suffix, extra, message] of [
      ['no-root', { 'pi-mode': 'native' }, /requires --native-skills/],
      ['ambiguous-root', { 'pi-mode': 'native', 'native-skills': corpus, skills: corpus }, /for Broker discovery/],
      ['wrong-mode', { 'native-skills': corpus }, /requires --pi-mode native/],
      ['broker-extension', { 'pi-mode': 'native', 'native-skills': corpus, 'pi-extension': [join(buildB, 'broker/src/index.ts')] }, /cannot select the paired Broker/],
    ]) await assert.rejects(runEnvironment({ root: rootB, build: 'fixture', target: 'pi',
      id: 'invalid-profile-' + suffix, 'pass-env': [], args: ['--help'], ...extra }), message);
  });

  await t.test('ordinary-derived inputs keep their order and private configuration while selecting the frozen Broker', async () => {
    const directory = join(retained, 'ordinary-resource-profile'); await mkdir(directory, { mode: 0o700 });
    const sha = bytes => createHash('sha256').update(bytes).digest('hex');
    const put = async (name, value) => {
      const path = join(directory, name), bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value) + '\n');
      await writeFile(path, bytes, { mode: 0o600 }); return { path, sha256: sha(bytes), bytes: bytes.length };
    };
    const first = await put('first.mjs', 'export default () => {};\n'), last = await put('last.mjs', 'export default () => {};\n');
    const native = await put('SKILL.md', '---\nname: ordinary-fixture\ndescription: Explicit native fixture.\n---\nBody.\n');
    const files = [first, last, native].map(({ path, ...item }) => ({ path: path.slice(directory.length + 1), ...item }));
    const closure = await put('closure.json', { schema_version: 1, root: directory, files, sha256: sha(JSON.stringify(files)) });
    const origin = await put('origin.json', { scope: 'synthetic ordinary resource identity' }), context = await put('AGENTS.md', 'Explicit context.\n');
    const mcp = await put('mcp.json', { mcpServers: {} }), privateConfig = await put('private-web.json', { fixtureApiKey: 'SYNTHETIC-ONLY-PRIVATE-KEY' });
    const selected = await put('profile.json', { schema_version: 1, kind: 'benchmark-ordinary-derived-resources', owner_root: retained,
      ordinary_source_refs: [origin], extension_order: [{ role: 'frozen', ...first, closure_ref: closure }, { role: 'selected-broker' }, { role: 'frozen', ...last, closure_ref: closure }],
      native_skills: [{ ...native, visible: true, closure_ref: closure }], context_files: [context], builtin_order: ['codemode', 'tool_search', 'mcp'],
      mcp_config: mcp, mcp_tools: [], agent_files: [{ ...privateConfig, relative_path: 'web-search.json', credential_paths: [['fixtureApiKey']] }],
      excluded_extensions: [{ path: join(directory, 'known-auto-write.mjs'), reason: 'Known lifecycle write omitted.' }],
      settings: { enableSkillCommands: true }, shared_differences: ['Observer first; CodeMode models:false; ToolSearch false.'],
      tool_policy: { allowed_tools: ['read', 'bash', 'codemode'], blocked_tools: ['tool_search'], blocked_parameters: [] } });
    const options = { root: rootB, build: 'fixture', target: 'command', 'command-source': 'none', 'pi-mode': 'broker',
      'resource-profile': selected.path, 'resource-profile-sha256': selected.sha256, 'pass-env': [], args: ['node', '-e', 'process.exit(0)'] };
    const receipt = await runEnvironment({ ...options, id: 'ordinary-profile' }); assert.equal(receipt.status, 'passed');
    const launch = await readJson(join(receipt.root, 'pi-launch.json'));
    assert.deepEqual(launch.extensions.map(item => item.path), [first.path, join(buildB, 'broker/src/index.ts'), last.path]);
    assert.equal(launch.extensions[1].role, 'broker'); assert.equal(launch.settings.enableSkillCommands, true); assert.deepEqual(launch.settings.packages, []);
    assert.deepEqual(launch.native_skill_paths, [native.path]); assert.deepEqual(launch.native_skill_roots, []);
    assert.equal(sha(await readFile(join(receipt.root, 'pi-agent/mcp.json'))), mcp.sha256);
    const privateCopy = join(receipt.root, 'pi-agent/web-search.json'); assert.equal(sha(await readFile(privateCopy)), privateConfig.sha256);
    assert.equal((await stat(privateCopy)).mode & 0o077, 0); assert.doesNotMatch(JSON.stringify(launch), /SYNTHETIC-ONLY-PRIVATE-KEY/);
    await assert.rejects(runEnvironment({ ...options, id: 'ordinary-profile-wrong-target', target: 'pi', 'command-source': undefined, args: ['--help'] }), /runtime-only Benchmark/);
    for (const invalid of [null, false, '']) await assert.rejects(runEnvironment({ ...options, id: 'ordinary-profile-invalid-reference', 'resource-profile': invalid }), /RESOURCE_PROFILE_CANONICAL_PATH/);
  });

  await t.test('resource and session overrides cannot diverge the direct and private Pi entries', async () => {
    for (const flag of ['-e', '--extension=/shared/observer.ts', '--skill', '--session-dir', '--continue', '--fork', '--fork=/shared/session.jsonl', '--session-id', '--no-session', '--approve']) {
      assert.throws(() => validatePiArguments([flag]), /belongs to the isolated launcher/);
    }
    validatePiArguments(['--provider', 'fixture', '-p', 'read the selected skill']);
    validatePiArguments(['-p', '--', '--skill']);
    await assert.rejects(runEnvironment({ root: rootB, build: 'fixture', target: 'pi',
      id: 'direct-override-rejected', 'pass-env': [], args: ['--fork', join(retained, 'foreign-session.jsonl')] }), /belongs to the isolated launcher/);
    const result = await runEnvironment({ root: rootB, build: 'fixture', target: 'command',
      id: 'wrapper-override-rejected', 'pass-env': [], args: ['pi', '--fork', join(retained, 'foreign-session.jsonl')] });
    assert.equal(result.status, 'failed');
    assert.equal(result.command_status, 'failed');
    assert.equal(result.runtime_check.status, 'unchanged');
    assert.match(await readFile(result.stderr, 'utf8'), /belongs to the isolated launcher/);
    assert.equal(await readFile(result.stdout, 'utf8'), '', 'Rejected before the Pi entry is called');
  });

  await t.test('the complete Broker package is sealed, including source additions and removals', async t => {
    for (const action of ['change', 'add', 'remove']) {
      await t.test(action, async () => {
        const buildId = 'mutation-' + action, root = await sealedBuild(rootA, buildId);
        const entry = join(root, 'broker/src/index.ts');
        if (action === 'change') await writeFile(entry, 'export const changed = true;\n');
        if (action === 'add') await writeFile(join(root, 'broker/src/extra.ts'), 'export {};\n');
        if (action === 'remove') await rename(entry, join(retained, 'removed-broker-entry.ts'));
        await assert.rejects(checkEnvironment({ root: rootA, build: buildId }), /Frozen package changed: broker/);
      });
    }
  });

  await t.test('shared tool upgrades do not invalidate historical environment metadata', async () => {
    const environmentPath = join(rootB, 'environment.json');
    const originalBytes = await readFile(environmentPath, 'utf8');
    await writeFile(join(rootB, 'environment.initial.json'), originalBytes, { flag: 'wx' });
    const historical = JSON.parse(originalBytes);
    historical.tools.node = { path: join(retained, 'removed-node-version'), version: 'v0.0.0', sha256: '0'.repeat(64) };
    historical.tools.bun = { path: join(retained, 'removed-bun-version'), sha256: '0'.repeat(64) };
    historical.tools.npm = join(retained, 'removed-npm-version.js');
    historical.tools.pi.version = '0.0.0-historical';
    await writeJson(environmentPath, historical);
    const historicalBytes = await readFile(environmentPath, 'utf8');
    const buildBytes = await readFile(join(buildB, 'build.json'), 'utf8');
    const receipt = await runEnvironment({
      root: rootB, build: 'fixture', target: 'command', id: 'upgraded-shared-tools',
      'pass-env': [], args: ['node', '-e', `console.log(JSON.stringify({
        execPath:process.execPath, version:process.version,
        bun:require('node:child_process').execFileSync('bun',['--version'],{encoding:'utf8'}).trim()
      }));`],
    });
    assert.equal(receipt.status, 'passed', 'Removed historical Node/Bun paths must not block a maintained shared toolchain');
    const actual = await readJson(receipt.stdout);
    assert.equal(actual.execPath, process.execPath);
    assert.equal(actual.version, process.version);
    assert.equal(actual.bun, execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim());
    const run = await readJson(join(receipt.root, 'run.json'));
    assert.equal(run.runtime.node.path, await realpath(process.execPath));
    assert.equal(run.runtime.node.version, process.version);
    assert.match(run.runtime.node.sha256, /^[a-f0-9]{64}$/);
    assert.equal(run.runtime.pi.path, await realpath(piEntry));
    assert.equal(run.runtime.pi.version, '0.0.0-fixture');
    assert.equal(run.runtime.pi.package_manifest.path, join(piPackage, 'package.json'));
    assert.equal(await readFile(environmentPath, 'utf8'), historicalBytes, 'Runs must preserve creation-time tool metadata');
    assert.equal(await readFile(join(rootB, 'environment.initial.json'), 'utf8'), originalBytes);
    assert.equal(await readFile(join(buildB, 'build.json'), 'utf8'), buildBytes, 'Running with current tools must not rewrite a frozen build receipt');
  });

  await t.test('run results retain successful command output when a selected runtime changes or becomes unavailable', async () => {
    const original = await readFile(piEntry);
    const saved = join(piPackage, 'retained-unavailable-entry.js');
    try {
      const drift = await runEnvironment({ root: rootB, build: 'fixture', target: 'command',
        id: 'runtime-file-drift', 'pass-env': [], args: ['node', '-e',
          'require("node:fs").appendFileSync(' + JSON.stringify(piEntry) + ',"// owned drift probe\\n");console.log("product completed");'] });
      assert.equal(drift.exit_code, 0);
      assert.equal(drift.command_status, 'succeeded');
      assert.equal(drift.status, 'failed');
      assert.equal(drift.runtime_check.status, 'drifted');
      assert.equal(drift.frozen_artifacts, 'passed');
      assert.equal(await readFile(drift.stdout, 'utf8'), 'product completed\n');
      assert.deepEqual(await readJson(join(drift.root, 'result.json')), drift);
      await writeFile(piEntry, original);
      const unknown = await runEnvironment({ root: rootB, build: 'fixture', target: 'command',
        id: 'runtime-end-unavailable', 'pass-env': [], args: ['node', '-e',
          'require("node:fs").renameSync(' + JSON.stringify(piEntry) + ',' + JSON.stringify(saved) + ');console.log("product completed");'] });
      assert.equal(unknown.exit_code, 0);
      assert.equal(unknown.command_status, 'succeeded');
      assert.equal(unknown.status, 'failed');
      assert.equal(unknown.runtime_check.status, 'unknown');
      assert.equal(await readFile(unknown.stdout, 'utf8'), 'product completed\n');
      assert.deepEqual(await readJson(join(unknown.root, 'result.json')), unknown);
    } finally {
      await writeFile(piEntry, original);
    }
  });

  await t.test('a sealed package cannot be replaced by an external directory symlink', async () => {
    const buildId = 'external-package-root', root = await sealedBuild(rootA, buildId);
    const external = join(retained, 'borrowed-broker-package');
    await rename(join(root, 'broker'), external);
    await symlink(external, join(root, 'broker'), 'dir');
    await assert.rejects(checkEnvironment({ root: rootA, build: buildId }),
      /symlink|canonical|outside|external/i);
  });
});

for (const kind of ['bun', 'npm']) test(kind + ' cache seeding copies only pinned idle local inputs into an independent cache', async t => {
  const seed = kind === 'bun' ? seedBunCache : seedNpmCache;
  const retained = await realpath(await mkdtemp(join(tmpdir(), 'paired-cache-test-')));
  t.diagnostic('Retained cache fixtures (no permanent deletion): ' + retained);
  async function fixture(name, live = false) {
    const base = join(retained, name), source = join(base, 'prior/builds/source'), target = join(base, 'next/builds/target');
    for (const [environment, build] of [[join(base, 'prior'), source], [join(base, 'next'), target]]) {
      await mkdir(join(build, 'logs'), { recursive: true });
      await writeJson(join(environment, 'environment.json'), { version: 1, kind: 'paired-development-environment', root: environment, environment_id: environment });
      for (const role of ['cli', 'broker']) {
        await mkdir(join(build, 'source', role), { recursive: true });
        await writeFile(join(build, 'source', role, 'bun.lock'), role + (build === target && role === 'broker' ? '-new-lock\n' : '-same-lock\n'));
      }
    }
    const cache = join(source, 'build-state/cache', kind), destination = join(target, 'build-state/cache', kind);
    await mkdir(join(cache, 'package@1@@@1/node_modules/nested'), { recursive: true });
    await mkdir(join(cache, 'package'));
    await writeFile(join(cache, 'package@1@@@1/index.js'), 'local cache bytes\n', { mode: 0o700 });
    await writeFile(join(cache, 'package@1@@@1/node_modules/nested/index.js'), 'nested dependency\n');
    await symlink(join(cache, 'package@1@@@1'), join(cache, 'package/1.0.0'));
    const started = new Date().toISOString();
    const child = spawn(process.execPath, ['-e', live ? 'setInterval(() => {}, 1000)' : ''], { detached: true, stdio: 'ignore' });
    const closed = new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    await writeJson(join(source, 'logs/install-source-cli.process.json'), { pid: child.pid, process_group: child.pid, started_at: started, command: process.execPath });
    if (!live) await closed;
    await writeJson(join(source, 'failure.json'), { status: 'failed', error: 'Retained failure after dependency work' });
    return { source, target, cache, destination, selected: await inventory(cache), child, closed };
  }

  await t.test('absolute internal aliases relocate; nested node_modules and executable bytes remain independent', async () => {
    const f = await fixture('copy');
    const ref = await seed(f.source, f.target, f.selected.sha256), receipt = await readJson(ref.path);
    const copied = await inventory(f.destination);
    assert.equal(receipt.kind, 'paired-' + kind + '-cache-seed');
    assert.equal(receipt.source.inventory_sha256, f.selected.sha256);
    assert.equal(receipt.target.inventory_sha256, copied.sha256);
    assert.equal(receipt.normalized_source_sha256, copied.sha256);
    assert.notEqual(copied.sha256, f.selected.sha256, 'Absolute source links change spelling when relocated');
    assert.deepEqual(await inventory(f.cache), f.selected);
    assert.equal(receipt.source.terminal.status, 'failed');
    assert.equal(receipt.source.processes[0].state, 'exited');
    assert.equal(receipt.locks.cli.identical, true); assert.equal(receipt.locks.broker.identical, false);
    assert.match(receipt.validation_scope, /not archive SRI/);
    assert.deepEqual(receipt.symlink_mappings, [{ path: 'package/1.0.0', source_target: join(f.cache, 'package@1@@@1'), target: '../package@1@@@1' }]);
    assert.equal(await readlink(join(f.destination, 'package/1.0.0')), '../package@1@@@1');
    assert.equal(await realpath(join(f.destination, 'package/1.0.0')), join(f.destination, 'package@1@@@1'));
    assert.equal(await readFile(join(f.destination, 'package@1@@@1/node_modules/nested/index.js'), 'utf8'), 'nested dependency\n');
    const original = join(f.cache, 'package@1@@@1/index.js'), duplicate = join(f.destination, 'package@1@@@1/index.js');
    assert.notEqual((await stat(original)).ino, (await stat(duplicate)).ino);
    assert.equal((await stat(duplicate)).mode & 0o111, 0o100);
    await assert.rejects(seed(f.source, f.target, f.selected.sha256), /EEXIST/);
    await writeFile(duplicate, 'private changed bytes\n'); await chmod(duplicate, 0o600);
    assert.equal(await readFile(original, 'utf8'), 'local cache bytes\n');
    assert.deepEqual(await inventory(f.cache), f.selected);
  });

  await t.test('an incorrect pinned hash fails before reserving the target cache', async () => {
    const f = await fixture('wrong-hash');
    await assert.rejects(seed(f.source, f.target, '0'.repeat(64)), /selected SHA-256/);
    await assert.rejects(stat(f.destination), { code: 'ENOENT' });
  });

  await t.test('cache links outside the selected cache are refused', async () => {
    const f = await fixture('external-link');
    await symlink(join(f.source, 'source/cli/bun.lock'), join(f.cache, 'outside'));
    await assert.rejects(seed(f.source, f.target, f.selected.sha256), /External symlink/);
    await assert.rejects(stat(f.destination), { code: 'ENOENT' });
  });

  await t.test('a terminal marker cannot hide a still-running recorded writer', async () => {
    const f = await fixture('active-writer', true);
    try {
      await assert.rejects(seed(f.source, f.target, f.selected.sha256), /active recorded process group/);
      await assert.rejects(stat(f.destination), { code: 'ENOENT' });
    } finally {
      try { process.kill(-f.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await f.closed;
    }
  });

  await t.test('unfinished sources, unrelated directories and terminal targets are refused', async () => {
    const f = await fixture('boundaries');
    await rename(join(f.source, 'failure.json'), join(f.source, 'retained-failure.json'));
    await assert.rejects(seed(f.source, f.target, f.selected.sha256), /terminal build/);
    await assert.rejects(seed(f.cache, f.target, f.selected.sha256), /paired build/);
    await writeJson(join(f.target, 'failure.json'), { status: 'failed' });
    await assert.rejects(seed(f.source, f.target, f.selected.sha256), /terminal build/);
    await assert.rejects(stat(f.destination), { code: 'ENOENT' });
  });
});
