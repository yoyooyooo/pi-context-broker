import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fileInventory, selectedCliInputs } from './next-build-identity.mjs';
import { verifyCurrentBuild, verifyNextWorktreePair } from './verify-next-worktrees.mjs';
import { aggregateDailyDeliveries, validateDailyLibraryRequests, validateDailyReceipt } from './verify-pi-daily-installation.mjs';

const save = (path, value) => writeFile(path, JSON.stringify(value) + '\n');
const selectedRefBytes = await readFile(new URL('../packages/context-broker/dist/ntn-skills-ref.cjs', import.meta.url));
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
test('help is read-only and needs no config, checkout or PATH tools', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'next-worktree-help-'));
  for (const flag of ['--help', '-h']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./verify-next-worktrees.mjs', import.meta.url)), flag], {
      cwd, env: { ...process.env, PATH: cwd }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /--config ABSOLUTE_CONFIG\.json/);
    assert.match(result.stdout, /worktrees\.cli.*worktrees\.broker/);
    assert.match(result.stdout, /real origin\/next/);
    assert.match(result.stdout, /actual_pi_process:not_run/);
    assert.match(result.stdout, /does not.*launch Pi/i);
  }
  assert.deepEqual(await readdir(cwd), []);
});

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
    const origin = join(parent, basename(root) + '-origin.git');
    git(parent, 'init', '--bare', '--initial-branch=next', origin);
    git(root, 'remote', 'add', 'origin', origin);
  }
  await mkdir(join(cliRoot, 'skills'));
  await writeFile(join(cliRoot, 'skills/SKILL.md'), 'current skill\n');
  await writeFile(join(cliRoot, 'dist/ntn-skills.js'), 'current CLI\n');
  await writeFile(join(cliRoot, 'dist/sdk.js'), 'current SDK\n');
  await writeFile(join(cliRoot, 'dist/ref.cjs'), selectedRefBytes);
  await writeFile(join(cliRoot, 'THIRD_PARTY_NOTICES.md'), 'current complete third-party notices\n');
  await writeFile(join(brokerRoot, 'dist/ntn-skills-sdk.mjs'), 'embedded current SDK\n');
  async function cliBuild() {
    await save(join(cliRoot, 'dist/next-build.json'), { version: 1, kind: 'cli-build', input_roots: ['src'],
      source: await fileInventory(cli, ['src']), artifacts: await fileInventory(cliRoot, ['dist/ntn-skills.js', 'dist/sdk.js', 'dist/ref.cjs', 'skills']) });
  }
  await cliBuild();
  await save(join(brokerRoot, 'dist/next-build.json'), { version: 1, kind: 'broker-build', input_roots: ['src'],
    source: await fileInventory(broker, ['src']), artifacts: await fileInventory(brokerRoot, ['dist/ntn-skills-sdk.mjs']),
    selected_cli: await fileInventory(cliRoot, selectedCliInputs) });
  function commit(root) {
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Next gate fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
    git(root, 'push', 'origin', 'next');
    return git(root, 'rev-parse', 'HEAD');
  }
  const config = { cliRoot, brokerRoot, worktrees: { cli: { root: cli, commit: commit(cli) }, broker: { root: broker, commit: commit(broker) } } };
  return { parent, cli, broker, cliRoot, brokerRoot, config, commit, cliBuild };
}
test('source and paired builds pass without claiming a real Pi launch', async () => {
  const f = await fixture(), result = await verifyNextWorktreePair(f.config);
  assert.equal(result.status, 'passed'); assert.equal(result.actual_pi_process, 'not_run');
  assert.equal(result.cli.commit, f.config.worktrees.cli.commit);
  assert.equal(result.version, 2);
  assert.match(result.machine?.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(result.machine).sort(), ['platform', 'scheme', 'sha256']);
  assert.deepEqual(result.machine, (await verifyNextWorktreePair(f.config)).machine);
  assert.equal(result.cli.origin_next, result.cli.commit);
});
test('an old target and unchanged local origin tracking ref cannot conceal a newer remote next', async () => {
  const f = await fixture(), old = f.config.worktrees.cli.commit;
  const actor = join(f.parent, 'other-machine');
  git(f.parent, 'clone', '--branch', 'next', git(f.cli, 'remote', 'get-url', 'origin'), actor);
  await writeFile(join(actor, 'src/current.ts'), 'export const version = 2;\n');
  const latest = f.commit(actor);
  assert.notEqual(latest, old);
  assert.equal(git(f.cli, 'rev-parse', 'HEAD'), old);
  assert.equal(git(f.cli, 'rev-parse', 'refs/remotes/origin/next'), old);
  await assert.rejects(verifyNextWorktreePair(f.config), /origin\/next.*target/);
});
test('an unresponsive real origin query becomes blocked within the declared deadline', { timeout: 20000 }, async () => {
  const f = await fixture(), sockets = new Set();
  const server = createServer(() => {});
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    git(f.cli, 'remote', 'set-url', 'origin', 'http://127.0.0.1:' + server.address().port + '/origin.git');
    const started = performance.now();
    await assert.rejects(verifyNextWorktreePair(f.config), error => error.status === 'blocked' && error.code === 'ORIGIN_NEXT_UNAVAILABLE');
    assert.ok(performance.now() - started < 15000, 'The origin check cannot wait indefinitely on network or authentication');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
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
test('a newly built pure reference module cannot pass with the previous selected CLI binding', async () => {
  const f = await fixture();
  await writeFile(join(f.cliRoot, 'dist/ref.cjs'), Buffer.concat([selectedRefBytes, Buffer.from('\n// New selected reference artifact\n')]));
  await f.cliBuild(); f.config.worktrees.cli.commit = f.commit(f.cli);
  await assert.rejects(verifyNextWorktreePair(f.config), /Source or artifact differs.*dist\/ref\.cjs/);
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

test('an unsupported host is explicitly blocked rather than identified by its hostname', () => {
  const code = `Object.defineProperty(process, 'platform', {value: 'unsupported-fixture'});
    const {machineFingerprint} = await import(${JSON.stringify(new URL('./verify-next-worktrees.mjs', import.meta.url).href)});
    try { await machineFingerprint(); process.exitCode = 1; }
    catch (error) { console.log(JSON.stringify({status:error.status,code:error.code})); }`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }));
  assert.deepEqual(result, { status: 'blocked', code: 'MACHINE_ID_UNAVAILABLE' });
});

// These are controlled receipt fixtures, never evidence of two real Pi runs.
async function dailyFixture() {
  const f = await fixture(), pair = await verifyNextWorktreePair(f.config);
  const started = Date.now() - 5000;
  f.config.version = 1;
  f.config.delivery = { id: randomUUID(), startedAt: new Date(started).toISOString() };
  f.config.library = '11111111-1111-4111-8111-111111111111';
  const harnessSha = createHash('sha256').update(await readFile(new URL('./verify-pi-daily-installation.mjs', import.meta.url))).digest('hex');
  function receipt(machineSha) {
    const bound = structuredClone(pair); bound.machine.sha256 = machineSha;
    const args = ['--mode', 'rpc', '-ns', '--session-dir', '/controlled/session'];
    const packageRoot = '/controlled/node_modules/@earendil-works/pi-coding-agent', entry = join(packageRoot, 'dist/cli.js');
    const file = path => ({ path, realpath: path, bytes: 1, sha256: 'f'.repeat(64) });
    const host = { file: '/controlled/node', prefix: ['/controlled/bin/pi'], path: '/controlled/bin/pi', identity: entry, parent_pid: 100,
      launcher: { ...file('/controlled/bin/pi'), realpath: entry } };
    const library = f.config.library, database = '22222222-2222-4222-8222-222222222222', dataSource = '33333333-3333-4333-8333-333333333333';
    const active = { in_trash: false, archived: false }, attribute = { kind: 'sdk', operation: 'list', library, requestId: 'controlled-list', request_kind: 'notion_metadata' };
    const http = [
      { origin: 'https://api.notion.com', method: 'GET', path: '/v1/blocks/' + library + '/children', cursor_sha256: null,
        attribution: { ...attribute, request_kind: 'notion_body', target: { block_id: library } },
        structure: { kind: 'root-children', root: library, has_more: false, next_cursor_sha256: null,
          children: [{ id: database, type: 'child_database', parent: { type: 'page_id', page_id: library }, ...active }] } },
      { origin: 'https://api.notion.com', method: 'GET', path: '/v1/databases/' + database, attribution: { ...attribute },
        structure: { kind: 'database', id: database, parent: { type: 'page_id', page_id: library }, data_source_ids: [dataSource], ...active } },
      { origin: 'https://api.notion.com', method: 'GET', path: '/v1/data_sources/' + dataSource, attribution: { ...attribute },
        structure: { kind: 'data_source', id: dataSource, parent: { type: 'database_id', database_id: database }, ...active } },
    ];
    return {
      version: 2, kind: 'actual-daily-pi-autoload-and-diagnostics', scope: 'ordinary-pi-startup-and-metadata', status: 'passed',
      evidence: 'controlled-receipt-fixture', delivery: { ...f.config.delivery }, library,
      started_at: new Date(started + 1000).toISOString(), finished_at: new Date(started + 2000).toISOString(),
      machine: { ...bound.machine }, worktrees_before: bound, worktrees_after: structuredClone(bound),
      worktrees_unchanged: true, configuration_unchanged: true, broker_files_unchanged: true, cli_shim_unchanged: true, host_files_unchanged: true,
      modifications: { user_settings: 0, source_config: 0, harness_model_credential_files_read: 0, old_sessions_read: 0,
        target_extensions_injected: 0, source_command_overrides: 0 },
      launch: { host: 'pi', normal_user_settings: true, args }, host,
      host_process: { pid: 101, parent_pid: 100, entry: file(entry), node: { ...file('/controlled/node'), version: '26.13.1' },
        package: { name: '@earendil-works/pi-coding-agent', version: '1.6.0', root: packageRoot, manifest: file(join(packageRoot, 'package.json')), bin: 'pi', entry_realpath: entry },
        args_sha256: createHash('sha256').update(JSON.stringify(args)).digest('hex'), observed_exit: true, exit_code: 0 },
      autoload: { injected_by_cli: false, registration: { source: 'extension' },
        actual_entry: { realpath: join(bound.broker.package_root, 'dist/index.js'), sha256: 'e'.repeat(64) } },
      initial_session: { sessionId: 'controlled-session', isStreaming: false, isCompacting: false },
      final_session: { sessionId: 'controlled-session', isStreaming: false, isCompacting: false },
      owned_pi: [{ pid: 101, file: host.file, args: [...host.prefix, ...args], observed_close: true, exit_code: 0, signal: null }],
      actual_default_sdk: { source_observation_complete: true, source_command_overridden: false, owner_pid: 101, operations: [{ operation: 'list', pid: 101, library }], http },
      library_structure: validateDailyLibraryRequests(http, library), notion_body_requests: 1,
      explicit_doctor_cli: { doctor: { ok: true, transport: 'direct_http' } }, metadata_http_requests: 3,
      provider_invocations: 0, tool_invocations: 0, remote_mutations: 0, skill_body_reads: 0, harness: { sha256: harnessSha },
    };
  }
  const pro = receipt(pair.machine.sha256), mini = receipt(pair.machine.sha256 === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64));
  f.config.receipts = { pro: join(f.parent, 'pro.json'), mini: join(f.parent, 'mini.json') };
  await save(f.config.receipts.pro, pro); await save(f.config.receipts.mini, mini);
  return { ...f, pair, pro, mini };
}
test('the public aggregate action accepts two controlled current daily receipts without claiming body or model verification', async () => {
  const f = await dailyFixture(), configPath = join(f.parent, 'delivery.json');
  await save(configPath, f.config);
  const result = JSON.parse(execFileSync(process.execPath, ['scripts/verify-pi-daily-installation.mjs', 'aggregate', '--config', configPath], { encoding: 'utf8' }));
  assert.equal(result.status, 'passed'); assert.equal(result.provider_model, 'not_run'); assert.equal(result.skill_body_consumption, 'not_run');
  assert.equal(result.scope, 'two-machine-ordinary-pi-startup-and-metadata');
  assert.notEqual(result.machines.pro.machine.sha256, result.machines.mini.machine.sha256);
});
test('one host cannot close delivery under two labels and neither a missing nor legacy receipt qualifies', async () => {
  const f = await dailyFixture();
  await save(f.config.receipts.mini, f.pro);
  assert.match((await aggregateDailyDeliveries(f.config)).error.message, /two different actual machines/);
  f.config.receipts.mini = join(f.parent, 'missing.json');
  assert.equal((await aggregateDailyDeliveries(f.config)).status, 'failed');
  f.config.receipts.mini = join(f.parent, 'old.json');
  await save(f.config.receipts.mini, { ...f.mini, version: 1 });
  assert.equal((await aggregateDailyDeliveries(f.config)).status, 'failed');
});
test('old delivery, changed builds, incomplete Pi proof and failed states cannot be promoted by a passed label', async () => {
  const f = await dailyFixture();
  assert.doesNotThrow(() => validateDailyReceipt(f.mini, f.config, f.pair));
  for (const change of [
    d => { d.delivery.id = randomUUID(); },
    d => { d.library = randomUUID(); },
    d => { d.notion_body_requests = 0; },
    d => { d.actual_default_sdk.operations[0].library = randomUUID(); },
    d => { d.library_structure.operations[0].databases = []; },
    d => { d.started_at = new Date(Date.parse(f.config.delivery.startedAt) - 1).toISOString(); },
    d => { d.worktrees_before.cli.commit = '0'.repeat(40); },
    d => { d.worktrees_after.broker.artifacts_sha256 = '0'.repeat(64); },
    d => { d.machine.sha256 = '0'.repeat(64); },
    d => { d.launch.normal_user_settings = false; },
    d => { d.autoload.injected_by_cli = true; },
    d => { d.owned_pi[0].observed_close = false; },
    d => { delete d.host_process; },
    d => { d.host_process.pid++; },
    d => { d.host_process.package.name = 'unrelated-package'; },
    d => { d.host_process.package.entry_realpath += '.other'; },
    d => { d.host_process.observed_exit = false; },
    d => { d.host_process.exit_code = 1; },
    d => { d.host_files_unchanged = false; },
    d => { d.actual_default_sdk.owner_pid++; },
    d => { d.actual_default_sdk.operations[0].pid++; },
    d => { d.actual_default_sdk.source_observation_complete = false; },
    ...['failed', 'blocked', 'not_run', 'prepared_not_executed'].map(status => d => { d.status = status; }),
  ]) {
    const candidate = structuredClone(f.mini); change(candidate);
    assert.throws(() => validateDailyReceipt(candidate, f.config, f.pair));
  }
  assert.throws(() => validateDailyReceipt(f.pair, f.config, f.pair));
  assert.throws(() => validateDailyReceipt({ version: 1, kind: 'project-scoped-candidate-precheck', status: 'passed' }, f.config, f.pair));
});
test('aggregate rechecks both the current verifier and the real origin instead of trusting two passed receipts', async () => {
  const f = await dailyFixture();
  await save(f.config.receipts.mini, { ...f.mini, harness: { sha256: '0'.repeat(64) } });
  assert.match((await aggregateDailyDeliveries(f.config)).error.message, /different verifier/);
  await save(f.config.receipts.mini, f.mini);
  const actor = join(f.parent, 'advanced-origin');
  git(f.parent, 'clone', '--branch', 'next', git(f.cli, 'remote', 'get-url', 'origin'), actor);
  await writeFile(join(actor, 'src/current.ts'), 'export const version = 2;\n');
  f.commit(actor);
  const result = await aggregateDailyDeliveries(f.config);
  assert.equal(result.status, 'failed'); assert.match(result.error.message, /origin\/next.*target/);
});
