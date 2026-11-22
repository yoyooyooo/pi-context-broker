#!/usr/bin/env node
// Real CLI + real Pi/Broker processes, with the existing deterministic provider.
// This verifies isolation and loading. It does not claim real-model/Notion acceptance.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { checkEnvironment, runEnvironment } from './paired-environment.mjs';
import { writeFakeProvider } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';

const HELP = `Usage:
  node scripts/paired-environment.smoke.mjs --root A --build BUILD_A
    --other-root B --other-build BUILD_B

Requires two separately created and built environments. Runs their actual private
CLI and paired Broker in the machine's Pi concurrently. Each gets a distinct copy
of the same-named Skill; the existing deterministic provider records the final
context. Asserts each sees its own marker, never the other, and that runtime state
paths and loaded extensions are separate. No credentials or Notion access.
Preserves fixtures and smoke.json under A/proofs/<unique ID>; that receipt links
to each environment's run logs and receipts under runs/<run ID>.
This is isolated-development evidence; real-model and remote Notion tests remain
separate. Failed proofs are preserved and return nonzero.
`;
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
const results = [];
try {
  const fixtures = [];
  for (const [index, item] of pair.entries()) {
    const root = join(proofRoot, String(index)), corpus = join(root, 'skills'), skill = join(corpus, 'paired-isolation-probe');
    await mkdir(skill, { recursive: true });
    const marker = 'PAIRED_MARKER_' + index + '_' + randomUUID().replaceAll('-', '');
    await writeFile(join(skill, 'SKILL.md'), `---\nname: paired-isolation-probe\ndescription: A selected local fixture for the paired isolation smoke test.\n---\n\n# Isolation probe\n\nThis test's unique marker is ${marker}.\nWhen asked, include this exact marker.\n`, { flag: 'wx' });
    const provider = await writeFakeProvider(root);
    const original = await readFile(provider, 'utf8');
    assert.ok(original.includes('process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE'));
    const runtimeProbe = `appendFileSync(process.env.PAIRED_RUN_ROOT + '/pi-loaded.jsonl', JSON.stringify({
      node: process.execPath, argv: process.argv, home: process.env.HOME,
      brokerConfig: process.env.CONTEXT_BROKER_CONFIG, agentDir: process.env.PI_CODING_AGENT_DIR,
      scheduler: process.env.NTN_SKILLS_SCHEDULER_ROOT, sessions: process.env.PI_CODING_AGENT_SESSION_DIR
    }) + '\\n');`;
    await writeFile(provider, original
      .replace('process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE', "(process.env.PAIRED_RUN_ROOT + '/provider-context.jsonl')")
      .replace('export default function provider(pi) {', 'export default function provider(pi) {\n' + runtimeProbe));
    fixtures.push({ ...item, marker, corpus, provider });
  }
  const cli = await Promise.all(fixtures.map((item, index) => runEnvironment({ ...item, target: 'cli', id: proofId + '-cli-' + index,
    'pass-env': [], args: ['--help'], 'timeout-ms': '120000' })));
  results.push(...cli);
  for (const result of cli) {
    assert.equal(result.status, 'passed', 'Private CLI failed: ' + result.stderr);
    assert.match(await readFile(result.stdout, 'utf8'), /ntn-skills/);
  }
  const pi = await Promise.all(fixtures.map((item, index) => runEnvironment({ ...item, target: 'pi', id: proofId + '-pi-' + index,
    skills: item.corpus, 'pass-env': [], 'timeout-ms': '120000',
    args: ['-e', item.provider, '--provider', 'context-broker-e2e', '--model', 'fake', '--thinking', 'off',
      '-p', '--mode', 'json', '$paired-isolation-probe State the selected isolation marker.'] })));
  results.push(...pi);
  const probes = [];
  for (const [index, result] of pi.entries()) {
    assert.equal(result.status, 'passed', 'Pi failed: ' + result.stderr);
    const capture = await readFile(join(result.root, 'provider-context.jsonl'), 'utf8');
    assert.ok(capture.includes(fixtures[index].marker), 'Broker did not load this run\'s selected Skill');
    assert.ok(!capture.includes(fixtures[1 - index].marker), 'Another environment\'s Skill leaked into the final context');
    const probe = JSON.parse((await readFile(join(result.root, 'pi-loaded.jsonl'), 'utf8')).trim().split('\n')[0]);
    const run = JSON.parse(await readFile(join(result.root, 'run.json'), 'utf8'));
    assert.ok(probe.argv.includes(join(run.build_root, 'broker/src/index.ts')), 'Pi loaded the wrong Broker entry');
    for (const name of ['brokerConfig', 'agentDir', 'scheduler', 'sessions']) assert.ok(probe[name].startsWith(result.root + '/'), 'Shared runtime path: ' + name);
    assert.equal(probe.home, process.env.HOME, 'Launcher changed HOME');
    probes.push({ run_id: result.run_id, runtime: run.runtime, ...probe });
  }
  for (const name of ['brokerConfig', 'agentDir', 'scheduler', 'sessions']) assert.notEqual(probes[0][name], probes[1][name]);
  await Promise.all(pair.map(checkEnvironment));
  const receipt = { version: 1, status: 'passed', scope: 'paired-isolation-real-pi-controlled-provider',
    proof_root: proofRoot, environments: pair, checks: ['private CLI execution', 'real Pi + selected Broker extension',
      'same-named Skill isolation in captured provider context', 'independent state/cache/scheduler/session paths', 'frozen artifacts unchanged'],
    provider: 'deterministic fixture', real_model: 'not_run', remote_notion: 'not_run', runs: results, probes };
  await writeFile(join(proofRoot, 'smoke.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: receipt.status, scope: receipt.scope, proof_root: proofRoot, evidence: join(proofRoot, 'smoke.json') }, null, 2));
} catch (error) {
  const receipt = { status: 'failed', proof_root: proofRoot, error: error.message, runs: results };
  await writeFile(join(proofRoot, 'failure.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2)); process.exitCode = 1;
}
