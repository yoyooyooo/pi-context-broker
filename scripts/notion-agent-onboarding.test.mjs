import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { skillFileRef } from './skill-ref-fixture.mjs';
import { gradeOnboardingAssertions, gradeOnboardingBusiness, gradeOnboardingReadback, onboardingProducedLibraries, onboardingResult, validateOnboardingConfig, validateOnboardingOracle } from './notion-agent-onboarding.mjs';
import { validateOnboardingFileOutput, validateOnboardingLibrary, validateOnboardingPlacement, validateOnboardingLoaded, validateOnboardingSnapshot } from './notion-agent-onboarding-runtime.mjs';
import { validateAgentCorpus } from './notion-agent-scenarios.mjs';

const execute = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex');
const parent = '11111111-2222-3333-4444-555555555555', libraryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  databaseId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const config = { version: 1, scope: 'notion-agent-workflow', profile: 'native-onboarding', scenarioFile: '/owned/scenarios.json', scenarioId: 'onboard', bindingsFile: '/owned/bindings.json',
  pairedEnvironment: { root: '/owned/pair', build: 'packed' }, parent, modelsFile: '/owned/models.json', passEnv: ['NOTION_API_TOKEN', 'MODEL_API_KEY'], evidenceRoot: '/owned/evidence', oracleFile: '/owned/oracle.json', model: 'magpie/group/worker', thinkingLevel: 'high' };
const oracle = { version: 1, allowAdditionalSkills: false, skills: [{ name: 'travel', files: [
  { path: 'SKILL.md', contains: ['Every receipt'] }, { path: 'references/rules.md', sha256: hash('complete supporting content\n') },
] }] };
const observed = { status: 'read_back', complete: true, libraryValidation: { status: 'passed' }, skills: [{ name: 'travel', files: [
  { path: 'SKILL.md', complete: true, content: '# Travel\nEvery receipt needs a date.\n' },
  { path: 'references/rules.md', complete: true, content: 'complete supporting content\n', sha256: hash('complete supporting content\n') },
] }] };

function currentReadbackFixture(content = '# Travel\nEvery receipt needs a date.\n') {
  const id = n => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
  const library = { version: 2, library_id: libraryId, operation_id: id(99),
    ...Object.fromEntries(['skills', 'files', 'records', 'sources'].map((role, i) => [role, { database_id: i ? id(i * 2 + 3) : databaseId, data_source_id: id(i * 2 + 4), property_ids: { Name: 'title' } }])) };
  const record = { id: 'skill://travel?library=' + libraryId, kind: 'skill', name: 'travel', entrypoint: 'SKILL.md',
    locator: { type: 'shared_skill', page_id: id(1), database_id: databaseId, data_source_id: id(4), library_id: library.library_id, skill_id: 'travel' } };
  const support = 'complete supporting content\n', snapshot = 's_' + '1'.repeat(64);
  const bindings = [{ path: 'SKILL.md', file_id: 'main-travel', page_id: id(1) }, { path: 'references/rules.md', file_id: 'support-travel', page_id: id(9) }];
  const ref = binding => skillFileRef(record.id, binding.path, snapshot);
  const metadata = { record, scope: 'scope-current', snapshot_id: snapshot, version_id: '2'.repeat(64), entrypoint: 'SKILL.md', file_bindings: bindings };
  const effects = { version: 1, remote_writes: 'none', author_content: 'unchanged' };
  const main = { ...metadata, path: 'SKILL.md', ref: ref(bindings[0]), source: 'notion', freshness: { policy: 'refresh', stale: false },
    materialization: { manifest_complete: true, materialized_paths: ['SKILL.md'] }, content, range: { start: 1, end: content.split('\n').length, total_lines: content.split('\n').length }, has_more: false, effects };
  const files = bindings.map((binding, i) => ({ path: binding.path, bytes: Buffer.byteLength(i ? support : content), sha256: hash(i ? support : content), mode: '100644', ref: ref(binding) }));
  const listed = { ...metadata, ref: main.ref, files, source: 'local_snapshot', freshness: { policy: 'pinned' }, materialization: { manifest_complete: true, materialized_paths: [] } };
  const output = { ...metadata, path: bindings[1].path, ref: ref(bindings[1]), source: 'local_snapshot', freshness: { policy: 'pinned' },
    materialization: { manifest_complete: true, materialized_paths: [bindings[1].path] }, output: '/owned/output', reused: false,
    bytes: files[1].bytes, sha256: files[1].sha256, entrypoint_sha256: files[0].sha256, effects };
  const catalog = { library_id: libraryId, has_more: false, next_cursor: null, records: [record], count: 1, total_count: 1, databases: [{ library_id: libraryId, database_id: databaseId, shared_library: library }],
    coverage: { method: 'explicit_library', exhaustive: true, failed_sources: [], search_index_limited: false, queried_data_sources: [library.skills.data_source_id] },
    source: 'notion', freshness: { policy: 'refresh', stale: false } };
  const placement = { root: { object: 'page', id: libraryId, parent: { type: 'page_id', page_id: parent } },
    databases: Object.fromEntries(Object.entries(library).filter(([role]) => ['skills', 'files', 'records', 'sources'].includes(role))
      .map(([role, binding]) => [role, { object: 'database', id: binding.database_id, parent: { type: 'page_id', page_id: libraryId }, data_sources: [{ id: binding.data_source_id }] }])),
    dataSources: Object.fromEntries(Object.entries(library).filter(([role]) => ['skills', 'files', 'records', 'sources'].includes(role))
      .map(([role, binding]) => [role, { object: 'data_source', id: binding.data_source_id, parent: { type: 'database_id', database_id: binding.database_id } }])) };
  return { library, placement, record, main, listed, output, support, catalog,
    initialized: { contract: 'current', library, reused: true }, inspected: { contract: 'current', library } };
}

test('onboarding inputs distinguish an empty parent from daily configuration and fixed model requirements', () => {
  validateOnboardingConfig(config);
  for (const patch of [{ entry: databaseId }, { database: databaseId }, { library: libraryId }, { brokerRoot: '/daily/broker' }, { cliRoot: '/daily/cli' },
    { profile: 'no-native-skills' }, { model: 'fake/model' }, { thinkingLevel: 'low' }, { parent: 'missing' },
    { passEnv: ['secret-value'] }, { timeoutMs: 0 }, { timeoutMs: 3600000 }]) assert.throws(() => validateOnboardingConfig({ ...config, ...patch }));
  const corpus = { version: 1, fixtures: { empty: { kind: 'empty-parent', objects: [] } }, scenarios: [
    { id: 'onboard', contract_ids: ['C08', 'T22'], profiles: ['native-onboarding'], fixture: 'empty', turns: [{ id: 'create', prompt: 'Create my library.', expect: [{ kind: 'completed' }] }] },
  ] };
  validateAgentCorpus(corpus);
  for (const mutate of [value => value.scenarios[0].profiles.push('daily'), value => value.scenarios[0].turns[0].before = [{ kind: 'restart', mode: 'fresh' }],
    value => value.fixtures.empty.environment = { catalog: 'normal' }, value => value.scenarios[0].turns[0].expect.push({ kind: 'output', all: ['answer'] })]) {
    const value = structuredClone(corpus); mutate(value); assert.throws(() => validateAgentCorpus(value));
  }
});

test('only actual successful v2 root descriptors produce grader Libraries', () => {
  const library = { version: 2, library_id: libraryId, skills: { database_id: databaseId } };
  const message = (role = 'toolResult', value = { ok: true, library }) => JSON.stringify({ id: 'result-1', type: 'message', message: { role, toolCallId: 'call-1', content: [{ type: 'text', text: 'output\n' + JSON.stringify(value, null, 2) + '\nProcess exited with code 0.' }] } }) + '\n';
  assert.equal(onboardingProducedLibraries(message())[0].libraryId, libraryId);
  assert.deepEqual(onboardingProducedLibraries(message('assistant')), []);
  assert.deepEqual(onboardingProducedLibraries(message('toolResult', { ok: false, library })), []);
  assert.deepEqual(onboardingProducedLibraries(message('toolResult', { ok: true, library: { ...library, version: 1 } })), []);
  assert.deepEqual(onboardingProducedLibraries(message('toolResult', { ok: true, library: { ...library, parent_page_id: parent } })), []);
  assert.equal(onboardingProducedLibraries(message() + message()).length, 1);
  const other = { ...library, library_id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee' };
  assert.equal(onboardingProducedLibraries(message() + message('toolResult', { ok: true, library: other })).length, 2);
});

test('independent grading requires a complete directory, complete bytes and explicit business criteria', () => {
  validateOnboardingOracle(oracle); assert.equal(gradeOnboardingReadback(oracle, observed).status, 'passed');
  for (const mutate of [value => value.complete = false, value => value.skills[0].files.pop(), value => value.skills[0].files[1].sha256 = '0'.repeat(64),
    value => value.skills[0].files[0].content = 'Some other policy', value => value.skills[0].files[1].complete = false,
    value => value.skills.push({ name: 'unexpected', files: [] }), value => delete value.libraryValidation]) {
    const value = structuredClone(observed); mutate(value); assert.notEqual(gradeOnboardingReadback(oracle, value).status, 'passed');
  }
  const unsafe = structuredClone(oracle); unsafe.skills[0].files[1].path = '../private'; assert.throws(() => validateOnboardingOracle(unsafe));
  const vacuous = structuredClone(oracle); vacuous.skills[0].files = []; assert.throws(() => validateOnboardingOracle(vacuous));
  const usage = { ...oracle, output: { contains: ['missing date'] } };
  assert.equal(gradeOnboardingBusiness(usage, observed, { finalOutput: 'The receipt is missing date.' }).status, 'passed');
  assert.equal(gradeOnboardingBusiness(usage, observed, { finalOutput: 'Saved.' }).status, 'failed');
});

test('exit zero, runtime drift, missing grader and failed business results stay distinct', () => {
  const receipt = { status: 'passed', command_status: 'succeeded', runtime_check: { status: 'unchanged' }, frozen_artifacts: 'passed' };
  const success = { episode: { status: 'passed' }, episodeRun: receipt, graderRun: receipt, business: { status: 'passed' }, hardContracts: { status: 'passed' } };
  assert.equal(onboardingResult(success).status, 'passed');
  for (const status of ['drifted', 'unknown']) {
    const result = onboardingResult({ ...success, episodeRun: { ...receipt, runtime_check: { status } } });
    assert.equal(result.status, 'failed'); assert.equal(result.validity, 'invalid'); assert.equal(result.process, 'succeeded'); assert.equal(result.business.status, 'passed');
  }
  const missing = onboardingResult({ ...success, graderRun: null });
  assert.equal(missing.remoteEffects, 'unknown_reconcile_before_retry'); assert.equal(missing.status, 'failed');
  assert.equal(onboardingResult({ ...success, business: { status: 'failed' } }).status, 'failed');
  const scenario = { turns: [{ id: 'first', expect: [{ kind: 'candidate-cli', min: 2 }, { kind: 'business-readback' }] }] };
  assert.equal(gradeOnboardingAssertions(scenario, { turns: [{ id: 'first', cliProcesses: { status: 'passed', matchedCliCount: 1 } }] }, { status: 'passed' }).status, 'failed');
});

test('actual Pi loading must match the shared declaration and contain no Broker or native Skills', () => {
  const run = { root: '/owned/run', candidate: { entries: { cli: '/owned/packed/cli.js' } }, pi_launch: { entry: '/machine/pi.js', argv: ['-ne', '-ns'], settings: { packages: [], enableSkillCommands: true } } };
  const loaded = { pid: 4, model: { provider: 'magpie', id: 'group/worker' }, settings: run.pi_launch.settings, agentDir: '/owned/run/pi-agent', sessions: '/owned/run/sessions', cliEntry: run.candidate.entries.cli,
    argv: ['/node', '/machine/pi.js', '-ne', '-ns', '--mode', 'rpc'], commands: [], tools: [{ name: 'bash' }] };
  assert.equal(validateOnboardingLoaded([loaded], run).status, 'passed');
  for (const mutate of [value => value.commands.push({ name: 'context-broker' }), value => value.commands.push({ name: 'skill:maintain', source: 'skill' }),
    value => value.tools.push({ name: 'notion_use' }), value => value.argv[2] = '-e', value => value.cliEntry = '/global/cli.js']) {
    const value = structuredClone(loaded); mutate(value); assert.throws(() => validateOnboardingLoaded([value], run));
  }
});

test('fresh schema and file proof reject partial or mismatched current outputs', () => {
  const sample = currentReadbackFixture(), input = { libraryId, parent, library: sample.library };
  assert.deepEqual(validateOnboardingLibrary(sample.initialized, sample.inspected, input), sample.library);
  for (const mutate of [value => value.reused = false, value => delete value.contract, value => delete value.library.sources]) {
    const value = structuredClone(sample.initialized); mutate(value); assert.throws(() => validateOnboardingLibrary(value, sample.inspected, input));
  }
  assert.equal(validateOnboardingSnapshot(sample.main, sample.listed, sample.record, sample.library).length, 2);
  for (const mutate of [value => value.main.range.start = 2, value => value.main.has_more = true,
    value => value.listed.has_more = true, value => value.listed.materialization.manifest_complete = false,
    value => value.listed.files.pop(), value => value.listed.files[1].ref = value.listed.files[0].ref,
    value => value.listed.version_id = 'other', value => delete value.listed.files,
    value => value.listed.files[0].bytes--]) {
    const value = structuredClone(sample); mutate(value); assert.throws(() => validateOnboardingSnapshot(value.main, value.listed, value.record, value.library));
  }
  validateOnboardingFileOutput(sample.output, sample.main, sample.listed.files[1], Buffer.from(sample.support), '/owned/output');
  for (const mutate of [value => delete value.bytes, value => value.path = 'another.md', value => value.snapshot_id = 'other',
    value => value.ref = sample.main.ref, value => value.sha256 = '0'.repeat(64), value => value.entrypoint_sha256 = '0'.repeat(64)]) {
    const value = structuredClone(sample.output); mutate(value); assert.throws(() => validateOnboardingFileOutput(value, sample.main, sample.listed.files[1], Buffer.from(sample.support), '/owned/output'));
  }
  assert.throws(() => validateOnboardingFileOutput(sample.output, sample.main, sample.listed.files[1], Buffer.from(sample.support.slice(1)), '/owned/output'));
});

test('placement checks independent root, database and data-source parents', () => {
  const sample = currentReadbackFixture(), input = { libraryId, parent, library: sample.library };
  assert.equal(validateOnboardingPlacement(sample.library, input, sample.placement).root, libraryId);
  for (const mutate of [
    value => { value.root.id = databaseId; },
    value => { value.root.parent.page_id = libraryId; },
    value => { value.root.in_trash = true; },
    value => { value.databases.skills.parent.page_id = parent; },
    value => { value.dataSources.skills.parent.database_id = sample.library.files.database_id; },
    value => { value.databases.skills.data_sources = []; },
  ]) {
    const observed = structuredClone(sample.placement); mutate(observed);
    assert.throws(() => validateOnboardingPlacement(sample.library, input, observed));
  }
  assert.equal(sample.library.library_id, libraryId, 'The candidate descriptor stayed unchanged throughout physical-world mutations');
});

test('fresh grader wiring reads the explicit Library root and every supporting file through the actual selected CLI', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'onboarding-grader-test-'))); t.diagnostic('Retained grader wiring evidence: ' + base);
  const cli = join(base, 'fixture-cli.mjs'), main = '# Full main\n' + 'middle\n'.repeat(12000) + 'Every receipt\n', sample = currentReadbackFixture(main);
  const physical = new Map([['/v1/pages/' + libraryId, sample.placement.root],
    ...Object.values(sample.placement.databases).map(value => ['/v1/databases/' + value.id, value]),
    ...Object.values(sample.placement.dataSources).map(value => ['/v1/data_sources/' + value.id, value])]);
  const placementCalls = [], server = createServer((request, response) => {
    placementCalls.push({ method: request.method, path: request.url });
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET' || !physical.has(request.url)) { response.statusCode = 404; response.end('{}'); return; }
    response.end(JSON.stringify(physical.get(request.url)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  await writeFile(cli, `import fs from 'node:fs';const args=process.argv.slice(2),sample=${JSON.stringify(sample)};let result;
fs.appendFileSync(process.env.PAIRED_RUN_ROOT+'/calls.jsonl',JSON.stringify({args,entry:process.argv[1],state:process.env.NTN_SKILLS_HOME})+'\\n');
if(args[0]==='ctl')result=args[2]==='init'?sample.initialized:sample.inspected;
else if(args[0]==='list')result=sample.catalog;
else if(args[0]==='files')result=sample.listed;
else if(args[1]===sample.record.locator.page_id)result=sample.main;
else {const output=args[args.indexOf('--output')+1];fs.writeFileSync(output,sample.support);result={...sample.output,output};}
console.log(JSON.stringify({ok:true,...result}));\n`);
  const root = join(base, 'fresh-grader');
  for (const path of ['native','config/cli','state/cli','cache/cli','data/cli','state/scheduler','sessions','workspace']) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, 'config/cli/config.json'), JSON.stringify({ default_library: libraryId }));
  await writeFile(join(root, 'run.json'), JSON.stringify({ root, run_id: 'fresh-grader', target: 'command', candidate: { mode: 'packed', entries: { cli } },
    pi_launch: { mode: 'native', native_skill_roots: [join(root, 'native')] }, remote: { library: libraryId, parent: null } }));
  const input = join(base, 'input.json'); await writeFile(input, JSON.stringify({ version: 1, libraryId, parent, library: sample.library }));
  await execute(process.execPath, ['--input-type=module', '--eval', `const m=await import(${JSON.stringify(new URL('./notion-agent-onboarding-runtime.mjs', import.meta.url).href)});await m.runOnboardingGrader(process.argv[1]);`, input],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME, PAIRED_RUN_ROOT: root, PAIRED_CLI_ENTRY: cli, NTN_SKILLS_HOME: join(root, 'state/cli'),
      NOTION_API_TOKEN: 'controlled-placement-fixture', NOTION_API_BASE_URL: 'http://127.0.0.1:' + server.address().port }, timeout: 15000 });
  const result = JSON.parse(await readFile(join(root, 'readback.json'), 'utf8'));
  assert.equal(result.status, 'read_back'); assert.equal(result.complete, true); assert.equal(result.skills[0].files[0].content, main);
  assert.equal(gradeOnboardingReadback(oracle, result).status, 'passed');
  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0].args, ['ctl', 'library', 'init', '--library', libraryId]); assert.deepEqual(calls[1].args, ['ctl', 'library', 'inspect', '--library', libraryId]); assert.ok(calls.every(call => call.state === join(root, 'state/cli') && call.entry === cli));
  assert.ok(calls.some(call => call.args[0] === 'read' && call.args[1] === 'references/rules.md' && call.args.includes('--output')));
  assert.equal(placementCalls.length, 9); assert.ok(placementCalls.every(call => call.method === 'GET'));
});

const pairedCliSource = process.env.PAIRED_CLI_SOURCE ?? (process.env.CONTEXT_BROKER_GRAPH_CORE ? resolve(process.env.CONTEXT_BROKER_GRAPH_CORE, '../../..') : null);
test('the installed CLI grader reads complete current HTTP pagination, long text, binary and empty files', {
  skip: !(process.env.NTN_SKILLS_BUILD_ENTRY && pairedCliSource) && 'Requires the paired installed CLI and its source fixture', timeout: 420000,
}, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'onboarding-installed-grader-'))); t.diagnostic('Retained installed grader evidence: ' + base);
  const fixtureRoot = join(base, 'fixture');
  await execute(process.execPath, [join(pairedCliSource, 'scripts/sdk-fixture.ts'), '--outdir', fixtureRoot], { timeout: 30000 });
  const fixture = JSON.parse(await readFile(join(fixtureRoot, 'fixture.json'), 'utf8'));
  const fixtureEnv = JSON.parse(await readFile(fixture.env, 'utf8'));
  const { startSdkSourceFixture } = await import(pathToFileURL(join(pairedCliSource, 'scripts/sdk-source-fixture.mjs')));
  const service = await startSdkSourceFixture(fixture, join(base, 'http.jsonl'));
  t.after(() => service.close());
  const root = join(base, 'fresh-grader'), cli = await realpath(process.env.NTN_SKILLS_BUILD_ENTRY);
  for (const path of ['native','config/cli','state/cli','cache/cli','data/cli','state/scheduler','sessions','workspace','tmp']) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, 'config/cli/config.json'), JSON.stringify({ default_library: fixture.notion.library.library_id }));
  await writeFile(join(root, 'run.json'), JSON.stringify({ root, run_id: 'installed-grader', target: 'command', candidate: { mode: 'packed', entries: { cli } },
    pi_launch: { mode: 'native', native_skill_roots: [join(root, 'native')] }, remote: { library: fixture.notion.library.library_id, parent: null } }));
  const input = join(base, 'input.json'); await writeFile(input, JSON.stringify({ version: 1, libraryId: fixture.notion.library.library_id, parent: fixture.notion.root.parent.page_id, library: fixture.notion.library }));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: join(root, 'tmp'), PAIRED_RUN_ROOT: root, PAIRED_CLI_ENTRY: cli,
    NTN_SKILLS_HOME: join(root, 'state/cli'), NTN_SKILLS_CACHE_HOME: join(root, 'cache/cli'), NTN_SKILLS_CONFIG_HOME: join(root, 'config/cli'),
    NTN_SKILLS_DATA_HOME: join(root, 'data/cli'), NTN_SKILLS_SCHEDULER_ROOT: join(root, 'state/scheduler'),
    NTN_SKILLS_NOTION_INTERVAL_MS: fixtureEnv.NTN_SKILLS_NOTION_INTERVAL_MS, NOTION_API_TOKEN: fixtureEnv.NOTION_API_TOKEN, NOTION_API_BASE_URL: service.origin };
  await execute(process.execPath, ['--input-type=module', '--eval', `const m=await import(${JSON.stringify(new URL('./notion-agent-onboarding-runtime.mjs', import.meta.url).href)});await m.runOnboardingGrader(process.argv[1]);`, input], { env, timeout: 390000 });
  const result = JSON.parse(await readFile(join(root, 'readback.json'), 'utf8'));
  assert.equal(result.status, 'read_back'); assert.equal(result.complete, true); assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].files.length, fixture.expected.file_count);
  for (const expected of fixture.expected.files) {
    const actual = result.skills[0].files.find(file => file.path === expected.path);
    assert.ok(actual); assert.equal(actual.bytes, expected.bytes); assert.equal(actual.sha256, expected.sha256);
  }
  assert.deepEqual(service.unexpected, []);
  const physicalPaths = ['/v1/pages/' + fixture.notion.root.id, '/v1/blocks/' + fixture.notion.root.id + '/children',
    ...fixture.notion.databases.map(row => '/v1/databases/' + row.id),
    ...fixture.notion.data_sources.map(row => '/v1/data_sources/' + row.id)];
  for (const path of physicalPaths) assert.ok(service.requests.some(call => call.method === 'GET' && call.path === path), 'Missing independent root/schema observation: ' + path);
  assert.ok(service.requests.every(call => call.method === 'GET' || call.method === 'POST' && /^\/v1\/data_sources\/[^/]+\/query$/u.test(call.path)));
  await writeFile(join(base, 'result.json'), JSON.stringify({ status: 'passed', scope: 'controlled-current-HTTP-installed-CLI-grader', files: fixture.expected.file_count,
    cli, httpRequests: service.requests.length, schemaReads: service.requests.filter(call => physicalPaths.includes(call.path)).length, semanticWrites: 0, notRun: ['real model', 'live Notion', 'daily'] }, null, 2) + '\n');
});
