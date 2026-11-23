import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { applyBenchmarkFixtureEvent, reconcileBenchmarkFixtureEvent, attachBenchmarkFixtureRuntime } from './fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value);
const safeResource = value => typeof value === 'string' && value && !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..');
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const runtimeKeys = ['NTN_SKILLS_HOME', 'NTN_SKILLS_CONFIG_HOME', 'NTN_SKILLS_CACHE_HOME', 'NTN_SKILLS_DATA_HOME'];
const fileShape = file => ({ path: file.resource_path ?? file.path, sha256: file.sha256, bytes: file.bytes, mode: file.mode });
const ordered = rows => [...rows].sort((a, b) => a.path.localeCompare(b.path));
async function own(path, root) {
  assert.ok(isAbsolute(path) && resolve(path) === path && inside(root, path), 'FIXTURE_TURN_PATH_ESCAPE');
  assert.equal(await realpath(path), path, 'FIXTURE_TURN_SYMLINK'); return path;
}
async function makeDirectory(path, root) {
  assert.ok(inside(root, path), 'FIXTURE_TURN_PATH_ESCAPE');
  let ancestor = path;
  while (!await exists(ancestor)) ancestor = dirname(ancestor);
  await own(ancestor, root);
  await mkdir(path, { recursive: true, mode: 0o700 }); await own(path, root);
}
async function artifact(path, root, expected) {
  const bytes = await readFile(await own(path, root));
  assert.ok((await lstat(path)).isFile(), 'FIXTURE_TURN_ORDINARY_FILE');
  if (expected) {
    assert.equal(sha(bytes), expected.sha256, 'FIXTURE_TURN_EVIDENCE_CHANGED');
    if (expected.bytes !== undefined) assert.equal(bytes.length, expected.bytes);
  }
  return { path, sha256: sha(bytes), bytes: bytes.length };
}
async function save(path, value, root) {
  await makeDirectory(dirname(path), root);
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
  return artifact(path, root);
}
async function inventory(root, prefix = '') {
  const files = [];
  for (const item of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? prefix + '/' + item.name : item.name, actual = join(root, path);
    assert.ok(!item.isSymbolicLink(), 'FIXTURE_TURN_TREE_SYMLINK');
    if (item.isDirectory()) files.push(...await inventory(root, path));
    else {
      assert.ok(item.isFile(), 'FIXTURE_TURN_TREE_NONFILE');
      const bytes = await readFile(actual), info = await lstat(actual);
      files.push({ path, sha256: sha(bytes), bytes: bytes.length, mode: info.mode & 0o111 ? '100755' : '100644', permissions: info.mode & 0o777 });
    }
  }
  return files;
}
const logicalTree = rows => ordered(rows.map(fileShape));
const abortError = signal => { if (signal?.aborted) throw Object.assign(new Error('FIXTURE_TURN_ABORTED'), { code: 'FIXTURE_TURN_ABORTED' }); };

async function verifyRun(config) {
  await own(config.runRoot, config.runRoot);
  const runFile = join(config.runRoot, 'run.json'), run = await json(runFile);
  assert.equal(run.run_id, config.runId); assert.equal(run.root, config.runRoot);
  const events = await readFile(await own(join(config.runRoot, 'benchmark/runtime/events.jsonl'), config.runRoot));
  const firstEnd = events.indexOf(10); assert.ok(firstEnd >= 0, 'FIXTURE_TURN_RUNTIME_START_MISSING');
  const first = JSON.parse(events.subarray(0, firstEnd + 1));
  assert.equal(first.type, 'runtime_start'); assert.equal(first.run_id, config.runId); assert.equal(first.episode_id, config.runId);
  assert.ok(inside(config.runRoot, first.data.cwd));
  return { run, owner: { run: await artifact(runFile, config.runRoot), runtime_start_sha256: sha(events.subarray(0, firstEnd + 1)) } };
}
async function verifyFixtureResult(value, config, event) {
  assert.ok(value && value.event_id === event.id && value.episode_id === config.runId, 'FIXTURE_TURN_RESULT_IDENTITY');
  const ref = await artifact(value.receipt.path, config.fixtureRoot, value.receipt), actual = await json(ref.path);
  for (const key of ['event_id', 'episode_id', 'status']) assert.equal(actual[key], value[key], 'FIXTURE_TURN_RECEIPT_IDENTITY');
  assert.ok(['applied', 'blocked', 'failed', 'not_applied', 'unknown'].includes(actual.status));
  if (actual.status === 'applied') {
    assert.equal(actual.effect_verified, true); assert.equal(actual.effect_unknown, false);
    assert.ok(actual.effect_evidence?.length > 0, 'FIXTURE_TURN_NO_EFFECT_EVIDENCE');
    for (const evidence of actual.effect_evidence) await artifact(evidence.path, config.fixtureRoot, evidence);
  }
  // The on-disk receipt owns every native tree and readback field, not a callback summary.
  return { ...actual, receipt: ref };
}
async function versionTree(value, config, event) {
  const tree = value.native_version;
  assert.ok(tree && safeId(tree.target_name) && /^[a-z0-9][a-z0-9-]{0,63}$/.test(tree.target_name), 'FIXTURE_TURN_NATIVE_VERSION_REQUIRED');
  await own(tree.skill_root, config.fixtureRoot);
  assert.ok(Array.isArray(tree.files) && tree.files.length > 0);
  assert.equal(new Set(tree.files.map(file => file.resource_path)).size, tree.files.length);
  for (const file of tree.files) {
    assert.ok(safeResource(file.resource_path), 'FIXTURE_TURN_RESOURCE_ESCAPE');
    assert.equal(file.skill_id, event.skill_id); assert.equal(file.version, event.version);
    assert.ok(['100644', '100755'].includes(file.mode), 'FIXTURE_TURN_MODE_INVALID');
    assert.equal(file.path, join(tree.skill_root, tree.target_name, file.resource_path));
    await artifact(file.path, config.fixtureRoot, file);
  }
  assert.ok(tree.files.some(file => file.resource_path === 'SKILL.md'), 'FIXTURE_TURN_MAIN_MISSING');
  const observed = logicalTree(await inventory(join(tree.skill_root, tree.target_name)));
  assert.deepEqual(observed, logicalTree(tree.files), 'FIXTURE_TURN_INCOMPLETE_NATIVE_TREE');
  const readback = await artifact(tree.readback.path, config.fixtureRoot, tree.readback);
  const raw = await artifact(tree.raw_readback.path, config.fixtureRoot, tree.raw_readback);
  const receipt = await json(readback.path);
  assert.equal(receipt.status, 'passed'); assert.deepEqual(logicalTree(receipt.observed.files), observed, 'FIXTURE_TURN_NATIVE_READBACK_MISMATCH');
  assert.equal(receipt.rawEvidence?.sha256, raw.sha256); assert.equal(receipt.rawEvidence?.path, raw.path);
  return { tree, observed, readback, raw };
}
async function nativeTarget(config, event, run) {
  const root = run.pi_launch?.native_corpus?.root;
  assert.ok(root && inside(config.runRoot, root), 'FIXTURE_TURN_NATIVE_ROOT_REQUIRED'); await own(root, config.runRoot);
  const originals = config.binding.skill_inventory.filter(file => file.skill_id === event.skill_id);
  assert.ok(originals.length > 0, 'FIXTURE_TURN_NATIVE_INITIAL_TREE_MISSING');
  const targetNames = [...new Set(originals.map(file => {
    assert.ok(safeResource(file.resource_path)); const suffix = '/' + file.resource_path;
    assert.ok(file.path.endsWith(suffix)); return file.path.slice(0, -suffix.length).split('/').at(-1);
  }))];
  assert.equal(targetNames.length, 1); assert.ok(safeId(targetNames[0]));
  const target = join(root, targetNames[0]); await own(target, config.runRoot);
  return { root, target, target_name: targetNames[0], initial: logicalTree(originals), before: await inventory(target) };
}

/** Complete-tree replacement occurs only while the subject is paused. Each rename
 * is atomic; the durable intent records the gap between them. A crash never
 * licenses an automatic repeat or an unverified claim of a successful switch. */
export async function installVerifiedNativeVersion(config, event, value, state, signal) {
  value = await verifyFixtureResult(value, config, event);
  const { run, owner } = await verifyRun(config), target = await nativeTarget(config, event, run);
  const source = await versionTree(value, config, event); assert.equal(source.tree.target_name, target.target_name);
  assert.deepEqual(logicalTree(target.before), state.native_before, 'FIXTURE_TURN_NATIVE_CHANGED_DURING_EVENT');
  const eventRoot = join(config.adapterRoot, event.id), stage = join(config.runRoot, 'benchmark/native-staging', event.id);
  const history = join(eventRoot, 'native-before'), intentFile = join(eventRoot, 'native-install-intent.json');
  assert.equal(await exists(intentFile), false, 'FIXTURE_TURN_NATIVE_INTERRUPTED');
  await makeDirectory(stage, config.runRoot);
  for (const file of source.tree.files) {
    abortError(signal); const destination = join(stage, file.resource_path);
    await makeDirectory(dirname(destination), config.runRoot);
    await writeFile(destination, await readFile(file.path), { flag: 'wx', mode: file.mode === '100755' ? 0o500 : 0o400 });
    await chmod(destination, file.mode === '100755' ? 0o500 : 0o400);
  }
  const staged = await inventory(stage); assert.deepEqual(logicalTree(staged), source.observed);
  const intent = { version: 1, event_id: event.id, episode_id: config.runId, target: target.target, stage, history,
    before: target.before, after: staged, source_receipt: value.receipt, readback: source.readback, raw_readback: source.raw, owner,
    atomic_unit: 'each-directory-rename', consistency_boundary: 'settled-turn-subject-paused' };
  await save(intentFile, intent, config.adapterRoot); abortError(signal);
  await rename(target.target, history); abortError(signal);
  await rename(stage, target.target);
  const after = await inventory(target.target), preserved = await inventory(history);
  assert.deepEqual(logicalTree(after), source.observed); assert.deepEqual(preserved, target.before);
  return save(join(eventRoot, 'native-installation.json'), { ...intent, status: 'applied', effect_verified: true,
    before_retained: preserved, after, observed_after_sha256: sha(JSON.stringify(after)) }, config.adapterRoot);
}
async function reconcileNative(config, event, value) {
  const file = join(config.adapterRoot, event.id, 'native-install-intent.json');
  assert.ok(await exists(file), 'FIXTURE_TURN_NO_NATIVE_INTENT');
  const intent = await json(file), source = await versionTree(value, config, event);
  assert.equal(intent.event_id, event.id); assert.equal(intent.episode_id, config.runId);
  await own(intent.target, config.runRoot); await own(intent.history, config.adapterRoot);
  assert.deepEqual(await inventory(intent.history), intent.before);
  assert.deepEqual(logicalTree(await inventory(intent.target)), source.observed);
  const proof = join(config.adapterRoot, event.id, 'native-reconciled.json');
  if (await exists(proof)) return artifact(proof, config.adapterRoot);
  return save(proof, { version: 1, event_id: event.id, episode_id: config.runId, status: 'applied', effect_verified: true,
    read_only: true, intent: await artifact(file, config.adapterRoot), before: intent.before, after: await inventory(intent.target),
    fixture_receipt: value.receipt }, config.adapterRoot);
}

export function freezeClarificationPolicy(clarifications, supplied) {
  const defaults = {
    'delivery-mode': ['配送', '送达', 'delivery', 'shipping'],
    'target-currency': ['币种', '货币', 'currency'],
  };
  const policy = supplied ?? { version: 1, kind: 'literal-question-topic-v1',
    topics: clarifications.map(item => ({ topic_id: item.topic_id, match_any: defaults[item.topic_id] ?? [] })) };
  assert.equal(policy.version, 1); assert.equal(policy.kind, 'literal-question-topic-v1');
  assert.ok(Array.isArray(policy.topics) && new Set(policy.topics.map(topic => topic.topic_id)).size === policy.topics.length);
  for (const topic of policy.topics) {
    assert.ok(clarifications.some(item => item.topic_id === topic.topic_id), 'FIXTURE_TURN_UNKNOWN_CLARIFICATION_TOPIC');
    assert.ok(Array.isArray(topic.match_any) && topic.match_any.length && topic.match_any.every(term => typeof term === 'string' && term.length > 0 && term.length <= 80), 'FIXTURE_TURN_CLARIFICATION_RULE_REQUIRED');
  }
  assert.equal(policy.topics.length, clarifications.length);
  return structuredClone(policy);
}
export function selectFrozenClarification({ observation, available }, policy) {
  const text = String(observation.final_text ?? '').slice(0, 32768).toLocaleLowerCase();
  // An explicit request for missing information need not end in a question mark.
  if (!/[?？]|请(?:问|确认|选择|提供|指定|告知|告诉(?:我们|我))|\b(?:could|would)\s+you\b|\bplease\s+(?:confirm|choose|provide|specify|tell\s+(?:me|us))\b/u.test(text)) return null;
  const matched = policy.topics.filter(topic => available.some(item => item.topic_id === topic.topic_id)
    && topic.match_any.some(term => text.includes(term.toLocaleLowerCase())));
  return matched.length === 1 ? matched[0].topic_id : null;
}

/** Parent-only adapter. operations is an apparatus seam; production supplies none.
 * Fixture plans, oracle data and event receipts never enter subject configuration. */
export async function createFixtureTurnAdapter({ runRoot, runId, mode, binding, controllerRoot, operations } = {}) {
  assert.ok(safeId(runId) && ['native', 'broker'].includes(mode)); assert.ok(isAbsolute(runRoot) && isAbsolute(controllerRoot));
  const events = binding.events ?? [], adapterRoot = join(controllerRoot, 'fixture-adapter');
  await own(controllerRoot, controllerRoot); await makeDirectory(adapterRoot, controllerRoot);
  const api = operations ?? { apply: applyBenchmarkFixtureEvent, reconcile: reconcileBenchmarkFixtureEvent, attach: attachBenchmarkFixtureRuntime };
  let fixtureRoot = null, frozen = null;
  if (events.length) {
    const ref = binding.fixture_control; assert.ok(ref && isAbsolute(ref.path) && ref.path.endsWith('/plan.json'), 'FIXTURE_TURN_FROZEN_PLAN_REQUIRED');
    fixtureRoot = dirname(ref.path);
    assert.ok(!inside(runRoot, fixtureRoot) && !inside(fixtureRoot, runRoot), 'FIXTURE_TURN_PRIVATE_PLAN_REQUIRED');
    await artifact(ref.path, fixtureRoot, ref); frozen = await json(ref.path);
    const { plan_sha256, ...body } = frozen; assert.equal(sha(JSON.stringify(body)), plan_sha256, 'FIXTURE_TURN_PLAN_CHANGED');
    assert.equal(frozen.control_root, fixtureRoot); assert.equal(frozen.access, 'episode-owned'); assert.equal(frozen.episode_id, runId);
    assert.equal(frozen.owned_runtime_root, runRoot);
    for (const event of events) {
      assert.ok(safeId(event.id)); const allowed = frozen.events.find(item => item.id === event.id); assert.ok(allowed, 'FIXTURE_TURN_EVENT_NOT_FROZEN');
      for (const [key, value] of Object.entries(event)) assert.deepEqual(allowed[key], value, 'FIXTURE_TURN_EVENT_CHANGED: ' + key);
    }
  }
  const config = { runRoot, runId, mode, binding, controllerRoot, adapterRoot, fixtureRoot };
  const terminal = async event => {
    const path = join(adapterRoot, event.id, 'receipt.json');
    if (!await exists(path)) return null;
    const value = await json(path);
    assert.equal(value.event_id, event.id); assert.equal(value.episode_id, runId);
    for (const proof of value.effect_evidence ?? []) {
      const root = inside(adapterRoot, proof.path) ? adapterRoot : fixtureRoot;
      await artifact(proof.path, root, proof);
    }
    return { ...value, receipt: await artifact(path, adapterRoot), reused: true };
  };
  const finish = async (event, status, extra = {}) => {
    const value = { schema_version: 1, event_id: event.id, episode_id: runId, status,
      logical_operation: frozen?.events.find(item => item.id === event.id)?.logical_operation ?? { skill_id: event.skill_id, intent: event.kind },
      effect_unknown: status === 'unknown', effect_verified: status === 'applied', evidence_id: 'fixture-turn-' + event.id, ...extra };
    const receipt = await save(join(adapterRoot, event.id, status === 'not_applied' ? 'not-applied-' + randomUUID() + '.json' : 'receipt.json'), value, adapterRoot);
    return { ...value, receipt };
  };
  async function perform({ event, eventId, episodeId, signal }, reconcileOnly) {
    assert.equal(eventId, event?.id); assert.equal(episodeId, runId);
    const expected = events.find(item => item.id === eventId); assert.deepEqual(event, expected, 'FIXTURE_TURN_EVENT_CHANGED');
    const prior = await terminal(event); if (prior) return prior;
    if (mode === 'native' && event.kind !== 'publish-version') return finish(event, 'blocked', {
      reason: 'This Notion or Store-specific event has no declared native counterpart', capability_scope: 'unsupported_native', dispatched: false });
    const startedFile = join(adapterRoot, event.id, 'started.json');
    if (!reconcileOnly && await exists(startedFile)) return perform({ event, eventId, episodeId, signal }, true);
    let state;
    try {
      abortError(signal); const { run, owner } = await verifyRun(config);
      const gitFile = join(fixtureRoot, 'git-runtime.json');
      if (await exists(gitFile)) {
        const selected = await json(gitFile), actual = run.runtime?.git;
        assert.ok(actual && selected.git, 'FIXTURE_TURN_SELECTED_GIT_MISSING');
        assert.equal(actual.path, selected.git.path, 'FIXTURE_TURN_SELECTED_GIT_CHANGED');
        assert.equal(actual.sha256, selected.git.sha256, 'FIXTURE_TURN_SELECTED_GIT_CHANGED');
        assert.equal(actual.version, selected.version, 'FIXTURE_TURN_SELECTED_GIT_CHANGED');
        owner.fixture_git = await artifact(gitFile, fixtureRoot);
      } else if (['interrupt-source-write', 'resume-source-write'].includes(event.kind)) {
        throw new Error('FIXTURE_TURN_SOURCE_EVENT_GIT_PROOF_REQUIRED');
      }
      if (await exists(startedFile)) state = await json(startedFile);
      else {
        let before = null;
        if (mode === 'native') {
          const target = await nativeTarget(config, event, run); before = logicalTree(target.before);
          assert.deepEqual(before, target.initial, 'FIXTURE_TURN_INITIAL_NATIVE_DRIFT');
        }
        state = { version: 1, event_id: eventId, episode_id: runId, native_before: before, owner, fixture_plan: binding.fixture_control };
        if (!reconcileOnly) await save(startedFile, state, adapterRoot);
      }
      if (['fault', 'restore-fault'].includes(event.kind)) {
        const env = Object.fromEntries(runtimeKeys.map(key => [key, run.paths[key]]));
        await api.attach({ controlRoot: fixtureRoot, episodeId: runId, ownedStateRoot: env.NTN_SKILLS_HOME, runtimeEnv: env });
      }
      abortError(signal);
      const returned = await (reconcileOnly ? api.reconcile : api.apply)({ controlRoot: fixtureRoot, eventId, episodeId: runId });
      const value = await verifyFixtureResult(returned, config, event); abortError(signal);
      let installation = null;
      if (value.status === 'applied' && mode === 'native') installation = await (reconcileOnly
        ? reconcileNative(config, event, value) : installVerifiedNativeVersion(config, event, value, state, signal));
      return finish(event, value.status, { fixture_receipt: value.receipt,
        effect_evidence: [value.receipt, ...(value.effect_evidence ?? []), ...(installation ? [installation] : [])],
        ...(installation ? { native_installation: installation } : {}), ...(reconcileOnly ? { reconciled: true } : {}) });
    } catch (error) {
      return finish(event, 'unknown', { reason: error.message, error_code: error.code ?? null,
        recovery: 'Read-only reconciliation is required; the adapter will not repeat an unknown operation.' });
    }
  }
  return { evidenceRoots: fixtureRoot ? [fixtureRoot] : [], executeEvent: context => perform(context, false), reconcileEvent: context => perform(context, true) };
}

