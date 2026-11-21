import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  bindAgentScenario, bindAgentTurn, checkAgentContractCoverage, selectAgentScenarios, validateAgentAssertion, validateAgentBindings,
  validateAgentCorpus, validateAgentEvent, validateAgentFixtureRecipe,
} from './notion-agent-scenarios.mjs';

const recipe = {
  kind: 'mixed-rules',
  objects: [{ id: 'remote', name: 'travel-rules', description: 'Travel policy', placement: 'notion', initial: 'A',
    versions: { A: { files: [{ path: 'SKILL.md', content: '# Travel rules\nOld policy.' }] },
      B: { files: [{ path: 'SKILL.md', content: '# Travel rules\nNew policy.' }] } } }],
  public: { 'business.receipts': 'Taxi 30; lunch 70.' },
  facts: { total: { anyOf: ['合计：100元', '合计：100 元'] } },
  readbacks: { created: { object: 'remote', version: 'A', state: 'present' } },
};
const body = { path: '/owned/oracle/remote-A-SKILL.md', sha256: '1'.repeat(64), bytes: 24 };
const bindings = {
  version: 1,
  public: { 'remote.name': 'travel-rules-owned-run', 'remote.url': 'https://www.notion.so/1234',
    'business.receipts': 'Taxi 30; lunch 70.' },
  private: { objects: { remote: { kind: 'notion', owner: 'real-owner', versions: {
    A: { snapshot_id: 's_old', version_id: 'v_old', bodyKeys: ['remote@A/SKILL.md'] },
    B: { bodyKeys: ['remote@B/SKILL.md'] },
  }, currentVersion: 'A' } }, bodies: { 'remote@A/SKILL.md': body, 'remote@B/SKILL.md': body },
  facts: recipe.facts, readbacks: recipe.readbacks },
};
const turn = { id: 'continue', prompt: '请用 Notion 的 {{remote.name}} 处理这些材料：{{business.receipts}}',
  expect: [{ kind: 'completed' }, { kind: 'selection', object: 'remote', version: 'A' },
    { kind: 'body', body: 'remote@A/SKILL.md', occurrences: 1 }, { kind: 'output', all: ['total'] }] };
const corpus = { version: 1, fixtures: { travel: recipe }, scenarios: [
  { id: 'explicit-notion', contract_ids: ['C08', 'T22'], profiles: ['daily', 'no-native-skills'], fixture: 'travel', turns: [turn] },
  { id: 'holdout-notion', contract_ids: ['C08'], profiles: ['daily'], fixture: 'travel', turns: [{ ...turn, prompt: '报销单已整理成一句话。{{business.receipts}} 请按 Notion 的 {{remote.name}} 审核。' }] },
] };
const clone = value => structuredClone(value);

test('natural text expands only user-provided bindings and keeps private expectations outside the prompt', () => {
  const result = bindAgentScenario(corpus, 'explicit-notion', bindings, { profile: 'daily' });
  assert.equal(result.turns[0].prompt, '请用 Notion 的 travel-rules-owned-run 处理这些材料：Taxi 30; lunch 70.');
  assert.ok(!result.turns[0].prompt.includes('real-owner'));
  assert.ok(!result.turns[0].prompt.includes('合计：100元'));
  assert.deepEqual(result.turns[0].expect, turn.expect);
  assert.deepEqual(corpus.scenarios[0].turns[0].prompt, turn.prompt);
  assert.throws(() => bindAgentTurn({ ...turn, prompt: '{{total}}' }, bindings), /only public/u);
  assert.throws(() => bindAgentTurn({ ...turn, prompt: '{{business.missing}}' }, bindings), /Missing public/u);
  assert.throws(() => bindAgentTurn({ ...turn, prompt: '请先 notion_use 再回答' }, bindings), /do not teach/u);
  const leaked = clone(bindings); leaked.public['remote.snapshot_id'] = 'hidden';
  assert.throws(() => validateAgentBindings(leaked), /only name\/url\/path/u);
});

test('planning a future revision never invents its snapshot; each turn binds against the actual updated state', () => {
  const newer = { ...turn, before: [{ kind: 'publish-version', object: 'remote', version: 'B' }],
    expect: [{ kind: 'selection', object: 'remote', version: 'B' }] };
  const bound = bindAgentTurn(newer, bindings);
  assert.equal(bindings.private.objects.remote.versions.B.snapshot_id, undefined);
  assert.deepEqual(bound.expect, newer.expect);
  const next = clone(bindings);
  Object.assign(next.private.objects.remote.versions.B, { snapshot_id: 's_actual', version_id: 'v_actual' });
  next.private.objects.remote.currentVersion = 'B';
  assert.deepEqual(bindAgentTurn(newer, next).expect, newer.expect);
  const missing = clone(bindings); delete missing.private.objects.remote.versions.B;
  assert.throws(() => bindAgentTurn(newer, missing), /Missing planned version/u);
});

test('typos, impossible limits and unsupported event structures fail before a model request', () => {
  for (const value of [
    { kind: 'candidate-cli' },
    { kind: 'candidate-cli', min: 0 },
    { kind: 'candidate-cli', min: 1, assume: true },
    { kind: 'tool-attempts', tool: 'notion_use' },
    { kind: 'tool-attempts', tool: 'notion_use', min: 2, max: 0 },
    { kind: 'tool-attempts', tool: 'notion_use', max: -1 },
    { kind: 'source-network-attempts', max: -1 },
    { kind: 'source-network-attempts' },
    { kind: 'body', body: 'a', occurrences: 0, unknown: true },
    { kind: 'body', body: 'a', occurrences: 1, scope: 'historical' },
    { kind: 'output', all: ['same'], none: ['same'] },
    { kind: 'output' },
    { kind: 'pretend-complete' },
    { kind: 'forbidden-tool-input', tool: 'read', facts: [] },
    { kind: 'visibility', object: 'remote', stage: 'exists-somewhere' },
  ]) assert.throws(() => validateAgentAssertion(value));
  for (const value of [
    { kind: 'shell', command: 'echo passed' },
    { kind: 'compact', instructions: 'You should use the hidden answer' },
    { kind: 'compact', keepRecentTokens: 0 },
    { kind: 'compact', keepRecentTokens: 1.5 },
    { kind: 'restart', mode: 'pretend' },
    { kind: 'publish-version', object: 'remote', version: 'B', command: 'anything' },
    { kind: 'fault', object: 'remote', mode: 'disable-all-validation' },
    { kind: 'interrupt-source-write', object: 'remote', maxRequests: 0 },
  ]) assert.throws(() => validateAgentEvent(value));
  assert.doesNotThrow(() => validateAgentAssertion({ kind: 'tool-attempts', tool: 'notion_use', max: 0 }));
  assert.doesNotThrow(() => validateAgentAssertion({ kind: 'source-network-attempts', max: 0 }));
  assert.doesNotThrow(() => validateAgentAssertion({ kind: 'candidate-cli', min: 1 }));
  assert.doesNotThrow(() => validateAgentEvent({ kind: 'compact', keepRecentTokens: 128 }));
});

test('corpus checks logical references, profile preconditions and real file structure', () => {
  validateAgentCorpus(corpus);
  const unknown = clone(corpus); unknown.scenarios[0].turns[0].before = [{ kind: 'publish-version', object: 'missing', version: 'B' }];
  assert.throws(() => validateAgentCorpus(unknown), /unknown event object/u);
  const fork = clone(corpus); fork.scenarios[0].turns[0].before = [{ kind: 'fork', turn: 'continue' }];
  assert.throws(() => validateAgentCorpus(fork), /earlier completed turn/u);
  const contract = clone(corpus); contract.scenarios[0].contract_ids = ['C01a'];
  assert.throws(() => validateAgentCorpus(contract), /Unknown C\/T/u);
  const legacy = clone(corpus); legacy.scenarios[0].profiles = ['notion-only'];
  assert.throws(() => validateAgentCorpus(legacy), /Unsupported profile/u);
  assert.throws(() => bindAgentScenario(corpus, 'holdout-notion', bindings, { profile: 'no-native-skills' }), /precondition/u);
  const traversal = clone(recipe); traversal.objects[0].versions.A.files[0].path = '../SKILL.md';
  assert.throws(() => validateAgentFixtureRecipe(traversal), /relative owner path/u);
  const noMain = clone(recipe); noMain.objects[0].versions.A.files[0].path = 'reference.md';
  assert.throws(() => validateAgentFixtureRecipe(noMain), /SKILL.md/u);
  const absentVersion = clone(recipe); absentVersion.readbacks.created.state = 'absent';
  assert.throws(() => validateAgentFixtureRecipe(absentVersion), /absent object/u);
});

test('unknown private references are not converted to an empty success', () => {
  for (const expected of [
    { kind: 'selection', object: 'absent' },
    { kind: 'body', body: 'absent', occurrences: 1 },
    { kind: 'output', all: ['absent'] },
    { kind: 'clarification', topic: 'absent' },
    { kind: 'business-readback', receipt: 'absent' },
    { kind: 'forbidden-tool-input', tool: 'read', facts: ['absent'] },
  ]) assert.throws(() => bindAgentTurn({ ...turn, expect: [expected] }, bindings), /Missing/u);
  assert.throws(() => selectAgentScenarios(corpus, { ids: [] }), /non-empty/u);
  assert.throws(() => selectAgentScenarios(corpus, { ids: ['unknown'] }), /Unknown scenario/u);
});

test('required and holdout selection stay separate and remain bounded', () => {
  assert.deepEqual(selectAgentScenarios(corpus).map(item => item.id), ['explicit-notion']);
  assert.deepEqual(selectAgentScenarios(corpus, { selection: 'holdout' }).map(item => item.id), ['holdout-notion']);
  assert.equal(selectAgentScenarios(corpus, { selection: 'all' }).length, 2);
  assert.deepEqual(selectAgentScenarios(corpus, { ids: ['holdout-notion'] }).map(item => item.id), ['holdout-notion']);
});

test('the checked-in corpus keeps required journeys, real environment profiles and holdouts executable', () => {
  const actual = validateAgentCorpus(JSON.parse(readFileSync(new URL('./notion-agent-scenarios.json', import.meta.url), 'utf8')));
  const required = selectAgentScenarios(actual);
  for (const id of ['mixed-explicit-global', 'mixed-explicit-notion', 'mixed-notion-url', 'mixed-ambiguous-source',
    'mixed-equivalent-copies', 'mixed-complementary', 'mixed-pending-local', 'mixed-resource-owner',
    'mixed-native-slash', 'mixed-broker-explicit', 'cold-maintenance-consultation', 'connected-maintenance-filtered-view',
    'explicit-offline-bootstrap', 'lifecycle-inspect-adopt', 'lifecycle-resume-fork-compact', 'lifecycle-recovery-failure',
    'lifecycle-shared-requires', 'lifecycle-enabled-default-context', 'management-native-crud',
    'management-register-existing', 'management-description-flags-resource', 'management-upstream-delete-restore',
    'management-source-applying-resume', 'cold-maintenance-unauthorized'])
    assert.ok(required.some(scenario => scenario.id === id), 'Missing agreed user journey ' + id);
  const local = required.find(scenario => scenario.id === 'mixed-explicit-global');
  assert.deepEqual(local.profiles, ['daily']);
  assert.ok(local.turns[0].expect.some(assertion => assertion.kind === 'tool-attempts' && assertion.tool === 'notion_use' && assertion.max === 0));
  assert.ok(local.turns[0].expect.some(assertion => assertion.kind === 'visibility' && assertion.stage === 'native-discovery'));
  assert.ok(local.turns[0].expect.some(assertion => assertion.kind === 'visibility' && assertion.stage === 'model-catalog'));
  const localRecipe = actual.fixtures[local.fixture];
  assert.equal(localRecipe.objects.find(item => item.id === 'remote').versions.A.defaultContext, true);
  const pending = required.find(scenario => scenario.id === 'mixed-pending-local');
  assert.equal(actual.fixtures[pending.fixture].environment.catalog, 'pending');
  assert.ok(pending.turns[0].expect.some(assertion => assertion.kind === 'visibility' && assertion.stage === 'source-pending'));
  const lifecycle = required.find(scenario => scenario.id === 'lifecycle-inspect-adopt');
  assert.equal(lifecycle.turns[1].before[0].kind, 'publish-version');
  assert.equal(lifecycle.turns[2].expect.find(assertion => assertion.kind === 'selection').version, 'A');
  assert.equal(lifecycle.turns.at(-1).expect.find(assertion => assertion.kind === 'selection').version, 'B');
  const holdouts = selectAgentScenarios(actual, { selection: 'holdout' });
  assert.ok(holdouts.length >= 3);
  assert.ok(actual.fixtures[holdouts.find(item => item.id === 'holdout-notion-business-layout').fixture]
    .objects.find(item => item.id === 'remote').versions.A.files.some(file => file.path === 'reference/limits.md'));
  const source = actual.fixtures['upstream-authoring'].objects[0];
  assert.equal(source.placement, 'source'); assert.deepEqual(source.versions.A.files, []);
  assert.match(source.source.declaration.definition.adapter.ref, /^[a-f0-9]{40}$/u);
});

test('C/T coverage comes from the paired current index rather than a second contract map', () => {
  const paired = { version: 2, contracts: [{ id: 'C08' }], scenarios: [{ id: 'T22', contracts: ['C08'] }] };
  const declared = clone(corpus);
  declared.scenarios[1].contract_ids.push('T22');
  assert.deepEqual(checkAgentContractCoverage(declared, paired)[0].mappings,
    [{ scenario_id: 'T22', contract_ids: ['C08'] }]);
  assert.throws(() => checkAgentContractCoverage(declared, { ...paired, version: 1 }), /current paired/u);
  assert.throws(() => checkAgentContractCoverage(declared, { ...paired, scenarios: [] }), /unknown current scenario/u);
  assert.throws(() => checkAgentContractCoverage(declared,
    { ...paired, scenarios: [{ id: 'T22', contracts: ['C01'] }] }), /maps none/u);
  declared.scenarios[0].contract_ids.push('C01');
  assert.throws(() => checkAgentContractCoverage(declared,
    { ...paired, contracts: [...paired.contracts, { id: 'C01' }] }), /no current T mapping/u);
});
