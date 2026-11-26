import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const bytes = (value, label) => {
  assert.ok(Number.isSafeInteger(value) && value >= 0, label + ' must be a nonnegative safe integer');
  return value;
};

/** A local development policy, never an implied quota or permission to delete. */
export async function capacityPolicy(environmentRoot, explicitPath) {
  if (explicitPath !== undefined) assert.ok(isAbsolute(explicitPath), '--capacity-policy must be absolute');
  const candidates = [];
  for (let parent = resolve(environmentRoot);; parent = dirname(parent)) {
    candidates.push(join(parent, 'capacity-policy.json'));
    if (dirname(parent) === parent) break;
  }
  if (explicitPath) candidates.push(explicitPath);
  const sources = [];
  for (const path of [...new Set(candidates)]) {
    let content;
    try { content = await readFile(path); }
    catch (error) { if (path !== explicitPath && error.code === 'ENOENT') continue; throw error; }
    const policy = JSON.parse(content);
    assert.equal(policy.version, 1, 'Unsupported capacity policy');
    for (const key of Object.keys(policy)) assert.ok(['version', 'min_free_bytes', 'review_below_bytes'].includes(key), 'Unknown capacity policy field: ' + key);
    const minimum = bytes(policy.min_free_bytes, 'min_free_bytes');
    const review = bytes(policy.review_below_bytes ?? minimum, 'review_below_bytes');
    assert.ok(review >= minimum, 'review_below_bytes must be at least min_free_bytes');
    sources.push({ path: await realpath(path), sha256: createHash('sha256').update(content).digest('hex'),
      min_free_bytes: minimum, review_below_bytes: review });
  }
  return { path: sources[0]?.path ?? null, sources,
    min_free_bytes: Math.max(0, ...sources.map(source => source.min_free_bytes)),
    review_below_bytes: Math.max(0, ...sources.map(source => source.review_below_bytes)) };
}

export async function availableCapacity(destination) {
  let path = resolve(destination);
  while (true) {
    try { await lstat(path); break; }
    catch (error) { if (error.code !== 'ENOENT' || dirname(path) === path) throw error; path = dirname(path); }
  }
  path = await realpath(path);
  const info = await statfs(path, { bigint: true });
  return { observed_path: path, filesystem_type: String(info.type),
    available_bytes: bytes(Number(info.bavail * info.bsize), 'available bytes'),
    observed_at: new Date().toISOString() };
}

/** Logical file lengths are conservative for COW copies; links add no file bytes. */
export async function inventoryCopyBytes(root, inventory) {
  let total = 0;
  for (const file of inventory.files) {
    const path = resolve(root, file.path);
    const within = relative(resolve(root), path);
    assert.ok(within && within !== '..' && !within.startsWith('..' + sep) && !isAbsolute(within), 'Inventory path escapes copy root');
    const info = await lstat(path);
    if (file.link !== undefined) assert.ok(info.isSymbolicLink(), 'Inventory link changed: ' + file.path);
    else { assert.ok(info.isFile(), 'Inventory file changed: ' + file.path); total += info.size; }
  }
  return bytes(total, 'copy bytes');
}

export function evaluateCapacity({ available_bytes, policy, estimate, budget }) {
  bytes(available_bytes, 'available bytes');
  bytes(estimate.known_copy_bytes, 'known copy bytes');
  assert.ok(Array.isArray(estimate.unknown), 'Unknown estimate components must be listed');
  if (budget !== undefined) {
    assert.match(String(budget), /^(0|[1-9][0-9]*)$/, '--capacity-estimate-bytes must be an integer');
    budget = bytes(Number(budget), '--capacity-estimate-bytes');
    assert.ok(budget >= estimate.known_copy_bytes, 'Declared capacity estimate is smaller than known copies');
  }
  const required = budget ?? estimate.known_copy_bytes;
  const remaining = available_bytes - required;
  const insufficient = remaining < policy.min_free_bytes || required > available_bytes;
  const unknownNeedsReview = budget === undefined && estimate.unknown.length > 0 && remaining < policy.review_below_bytes;
  return { status: insufficient ? 'refused' : unknownNeedsReview ? 'review_required' : 'allowed',
    reason: insufficient ? 'insufficient_capacity' : unknownNeedsReview ? 'unknown_estimate_below_review_line' : null,
    available_bytes, estimated_additional_bytes: required, expected_remaining_bytes: remaining,
    estimate: { ...estimate, basis: budget === undefined ? estimate.unknown.length ? 'lower_bound_unknown_total' : 'logical_copy_bytes' : 'operator_declared_budget',
      ...(budget === undefined ? {} : { declared_budget_bytes: budget }) }, policy,
    limitations: ['Point-in-time observation, not a reservation or concurrent-writer guarantee.',
      'Logical copy bytes can overestimate APFS COW allocation; command output and later writes can exceed the estimate.'] };
}

export async function preflightCapacity(options, operation, estimate, destination = options.root) {
  const policy = await capacityPolicy(options.root, options['capacity-policy']);
  const observation = await availableCapacity(destination);
  const result = { version: 1, operation, environment_root: options.root, destination, ...observation,
    ...evaluateCapacity({ ...observation, policy, estimate, budget: options['capacity-estimate-bytes'] }) };
  if (result.status !== 'allowed') {
    const error = new Error('Capacity preflight ' + result.reason + '; preserve existing state and inspect capacity-policy.json or provide a reviewed --capacity-estimate-bytes budget');
    error.code = 'PAIRED_CAPACITY_REFUSED'; error.capacity = result;
    throw error;
  }
  return result;
}
