import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, fingerprint } from '../protocol.mjs';
import { validateAgentFixtureRecipe } from '../../scripts/notion-agent-scenarios.mjs';
import { NATIVE_MAIN_EXACT_RESOURCES } from '../../scripts/notion-agent-authoring.mjs';
import { buildJourney, JOURNEYS, FAMILY_COUNTS, createDistractor, hashBytes, corpusFile } from './materials.mjs';
import { gradeEpisode, validateOracle } from './grader.mjs';

export { gradeEpisode, validateOracle, FAMILY_COUNTS, JOURNEYS };
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CANDIDATE_COUNTS = [16, 64, 256], ROUND_COUNTS = [1, 2, 4, 8];
const LICENSE = 'CC0-1.0';
const copy = value => structuredClone(value);
const json = value => JSON.stringify(value, null, 2) + '\n';
const inside = (parent, child) => child === parent || child.startsWith(parent + sep);
const identity = value => { const { content_sha256: ignored, ...rest } = value; return fingerprint(rest); };
const validPath = value => typeof value === 'string' && !isAbsolute(value) && !value.includes('\\')
  && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..');

function sortedSkills(skills, seed) {
  return [...skills].sort((a, b) => hashBytes(seed + a.id).localeCompare(hashBytes(seed + b.id)));
}

function publicVariant(plan) {
  return { turns: copy(plan.turns), attachments: copy(plan.attachments),
    completion: { kind: plan.contracts.some(c => c.kind === 'final-answer') ? 'final-answer' : 'artifacts',
      paths: plan.contracts.filter(c => c.kind === 'artifact-json').map(c => c.path) },
    contract_sha256: fingerprint(plan.contracts) };
}

/** Produces reproducible public business material and a separate private control value. */
export function buildCorpus({ seed, split = 'development', materialVersion = '1' } = {}) {
  assert.equal(typeof seed, 'string', 'An explicit corpus seed is required');
  assert.ok(seed.trim(), 'Corpus seed must not be empty');
  assert.ok(['development', 'pilot', 'confirmation'].includes(split), 'Unsupported corpus split');
  assert.ok(['1', '2'].includes(materialVersion), 'Unknown synthetic material version');
  const corpusId = 'benchmark-synthetic-' + split + '-' + fingerprint({ seed, materialVersion }).slice(0, 12);
  const sharedSeed = fingerprint({ seed, split, materialVersion, pool: 'distractors' });
  const distractors = Array.from({ length: 256 }, (_, index) => createDistractor({ caseId: 'shared', seed: sharedSeed, index: index + 1, materialVersion }));
  const skills = [...distractors], cases = [], controlCases = [];
  for (const journey of JOURNEYS) for (const material of ['a', 'b']) {
    const materialSeed = fingerprint({ seed, split, materialVersion, journey: journey.id, material });
    const minimumRounds = ['continuation', 'task-switch'].includes(journey.family) ? 2 : 1;
    const rounds = journey.anchor ? ROUND_COUNTS : [minimumRounds];
    const plans = new Map(rounds.map(roundCount => [roundCount, buildJourney(journey, { seed: materialSeed, material, roundCount, materialVersion })]));
    const initial = plans.get(minimumRounds);
    assert.ok(initial, 'Anchor plans must contain their default round count');
    const id = journey.id + '-' + material;
    skills.push(...initial.skills);
    const base = {
      id, journey_id: journey.id, family: journey.family, title: journey.title,
      material_id: corpusId + '-' + id, cluster_id: journey.id,
      split, seed: materialSeed, license: LICENSE, material_version: materialVersion,
      required_capabilities: initial.required_capabilities,
      capability_scope: 'common', default_round_count: minimumRounds,
      catalog: {
        skill_ids: sortedSkills([...initial.skills, ...distractors.slice(0, 16 - initial.skills.length)], materialSeed).map(skill => skill.id),
        base_candidate_count: 16,
      },
      anchors: journey.anchor ? { candidate_counts: [...CANDIDATE_COUNTS], round_counts: [...ROUND_COUNTS] } : null,
      authorization: { workspace_read: ['input/**'], workspace_write: ['output/**'], remote_write: false },
      ...publicVariant(initial),
      variants: Object.fromEntries([...plans].filter(([count]) => count !== minimumRounds).map(([count, plan]) => [String(count), publicVariant(plan)])),
    };
    base.prompt_sha256 = fingerprint(base.turns);
    base.initial_state_sha256 = fingerprint({ attachments: base.attachments,
      skills: initial.skills.map(skill => ({ id: skill.id, files: skill.versions[skill.initial_version].files })) });
    base.authorization_sha256 = fingerprint(base.authorization);
    base.content_sha256 = identity(base);
    const oracles = Object.fromEntries([...plans].map(([count, plan]) => {
      const oracle = {
        schema_version: 1, case_id: id, capability_scope: 'common',
        required_capabilities: plan.required_capabilities, public_sha256: base.content_sha256,
        contracts: plan.contracts,
      };
      validateOracle(oracle);
      return [String(count), oracle];
    }));
    cases.push(base);
    controlCases.push({ case_id: id, target_skill_ids: initial.skills.map(skill => skill.id),
      oracles, events: initial.events, clarification: initial.clarification });
  }
  const publicCorpus = {
    schema_version: 1, id: corpusId, version: materialVersion, split, seed,
    license: LICENSE, provenance: { kind: 'synthetic', source: 'benchmark/corpus/materials.mjs',
      contains_personal_data: false, material_namespaces: ['a', 'b'], seed_namespace: split + ':' + seed },
    families: Object.entries(FAMILY_COUNTS).map(([id, journey_count]) => ({ id, journey_count, case_count: journey_count * 2, weight: 0.1 })),
    capabilities: ['workspace-files', 'skill-content', 'resource-read'].map(id => ({ id, scope: 'common' })),
    distractor_skill_ids: distractors.map(skill => skill.id), skills, cases,
  };
  publicCorpus.content_sha256 = identity(publicCorpus);
  const control = {
    schema_version: 1, corpus_id: corpusId, public_sha256: publicCorpus.content_sha256,
    cases: controlCases,
    canaries: [{ id: 'private-oracle', value: 'BENCHMARK_PRIVATE_' + randomUUID() }],
    seal: { state: split === 'confirmation' ? 'unsealed' : 'development', split },
  };
  validateCorpus({ publicCorpus, control });
  assert.equal(cases.length, 40);
  return { publicCorpus, control };
}

function validateFile(file) {
  assert.ok(validPath(file.path), 'File must use a confined relative path');
  assert.ok(['utf8', 'base64'].includes(file.encoding));
  assert.ok(['100644', '100755'].includes(file.mode));
  assert.equal(typeof file.content, 'string');
  if (file.encoding === 'base64') assert.equal(Buffer.from(file.content, 'base64').toString('base64'), file.content, 'Base64 must be canonical');
  const bytes = Buffer.from(file.content, file.encoding);
  assert.equal(bytes.length, file.bytes, 'File byte count mismatch');
  assert.equal(hashBytes(bytes), file.sha256, 'File content identity mismatch');
}

export function validateCorpus({ publicCorpus, control } = {}) {
  assert.equal(publicCorpus?.schema_version, 1);
  assert.equal(publicCorpus.license, LICENSE);
  assert.ok(['development', 'pilot', 'confirmation'].includes(publicCorpus.split));
  assert.equal(identity(publicCorpus), publicCorpus.content_sha256, 'Public corpus fingerprint mismatch');
  assert.ok(Array.isArray(publicCorpus.skills) && Array.isArray(publicCorpus.cases));
  const ids = new Set();
  for (const skill of publicCorpus.skills) {
    assert.ok(!ids.has(skill.id), 'Duplicate Skill identity'); ids.add(skill.id);
    assert.match(skill.name, /^[a-z0-9][a-z0-9-]{0,54}$/);
    assert.ok(skill.versions[skill.initial_version], 'Missing initial Skill version');
    for (const version of Object.values(skill.versions)) {
      assert.ok(version.files.some(file => file.path === 'SKILL.md'), 'Missing SKILL.md');
      assert.equal(new Set(version.files.map(file => file.path)).size, version.files.length);
      for (const file of version.files) validateFile(file);
    }
  }
  for (const skill of publicCorpus.skills) for (const dependency of skill.requires) assert.ok(ids.has(dependency), 'Unknown Skill dependency');
  const caseIds = new Set();
  for (const item of publicCorpus.cases) {
    assert.ok(!caseIds.has(item.id), 'Duplicate case id'); caseIds.add(item.id);
    assert.equal(item.split, publicCorpus.split);
    assert.equal(identity(item), item.content_sha256, 'Case fingerprint mismatch');
    assert.equal(item.catalog.skill_ids.length, item.catalog.base_candidate_count);
    for (const id of item.catalog.skill_ids) assert.ok(ids.has(id), 'Case references an unknown Skill');
    for (const variant of [item, ...Object.values(item.variants ?? {})]) {
      for (const file of variant.attachments) validateFile(file);
      for (const turn of variant.turns) {
        assert.equal(typeof turn.prompt, 'string'); assert.ok(turn.prompt.length > 0);
        assert.doesNotMatch(turn.prompt, /\b(?:notion_use|notion_list|notion_ctl)\b|(?:snapshot_id|file_id)\s*[:=]|skill:\/\//u, 'Prompt must not prescribe product tool internals');
      }
      assert.ok(['artifacts', 'final-answer'].includes(variant.completion?.kind), 'Unsupported public completion kind');
      assert.ok(Array.isArray(variant.completion.paths), 'Completion paths must be an array');
      for (const path of variant.completion.paths) assert.ok(validPath(path) && path.startsWith('output/'));
    }
  }
  if (control) {
    assert.equal(control.schema_version, 1);
    assert.equal(control.corpus_id, publicCorpus.id);
    assert.equal(control.public_sha256, publicCorpus.content_sha256);
    assert.equal(control.cases.length, publicCorpus.cases.length);
    assert.equal(new Set(control.cases.map(item => item.case_id)).size, control.cases.length, 'Duplicate private case');
    for (const item of control.cases) {
      assert.ok(caseIds.has(item.case_id));
      const publicCase = publicCorpus.cases.find(value => value.id === item.case_id);
      const rounds = [String(publicCase.default_round_count), ...Object.keys(publicCase.variants ?? {})].sort();
      assert.deepEqual(Object.keys(item.oracles).sort(), rounds, 'Private round variants do not match public material');
      for (const [round, oracle] of Object.entries(item.oracles)) {
        validateOracle(oracle);
        const variant = Number(round) === publicCase.default_round_count ? publicCase : publicCase.variants[round];
        const answers = oracle.contracts.filter(contract => contract.kind === 'final-answer');
        assert.equal(variant.completion.kind === 'final-answer', answers.length > 0, 'Public and private completion kinds differ');
        for (const contract of answers)
          assert.ok(variant.turns.some(turn => turn.id === contract.turn_id), 'Final answer names an undeclared public turn');
        assert.equal(oracle.case_id, item.case_id, 'Oracle case identity mismatch');
        assert.equal(oracle.public_sha256, publicCase.content_sha256, 'Oracle public identity mismatch');
        assert.equal(fingerprint(oracle.contracts), variant.contract_sha256, 'Oracle contract fingerprint mismatch');
        assert.deepEqual(oracle.required_capabilities, publicCase.required_capabilities, 'Oracle capability declaration mismatch');
      }
      for (const id of item.target_skill_ids) assert.ok(ids.has(id) && publicCase.catalog.skill_ids.includes(id), 'Private target is outside the public catalog');
    }
    const publicBytes = canonicalJson(publicCorpus);
    for (const canary of control.canaries) assert.ok(!publicBytes.includes(canary.value), 'Private canary leaked into public corpus');
  }
  return { status: 'valid', case_count: publicCorpus.cases.length, skill_count: publicCorpus.skills.length };
}

export function planCaseVariant({ publicCorpus, control, caseId, candidateCount = 16, roundCount } = {}) {
  const base = publicCorpus.cases.find(item => item.id === caseId);
  assert.ok(base, 'Unknown case ' + caseId);
  roundCount ??= base.default_round_count;
  assert.ok((base.anchors?.candidate_counts ?? [16]).includes(candidateCount), 'Candidate count is not registered for this case');
  assert.ok((base.anchors?.round_counts ?? [base.default_round_count]).includes(roundCount), 'Round count is not registered for this case');
  const selected = roundCount === base.default_round_count ? base : base.variants[String(roundCount)];
  assert.ok(selected, 'Missing declared round variant');
  const selectedIds = [...base.catalog.skill_ids];
  for (const id of publicCorpus.distractor_skill_ids) {
    if (selectedIds.length === candidateCount) break;
    if (!selectedIds.includes(id)) selectedIds.push(id);
  }
  assert.equal(selectedIds.length, candidateCount);
  const order = sortedSkills(selectedIds.map(id => publicCorpus.skills.find(skill => skill.id === id)), base.seed);
  const publicCase = {
    ...copy(base), ...copy(selected),
    catalog: { skill_ids: order.map(skill => skill.id), candidate_count: candidateCount },
    round_count: roundCount,
  };
  delete publicCase.variants;
  const variant = { case_id: caseId, candidate_count: candidateCount, round_count: roundCount,
    id: caseId + '-n' + candidateCount + '-r' + roundCount,
    content_sha256: fingerprint({ case_id: caseId, public_sha256: publicCorpus.content_sha256, candidateCount, roundCount }) };
  const controlled = control?.cases.find(item => item.case_id === caseId);
  if (control) assert.ok(controlled, 'Missing private case control');
  return { publicCase, skills: copy(order), variant,
    ...(controlled ? { oracle: copy(controlled.oracles[String(roundCount)]), events: copy(controlled.events),
      clarification: copy(controlled.clarification) } : {}) };
}

async function canonicalTarget(path) {
  assert.ok(isAbsolute(path), 'Output roots must be absolute');
  let current = resolve(path), suffix = [];
  while (true) {
    try { return join(await realpath(current), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(current); assert.notEqual(parent, current);
      suffix.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1))); current = parent;
    }
  }
}

async function prepareOwnedRoot(root, kind, contentSha256) {
  root = await canonicalTarget(root);
  const marker = join(root, '.benchmark-corpus-owner.json');
  try {
    const previous = JSON.parse(await readFile(marker, 'utf8'));
    assert.equal(previous.kind, kind, 'Output root belongs to another operation');
    assert.equal(previous.content_sha256, contentSha256, 'Output root belongs to another corpus or variant');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let entries = [];
    try { entries = await readdir(root); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    assert.equal(entries.length, 0, 'Use a fresh or matching owned output root');
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(marker, json({ schema_version: 1, kind, content_sha256: contentSha256 }), { flag: 'wx', mode: 0o600 });
  }
  return root;
}

async function writeOwned(root, file) {
  validateFile(file);
  const path = join(root, file.path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  assert.ok(inside(root, await canonicalTarget(dirname(path))), 'Output path escapes through a symlink');
  const bytes = Buffer.from(file.content, file.encoding);
  try { await writeFile(path, bytes, { flag: 'wx', mode: file.mode === '100755' ? 0o700 : 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.ok((await lstat(path)).isFile() && !(await lstat(path)).isSymbolicLink(), 'Existing output must be a regular file');
    assert.equal(hashBytes(await readFile(path)), file.sha256, 'Owned output bytes changed; refusing to replace them');
    assert.equal(Boolean((await lstat(path)).mode & 0o111), file.mode === '100755', 'Owned executable bit changed');
  }
  return { path, relative_path: file.path, sha256: file.sha256, bytes: file.bytes, mode: file.mode };
}

/** Writes the control document outside both the repository and public subject tree. */
export async function writeCorpus({ corpus, publicRoot, controlRoot } = {}) {
  validateCorpus(corpus);
  publicRoot = await canonicalTarget(publicRoot); controlRoot = await canonicalTarget(controlRoot);
  assert.ok(!inside(publicRoot, controlRoot) && !inside(controlRoot, publicRoot), 'Public and control roots must be disjoint');
  assert.ok(!inside(REPO_ROOT, controlRoot) && !inside(controlRoot, REPO_ROOT), 'Private control must stay outside the repository');
  await prepareOwnedRoot(publicRoot, 'public-corpus', corpus.publicCorpus.content_sha256);
  await prepareOwnedRoot(controlRoot, 'private-control', corpus.publicCorpus.content_sha256);
  const publicFile = await writeOwned(publicRoot, corpusFile('corpus.json', json(corpus.publicCorpus)));
  const controlFile = await writeOwned(controlRoot, corpusFile('control.json', json(corpus.control)));
  return { schema_version: 1, public_path: publicFile.path, control_path: controlFile.path,
    public_sha256: corpus.publicCorpus.content_sha256, files: [publicFile, controlFile] };
}

/** Copies public consumable files only. The receipt belongs to the controller. */
export async function materializeLocal({ publicCorpus, targetRoot, caseId, candidateCount = 16, roundCount } = {}) {
  const plan = planCaseVariant({ publicCorpus, caseId, candidateCount, roundCount });
  targetRoot = await canonicalTarget(targetRoot);
  assert.ok(!inside(REPO_ROOT, targetRoot), 'Subject workspace must stay outside the repository');
  await prepareOwnedRoot(targetRoot, 'subject-material', plan.variant.content_sha256);
  const inventory = [];
  for (const skill of plan.skills) {
    for (const file of skill.versions[skill.initial_version].files) {
      const projected = { ...file, path: '.agents/skills/' + skill.name + '/' + file.path };
      const receipt = await writeOwned(targetRoot, projected);
      inventory.push({ ...receipt, skill_id: skill.id, resource_path: file.path,
        version: skill.initial_version, authorized: true, content_sha256: file.sha256 });
    }
  }
  for (const file of plan.publicCase.attachments) inventory.push({ ...(await writeOwned(targetRoot, file)), kind: 'input', authorized: true });
  await mkdir(join(targetRoot, 'output'), { recursive: true, mode: 0o700 });
  return { schema_version: 1, target_root: targetRoot, variant: plan.variant, public_case: plan.publicCase, inventory,
    visible_paths: inventory.map(file => file.relative_path), contains_private_control: false };
}

/** Builds preparation instructions for the existing real public-interface fixture helper. */
export function buildFixtureRecipe({ publicCorpus, caseId, placement = 'notion', scopeId, candidateCount = 16,
  roundCount, sourceBindings = {}, authoring, authoringBySkill } = {}) {
  assert.match(scopeId, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/);
  assert.ok(['project', 'notion', 'mixed'].includes(placement));
  if (authoring !== undefined) {
    assert.equal(authoring, NATIVE_MAIN_EXACT_RESOURCES, 'Unknown fixture authoring policy');
    assert.equal(placement, 'notion', 'Exact-resource authoring requires Notion placement');
  }
  assert.ok(authoring === undefined || authoringBySkill === undefined, 'Select global authoring or an explicit per-Skill map, not both');
  const plan = planCaseVariant({ publicCorpus, caseId, candidateCount, roundCount });
  if (authoringBySkill !== undefined) {
    assert.ok(authoringBySkill && typeof authoringBySkill === 'object' && !Array.isArray(authoringBySkill) && Object.keys(authoringBySkill).length > 0, 'Per-Skill authoring requires a nonempty canonical Skill map');
    for (const [skillId, policy] of Object.entries(authoringBySkill)) {
      assert.ok(plan.skills.some(skill => skill.id === skillId), 'Authoring map names a Skill outside the selected catalog: ' + skillId);
      assert.equal(policy, NATIVE_MAIN_EXACT_RESOURCES, 'Unknown fixture authoring policy');
    }
  }
  const aliases = new Map(plan.skills.map((skill, i) => [skill.id, 's' + String(i + 1).padStart(3, '0')]));
  const relationIds = new Set(plan.skills.flatMap(skill => skill.requires.length ? [skill.id, ...skill.requires] : []));
  const objects = plan.skills.map((skill, index) => {
    const source = sourceBindings[skill.id];
    if (source) {
      assert.equal(source.declaration?.definition?.policy, 'pinned', 'Upstream material must be pinned');
      assert.equal(source.declaration.definition.adapter.type, 'git');
      assert.match(source.declaration.definition.adapter.ref, /^[a-f0-9]{40,64}$/, 'Upstream ref must be a full commit identity');
      const upstream = new URL(source.declaration.definition.adapter.url);
      assert.equal(upstream.protocol, 'https:', 'Public upstream fixture sources use HTTPS');
      assert.equal(upstream.username + upstream.password, '', 'Do not persist upstream credentials');
      assert.ok(typeof source.memberKey === 'string' && !source.memberKey.startsWith('/') && !source.memberKey.includes('\\') && source.memberKey.split('/').every(part => part && part !== '.' && part !== '..'), 'Use one safe upstream member path');
      assert.deepEqual(source.declaration.definition.selection?.roots, [source.memberKey], 'Select exactly the reviewed upstream member');
      assert.deepEqual(source.declaration.definition.selection.include, []);
      assert.deepEqual(source.declaration.definition.selection.exclude, []);
      assert.deepEqual(source.declaration.definition.selection.mapping, {});
      assert.equal(Object.keys(skill.versions).length, 1, 'Mutable source versions require a separate explicitly frozen source-update design');
    }
    const where = source ? 'source' : placement === 'mixed'
      ? relationIds.has(skill.id) || index % 2 === 0 ? 'notion' : 'project' : placement;
    assert.ok(!skill.requires.length || where === 'notion' || where === 'project', 'Unsupported relation owner');
    const selectedAuthoring = authoringBySkill && Object.hasOwn(authoringBySkill, skill.id) ? authoringBySkill[skill.id]
      : where === 'notion' ? authoring : undefined;
    return { id: aliases.get(skill.id), name: skill.name, description: skill.description,
      placement: where, initial: skill.initial_version,
      ...(selectedAuthoring !== undefined ? { authoring: selectedAuthoring } : {}),
      versions: Object.fromEntries(Object.entries(skill.versions).map(([version, value]) => [version, {
        files: value.files.map(({ path, content, encoding, mode }) => ({ path, content, encoding, mode })),
        ...(skill.requires.length && where === 'notion' ? { requires: skill.requires.map(id => aliases.get(id)) } : {}),
      }])), ...(source ? { source: copy(source) } : {}) };
  });
  const recipe = { kind: Object.keys(sourceBindings).length ? 'upstream-projection' :
    plan.skills.some(skill => Object.keys(skill.versions).length > 1) ? 'versioned-graph' : 'mixed-rules', objects };
  validateAgentFixtureRecipe(recipe);
  // planAgentFixturePreparation is exported by the fixture module, not the scenario parser;
  // validation of physical relations also runs in prepareAgentFixtures before its first mutation.
  const skillMapping = Object.fromEntries(plan.skills.map(skill => [skill.id, {
    object_id: aliases.get(skill.id), name: skill.name, initial_version: skill.initial_version,
    placement: objects.find(object => object.id === aliases.get(skill.id)).placement,
  }]));
  const plannedInventory = plan.skills.flatMap(skill => Object.entries(skill.versions).flatMap(([version, value]) =>
    value.files.map(file => ({ skill_id: skill.id, version, ...copy(file), authorized: true }))));
  return { schema_version: 1, scope_id: scopeId, recipe, skill_mapping: skillMapping,
    expected_inventory: plannedInventory.filter(file => file.version === skillMapping[file.skill_id].initial_version), planned_inventory: plannedInventory, mutable: plan.skills.some(skill => Object.keys(skill.versions).length > 1),
    variant: plan.variant, source_claim: Object.keys(sourceBindings).length ? 'requires-public-readback' : 'no-upstream-claim' };
}

function normalizedMain(content, name) {
  if (typeof content !== 'string' || !name) return content;
  return content.replace(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/u, (_all, start, fields, end) => start + fields.replace(/(^|\n)name:[^\r\n]*/u, '$1name: ' + name) + end);
}

/** Compares retained, actually consumed files; it does not fetch or repair them. */
export function verifyMaterialization({ expected, observed, skillMapping = {}, compareMain } = {}) {
  assert.ok(Array.isArray(expected) && Array.isArray(observed));
  const key = item => [item.skill_id, item.version ?? 'v1', item.path].join('|');
  const expectedMap = new Map(expected.map(item => [key(item), item])), observedMap = new Map();
  const differences = [];
  for (const item of observed) {
    if (observedMap.has(key(item))) differences.push({ key: key(item), field: 'duplicate', observed: true });
    observedMap.set(key(item), item);
  }
  for (const [id, wanted] of expectedMap) {
    const actual = observedMap.get(id);
    if (!actual) { differences.push({ key: id, field: 'presence', expected: 'present', observed: 'missing' }); continue; }
    if (actual.authorized !== true) differences.push({ key: id, field: 'authorization', expected: true, observed: actual.authorized ?? null });
    if (Boolean(actual.mode === '100755') !== Boolean(wanted.mode === '100755'))
      differences.push({ key: id, field: 'executable', expected: wanted.mode, observed: actual.mode ?? null });
    let actualHash = actual.sha256;
    if (actual.content !== undefined) {
      const original = Buffer.from(actual.content, actual.encoding ?? 'utf8');
      if (actual.sha256 && hashBytes(original) !== actual.sha256) differences.push({ key: id, field: 'evidence_hash', expected: actual.sha256, observed: hashBytes(original) });
      const normalized = wanted.path === 'SKILL.md'
        ? normalizedMain(original.toString('utf8'), skillMapping[wanted.skill_id]?.name) : original;
      actualHash = hashBytes(normalized);
    }
    let matches = actualHash === wanted.sha256;
    if (!matches && wanted.path === 'SKILL.md' && compareMain && actual.content !== undefined)
      matches = compareMain({ expected: wanted, observed: actual, mapping: skillMapping[wanted.skill_id] }) === true;
    if (!matches) differences.push({ key: id, field: 'content', expected: wanted.sha256, observed: actualHash ?? null });
  }
  for (const [id] of observedMap) if (!expectedMap.has(id)) differences.push({ key: id, field: 'unexpected', observed: 'present' });
  return { status: differences.length ? 'invalid' : 'valid', expected_files: expected.length, observed_files: observed.length, differences };
}

export function sealCorpus({ corpus, sealedAt } = {}) {
  validateCorpus(corpus);
  assert.equal(corpus.publicCorpus.split, 'confirmation', 'Only confirmation material is sealed');
  assert.equal(corpus.control.seal.state, 'unsealed', 'Corpus already sealed or opened');
  assert.ok(Number.isFinite(Date.parse(sealedAt)), 'Use an explicit seal timestamp');
  const value = copy(corpus), oracleHash = fingerprint(value.control.cases);
  value.control.seal = { state: 'sealed', split: 'confirmation', sealed_at: sealedAt,
    public_sha256: value.publicCorpus.content_sha256, oracle_sha256: oracleHash };
  value.control.seal.seal_sha256 = fingerprint(value.control.seal);
  return value;
}

export function openCorpus({ corpus, openedAt, preregistrationSha256 } = {}) {
  validateCorpus(corpus);
  assert.equal(corpus.control.seal.state, 'sealed', 'A confirmation corpus must be sealed before opening');
  assert.match(preregistrationSha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(openedAt)) && Date.parse(openedAt) >= Date.parse(corpus.control.seal.sealed_at));
  const { seal_sha256: sealHash, ...sealed } = corpus.control.seal;
  assert.equal(fingerprint(sealed), sealHash, 'Seal metadata was modified');
  assert.equal(fingerprint(corpus.control.cases), sealed.oracle_sha256, 'Sealed oracle was modified');
  assert.equal(corpus.publicCorpus.content_sha256, sealed.public_sha256, 'Sealed public material was modified');
  const value = copy(corpus);
  value.control.seal = { ...value.control.seal, state: 'opened', opened_at: openedAt, preregistration_sha256: preregistrationSha256 };
  return value;
}

/** Inventory + canary check, not an operating-system sandbox claim. */
export async function auditVisibleMaterial({ roots, canaries = [], forbiddenPaths = [] } = {}) {
  assert.ok(Array.isArray(roots) && roots.length > 0);
  const visible = [], violations = [], forbidden = await Promise.all(forbiddenPaths.map(canonicalTarget));
  async function walk(root, path) {
    const state = await lstat(path);
    const actual = await realpath(path);
    if (forbidden.some(control => inside(control, actual))) violations.push({ path, kind: 'private-path-visible' });
    if (state.isSymbolicLink()) { violations.push({ path, kind: 'symlink-not-audited' }); return; }
    if (state.isDirectory()) {
      for (const child of await readdir(path)) await walk(root, join(path, child));
      return;
    }
    if (!state.isFile()) { violations.push({ path, kind: 'non-regular-file' }); return; }
    const bytes = await readFile(path), content = bytes.toString('utf8');
    visible.push({ root, path: relative(root, path), sha256: hashBytes(bytes), bytes: bytes.length });
    for (const canary of canaries) if (content.includes(typeof canary === 'string' ? canary : canary.value))
      violations.push({ path, kind: 'private-canary-visible', canary_id: typeof canary === 'string' ? hashBytes(canary).slice(0, 12) : canary.id });
  }
  for (const root of roots) await walk(await canonicalTarget(root), await canonicalTarget(root));
  return { status: violations.length ? 'invalid' : 'valid', files: visible, violations,
    isolation_claim: 'visibility-inventory-only; same-user filesystem access is not an OS sandbox' };
}

/** Binds public invocation names after fixture creation; no private expected values are returned. */
export function bindPublicCaseToFixture({ publicCase, skillMapping, bindings } = {}) {
  assert.ok(bindings?.public && bindings?.private?.objects, 'Use a completed fixture binding');
  const value = copy(publicCase), identityMap = {};
  for (const [skillId, mapping] of Object.entries(skillMapping)) {
    const name = bindings.public[mapping.object_id + '.name'];
    const observed = bindings.private.objects[mapping.object_id];
    assert.equal(typeof name, 'string', 'Fixture omitted its public Skill name');
    assert.ok(observed, 'Fixture omitted a prepared Skill identity');
    identityMap[skillId] = {
      object_id: mapping.object_id, logical_name: mapping.name, bound_name: name,
      ...(observed.skillId ? { bound_skill_id: observed.skillId } : {}),
      ...(observed.path ? { bound_path: observed.path } : {}),
      ...(observed.owner ? { bound_owner: observed.owner } : {}),
      ...(observed.pageId ? { bound_page_id: observed.pageId } : {}),
      ...(observed.versions ? { bound_versions: Object.fromEntries(Object.entries(observed.versions).map(([version, state]) => [version, Object.fromEntries(Object.entries(state).filter(([key]) => ['ref', 'snapshot_id', 'version_id'].includes(key)))])) } : {}),
    };
    value.turns = value.turns.map(turn => ({ ...turn, prompt: turn.prompt.replaceAll(mapping.name, name) }));
  }
  return { publicCase: value, identity_map: identityMap };
}

/** Rebinds a pre-registration case set to one complete, shared public catalog. */
export function rebindCorpusCatalog({ corpus, caseIds, skillIds, reason } = {}) {
  validateCorpus(corpus);
  assert.ok(!['sealed', 'opened'].includes(corpus.control.seal.state), 'A sealed confirmation catalog cannot be rebound');
  assert.ok(Array.isArray(caseIds) && caseIds.length > 0 && new Set(caseIds).size === caseIds.length, 'Use unique case IDs');
  assert.ok(Array.isArray(skillIds) && skillIds.length === 16 && new Set(skillIds).size === 16, 'A shared base catalog needs exactly sixteen unique Skills');
  assert.equal(typeof reason, 'string', 'Record the pre-registration reason');
  assert.ok(reason.trim(), 'Record the pre-registration reason');
  const skills = new Map(corpus.publicCorpus.skills.map(skill => [skill.id, skill]));
  for (const id of skillIds) assert.ok(skills.has(id), 'Shared catalog includes an unknown Skill');
  for (const id of skillIds) for (const dependency of skills.get(id).requires)
    assert.ok(skillIds.includes(dependency), 'Shared catalog omits a declared dependency');
  for (const caseId of caseIds) {
    assert.ok(corpus.publicCorpus.cases.some(item => item.id === caseId), 'Unknown rebinding case');
    const controlled = corpus.control.cases.find(item => item.case_id === caseId);
    assert.ok(controlled.target_skill_ids.every(id => skillIds.includes(id)), 'Shared catalog omits a required case Skill');
  }
  const alreadyBound = caseIds.every(id => {
    const item = corpus.publicCorpus.cases.find(item => item.id === id);
    return item.catalog.base_candidate_count === 16 && sameList(item.catalog.skill_ids, skillIds);
  });
  if (alreadyBound) return copy(corpus);
  const value = copy(corpus), sourceHash = corpus.publicCorpus.content_sha256;
  const catalogHash = fingerprint(skillIds.map(id => {
    const skill = skills.get(id);
    return { id, name: skill.name, description: skill.description,
      initial_version: skill.initial_version, files: skill.versions[skill.initial_version].files };
  }));
  const change = { kind: 'catalog-rebinding', source_corpus_id: corpus.publicCorpus.id,
    source_corpus_sha256: sourceHash, case_ids: [...caseIds].sort(),
    catalog_sha256: catalogHash, reason };
  const changeHash = fingerprint(change);
  value.publicCorpus.id = corpus.publicCorpus.id.replace(/-catalog-[a-f0-9]{12}$/u, '') + '-catalog-' + changeHash.slice(0, 12);
  value.publicCorpus.catalog_rebindings = [...(value.publicCorpus.catalog_rebindings ?? []), change];
  for (const item of value.publicCorpus.cases.filter(item => caseIds.includes(item.id))) {
    const sourceCaseHash = item.content_sha256;
    item.catalog = { skill_ids: [...skillIds], base_candidate_count: 16 };
    item.catalog_lineage = { base_case_sha256: item.catalog_lineage?.base_case_sha256 ?? sourceCaseHash,
      source_case_sha256: sourceCaseHash, source_corpus_sha256: sourceHash, catalog_sha256: catalogHash };
    item.initial_state_sha256 = fingerprint({ attachments: item.attachments, catalog_sha256: catalogHash, authorization: item.authorization });
    item.content_sha256 = identity(item);
    const controlled = value.control.cases.find(control => control.case_id === item.id);
    for (const oracle of Object.values(controlled.oracles)) oracle.public_sha256 = item.content_sha256;
  }
  value.publicCorpus.content_sha256 = identity(value.publicCorpus);
  value.control.corpus_id = value.publicCorpus.id;
  value.control.public_sha256 = value.publicCorpus.content_sha256;
  validateCorpus(value);
  return value;
}

function sameList(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }
