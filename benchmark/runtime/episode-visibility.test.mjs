import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertRunSourceAbsent, assertSourceEnvironmentAbsent, RUNTIME_ONLY_SOURCE, sourceVisibility } from './episode-visibility.mjs';

test('new source-free receipts and historical moved receipts retain their actual distinct meaning', () => {
  assert.deepEqual(sourceVisibility({ ...RUNTIME_ONLY_SOURCE, projection: { files: [] } }), RUNTIME_ONLY_SOURCE);
  assert.deepEqual(sourceVisibility({ source_moved_outside_run: true }), { source_moved_outside_run: true });
  for (const invalid of [{}, { source_moved_outside_run: false }, { source_moved_outside_run: true, command_source: 'none' },
    { ...RUNTIME_ONLY_SOURCE, source_moved_outside_run: true }, { ...RUNTIME_ONLY_SOURCE, command_source: 'copy' },
    { ...RUNTIME_ONLY_SOURCE, command_source: undefined }, { ...RUNTIME_ONLY_SOURCE, source_disposition: 'deleted' }])
    assert.throws(() => sourceVisibility(invalid), /VISIBILITY/);
});

test('runtime source exclusion rejects directories, dangling links and exposed source bindings', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-source-visibility-')));
  t.diagnostic('Owned fixture retained for system-Trash cleanup: ' + root);
  await assertRunSourceAbsent(root);
  const directory = join(root, 'directory'), dangling = join(root, 'dangling');
  await mkdir(join(directory, 'source'), { recursive: true }); await mkdir(dangling);
  await symlink('does-not-exist', join(dangling, 'source'));
  await assert.rejects(assertRunSourceAbsent(directory), /SOURCE_STILL_VISIBLE/);
  await assert.rejects(assertRunSourceAbsent(dangling), /SOURCE_STILL_VISIBLE/);
  assertSourceEnvironmentAbsent({});
  for (const name of ['PAIRED_CLI_SOURCE', 'PAIRED_BROKER_SOURCE', 'CONTEXT_BROKER_GRAPH_CORE', 'NTN_SKILLS_BUILD_ENTRY'])
    for (const value of ['', '/some/source']) assert.throws(() => assertSourceEnvironmentAbsent({ [name]: value }), /SOURCE_ENV_VISIBLE/);
});
