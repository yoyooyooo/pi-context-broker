import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { brokerRegistryVersion, installBrokerConsumer, verifyBundledRuntime, verifyInstalledArchive, verifyRegistryArtifact, verifyReleaseCliInput } from './verify-package-closure.mjs';

test('publication requires the declared installed SDK and a fixture from that same version', () => {
  const fixture = { brokerManifest: { devDependencies: { 'ntn-skills': '0.4.0' } },
    installedManifest: { name: 'ntn-skills', version: '0.4.0', exports: { './sdk': { import: './dist/sdk.js' } } },
    fixtureManifest: { name: 'ntn-skills', version: '0.4.0' } };
  assert.deepEqual(verifyReleaseCliInput(fixture), { package: 'ntn-skills', version: '0.4.0', fixtureVersion: '0.4.0' });
  for (const change of [
    value => { value.brokerManifest.devDependencies = {}; },
    value => { value.brokerManifest.devDependencies['ntn-skills'] = '^0.4.0'; },
    value => { value.installedManifest.name = 'another-package'; },
    value => { value.installedManifest.version = '0.3.0'; },
    value => { value.installedManifest.exports = {}; },
    value => { value.fixtureManifest.version = '0.3.0'; },
    value => { value.buildEntry = '/unverified/source-cli.js'; },
  ]) {
    const value = structuredClone(fixture); change(value);
    assert.throws(() => verifyReleaseCliInput(value));
  }
});

test('registry verification binds the exact package, version, integrity and candidate bytes', () => {
  const archiveBytes = Buffer.from('verified-candidate');
  const fixture = { spec: 'pi-context-broker@0.2.0', archiveBytes, expectedBytes: archiveBytes,
    metadata: { name: 'pi-context-broker', version: '0.2.0', 'dist.integrity': `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}` } };
  assert.equal(verifyRegistryArtifact(fixture), fixture.metadata['dist.integrity']);
  for (const change of [
    value => { value.metadata.name = 'another-package'; },
    value => { value.metadata.version = '0.1.0'; },
    value => { value.metadata['dist.integrity'] = 'sha512-wrong'; },
    value => { value.expectedBytes = Buffer.from('unverified-candidate'); },
  ]) {
    const value = structuredClone(fixture); change(value);
    assert.throws(() => verifyRegistryArtifact(value));
  }
  for (const spec of ['pi-context-broker', 'pi-context-broker@latest', 'pi-context-broker@^0.2.0', 'pi-context-broker@01.2.0', 'other@0.2.0'])
    assert.throws(() => brokerRegistryVersion(spec));
});

test('installed archive verification rejects altered and leftover package files after an upgrade', async t => {
  const base = await mkdtemp(join(tmpdir(), 'broker-installed-archive-'));
  t.diagnostic(`Package inventory fixture retained at ${base}`);
  const staged = join(base, 'staged');
  await mkdir(staged);
  await writeFile(join(staged, 'package.json'), '{"name":"pi-context-broker","version":"0.2.0"}\n');
  for (const kind of ['exact', 'changed', 'stale']) {
    const installed = join(base, kind);
    await mkdir(installed);
    await copyFile(join(staged, 'package.json'), join(installed, 'package.json'));
    if (kind === 'changed') await writeFile(join(installed, 'package.json'), '{"version":"0.1.0"}\n');
    if (kind === 'stale') await writeFile(join(installed, 'obsolete-runtime.mjs'), 'old runtime');
    if (kind === 'exact') assert.equal(await verifyInstalledArchive({ staged, installed }), 1);
    else await assert.rejects(verifyInstalledArchive({ staged, installed }), /without stale upgrade files/);
  }
});

for (const outcome of ['preserved', 'changed-config', 'wrong-previous-version']) {
  test(`upgrade installs the previous registry version before the candidate (${outcome})`, async t => {
    // The installer is controlled here; real npm and actual-host checks remain in verify-artifacts.
    const base = await mkdtemp(join(tmpdir(), 'broker-upgrade-dispatch-'));
    t.diagnostic(`Upgrade fixture retained at ${base}`);
    const consumer = join(base, 'consumer'), home = join(base, 'home');
    await mkdir(consumer); await mkdir(home);
    const calls = [];
    const run = async (argv, cwd) => {
      assert.equal(cwd, consumer);
      calls.push(argv);
      const installed = join(consumer, 'node_modules/pi-context-broker');
      await mkdir(installed, { recursive: true });
      await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'pi-context-broker', version: calls.length === 1 && outcome !== 'wrong-previous-version' ? '0.1.0' : '0.2.0' }));
      if (calls.length === 2 && outcome === 'changed-config') await writeFile(join(home, '.pi/agent/settings.json'), '{}');
      return '';
    };
    const operation = installBrokerConsumer({ consumer, home, target: 'file:/candidate.tgz', upgradeFrom: 'pi-context-broker@0.1.0', run });
    if (outcome === 'preserved') {
      const result = await operation;
      assert.equal(result.mode, 'upgrade');
      assert.equal(result.preservedConfigurations.length, 2);
      assert.deepEqual(calls.map(argv => argv.at(-1)), ['pi-context-broker@0.1.0', 'file:/candidate.tgz']);
    } else {
      await assert.rejects(operation);
      assert.equal(calls.length, outcome === 'wrong-previous-version' ? 1 : 2);
    }
  });
}

test('a selected source build accepts its frozen version and rejects wrong packages or altered bundle bytes', () => {
  const hash = value => createHash('sha256').update(value).digest('hex');
  const fixture = { expectedVersion: '0.1.0', cliBytes: Buffer.from('frozen-cli'), sdkBytes: Buffer.from('frozen-sdk'),
    manifest: { version: 1, package: 'ntn-skills', package_version: '0.1.0', cli_sha256: hash('frozen-cli'), sdk_sha256: hash('frozen-sdk') } };
  assert.deepEqual(verifyBundledRuntime(fixture), { cli: fixture.manifest.cli_sha256, sdk: fixture.manifest.sdk_sha256 });
  for (const change of [
    value => { value.expectedVersion = '0.3.0'; },
    value => { value.manifest.package = 'other-package'; },
    value => { value.manifest.version = 2; },
    value => { value.cliBytes = Buffer.from('other-cli'); },
    value => { value.sdkBytes = Buffer.from('other-sdk'); },
  ]) {
    const value = structuredClone(fixture); change(value);
    assert.throws(() => verifyBundledRuntime(value));
  }
});

// Only the packaging dispatcher is under test. Actual build/install/host proof
// is separate; these stub commands never contact npm or start a host.
async function dispatch(args) {
  const root = await mkdtemp(join(tmpdir(), 'broker-pack-target-'));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'packages/context-broker'), { recursive: true });
  await mkdir(join(root, 'bin'));
  await copyFile(new URL('./pack.mjs', import.meta.url), join(root, 'scripts/pack.mjs'));
  for (const name of ['bun', 'npm', 'tar']) {
    const executable = join(root, 'bin', name);
    await writeFile(executable, '#!/bin/sh\nprintf "%s" "' + name + '" >> "$CALLS"\nfor arg do printf "|%s" "$arg" >> "$CALLS"; done\nprintf "\\n" >> "$CALLS"\n');
    await chmod(executable, 0o755);
  }
  const result = spawnSync(process.execPath, [join(root, 'scripts/pack.mjs'), ...args, '--out-dir', join(root, 'output')], {
    encoding: 'utf8', env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, CALLS: join(root, 'calls') },
  });
  const calls = await readFile(join(root, 'calls'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  // Preserve test inputs/results; no deletion of user files or generated trees.
  await writeFile(join(root, 'result.json'), JSON.stringify({ args, exit: result.status, calls }, null, 2) + '\n');
  return { result, calls: calls.trim().split('\n').filter(Boolean) };
}

test('broker package target never dispatches the Tern archive', async () => {
  const { result, calls } = await dispatch(['--target', 'broker']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls[0], 'bun|scripts/build-tern.mjs|--target|broker');
  assert.ok(calls[1].startsWith('npm|pack|--ignore-scripts|--json|--pack-destination|'));
  assert.equal(calls.length, 2);
});

test('default package target retains both product formats', async () => {
  const { result, calls } = await dispatch([]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls[0], 'bun|scripts/build-tern.mjs|--target|all');
  assert.ok(calls[2].startsWith('tar|-czf|'));
  assert.equal(calls.length, 3);
});

test('broker dry-run stays broker-only and uses npm dry-run', async () => {
  const { result, calls } = await dispatch(['--target', 'broker', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], 'npm|pack|--ignore-scripts|--json|--dry-run');
});

for (const args of [['--target', 'tern'], ['--target'], ['--target', 'broker', '--target', 'all']]) {
  test(`invalid package arguments stop before build: ${args.join(' ')}`, async () => {
    const { result, calls } = await dispatch(args);
    assert.notEqual(result.status, 0);
    assert.deepEqual(calls, []);
  });
}
