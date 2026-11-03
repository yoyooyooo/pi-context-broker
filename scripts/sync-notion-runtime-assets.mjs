#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/sync-notion-runtime-assets.mjs --evidence-root /absolute/evidence');
  console.log('After build:broker, copy only its exact Notion CLI, notices and three builtin Skills into the generated Tern runtime. Preserve old assets outside the checkout and verify completion.mjs is unchanged.');
  process.exit(0);
}
assert(args.length === 2 && args[0] === '--evidence-root' && isAbsolute(args[1]), 'An external absolute evidence directory is required');
const root = resolve(import.meta.dirname, '..'), broker = join(root, 'packages/context-broker');
const source = join(broker, 'dist'), target = join(root, 'packages/tern-context-broker/query');
assert(!args[1].startsWith(root + '/'), 'Retain previous generated assets outside the checkout');
await mkdir(args[1], { recursive: true });
const evidence = await realpath(await mkdtemp(join(args[1], 'shared-runtime-assets-')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const completion = join(target, 'completion.mjs'), completionBefore = hash(await readFile(completion));
const names = ['ntn-skills', 'ntn-skills-maintain', 'ntn-skills-sync'];
const dependencies = ['effect', '@effect/platform-node', '@effect/platform-node-shared', '@effect/sql-sqlite-node'];
const receipt = { version: 1, status: 'preparing', source, target, evidence, protected_completion_sha256: completionBefore, files: [], dependencies: {}, checks: [] };
await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2));
async function inventory(directory, prefix = '') {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name), name = prefix + entry.name;
    assert(!entry.isSymbolicLink(), 'Generated runtime assets cannot contain symlinks');
    if (entry.isDirectory()) result.push(...await inventory(path, name + '/'));
    else {
      assert(entry.isFile(), 'Generated runtime assets must be regular files');
      const bytes = await readFile(path); result.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  return result;
}
async function regular(path) { const value = await lstat(path); assert(value.isFile() && !value.isSymbolicLink()); return readFile(path); }
try {
  assert.equal((await stat(evidence)).dev, (await stat(target)).dev, 'Atomic retained publication requires the same filesystem');
  const queryManifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  const brokerManifest = JSON.parse(await readFile(join(broker, 'package.json'), 'utf8'));
  for (const name of dependencies) {
    assert.equal(brokerManifest.dependencies[name], '4.0.5'); assert.equal(queryManifest.dependencies[name], '4.0.5');
    const observed = [];
    for (const manifest of [join(broker, 'package.json'), join(target, 'package.json')]) {
      const require = createRequire(manifest);
      const dependency = JSON.parse(await readFile(require.resolve(name + '/package.json'), 'utf8'));
      assert.equal(dependency.version, '4.0.5'); observed.push(dependency.version);
    }
    receipt.dependencies[name] = { declared: '4.0.5', installed: observed };
  }
  assert.deepEqual((await readdir(join(source, 'builtin-skills'))).sort(), names);
  const sourceInventory = await inventory(join(source, 'builtin-skills'));
  const stage = join(evidence, 'stage'), previous = join(evidence, 'previous');
  await mkdir(stage); await mkdir(previous);
  for (const name of ['ntn-skills.mjs', 'NOTICES.txt']) {
    const bytes = await regular(join(source, name));
    await writeFile(join(stage, name), bytes, { mode: (await lstat(join(source, name))).mode & 0o777, flag: 'wx' });
    try { const old = await regular(join(target, name)); await writeFile(join(previous, name), old, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    receipt.files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  await cp(join(source, 'builtin-skills'), join(stage, 'builtin-skills'), { recursive: true, errorOnExist: true, force: false });
  assert.deepEqual(await inventory(join(stage, 'builtin-skills')), sourceInventory);
  assert.equal(hash(await readFile(completion)), completionBefore, 'Protected completion changed before publication');
  for (const name of ['ntn-skills.mjs', 'NOTICES.txt']) await rename(join(stage, name), join(target, name));
  let retained = false;
  try { await rename(join(target, 'builtin-skills'), join(previous, 'builtin-skills')); retained = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(join(stage, 'builtin-skills'), join(target, 'builtin-skills')); }
  catch (error) { if (retained) await rename(join(previous, 'builtin-skills'), join(target, 'builtin-skills')); throw error; }
  assert.deepEqual(await inventory(join(target, 'builtin-skills')), sourceInventory);
  receipt.files.push(...sourceInventory.map(file => ({ ...file, path: 'builtin-skills/' + file.path })));
  for (const name of ['ntn-skills.mjs', 'NOTICES.txt']) assert.deepEqual(await readFile(join(source, name)), await readFile(join(target, name)));
  const home = join(evidence, 'verification-home'), cwd = join(evidence, 'verification-cwd');
  await mkdir(home); await mkdir(cwd);
  const env = { PATH: dirname(process.execPath) + ':/usr/bin:/bin', HOME: home, LANG: 'en_US.UTF-8',
    NTN_SKILLS_HOME: join(home, 'state'), NTN_SKILLS_CONFIG_HOME: join(home, 'config'),
    NTN_SKILLS_CACHE_HOME: join(home, 'cache'), NTN_SKILLS_DATA_HOME: join(home, 'data') };
  const call = async argv => {
    const result = spawnSync(process.execPath, [join(target, 'ntn-skills.mjs'), ...argv], { env, cwd, encoding: 'utf8', timeout: 30000 });
    await writeFile(join(evidence, 'public-' + receipt.checks.length + '.json'), JSON.stringify({ argv, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message }, null, 2));
    assert.equal(result.status, 0, 'Generated runtime public command failed');
    const value = JSON.parse(result.stdout); assert.equal(value.ok, true);
    receipt.checks.push({ argv, status: result.status }); return value;
  };
  const schema = await call(['schema', 'prepare']);
  assert(schema.ok);
  const catalog = await call(['ctl', 'builtin', 'list']);
  assert.deepEqual(catalog.skills.map(skill => skill.id).sort(), names.map(name => 'notion/' + name));
  assert(catalog.skills.every(skill => skill.installation.state === 'not_installed'));
  for (const file of sourceInventory.filter(file => file.path.endsWith('.md'))) {
    const [name, ...parts] = file.path.split('/'), path = parts.join('/');
    const value = await call(['ctl', 'builtin', 'read', 'notion/' + name, ...(path === 'SKILL.md' ? [] : ['--path', path])]);
    assert.equal(value.builtin.origin, 'builtin');
    assert.equal(hash(Buffer.from(value.content)), file.sha256, 'Builtin read must consume exact generated bytes');
  }
  assert.equal(hash(await readFile(completion)), completionBefore, 'Protected completion must remain byte-for-byte unchanged');
  receipt.status = 'passed'; receipt.protected_completion_after_sha256 = completionBefore;
} catch (error) {
  receipt.status = 'failed'; receipt.error = String(error); process.exitCode = 1;
} finally {
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ status: receipt.status, evidence, files: receipt.files.length, checks: receipt.checks.length, protected_completion_sha256: completionBefore, error: receipt.error }));
}
