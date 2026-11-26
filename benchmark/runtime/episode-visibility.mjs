import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

export const RUNTIME_ONLY_SOURCE = Object.freeze({ source_disposition: 'not_copied',
  source_moved_outside_run: false, command_source: 'none' });

/** Read old moved-source evidence without claiming that new runs moved a tree. */
export function sourceVisibility(receipt) {
  assert.ok(receipt && typeof receipt === 'object', 'BENCHMARK_SOURCE_VISIBILITY_REQUIRED');
  if (receipt.source_disposition === undefined) {
    assert.equal(receipt.source_moved_outside_run, true, 'BENCHMARK_SOURCE_VISIBILITY_UNPROVEN');
    assert.equal(receipt.command_source, undefined, 'BENCHMARK_SOURCE_VISIBILITY_CONFLICT');
    return { source_moved_outside_run: true };
  }
  for (const [key, value] of Object.entries(RUNTIME_ONLY_SOURCE))
    assert.equal(receipt[key], value, 'BENCHMARK_SOURCE_VISIBILITY_CONFLICT:' + key);
  return { ...RUNTIME_ONLY_SOURCE };
}

export async function assertRunSourceAbsent(runRoot) {
  try { await lstat(join(runRoot, 'source')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.fail('BENCHMARK_SHARED_SOURCE_STILL_VISIBLE');
}

export function assertSourceEnvironmentAbsent(environment = process.env) {
  for (const name of ['PAIRED_CLI_SOURCE', 'PAIRED_BROKER_SOURCE', 'CONTEXT_BROKER_GRAPH_CORE', 'NTN_SKILLS_BUILD_ENTRY'])
    assert.equal(environment[name], undefined, 'BENCHMARK_SOURCE_ENV_VISIBLE:' + name);
}
