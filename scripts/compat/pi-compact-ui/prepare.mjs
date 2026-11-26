#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: node scripts/compat/pi-compact-ui/prepare.mjs --archive /absolute/pi-compact-ui-0.1.3.tgz --output /absolute/new-owned-directory\nVerifies the official archive, applies the reviewed read-only rendering patch, and packs a private package. Does not install or change Pi settings.');
  process.exit(0);
}
assert.equal(args.length, 4, 'Use --archive and --output; see --help');
assert.equal(args[0], '--archive'); assert.equal(args[2], '--output');
assert.ok(isAbsolute(args[1]) && isAbsolute(args[3]), 'Use absolute paths');
const archive = await realpath(args[1]), output = resolve(args[3]);
const manifestBytes = await readFile(join(here, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.version, 1);
const patchPath = join(here, manifest.patch), patchBytes = await readFile(patchPath);
assert.equal(sha(patchBytes), manifest.patch_sha256, 'The reviewed patch changed');
const archiveBytes = await readFile(archive);
assert.equal(sha(archiveBytes), manifest.upstream_sha256, 'Use the exact reviewed upstream archive');
assert.equal('sha512-' + createHash('sha512').update(archiveBytes).digest('base64'), manifest.upstream_integrity);
const expectedNames = Object.keys(manifest.upstream_files).sort();
const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().split('\n').sort();
assert.deepEqual(members, expectedNames.map(name => 'package/' + name));
const sources = await Promise.all(expectedNames.map(async name => {
  assert.ok(!name.includes('/') && name !== '.' && name !== '..');
  const bytes = execFileSync('tar', ['-xOzf', archive, 'package/' + name], { maxBuffer: 1024 * 1024 });
  assert.equal(sha(bytes), manifest.upstream_files[name], 'Upstream member mismatch: ' + name);
  return [name, bytes];
}));
await mkdir(output);
const packageRoot = join(output, 'package'), archives = join(output, 'archives');
await mkdir(packageRoot); await mkdir(archives); await mkdir(join(output, 'npm-cache'));
await writeFile(join(output, 'npmrc'), '', { flag: 'wx', mode: 0o600 });
for (const [name, bytes] of sources) await writeFile(join(packageRoot, name), bytes, { flag: 'wx' });
execFileSync('git', ['apply', '--check', patchPath], { cwd: packageRoot, stdio: 'pipe' });
execFileSync('git', ['apply', patchPath], { cwd: packageRoot, stdio: 'pipe' });
for (const [name, digest] of Object.entries(manifest.result_files))
  assert.equal(sha(await readFile(join(packageRoot, name))), digest, 'Patched member mismatch: ' + name);
const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
assert.equal(pkg.name, manifest.package); assert.equal(pkg.version, manifest.compatibility_version); assert.equal(pkg.private, true);
const env = { ...process.env, npm_config_cache: join(output, 'npm-cache'), npm_config_userconfig: join(output, 'npmrc') };
const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', archives], {
  cwd: packageRoot, env, encoding: 'utf8', maxBuffer: 1024 * 1024,
}));
assert.equal(packed.length, 1);
const packedPath = join(archives, packed[0].filename), packedBytes = await readFile(packedPath);
const receipt = { version: 1, status: 'prepared-not-activated', upstream: { path: archive, sha256: manifest.upstream_sha256, integrity: manifest.upstream_integrity, license: manifest.upstream_license },
  manifest_sha256: sha(manifestBytes), patch_sha256: manifest.patch_sha256, preparation_script_sha256: sha(await readFile(fileURLToPath(import.meta.url))),
  package: { path: packageRoot, name: pkg.name, version: pkg.version, files: manifest.result_files },
  archive: { path: packedPath, sha256: sha(packedBytes), integrity: packed[0].integrity },
  tested_pi_version: manifest.tested_pi_version, global_installation_changed: false, settings_changed: false };
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(receipt, null, 2));
