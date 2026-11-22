import assert from 'node:assert/strict';
import test from 'node:test';
import { createExpectation, freezeExpectation, validateExpectation, compareObservation, projectObservation, inspectObservation } from './runtime/observation.mjs';

const hash = 'a'.repeat(64);
function fixture(id = 'a') {
  const root = '/owned/runs/' + id, buildRoot = '/owned/builds/base';
  const tool = (path, version) => ({ path, invocation_path: path, version, sha256: hash, status: 'observed' });
  const run = { root, build_root: buildRoot, runtime: { node: tool('/maintained/node', 'v26.13.1'),
    bun: tool('/maintained/bun', '1.4.4'), pi: { ...tool('/maintained/pi/cli.js', '1.6.0'),
      package_manifest: { ...tool('/maintained/pi/package.json', '1.6.0'), name: '@earendil-works/pi-coding-agent' },
      runtime_module: { ...tool('/maintained/pi/cli-runtime.js', '1.6.0') } } },
    pi_launch: { entry: '/maintained/pi/cli.js', argv: ['-ns', '-e', buildRoot + '/broker/src/index.ts'], mode: 'broker' } };
  const roots = Object.fromEntries(['PI_CODING_AGENT_DIR', 'NTN_SKILLS_CONFIG_HOME', 'NTN_SKILLS_HOME', 'NTN_SKILLS_CACHE_HOME', 'NTN_SKILLS_DATA_HOME', 'NTN_SKILLS_SCHEDULER_ROOT'].map(name => [name, root + '/' + name]));
  const snapshot = { schema_version: 1, kind: 'benchmark-pi-observation', nonce: id,
    process: { pid: id === 'a' ? 12 : 13, node: '/maintained/node', version: 'v26.13.1', argv: ['/maintained/node', '/maintained/pi/cli.js', ...run.pi_launch.argv, '--mode', 'rpc'], cwd: root + '/workspace' },
    roots: { ...roots, PAIRED_RUN_ROOT: root }, settings: { enableSkillCommands: false },
    model_selection: { provider: 'benchmark-phase0', id: 'no-request' }, thinking_level: 'off',
    commands: [{ name: 'inspect', sourceInfo: { path: buildRoot + '/source/broker/benchmark/runtime/observer.mjs' } }],
    tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }], active_tools: ['read'],
    prompt_options: { contextFiles: [], cwd: root + '/workspace' }, system_prompt: 'Workspace: ' + root + '/workspace\n' };
  const build = { environment_id: 'env', build_id: 'base', sources: { cli: { commit: 'b'.repeat(40), sha256: hash }, broker: { commit: 'c'.repeat(40), sha256: hash } }, packages: { cli: { sha256: hash }, broker: { sha256: hash } }, selected_cli_sha256: hash };
  return { snapshot, run, build };
}
const project = f => projectObservation(f.snapshot, f.run, f.build);
const sealed = projection => freezeExpectation(createExpectation(projection, 'candidate', { path: '/proof/snapshot.json', sha256: hash }));

test('separate run paths, pid and control nonce do not alter the portable observation', () => {
  const a = fixture('a'), b = fixture('b');
  assert.deepEqual(project(a), project(b));
  assert.equal(inspectObservation(a.snapshot, a.run).valid, true);
  assert.equal(compareObservation(sealed(project(a)), project(b)).matched, true);
});

test('a draft or altered frozen expectation cannot grant a match', () => {
  const f = fixture(), proposal = createExpectation(project(f), 'candidate', { sha256: hash });
  assert.equal(validateExpectation(proposal).valid, false);
  assert.equal(compareObservation(proposal, project(f)).matched, false);
  const expected = sealed(project(f));
  expected.projection.tools[0].name = 'other';
  assert.equal(validateExpectation(expected).valid, false);
  assert.equal(compareObservation(expected, project(f)).matched, false);
});

for (const [name, mutate] of [
  ['wrong build', f => { f.build.selected_cli_sha256 = 'd'.repeat(64); }],
  ['wrong tool schema', f => { f.snapshot.tools[0].parameters = { type: 'string' }; }],
  ['missing observer command', f => { f.snapshot.commands = []; }],
  ['wrong model selection', f => { f.snapshot.model_selection.id = 'unselected'; }],
  ['unexpected context', f => { f.snapshot.prompt_options.contextFiles = [{ path: '/global/AGENTS.md', content: 'unselected' }]; }],
  ['changed initial prompt', f => { f.snapshot.system_prompt += 'injected'; }],
  ['Pi entry changed in place between stable runs', f => { f.run.runtime.pi.sha256 = 'd'.repeat(64); }],
  ['Pi manifest changed in place between stable runs', f => { f.run.runtime.pi.package_manifest.sha256 = 'd'.repeat(64); }],
  ['Bun changed in place between stable runs', f => { f.run.runtime.bun.version = '1.4.5'; }],
  ['Node changed in place with the same version', f => { f.run.runtime.node.sha256 = 'd'.repeat(64); }],
]) test(name + ' is rejected before any task execution exists', () => {
  const f = fixture(), expected = sealed(project(f));
  mutate(f);
  const result = compareObservation(expected, project(f));
  assert.equal(result.matched, false);
  assert.ok(result.differences.length > 0);
  assert.equal(result.task_execution_enabled, false);
});

test('missing fields remain different from an explicitly observed null', () => {
  const f = fixture(); f.snapshot.prompt_options.customPrompt = null;
  const expected = sealed(project(f));
  delete f.snapshot.prompt_options.customPrompt;
  assert.equal(compareObservation(expected, project(f)).matched, false);
});

test('each candidate owns its tools and prompt expectation', () => {
  const a = fixture(), b = fixture();
  b.snapshot.tools = [{ name: 'combined_action', description: 'One operation', parameters: { type: 'object' } }];
  b.snapshot.active_tools = ['combined_action']; b.snapshot.system_prompt = 'Use the combined action.';
  assert.equal(compareObservation(sealed(project(a)), project(a)).matched, true);
  assert.equal(compareObservation(sealed(project(b)), project(b)).matched, true);
  assert.equal(compareObservation(sealed(project(a)), project(b)).matched, false);
});

test('process and state identity cannot be supplied by another run', () => {
  const f = fixture(); f.snapshot.roots.NTN_SKILLS_HOME = '/unselected/state';
  assert.equal(inspectObservation(f.snapshot, f.run).valid, false);
  const g = fixture(); g.snapshot.process.argv[1] = '/old/pi.js';
  assert.equal(inspectObservation(g.snapshot, g.run).valid, false);
  const h = fixture(); h.snapshot.process.node = '/old/node';
  assert.equal(inspectObservation(h.snapshot, h.run).valid, false);
});
