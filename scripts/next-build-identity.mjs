import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const selectedCliInputs = ['package.json', 'dist/ntn-skills.js', 'dist/sdk.js', 'skills', 'THIRD_PARTY_NOTICES.md'];
export const brokerInputs = ['packages/context-broker/src', 'packages/context-broker/package.json',
  'packages/context-broker/docs', 'packages/context-broker/examples', 'scripts/build-tern.mjs',
  'scripts/next-build-identity.mjs', 'package.json', 'bun.lock', 'README.md', 'README.zh-CN.md',
  'CONTRIBUTING.md', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md'];
export async function fileInventory(root, names) {
  const files = [];
  async function walk(name) {
    const path = join(root, name), entry = await stat(path);
    if (entry.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await walk(name + '/' + child);
    } else {
      assert.ok(entry.isFile(), 'Build inputs must be ordinary files: ' + name);
      files.push({ path: name, sha256: hash(await readFile(path)) });
    }
  }
  for (const name of names) await walk(name);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { sha256: hash(JSON.stringify(files)), files };
}
export async function verifyInventory(root, inventory) {
  assert.ok(inventory && /^[a-f0-9]{64}$/.test(inventory.sha256) && Array.isArray(inventory.files));
  assert.equal(hash(JSON.stringify(inventory.files)), inventory.sha256, 'Build input inventory was changed');
  for (const file of inventory.files) {
    assert.ok(typeof file.path === 'string' && file.path && !file.path.startsWith('/') && !file.path.split('/').includes('..'));
    assert.equal(hash(await readFile(join(root, file.path))), file.sha256, 'Source or artifact differs from the build: ' + file.path);
  }
}
