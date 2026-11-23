import assert from 'node:assert/strict';

export const NATIVE_MAIN_EXACT_RESOURCES = 'native-main-exact-resources';

/** Explicit fixture transport policy. Omission preserves the existing authoring commands. */
export function validateAgentFixtureAuthoring(object) {
  if (object.authoring === undefined) return;
  assert.equal(object.authoring, NATIVE_MAIN_EXACT_RESOURCES, 'Unknown fixture authoring policy');
  assert.equal(object.placement, 'notion', 'Exact-resource authoring requires a Notion object');
  assert.ok(Object.hasOwn(object.versions, object.initial), 'Exact-resource authoring requires a present initial version');
  assert.equal(Object.keys(object.versions).length, 1, 'Exact-resource authoring currently supports one immutable version');
  for (const version of Object.values(object.versions)) {
    for (const field of ['requires', 'members', 'enabled', 'defaultContext'])
      assert.equal(version[field], undefined, 'Exact-resource authoring does not support ' + field);
  }
}

export function agentFixtureRelationArgs({ objects }, version) {
  const args = [];
  for (const [field, aliases] of [['requires', version.requires], ['members', version.members]]) {
    if (!aliases?.length) continue;
    for (const alias of aliases) {
      const target = objects[alias];
      assert.ok(target && target.pageId, 'Fixture relation target is not yet live: ' + alias);
      args.push('--' + field, target.pageId);
    }
  }
  if (version.enabled !== undefined) args.push('--enabled', String(version.enabled));
  if (version.defaultContext !== undefined) args.push('--default-context', String(version.defaultContext));
  return args;
}

/** Used by initial preparation and guarded absent-object continuation. Never resumes a write. */
export function agentFixtureCreateArgs({ entry, object, owned, input, objects }) {
  validateAgentFixtureAuthoring(object);
  const identity = ['--entry', entry, '--skill-id', owned.skillId, '--name', owned.name, '--description', object.description];
  if (object.authoring === NATIVE_MAIN_EXACT_RESOURCES) {
    for (const field of ['requires', 'members'])
      assert.ok(input[field] === undefined || Array.isArray(input[field]) && input[field].length === 0, 'Exact-resource input cannot discard ' + field);
    for (const field of ['enabled', 'defaultContext'])
      assert.equal(input[field], undefined, 'Exact-resource input cannot discard ' + field);
    return ['ctl', 'library', 'import', input.directory, ...identity, '--native', 'SKILL.md'];
  }
  return ['ctl', 'library', 'skill', 'create', input.directory, ...identity, ...agentFixtureRelationArgs({ objects }, input)];
}

/** Import can replace an owner. Only a complete public absence observation permits fixture creation. */
export function assertAgentFixtureImportCreation(value, { entry, object, owned, input }) {
  validateAgentFixtureAuthoring(object);
  assert.equal(object.authoring, NATIVE_MAIN_EXACT_RESOURCES);
  assert.equal(value.ok, true); assert.equal(value.contract, 'current'); assert.equal(value.dry_run, true);
  assert.equal(value.remote_writes, 0);
  assert.equal(value.library?.database_id?.replaceAll('-', ''), entry.replaceAll('-', ''));
  assert.equal(value.skill_id, owned.skillId);
  assert.equal(value.page_id, null, 'Fixture import cannot replace an existing owner');
  assert.equal(value.state, null, 'Fixture import cannot continue an existing owner state');
  assert.equal(value.replaces_complete_tree, true); assert.deepEqual(value.remove, []);
  assert.equal(value.metadata?.name, owned.name); assert.equal(value.metadata?.description, object.description);
  assert.equal(value.metadata?.kind, 'skill'); assert.equal(value.metadata?.enabled, true);
  assert.equal(value.metadata?.default_context, false);
  assert.ok(Array.isArray(value.files));
  assert.deepEqual(value.files.map(file => file.path).sort(), input.files.map(file => file.path).sort(), 'Import preflight must admit the complete file tree');
  for (const file of value.files) {
    const expected = input.files.find(item => item.path === file.path);
    assert.equal(file.page_id, null); assert.equal(file.previous_authority, null); assert.equal(file.action, 'create');
    assert.equal(file.authority, file.path === 'SKILL.md' ? 'native' : 'resource', 'Import preflight changed file authority');
    assert.equal(file.sha256, expected.sha256); assert.equal(file.bytes, expected.bytes);
  }
}

export function agentFixtureUsesNativeMarkdown(object, path) {
  if (object?.authoring !== undefined) {
    assert.equal(object.authoring, NATIVE_MAIN_EXACT_RESOURCES, 'Unknown fixture authoring policy');
    return path === 'SKILL.md';
  }
  return /\.(md|markdown)$/iu.test(path);
}

/** Receives only CLI arguments, after the Node and executable entries in a retained command. */
export function isAgentFixtureCreationArgs(args, skillId) {
  if (!Array.isArray(args) || args.includes('--dry-run')) return false;
  const create = args[0] === 'ctl' && args[1] === 'library' && args[2] === 'skill' && args[3] === 'create';
  const importing = args[0] === 'ctl' && args[1] === 'library' && args[2] === 'import';
  if (!create && !importing) return false;
  const owner = args.indexOf('--skill-id');
  return owner >= 0 && args[owner + 1] === skillId;
}
