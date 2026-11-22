import assert from 'node:assert/strict';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { deriveAccounting } from './accounting.mjs';

const root = await realpath(dirname(fileURLToPath(import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async name => JSON.parse(await readFile(join(root, name), 'utf8'));
const manifest = await read('release-manifest.json');
assert.equal(hash(JSON.stringify({ ...manifest, manifest_sha256: null })), manifest.manifest_sha256);
const declared = new Set();
for (const item of manifest.files) {
  assert.ok(!declared.has(item.path)); declared.add(item.path);
  const path = await realpath(resolve(root, item.path));
  const child = relative(root, path);
  assert.ok(child !== '' && !child.startsWith('..') && !isAbsolute(child), 'Release member escaped its directory');
  const bytes = await readFile(path);
  assert.equal(hash(bytes), item.sha256, item.path); assert.equal(bytes.length, item.bytes);
}
async function enumerate(directory, prefix = '') {
  const output = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + item.name;
    if (item.isDirectory()) output.push(...await enumerate(join(directory, item.name), name + '/'));
    else { assert.ok(item.isFile(), 'Unexpected link or special file'); output.push(name); }
  }
  return output;
}
assert.deepEqual((await enumerate(root)).sort(), [...declared, 'release-manifest.json'].sort());
for (const name of ['current-plan', 'retained-invalid']) {
  const output = execFileSync(process.execPath, [join(root, name, 'replay.mjs')], { encoding: 'utf8' }).trim();
  const receipt = JSON.parse(output);
  assert.equal(receipt.status, 'verified'); assert.equal(receipt.model_requests, 0);
}
const reservations = [];
for (const item of manifest.reservations) reservations.push({
  ordinal: item.ordinal, receipt: await read(item.path), source_sha256: item.source_sha256,
});
const accounting = deriveAccounting({
  current: await read('current-plan/analysis-input.json'),
  retained: await read('retained-invalid/analysis-input.json'),
  currentAnalysis: await read('current-plan/analysis.json'),
  currentManifest: await read('current-plan/public-manifest.json'),
  retainedManifest: await read('retained-invalid/public-manifest.json'),
  reservations,
});
assert.deepEqual(accounting, await read('accounting.json'));
process.stdout.write(JSON.stringify({
  status: 'verified', release_manifest_sha256: manifest.manifest_sha256,
  shared_pilot: accounting.shared_pilot, current_plan: accounting.current_plan,
  scope: 'Published hashes, locators, normalized statistics and shared reservation accounting; no private regrading or remote materialization',
  model_requests: 0,
}) + '\n');
