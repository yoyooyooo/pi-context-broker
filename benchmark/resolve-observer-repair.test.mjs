import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fingerprint } from './protocol.mjs';
import { RESOLVE_OBSERVER_FILES, assertResolveObserverSource, assertResolveRepairExpectation,
  assertResolveRepairInstrumentation, verifyResolveRepairInstrumentation, assertResolveRepairCatalog, verifyResolveRepairCredential, resolveRepairBuild } from './resolve-observer-repair.mjs';
import { assertObserverRepairSetup, assertObserverRepairEngineeringCases, assertObserverStopObservation,
  readObserverRepairHistory, observerRepairContinuationSources } from './campaign-observer-repair-continuation.mjs';
import { instrumentationIdentity } from './implementation.mjs';
import { buildCorpus, planCaseVariant } from './corpus/index.mjs';
import { protocolCaseForVariant } from './planning.mjs';
import { FINITE_CAMPAIGN, verifyFiniteOriginalResults, assertConfirmationUnexposed } from './finite-campaign.mjs';
import { inventoryPublicInputs } from './subject.mjs';
import { normalizeCandidate } from './runtime/episode-evidence.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const oldText = "const operations = ['list', 'files', 'consume', 'read', 'read-resources'];\n";
const newText = "const operations = ['list', 'files', 'consume', 'read', 'read-resources', 'resolve'];\n";
const changes = RESOLVE_OBSERVER_FILES.map(path => ({ path,
  before: { path: '/old/' + path, sha256: sha(oldText), bytes: Buffer.byteLength(oldText) },
  after: { path: '/new/' + path, sha256: sha(newText), bytes: Buffer.byteLength(newText) } }));
const pair = { source: { id: 'old', reference: { path: '/old/build.json', sha256: 'a'.repeat(64), bytes: 100 } },
  target: { id: 'new', reference: { path: '/new/build.json', sha256: 'b'.repeat(64), bytes: 200 } }, changes };
const repair = { builds: [pair] };

test('source repair admits only the exact resolve addition', () => {
  assertResolveObserverSource(oldText, newText);
  for (const changed of [oldText, newText + 'sendRequest();\n', newText.replace("'resolve'", "'other'"), newText.replace('const', 'let')])
    assert.throws(() => assertResolveObserverSource(oldText, changed));
  assert.throws(() => assertResolveObserverSource(oldText + oldText, newText + newText));
  assert.throws(() => resolveRepairBuild(repair, 'old', 'unknown'));
  assert.throws(() => resolveRepairBuild({ builds: [pair, pair] }, 'old', 'new'));
});

function expectation(after) {
  const build = after ? pair.target : pair.source;
  const files = changes.map(item => ({ path: item.path, sha256: (after ? item.after : item.before).sha256,
    bytes: (after ? item.after : item.before).bytes }));
  files.push({ path: 'benchmark/runtime/episode-runner.mjs', sha256: 'c'.repeat(64), bytes: 123 });
  return { version: 1, kind: 'candidate-expectation', projection: {
    build: { path: '$BUILD/build.json', realpath: '$BUILD/build.json', sha256: build.reference.sha256, bytes: build.reference.bytes },
    visibility: { source_moved_outside_run: true, projection: { files, sha256: sha(JSON.stringify(files)) } },
    model: { id: 'auto/gpt-6.2-sol', api: 'openai-completions' },
    tools: [{ name: 'read', description: 'Read full selected content.' }],
    initial_context: [{ role: 'user', content: 'Public business task' }],
    git: { version: '2.50.1' }, node: { sha256: 'd'.repeat(64) } },
    request_contract: { model: 'auto/gpt-6.2-sol', maxTokens: 4096, tools: ['read'] } };
}

test('complete startup comparison permits receipt/module changes and rejects business or tool changes', () => {
  const original = expectation(false), current = expectation(true);
  assertResolveRepairExpectation(current, original, pair);
  const mutations = [
    value => { value.projection.model.id = 'other-model'; },
    value => { value.projection.tools[0].description = 'Changed tool guidance'; },
    value => { value.projection.initial_context[0].content = 'A different task'; },
    value => { value.projection.git.version = '2.51'; },
    value => { value.projection.node.sha256 = 'e'.repeat(64); },
    value => { value.request_contract.maxTokens = 8192; },
    value => { value.projection.visibility.source_moved_outside_run = false; },
    value => { value.projection.build.bytes++; },
    value => {
      const projection = value.projection.visibility.projection;
      projection.files.at(-1).sha256 = 'f'.repeat(64); projection.sha256 = sha(JSON.stringify(projection.files));
    },
    value => {
      const projection = value.projection.visibility.projection;
      projection.files.pop(); projection.sha256 = sha(JSON.stringify(projection.files));
    },
  ];
  for (const mutate of mutations) { const changed = structuredClone(current); mutate(changed); assert.throws(() => assertResolveRepairExpectation(changed, original, pair)); }
});

test('persisted captures retain the runtime inventory digest across canonical key ordering', () => {
  const persisted = after => JSON.parse(JSON.stringify(normalizeCandidate(expectation(after), {})));
  const original = persisted(false), current = persisted(true);
  for (const value of [original, current]) {
    const projection = value.projection.visibility.projection;
    assert.deepEqual(Object.keys(projection.files[0]), ['bytes', 'path', 'sha256']);
    assert.notEqual(projection.sha256, sha(JSON.stringify(projection.files)));
  }
  assertResolveRepairExpectation(current, original, pair);
  for (const change of [
    value => { value.sha256 = sha(JSON.stringify(value.files)); },
    value => { value.files.reverse(); },
    value => { value.files[0].bytes++; },
    value => { value.files[0].extra = 'undeclared'; },
  ]) {
    for (const target of ['original', 'current']) {
      const values = { original: structuredClone(original), current: structuredClone(current) };
      change(values[target].projection.visibility.projection);
      assert.throws(() => assertResolveRepairExpectation(values.current, values.original, pair));
    }
  }
});

function instrumentation(after) {
  const collector_files = [
    ...changes.filter(item => item.path.startsWith('scripts/')).map(item => ({ path: item.path,
      sha256: (after ? item.after : item.before).sha256, bytes: (after ? item.after : item.before).bytes })),
    { path: 'benchmark/collect.mjs', sha256: '1'.repeat(64), bytes: 500 },
    { path: 'benchmark/protocol.mjs', sha256: (after ? '2' : '3').repeat(64), bytes: 200 },
  ].sort((a, b) => a.path.localeCompare(b.path));
  return { version: 1, runtime_sha256: [(after ? '4' : '5').repeat(64)], collector_files,
    collector_sha256: fingerprint(collector_files), scope: 'frozen instrumentation' };
}
test('the semantic collector cannot change with the observation repair', () => {
  const current = instrumentation(true), original = instrumentation(false);
  assertResolveRepairInstrumentation(current, original, repair);
  for (const action of ['replace-collector', 'omit-source', 'add-module', 'empty-runtime']) {
    const changed = structuredClone(current);
    if (action === 'replace-collector') changed.collector_files.find(item => item.path === 'benchmark/collect.mjs').sha256 = '6'.repeat(64);
    if (action === 'omit-source') changed.collector_files = changed.collector_files.filter(item => !item.path.includes('source-observer'));
    if (action === 'add-module') changed.collector_files.push({ path: 'benchmark/extra.mjs', sha256: '7'.repeat(64), bytes: 1 });
    if (action === 'empty-runtime') changed.runtime_sha256 = [];
    changed.collector_sha256 = fingerprint(changed.collector_files);
    assert.throws(() => assertResolveRepairInstrumentation(changed, original, repair));
  }
});

test('runtime hashes are derived from the actual captured closure, not accepted by shape', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'resolve-runtime-test-')));
  if (process.platform === 'darwin') t.after(() => execFileSync('/usr/bin/trash', [root]));
  const value = expectation(true);
  Object.assign(value.projection, { pi: { files: [{ path: '/pi/sdk.js', sha256: '8'.repeat(64) }] }, bun: { sha256: '9'.repeat(64) } });
  const path = join(root, 'expectation.json'); await writeFile(path, JSON.stringify(value));
  const execution = { conditions: { c: { expectations: { case: { path, sha256: sha(await readFile(path)) } } } } };
  const actual = await instrumentationIdentity(execution);
  for (const runtime_sha256 of [[], ['f'.repeat(64)], [...actual.runtime_sha256, 'e'.repeat(64)]]) {
    execution.instrumentation = { ...actual, runtime_sha256 };
    await assert.rejects(verifyResolveRepairInstrumentation(execution, actual, repair), /RESOLVE_REPAIR_CURRENT_INSTRUMENTATION_CHANGED/);
  }
});

async function setupFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'resolve-setup-test-')));
  // Respect the host's Trash policy for temporary verification data.
  if (process.platform === 'darwin') t.after(() => execFileSync('/usr/bin/trash', [root]));
  const original = { version: 1, id: 'engineering-original', phase: 'pilot', purpose: 'environment_iteration',
    environment_root: root, control_root: join(root, 'control/original'),
    corpus: { seed: 'original', split: 'development', material_version: '2', selections: [{ caseId: 'references-01-a' }] },
    candidates: [{ id: 'broker', build_id: 'old', mode: 'broker', code_mode: 'free', source_kind: 'notion' }],
    models: { source_file: '/original/models.json', ids: ['auto/gpt-6.2-sol'], window: { start: null, end: null }, parameters: { maxTokens: 4096 } },
    budget: { batch: { max_episodes: 2, max_concurrency: 1 }, episode: { max_retries: 0 } },
    runtime: { node: '/same/node', pi: '/same/pi', bun: '/same/bun' }, decision: { mode: 'descriptive' },
    ordering_seed: 20261123, repetitions: 1, materialization_binding_file: null,
    campaign_scope: { kind: 'benchmark-finite-campaign', id: 'engineering', role: 'acceptance', allocation_id: 'engineering',
      authorization: 'original approval', predecessor: { registration: null, amendment: null }, history_plan_files: null, prospective_authorization: null },
    proposal: { status: 'draft' }, analysis: { interactions: [] } };
  const path = join(root, 'original.json'); await writeFile(path, JSON.stringify(original));
  const source = { path, sha256: sha(await readFile(path)) };
  const window = { start: '2026-11-24T02:08:50.700Z', end: '2026-11-25T02:08:50.700Z' };
  const authorized = { value: { version: 6, environment_root: root, revision: { model_window: window } },
    confirmationContinuation: { repair, engineeringDesigns: { entries: [{ allocation_id: 'engineering', reservations: 2,
      setup: source, schedule: { path: '/retained/schedule.json', sha256: 'a'.repeat(64) } }] } } };
  const current = structuredClone(original); current.control_root = join(root, 'control/new'); current.models.window = window;
  current.models.source_file = '/owned/models.json'; current.candidates[0].build_id = 'new';
  current.candidates[0].notion_entry = '01234567-89ab-cdef-0123-456789abcdef'; current.materialization_binding_file = '/owned/material.json';
  Object.assign(current.campaign_scope, { predecessor: { registration: 'bound', amendment: 'bound' }, history_plan_files: ['old-plan'],
    prospective_authorization: { path: '/owned/authority.json', sha256: 'b'.repeat(64) }, authorization: 'continued same work' });
  current.proposal = { status: 'bound', information: 'does not control the experiment' };
  return { current, authorized };
}

test('engineering preflight binds execution locators without changing the original science', async t => {
  const { current, authorized } = await setupFixture(t);
  assert.ok((await assertObserverRepairSetup(current, authorized)).source_setup);
  const mutations = [
    value => { value.budget.episode.max_retries = 1; },
    value => { value.budget.batch.max_episodes = 3; },
    value => { value.candidates[0].code_mode = 'off'; },
    value => { value.candidates[0].source_kind = 'native'; },
    value => { value.models.ids = ['other']; },
    value => { value.models.parameters.maxTokens = 8192; },
    value => { value.models.window.end = '2026-11-26T02:08:50.700Z'; },
    value => { value.runtime.node = '/different/node'; },
    value => { value.corpus.selections[0].caseId = 'another-case'; },
    value => { value.campaign_scope.id = 'another-allocation'; },
    value => { value.analysis.interactions.push({ kind: 'new-claim' }); },
    value => { value.repetitions = 2; },
    value => { value.ordering_seed++; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(current); mutate(changed); await assert.rejects(assertObserverRepairSetup(changed, authorized)); }
});

test('engineering execution re-derives case scale, rounds, task and oracle from frozen materials', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'resolve-cases-test-')));
  if (process.platform === 'darwin') t.after(() => execFileSync('/usr/bin/trash', [root]));
  const frozen = buildCorpus({ seed: 'repair-cases', materialVersion: '2' });
  const path = join(root, 'recipe.json'); await writeFile(path, JSON.stringify({ corpus: frozen }));
  const sourceSetup = { corpus: { selections: [{ caseId: 'implicit-01-a', candidateCount: 64, roundCount: 1 },
    { caseId: 'references-01-a', candidateCount: 16, roundCount: 4 }] },
    proposal: { materialization_recipe: { path, sha256: sha(await readFile(path)) } } };
  const cases = [];
  for (const selection of sourceSetup.corpus.selections) {
    const selected = planCaseVariant({ ...frozen, ...selection }), oracle_path = join(root, selected.variant.id + '.json');
    await writeFile(oracle_path, JSON.stringify(selected.oracle));
    const input_root = join(root, selected.variant.id);
    for (const item of selected.publicCase.attachments) {
      const path = join(input_root, item.path); await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(item.content, item.encoding), { mode: item.mode === '100755' ? 0o755 : 0o644 });
    }
    cases.push({ id: selected.variant.id, base_case_id: selected.publicCase.id, variant: selected.variant,
      public_case: selected.publicCase, events: selected.events, clarification: selected.clarification,
      protocol_case: protocolCaseForVariant(selected), oracle_path, oracle_sha256: sha(await readFile(oracle_path)),
      input_root, input_inventory_sha256: sha(JSON.stringify(await inventoryPublicInputs(input_root))) });
  }
  const input = { setup: sourceSetup, sourceSetup, corpus: frozen.publicCorpus, cases };
  await assertObserverRepairEngineeringCases(input);
  for (const mutate of [
    value => { value.cases[0].variant.candidate_count = 16; },
    value => { value.cases[0].public_case.catalog.candidate_count = 16; },
    value => { value.cases[1].public_case.round_count = 1; },
    value => { value.cases[0].public_case.turns[0].prompt = 'Different task'; },
    value => { value.cases[0].protocol_case.contract_sha256 = 'a'.repeat(64); },
    value => { value.cases.reverse(); },
    value => { value.cases.pop(); },
    value => { value.corpus.cases[0].default_round_count++; },
    value => { value.cases[0].oracle_sha256 = 'b'.repeat(64); },
    value => { value.cases[0].input_inventory_sha256 = 'c'.repeat(64); },
  ]) {
    const changed = structuredClone(input); mutate(changed); await assert.rejects(assertObserverRepairEngineeringCases(changed));
  }
  const attachment = join(cases[0].input_root, cases[0].public_case.attachments[0].path);
  await writeFile(attachment, 'Different actual input bytes');
  const changed = structuredClone(input);
  changed.cases[0].input_inventory_sha256 = sha(JSON.stringify(await inventoryPublicInputs(cases[0].input_root)));
  await assert.rejects(assertObserverRepairEngineeringCases(changed), /OBSERVER_CONTINUATION_ENGINEERING_INPUTS_CHANGED/);
});

function stoppedObservation() {
  const usage = { model_requests: 5, input_tokens: 23142, output_tokens: 376, duration_ms: 110313 };
  const terminal = { run_id: 'approved-observer-003', result: { status: 'invalid', stop_batch: true,
    stop_reason: 'subject_requested_stop', episode_sha256: 'a'.repeat(64), budget_usage: usage } };
  const episode = { episode_sha256: terminal.result.episode_sha256, identity: { run_id: terminal.run_id, experiment_id: 'approved-observer' },
    admission: { status: 'invalid', reasons: ['core_notion_evidence_incomplete', 'runtime_not_a_business_episode:invalid'],
      completeness: { attempts: 'complete', tools: 'complete', interventions: 'complete' } },
    measurements: { actual_attempts: { status: 'known', value: 5 },
      input_total: { value: { status: 'known', value: usage.input_tokens } }, output_total: { value: { status: 'known', value: usage.output_tokens } } },
    timing: { duration_ms: { status: 'known', value: usage.duration_ms } } };
  const runtime = { status: 'invalid', error: null, budget: { requests: 5, input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens, usage_unknown: false, stop: null },
    notion: { coverage: { sdk: 'partial', owned_http: 'partial', child_lifecycle: 'partial', descendant_transport: 'unobserved' } } };
  return { episode, runtime, terminal, experimentId: 'approved-observer' };
}

test('retained stop requires the exact invalid observer shape with complete known usage', () => {
  const input = stoppedObservation(); assert.deepEqual(assertObserverStopObservation(input), input.terminal.result.budget_usage);
  for (const mutate of [
    value => { value.terminal.run_id = 'another-episode'; },
    value => { value.terminal.result.stop_batch = false; },
    value => { value.terminal.result.status = 'completed'; },
    value => { value.episode.admission.reasons.push('model_usage_unknown'); },
    value => { value.episode.admission.completeness.attempts = 'partial'; },
    value => { value.episode.measurements.input_total.value.status = 'unknown'; },
    value => { value.terminal.result.budget_usage.input_tokens++; },
    value => { value.episode.timing.duration_ms.value = null; },
    value => { value.runtime.error = { code: 'provider-error' }; },
    value => { value.runtime.budget.usage_unknown = true; },
    value => { value.runtime.budget.stop = 'request-limit'; },
    value => { value.runtime.notion.coverage.sdk = 'complete'; },
  ]) { const changed = structuredClone(input); mutate(changed); assert.throws(() => assertObserverStopObservation(changed)); }
});

test('v6 cannot be chained to accept another stop and ordinary result guards still reject later stops or unknown usage', async () => {
  await assert.rejects(readObserverRepairHistory({ parent: { value: { version: 6 } } }), /OBSERVER_CONTINUATION_PARENT_VERSION/);
  const scope = { kind: FINITE_CAMPAIGN }, plan = { protocol: { policies: { campaign: scope } }, execution: { campaign_scope: scope } };
  const stopped = stoppedObservation().terminal;
  await assert.rejects(verifyFiniteOriginalResults(plan, [{ ...stopped, type: 'episode_completed' }]), /FINITE_ORIGINAL_CORE_STOP/);
  const unknown = structuredClone(stopped); unknown.result.stop_batch = false; unknown.result.budget_usage.input_tokens = null;
  await assert.rejects(verifyFiniteOriginalResults(plan, [{ ...unknown, type: 'episode_completed' }]), /FINITE_ORIGINAL_UNKNOWN_USAGE/);
});


function catalogFixture() {
  const make = after => {
    const protocol = { models: [{ id: 'model-a' }, { id: 'model-b' }], corpus: { cases: [{ id: 'first' }, { id: 'second' }] },
      conditions: ['model-a', 'model-b'].map((model_id, index) => ({ id: 'm' + index, model_id, environment_id: 'own', case_ids: ['first', 'second'] })),
      environments: [{ id: 'own', pi: { catalog_sha256: null } }] };
    const execution = { conditions: Object.fromEntries(protocol.conditions.map(condition => [condition.id, {
      expectations: Object.fromEntries(condition.case_ids.map(case_id => [case_id, { path: '/capture/' + case_id,
        sha256: sha(condition.model_id + case_id + after) }])) }])) };
    return { protocol, execution };
  };
  const seal = value => { value.protocol.environments[0].pi.catalog_sha256 = fingerprint(value.protocol.conditions.flatMap(condition =>
    condition.case_ids.map(case_id => ({ model_id: condition.model_id, case_id, sha256: value.execution.conditions[condition.id].expectations[case_id].sha256 })))); };
  const source = make(false), current = make(true); seal(source); seal(current); return { source, current, seal };
}

test('repair catalogs retain the complete ordered model/case mapping and verify both digests', () => {
  const { source, current, seal } = catalogFixture();
  const check = (now, before) => assertResolveRepairCatalog(now.protocol, now.execution, before, 'own');
  check(current, source);
  for (const side of ['source', 'current']) {
    for (const mutate of [
      value => { value.protocol.environments[0].pi.catalog_sha256 = 'f'.repeat(64); },
      value => { value.execution.conditions.m0.expectations.first.sha256 = 'f'.repeat(64); },
      value => { value.protocol.conditions[0].case_ids.reverse(); seal(value); },
      value => { value.protocol.conditions.reverse(); seal(value); },
      value => { delete value.execution.conditions.m0.expectations.second; },
      value => { value.execution.conditions.m0.expectations.extra = { sha256: 'f'.repeat(64) }; },
    ]) {
      const values = { source: structuredClone(source), current: structuredClone(current) };
      mutate(values[side]); assert.throws(() => check(values.current, values.source));
    }
  }
  for (const mutate of [
    value => { value.protocol.models[0].id = value.protocol.conditions[0].model_id = 'different-model'; },
    value => {
      value.protocol.corpus.cases[0].id = 'different-case';
      for (const condition of value.protocol.conditions) {
        condition.case_ids[0] = 'different-case'; const refs = value.execution.conditions[condition.id].expectations;
        refs['different-case'] = refs.first; delete refs.first;
      }
    },
    value => { value.protocol.conditions.reverse(); value.protocol.models.reverse(); },
    value => { value.protocol.corpus.cases.reverse(); for (const condition of value.protocol.conditions) condition.case_ids.reverse(); },
  ]) {
    const changed = structuredClone(current); mutate(changed); seal(changed);
    assert.throws(() => check(changed, source), /RESOLVE_REPAIR_CATALOG_DESIGN_CHANGED/);
  }
});

async function credentialFixture(t, editRegistry = () => {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'resolve-credential-test-')));
  if (process.platform === 'darwin') t.after(() => execFileSync('/usr/bin/trash', [root]));
  const registry = { providers: { provider: { api: 'openai-completions', baseUrl: 'http://127.0.0.1/v1',
    apiKey: 'BENCHMARK_MODEL_KEY', models: [{ id: 'original-model' }] } } };
  editRegistry(registry); const bytes = JSON.stringify(registry), models_sha256 = sha(bytes);
  const credential = { source_file: '/unread/global/models.json', provider: 'provider', api_key_env: 'BENCHMARK_MODEL_KEY' };
  const owners = [];
  for (const name of ['science', 'parent', 'current']) {
    const control_root = join(root, 'control', name), models_file = join(control_root, 'models.json');
    await mkdir(control_root, { recursive: true }); await writeFile(models_file, bytes);
    owners.push({ environment_root: root, control_root, models_file, models_sha256, credential: structuredClone(credential) });
  }
  const [original, inherited, execution] = owners;
  execution.credential.source_file = inherited.models_file;
  const path = join(inherited.control_root, 'plan.json'); await writeFile(path, JSON.stringify({ execution: inherited }));
  return { original, inherited, execution, reference: { path, sha256: sha(await readFile(path)) } };
}

test('credential relocation requires the exact parent frozen registry and unchanged environment descriptor', async t => {
  const { original, inherited, execution, reference } = await credentialFixture(t);
  assert.deepEqual(await verifyResolveRepairCredential(execution, original, reference), original.credential);
  for (const mutate of [
    value => { value.credential.source_file = original.models_file; },
    value => { value.credential.source_file = execution.models_file; },
    value => { value.credential.provider = 'another-provider'; },
    value => { value.credential.api_key_env = 'ANOTHER_KEY'; },
    value => { value.credential.headers = { Authorization: 'changed' }; },
    value => { value.models_sha256 = 'f'.repeat(64); },
    value => { value.models_file = inherited.models_file; },
  ]) {
    const changed = structuredClone(execution); mutate(changed);
    await assert.rejects(verifyResolveRepairCredential(changed, original, reference));
  }
  await assert.rejects(verifyResolveRepairCredential(execution, original, { ...reference, sha256: 'f'.repeat(64) }));
  await writeFile(execution.models_file, JSON.stringify({ providers: { changed: {} } }));
  const changed = structuredClone(execution); changed.models_sha256 = sha(await readFile(changed.models_file));
  await assert.rejects(verifyResolveRepairCredential(changed, original, reference), /RESOLVE_REPAIR_CREDENTIAL_REGISTRY_CHANGED/);
  for (const edit of [
    value => { value.providers.provider.apiKey = 'literal-credential'; },
    value => { value.providers.provider.headers = { Authorization: 'undeclared' }; },
    value => { value.providers.extra = structuredClone(value.providers.provider); },
    value => { value.providers.provider.models.push({ id: 'new-model' }); },
  ]) {
    const fixture = await credentialFixture(t, edit);
    await assert.rejects(verifyResolveRepairCredential(fixture.execution, fixture.original, fixture.reference));
  }
});

test('v6 inherits the verified intermediate continuation without exempting other material exposure', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'resolve-ancestors-test-')));
  if (process.platform === 'darwin') t.after(() => execFileSync('/usr/bin/trash', [root]));
  const protocol = { phase: 'confirmation', corpus: { cases: [{ id: 'case', material_id: 'original-material',
    content_sha256: 'a'.repeat(64), prompt_sha256: 'b'.repeat(64), contract_sha256: 'c'.repeat(64),
    initial_state_sha256: 'd'.repeat(64), authorization_sha256: 'e'.repeat(64) }] } };
  const refs = [];
  for (const id of ['science', 'intermediate', 'parent', 'unrelated']) {
    const path = join(root, id + '.json'); await writeFile(path, JSON.stringify({ id, protocol, execution: {} }));
    refs.push({ path, sha256: sha(await readFile(path)) });
  }
  const transition = { scientific_source_plan: refs[0], source_plan: refs[2] };
  const parent = { value: { version: 5 }, confirmationContinuation: { transition: { scientific_source_plan: refs[0], source_plan: refs[1] } } };
  const history = { plans: refs.slice(0, 3).map(plan => ({ plan })) };
  const sources = observerRepairContinuationSources(parent, transition, history);
  assert.deepEqual(sources, refs.slice(0, 3));
  await assertConfirmationUnexposed(protocol, {}, history, sources);
  await assert.rejects(assertConfirmationUnexposed(protocol, {}, history, [refs[0], refs[2]]), /FINITE_CONFIRMATION_KNOWN_MATERIAL_EXPOSURE/);
  await assert.rejects(assertConfirmationUnexposed(protocol, {}, history), /FINITE_CONFIRMATION_KNOWN_MATERIAL_EXPOSURE/);
  await assert.rejects(assertConfirmationUnexposed(protocol, {}, { plans: [...history.plans, { plan: refs[3] }] }, sources), /FINITE_CONFIRMATION_KNOWN_MATERIAL_EXPOSURE/);
  const changed = structuredClone(protocol); changed.corpus.cases[0].content_sha256 = 'f'.repeat(64);
  await assert.rejects(assertConfirmationUnexposed(changed, {}, history, sources), /CONFIRMATION_CONTINUATION_MATERIAL_CHANGED/);
  for (const mutate of [
    value => { value.value.version = 6; },
    value => { value.confirmationContinuation.transition.scientific_source_plan = refs[1]; },
    value => { value.confirmationContinuation.transition.source_plan = refs[3]; },
    value => { value.confirmationContinuation.transition.source_plan.sha256 = 'f'.repeat(64); },
  ]) { const changed = structuredClone(parent); mutate(changed); assert.throws(() => observerRepairContinuationSources(changed, transition, history)); }
});
