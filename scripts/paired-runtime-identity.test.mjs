import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureRuntimeIdentity, compareRuntimeIdentity } from './paired-runtime-identity.mjs';

test('runtime endpoint identity observes actual files and version subprocesses', async t => {
  const retained = await realpath(await mkdtemp(join(tmpdir(), 'paired-runtime-identity-')));
  t.diagnostic('Retained task-owned runtime fixtures: ' + retained);
  // A private copy makes the actual Node process test independent of mutable global links.
  const nodeCopy = join(retained, 'node-copy');
  await copyFile(process.execPath, nodeCopy);
  await chmod(nodeCopy, 0o700);
  const actualNodeVersion = execFileSync(nodeCopy, ['--version'], { encoding: 'utf8' }).trim();

  async function fixture(label, { runtimeModule = true } = {}) {
    const root = join(retained, label), packageRoot = join(root, 'pi');
    await mkdir(packageRoot, { recursive: true });
    const node = join(root, 'node'), bun = join(root, 'bun'), pi = join(packageRoot, 'cli.js');
    await symlink(nodeCopy, node);
    await writeFile(bun, '#!/bin/sh\nprintf \'%s\\n\' "$IDENTITY_BUN_VERSION"\n', { mode: 0o700 });
    await writeFile(pi, 'if (process.argv[2] !== "--version") process.exit(2);\n' +
      'console.log(process.env.IDENTITY_PI_VERSION);\n');
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@earendil-works/pi-coding-agent', version: '1.6.0', type: 'module',
    }));
    if (runtimeModule) await writeFile(join(packageRoot, 'cli-runtime.js'), 'export const fixture = true;\n');
    const options = { node, bun, pi: { path: pi, package_root: packageRoot }, cwd: root,
      env: { PATH: '/usr/bin:/bin', IDENTITY_BUN_VERSION: '1.4.4', IDENTITY_PI_VERSION: '1.6.0' },
      usage: { node: 'launched', pi: 'available', bun: 'potential' } };
    return { root, options, capture: () => captureRuntimeIdentity(options) };
  }

  await t.test('unchanged actual Node and owned version entries retain declared usage', async () => {
    const f = await fixture('unchanged');
    const before = await f.capture(), after = await f.capture();
    assert.equal(before.node.version, actualNodeVersion);
    assert.equal(before.node.path, nodeCopy);
    assert.equal(before.node.invocation_path, f.options.node);
    assert.match(before.node.sha256, /^[a-f0-9]{64}$/);
    assert.equal(before.node.usage, 'launched');
    assert.equal(before.pi.version, '1.6.0');
    assert.equal(before.pi.package_version, '1.6.0');
    assert.equal(before.pi.package_manifest.version, '1.6.0');
    assert.equal(before.pi.usage, 'available', 'Running a version probe does not assert target Pi use');
    assert.equal(before.bun.version, '1.4.4');
    assert.equal(before.bun.usage, 'potential');
    assert.equal(before.pi.runtime_module.status, 'observed');
    assert.deepEqual(compareRuntimeIdentity(before, after), {
      status: 'unchanged', changes: [], unknown: [], scope: 'selected-runtime-and-declared-launcher-files-at-run-endpoints',
    });
    const unspecified = await captureRuntimeIdentity({ ...f.options, usage: undefined });
    assert.deepEqual(['node', 'pi', 'bun'].map(name => unspecified[name].usage), ['unknown', 'unknown', 'unknown']);
    const requested = await captureRuntimeIdentity({ ...f.options, usage: { node: 'requested', pi: 'requested', bun: 'not_requested' } });
    assert.equal(requested.pi.usage, 'requested', 'An observed executable does not upgrade requested use to launched');
  });

  await t.test('an optional absent Pi runtime module is a known finite scope', async () => {
    const f = await fixture('absent-module', { runtimeModule: false });
    const before = await f.capture(), after = await f.capture();
    assert.equal(before.pi.runtime_module.status, 'absent');
    assert.equal(before.pi.status, 'observed');
    assert.equal(compareRuntimeIdentity(before, after).status, 'unchanged');
    await writeFile(join(f.options.pi.package_root, 'cli-runtime.js'), 'export const nowPresent = true;\n');
    const changed = compareRuntimeIdentity(before, await f.capture());
    assert.equal(changed.status, 'drifted');
    assert.ok(changed.changes.some(change => change.tool === 'pi.runtime_module' && change.field === 'presence'));
  });

  await t.test('selected lexical entry changes even when the real target is identical', async () => {
    const f = await fixture('lexical-path');
    const before = await f.capture();
    const alias = join(f.root, 'node-alias');
    await symlink(nodeCopy, alias);
    const after = await captureRuntimeIdentity({ ...f.options, node: alias });
    const result = compareRuntimeIdentity(before, after);
    assert.equal(before.node.path, after.node.path);
    assert.equal(before.node.sha256, after.node.sha256);
    assert.equal(result.status, 'drifted');
    assert.deepEqual(result.changes, [{ tool: 'node', field: 'invocation_path', before: f.options.node, after: alias }]);
  });

  await t.test('a retargeted symlink is drift even with identical bytes and version', async () => {
    const f = await fixture('symlink-target');
    const first = join(f.root, 'bun-a'), last = join(f.root, 'bun-b');
    await rename(f.options.bun, first);
    await copyFile(first, last); await chmod(last, 0o700);
    await symlink(first, f.options.bun);
    const before = await f.capture();
    await rename(f.options.bun, join(f.root, 'previous-bun-link'));
    await symlink(last, f.options.bun);
    const after = await f.capture(), result = compareRuntimeIdentity(before, after);
    assert.equal(before.bun.invocation_path, after.bun.invocation_path);
    assert.equal(before.bun.sha256, after.bun.sha256);
    assert.equal(before.bun.version, after.bun.version);
    assert.equal(result.status, 'drifted');
    assert.ok(result.changes.some(change => change.tool === 'bun' && change.field === 'path'));
  });

  await t.test('modified Pi entry, manifest and runtime module cannot hide behind a stable version', async () => {
    const f = await fixture('modified-entry');
    const before = await f.capture();
    await writeFile(f.options.pi.path, await readFile(f.options.pi.path, 'utf8') + '// replacement bytes\n');
    await writeFile(join(f.options.pi.package_root, 'cli-runtime.js'), 'export const fixture = false;\n');
    const manifestPath = join(f.options.pi.package_root, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, fixture_revision: 'changed' }));
    const after = await f.capture(), result = compareRuntimeIdentity(before, after);
    assert.equal(before.pi.version, after.pi.version);
    assert.equal(result.status, 'drifted');
    assert.ok(result.changes.some(change => change.tool === 'pi' && change.field === 'sha256'));
    assert.ok(result.changes.some(change => change.tool === 'pi.package_manifest' && change.field === 'sha256'));
    assert.ok(result.changes.some(change => change.tool === 'pi.runtime_module' && change.field === 'sha256'));
  });

  await t.test('version changes come from the passed environment and actual subprocess', async () => {
    const f = await fixture('version-change');
    const before = await f.capture();
    const after = await captureRuntimeIdentity({ ...f.options,
      env: { ...f.options.env, IDENTITY_BUN_VERSION: '1.4.5' } });
    const result = compareRuntimeIdentity(before, after);
    assert.equal(before.bun.sha256, after.bun.sha256);
    assert.deepEqual(result.changes, [{ tool: 'bun', field: 'version', before: '1.4.4', after: '1.4.5' }]);
    assert.equal(result.status, 'drifted');
  });

  await t.test('missing endpoint observation remains unknown without replacing known drift', async () => {
    const f = await fixture('missing-at-end');
    const before = await f.capture();
    await rename(f.options.bun, join(f.root, 'retained-bun'));
    const missing = await f.capture();
    assert.equal(missing.bun.status, 'unknown');
    assert.equal(missing.bun.version, null);
    assert.equal(compareRuntimeIdentity(before, missing).status, 'unknown');
    await writeFile(f.options.pi.path, await readFile(f.options.pi.path, 'utf8') + '// changed while Bun unavailable\n');
    const result = compareRuntimeIdentity(before, await f.capture());
    assert.equal(result.status, 'drifted');
    assert.ok(result.changes.some(change => change.tool === 'pi' && change.field === 'sha256'));
    assert.ok(result.unknown.some(item => item.tool === 'bun'));
  });

  await t.test('failed and malformed version probes reveal no stdout, stderr or secret values', async () => {
    const f = await fixture('probe-failure');
    const sentinel = 'owned-probe-secret-must-not-appear';
    await writeFile(f.options.bun,
      '#!/bin/sh\nprintf \'%s\\n\' "$IDENTITY_SECRET"\nprintf \'%s\\n\' "$IDENTITY_SECRET" >&2\nexit 7\n');
    const failed = await captureRuntimeIdentity({ ...f.options, env: { ...f.options.env, IDENTITY_SECRET: sentinel } });
    assert.equal(failed.bun.version, null);
    assert.equal(failed.bun.version_probe.reason, 'PROBE_EXIT_NONZERO');
    assert.equal(failed.bun.version_probe.exit_code, 7);
    assert.equal(failed.bun.status, 'unknown');
    assert.ok(!JSON.stringify(failed).includes(sentinel));
    await writeFile(f.options.bun, '#!/bin/sh\nprintf \'%s\\n\' "$IDENTITY_SECRET"\n');
    const malformed = await captureRuntimeIdentity({ ...f.options, env: { ...f.options.env, IDENTITY_SECRET: sentinel } });
    assert.equal(malformed.bun.version_probe.reason, 'INVALID_VERSION_OUTPUT');
    assert.ok(!JSON.stringify(malformed).includes(sentinel));
    await writeFile(f.options.bun, '#!' + nodeCopy + '\nprocess.stdout.write("x".repeat(8192));\n');
    const excessive = await f.capture();
    assert.equal(excessive.bun.version_probe.reason, 'PROBE_OUTPUT_LIMIT');
    assert.equal(excessive.bun.version, null);
  });

  await t.test('declared private launcher replacements are checked without executing them', async () => {
    const f = await fixture('launcher-change');
    const cli = join(f.root, 'cli-wrapper'), pi = join(f.root, 'pi-wrapper');
    const original = 'throw new Error("Launchers must not run during identity observation");\n';
    await writeFile(cli, original); await writeFile(pi, original);
    const options = { ...f.options, launchers: { cli, pi } };
    const before = await captureRuntimeIdentity(options);
    assert.equal(compareRuntimeIdentity(before, await captureRuntimeIdentity(options)).status, 'unchanged');
    assert.equal(before.launchers.pi.scope, 'selected-launcher-file');
    await writeFile(pi, original + '// changed selected Pi invocation\n');
    await rename(cli, join(f.root, 'retained-cli-wrapper'));
    const result = compareRuntimeIdentity(before, await captureRuntimeIdentity(options));
    assert.equal(result.status, 'drifted');
    assert.ok(result.changes.some(change => change.tool === 'launchers.pi' && change.field === 'sha256'));
    assert.ok(result.unknown.some(item => item.tool === 'launchers.cli'));
    assert.equal((await f.capture()).launchers, undefined, 'Undeclared launcher files must not be guessed');
  });

  await t.test('Pi package and executable versions are independently checked', async () => {
    const f = await fixture('pi-version-conflict');
    const before = await f.capture();
    const after = await captureRuntimeIdentity({ ...f.options,
      env: { ...f.options.env, IDENTITY_PI_VERSION: '1.6.1' } });
    assert.equal(after.pi.version, '1.6.1');
    assert.equal(after.pi.package_version, '1.6.0');
    assert.equal(after.pi.status, 'unknown');
    assert.equal(after.pi.reason, 'PI_VERSION_MISMATCH');
    const result = compareRuntimeIdentity(before, after);
    assert.equal(result.status, 'drifted');
    assert.ok(result.changes.some(change => change.tool === 'pi' && change.field === 'version'));
    assert.ok(result.unknown.some(item => item.tool === 'pi'));
  });

  await t.test('missing selections produce unknown receipts rather than throwing', async () => {
    const result = await captureRuntimeIdentity({ cwd: retained, env: {} });
    assert.deepEqual(['node', 'pi', 'bun'].map(name => result[name].status), ['unknown', 'unknown', 'unknown']);
    assert.equal(compareRuntimeIdentity(result, result).status, 'unknown');
    assert.equal(compareRuntimeIdentity(undefined, undefined).status, 'unknown');
  });

  await t.test('a nonterminating version probe is bounded and preserves other observations', async () => {
    const f = await fixture('probe-timeout');
    await writeFile(f.options.bun, '#!' + nodeCopy + '\nsetInterval(() => {}, 1000);\n');
    const started = Date.now(), result = await f.capture();
    assert.equal(result.bun.version_probe.reason, 'PROBE_TIMEOUT');
    assert.equal(result.bun.status, 'unknown');
    assert.equal(result.node.status, 'observed');
    assert.equal(result.pi.status, 'observed');
    assert.ok(Date.now() - started < 9_000, 'The bounded probe must not wait for the target run deadline');
  });

  for (const mode of ['timeout', 'output-limit']) {
    await t.test('probe ' + mode + ' cleans its owned descendants and leaves another process running', async t => {
      const f = await fixture('descendant-' + mode);
      const pidPath = join(f.root, 'owned-processes.json');
      const sentinel = spawn(nodeCopy, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      const sentinelClosed = new Promise(resolve => sentinel.once('close', resolve));
      t.after(async () => {
        // These exact processes were created by this test. No process-name scans.
        try { process.kill(sentinel.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        await sentinelClosed;
        let owned;
        try { owned = JSON.parse(await readFile(pidPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (owned) for (const pid of [owned.child, owned.parent]) {
          try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      });
      await new Promise((resolve, reject) => { sentinel.once('spawn', resolve); sentinel.once('error', reject); });
      await writeFile(f.options.bun, '#!' + nodeCopy + '\n' +
        'const {spawn} = require("node:child_process"), fs = require("node:fs");\n' +
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:["ignore","inherit","inherit"]});\n' +
        'fs.writeFileSync(' + JSON.stringify(pidPath) + ', JSON.stringify({parent:process.pid,child:child.pid}));\n' +
        (mode === 'output-limit' ? 'process.stderr.write("x".repeat(8192));\n' : '') +
        'setInterval(() => {}, 1000);\n');
      const result = await f.capture();
      assert.equal(result.bun.version_probe.reason, mode === 'timeout' ? 'PROBE_TIMEOUT' : 'PROBE_OUTPUT_LIMIT');
      const owned = JSON.parse(await readFile(pidPath, 'utf8'));
      const running = pid => {
        try {
          const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: 1000 }).trim();
          // A zombie has exited; reaping belongs to its operating-system parent.
          return Boolean(state) && !state.startsWith('Z');
        } catch (error) { if (error.status === 1) return false; throw error; }
      };
      const deadline = Date.now() + 1000;
      while (running(owned.child) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(running(owned.child), false, 'The version-probe descendant must have exited');
      assert.equal(running(owned.parent), false, 'The version-probe leader must have exited');
      assert.equal(running(sentinel.pid), true, 'An unrelated owned process must remain running');
    });
  }
});
