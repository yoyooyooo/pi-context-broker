import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { runEnvironment } from '../scripts/paired-environment.mjs';
import { resolveModelCredential } from './models.mjs';
import { createTurnBridgeController, readTurnBridgeJournal } from './turn-bridge.mjs';
import { createFixtureTurnAdapter, freezeClarificationPolicy, selectFrozenClarification } from './fixture-turn-adapter.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

/** Parent readback for stop decisions. Incomplete controller evidence never
 * changes actual model accounting and never authorizes another dispatch. */
export async function readSubjectTurnControl({ controlRoot, runRoot, runId, required = false }) {
  assert.ok(isAbsolute(controlRoot) && isAbsolute(runRoot) && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(runId));
  const privateRoot = join(controlRoot, 'turn-control', runId), resultFile = join(privateRoot, 'result.json');
  let result = null, receipt = null;
  const checkedRead = async path => {
    assert.equal(await realpath(path), path, 'TURN_CONTROL_RECEIPT_SYMLINK');
    const info = await lstat(path); assert.ok(info.isFile() && info.size <= 64 * 1024 * 1024, 'TURN_CONTROL_RECEIPT_LIMIT');
    return readFile(path);
  };
  try {
    try {
      const launch = JSON.parse(await checkedRead(join(controlRoot, runId + '.launch.json')));
      required ||= Boolean(launch.turn_bridge);
      if (launch.turn_bridge) {
        assert.equal(launch.turn_bridge.runRoot, runRoot); assert.equal(launch.turn_bridge.runId, runId);
        assert.equal(launch.turn_bridge.episodeId, runId);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let bytes;
    try { bytes = await checkedRead(resultFile); }
    catch (error) {
      if (error.code === 'ENOENT' && !required) {
        try { await lstat(privateRoot); } catch (missing) { if (missing.code === 'ENOENT') return { status: 'absent', required: false, result: null, receipt: null }; throw missing; }
      }
      throw error;
    }
    required = true; result = JSON.parse(bytes); receipt = { path: resultFile, sha256: sha(bytes), bytes: bytes.length };
    assert.equal(result.version, 1); assert.equal(result.run_id, runId); assert.equal(result.episode_id, runId);
    assert.ok(['completed', 'stopped'].includes(result.status));
    assert.equal(result.public_root, join(runRoot, 'benchmark/turn-bridge'));
    assert.equal(result.plan?.path, join(privateRoot, 'plan.json'));
    assert.equal(sha(await checkedRead(result.plan.path)), result.plan.sha256, 'TURN_CONTROL_PLAN_CHANGED');
    const plan = JSON.parse(await checkedRead(result.plan.path)); assert.equal(plan.run_id, runId); assert.equal(plan.episode_id, runId);
    assert.equal(result.journal?.path, join(privateRoot, 'controller.jsonl'));
    assert.equal(sha(await checkedRead(result.journal.path)), result.journal.sha256, 'TURN_CONTROL_JOURNAL_CHANGED');
    const rows = await readTurnBridgeJournal(result.journal.path); assert.equal(rows.length, result.journal.rows);
    assert.equal(rows[0]?.type, 'controller_prepared'); assert.equal(rows[0]?.data.plan_sha256, result.plan.sha256);
    assert.equal(rows.at(-1)?.type, 'controller_end'); assert.equal(rows.at(-1)?.data.status, result.status);
    assert.equal(rows.at(-1)?.data.completed_checkpoints, result.completed_checkpoints);
    for (const row of rows) { assert.equal(row.run_id, runId); assert.equal(row.episode_id, runId); }
    const accepted = rows.filter(row => row.type === 'checkpoint_accepted');
    if (result.status === 'completed') {
      const decisions = rows.filter(row => row.type === 'checkpoint_decided');
      assert.equal(decisions.length, result.completed_checkpoints, 'TURN_CONTROL_CHECKPOINT_COUNT');
      assert.ok(decisions.every(row => row.data.response.action === 'continue'), 'TURN_CONTROL_UNVERIFIED_RESUME');
      assert.ok(rows.filter(row => row.type === 'event_result').every(row => row.data.result.status === 'applied'), 'TURN_CONTROL_UNKNOWN_EVENT');
    }
    if (accepted.length) {
      const path = join(runRoot, 'benchmark/runtime/events.jsonl'), events = (await checkedRead(path)).toString('utf8').split('\n');
      for (const row of accepted) {
        const ref = row.data.observation.ref; assert.equal(ref.path, path);
        assert.ok(Number.isSafeInteger(ref.through_line) && ref.through_line > 0 && ref.through_line < events.length);
        assert.equal(sha(events.slice(0, ref.through_line).join('\n') + '\n'), ref.prefix_sha256, 'TURN_CONTROL_CHECKPOINT_PREFIX_CHANGED');
      }
    }
    return { status: 'verified', required: true, result, receipt };
  } catch (error) { return { status: 'unavailable', required: true, result, receipt, reason: String(error.message) }; }
}

/** The only paid subject dispatch path; the controller itself never invokes a provider. */
export async function runSubject({ environmentRoot, buildId, mode, binding, model, modelsFile, runtime,
  controlRoot, runId, conditionId, budget, codeMode = 'free', expected, captureOnly = false, credential, notionEntry }, apparatus = {}) {
  for (const path of [environmentRoot, modelsFile, controlRoot]) assert.ok(isAbsolute(path));
  assert.ok(['native', 'broker'].includes(mode));
  assert.ok(['free', 'off', 'required'].includes(codeMode));
  if (!captureOnly) {
    assert.ok(expected && isAbsolute(expected.path), 'Paid execution requires the exact frozen expectation');
    assert.equal(sha(await readFile(expected.path)), expected.sha256, 'Frozen expectation bytes changed');
  }
  await mkdir(controlRoot, { recursive: true });
  const root = join(environmentRoot, 'runs', runId), events = binding.events ?? [], clarifications = binding.clarification ?? [];
  const turns = binding.public_case.turns.map(({ id, prompt }) => ({ id, prompt }));
  const needsBridge = !captureOnly && (turns.length > 1 || events.length > 0 || clarifications.length > 0);
  const bridgeRoot = join(controlRoot, 'turn-control', runId);
  const secrets = await (apparatus.resolveModelCredential ?? resolveModelCredential)({ sourceFile: credential.source_file, provider: credential.provider, apiKeyEnv: credential.api_key_env });
  let controller = null, adapter = null, clarificationPolicy = null;
  if (needsBridge) {
    await mkdir(bridgeRoot, { recursive: true, mode: 0o700 });
    clarificationPolicy = freezeClarificationPolicy(clarifications, binding.clarification_policy);
    adapter = await createFixtureTurnAdapter({ runRoot: root, runId, mode, binding, controllerRoot: bridgeRoot, operations: apparatus.fixtureOperations });
    controller = await createTurnBridgeController({ runRoot: root, controllerRoot: bridgeRoot, runId, episodeId: runId,
      turns, events, clarifications, evidenceRoots: adapter.evidenceRoots,
      policy: { clarification: clarificationPolicy, fixture: binding.fixture_control ?? null, native_event_scope: 'publish-version-only' },
      limits: { wallMs: budget.max_duration_ms + 60000, waitMs: budget.max_duration_ms,
        eventMs: Math.min(60000, budget.max_duration_ms), pollMs: 25 } });
  }
  const parameters = model.parameters;
  const launch = { run_id: runId, source_retention_root: join(controlRoot, 'controller-sources'),
    input_root: binding.input_root, input_inventory_sha256: binding.input_inventory_sha256,
    ...(controller ? { turn_bridge: controller.publicConfig } : {}),
    runtime_config: { version: 1, mode,
      model: { provider: model.provider, id: model.route ?? model.id, api: model.api, baseUrl: model.baseUrl,
        apiKeyEnv: credential.api_key_env, parameters }, runtime,
      limits: { wallTimeMs: budget.max_duration_ms, maxModelRequests: budget.max_model_requests, maxToolCalls: 40,
        maxHttpAttempts: budget.max_http_attempts, maxInputTokens: budget.max_input_tokens,
        maxOutputTokens: budget.max_output_tokens, maxTotalTokens: budget.max_input_tokens + budget.max_output_tokens },
      admission: { captureOnly, ...(expected ? { expectedFile: expected.path } : {}) },
      turns,
      correlation: { run_id: runId, episode_id: runId, candidate_id: conditionId, task_id: binding.id },
      codeMode: { policy: codeMode, enabled: codeMode !== 'off', toolSearchEnabled: true, models: false } } };
  const launchFile = join(controlRoot, runId + '.launch.json');
  try { await save(launchFile, launch); }
  catch (error) { await controller?.abandon('SUBJECT_LAUNCH_CONFIG_FAILED'); throw error; }
  const previous = Object.fromEntries(Object.keys(secrets).map(key => [key, process.env[key]]));
  Object.assign(process.env, secrets);
  let shared, turnControl = null, dispatchError = null;
  try {
    // Promise settlement is joint: a bridge failure must not hide the shared
    // process terminal or its actual request/usage artifacts.
    const subject = Promise.resolve().then(() => (apparatus.runEnvironment ?? runEnvironment)({ root: environmentRoot, build: buildId, target: 'command', id: runId,
      'pi-mode': mode, ...(mode === 'native' ? { 'native-skills': binding.skills_root }
        : notionEntry ? { entry: notionEntry } : { skills: binding.skills_root }),
      models: modelsFile, 'pass-env': [credential.api_key_env, ...(notionEntry ? ['NOTION_API_TOKEN'] : [])],
      'timeout-ms': Math.min(3600000, budget.max_duration_ms + 60000),
      args: ['node', join(environmentRoot, 'builds', buildId, 'source/broker/benchmark/subject.mjs'), launchFile] }));
    const bridge = controller ? controller.serve({ subject, executeEvent: adapter.executeEvent, reconcileEvent: adapter.reconcileEvent,
      selectClarification: observation => selectFrozenClarification(observation, clarificationPolicy) }) : Promise.resolve(null);
    const [subjectResult, bridgeResult] = await Promise.allSettled([subject, bridge]);
    if (subjectResult.status === 'fulfilled') shared = subjectResult.value;
    else {
      dispatchError = { name: subjectResult.reason?.name ?? 'Error', message: String(subjectResult.reason?.message ?? subjectResult.reason) };
      try { shared = JSON.parse(await readFile(join(root, 'result.json'), 'utf8')); } catch { shared = null; }
    }
    turnControl = bridgeResult.status === 'fulfilled' ? bridgeResult.value
      : { version: 1, run_id: runId, episode_id: runId, status: 'stopped', reason: 'TURN_CONTROLLER_FAILED',
        error: String(bridgeResult.reason?.message ?? bridgeResult.reason), journal_path: join(bridgeRoot, 'controller.jsonl') };
    if (controller) {
      try {
        const resultFile = join(bridgeRoot, 'result.json'); await save(resultFile, turnControl);
        turnControl = { ...turnControl, receipt: { path: resultFile, sha256: sha(await readFile(resultFile)) } };
      } catch (error) {
        turnControl = { ...turnControl, status: 'stopped', retention_error: String(error?.message ?? error) };
      }
    }
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  const resultPath = join(root, 'benchmark/runtime/episode-result.json');
  let episode;
  try { episode = JSON.parse(await readFile(resultPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: 1, status: 'invalid', run_id: runId, root, shared, episode: null, turn_control: turnControl, dispatch_error: dispatchError,
      error: 'No terminal runtime receipt; actual request/cost status remains unknown', stop_batch: true };
  }
  return { version: 1, status: episode.status, run_id: runId, root, shared, episode, result_path: resultPath, turn_control: turnControl, dispatch_error: dispatchError,
    stop_batch: dispatchError !== null || turnControl !== null && turnControl.status !== 'completed'
      || shared?.runtime_check?.status !== 'unchanged' || shared?.frozen_artifacts !== 'passed'
      || ['invalid', 'admission_rejected', 'failed', 'cancelled'].includes(episode.status) };
}
