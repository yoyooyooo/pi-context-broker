import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { availableCapacity, capacityPolicy, evaluateCapacity, inventoryCopyBytes, preflightCapacity } from './paired-capacity.mjs';

test('capacity decision distinguishes known copies, unknown growth, reviewed budgets and changed free space', () => {
  const policy = { min_free_bytes: 20, review_below_bytes: 40 };
  const estimate = { known_copy_bytes: 10, unknown: [] };
  assert.equal(evaluateCapacity({ available_bytes: 30, policy, estimate }).status, 'allowed');
  assert.equal(evaluateCapacity({ available_bytes: 29, policy, estimate }).reason, 'insufficient_capacity');
  const unknown = { known_copy_bytes: 3, unknown: ['dependency installation'] };
  assert.equal(evaluateCapacity({ available_bytes: 45, policy, estimate: unknown }).estimate.basis, 'lower_bound_unknown_total');
  assert.equal(evaluateCapacity({ available_bytes: 41, policy, estimate: unknown }).reason, 'unknown_estimate_below_review_line');
  assert.equal(evaluateCapacity({ available_bytes: 39, policy, estimate: unknown }).reason, 'unknown_estimate_below_review_line');
  assert.equal(evaluateCapacity({ available_bytes: 39, policy, estimate: unknown, budget: '10' }).status, 'allowed');
  assert.equal(evaluateCapacity({ available_bytes: 29, policy, estimate: unknown, budget: '10' }).status, 'refused');
  assert.throws(() => evaluateCapacity({ available_bytes: 39, policy, estimate: unknown, budget: '2' }), /smaller than known/);
  for (const budget of ['-1', '1e9', '1.2', '9007199254740992'])
    assert.throws(() => evaluateCapacity({ available_bytes: 39, policy, estimate: unknown, budget }), /integer/);
});

test('capacity probes the actual destination ancestor and refuses before creating missing directories', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paired-capacity-test-')));
  t.diagnostic('Owned fixture retained for system-Trash cleanup: ' + root);
  const destination = join(root, 'missing/deep/run');
  const observed = await availableCapacity(destination);
  assert.equal(observed.observed_path, root);
  assert.ok(observed.available_bytes > 0);
  await assert.rejects(stat(join(root, 'missing')), { code: 'ENOENT' });
  const policyPath = join(root, 'capacity-policy.json');
  await writeFile(policyPath, JSON.stringify({ version: 1, min_free_bytes: Number.MAX_SAFE_INTEGER }));
  await assert.rejects(preflightCapacity({ root: join(root, 'environment') }, 'run', { known_copy_bytes: 0, unknown: [] }, destination), error => {
    assert.equal(error.code, 'PAIRED_CAPACITY_REFUSED');
    assert.equal(error.capacity.observed_path, root);
    assert.equal(error.capacity.policy.path, policyPath);
    assert.equal(error.capacity.destination, destination);
    return true;
  });
  await assert.rejects(stat(join(root, 'environment')), { code: 'ENOENT' });
  const before = await readFile(policyPath, 'utf8');
  await assert.rejects(preflightCapacity({ root: join(root, 'environment') }, 'create', { known_copy_bytes: 0, unknown: ['clone'] }));
  assert.equal(await readFile(policyPath, 'utf8'), before, 'Repeated refusals do not rewrite the policy or state');
  await writeFile(join(root, 'explicit.json'), JSON.stringify({ version: 1, min_free_bytes: 0, review_below_bytes: 0 }));
  const inherited = await capacityPolicy(join(root, 'environment'), join(root, 'explicit.json'));
  assert.equal(inherited.min_free_bytes, Number.MAX_SAFE_INTEGER, 'An explicit weaker policy cannot bypass an ancestor');
  assert.equal(inherited.sources.length, 2);
  const nestedRoot = join(root, 'nested/environment');
  await mkdir(nestedRoot, { recursive: true });
  await writeFile(join(nestedRoot, 'capacity-policy.json'), JSON.stringify({ version: 1, min_free_bytes: 0 }));
  assert.equal((await capacityPolicy(nestedRoot)).min_free_bytes, Number.MAX_SAFE_INTEGER, 'Nested environments still inherit the project limit');
  await writeFile(join(root, 'explicit.json'), JSON.stringify({ version: 1, min_free_bytes: 10, review_below_bytes: 9 }));
  await assert.rejects(capacityPolicy(root, join(root, 'explicit.json')), /at least/);
  await assert.rejects(capacityPolicy(root, 'relative.json'), /absolute/);
});

test('copy estimates use real file lengths, do not count symlink targets twice, and reject escaped paths', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paired-capacity-copy-test-')));
  t.diagnostic('Owned fixture retained for system-Trash cleanup: ' + root);
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested/file'), Buffer.alloc(12345));
  await symlink('nested/file', join(root, 'link'));
  assert.equal(await inventoryCopyBytes(root, { files: [{ path: 'nested/file', sha256: 'recorded-elsewhere' }, { path: 'link', link: 'nested/file' }] }), 12345);
  await assert.rejects(inventoryCopyBytes(root, { files: [{ path: '../escape', sha256: 'x' }] }), /escapes/);
  await assert.rejects(inventoryCopyBytes(root, { files: [{ path: 'link', sha256: 'x' }] }), /file changed/);
});
