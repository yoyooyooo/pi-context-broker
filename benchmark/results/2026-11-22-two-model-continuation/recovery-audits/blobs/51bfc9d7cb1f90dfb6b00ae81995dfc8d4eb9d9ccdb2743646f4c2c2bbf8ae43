import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checkEnvironment, inventory, runEnvironment } from '../scripts/paired-environment.mjs';
import { fingerprint } from './protocol.mjs';
import { compareObservation, createExpectation, inspectObservation, projectObservation, validateExpectation } from './runtime/observation.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = async path => { const bytes = await readFile(path); return { path, bytes: bytes.length, sha256: sha(bytes) }; };
const inside = (parent, child) => { const part = relative(parent, child); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };

export async function phaseZero(options) {
  assert.ok(options.root && isAbsolute(options.root), '--root must name a task-owned absolute paired environment');
  const root = await realpath(options.root);
  assert.equal(root, options.root, 'Use the canonical paired environment path');
  assert.ok(typeof options.build === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(options.build), 'Select an explicit build ID');
  assert.ok(['broker', 'native'].includes(options.mode), 'Select --mode broker or native');
  assert.ok(options.skills && isAbsolute(options.skills), '--skills must name an explicit owned synthetic corpus');
  assert.equal(await realpath(options.skills), options.skills, 'Use the canonical corpus path');
  const corpusBefore = await inventory(options.skills);
  const checked = await checkEnvironment({ root, build: options.build });
  const buildPath = join(checked.root, 'build.json'), build = await json(buildPath);
  const observer = join(checked.root, 'source/broker/benchmark/runtime/observer.mjs');
  const runner = join(checked.root, 'source/broker/benchmark/runtime/probe-child.mjs');
  const observerIdentity = await identity(observer), runnerIdentity = await identity(runner);
  let expected;
  if (options.expected) {
    assert.ok(isAbsolute(options.expected), '--expected must be absolute');
    expected = await json(options.expected);
    const valid = validateExpectation(expected);
    assert.ok(valid.valid, valid.errors.map(error => error.message).join('; '));
  }
  const runId = options.id ?? 'phase0-' + randomUUID();
  assert.match(runId, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/, 'Use a bounded run ID');
  const output = options.out ?? join(root, 'proofs', runId);
  assert.ok(isAbsolute(output), '--out must be absolute');
  assert.ok(inside(root, output), 'Phase 0 output must stay in this task-owned paired environment');
  for (const name of ['builds', 'runs', 'cli', 'broker']) assert.ok(!inside(join(root, name), output), 'Evidence must not alter a build, source checkout or native run directory');
  await mkdir(join(root, 'proofs'), { recursive: true });
  assert.equal(await realpath(resolve(output, '..')), resolve(output, '..'), 'Output parent must already be canonical');
  await mkdir(output, { mode: 0o700 });
  const plannedRunRoot = join(root, 'runs', runId), nonce = randomBytes(16).toString('hex');
  await save(join(output, 'input.json'), { schema_version: 1, phase: 'phase0', purpose: 'registered-resource-preflight',
    root, build_id: options.build, mode: options.mode, condition_id: options.condition ?? options.mode + '-phase0',
    host: hostname(), started_at: new Date().toISOString(), corpus: { root: options.skills, ...corpusBefore },
    observer: observerIdentity, runner: runnerIdentity, build_receipt: await identity(buildPath),
    expected: options.expected ? await identity(options.expected) : null,
    scope: { real_model: false, task_submission_supported: false, remote_notion: false,
      complete_extension_census: false, provider_wire_observed: false } });
  let receipt;
  try {
    receipt = await runEnvironment({ root, build: options.build, target: 'command', cwd: 'workspace', id: runId,
      'pi-mode': options.mode, ...(options.mode === 'native' ? { 'native-skills': options.skills } : { skills: options.skills }),
      'pi-extension': [observer], 'pass-env': [], 'timeout-ms': '180000', stdin: 'ignore',
      args: ['node', join(plannedRunRoot, 'source/broker/benchmark/runtime/probe-child.mjs'), nonce, observer] });
    const runPath = join(receipt.root, 'run.json'), nativeResultPath = join(receipt.root, 'result.json');
    const run = await json(runPath), childPath = join(receipt.root, 'benchmark/probe.json');
    const probe = await json(childPath);
    const snapshotPath = join(receipt.root, 'benchmark', 'observation-' + nonce + '.json');
    const snapshotIdentity = await identity(snapshotPath), snapshot = await json(snapshotPath);
    assert.equal(probe.status, 'passed', 'Real Pi bootstrap probe failed');
    assert.equal(probe.model_requests, 0, 'Phase 0 did not observe a verified no-request boundary');
    assert.equal(probe.control_scope?.business_tasks_submitted, 0, 'Phase 0 submitted a business task');
    assert.equal(probe.graceful_eof, true, 'Pi did not finish through a normal EOF boundary');
    assert.equal(snapshot.nonce, nonce, 'Observation belongs to another control command');
    assert.equal(probe.snapshot?.sha256, snapshotIdentity.sha256, 'Child snapshot receipt does not match retained bytes');
    assert.equal(receipt.status, 'passed', 'Isolated run failed, drifted, or changed its frozen package');
    const loaded = inspectObservation(snapshot, run);
    assert.ok(loaded.valid, loaded.errors.map(error => error.message).join('; '));
    const corpusAfter = await inventory(options.skills);
    assert.equal(corpusAfter.sha256, corpusBefore.sha256, 'Selected corpus changed while probing');
    const copyRoot = options.mode === 'native' ? run.pi_launch.native_skill_roots[0] : join(receipt.root, 'skills/selected');
    const copied = await inventory(copyRoot);
    assert.equal(copied.sha256, corpusBefore.sha256, 'The run did not consume a byte-equivalent complete corpus tree');
    const projection = projectObservation(snapshot, run, build);
    projection.corpus = { sha256: copied.sha256, files: copied.files };
    const comparison = expected ? compareObservation(expected, projection) : null;
    const proposal = createExpectation(projection, options.condition ?? options.mode + '-phase0', snapshotIdentity);
    await save(join(output, 'load-proposal.json'), proposal);
    const result = { schema_version: 1, kind: 'benchmark-phase0-result',
      status: comparison ? comparison.matched ? 'matched' : 'rejected' : 'captured',
      run_id: runId, run_root: receipt.root, build_id: options.build, host: hostname(),
      mode: options.mode, condition_id: proposal.condition_id, observation_sha256: fingerprint(projection),
      comparison, task_execution_enabled: false, real_model_episodes: 0,
      controlled_rpc_command: 'benchmark-inspect', native_run_status: receipt.status,
      runtime_check: receipt.runtime_check.status, corpus_copy: { sha256: copied.sha256, equivalent: true },
      graceful_eof: probe.graceful_eof, observed_model_requests: probe.model_requests,
      evidence: { native_run: await identity(runPath), native_result: await identity(nativeResultPath),
        child_probe: await identity(childPath), snapshot: snapshotIdentity, proposal: await identity(join(output, 'load-proposal.json')) },
      limitations: ['Registered resources are observed, not a complete census of silent loaded extensions.',
        'Initial registered definitions and model selection are observed; final provider wire, backend and effective usage are not.',
        'This no-model probe cannot authorize or score a business episode.'] };
    await save(join(output, 'result.json'), result);
    return { ...result, output };
  } catch (error) {
    const failure = { schema_version: 1, kind: 'benchmark-phase0-result', status: 'failed',
      error: error.message, run_id: runId, run_root: plannedRunRoot, output,
      native_run_status: receipt?.status ?? 'unavailable', real_model_episodes: 0, task_execution_enabled: false };
    await save(join(output, 'failure.json'), failure);
    return failure;
  }
}
