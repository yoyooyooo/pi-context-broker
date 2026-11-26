import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createSecureServer } from 'node:http2';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fileInventory } from './next-build-identity.mjs';
import { resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { readSourceObservation, sourceObserverPreloadSource } from './skill-consumption-source-observer.mjs';
import { aggregateDailyDeliveries, classifyDailyHttp, classifyDailyNotionRequest, dailyObserverPreloadSource, observedDailyHostProcess, validateDailyDoctor, validateDailyDoctorCli, validateDailyFind, validateDailyLibraryRequests, validateDailySdkOperations, verifyDailyCliShim, verifyDailyPackageSource } from './verify-pi-daily-installation.mjs';
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
  assert.equal(loader.createJiti().origin, await realpath(f.loader), 'Workflow loading must follow the observed Pi package, including through a shell launcher');
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
  const source = { sources: [{ id: 'notion', type: 'notion', library: '44444444-4444-4444-8444-444444444444', prefetch: false }] };
  await Promise.all([dirname(sourcePath), dirname(skillPath), join(f.broker, 'dist')].map(path => mkdir(path, { recursive: true })));
  await writeFile(settingsPath, JSON.stringify(settings));
  await writeFile(sourcePath, JSON.stringify(source));
  await writeFile(skillPath, skill);
  const embeddedCli = 'throw new Error("Fixture CLI must not execute");\n', embeddedSdk = 'throw new Error("Fixture SDK must not execute");\n';
  await writeFile(join(f.broker, 'dist/ntn-skills.mjs'), embeddedCli);
  await writeFile(join(f.broker, 'dist/ntn-skills-sdk.mjs'), embeddedSdk);
  const embeddedRef = 'throw new Error("Fixture pure module must not execute");\n';
  await writeFile(join(f.broker, 'dist/ntn-skills-ref.cjs'), embeddedRef);
  await writeFile(join(f.cliRoot, 'dist/ref.cjs'), embeddedRef);
  await writeFile(join(f.broker, 'dist/ntn-skills-runtime.json'), JSON.stringify({ version: 1, package: 'ntn-skills', cli_sha256: digest(embeddedCli), sdk_sha256: digest(embeddedSdk), sdk_version: 3, skill_ref_version: 2, ref_sha256: digest(embeddedRef) }));
  const config = { ...f.config, version: 1, library: source.sources[0].library, packageCount: 2, packageIndex: 1, brokerRoot: f.broker,
    delivery: { id: randomUUID(), startedAt: new Date().toISOString() },
    embeddedCliSha256: digest(embeddedCli), embeddedSdkSha256: digest(embeddedSdk), evidenceRoot: join(f.root, 'evidence') };
  // This public run crosses the real current-worktree boundary using owned local origins.
  // The controlled Pi still exits before any extension, RPC or service operation.
  config.worktrees = {};
  await mkdir(join(f.cliRoot, 'skills'));
  await writeFile(join(f.cliRoot, 'skills/SKILL.md'), '# Controlled skill\n');
  await writeFile(join(f.cliRoot, 'dist/sdk.js'), embeddedSdk);
  await writeFile(join(f.cliRoot, 'THIRD_PARTY_NOTICES.md'), 'controlled complete third-party notices\n');
  await writeFile(join(f.cliRoot, 'package.json'), '{"type":"module"}\n');
  for (const [name, pkg] of [['cli', f.cliRoot], ['broker', f.broker]]) {
    const root = dirname(dirname(pkg)), origin = join(f.root, name + '-origin.git');
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/current.ts'), 'export const fixture = true;\n');
    const build = { version: 1, kind: name + '-build', input_roots: ['src'], source: await fileInventory(root, ['src']),
      artifacts: await fileInventory(pkg, name === 'cli' ? ['dist/ntn-skills.js', 'dist/sdk.js', 'dist/ref.cjs', 'skills'] : ['dist/ntn-skills.mjs', 'dist/ntn-skills-sdk.mjs', 'dist/ntn-skills-ref.cjs', 'dist/ntn-skills-runtime.json']) };
    if (name === 'broker') build.selected_cli = await fileInventory(f.cliRoot, ['package.json', 'dist/ntn-skills.js', 'dist/sdk.js', 'dist/ref.cjs', 'skills', 'THIRD_PARTY_NOTICES.md']);
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
    { event: 'http_end', pid: 20, id: 'source', status: 200 },
    { event: 'http_end', pid: 21, id: 'source-child', status: 200 },
    { event: 'http_start', pid: 31, id: 'other-plugin' },
  ];
  const result = classifyDailyHttp(observed, new Set([20]), new Set([10]));
  assert.deepEqual(result.source.map(row => row.id), ['source', 'source-child']);
  assert.deepEqual(result.otherPlugins.map(row => row.id), ['other-plugin']);
});

test('bundled CLI HTTP retains its unique independent response structure', () => {
  const root = '11111111-1111-4111-8111-111111111111';
  const request = { event: 'http_start', pid: 20, id: '20:1', origin: 'https://api.notion.com',
    method: 'GET', path: '/v1/blocks/' + root + '/children', cursor_sha256: null };
  const terminal = { event: 'http_end', pid: 20, id: request.id, status: 200,
    library_structure: { kind: 'root-children', root, has_more: false, next_cursor_sha256: null, children: [] } };
  const ancestry = { event: 'spawn', pid: 10, child_pid: 20 };
  const result = classifyDailyHttp([ancestry, request, terminal], new Set([20]), new Set([10]));
  assert.deepEqual(result.source[0].structure, terminal.library_structure);
  assert.deepEqual(result.source[0].response, terminal);
  for (const terminals of [[], [terminal, { ...terminal }], [{ ...terminal, pid: 21 }],
    [{ ...terminal, event: 'http_error' }], [{ ...terminal, status: 403 }]]) {
    assert.throws(() => classifyDailyHttp([ancestry, request, ...terminals], new Set([20]), new Set([10])));
  }
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

for (const operation of ['library', 'list', 'files', 'resolve']) test(operation + ' host SDK HTTP needs an exact complete operation and independent response request ID', () => {
  const observation = sdkObservation();
  observation.events = observation.events.map(event => event.operation ? { ...event, operation } : event);
  const result = classifyDailyHttp(sdkHttp, new Set(), new Set([10]), { sourceObservation: observation });
  assert.equal(result.sdk.length, 1);
  assert.equal(result.source.length, 1);
  assert.equal(result.sdk[0].attribution.operation, operation);
  assert.equal(result.sdk[0].attribution.requestId, 'sdk:10:one');
  assert.equal(result.sdk[0].attribution.response_bytes, 100);
});

const libraryRoot = '11111111-1111-4111-8111-111111111111';
const libraryDatabase = '22222222-2222-4222-8222-222222222222';
const libraryDataSource = '33333333-3333-4333-8333-333333333333';
const foreignRoot = '44444444-4444-4444-8444-444444444444';
function libraryRequests() {
  const request = (path, structure, operation = 'library') => ({ origin: 'https://api.notion.com', method: 'GET', path, structure,
    attribution: { kind: 'sdk', operation, library: libraryRoot, source_id: 'same-source-name', requestId: operation + ':1', request_kind: 'notion_metadata' } });
  const active = { in_trash: false, archived: false };
  return [
    request('/v1/pages/' + libraryRoot, { kind: 'page', id: libraryRoot, ...active }),
    { ...request('/v1/blocks/' + libraryRoot + '/children', { kind: 'root-children', root: libraryRoot, has_more: false, next_cursor_sha256: null,
      children: [{ id: libraryDatabase, type: 'child_database', parent: { type: 'page_id', page_id: libraryRoot }, ...active }] }),
      cursor_sha256: null, attribution: { kind: 'sdk', operation: 'library', library: libraryRoot, requestId: 'library:1', request_kind: 'notion_body', target: { block_id: libraryRoot } } },
    request('/v1/databases/' + libraryDatabase, { kind: 'database', id: libraryDatabase, parent: { type: 'page_id', page_id: libraryRoot }, data_source_ids: [libraryDataSource], ...active }),
    request('/v1/data_sources/' + libraryDataSource, { kind: 'data_source', id: libraryDataSource, parent: { type: 'database_id', database_id: libraryDatabase }, ...active }),
    { ...request('/v1/data_sources/' + libraryDataSource + '/query', undefined, 'list'), method: 'POST' },
  ];
}

function doctorCliObservation() {
  const at = ms => new Date(Date.UTC(2026, 0, 2) + ms).toISOString();
  const expected = { library: libraryRoot, hostPid: 10, entry: '/controlled/broker/dist/ntn-skills.mjs',
    sha256: 'a'.repeat(64), executable: '/controlled/node',
    phase: { command: '/context-broker doctor', disposition: 'handled', startedAt: at(0), finishedAt: at(4000) } };
  const args = ['ctl', 'doctor', '--library', libraryRoot], pid = 20;
  const meta = { pid: 10, child_pid: pid, executable: expected.executable, script: expected.entry,
    real_script: expected.entry, bundled_cli: true, script_sha256: expected.sha256 };
  const rows = [
    { ...meta, event: 'spawn', at: at(1000), cli_args: [...args] },
    { event: 'process_start', pid, ppid: 10, at: at(1001), executable: expected.executable,
      real_entry: expected.entry, entry_sha256: expected.sha256, args_sha256: createHash('sha256').update(JSON.stringify(args)).digest('hex') },
  ];
  for (const [index, request] of libraryRequests().entries()) {
    const { attribution, structure, ...http } = request;
    const start = { ...http, event: 'http_start', pid, id: pid + ':' + (index + 1), at: at(2000 + index * 10) };
    rows.push({ ...start, event: 'http_created' }, start,
      { event: 'http_end', pid, id: start.id, at: at(2001 + index * 10), status: 200,
        ...(structure ? { library_structure: structure } : {}) });
  }
  rows.push({ event: 'process_exit', pid, at: at(3000), code: 0 },
    { event: 'http_observer_end', pid, at: at(3000), complete: true, errors: 0, pending: [] },
    { ...meta, event: 'child_close', at: at(3001), cli_args: [...args], code: 0, signal: null,
      stdout_bytes: 100, stdout_sha256: 'b'.repeat(64),
      receipt: { ok: true, transport: 'direct_http', notion_api_version: '2026-03-11',
        authentication: 'available', skill_read: { checked: false } } });
  return { rows, expected, at };
}

test('explicit doctor proves its own process and complete root without borrowing SDK metrics', () => {
  const { rows, expected } = doctorCliObservation();
  const proof = validateDailyDoctorCli(rows, expected);
  assert.equal(proof.library_structure.root_children_requests, 1);
  assert.equal(proof.http.length, 5);
  assert.deepEqual(proof.library_structure.operations[0].data_sources,
    [{ data_source_id: libraryDataSource, database_id: libraryDatabase }]);
  assert.ok(proof.http.every(request => request.attribution.kind === 'doctor' && request.attribution.cli_pid === 20));
  assert.ok(proof.http.every(request => !Object.hasOwn(request.attribution, 'request_kind')));
  assert.throws(() => validateDailyLibraryRequests(proof.http, libraryRoot));
  assert.deepEqual(validateDailyDoctorCli(proof.observations, expected), proof);
});

test('doctor rejects substituted process identity, argv, owner, phase, exit or observer completion', () => {
  for (const mutate of [
    rows => { rows.find(row => row.event === 'spawn').pid = 99; },
    rows => { rows.find(row => row.event === 'spawn').cli_args.push('--skill', foreignRoot); },
    rows => { rows.find(row => row.event === 'spawn').cli_args[3] = foreignRoot; },
    rows => { rows.find(row => row.event === 'spawn').script_sha256 = 'c'.repeat(64); },
    rows => { rows.find(row => row.event === 'spawn').at = '2026-01-01T00:00:00.000Z'; },
    rows => { rows.push({ ...rows.find(row => row.event === 'spawn'), child_pid: 21 }); },
    rows => { rows.find(row => row.event === 'process_start').ppid = 99; },
    rows => { rows.find(row => row.event === 'process_start').real_entry += '.other'; },
    rows => { rows.find(row => row.event === 'process_start').args_sha256 = 'c'.repeat(64); },
    rows => { rows.push({ ...rows.find(row => row.event === 'process_start') }); },
    rows => { rows.splice(rows.findIndex(row => row.event === 'process_start'), 1); },
    rows => { rows.find(row => row.event === 'process_exit').code = 1; },
    rows => { rows.find(row => row.event === 'child_close').signal = 'SIGTERM'; },
    rows => { rows.find(row => row.event === 'child_close').receipt.skill_read.checked = true; },
    rows => { rows.find(row => row.event === 'child_close').at = '2026-01-02T00:00:05.000Z'; },
    rows => { rows.find(row => row.event === 'http_observer_end').pending = ['20:unfinished']; },
    rows => { rows.find(row => row.event === 'http_observer_end').complete = false; },
    rows => { rows.splice(rows.findIndex(row => row.event === 'http_observer_end'), 1); },
  ]) {
    const { rows, expected } = doctorCliObservation(); mutate(rows);
    assert.throws(() => validateDailyDoctorCli(rows, expected));
  }
});

test('doctor cannot borrow SDK structure or authorize missing, foreign, partial or unowned HTTP', () => {
  const response = (rows, path) => {
    const request = rows.find(row => row.event === 'http_start' && row.path === path);
    return rows.find(row => row.event === 'http_end' && row.id === request.id);
  };
  const rootPath = '/v1/blocks/' + libraryRoot + '/children';
  for (const mutate of [
    rows => { response(rows, rootPath).library_structure = null; },
    rows => { response(rows, rootPath).library_structure.root = foreignRoot; },
    rows => { response(rows, rootPath).library_structure.children[0].parent.page_id = foreignRoot; },
    rows => { response(rows, rootPath).library_structure.has_more = true; response(rows, rootPath).library_structure.next_cursor_sha256 = 'a'.repeat(64); },
    rows => { response(rows, rootPath).library_structure.children.push(structuredClone(response(rows, rootPath).library_structure.children[0])); },
    rows => { rows.find(row => row.event === 'http_start' && row.path === rootPath).cursor_sha256 = 'a'.repeat(64); },
    rows => { response(rows, '/v1/databases/' + libraryDatabase).library_structure.parent.page_id = foreignRoot; },
    rows => { response(rows, '/v1/databases/' + libraryDatabase).library_structure.data_source_ids.push(foreignRoot); },
    rows => { response(rows, '/v1/data_sources/' + libraryDataSource).library_structure.parent.database_id = foreignRoot; },
    rows => { response(rows, rootPath).status = 403; },
    rows => { response(rows, rootPath).pid = 99; },
    rows => { rows.push({ ...response(rows, rootPath) }); },
    rows => { rows.splice(rows.indexOf(response(rows, rootPath)), 1); },
    rows => { response(rows, rootPath).at = '2026-01-02T00:00:05.000Z'; },
    rows => { rows.find(row => row.event === 'http_created' && row.path === rootPath).path = '/v1/blocks/' + foreignRoot + '/children'; },
    rows => {
      const query = '/v1/data_sources/' + libraryDataSource + '/query';
      for (const row of rows.filter(row => row.path === query)) row.path = '/v1/data_sources/' + foreignRoot + '/query';
    },
    rows => {
      for (const row of rows.filter(row => row.path === rootPath)) row.path = '/v1/blocks/' + foreignRoot + '/children';
    },
    rows => {
      for (const row of rows.filter(row => row.path === '/v1/pages/' + libraryRoot)) row.path += '/markdown';
    },
    rows => {
      for (const row of rows.filter(row => row.path === '/v1/data_sources/' + libraryDataSource + '/query')) row.method = 'DELETE';
    },
    rows => {
      rows.push({ event: 'process_start', pid: 21, ppid: 20, at: '2026-01-02T00:00:01.500Z' });
      for (const row of rows.filter(row => ['http_created', 'http_start', 'http_end'].includes(row.event))) row.pid = 21;
    },
  ]) {
    const { rows, expected } = doctorCliObservation(); mutate(rows);
    assert.throws(() => validateDailyDoctorCli(rows, expected));
  }
});

test('daily SDK3 selection is local and remote metadata keeps the exact expected root', () => {
  const operations = ['library-selection', 'candidates', 'library', 'list'].map(operation => ({ operation, source_id: 'same-source-name', library: operation === 'library-selection' ? null : libraryRoot }));
  assert.doesNotThrow(() => validateDailySdkOperations(operations, libraryRoot));
  for (const operation of ['candidates', 'library', 'list']) assert.throws(() => validateDailySdkOperations(
    operations.map(row => row.operation === operation ? { ...row, library: foreignRoot } : row), libraryRoot), /another Library/u);
  assert.throws(() => validateDailySdkOperations(operations.map(row => row.operation === 'candidates' ? { ...row, library: null } : row), libraryRoot), /another Library/u);
  assert.throws(() => validateDailySdkOperations(operations.filter(row => row.operation !== 'list'), libraryRoot), /Actual SDK catalog discovery/u);
  for (const operation of ['consume', 'read', 'files', 'read-resources', 'resolve', 'content-search', 'future-operation'])
    assert.throws(() => validateDailySdkOperations([...operations, { operation, library: libraryRoot }], libraryRoot), /cannot consume/u);
});

for (const operation of ['library-selection', 'candidates']) test(operation + ' cannot attribute HTTP to a local operation', () => {
  const local = sdkObservation();
  local.events = local.events.map(row => row.operation ? { ...row, operation } : row);
  assert.throws(() => classifyDailyHttp(sdkHttp, new Set(), new Set([10]), { sourceObservation: local }), /cannot perform HTTP/u);
  local.events = local.events.filter(row => row.phase !== 'attempt').map(row => row.phase === 'metrics' ? { ...row, total_requests: 0 } : row);
  assert.equal(classifyDailyHttp([], new Set(), new Set([10]), { sourceObservation: local }).source.length, 0);
  assert.throws(() => classifyDailyHttp(sdkHttp, new Set(), new Set([10]), { sourceObservation: local }), /no exact SDK request ID match/u);
  const waited = structuredClone(local);
  waited.events.splice(2, 0, { phase: 'wait', kind: 'http', requestId: 'sdk:10:one', wait_kind: 'queue', milliseconds: 1 });
  assert.throws(() => classifyDailyHttp([], new Set(), new Set([10]), { sourceObservation: waited }), /HTTP trace/u);
});

for (const operation of ['library-selection', 'candidates']) test(operation + ' still requires observed complete zero-request metrics', () => {
  const local = sdkObservation();
  local.events = local.events.filter(row => row.phase !== 'attempt').map(row => row.operation
    ? { ...row, operation }
    : row.phase === 'metrics' ? { ...row, total_requests: 0 } : row);
  assert.equal(classifyDailyHttp([], new Set(), new Set([10]), { sourceObservation: local }).sdk.length, 0);
  for (const metrics of [
    { observed: false, complete: false, total_requests: null },
    { observed: false, complete: true, total_requests: 0 },
    { observed: true, complete: false, total_requests: 0 },
    { observed: true, complete: true, total_requests: 1 },
  ]) {
    const invalid = { ...local, events: local.events.map(row => row.phase === 'metrics' ? { ...row, ...metrics } : row) };
    assert.throws(() => classifyDailyHttp([], new Set(), new Set([10]), { sourceObservation: invalid }));
  }
});

test('independent direct-root descriptors authorize the exact structure read and later catalog query', () => {
  const proof = validateDailyLibraryRequests(libraryRequests(), libraryRoot);
  assert.equal(proof.library_id, libraryRoot); assert.equal(proof.root_children_requests, 1);
  assert.deepEqual(proof.operations.map(row => row.operation), ['library', 'list']);
  assert.deepEqual(proof.operations[0].data_sources, [{ data_source_id: libraryDataSource, database_id: libraryDatabase }]);
  const paginated = libraryRequests(), next = 'a'.repeat(64), first = paginated[1];
  first.structure.has_more = true; first.structure.next_cursor_sha256 = next;
  paginated.splice(2, 0, { ...structuredClone(first), cursor_sha256: next,
    structure: { kind: 'root-children', root: libraryRoot, children: [], has_more: false, next_cursor_sha256: null } });
  assert.equal(validateDailyLibraryRequests(paginated, libraryRoot).root_children_requests, 2);
});

test('root proofs reject foreign or truncated children, orphan data sources, and body reads', () => {
  for (const mutate of [
    rows => { rows[1].structure.children[0].parent.page_id = foreignRoot; },
    rows => { rows[1].structure.has_more = true; rows[1].structure.next_cursor_sha256 = 'a'.repeat(64); },
    rows => { rows[1].cursor_sha256 = 'a'.repeat(64); },
    rows => { rows[1].structure.children.push(structuredClone(rows[1].structure.children[0])); },
    rows => { rows[2].structure.parent.page_id = foreignRoot; },
    rows => { rows[3].structure.parent.database_id = foreignRoot; },
    rows => { rows[2].structure.data_source_ids = [foreignRoot]; },
    rows => { rows[2].structure.data_source_ids.push(foreignRoot); },
    rows => { rows[3].path = '/v1/data_sources/' + foreignRoot; rows[3].structure.id = foreignRoot; },
    rows => { rows[4].path = '/v1/data_sources/' + foreignRoot + '/query'; },
    rows => { rows[4].attribution.library = foreignRoot; },
    rows => { rows[1].attribution.target.block_id = foreignRoot; },
    rows => { rows[1].attribution.request_kind = 'notion_metadata'; },
    rows => { rows[0].method = 'PATCH'; },
    rows => { rows.push({ ...structuredClone(rows[4]), method: 'GET', path: '/v1/blocks/' + foreignRoot + '/children' }); },
    rows => { rows.push({ ...structuredClone(rows[4]), method: 'GET', path: '/v1/pages/' + libraryRoot + '/markdown' }); },
    rows => { rows.push({ ...structuredClone(rows[0]), path: '/v1/pages/' + foreignRoot }); },
    rows => { rows.push({ ...structuredClone(rows[4]), method: 'GET', path: '/v1/pages/' + foreignRoot }); },
    rows => { rows.push({ ...structuredClone(rows[4]), method: 'GET', path: '/v1/pages/' + foreignRoot + '/properties/name' }); },
    rows => { rows.push({ ...structuredClone(rows[4]), method: 'POST', path: '/v1/search' }); },
    rows => { rows.push({ ...structuredClone(rows[4]), method: 'GET', path: '/v1/views', view_database_id: foreignRoot }); },
  ]) {
    const rows = libraryRequests(); mutate(rows);
    assert.throws(() => validateDailyLibraryRequests(rows, libraryRoot));
  }
});

test('catalog View metadata and query endpoints require independent direct-table ownership', () => {
  const rows = libraryRequests(), view = '55555555-5555-4555-8555-555555555555', query = '66666666-6666-4666-8666-666666666666';
  const request = (method, path) => ({ ...structuredClone(rows[4]), method, path });
  rows.push({ ...request('GET', '/v1/views'), view_database_id: libraryDatabase },
    { ...request('GET', '/v1/views/' + view), structure: { kind: 'view', id: view,
      parent: { type: 'database_id', database_id: libraryDatabase }, data_source_id: libraryDataSource } },
    request('POST', '/v1/views/' + view + '/queries'), request('GET', '/v1/views/' + view + '/queries/' + query));
  const proof = validateDailyLibraryRequests(rows, libraryRoot);
  assert.deepEqual(proof.operations.at(-1).views, [{ view_id: view, database_id: libraryDatabase, data_source_id: libraryDataSource }]);
  for (const mutate of [
    value => { value[5].view_database_id = foreignRoot; },
    value => { value[6].structure.parent.database_id = foreignRoot; },
    value => { value[6].structure.data_source_id = foreignRoot; },
    value => { value[6].structure.id = foreignRoot; },
    value => { value[7].path = '/v1/views/' + foreignRoot + '/queries'; },
    value => { value[8].path = '/v1/views/' + foreignRoot + '/queries/' + query; },
    value => { value.splice(6, 1); },
  ]) { const changed = structuredClone(rows); mutate(changed); assert.throws(() => validateDailyLibraryRequests(changed, libraryRoot)); }
});

test('passive HTTP projects only Library structure identities and preserves original response bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'daily-root-structure-'));
  const preload = dailyObserverPreloadSource({ directory, cliEntry: join(directory, 'unused-cli.js'), library: libraryRoot,
    responseRequestIdBodyOrigins: ['http://controlled-root.test'] });
  const values = {
    ['/v1/pages/' + libraryRoot]: { object: 'page', id: libraryRoot, properties: { secret: 'UNRECORDED_AUTHOR_TEXT' } },
    ['/v1/blocks/' + libraryRoot + '/children']: { object: 'list', has_more: false, next_cursor: null,
      results: [{ id: libraryDatabase, type: 'child_database', parent: { type: 'page_id', page_id: libraryRoot }, child_database: { title: 'UNRECORDED_AUTHOR_TEXT' } }] },
    ['/v1/databases/' + libraryDatabase]: { object: 'database', id: libraryDatabase, parent: { type: 'page_id', page_id: libraryRoot }, data_sources: [{ id: libraryDataSource, name: 'UNRECORDED_AUTHOR_TEXT' }] },
    ['/v1/data_sources/' + libraryDataSource]: { object: 'data_source', id: libraryDataSource, parent: { type: 'database_id', database_id: libraryDatabase }, properties: { Name: 'UNRECORDED_AUTHOR_TEXT' } },
    ['/v1/views?database_id=' + libraryDatabase]: { results: [{ object: 'view', id: foreignRoot }], has_more: false, next_cursor: null },
    ['/v1/views/' + foreignRoot]: { id: foreignRoot, type: 'table', name: 'UNRECORDED_AUTHOR_TEXT', parent: { type: 'database_id', database_id: libraryDatabase }, data_source_id: libraryDataSource },
    ['/v1/blocks/' + foreignRoot + '/children']: { object: 'list', results: [{ paragraph: 'UNRECORDED_AUTHOR_TEXT' }] },
  };
  const child = `
    const http = require('node:http'), vm = require('node:vm'); const values = ${JSON.stringify(values)};
    const retainedFetch = globalThis.fetch;
    const server = http.createServer((req,res) => { res.writeHead(200, {'content-type':'application/json','x-request-id':'${sdkRequestId}'}); res.end(JSON.stringify(values[req.url])); });
    (async () => { await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      try { const origin='http://127.0.0.1:'+server.address().port;
        vm.runInThisContext(${JSON.stringify(preload)}.replaceAll('http://controlled-root.test',origin));
        if(globalThis.fetch!==retainedFetch) throw new Error('Observer replaced fetch');
        for(const [path,value] of Object.entries(values)){ const response=await retainedFetch(origin+path); if(await response.text()!==JSON.stringify(value))throw new Error('Response changed'); }
      } finally { await new Promise(resolve=>server.close(resolve)); }
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  execFileSync(process.execPath, ['-e', child], { timeout: 15000, stdio: 'pipe' });
  const raw = (await Promise.all((await readdir(directory)).map(file => readFile(join(directory, file), 'utf8')))).join('');
  assert.equal(raw.includes('UNRECORDED_AUTHOR_TEXT'), false);
  const rows = raw.trim().split('\n').map(JSON.parse), projections = rows.filter(row => row.event === 'http_end' && row.library_structure);
  assert.deepEqual(projections.map(row => row.library_structure.kind), ['page', 'root-children', 'database', 'data_source', 'view']);
  assert.equal(rows.filter(row => row.event === 'http_end').length, 7);
  assert.equal(projections[1].library_structure.children[0].parent.page_id, libraryRoot);
  assert.deepEqual(projections[2].library_structure.data_source_ids, [libraryDataSource]);
  assert.equal(projections[3].library_structure.parent.database_id, libraryDatabase);
  assert.equal(rows.find(row => row.event === 'http_start' && row.path === '/v1/views').view_database_id, libraryDatabase);
  assert.equal(projections[4].library_structure.parent.database_id, libraryDatabase);
  assert.equal(projections[4].library_structure.data_source_id, libraryDataSource);
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


test('daily observer preserves real proxy CONNECT authority separately from tunneled application HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'daily-proxy-connect-')), preload = join(directory, 'observe.cjs');
  const cert = join(directory, 'cert.pem'), key = join(directory, 'key.pem'), certConfig = join(directory, 'cert.cnf');
  await writeFile(certConfig, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n', { mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', certConfig], { timeout: 10000, stdio: 'pipe' });
  await writeFile(preload, dailyObserverPreloadSource({ directory, cliEntry: join(directory, 'unused-cli.js') }));
  const client = `fetch(process.argv[1]).then(async response => {
    const body = await response.text(); if (response.status !== 200 || body !== 'tunneled metadata') throw new Error('Response changed');
  }).catch(error => { console.error(error); process.exitCode = 1; });`;
  const child = `
    const http = require('node:http'), https = require('node:https'), net = require('node:net');
    const {readFileSync} = require('node:fs'), {spawn} = require('node:child_process');
    const sockets = new Set(); let connections = 0;
    const target = https.createServer({ cert: readFileSync(${JSON.stringify(cert)}), key: readFileSync(${JSON.stringify(key)}) },
      (_request, response) => { response.end('tunneled metadata'); });
    const proxy = http.createServer((_request, response) => { response.writeHead(500); response.end('Expected CONNECT'); });
    proxy.on('connect', (request, socket, head) => {
      if (request.url !== '127.0.0.1:' + target.address().port) return socket.destroy();
      connections++; sockets.add(socket);
      const upstream = net.connect(target.address().port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
        if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
      });
      sockets.add(upstream); upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    });
    (async () => {
      await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
      await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
      const origin = 'http://127.0.0.1:' + proxy.address().port;
      try {
        const code = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['--require', ${JSON.stringify(preload)}, '-e', ${JSON.stringify(client)},
            'https://127.0.0.1:' + target.address().port + '/metadata'], { stdio: 'inherit', timeout: 8000, killSignal: 'SIGTERM', env: { ...process.env,
              HTTP_PROXY: origin, HTTPS_PROXY: origin, http_proxy: origin, https_proxy: origin,
              NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '1', NODE_EXTRA_CA_CERTS: ${JSON.stringify(cert)},
              NODE_TLS_REJECT_UNAUTHORIZED: '1' } });
          child.once('error', reject); child.once('close', resolve);
        });
        if (code !== 0 || connections !== 1) throw new Error('The actual proxy tunnel was not observed');
      } finally {
        for (const socket of sockets) socket.destroy(); target.closeAllConnections(); proxy.closeAllConnections();
        await Promise.all([new Promise(resolve => target.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  execFileSync(process.execPath, ['-e', child], { timeout: 15000, stdio: 'pipe' });
  const rows = (await Promise.all((await readdir(directory)).filter(name => name.endsWith('.jsonl'))
    .map(file => readFile(join(directory, file), 'utf8')))).flatMap(text => text.trim().split('\n').map(JSON.parse));
  const starts = rows.filter(row => row.event === 'http_start');
  assert.equal(starts.length, 2);
  const tunnel = starts.find(row => row.method === 'CONNECT'), application = starts.find(row => row.method === 'GET');
  assert.equal(tunnel.transport, 'proxy-connect'); assert.equal(tunnel.path, null); assert.equal(tunnel.request_bytes, 0);
  assert.match(tunnel.authority, /^127\.0\.0\.1:[0-9]+$/u);
  assert.match(tunnel.origin, /^http:\/\/127\.0\.0\.1:[0-9]+$/u);
  assert.equal(application.path, '/metadata'); assert.equal(application.transport, undefined);
  assert.equal(application.origin, 'https://' + tunnel.authority);
  assert.notEqual(tunnel.origin, application.origin);
  assert.ok(rows.some(row => row.event === 'http_end' && row.id === tunnel.id && row.status === 200));
  assert.ok(rows.some(row => row.event === 'http_observer_end' && row.complete === true && row.errors === 0));
});

test('proxy setup retains source ancestry, failures and pre-send attempts without satisfying SDK metadata evidence', () => {
  const tunnel = { event: 'http_start', id: '10:tunnel', pid: 10, method: 'CONNECT', transport: 'proxy-connect',
    origin: 'http://127.0.0.1:7890', path: null, authority: 'api.notion.com:443', request_bytes: 0 };
  const complete = { event: 'http_end', id: tunnel.id, pid: 10, status: 200, response_request_id: null };
  const childTunnel = { ...tunnel, id: '20:tunnel', pid: 20 };
  const failed = { event: 'http_error', id: childTunnel.id, pid: 20, code: 'ECONNRESET' };
  const pending = { ...tunnel, event: 'http_created', id: '10:pending' }; delete pending.request_bytes;
  const rows = [...sdkHttp, tunnel, complete, childTunnel, failed, pending];
  const result = classifyDailyHttp(rows, new Set([20]), new Set([10]), { sourceObservation: sdkObservation() });
  assert.equal(result.source.length, 1); assert.equal(result.sdk.length, 1);
  assert.deepEqual(result.proxyTunnels, [
    { ...tunnel, role: 'host', outcomes: [complete] },
    { ...childTunnel, role: 'source', outcomes: [failed] },
    { ...pending, role: 'host', outcomes: [] },
  ]);
  assert.throws(() => classifyDailyHttp([tunnel, complete], new Set(), new Set([10]), { sourceObservation: sdkObservation() }),
    /SDK attempt lacks independent HTTP evidence/u);
  for (const changed of [
    { ...tunnel, transport: undefined }, { ...tunnel, method: 'POST' }, { ...tunnel, request_bytes: 7 },
    { ...tunnel, authority: 'user:password@api.notion.com:443' }, { ...tunnel, origin: 'null' },
    { ...tunnel, pid: 99 }, { ...tunnel, authority: 'api.notion.com:443/hidden' },
  ]) assert.throws(() => classifyDailyHttp([...sdkHttp, changed], new Set([20]), new Set([10]), { sourceObservation: sdkObservation() }));
  assert.throws(() => classifyDailyHttp([...sdkHttp, tunnel, { ...complete, response_request_id: sdkRequestId }],
    new Set(), new Set([10]), { sourceObservation: sdkObservation() }), /cannot replace an SDK response/u);
});

// Require actual ALPN h2; keep the selected public fetch and Agent on one handler API.
test('passive observer preserves H1/H2 bytes and complete Library structure with header/body request IDs', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'daily-observer-h1-h2-'));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  // Select the declared runtime dependency, not Node's version-specific H2 default.
  const selected = createRequire(process.env.NTN_SKILLS_BUILD_ENTRY ?? new URL('../packages/context-broker/package.json', import.meta.url));
  const platformManifest = selected.resolve('@effect/platform-node/package.json');
  const runtime = createRequire(platformManifest), entry = await realpath(runtime.resolve('undici'));
  const manifest = await realpath(runtime.resolve('undici/package.json'));
  const dispatcher = { entry, manifest, version: JSON.parse(await readFile(manifest, 'utf8')).version,
    entry_sha256: hash(await readFile(entry)), platform_manifest: await realpath(platformManifest) };
  const root = '00000000-0000-4000-8000-000000000101', database = '00000000-0000-4000-8000-000000000102', dataSource = '00000000-0000-4000-8000-000000000103';
  const headerId = '00000000-0000-4000-8000-000000000301', bodyId = '00000000-0000-4000-8000-000000000302';
  const marker = 'UNRECORDED_AUTHOR_TEXT_H2_REGRESSION';
  const values = {
    ['/v1/pages/' + root]: { object: 'page', id: root, request_id: bodyId, properties: { secret: marker } },
    ['/v1/blocks/' + root + '/children']: { object: 'list', request_id: bodyId, has_more: false, next_cursor: null, results: [{ id: database, type: 'child_database', parent: { type: 'page_id', page_id: root }, child_database: { title: marker } }] },
    ['/v1/databases/' + database]: { object: 'database', id: database, request_id: bodyId, parent: { type: 'page_id', page_id: root }, data_sources: [{ id: dataSource, name: marker }] },
    ['/v1/data_sources/' + dataSource]: { object: 'data_source', id: dataSource, request_id: bodyId, parent: { type: 'database_id', database_id: database }, properties: { Name: marker } },
  };
  const cert = join(directory, 'cert.pem'), key = join(directory, 'key.pem'), config = join(directory, 'cert.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n', { flag: 'wx', mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', config], { timeout: 10000, stdio: 'pipe' });
  const sockets = new Set(), sessions = new Set(), served = [];
  const handle = transport => (request, response) => {
    const url = new URL(request.url, 'https://127.0.0.1'), body = JSON.stringify(values[url.pathname]);
    assert.ok(body);
    served.push({ transport, source: url.searchParams.get('source'), path: url.pathname, httpVersion: request.httpVersion, alpn: request.socket.alpnProtocol, bytes: Buffer.byteLength(body), sha256: hash(body) });
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'identity', ...(url.searchParams.get('source') === 'header' ? { 'x-request-id': headerId } : {}) });
    response.end(body);
  };
  const tls = { cert: await readFile(cert), key: await readFile(key) };
  const servers = [createServer(tls, handle('h1')), createSecureServer({ ...tls, allowHTTP1: false, ALPNProtocols: ['h2'] }, handle('h2'))];
  for (const server of servers) {
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('session', session => { sessions.add(session); session.once('close', () => sessions.delete(session)); });
  }
  let child;
  try {
    for (const server of servers) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoints = servers.map((server, index) => ({ transport: index ? 'h2' : 'h1', origin: 'https://127.0.0.1:' + server.address().port }));
    const observation = join(directory, 'observation'); await mkdir(observation, { mode: 0o700 });
    const preload = join(directory, 'observe.cjs'), client = join(directory, 'client.cjs'), clientResult = join(directory, 'consumer.json');
    await writeFile(preload, dailyObserverPreloadSource({ directory: observation, cliEntry: join(directory, 'unused-cli.js'), library: root, responseRequestIdBodyOrigins: endpoints.map(endpoint => endpoint.origin) }), { flag: 'wx', mode: 0o600 });
    const code = [
      "const fs=require('node:fs'),dc=require('node:diagnostics_channel'),crypto=require('node:crypto');",
      "const endpoints=" + JSON.stringify(endpoints) + ",values=" + JSON.stringify(values) + ";",
      "const retainedGlobalFetch=globalThis.fetch,dispatcher=" + JSON.stringify(dispatcher) + ";const client=require(dispatcher.entry),{Agent}=client,retainedFetch=client.fetch;",
      "const agents=new Map(endpoints.map(endpoint=>[endpoint.transport,new Agent({allowH2:endpoint.transport==='h2'})]));let activeRequest=null;",
      "new Function('require',fs.readFileSync(" + JSON.stringify(preload) + ",'utf8'))(require);if(globalThis.fetch!==retainedGlobalFetch||client.fetch!==retainedFetch)throw Error('Observer replaced fetch');",
      "const shapes=[],pending=new WeakMap();let sequence=0;",
      "dc.subscribe('undici:request:create',({request})=>pending.set(request,{sequence:++sequence,origin:String(request.origin),path:request.path,bodyChunks:0,bodyBytes:0}));",
      "dc.subscribe('undici:request:headers',({request,response})=>{const row=pending.get(request),headers=response.headers;const keys=Array.isArray(headers)?headers.filter((_,i)=>i%2===0).map(x=>Buffer.isBuffer(x)?x.toString():String(x)):Object.keys(headers??{});Object.assign(row,{array:Array.isArray(headers),type:typeof headers,keys:keys.map(x=>x.toLowerCase()).filter(x=>['content-type','content-encoding','x-request-id'].includes(x)).sort()});});",
      "dc.subscribe('undici:request:bodyChunkReceived',({request,chunk})=>{const row=pending.get(request);row.bodyChunks++;row.bodyBytes+=chunk.byteLength;});",
      "dc.subscribe('undici:request:trailers',({request})=>shapes.push({...pending.get(request)}));",
      "(async()=>{const results=[];try{for(const endpoint of endpoints)for(const source of ['header','body'])for(const [path,value] of Object.entries(values)){",
      "activeRequest={transport:endpoint.transport,source,path};const response=await retainedFetch(endpoint.origin+path+'?source='+source,{dispatcher:agents.get(endpoint.transport)}),body=await response.text();",
      "if(response.status!==200||body!==JSON.stringify(value))throw Error('Response bytes changed');results.push({transport:endpoint.transport,source,path,status:response.status,bytes:Buffer.byteLength(body),sha256:crypto.createHash('sha256').update(body).digest('hex')});}",
      "}finally{await Promise.all([...agents.values()].map(agent=>agent.close()));}if(globalThis.fetch!==retainedGlobalFetch||client.fetch!==retainedFetch)throw Error('Fetch changed');",
      "fs.writeFileSync(" + JSON.stringify(clientResult) + ",JSON.stringify({node:process.version,undici:process.versions.undici,client:'selected-undici-fetch',explicitDispatcher:dispatcher,fetchUnchanged:true,selectedFetchUnchanged:true,results,shapes},null,2)+'\\n',{flag:'wx',mode:0o600});process.exit(0);})().catch(error=>{",
      "const details=value=>({name:value?.name??null,code:value?.code??null,message:value?.message??String(value)});console.error(JSON.stringify({request:activeRequest,node:process.version,builtinUndici:process.versions.undici,client:'selected-undici-fetch',explicitDispatcher:dispatcher,error:details(error),cause:error?.cause?details(error.cause):null}));process.exit(1);});",
    ].join('\n');
    await writeFile(client, code, { flag: 'wx', mode: 0o600 });
    // Trust only this generated local certificate in the owned child; no proxy,
    // credentials, NODE_OPTIONS or global TLS configuration are inherited.
    child = spawn(process.execPath, [client], { cwd: directory, env: { PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin', HOME: directory, LANG: 'en_US.UTF-8', NODE_EXTRA_CA_CERTS: cert }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    const closed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} reject(new Error('Owned loopback child timed out')); }, 20000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    await writeFile(join(directory, 'stdout.log'), stdout, { flag: 'wx' }); await writeFile(join(directory, 'stderr.log'), stderr, { flag: 'wx' });
    assert.equal(closed.code, 0, stderr); assert.equal(closed.signal, null);
    const consumer = JSON.parse(await readFile(clientResult, 'utf8'));
    const raw = (await Promise.all((await readdir(observation)).map(name => readFile(join(observation, name), 'utf8')))).join('');
    assert.equal(raw.includes(marker), false);
    const rows = raw.trim().split('\n').map(JSON.parse), starts = rows.filter(row => row.event === 'http_start'), ends = rows.filter(row => row.event === 'http_end');
    assert.equal(starts.length, 16); assert.equal(ends.length, 16); assert.equal(consumer.results.length, 16); assert.equal(served.length, 16);
    assert.equal(consumer.fetchUnchanged, true);
    assert.deepEqual(consumer.explicitDispatcher, dispatcher);
    assert.equal(consumer.selectedFetchUnchanged, true); assert.equal(consumer.client, 'selected-undici-fetch');
    const expectedKinds = ['page', 'root-children', 'database', 'data_source'];
    for (const [index, start] of starts.entries()) {
      const actual = ends.find(row => row.id === start.id), original = served[index], consumed = consumer.results[index], projection = actual.library_structure;
      assert.equal(actual.status, 200); assert.equal(consumed.sha256, original.sha256); assert.equal(consumed.bytes, original.bytes);
      assert.equal(original.httpVersion, consumed.transport === 'h2' ? '2.0' : '1.1'); assert.equal(original.alpn, consumed.transport === 'h2' ? 'h2' : 'http/1.1');
      assert.equal(consumer.shapes[index].array, consumed.transport === 'h1'); assert.ok(consumer.shapes[index].bodyChunks > 0);
      assert.equal(actual.response_request_id, consumed.source === 'header' ? headerId : bodyId);
      assert.equal(actual.response_request_id_source, consumed.source === 'header' ? 'response-header' : 'response-json');
      assert.equal(projection.kind, expectedKinds[index % 4]);
      if (projection.kind === 'page') assert.equal(projection.id, root);
      if (projection.kind === 'root-children') { assert.equal(projection.root, root); assert.equal(projection.has_more, false); assert.equal(projection.next_cursor_sha256, null); assert.equal(projection.children[0].id, database); assert.equal(projection.children[0].parent.page_id, root); }
      if (projection.kind === 'database') { assert.equal(projection.id, database); assert.equal(projection.parent.page_id, root); assert.deepEqual(projection.data_source_ids, [dataSource]); }
      if (projection.kind === 'data_source') { assert.equal(projection.id, dataSource); assert.equal(projection.parent.database_id, database); }
    }
    assert.ok(rows.find(row => row.event === 'http_observer_end' && row.complete && row.errors === 0 && row.pending.length === 0));
    await writeFile(join(directory, 'result.json'), JSON.stringify({ status: 'passed', node: process.version, undici: process.versions.undici, requests: 16, transports: ['http/1.1', 'h2'], requestIdSources: ['response-header', 'response-json'], completeStructuralProjections: 16, responseBytesUnchanged: true, fetchUnchanged: true, authorTextRecorded: false, served, consumer, child: { pid: child.pid, ...closed }, notionRequests: 0 }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } finally {
    for (const session of sessions) session.destroy(); for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
});
