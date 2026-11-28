import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_MAIN_EXACT_RESOURCES, agentFixtureCreateArgs, assertAgentFixtureImportCreation,
  agentFixtureUsesNativeMarkdown, isAgentFixtureCreationArgs } from './notion-agent-authoring.mjs';
import { validateAgentFixtureRecipe } from './notion-agent-scenarios.mjs';

const libraryId = '11111111-1111-4111-8111-111111111111';
const object = () => ({ id: 'grant', name: 'grant', description: 'Grant rules', placement: 'notion', initial: 'v1',
  versions: { v1: { files: [{ path: 'SKILL.md', content: '# Grant\n' }, { path: 'references/rules.md', content: 'grant_cents\n' }] } } });
const selected = () => ({ libraryId, object: { ...object(), authoring: NATIVE_MAIN_EXACT_RESOURCES },
  owned: { name: 'grant-owned', skillId: 'owned-grant' }, objects: {}, input: { directory: '/owned/input with spaces', requires: [], members: [],
    files: [{ path: 'SKILL.md', sha256: 'a'.repeat(64), bytes: 8 }, { path: 'references/rules.md', sha256: 'b'.repeat(64), bytes: 12 }] } });
const preflight = selected => ({ ok: true, contract: 'current', dry_run: true, remote_writes: 0,
  library: { library_id: libraryId }, skill_id: selected.owned.skillId, page_id: null, state: null,
  replaces_complete_tree: true, remove: [], metadata: { name: selected.owned.name, description: selected.object.description,
    kind: 'skill', enabled: true, default_context: false },
  files: selected.input.files.map(file => ({ ...file, page_id: null, previous_authority: null, action: 'create', authority: file.path === 'SKILL.md' ? 'native' : 'resource' })) });

test('the opt-in recipe is frozen as data and rejects unsupported authoring before I/O', () => {
  const recipe = { kind: 'mixed-rules', objects: [selected().object] }, before = JSON.stringify(recipe);
  assert.equal(validateAgentFixtureRecipe(recipe), recipe); assert.equal(JSON.stringify(recipe), before);
  for (const [label, change] of [
    ['unknown policy', item => { item.authoring = 'guess'; }],
    ['non-Notion', item => { item.placement = 'project'; }],
    ['absent', item => { item.initial = 'absent'; }],
    ['unmanaged', item => { item.initial = 'unmanaged'; }],
    ['multiple versions', item => { item.versions.v2 = structuredClone(item.versions.v1); }],
    ...['requires', 'members'].map(field => [field, item => { item.versions.v1[field] = []; }]),
    ...['enabled', 'defaultContext'].flatMap(field => [false, true].map(value => [field + '=' + value, item => { item.versions.v1[field] = value; }])),
  ]) {
    const invalid = structuredClone(recipe); change(invalid.objects[0]);
    assert.throws(() => validateAgentFixtureRecipe(invalid), undefined, label);
  }
});

test('legacy creation keeps relation and metadata flags while exact resources use public complete import', () => {
  const options = selected(), imported = agentFixtureCreateArgs(options);
  assert.deepEqual(imported, ['ctl', 'library', 'import', '/owned/input with spaces', '--library', libraryId, '--skill-id', 'owned-grant',
    '--name', 'grant-owned', '--description', 'Grant rules', '--native', 'SKILL.md']);
  delete options.object.authoring;
  Object.assign(options.input, { requires: ['dependency'], members: ['optional'], enabled: false, defaultContext: true });
  options.objects = { dependency: { pageId: 'dependency-page' }, optional: { pageId: 'optional-page' } };
  assert.deepEqual(agentFixtureCreateArgs(options), ['ctl', 'library', 'skill', 'create', '/owned/input with spaces', '--library', libraryId,
    '--skill-id', 'owned-grant', '--name', 'grant-owned', '--description', 'Grant rules', '--requires', 'dependency-page',
    '--members', 'optional-page', '--enabled', 'false', '--default-context', 'true']);
  for (const field of ['requires', 'members', 'enabled', 'defaultContext']) {
    const unsafe = selected(); unsafe.input[field] = ['requires', 'members'].includes(field) ? ['unrepresented'] : false;
    assert.throws(() => agentFixtureCreateArgs(unsafe), /cannot discard/u);
  }
});

test('complete import preflight rejects an existing owner, changed authority and any partial or changed input', () => {
  const options = selected(); assert.doesNotThrow(() => assertAgentFixtureImportCreation(preflight(options), options));
  for (const [label, change] of [
    ['existing owner', value => { value.page_id = 'existing-page'; }],
    ['unfinished state', value => { value.state = 'applying'; }],
    ['partial tree', value => { value.files.pop(); }],
    ['unexpected removal', value => { value.remove.push({ path: 'unowned.md' }); }],
    ['native auxiliary file', value => { value.files[1].authority = 'native'; }],
    ['changed bytes', value => { value.files[1].sha256 = 'c'.repeat(64); }],
    ['replacement action', value => { value.files[1].action = 'verify_or_replace'; }],
    ['wrong owner', value => { value.skill_id = 'another-owner'; }],
    ['wrong library', value => { value.library.library_id = 'another-library'; }],
    ['remote writes', value => { value.remote_writes = 1; }],
  ]) { const value = preflight(options); change(value); assert.throws(() => assertAgentFixtureImportCreation(value, options), undefined, label); }
});

test('write-history matching includes import and excludes read-only dry-runs and another owner', () => {
  const options = selected(), imported = agentFixtureCreateArgs(options);
  assert.equal(isAgentFixtureCreationArgs(imported, options.owned.skillId), true);
  assert.equal(isAgentFixtureCreationArgs([...imported, '--dry-run'], options.owned.skillId), false);
  assert.equal(isAgentFixtureCreationArgs(imported, 'another-owner'), false);
  delete options.object.authoring;
  assert.equal(isAgentFixtureCreationArgs(agentFixtureCreateArgs(options), options.owned.skillId), true);
  assert.equal(isAgentFixtureCreationArgs(['ctl', 'library', 'operation', options.owned.skillId], options.owned.skillId), false);
  assert.equal(isAgentFixtureCreationArgs(['ctl', 'library', 'skill', 'update', '--skill-id', options.owned.skillId], options.owned.skillId), false);
});

test('only opted-in main Markdown permits native normalization', () => {
  assert.equal(agentFixtureUsesNativeMarkdown(object(), 'references/rules.md'), true);
  assert.equal(agentFixtureUsesNativeMarkdown(selected().object, 'SKILL.md'), true);
  assert.equal(agentFixtureUsesNativeMarkdown(selected().object, 'references/rules.md'), false);
  assert.equal(agentFixtureUsesNativeMarkdown(object(), 'assets/rules.json'), false);
});
