import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyBundledRuntime } from './verify-package-closure.mjs';

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
