#!/usr/bin/env node
// Real CLI and Pi processes, using the existing deterministic provider.
// This proves loading and isolation, not model cognition or remote Notion behavior.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { checkEnvironment, runEnvironment } from './paired-environment.mjs';
import { writeFakeProvider } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';

const HELP = `Usage:
  node scripts/paired-environment.smoke.mjs --root A --build BUILD_A
    --other-root B --other-build BUILD_B

Requires two independently created and built environments. Executes both private
CLIs, then Broker/native Pi modes through the direct target and private pi wrapper.
Each of the four Pi conditions runs both environments concurrently. The existing
deterministic provider captures the final context. An observer records the actual
argv, settings, commands, tools and state paths after resources have loaded.

Each condition must contain its own selected Skill marker and exclude the other
environment and unselected discovery canaries. Canaries live in owned fixture
directories, never in the user's real global configuration. HOME stays unchanged.
Native uses Pi's /skill command and built-in reader with an explicit Skill root.
No Notion request or real model call is made. Runtime checks must be unchanged.

Preserves fixtures and smoke.json under A/proofs/<unique ID>; that receipt links
to each environment's run logs and receipts. Failed attempts retain failure.json
and return nonzero. This is isolated-development evidence, not a daily gate.
`;

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const rows = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const inside = (root, path) => typeof path === 'string' && path.startsWith(root + '/');
const strings = value => typeof value === 'string' ? [value]
  : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];

if (process.argv.includes('--help')) { process.stdout.write(HELP); process.exit(0); }
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  assert.ok(['--root', '--build', '--other-root', '--other-build'].includes(name) && !options[name], 'Unknown or repeated option');
  assert.ok(process.argv[index + 1], 'Missing option value'); options[name] = process.argv[index + 1];
}
const pair = [{ root: options['--root'], build: options['--build'] }, { root: options['--other-root'], build: options['--other-build'] }];
for (const item of pair) assert.ok(item.root && isAbsolute(item.root) && item.build, 'Supply both absolute roots and build IDs');
assert.notEqual(pair[0].root, pair[1].root, 'Use two independent environments');
await Promise.all(pair.map(checkEnvironment));
const proofId = 'smoke-' + randomUUID(), proofRoot = join(pair[0].root, 'proofs', proofId);
await mkdir(proofRoot, { recursive: true, mode: 0o700 });
const results = [], probes = [];
const inheritedNames = ['PI_CODING_AGENT_DIR', 'CONTEXT_BROKER_CONFIG'];
const inherited = Object.fromEntries(inheritedNames.map(name => [name, process.env[name]]));

async function sampledConfiguration() {
  const paths = [...new Set([join(homedir(), '.pi/agent/settings.json'), inherited.CONTEXT_BROKER_CONFIG].filter(Boolean))];
  return Promise.all(paths.map(async path => {
    try { return { path, status: 'observed', sha256: hash(await readFile(path)) }; }
    catch (error) { return { path, status: error.code === 'ENOENT' ? 'absent' : 'unknown', reason: error.code }; }
  }));
}

// Await every started run even when one fails. Never lose a peer's receipt or
// return while its owned process tree is still executing.
async function batch(items) {
  const settled = await Promise.allSettled(items.map(item => runEnvironment(item)));
  for (const result of settled) {
    if (result.status === 'fulfilled') results.push(result.value);
    else results.push({ status: 'setup_failed', error: result.reason.message });
  }
  const failed = settled.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return settled.map(result => result.value);
}

async function skill(root, marker, name = 'paired-isolation-probe', catalogCanary = false) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  const description = catalogCanary ? 'Unselected fixture ' + marker : 'A selected local fixture for the paired isolation smoke test.';
  await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# Isolation probe\n\nThis test's unique marker is ${marker}.\nWhen asked, include this exact marker.\n`, { flag: 'wx' });
  return root;
}

async function providerFixture(root) {
  const provider = await writeFakeProvider(root), original = await readFile(provider, 'utf8');
  assert.ok(original.includes('process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE'));
  assert.ok(original.includes('export default function provider(pi) {'));
  const observation = `
  pi.on('before_agent_start', (_event, ctx) => {
    appendFileSync(process.env.PAIRED_RUN_ROOT + '/pi-loaded.jsonl', JSON.stringify({
      phase: 'before_agent_start', pid: process.pid, node: process.execPath,
      nodeVersion: process.version, argv: process.argv, home: process.env.HOME,
      cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
      brokerConfig: process.env.CONTEXT_BROKER_CONFIG,
      cliConfig: process.env.NTN_SKILLS_CONFIG_HOME, cliState: process.env.NTN_SKILLS_HOME,
      cliCache: process.env.NTN_SKILLS_CACHE_HOME, cliData: process.env.NTN_SKILLS_DATA_HOME,
      scheduler: process.env.NTN_SKILLS_SCHEDULER_ROOT, sessions: process.env.PI_CODING_AGENT_SESSION_DIR,
      settings: JSON.parse(readFileSync(process.env.PI_CODING_AGENT_DIR + '/settings.json', 'utf8')),
      broker: JSON.parse(readFileSync(process.env.CONTEXT_BROKER_CONFIG, 'utf8')),
      model: { provider: ctx.model?.provider, id: ctx.model?.id },
      commands: pi.getCommands().map(({ name, source, sourceInfo }) => ({ name, source, sourceInfo })),
      tools: pi.getAllTools().map(({ name, sourceInfo }) => ({ name, sourceInfo }))
    }) + '\\n');
  });`;
  await writeFile(provider, original
    .replace('import { appendFileSync }', 'import { appendFileSync, readFileSync }')
    .replace('process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE', "(process.env.PAIRED_RUN_ROOT + '/provider-context.jsonl')")
    .replace('export default function provider(pi) {', 'export default function provider(pi) {\n' + observation));
  return provider;
}

const stateNames = ['brokerConfig', 'agentDir', 'cliConfig', 'cliState', 'cliCache', 'cliData', 'scheduler', 'sessions'];
const before = await sampledConfiguration();
try {
  // These controlled caller defaults exercise rejection of inherited settings
  // without editing the user's global directories or replacing HOME.
  const globalMarker = 'PAIRED_UNSELECTED_GLOBAL_' + randomUUID().replaceAll('-', '');
  const globalAgent = join(proofRoot, 'inherited-agent');
  const globalSkills = await skill(join(globalAgent, 'skills'), globalMarker, 'paired-isolation-probe', true);
  const globalExtension = join(globalAgent, 'global-canary.mjs');
  await writeFile(globalExtension, `export default function(pi) { pi.registerCommand('unselected-global-canary', { description: ${JSON.stringify(globalMarker)}, handler: async () => {} }); }\n`, { flag: 'wx' });
  await save(join(globalAgent, 'settings.json'), { packages: [], skills: [globalSkills], extensions: [globalExtension], enableSkillCommands: true });
  const globalBroker = join(proofRoot, 'inherited-broker.json');
  await save(globalBroker, { sources: [], skillRoots: [globalSkills], extraSkillRoots: [], ruleRoots: [], discoveryCatalogs: [], extraDiscoveryCatalogs: [] });
  process.env.PI_CODING_AGENT_DIR = globalAgent;
  process.env.CONTEXT_BROKER_CONFIG = globalBroker;

  const fixtures = [];
  for (const [index, item] of pair.entries()) {
    const root = join(proofRoot, String(index));
    const marker = 'PAIRED_MARKER_' + index + '_' + randomUUID().replaceAll('-', '');
    const corpus = await skill(join(root, 'skills'), marker);
    const provider = await providerFixture(root);
    // Pi normally discovers ancestor .agents/skills. A real discoverable canary
    // proves -ns excludes unselected project material, including in wrapper runs.
    const discoveryMarker = 'PAIRED_UNSELECTED_DISCOVERY_' + randomUUID().replaceAll('-', '');
    const discoveryName = 'unselected-' + proofId;
    const discoveryRoot = join(item.root, 'runs', '.agents/skills');
    await skill(discoveryRoot, discoveryMarker, discoveryName, true);
    fixtures.push({ ...item, marker, corpus, provider, discoveryMarker, discoveryName, discoveryRoot });
  }

  const cli = await batch(fixtures.map((item, index) => ({ ...item, target: 'cli', id: proofId + '-cli-' + index,
    'pass-env': [], args: ['--help'], 'timeout-ms': '120000' })));
  for (const result of cli) {
    assert.equal(result.status, 'passed', 'Private CLI failed: ' + result.stderr);
    assert.equal(result.runtime_check.status, 'unchanged');
    assert.match(await readFile(result.stdout, 'utf8'), /ntn-skills/);
  }

  for (const mode of ['broker', 'native']) {
    for (const target of ['pi', 'command']) {
      const pi = await batch(fixtures.map((item, index) => {
        const prompt = (mode === 'broker' ? '$paired-isolation-probe' : '/skill:paired-isolation-probe') + ' State the selected isolation marker.';
        const args = ['--provider', 'context-broker-e2e', '--model', 'fake', '--thinking', 'off', '-p', '--mode', 'json', prompt];
        return { root: item.root, build: item.build, target, id: proofId + '-' + mode + '-' + target + '-' + index,
          'pi-mode': mode, ...(mode === 'broker' ? { skills: item.corpus } : { 'native-skills': item.corpus }),
          'pi-extension': [item.provider], 'pass-env': [], 'timeout-ms': '120000',
          args: target === 'pi' ? args : ['pi', ...args] };
      }));
      for (const [index, result] of pi.entries()) {
        assert.equal(result.status, 'passed', 'Pi failed: ' + result.stderr);
        assert.equal(result.runtime_check.status, 'unchanged', 'Runtime identity changed during smoke');
        const contextStrings = (await rows(join(result.root, 'provider-context.jsonl'))).flatMap(row => strings(row.context));
        const capture = contextStrings.join('\n');
        const body = `This test's unique marker is ${fixtures[index].marker}.\nWhen asked, include this exact marker.`;
        assert.ok(contextStrings.some(value => value.includes(body)), mode + ' did not deliver the complete selected Skill body');
        for (const marker of [fixtures[1 - index].marker, globalMarker, ...fixtures.map(item => item.discoveryMarker)]) {
          assert.ok(!capture.includes(marker), 'Unselected fixture entered the final provider context');
        }
        const observed = await rows(join(result.root, 'pi-loaded.jsonl'));
        assert.ok(observed.length > 0, 'Missing actual Pi resource observation');
        const probe = observed.at(-1), run = await json(join(result.root, 'run.json'));
        const launch = run.pi_launch;
        assert.equal(launch.mode, mode);
        assert.equal(await realpath(probe.node), run.runtime.node.path, 'Pi used another Node entry');
        assert.equal(probe.nodeVersion, run.runtime.node.version, 'Pi used another Node version');
        assert.equal(await realpath(probe.argv[1]), await realpath(launch.entry));
        assert.deepEqual(probe.argv.slice(2, 2 + launch.argv.length), launch.argv, 'Actual fixed argv differs from the declared launch');
        const extensionArgs = launch.argv.flatMap((arg, offset) => arg === '-e' ? [launch.argv[offset + 1]] : []);
        assert.deepEqual(launch.extensions.map(extension => extension.path), extensionArgs, 'Extension identities differ from the actual launch');
        assert.deepEqual(probe.settings, launch.settings, 'Actual settings differ from the declared launch');
        assert.equal(probe.settings.enableSkillCommands, mode === 'native');
        assert.deepEqual(probe.settings.packages, []);
        assert.equal(probe.model.provider, 'context-broker-e2e');
        assert.equal(probe.model.id, 'fake');
        assert.deepEqual(probe.broker.sources, []);
        assert.equal(probe.home, process.env.HOME, 'Launcher changed HOME');
        for (const name of stateNames) assert.ok(inside(result.root, probe[name]), 'Shared runtime path: ' + name);
        assert.ok(!probe.commands.some(command => command.name === 'unselected-global-canary'));
        assert.ok(!probe.commands.some(command => command.name.startsWith('skill:unselected-')));
        const brokers = probe.commands.filter(command => command.name === 'context-broker');
        const brokerEntry = join(run.build_root, 'broker/src/index.ts');
        if (mode === 'broker') {
          assert.equal(brokers.length, 1, 'The actual selected Broker must register its command');
          assert.equal(await realpath(brokers[0].sourceInfo.path), await realpath(brokerEntry));
          assert.ok(probe.argv.includes(brokerEntry));
          assert.deepEqual(launch.native_skill_roots, []);
          assert.ok(probe.broker.skillRoots.every(path => inside(result.root, path)));
        } else {
          assert.equal(brokers.length, 0, 'Native Pi loaded Broker');
          assert.ok(!probe.argv.includes(brokerEntry));
          assert.ok(![...probe.commands, ...probe.tools].some(resource => inside(join(run.build_root, 'broker'), resource.sourceInfo?.path)), 'Native catalog or tools include Broker resources');
          assert.ok(!probe.tools.some(tool => ['notion_list', 'notion_use', 'notion_ctl'].includes(tool.name)));
          assert.ok(probe.tools.some(tool => tool.name === 'read' && tool.sourceInfo?.source === 'builtin'), 'Native reader was replaced');
          assert.deepEqual(probe.broker.skillRoots, []);
          assert.equal(launch.native_skill_roots.length, 1);
          const nativeRoot = launch.native_skill_roots[0];
          assert.ok(inside(result.root, nativeRoot));
          assert.equal(probe.argv[probe.argv.indexOf('--skill') + 1], nativeRoot);
          const selected = probe.commands.filter(command => command.source === 'skill' && command.name === 'skill:paired-isolation-probe');
          assert.equal(selected.length, 1, 'The native Skill command was not discovered exactly once');
          assert.ok(inside(nativeRoot, await realpath(selected[0].sourceInfo.path)), 'Native command belongs to another Skill root');
          assert.ok(probe.commands.filter(command => command.source === 'skill').every(command => inside(nativeRoot, command.sourceInfo.path)), 'Native catalog includes unselected Skills');
        }
        probes.push({ condition: { environment: index, mode, target }, run_id: result.run_id, root: result.root,
          runtime: run.runtime, pi_launch: launch, capture: join(result.root, 'provider-context.jsonl'),
          observation: join(result.root, 'pi-loaded.jsonl'), ...probe });
      }
    }
  }

  for (const name of stateNames) assert.equal(new Set(probes.map(probe => probe[name])).size, probes.length, 'Runs share ' + name);
  for (const environment of [0, 1]) for (const mode of ['broker', 'native']) {
    const matches = probes.filter(probe => probe.condition.environment === environment && probe.condition.mode === mode);
    const normalized = matches.map(probe => JSON.stringify({ argv: probe.pi_launch.argv, settings: probe.settings }).replaceAll(probe.root, '<run>'));
    assert.equal(normalized.length, 2);
    assert.equal(normalized[0], normalized[1], 'Direct target and private wrapper do not share a launch definition');
  }
  await Promise.all(pair.map(checkEnvironment));
  const after = await sampledConfiguration();
  assert.deepEqual(after, before, 'Sampled real global configuration changed');
  const receipt = { version: 2, status: 'passed', scope: 'paired-isolation-real-pi-controlled-provider',
    proof_root: proofRoot, environments: pair, matrix: { environments: 2, modes: ['broker', 'native'], targets: ['pi', 'command'], pi_runs: probes.length },
    checks: ['private CLI execution', 'actual Broker registration and native absence', 'native Skill command and original reader',
      'selected Skill delivery with unselected canaries excluded', 'same launch definition for direct target and wrapper',
      'independent state/cache/scheduler/session paths', 'runtime identities unchanged', 'frozen artifacts unchanged'],
    canaries: { inherited_agent: globalAgent, inherited_broker: globalBroker,
      discovery: fixtures.map(({ discoveryRoot, discoveryName }) => ({ root: discoveryRoot, name: discoveryName })),
      scope: 'owned stand-ins for inherited global configuration and real ancestor discovery; real HOME was not changed' },
    fixtures: await Promise.all(fixtures.map(async ({ corpus, provider }, environment) => ({ environment, corpus,
      skill_sha256: hash(await readFile(join(corpus, 'paired-isolation-probe/SKILL.md'))),
      provider, provider_sha256: hash(await readFile(provider)) }))),
    sampled_global_configuration: { status: before.some(item => item.status === 'unknown') ? 'incomplete' : 'unchanged',
      before, after, whole_machine_claim: false },
    provider: 'deterministic fixture', real_model: 'not_run', remote_notion: 'not_run', runs: results, probes };
  await save(join(proofRoot, 'smoke.json'), receipt);
  console.log(JSON.stringify({ status: receipt.status, scope: receipt.scope, proof_root: proofRoot, evidence: join(proofRoot, 'smoke.json') }, null, 2));
} catch (error) {
  const receipt = { status: 'failed', proof_root: proofRoot, error: error.message, runs: results, probes };
  await save(join(proofRoot, 'failure.json'), receipt);
  console.log(JSON.stringify(receipt, null, 2)); process.exitCode = 1;
} finally {
  for (const name of inheritedNames) {
    if (inherited[name] === undefined) delete process.env[name];
    else process.env[name] = inherited[name];
  }
}
