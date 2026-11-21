import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export const AGENT_PROFILES = Object.freeze(['daily', 'no-native-skills']);
export const AGENT_FIXTURE_KINDS = Object.freeze(['mixed-rules', 'native-management', 'versioned-graph', 'upstream-projection']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/u.test(value);
const logicalVersion = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/u.test(value);
const object = (value, where) => assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), where + ': expected an object');
const string = (value, where) => assert.ok(typeof value === 'string' && value.trim().length > 0, where + ': expected non-empty text');
const keys = (value, allowed, required, where) => {
  object(value, where);
  for (const key of Object.keys(value)) assert.ok(allowed.includes(key), where + ': unsupported field ' + key);
  for (const key of required) assert.ok(own(value, key), where + ': missing ' + key);
};
const strings = (value, where, { empty = false, check = string } = {}) => {
  assert.ok(Array.isArray(value) && (empty || value.length > 0), where + ': expected ' + (empty ? 'an' : 'a non-empty') + ' array');
  for (const item of value) check(item, where);
  assert.equal(new Set(value).size, value.length, where + ': duplicate values');
};
const id = (value, where) => assert.ok(identifier(value), where + ': invalid identifier');
const version = (value, where) => assert.ok(logicalVersion(value), where + ': invalid version label');
const publicKey = key => /^(?:[A-Za-z0-9][A-Za-z0-9_-]*\.(?:name|url|path)|business\.[A-Za-z0-9][A-Za-z0-9_.-]*)$/u.test(key);
const relativePath = (value, where) => {
  string(value, where);
  assert.ok(!isAbsolute(value) && !value.includes('\\') && !value.includes('\0') &&
    value.split('/').every(part => part && part !== '.' && part !== '..'), where + ': use a relative owner path');
};

function validatePublic(value, where) {
  object(value, where);
  for (const [key, text] of Object.entries(value)) {
    assert.ok(publicKey(key), where + ': only name/url/path and business text may be exposed: ' + key);
    string(text, where + '.' + key);
  }
}
function validateFacts(value, where) {
  object(value, where);
  for (const [key, fact] of Object.entries(value)) {
    string(key, where); keys(fact, ['anyOf'], ['anyOf'], where + '.' + key);
    strings(fact.anyOf, where + '.' + key + '.anyOf');
  }
}

/** Validate preparation instructions, never execute them or guess an upstream schema. */
export function validateAgentFixtureRecipe(recipe) {
  keys(recipe, ['kind', 'objects', 'public', 'facts', 'readbacks', 'environment'], ['kind', 'objects'], 'fixture');
  assert.ok(AGENT_FIXTURE_KINDS.includes(recipe.kind), 'fixture: unsupported kind ' + recipe.kind);
  assert.ok(Array.isArray(recipe.objects), 'fixture.objects must be an array');
  const aliases = new Set();
  for (const item of recipe.objects) {
    keys(item, ['id', 'name', 'description', 'placement', 'initial', 'versions', 'source'],
      ['id', 'name', 'description', 'placement', 'initial', 'versions'], 'fixture.object');
    id(item.id, 'fixture.object.id'); assert.ok(!aliases.has(item.id), 'fixture: duplicate object ' + item.id); aliases.add(item.id);
    string(item.name, item.id + '.name'); string(item.description, item.id + '.description');
    assert.ok(['notion', 'global', 'project', 'source', 'builtin'].includes(item.placement), item.id + ': unsupported placement');
    object(item.versions, item.id + '.versions');
    assert.ok(Object.keys(item.versions).length > 0, item.id + ': missing versions');
    assert.ok(['absent', 'unmanaged'].includes(item.initial) || own(item.versions, item.initial), item.id + ': unknown initial version');
    assert.ok(item.initial !== 'unmanaged' || item.placement === 'notion', item.id + ': unmanaged pages must be Notion objects');
    if (item.placement === 'source') {
      keys(item.source, ['declaration', 'memberKey'], ['declaration', 'memberKey'], item.id + '.source');
      object(item.source.declaration, item.id + '.source.declaration');
      string(item.source.memberKey, item.id + '.source.memberKey');
    } else assert.equal(item.source, undefined, item.id + ': source declaration only applies to source placement');
    for (const [label, value] of Object.entries(item.versions)) {
      version(label, item.id + '.version');
      keys(value, ['files', 'requires', 'members', 'enabled', 'defaultContext'], ['files'], item.id + '@' + label);
      assert.ok(Array.isArray(value.files) && (value.files.length > 0 || ['source', 'builtin'].includes(item.placement)), item.id + '@' + label + ': missing files');
      const paths = new Set();
      for (const file of value.files) {
        keys(file, ['path', 'content', 'encoding', 'mode'], ['path', 'content'], item.id + '.file');
        relativePath(file.path, item.id + '.file.path');
        assert.ok(!paths.has(file.path), item.id + ': duplicate file path ' + file.path); paths.add(file.path);
        assert.equal(typeof file.content, 'string', item.id + '.file.content must be text');
        assert.ok(file.encoding === undefined || ['utf8', 'base64'].includes(file.encoding), item.id + ': unsupported file encoding');
        if (file.encoding === 'base64') assert.equal(Buffer.from(file.content, 'base64').toString('base64'), file.content,
          item.id + ': base64 content is not canonical');
        assert.ok(file.mode === undefined || ['100644', '100755'].includes(file.mode), item.id + ': unsupported file mode');
      }
      assert.ok(paths.has('SKILL.md') || ['source', 'builtin'].includes(item.placement) && value.files.length === 0, item.id + '@' + label + ': complete Skill tree requires SKILL.md');
      for (const property of ['requires', 'members']) if (value[property] !== undefined) strings(value[property], item.id + '.' + property, { empty: true, check: id });
      for (const property of ['enabled', 'defaultContext']) if (value[property] !== undefined)
        assert.equal(typeof value[property], 'boolean', item.id + '.' + property + ' must be boolean');
    }
  }
  for (const item of recipe.objects) for (const value of Object.values(item.versions))
    for (const alias of [...(value.requires ?? []), ...(value.members ?? [])])
      assert.ok(aliases.has(alias), item.id + ': missing dependency object ' + alias);
  if (recipe.environment !== undefined) {
    keys(recipe.environment, ['catalog', 'offline'], ['catalog'], 'fixture.environment');
    assert.ok(['normal', 'pending', 'unauthorized', 'partial-view'].includes(recipe.environment.catalog), 'Unsupported catalog precondition');
    if (recipe.environment.offline !== undefined) assert.equal(typeof recipe.environment.offline, 'boolean');
  }
  if (recipe.public !== undefined) validatePublic(recipe.public, 'fixture.public');
  if (recipe.facts !== undefined) validateFacts(recipe.facts, 'fixture.facts');
  if (recipe.readbacks !== undefined) {
    object(recipe.readbacks, 'fixture.readbacks');
    for (const [key, declaration] of Object.entries(recipe.readbacks)) {
      string(key, 'fixture.readbacks key');
      keys(declaration, ['object', 'version', 'state', 'properties', 'projection'], ['object', 'state'], 'fixture.readbacks.' + key);
      assert.ok(aliases.has(declaration.object), 'Unknown readback object ' + declaration.object);
      assert.ok(['present', 'absent'].includes(declaration.state), 'Readback state must be present or absent');
      if (declaration.projection !== undefined) {
        assert.ok(['same-as-baseline', 'absent'].includes(declaration.projection), 'Unsupported projection readback');
        assert.equal(recipe.objects.find(item => item.id === declaration.object).placement, 'source', 'Projection readback requires a Source object');
      }
      if (declaration.properties !== undefined) {
        keys(declaration.properties, ['description', 'enabled', 'defaultContext'], [], 'readback.properties');
        assert.ok(Object.keys(declaration.properties).length > 0, 'readback.properties must not be empty');
        if (declaration.properties.description !== undefined) string(declaration.properties.description, 'readback.description');
        for (const key of ['enabled', 'defaultContext']) if (declaration.properties[key] !== undefined)
          assert.equal(typeof declaration.properties[key], 'boolean', 'readback.' + key + ' must be boolean');
        assert.equal(declaration.state, 'present', 'An absent object cannot have current metadata');
      }
      if (declaration.version !== undefined) {
        version(declaration.version, 'readback.version');
        const target = recipe.objects.find(item => item.id === declaration.object);
        assert.ok(own(target.versions, declaration.version), 'Readback references an unknown version');
        assert.equal(declaration.state, 'present', 'An absent object cannot have a current version');
      }
    }
  }
  return recipe;
}

export function validateAgentAssertion(assertion) {
  object(assertion, 'expect'); string(assertion.kind, 'expect.kind');
  const shape = {
    completed: [[], []],
    'tool-attempts': [['tool', 'min', 'max'], ['tool']],
    body: [['body', 'occurrences', 'receiptRequired', 'scope'], ['body', 'occurrences']],
    selection: [['object', 'version'], ['object']],
    'selection-any': [['objects'], ['objects']],
    visibility: [['object', 'stage'], ['object', 'stage']],
    resource: [['object', 'path', 'version'], ['object', 'path']],
    output: [['all', 'none', 'any'], []],
    'no-semantic-writes': [[], []],
    clarification: [['topic'], ['topic']],
    'business-readback': [['receipt'], ['receipt']],
  }[assertion.kind];
  assert.ok(shape, 'expect: unsupported assertion ' + assertion.kind);
  keys(assertion, ['kind', ...shape[0]], ['kind', ...shape[1]], 'expect.' + assertion.kind);
  if (assertion.kind === 'tool-attempts') {
    string(assertion.tool, 'expect.tool');
    assert.ok(assertion.min !== undefined || assertion.max !== undefined, 'tool-attempts requires a boundary');
    for (const key of ['min', 'max']) if (assertion[key] !== undefined)
      assert.ok(Number.isSafeInteger(assertion[key]) && assertion[key] >= 0, 'tool-attempts.' + key + ' must be a nonnegative integer');
    assert.ok(assertion.min === undefined || assertion.max === undefined || assertion.min <= assertion.max, 'tool-attempts has contradictory bounds');
  }
  if (assertion.kind === 'body') {
    string(assertion.body, 'expect.body');
    assert.ok(Number.isSafeInteger(assertion.occurrences) && assertion.occurrences >= 0, 'body.occurrences must be a nonnegative integer');
    if (assertion.receiptRequired !== undefined) assert.equal(typeof assertion.receiptRequired, 'boolean');
    if (assertion.scope !== undefined) assert.ok(['final', 'all'].includes(assertion.scope), 'body.scope must be final or all');
  }
  if (assertion.kind === 'visibility') {
    id(assertion.object, 'visibility.object');
    assert.ok(['native-discovery', 'model-catalog', 'source-pending'].includes(assertion.stage), 'Unsupported visibility stage');
  }
  if (assertion.kind === 'selection-any') {
    assert.ok(Array.isArray(assertion.objects) && assertion.objects.length > 0, 'selection-any requires allowed identities');
    const choices = new Set();
    for (const choice of assertion.objects) {
      keys(choice, ['object', 'version'], ['object'], 'selection-any.choice');
      validateAgentAssertion({ kind: 'selection', ...choice });
      const key = choice.object + '@' + (choice.version ?? '');
      assert.ok(!choices.has(key), 'selection-any contains duplicate identities'); choices.add(key);
    }
  }
  if (['selection', 'resource'].includes(assertion.kind)) {
    id(assertion.object, 'expect.object');
    if (assertion.version !== undefined) version(assertion.version, 'expect.version');
  }
  if (assertion.kind === 'resource') relativePath(assertion.path, 'expect.path');
  if (assertion.kind === 'output') {
    assert.ok(['all', 'none', 'any'].some(key => assertion[key]?.length), 'output requires necessary facts');
    for (const key of ['all', 'none', 'any']) if (assertion[key] !== undefined) strings(assertion[key], 'output.' + key);
    for (const key of assertion.none ?? []) assert.ok(!(assertion.all ?? []).includes(key) && !(assertion.any ?? []).includes(key), 'output has contradictory facts');
  }
  if (assertion.kind === 'clarification') string(assertion.topic, 'expect.topic');
  if (assertion.kind === 'business-readback') string(assertion.receipt, 'expect.receipt');
  return assertion;
}

export function validateAgentEvent(event) {
  object(event, 'before'); string(event.kind, 'before.kind');
  const shape = {
    'publish-version': [['object', 'version'], ['object', 'version']],
    'set-enabled': [['object', 'enabled', 'defaultContext'], ['object', 'enabled']],
    'remove-owned': [['object'], ['object']],
    'restore-projection': [['object'], ['object']],
    'trash-projection': [['object'], ['object']],
    readback: [['object', 'receipt'], ['object', 'receipt']],
    restart: [['mode'], ['mode']],
    fork: [['turn'], ['turn']],
    compact: [[], []],
    fault: [['object', 'mode'], ['object', 'mode']],
  }[event.kind];
  assert.ok(shape, 'before: unsupported event ' + event.kind);
  keys(event, ['kind', ...shape[0]], ['kind', ...shape[1]], 'before.' + event.kind);
  if (event.object !== undefined) id(event.object, 'before.object');
  if (event.version !== undefined) version(event.version, 'before.version');
  if (event.kind === 'set-enabled') {
    assert.equal(typeof event.enabled, 'boolean', 'before.enabled must be boolean');
    if (event.defaultContext !== undefined) assert.equal(typeof event.defaultContext, 'boolean', 'before.defaultContext must be boolean');
  }
  if (event.kind === 'readback') string(event.receipt, 'before.receipt');
  if (event.kind === 'restart') assert.ok(['resume', 'fresh'].includes(event.mode), 'before.restart mode must be resume or fresh');
  if (event.kind === 'fork') id(event.turn, 'before.turn');
  if (event.kind === 'fault') assert.ok(['missing-object', 'missing-manifest', 'store-unavailable'].includes(event.mode), 'before.fault unsupported mode');
  return event;
}

function validateTurn(turn, where) {
  keys(turn, ['id', 'prompt', 'before', 'expect'], ['id', 'prompt', 'expect'], where);
  id(turn.id, where + '.id'); string(turn.prompt, where + '.prompt');
  assert.doesNotMatch(turn.prompt, /\b(?:notion_use|notion_list|notion_ctl)\b|(?:snapshot_id|version_id|file_id)\s*[:=]|(?:--provider|--model|--skill|--no-session)\b|skill:\/\/|sr:[a-zA-Z0-9]/u,
    where + ': do not teach the subject internal tools, bindings or runtime flags');
  for (const match of turn.prompt.matchAll(/\{\{([^{}]+)\}\}/gu))
    assert.ok(publicKey(match[1]), where + ': only public user information may be substituted');
  assert.ok(!turn.prompt.replaceAll(/\{\{[^{}]+\}\}/gu, '').includes('{{'), where + ': malformed substitution');
  assert.ok(Array.isArray(turn.expect) && turn.expect.length > 0, where + ': empty oracle is not a test');
  for (const assertion of turn.expect) validateAgentAssertion(assertion);
  if (turn.before !== undefined) {
    assert.ok(Array.isArray(turn.before) && turn.before.length > 0, where + ': before must contain declared events');
    for (const event of turn.before) validateAgentEvent(event);
  }
  return turn;
}

export function validateAgentCorpus(corpus) {
  keys(corpus, ['version', 'fixtures', 'scenarios'], ['version', 'fixtures', 'scenarios'], 'corpus');
  assert.equal(corpus.version, 1, 'Unsupported natural journey version');
  object(corpus.fixtures, 'corpus.fixtures');
  for (const [key, recipe] of Object.entries(corpus.fixtures)) { id(key, 'fixture key'); validateAgentFixtureRecipe(recipe); }
  assert.ok(Array.isArray(corpus.scenarios) && corpus.scenarios.length > 0, 'corpus.scenarios must not be empty');
  const seen = new Set();
  for (const scenario of corpus.scenarios) {
    keys(scenario, ['id', 'contract_ids', 'profiles', 'fixture', 'turns'], ['id', 'contract_ids', 'profiles', 'fixture', 'turns'], 'scenario');
    id(scenario.id, 'scenario.id'); assert.ok(!seen.has(scenario.id), 'Duplicate scenario ' + scenario.id); seen.add(scenario.id);
    strings(scenario.contract_ids, scenario.id + '.contract_ids', { check: value =>
      assert.ok(/^(?:C0[1-9]|C07[abc]|C1[01]|T(?:0[1-9]|1[0-9]|2[0-3]))$/u.test(value), 'Unknown C/T identity ' + value) });
    strings(scenario.profiles, scenario.id + '.profiles', { check: value => assert.ok(AGENT_PROFILES.includes(value), 'Unsupported profile ' + value) });
    string(scenario.fixture, scenario.id + '.fixture');
    assert.ok(own(corpus.fixtures, scenario.fixture), scenario.id + ': unknown fixture ' + scenario.fixture);
    assert.ok(Array.isArray(scenario.turns) && scenario.turns.length > 0, scenario.id + ': missing turns');
    const recipe = corpus.fixtures[scenario.fixture], aliases = new Map(recipe.objects.map(item => [item.id, item])), turns = new Set();
    for (const turn of scenario.turns) {
      validateTurn(turn, scenario.id + '.turn');
      assert.ok(!turns.has(turn.id), scenario.id + ': duplicate turn ' + turn.id);
      for (const event of turn.before ?? []) {
        if (event.kind === 'fork') assert.ok(turns.has(event.turn), scenario.id + ': fork must name an earlier completed turn');
        if (event.object !== undefined) {
          assert.ok(aliases.has(event.object), scenario.id + ': unknown event object ' + event.object);
          if (event.version !== undefined) assert.ok(own(aliases.get(event.object).versions, event.version), scenario.id + ': unknown event version');
        }
      }
      for (const assertion of turn.expect.flatMap(expected => expected.kind === 'selection-any' ? expected.objects : [expected])) if (assertion.object !== undefined) {
        assert.ok(aliases.has(assertion.object), scenario.id + ': unknown expected object ' + assertion.object);
        if (assertion.version !== undefined) assert.ok(own(aliases.get(assertion.object).versions, assertion.version), scenario.id + ': unknown expected version');
      }
      turns.add(turn.id);
    }
  }
  return corpus;
}

export async function loadAgentCorpus(path) {
  assert.ok(isAbsolute(path), 'The corpus path must be absolute');
  return validateAgentCorpus(JSON.parse(await readFile(path, 'utf8')));
}

export function selectAgentScenarios(corpus, { ids, selection = 'required', profiles } = {}) {
  validateAgentCorpus(corpus);
  assert.ok(['required', 'holdout', 'all'].includes(selection), 'Unknown corpus selection');
  if (ids !== undefined) strings(ids, 'scenario IDs', { check: id });
  if (profiles !== undefined) strings(profiles, 'profiles', { check: value => assert.ok(AGENT_PROFILES.includes(value)) });
  for (const selected of ids ?? []) assert.ok(corpus.scenarios.some(scenario => scenario.id === selected), 'Unknown scenario ' + selected);
  const scenarios = corpus.scenarios.filter(scenario => (ids ? ids.includes(scenario.id) :
    selection === 'all' || scenario.id.startsWith('holdout-') === (selection === 'holdout')) &&
    (!profiles || scenario.profiles.some(profile => profiles.includes(profile))));
  assert.ok(scenarios.length > 0, 'The selected natural journey set is empty');
  return scenarios;
}

export function validateAgentBindings(bindings) {
  keys(bindings, ['version', 'public', 'private', 'fixtureReceipt'], ['version', 'public', 'private'], 'bindings');
  assert.equal(bindings.version, 1, 'Unsupported runtime bindings version'); validatePublic(bindings.public, 'bindings.public');
  keys(bindings.private, ['objects', 'bodies', 'facts', 'readbacks', 'events', 'fixture'], ['objects', 'bodies', 'facts'], 'bindings.private');
  object(bindings.private.objects, 'bindings.private.objects');
  for (const [alias, value] of Object.entries(bindings.private.objects)) {
    id(alias, 'binding object'); object(value, 'binding object ' + alias);
    assert.ok(['local', 'notion'].includes(value.kind), alias + ': logical object kind must be local or notion');
    object(value.versions, alias + '.versions');
    for (const [label, observed] of Object.entries(value.versions)) {
      version(label, alias + '.version'); object(observed, alias + '@' + label);
      if (observed.bodyKeys !== undefined) strings(observed.bodyKeys, alias + '@' + label + '.bodyKeys', { empty: true });
    }
  }
  object(bindings.private.bodies, 'bindings.private.bodies');
  for (const [key, body] of Object.entries(bindings.private.bodies)) {
    object(body, 'body binding ' + key);
    assert.ok(isAbsolute(body.path), key + ': body oracle must point to frozen absolute bytes');
    assert.match(body.sha256, /^[a-f0-9]{64}$/u, key + ': body oracle needs SHA-256');
    assert.ok(Number.isSafeInteger(body.bytes) && body.bytes >= 0, key + ': body oracle needs byte count');
  }
  validateFacts(bindings.private.facts, 'bindings.private.facts');
  if (bindings.private.readbacks !== undefined) object(bindings.private.readbacks, 'bindings.private.readbacks');
  return bindings;
}

/** Late binding keeps future publication identities unknown until the real event completes. */
export function bindAgentTurn(turn, bindings) {
  validateTurn(turn, 'turn'); validateAgentBindings(bindings);
  const prompt = turn.prompt.replaceAll(/\{\{([^{}]+)\}\}/gu, (_match, key) => {
    assert.ok(own(bindings.public, key), 'Missing public binding ' + key);
    return bindings.public[key];
  });
  for (const expected of turn.expect.flatMap(expected => expected.kind === 'selection-any' ? expected.objects : [expected])) {
    if (expected.body !== undefined) assert.ok(own(bindings.private.bodies, expected.body), 'Missing private body ' + expected.body);
    if (expected.object !== undefined) {
      const identity = bindings.private.objects[expected.object];
      assert.ok(identity, 'Missing private identity ' + expected.object);
      if (expected.version !== undefined) assert.ok(own(identity.versions, expected.version), 'Missing planned version ' + expected.object + '@' + expected.version);
    }
    for (const fact of [...(expected.all ?? []), ...(expected.none ?? []), ...(expected.any ?? [])])
      assert.ok(own(bindings.private.facts, fact), 'Missing private fact ' + fact);
    if (expected.kind === 'clarification') assert.ok(own(bindings.private.facts, expected.topic), 'Missing clarification topic ' + expected.topic);
    if (expected.kind === 'business-readback') assert.ok(own(bindings.private.readbacks ?? {}, expected.receipt), 'Missing declared readback ' + expected.receipt);
  }
  return { ...structuredClone(turn), prompt };
}

export function bindAgentScenario(corpus, scenarioId, bindings, { profile } = {}) {
  validateAgentCorpus(corpus); validateAgentBindings(bindings);
  const scenario = corpus.scenarios.find(item => item.id === scenarioId);
  assert.ok(scenario, 'Unknown scenario ' + scenarioId);
  assert.ok(scenario.profiles.includes(profile), scenarioId + ': profile precondition does not hold');
  return { id: scenario.id, contract_ids: [...scenario.contract_ids], profile,
    fixture: structuredClone(corpus.fixtures[scenario.fixture]),
    turns: scenario.turns.map(turn => bindAgentTurn(turn, bindings)), bindings };
}
