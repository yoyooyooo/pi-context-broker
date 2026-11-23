import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fingerprint } from './protocol.mjs';
import { planBenchmarkFixture, prepareBenchmarkFixture, reconcileBenchmarkFixture } from './fixture.mjs';
import { bindMaterializedCases } from './planning.mjs';
import { diagnosticBinding, episodeFixtureSelections, validateFixtureDiagnostics } from './fixture-diagnostics.mjs';
import { NATIVE_MAIN_EXACT_RESOURCES } from '../scripts/notion-agent-authoring.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => { const child = relative(root, path); return child === '' || child !== '..' && !child.startsWith('../') && !isAbsolute(child); };
const runIdFor = (id, slot) => id + '-' + String(slot.order + 1).padStart(3, '0');
const json = path => readFile(path, 'utf8').then(JSON.parse);
const present = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

async function canonicalDirectory(path) {
  assert.ok(isAbsolute(path));
  let current = path;
  for (;;) {
    try { assert.equal(await realpath(current), current, 'Episode fixture path cannot traverse a symlink'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; const parent = dirname(current); assert.notEqual(parent, current); current = parent; }
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(path), path); return path;
}
async function artifact(path, root, expected) {
  assert.ok(isAbsolute(path) && inside(root, path), 'Episode fixture evidence escaped its private root');
  assert.equal(await realpath(path), path, 'Episode fixture evidence cannot be a symlink');
  const stat = await lstat(path); assert.ok(stat.isFile() && stat.size <= 64 * 1024 * 1024);
  const bytes = await readFile(path), ref = { path, sha256: sha(bytes), bytes: bytes.length };
  if (expected) { assert.equal(ref.sha256, expected.sha256, 'Frozen episode fixture evidence changed'); if (expected.bytes !== undefined) assert.equal(ref.bytes, expected.bytes); }
  return ref;
}
async function save(path, value) {
  await canonicalDirectory(dirname(path));
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return artifact(path, dirname(path));
}

/** This policy authorizes only initial fixture preparation before registration.
 * All episode events remain in the canonical case and owned fixture plan. */
export function validateEpisodeFixturePolicy(policy, { required = false } = {}) {
  if (policy === undefined) { assert.equal(required, false, 'Cases with events require setup.episode_fixtures before capture'); return null; }
  assert.equal(policy.version, 1);
  assert.deepEqual(Object.keys(policy).filter(key => !['version', 'project_page_id', 'placement', 'source_bindings', 'authoring', 'authoring_by_skill', 'git', 'diagnostics'].includes(key)), []);
  assert.match(policy.project_page_id, /^[a-f0-9-]{32,36}$/i);
  assert.equal(policy.placement ?? 'notion', 'notion', 'Per-slot preparation currently requires a complete Notion/source catalog');
  if (policy.authoring !== undefined) assert.equal(policy.authoring, NATIVE_MAIN_EXACT_RESOURCES, 'Unknown fixture authoring policy');
  assert.ok(policy.authoring === undefined || policy.authoring_by_skill === undefined, 'Select global authoring or an explicit per-Skill map, not both');
  if (policy.authoring_by_skill !== undefined) {
    assert.ok(policy.authoring_by_skill && typeof policy.authoring_by_skill === 'object' && !Array.isArray(policy.authoring_by_skill)
      && Object.keys(policy.authoring_by_skill).length > 0, 'Per-Skill authoring requires a nonempty canonical Skill map');
    for (const value of Object.values(policy.authoring_by_skill)) assert.equal(value, NATIVE_MAIN_EXACT_RESOURCES, 'Unknown fixture authoring policy');
  }
  if (policy.git !== undefined) assert.ok(isAbsolute(policy.git));
  assert.ok(policy.source_bindings === undefined || policy.source_bindings && typeof policy.source_bindings === 'object' && !Array.isArray(policy.source_bindings));
  validateFixtureDiagnostics(policy.diagnostics);
  return structuredClone(policy);
}

function slotAuthoring(policy, skillIds) {
  const selected = Object.fromEntries(Object.entries(policy.authoring_by_skill ?? {}).filter(([skillId]) => skillIds.includes(skillId)));
  return { authoring: policy.authoring, ...(Object.keys(selected).length ? { authoringBySkill: selected } : {}) };
}
function validateAuthoringSelection(policy, selections) {
  const ownedSkills = new Set([...selections.values()].flatMap(item => item.baseBinding.public_case.catalog.skill_ids));
  for (const skillId of Object.keys(policy?.authoring_by_skill ?? {}))
    assert.ok(ownedSkills.has(skillId), 'Authoring map names a Skill outside the scheduled owned catalogs: ' + skillId);
}

function materialIdentity(binding) {
  return fingerprint(binding.skill_inventory.map(file => ({ skill_id: file.skill_id, resource_path: file.resource_path,
    sha256: file.sha256, bytes: file.bytes, mode: file.mode })).sort((a, b) => (a.skill_id + '/' + a.resource_path).localeCompare(b.skill_id + '/' + b.resource_path)));
}
async function bindPrepared({ baseBinding, materialization, fixturePlan, fixtureRoot }) {
  assert.equal(materialization.access, 'episode-owned'); assert.equal(materialization.episode_id, fixturePlan.episode_id);
  assert.equal(materialization.control_root, fixtureRoot);
  assert.equal(materialization.public_sha256, fixturePlan.corpus.publicCorpus.content_sha256);
  // objects/bindings.json is mutable during events. Derivation must use the
  // initial immutable snapshot even when an old episode is later reanalyzed.
  const prepared = materialization.prepared_bindings;
  assert.ok(prepared); await artifact(prepared.path, fixtureRoot, prepared);
  const [bound] = await bindMaterializedCases({ cases: [baseBinding],
    materialization: { ...materialization, fixture_bindings_path: prepared.path } });
  return { ...bound, protocol_case: structuredClone(baseBinding.protocol_case),
    fixture_control: await artifact(join(fixtureRoot, 'plan.json'), fixtureRoot) };
}
async function readSlot({ ref, slot, id, baseBinding, environmentRoot, controlRoot, policy, candidate, runtime, corpus }) {
  const episode = diagnosticBinding(baseBinding, slot.condition_id, policy.diagnostics);
  assert.equal(ref.path, join(controlRoot, 'slot-bindings', runIdFor(id, slot) + '.json'));
  await artifact(ref.path, controlRoot, ref); const record = await json(ref.path);
  assert.equal(record.version, 1); assert.equal(record.kind, 'benchmark-slot-materialization');
  assert.equal(record.slot_id, slot.slot_id); assert.equal(record.run_id, runIdFor(id, slot));
  assert.equal(record.slot_sha256, fingerprint(slot));
  assert.equal(record.case_id, slot.case_id); assert.equal(record.condition_id, slot.condition_id);
  assert.equal(record.canonical_binding_sha256, fingerprint(baseBinding));
  assert.equal(record.policy_sha256, fingerprint(policy));
  const fixtureRoot = join(controlRoot, 'episode-fixtures', record.run_id);
  assert.equal(record.fixture_plan.path, join(fixtureRoot, 'plan.json'));
  await artifact(record.fixture_plan.path, fixtureRoot, record.fixture_plan);
  const plan = await json(record.fixture_plan.path), { plan_sha256, ...body } = plan;
  assert.equal(sha(JSON.stringify(body)), plan_sha256);
  if (corpus !== undefined) assert.deepEqual(plan.corpus, corpus, 'Prepared fixture must retain the same complete public and private corpus');
  assert.equal(plan.authoring, policy.authoring, 'Prepared fixture authoring policy differs');
  assert.deepEqual(plan.authoring_by_skill, slotAuthoring(policy, baseBinding.public_case.catalog.skill_ids).authoringBySkill, 'Prepared fixture per-Skill authoring policy differs');
  assert.equal(plan.access, 'episode-owned'); assert.equal(plan.episode_id, record.run_id);
  assert.equal(plan.control_root, fixtureRoot); assert.equal(plan.owned_runtime_root, join(environmentRoot, 'runs', record.run_id));
  assert.equal(plan.project_page_id, policy.project_page_id);
  assert.equal(record.build_id, candidate.build_id);
  assert.equal(plan.build_root, join(environmentRoot, 'builds', candidate.build_id));
  assert.equal(plan.node, runtime.node);
  assert.deepEqual(plan.events.map(event => event.id), (episode.binding.events ?? []).map(event => event.id), 'Frozen fixture events differ from the scheduled arm');
  for (const expected of episode.binding.events ?? []) {
    const event = plan.events.find(value => value.id === expected.id);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(event[key], value, 'Frozen fixture event changed: ' + key);
  }
  await artifact(record.materialization.path, fixtureRoot, record.materialization);
  const binding = await bindPrepared({ baseBinding: episode.binding, materialization: await json(record.materialization.path), fixturePlan: plan, fixtureRoot });
  assert.deepEqual(record.binding, binding, 'Frozen slot binding differs from its canonical case and actual material');
  assert.equal(record.public_case_sha256, fingerprint(binding.public_case));
  assert.equal(record.public_prompt_sha256, fingerprint(binding.public_case.turns));
  assert.equal(record.initial_material_sha256, materialIdentity(binding));
  assert.equal(record.authorization_sha256, baseBinding.protocol_case.authorization_sha256);
  return { record, binding, ref };
}

/** Freeze each writable slot independently, before its actual zero-model capture.
 * A lost preparation receipt permits only the existing read-only reconciler. */
export async function prepareEpisodeFixtures({ id, environmentRoot, controlRoot, corpus, cases, slots, candidates, runtime, policy: supplied }, operations = {}) {
  const selections = episodeFixtureSelections({ cases, slots, candidates, diagnostics: supplied?.diagnostics });
  const mutable = slots.filter(slot => selections.has(slot.slot_id));
  const policy = validateEpisodeFixturePolicy(supplied, { required: mutable.length > 0 });
  validateAuthoringSelection(policy, selections);
  if (!mutable.length) return { registration: null, slots: new Map() };
  assert.ok(isAbsolute(environmentRoot) && isAbsolute(controlRoot) && inside(environmentRoot, controlRoot));
  await canonicalDirectory(controlRoot);
  for (const skillId of Object.keys(policy.source_bindings ?? {}))
    assert.ok(corpus.publicCorpus.skills.some(skill => skill.id === skillId), 'Source binding names an unknown canonical Skill');
  const prepare = operations.prepare ?? prepareBenchmarkFixture, reconcile = operations.reconcile ?? reconcileBenchmarkFixture;
  const completed = new Map(), references = {};
  for (const slot of mutable) {
    const episode = selections.get(slot.slot_id), { baseBinding } = episode, candidate = candidates[slot.condition_id];
    assert.ok(candidate && baseBinding); const runId = runIdFor(id, slot);
    assert.match(runId, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/, 'Episode fixture run IDs are bounded by the existing fixture API');
    const fixtureRoot = join(controlRoot, 'episode-fixtures', runId), recordPath = join(controlRoot, 'slot-bindings', runId + '.json');
    if (await present(recordPath)) {
      const ref = await artifact(recordPath, controlRoot), result = await readSlot({ ref, slot, id, baseBinding, environmentRoot, controlRoot, policy, candidate, runtime, corpus });
      references[slot.slot_id] = ref; completed.set(slot.slot_id, result); continue;
    }
    const catalog = corpus.publicCorpus.cases.find(value => value.id === baseBinding.base_case_id)?.catalog.skill_ids;
    assert.ok(catalog); const sourceBindings = Object.fromEntries(Object.entries(policy.source_bindings ?? {})
      .filter(([skillId]) => baseBinding.public_case.catalog.skill_ids.includes(skillId)));
    const fixturePlan = planBenchmarkFixture({ corpus, caseIds: [baseBinding.base_case_id],
      scopeId: 'bm-' + sha(controlRoot + '\0' + slot.slot_id).slice(0, 24), controlRoot: fixtureRoot,
      projectPageId: policy.project_page_id, buildRoot: join(environmentRoot, 'builds', candidate.build_id), node: runtime.node,
      placement: policy.placement ?? 'notion', sourceBindings, ...slotAuthoring(policy, baseBinding.public_case.catalog.skill_ids), git: policy.git ?? null,
      access: 'episode-owned', episodeId: runId, ownedRuntimeRoot: join(environmentRoot, 'runs', runId),
      candidateCount: baseBinding.variant.candidate_count, roundCount: baseBinding.variant.round_count,
      events: episode.events,
      ...(baseBinding.variant.candidate_count === 16 ? { catalogSkillIds: catalog } : {}) });
    assert.equal(fixturePlan.corpus.publicCorpus.content_sha256, corpus.publicCorpus.content_sha256, 'Slot preparation cannot change the registered canonical corpus');
    for (const event of episode.binding.events ?? []) {
      const actual = fixturePlan.events.find(value => value.id === event.id); assert.ok(actual);
      for (const [key, value] of Object.entries(event)) assert.deepEqual(actual[key], value);
    }
    const intent = { version: 1, slot_id: slot.slot_id, run_id: runId, policy_sha256: fingerprint(policy),
      canonical_binding_sha256: fingerprint(baseBinding), fixture_plan_sha256: fixturePlan.plan_sha256 };
    const attemptRoot = join(controlRoot, 'slot-preparation', runId), intentPath = join(attemptRoot, 'intent.json');
    let first = false;
    try { await save(intentPath, intent); first = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; assert.deepEqual(await json(intentPath), intent, 'Retained preparation belongs to another slot or template'); }
    let result;
    try { result = first ? await prepare(fixturePlan) : await reconcile({ controlRoot: fixtureRoot }); }
    catch (error) { result = { status: 'unknown', effect_unknown: true, error: { message: String(error.message), code: error.code ?? null } }; }
    await save(join(attemptRoot, 'attempt-' + randomUUID() + '.json'), { ...intent, action: first ? 'prepare' : 'read-only-reconcile', result, model_calls: 0 });
    assert.ok(result.status === 'ready' && result.effect_unknown === false, 'Episode fixture preparation is unresolved; retain this scope and reconcile without replaying writes: ' + runId);
    const materializationRef = result.binding;
    assert.ok(materializationRef && materializationRef.path === result.binding_path);
    await artifact(materializationRef.path, fixtureRoot, materializationRef);
    const actualPlan = await json(join(fixtureRoot, 'plan.json')); assert.deepEqual(actualPlan, fixturePlan);
    const binding = await bindPrepared({ baseBinding: episode.binding, materialization: await json(materializationRef.path), fixturePlan, fixtureRoot });
    const record = { version: 1, kind: 'benchmark-slot-materialization', slot_id: slot.slot_id, run_id: runId,
      slot_sha256: fingerprint(slot), build_id: candidate.build_id,
      case_id: slot.case_id, condition_id: slot.condition_id, canonical_binding_sha256: fingerprint(baseBinding),
      policy_sha256: fingerprint(policy), public_case_sha256: fingerprint(binding.public_case),
      public_prompt_sha256: fingerprint(binding.public_case.turns), initial_material_sha256: materialIdentity(binding),
      authorization_sha256: baseBinding.protocol_case.authorization_sha256,
      fixture_plan: binding.fixture_control, materialization: materializationRef, binding };
    const ref = await save(recordPath, record); references[slot.slot_id] = ref;
    completed.set(slot.slot_id, { ref, record, binding });
  }
  return { registration: { version: 1, policy, slot_bindings: references }, slots: completed };
}

/** Dispatch, recovery and reanalysis select retained bindings; no preparation
 * or remote command is reachable from this function. */
export async function readEpisodeFixtureBindings({ id, registration, environmentRoot, controlRoot, cases, slots, candidates, runtime, corpus }) {
  const selections = episodeFixtureSelections({ cases, slots, candidates, diagnostics: registration?.policy?.diagnostics });
  const required = slots.filter(slot => selections.has(slot.slot_id));
  if (!registration) { assert.equal(required.length, 0, 'Stateful execution requires frozen per-slot materializations'); return new Map(); }
  assert.equal(registration.version, 1); const policy = validateEpisodeFixturePolicy(registration.policy, { required: true });
  validateAuthoringSelection(policy, selections);
  assert.deepEqual(Object.keys(registration.slot_bindings).sort(), required.map(slot => slot.slot_id).sort(), 'Frozen episode fixtures must cover exactly the writable scheduled slots');
  const output = new Map();
  for (const slot of required) output.set(slot.slot_id, await readSlot({ ref: registration.slot_bindings[slot.slot_id], slot, id,
    baseBinding: cases.find(binding => binding.id === slot.case_id), environmentRoot, controlRoot, policy,
    candidate: candidates[slot.condition_id], runtime, corpus }));
  return output;
}
