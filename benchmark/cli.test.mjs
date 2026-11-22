import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseBenchmarkArgs } from './cli.mjs';

const entry = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const template = fileURLToPath(new URL('./templates/preregistration.draft.json', import.meta.url));

test('public CLI validates a draft but refuses to treat it as an executable registration', () => {
  const invoke = stage => spawnSync(process.execPath, [entry, 'validate', '--protocol', template, '--stage', stage], { encoding: 'utf8', timeout: 10000 });
  const preview = invoke('phase0');
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  const draft = JSON.parse(preview.stdout);
  assert.equal(draft.valid, true); assert.equal(draft.execution_performed, false);
  const execute = invoke('execute');
  assert.equal(execute.status, 1, execute.stdout + execute.stderr);
  const refused = JSON.parse(execute.stdout);
  assert.equal(refused.valid, false); assert.equal(refused.execution_performed, false);
  assert.ok(refused.errors.length > 0);
});

test('CLI rejects arbitrary prompt execution and undeclared resource pass-through', () => {
  for (const args of [['run', '--prompt', 'business task'], ['phase0', '--models', '/unselected/models.json'],
    ['phase0', '--pass-env', 'SECRET'], ['validate', '--protocol', '/a', '--protocol', '/b'], ['validate', '--protocol']])
    assert.throws(() => parseBenchmarkArgs(args));
});

test('the no-model scope is explicit in the public help', () => {
  const result = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no task submission API/);
  assert.match(result.stdout, /not the full candidate manifest/);
});
