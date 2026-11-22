import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fileInventory } from './next-build-identity.mjs';
import { resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { readSourceObservation, sourceObserverPreloadSource } from './skill-consumption-source-observer.mjs';
import { aggregateDailyDeliveries, classifyDailyHttp, classifyDailyNotionRequest, dailyObserverPreloadSource, observedDailyHostProcess, validateDailyDoctor, validateDailyFind, verifyDailyCliShim, verifyDailyPackageSource } from './verify-pi-daily-installation.mjs';
import { workflowHostLoader } from './notion-agent-workflow-runtime.mjs';

test('daily aggregate requires an explicit new delivery and both machine receipts before any source or Pi operation', async () => {
  for (const config of [{}, { delivery: { id: 'old-label', startedAt: new Date().toISOString() } },
    { delivery: { id: '12345678-1234-4234-8234-123456789abc', startedAt: new Date().toISOString() }, receipts: { pro: '/missing/pro.json' } }]) {
    const result = await aggregateDailyDeliveries(config);
    assert.equal(result.status, 'failed'); assert.equal(result.provider_model, 'not_run');
    assert.equal(result.current_source_build, undefined);
  }
});
test('the existing daily entry advertises aggregate and its one current receipt schema', () => {
  const help = execFileSync(process.execPath, ['scripts/verify-pi-daily-installation.mjs', '--help'], { encoding: 'utf8' });
  assert.match(help, /aggregate --config/); assert.match(help, /Only daily receipt version 2 qualifies/);
  assert.match(help, /delivery:\{id:UUID,startedAt:UTC_ISO\}/);
});

async function observedHostFixture(kind, packageName = '@earendil-works/pi-coding-agent', binEntry = 'dist/cli.cjs') {
  const root = await mkdtemp(join(tmpdir(), 'daily-host-identity-')), packageRoot = join(root, 'installed-package');
  const entry = join(packageRoot, 'dist/cli.cjs'), launcher = join(root, 'pi'), directory = join(root, 'observed');
  await Promise.all([dirname(entry), directory].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: packageName, version: '1.6.0', bin: { pi: binEntry } }));
  await writeFile(entry, '#!/usr/bin/env node\nprocess.stdout.write("controlled host only\\n");\n', { mode: 0o755 });
  const loader = join(packageRoot, 'node_modules/jiti/index.js');
  await mkdir(dirname(loader), { recursive: true });
  await writeFile(loader, 'exports.createJiti=()=>({origin:__filename});\n');
  if (kind === 'native') await symlink(entry, launcher);
  else await writeFile(launcher, kind === 'wrapper'
    ? '#!/bin/sh\nexec ' + [process.execPath, entry].map(value => "'" + value.replaceAll("'", "'\\''") + "'").join(' ') + ' "$@"\n'
    : '#!/bin/sh\n# ' + entry + '\nexit 0\n', { mode: 0o755 });
  const preload = join(root, 'observe.cjs'), sourcePreload = join(root, 'source.mjs'), sourceLedger = join(root, 'source.jsonl');
  await writeFile(preload, dailyObserverPreloadSource({ directory, cliEntry: entry, ownerParentPid: process.pid }));
  await writeFile(sourcePreload, sourceObserverPreloadSource({ output: sourceLedger, checkoutRoot: process.cwd(), clockId: 'host-test',
    cliPath: entry, ownerParentPid: process.pid, ownerPackage: { packageName: '@earendil-works/pi-coding-agent', binName: 'pi' } }));
  const selected = await resolveHost(launcher), bytes = await readFile(launcher);
  const host = { ...selected, parent_pid: process.pid, launcher: { path: launcher, realpath: await realpath(launcher), bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') } };
  const args = ['--mode', 'rpc', '-ns', '--session-dir', join(root, 'sessions')];
  const child = spawnSync(host.file, [...host.prefix, ...args], { encoding: 'utf8', timeout: 15000,
    env: { ...process.env, NODE_OPTIONS: '--require=' + JSON.stringify(preload) + ' --import=' + JSON.stringify(sourcePreload) } });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  const owned = [{ pid: child.pid, file: host.file, args: [...host.prefix, ...args], observed_close: true, exit_code: child.status, signal: child.signal }];
  const observed = (await Promise.all((await readdir(directory)).map(file => readFile(join(directory, file), 'utf8'))))
    .flatMap(text => text.trim().split('\n').filter(Boolean).map(JSON.parse));
  return { host, args, owned, observed, sourceLedger, entry, loader };
}

for (const kind of ['native', 'wrapper']) test('ordinary ' + kind + ' binds the actual Pi package, Node and source observer to one exited process', async () => {
  const f = await observedHostFixture(kind);
  const proof = observedDailyHostProcess(f.host, f.owned, f.observed, f.args);
  assert.equal(proof.entry.realpath, await realpath(f.entry));
  assert.equal(proof.node.realpath, await realpath(process.execPath));
  assert.equal(proof.node.version, process.versions.node);
  assert.equal(proof.package.version, '1.6.0'); assert.equal(proof.observed_exit, true);
  assert.equal(proof.pid, f.owned[0].pid);
  assert.equal(f.host.launcher.realpath === proof.entry.realpath, kind === 'native');
  const loader = await workflowHostLoader(f.host, f.owned, f.observed, f.args);
  assert.deepEqual(loader.hostProcess, proof);
  assert.equal(loader.loaderArtifact.realpath, await realpath(f.loader));
  assert.equal(loader.createJiti().origin, f.loader, 'Workflow loading must follow the observed Pi package, including through a shell launcher');
  const source = await readSourceObservation(f.sourceLedger);
  assert.equal(source.complete, true);
  assert.equal(source.events.find(row => row.phase === 'source_observer_start').pid, proof.pid);
  for (const change of [
    rows => rows.filter(row => row.event !== 'process_start'),
    rows => rows.filter(row => row.event !== 'process_exit'),
    rows => rows.map(row => row.event === 'process_start' ? { ...row, pid: row.pid + 1 } : row),
    rows => rows.map(row => row.event === 'process_start' ? { ...row, args_sha256: '0'.repeat(64) } : row),
  ]) assert.throws(() => observedDailyHostProcess(f.host, f.owned, change(f.observed), f.args));
  await assert.rejects(workflowHostLoader(f.host, f.owned.map(child => ({ ...child, pid: child.pid + 1 })), f.observed, f.args));
  await writeFile(f.entry, '# Changed after the observed launch\n');
  await assert.rejects(workflowHostLoader(f.host, f.owned, f.observed, f.args), /observed Pi entry or package changed/);
});

test('fake wrappers, unrelated packages and a mismatched public bin cannot establish host identity', async () => {
  for (const f of [await observedHostFixture('fake'), await observedHostFixture('wrapper', 'unrelated-package'),
    await observedHostFixture('wrapper', '@earendil-works/pi-coding-agent', 'dist/other.cjs')]) {
    assert.throws(() => observedDailyHostProcess(f.host, f.owned, f.observed, f.args));
    await assert.rejects(workflowHostLoader(f.host, f.owned, f.observed, f.args));
    assert.equal((await readSourceObservation(f.sourceLedger)).complete, false);
  }
});

test('daily HTTP observation includes retained fetch references without changing responses or double counting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'daily-http-observer-'));
  const preload = dailyObserverPreloadSource({ directory, cliEntry: join(directory, 'unused-cli.js') });
  const child = `
    const http = require('node:http'), vm = require('node:vm');
    const retainedFetch = globalThis.fetch;
    vm.runInThisContext(${JSON.stringify(preload)});
    if (globalThis.fetch !== retainedFetch) throw new Error('Observer replaced fetch');
    const server = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      res.writeHead(200, {'x-request-id': '${sdkRequestId}'}); res.end(body);
    });
    (async () => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const url = 'http://127.0.0.1:' + server.address().port + '/metadata';
        for (const fetch of [retainedFetch, globalThis.fetch]) {
          const response = await fetch(url, {method: 'POST', body: '{"unicode":"数据"}'});
          if (await response.text() !== '{"unicode":"数据"}') throw new Error('Observer changed response');
        }
      } finally { await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  execFileSync(process.execPath, ['-e', child], { timeout: 15000, stdio: 'pipe' });
  const files = await readdir(directory);
  const rows = (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).flatMap(text => text.trim().split('\n').map(JSON.parse));
  const requests = rows.filter(row => row.event === 'http_start');
  assert.equal(requests.length, 2, 'Both retained and current fetch must have independent transport evidence');
  assert.equal(rows.filter(row => row.event === 'http_end').length, 2);
  assert.ok(requests.every(row => row.request_bytes === Buffer.byteLength('{"unicode":"数据"}')));
  assert.ok(rows.filter(row => row.event === 'http_end').every(row => row.status === 200 && row.response_request_id === sdkRequestId));
  assert.ok(rows.some(row => row.event === 'http_observer_end' && row.complete === true && row.errors === 0));
});

test('daily transport preserves an aborted response as failure after headers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'daily-http-aborted-'));
  const preload = dailyObserverPreloadSource({ directory, cliEntry: join(directory, 'unused-cli.js') });
  const child = `
    const http = require('node:http'), vm = require('node:vm');
    vm.runInThisContext(${JSON.stringify(preload)});
    const server = http.createServer((req, res) => {
      res.writeHead(200, {'content-length': '100', 'x-request-id': '${sdkRequestId}'});
      res.write('x'); setTimeout(() => res.destroy(), 10);
    });
    (async () => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/metadata');
        try { await response.text(); throw new Error('Expected an interrupted response'); }
        catch (error) { if (error.message === 'Expected an interrupted response') throw error; }
      } finally { await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  execFileSync(process.execPath, ['-e', child], { timeout: 15000, stdio: 'pipe' });
  const rows = (await Promise.all((await readdir(directory)).map(file => readFile(join(directory, file), 'utf8')))).flatMap(text => text.trim().split('\n').map(JSON.parse));
  assert.equal(rows.filter(row => row.event === 'http_start').length, 1);
  assert.equal(rows.filter(row => row.event === 'http_error').length, 1);
  assert.equal(rows.filter(row => row.event === 'http_end').length, 0, 'Response headers alone do not establish complete delivery');
  assert.ok(rows.some(row => row.event === 'http_observer_end' && row.complete === true && row.errors === 0));
});

test('a pre-send connection failure retains request identity and terminal error without inventing a response ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'daily-http-connect-failure-'));
  const preload = dailyObserverPreloadSource({ directory, cliEntry: join(directory, 'unused-cli.js') });
  const child = `
    const http = require('node:http'), vm = require('node:vm');
    vm.runInThisContext(${JSON.stringify(preload)});
    const server = http.createServer();
    (async () => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      await new Promise(resolve => server.close(resolve));
      try { await fetch('http://127.0.0.1:' + port + '/metadata'); throw new Error('Expected connection failure'); }
      catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  execFileSync(process.execPath, ['-e', child], { timeout: 15000, stdio: 'pipe' });
  const rows = (await Promise.all((await readdir(directory)).map(file => readFile(join(directory, file), 'utf8')))).flatMap(text => text.trim().split('\n').map(JSON.parse));
  const created = rows.filter(row => row.event === 'http_created'), failed = rows.filter(row => row.event === 'http_error');
  assert.equal(created.length, 1); assert.equal(failed.length, 1);
  assert.equal(rows.filter(row => row.event === 'http_start' || row.event === 'http_end').length, 0);
  for (const field of ['id', 'pid', 'method', 'origin', 'path', 'started_ms']) assert.equal(failed[0][field], created[0][field]);
  assert.equal(failed[0].method, 'GET'); assert.equal(failed[0].path, '/metadata');
  assert.equal(failed[0].code, 'ECONNREFUSED'); assert.equal(failed[0].error.code, 'ECONNREFUSED');
  assert.match(failed[0].error.message, /ECONNREFUSED/);
  assert.equal(failed[0].status, null); assert.equal(failed[0].response_request_id, null);
  assert.equal(failed[0].request_body_sent, false); assert.equal(failed[0].sent_request_bytes, 0);
  assert.ok(failed[0].ended_ms >= failed[0].started_ms);
  assert.ok(rows.some(row => row.event === 'http_observer_end' && row.complete === true && row.errors === 0));
});

async function observeJsonResponseBodyId(allowLoopback) {
  const directory = await mkdtemp(join(tmpdir(), 'daily-http-body-id-'));
  const preload = dailyObserverPreloadSource({ directory, cliEntry: join(directory, 'unused-cli.js'),
    ...(allowLoopback ? { responseRequestIdBodyOrigins: ['http://127.0.0.1:__PORT__'] } : {}) });
  const child = `
    const http = require('node:http'), vm = require('node:vm'), zlib = require('node:zlib');
    const body = JSON.stringify({request_id: '${sdkRequestId}', value: '数据'});
    const server = http.createServer((req, res) => {
      res.writeHead(200, {'content-type': 'application/json', 'content-encoding': 'gzip'}); res.end(zlib.gzipSync(body));
    });
    (async () => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      vm.runInThisContext(${JSON.stringify(preload)}.replace('http://127.0.0.1:__PORT__', 'http://127.0.0.1:' + server.address().port));
      try {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/metadata');
        if (await response.text() !== body) throw new Error('Observer changed response');
      } finally { await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  execFileSync(process.execPath, ['-e', child], { timeout: 15000, stdio: 'pipe' });
  const raw = (await Promise.all((await readdir(directory)).map(file => readFile(join(directory, file), 'utf8')))).join('');
  const rows = raw.trim().split('\n').map(JSON.parse), completed = rows.filter(row => row.event === 'http_end');
  assert.equal(completed.length, 1);
  assert.equal(raw.includes('数据'), false, 'Private response bodies must not be persisted');
  assert.ok(rows.some(row => row.event === 'http_observer_end' && row.complete === true && row.errors === 0));
  return completed[0];
}

test('a complete JSON response may carry its server request ID in a compressed body', async () => {
  const completed = await observeJsonResponseBodyId(true);
  assert.equal(completed.response_request_id, sdkRequestId);
  assert.equal(completed.response_request_id_source, 'response-json');
});

test('the production observer never parses a JSON request ID from an unrelated origin', async () => {
  const completed = await observeJsonResponseBodyId(false);
  assert.equal(completed.response_request_id, null);
  assert.equal(completed.response_request_id_source, null);
});

async function installationFixture() {
  const root = await mkdtemp(join(tmpdir(), 'daily-installation-identity-'));
  const agent = join(root, '.pi/agent'), broker = join(root, 'broker-next/packages/context-broker');
  const cliRoot = join(root, 'cli-next/packages/cli'), bin = join(root, '.volta/bin');
  await Promise.all([agent, broker, join(cliRoot, 'dist'), bin].map(path => mkdir(path, { recursive: true })));
  const entry = join(cliRoot, 'dist/ntn-skills.js'), content = '#!/usr/bin/env node\nthrow new Error("The CLI must not execute in identity tests");\n';
  await writeFile(entry, content, { mode: 0o755 });
  const resolution = join(root, 'volta-resolution.txt');
  const selected = join(root, 'image/bin/ntn-skills');
  await mkdir(join(root, 'image/bin'), { recursive: true });
  await symlink(entry, selected);
  await writeFile(resolution, selected + '\n');
  await writeFile(join(bin, 'volta'), `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv.slice(2).join(' ') !== 'which ntn-skills' || process.env.DAILY_LOOKUP_SENTINEL !== 'preserved') process.exit(7);\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(resolution)}, 'utf8'));\n`, { mode: 0o755 });
  await writeFile(join(bin, 'volta-shim'), 'fixture Volta dispatcher: never executed\n', { mode: 0o755 });
  const shim = join(bin, 'ntn-skills');
  await symlink('volta-shim', shim);
  return {
    root, agent, broker, cliRoot, bin, entry, selected, resolution, shim,
    env: { PATH: bin, DAILY_LOOKUP_SENTINEL: 'preserved' },
    config: {
      cliRoot, cliShim: shim, cliEntrySha256: createHash('sha256').update(content).digest('hex'),
      voltaIdentity: {
        executable_sha256: createHash('sha256').update(await readFile(join(bin, 'volta'))).digest('hex'),
        dispatcher_sha256: createHash('sha256').update(await readFile(join(bin, 'volta-shim'))).digest('hex'),
      },
    },
  };
}

test('daily plan and launched host receive -ns without replacing normal HOME or settings', async () => {
  const f = await installationFixture(), digest = value => createHash('sha256').update(value).digest('hex');
  const settingsPath = join(f.agent, 'settings.json'), sourcePath = join(f.agent, 'context-broker/config.json');
  const skillPath = join(f.agent, 'skills/kept/SKILL.md'), skill = '# Existing global skill\n';
  const settings = { packages: ['npm:kept-plugin', relative(f.agent, f.broker)], defaultModel: 'kept-model' };
  const source = { sources: [{ id: 'notion', type: 'notion', database: 'fixture-database', prefetch: false }] };
  await Promise.all([dirname(sourcePath), dirname(skillPath), join(f.broker, 'dist')].map(path => mkdir(path, { recursive: true })));
  await writeFile(settingsPath, JSON.stringify(settings));
  await writeFile(sourcePath, JSON.stringify(source));
  await writeFile(skillPath, skill);
  const embeddedCli = 'throw new Error("Fixture CLI must not execute");\n', embeddedSdk = 'throw new Error("Fixture SDK must not execute");\n';
  await writeFile(join(f.broker, 'dist/ntn-skills.mjs'), embeddedCli);
  await writeFile(join(f.broker, 'dist/ntn-skills-sdk.mjs'), embeddedSdk);
  await writeFile(join(f.broker, 'dist/ntn-skills-runtime.json'), JSON.stringify({ version: 1, package: 'ntn-skills', cli_sha256: digest(embeddedCli), sdk_sha256: digest(embeddedSdk) }));
  const config = { ...f.config, version: 1, packageCount: 2, packageIndex: 1, brokerRoot: f.broker,
    delivery: { id: randomUUID(), startedAt: new Date().toISOString() },
    embeddedCliSha256: digest(embeddedCli), embeddedSdkSha256: digest(embeddedSdk), evidenceRoot: join(f.root, 'evidence') };
  // This public run crosses the real current-worktree boundary using owned local origins.
  // The controlled Pi still exits before any extension, RPC or service operation.
  config.worktrees = {};
  await mkdir(join(f.cliRoot, 'skills'));
  await writeFile(join(f.cliRoot, 'skills/SKILL.md'), '# Controlled skill\n');
  await writeFile(join(f.cliRoot, 'dist/sdk.js'), embeddedSdk);
  await writeFile(join(f.cliRoot, 'package.json'), '{"type":"module"}\n');
  for (const [name, pkg] of [['cli', f.cliRoot], ['broker', f.broker]]) {
    const root = dirname(dirname(pkg)), origin = join(f.root, name + '-origin.git');
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/current.ts'), 'export const fixture = true;\n');
    const build = { version: 1, kind: name + '-build', input_roots: ['src'], source: await fileInventory(root, ['src']),
      artifacts: await fileInventory(pkg, name === 'cli' ? ['dist/ntn-skills.js', 'dist/sdk.js', 'skills'] : ['dist/ntn-skills.mjs', 'dist/ntn-skills-sdk.mjs', 'dist/ntn-skills-runtime.json']) };
    if (name === 'broker') build.selected_cli = await fileInventory(f.cliRoot, ['package.json', 'dist/ntn-skills.js', 'dist/sdk.js', 'skills']);
    await writeFile(join(pkg, 'dist/next-build.json'), JSON.stringify(build));
    git('init', '--initial-branch=next'); git('init', '--bare', '--initial-branch=next', origin); git('remote', 'add', 'origin', origin);
    git('add', '.'); git('-c', 'user.name=Daily launch fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'controlled daily inputs');
    git('push', 'origin', 'next');
    config.worktrees[name] = { root, commit: git('rev-parse', 'HEAD') };
  }
  for (const [name, root] of [['broker', f.broker], ['cli', f.cliRoot]]) {
    const staging = join(f.root, name + '-archive'), archive = join(f.root, name + '.tgz');
    await cp(root, join(staging, 'package'), { recursive: true });
    execFileSync('tar', ['-czf', archive, '-C', staging, 'package'], { env: { PATH: process.env.PATH, COPYFILE_DISABLE: '1' } });
    config[name + 'Archive'] = archive;
    config[name + 'ArchiveSha256'] = digest(await readFile(archive));
  }
  const host = join(f.root, 'host/@earendil-works/pi-coding-agent/cli.cjs'), bin = join(f.root, 'host-bin');
  const receipt = join(f.root, 'host-launch.json');
  await Promise.all([dirname(host), bin].map(path => mkdir(path, { recursive: true })));
  // This controlled host records the real launch boundary, then exits before
  // RPC, extension loading or any model/network operation can take place.
  await writeFile(host, `#!/usr/bin/env node\nconst fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const settingsPath = path.join(os.homedir(), '.pi/agent/settings.json');
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME,
  agentOverride: process.env.PI_CODING_AGENT_DIR ?? null, sourceOverride: process.env.CONTEXT_BROKER_CONFIG ?? null,
  settingsPath, settings: JSON.parse(fs.readFileSync(settingsPath, 'utf8')) }));
process.exit(17);\n`, { mode: 0o755 });
  await symlink(host, join(bin, 'pi'));
  const configPath = join(f.root, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  const entry = fileURLToPath(new URL('./verify-pi-daily-installation.mjs', import.meta.url));
  const env = { ...f.env, HOME: f.root, PATH: [bin, f.bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) };
  const planned = JSON.parse(execFileSync(process.execPath, [entry, 'plan', '--config', configPath], { env, encoding: 'utf8' }));
  assert.deepEqual(planned.pi_arguments, ['--mode', 'rpc', '-ns', '--session-dir', '<new owned directory>']);
  assert.equal(planned.settings, settingsPath);
  const launched = spawnSync(process.execPath, [entry, 'run', '--config', configPath], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(launched.error, undefined);
  assert.equal(launched.status, 1, launched.stderr);
  const result = JSON.parse(launched.stdout);
  assert.match(result.error.message, /RPC exited \(code=17,/);
  const observed = JSON.parse(await readFile(receipt, 'utf8'));
  assert.deepEqual(observed.args, ['--mode', 'rpc', '-ns', '--session-dir', join(result.evidence, 'sessions')]);
  assert.equal(observed.home, f.root);
  assert.equal(observed.agentOverride, null);
  assert.equal(observed.sourceOverride, null);
  assert.equal(observed.settingsPath, settingsPath);
  assert.deepEqual(observed.settings, settings);
  assert.equal(await readFile(settingsPath, 'utf8'), JSON.stringify(settings));
  assert.equal(await readFile(sourcePath, 'utf8'), JSON.stringify(source));
  assert.equal(await readFile(skillPath, 'utf8'), skill);
});

test('daily relative package source resolves from the settings agent directory, independently of cwd', async () => {
  const f = await installationFixture();
  const spec = relative(f.agent, f.broker);
  assert.notEqual(process.cwd(), f.agent);
  assert.deepEqual(await verifyDailyPackageSource(spec, join(f.agent, 'settings.json'), f.broker), {
    selected_package: spec, resolved_package: await realpath(f.broker),
  });
});

test('daily Volta shim uses official which resolution and binds the exact frozen CLI bytes', async () => {
  const f = await installationFixture();
  const identity = await verifyDailyCliShim(f.config, f.env);
  assert.equal(identity.resolution.kind, 'volta');
  assert.deepEqual(identity.resolution.argv, [join(f.bin, 'volta'), 'which', 'ntn-skills']);
  assert.equal(identity.resolution.entry.realpath, await realpath(f.entry));
  assert.equal(identity.resolution.entry.sha256, f.config.cliEntrySha256);
  assert.equal(identity.executed_by_harness, false);
});

test('daily package identity accepts an absolute source and rejects a different slot or agent-relative target', async () => {
  const f = await installationFixture();
  assert.equal((await verifyDailyPackageSource(f.broker, join(f.agent, 'settings.json'), f.broker)).resolved_package, await realpath(f.broker));
  await assert.rejects(verifyDailyPackageSource(f.cliRoot, join(f.agent, 'settings.json'), f.broker), /final Broker/);
  await assert.rejects(verifyDailyPackageSource(relative(f.agent, f.broker), join(f.root, 'another-agent/settings.json'), f.broker));
});

test('daily direct CLI selection resolves exactly to the frozen entry and hash', async () => {
  const f = await installationFixture(), bin = join(f.root, 'direct-bin');
  await mkdir(bin);
  const shim = join(bin, 'ntn-skills');
  await symlink(f.entry, shim);
  const config = { ...f.config, cliShim: shim }, env = { PATH: bin };
  assert.equal((await verifyDailyCliShim(config, env)).resolution.kind, 'direct');
  await assert.rejects(verifyDailyCliShim({ ...config, cliEntrySha256: '0'.repeat(64) }, env));
});

test('daily CLI identity rejects a wrapper containing the final bundle path and a shadowed PATH selection', async () => {
  const f = await installationFixture(), bin = join(f.root, 'shadow-bin');
  await mkdir(bin);
  const wrapper = join(bin, 'ntn-skills');
  await writeFile(wrapper, `#!/bin/sh\n# ${f.entry}\nexit 0\n`, { mode: 0o755 });
  const env = { ...f.env, PATH: bin + delimiter + f.bin };
  await assert.rejects(verifyDailyCliShim({ ...f.config, cliShim: wrapper }, env), /actual Volta dispatcher/);
  await assert.rejects(verifyDailyCliShim(f.config, env), /normal PATH selection/);
});

test('daily Volta resolution rejects a different entry even with identical bytes and rejects ambiguous output', async () => {
  const f = await installationFixture(), other = join(f.cliRoot, 'dist/other.js');
  await writeFile(other, await readFile(f.entry), { mode: 0o755 });
  await writeFile(f.resolution, other + '\n');
  await assert.rejects(verifyDailyCliShim(f.config, f.env), /different installed CLI/);
  await writeFile(f.resolution, f.selected + '\n' + f.entry + '\n');
  await assert.rejects(verifyDailyCliShim(f.config, f.env), /one absolute CLI entry/);
});

test('daily identity reread detects changed frozen entry bytes and a changed Volta mapping', async () => {
  const f = await installationFixture();
  const initial = await verifyDailyCliShim(f.config, f.env);
  assert.deepEqual(await verifyDailyCliShim(f.config, f.env), initial);
  await writeFile(f.entry, (await readFile(f.entry, 'utf8')) + '// changed\n');
  await assert.rejects(verifyDailyCliShim(f.config, f.env));
  await writeFile(f.resolution, f.broker + '\n');
  const changedHash = createHash('sha256').update(await readFile(f.entry)).digest('hex');
  await assert.rejects(verifyDailyCliShim({ ...f.config, cliEntrySha256: changedHash }, f.env));
});

test('daily Volta identity requires reviewed executable and dispatcher bytes, not their path names', async () => {
  const f = await installationFixture();
  await assert.rejects(verifyDailyCliShim({ ...f.config, voltaIdentity: undefined }, f.env), /actual Volta executable SHA/);
  await assert.rejects(verifyDailyCliShim({ ...f.config, voltaIdentity: { ...f.config.voltaIdentity, dispatcher_sha256: '0'.repeat(64) } }, f.env), /actual Volta dispatcher SHA/);
  await writeFile(join(f.bin, 'volta'), (await readFile(join(f.bin, 'volta'), 'utf8')) + '// changed\n');
  await assert.rejects(verifyDailyCliShim(f.config, f.env), /actual Volta executable SHA/);
});

const selected = { selection: 'required-router@notion', kind: 'router', source: 'notion', page: 'current-page' };
const finding = 'context-broker find: required-router -> 1/1\n$required-router@notion\n  kind: router\n  source: notion\n  page: current-page';
const failure = '  fail router "external-router" member "notion_page:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" unavailable (CATALOG_MEMBER_UNAVAILABLE): declared locator absent from current credential-scoped catalog';
const report = ['Context Broker Doctor', 'Config diagnostics: ok', 'Namespace: failed', failure].join('\n');
const review = {
  kind: 'reviewed-external-catalog-diagnostics', status: 'outside-delivery-scope',
  sourceDatabaseId: 'current-database', declaredDatabaseIds: ['other-database'],
  routerNames: ['external-router'], namespaceDiagnostics: [failure],
  catalog: { path: '/reviewed/catalog.yaml', sha256: 'reviewed-by-run' }, reason: 'A separate database remains outside this delivery.',
};
const doctor = (text = report, accepted = review) => validateDailyDoctor([text], accepted, ['current-database'], selected.selection);

test('daily selection requires the exact qualified source, kind and page', () => {
  assert.deepEqual(validateDailyFind([finding], selected), selected);
  assert.throws(() => validateDailyFind([finding.replace('current-page', 'other-page')], selected));
  assert.throws(() => validateDailyFind([finding.replace('source: notion', 'source: local')], selected));
  assert.throws(() => validateDailyFind([finding, finding], selected));
});

test('a clean doctor needs no exception; conflicting namespace reports fail', () => {
  const clean = 'Context Broker Doctor\nConfig diagnostics: ok\nNamespace: ok no discovery namespace collisions';
  assert.equal(doctor(clean, undefined).status, 'ok');
  assert.throws(() => doctor(clean + '\nNamespace: failed', undefined));
});

test('reviewed external diagnostics remain visible as failed namespace observations', () => {
  const result = doctor();
  assert.equal(result.status, 'retained-external-catalog-diagnostics');
  assert.deepEqual(result.failures, [failure]);
  assert.throws(() => doctor(report, null));
});

test('new, changed, or duplicate namespace failures cannot use the review', () => {
  assert.throws(() => doctor(report + '\n' + failure));
  assert.throws(() => doctor(report.replace('external-router', 'new-router')));
  assert.throws(() => doctor(report.replace('aaaaaaaa', 'bbbbbbbb')));
});

test('configuration failures remain fatal even with an exact namespace review', () => {
  assert.throws(() => doctor(report.replace('Config diagnostics: ok', 'Config diagnostics: failed')));
});

test('the current database and required route cannot be excluded', () => {
  assert.throws(() => doctor(report, { ...review, declaredDatabaseIds: ['current-database'] }));
  const targetFailure = failure.replace('external-router', 'required-router');
  assert.throws(() => doctor(report.replace(failure, targetFailure), { ...review, routerNames: ['required-router'], namespaceDiagnostics: [targetFailure] }));
});

test('HTTP follows actual process ancestry, including source descendants', () => {
  const observed = [
    { event: 'spawn', pid: 10, child_pid: 20 },
    { event: 'spawn', pid: 10, child_pid: 30 },
    { event: 'process_start', pid: 21, ppid: 20 },
    { event: 'process_start', pid: 31, ppid: 30 },
    { event: 'http_start', pid: 20, id: 'source' },
    { event: 'http_start', pid: 21, id: 'source-child' },
    { event: 'http_start', pid: 31, id: 'other-plugin' },
  ];
  const result = classifyDailyHttp(observed, new Set([20]), new Set([10]));
  assert.deepEqual(result.source.map(row => row.id), ['source', 'source-child']);
  assert.deepEqual(result.otherPlugins.map(row => row.id), ['other-plugin']);
});

test('host, unknown, or cyclic ancestry cannot conceal HTTP as other-plugin traffic', () => {
  for (const rows of [
    [{ event: 'http_start', pid: 10 }],
    [{ event: 'http_start', pid: 99 }],
    [{ event: 'http_start', pid: 99, origin: 'https://external.example', id: 'unknown' }],
    [{ event: 'process_start', pid: 40, ppid: 41 }, { event: 'process_start', pid: 41, ppid: 40 }, { event: 'http_start', pid: 40 }],
  ]) assert.throws(() => classifyDailyHttp(rows, new Set([20]), new Set([10])));
});

const sdkRequestId = '12345678-1234-4234-8234-123456789abc';
function sdkObservation(overrides = {}) {
  return { complete: true, errors: [], events: [
    { phase: 'source_observer_start', pid: 10 },
    { phase: 'started', kind: 'sdk', pid: 10, operation: 'list', requestId: 'sdk:10:one' },
    { phase: 'attempt', kind: 'http', requestId: 'sdk:10:one', attempt: 1,
      request_id: sdkRequestId, request_kind: 'notion_metadata', method: 'POST', http_status: 200, outcome: 'success', request_bytes: 2, response_bytes: 100 },
    { phase: 'metrics', kind: 'metrics', requestId: 'sdk:10:one', observed: true, complete: true, total_requests: 1 },
    { phase: 'completed', kind: 'sdk', pid: 10, operation: 'list', requestId: 'sdk:10:one', status: 'completed', sdkStarted: true },
    { phase: 'source_observer_end', complete: true },
  ], ...overrides };
}
const sdkHttp = [
  { event: 'http_start', pid: 10, id: '10:1', method: 'POST', origin: 'https://api.notion.com', path: '/v1/views/view/queries', request_bytes: 2 },
  { event: 'http_end', pid: 10, id: '10:1', status: 200, response_request_id: sdkRequestId },
];

for (const operation of ['list', 'files']) test(operation + ' host SDK HTTP needs an exact complete operation and independent response request ID', () => {
  const observation = sdkObservation();
  observation.events = observation.events.map(event => event.operation ? { ...event, operation } : event);
  const result = classifyDailyHttp(sdkHttp, new Set(), new Set([10]), { sourceObservation: observation });
  assert.equal(result.sdk.length, 1);
  assert.equal(result.source.length, 1);
  assert.equal(result.sdk[0].attribution.operation, operation);
  assert.equal(result.sdk[0].attribution.requestId, 'sdk:10:one');
  assert.equal(result.sdk[0].attribution.response_bytes, 100);
});

test('SDK HTTP rejects absent, ambiguous, failed or mismatched receipt evidence', () => {
  for (const changed of [
    sdkObservation({ complete: false }),
    sdkObservation({ errors: ['missing-end-boundary'] }),
    sdkObservation({ events: sdkObservation().events.filter(event => event.phase !== 'completed') }),
    sdkObservation({ events: sdkObservation().events.map(event => event.phase === 'attempt' ? { ...event, request_id: null } : event) }),
    sdkObservation({ events: sdkObservation().events.map(event => event.phase === 'attempt' ? { ...event, method: 'GET' } : event) }),
    sdkObservation({ events: sdkObservation().events.map(event => event.phase === 'attempt' ? { ...event, http_status: 403 } : event) }),
    sdkObservation({ events: sdkObservation().events.map(event => event.phase === 'started' ? { ...event, pid: 99 } : event) }),
    sdkObservation({ events: sdkObservation().events.map(event => event.operation ? { ...event, operation: 'future-operation' } : event) }),
    sdkObservation({ events: [...sdkObservation().events, { ...sdkObservation().events[2], requestId: 'sdk:10:two' }] }),
  ]) assert.throws(() => classifyDailyHttp(sdkHttp, new Set(), new Set([10]), { sourceObservation: changed }));
  assert.throws(() => classifyDailyHttp([...sdkHttp, { ...sdkHttp[0], id: '10:2' }, { ...sdkHttp[1], id: '10:2' }],
    new Set(), new Set([10]), { sourceObservation: sdkObservation() }));
});

test('every host Notion request still needs an exact SDK match', () => {
  for (const origin of ['https://api.notion.com', 'http://api.notion.com', 'https://api.notion.com:8443']) {
    const request = { ...sdkHttp[0], origin };
    const response = { ...sdkHttp[1], response_request_id: null };
    assert.throws(() => classifyDailyHttp([request, response], new Set(), new Set([10])), /no exact SDK request ID match/u);
  }
});

test('non-Notion host traffic retains failures and missing outcomes outside target costs', () => {
  const unauthorized = { event: 'http_start', pid: 10, id: '10:external-1', origin: 'https://mcp.external.example', path: '/mcp', method: 'POST', request_bytes: 161 };
  const unauthorizedEnd = { event: 'http_end', pid: 10, id: unauthorized.id, status: 401, response_request_id: null };
  const stream = { ...unauthorized, id: '10:external-2', method: 'GET', request_bytes: 0 };
  const streamError = { event: 'http_error', pid: 10, id: stream.id, status: 200, response_request_id: null, code: 20, error: { name: 'AbortError', message: 'stream aborted' } };
  const pending = { ...stream, id: '10:external-3' };
  const external = [unauthorized, unauthorizedEnd, stream, streamError, pending];
  const result = classifyDailyHttp([...sdkHttp, ...external], new Set(), new Set([10]), { sourceObservation: sdkObservation() });
  assert.deepEqual(result.source.map(row => row.id), ['10:1']);
  assert.equal(result.sdk.length, 1);
  assert.deepEqual(result.otherPlugins, []);
  assert.deepEqual(result.unattributedHostHttp, [
    { ...unauthorized, outcomes: [unauthorizedEnd] },
    { ...stream, outcomes: [streamError] },
    { ...pending, outcomes: [] },
  ]);
  assert.throws(() => classifyDailyHttp(external, new Set(), new Set([10]), { sourceObservation: sdkObservation() }), /SDK attempt lacks independent HTTP evidence/u);
});

test('an SDK-attributed external provider stays in scope and fails Notion metadata verification', () => {
  const request = { ...sdkHttp[0], origin: 'https://provider.example', path: '/content' };
  const result = classifyDailyHttp([request, sdkHttp[1]], new Set(), new Set([10]), { sourceObservation: sdkObservation() });
  assert.equal(result.source.length, 1);
  assert.deepEqual(result.unattributedHostHttp, []);
  assert.throws(() => classifyDailyNotionRequest(result.source[0]), /Unexpected provider/u);
  assert.throws(() => classifyDailyHttp([{ ...request, pid: 11 }, { ...sdkHttp[1], pid: 11 }], new Set(), new Set([10, 11]), { sourceObservation: sdkObservation() }), /no exact SDK request ID match/u);
});

test('startup, find and doctor allow read-only Notion metadata', () => {
  for (const pid of [10, 20, 30]) {
    const request = { origin: 'https://api.notion.com', pid, method: 'GET', path: '/v1/pages/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
    assert.equal(classifyDailyNotionRequest(request), 'metadata');
    assert.equal(classifyDailyNotionRequest({ ...request, method: 'POST', path: '/v1/views/view-id/queries' }), 'metadata');
    assert.equal(classifyDailyNotionRequest({ ...request, method: 'POST', path: '/v1/data_sources/source-id/query' }), 'metadata');
    assert.equal(classifyDailyNotionRequest({ ...request, method: 'POST', path: '/v1/search' }), 'metadata');
  }
});

test('doctor and other source processes reject body reads and every semantic write', () => {
  for (const pid of [10, 20, 30]) {
    const request = { origin: 'https://api.notion.com', pid, method: 'GET', path: '/v1/pages/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
    for (const path of [request.path + '/markdown', '/v1/blocks/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '/v1/blocks/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/children'])
      assert.throws(() => classifyDailyNotionRequest({ ...request, path }), /must not load Skill bodies/u);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      assert.throws(() => classifyDailyNotionRequest({ ...request, method }), /remote mutation/u);
    assert.throws(() => classifyDailyNotionRequest({ ...request, origin: 'https://example.com' }), /Unexpected provider/u);
  }
});
