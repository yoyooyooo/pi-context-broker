import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentWorkflowArgs, agentWorkflowEnvironment, agentWorkflowProjectSettings, prepareWorkflowTemporaryEnvironment, workflowSourceSlice, workflowCatalogFault, awaitWorkflowCatalog } from './notion-agent-workflow-runtime.mjs';
import { validateCandidateTurn } from './verify-pi-daily-candidate.mjs';

const execute = promisify(execFile);
async function temporaryFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workflow-temporary-')));
  if (await access('/usr/bin/trash').then(() => true, () => false)) t.after(() => execute('/usr/bin/trash', [root]));
  const ownership = { runId: 'temporary-test', root, token: 'owned-temporary-token', temporaryRoot: join(root, 'temporary') };
  await mkdir(ownership.temporaryRoot); await writeFile(join(root, 'ownership.json'), JSON.stringify(ownership));
  const projectRoot = join(root, 'project'); await mkdir(projectRoot);
  return { root, runId: ownership.runId, ownership, projectRoot };
}

test('explicit TMPDIR shell templates and Node temporary APIs retain inputs without changing the caller environment', async t => {
  const fixture = await temporaryFixture(t);
  const inherited = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: '/inherited-temporary-root' }, before = { ...inherited };
  const { env, projectContext } = await prepareWorkflowTemporaryEnvironment(fixture, inherited);
  assert.deepEqual(inherited, before);
  assert.deepEqual(env, { ...before, TMPDIR: fixture.ownership.temporaryRoot });
  assert.equal(projectContext.path, join(fixture.projectRoot, 'AGENTS.md'));
  const context = await readFile(projectContext.path);
  assert.equal(createHash('sha256').update(context).digest('hex'), projectContext.sha256);
  assert.equal(context.length, projectContext.bytes);
  const shell = (await execute('/bin/sh', ['-c', 'mktemp -d "${TMPDIR%/}/work.XXXXXX"'], { env })).stdout.trim();
  const node = (await execute(process.execPath, ['-e', 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path");console.log(fs.mkdtempSync(path.join(os.tmpdir(),"node-")))'], { env })).stdout.trim();
  for (const path of [shell, node]) {
    assert.ok(path.startsWith(fixture.ownership.temporaryRoot + '/'), 'Temporary API escaped owned evidence: ' + path);
    assert.equal(await realpath(path), path);
    await writeFile(join(path, 'operation-input.md'), '# Preserve exact retry input\n');
    assert.equal(await readFile(join(path, 'operation-input.md'), 'utf8'), '# Preserve exact retry input\n');
  }
});

test('the subject process receives all five owned roots instead of inherited config and scheduler state', async t => {
  const fixture = await temporaryFixture(t), stateRoot = join(fixture.root, 'owned-state'), sourceConfigPath = join(fixture.root, 'source-config.json');
  const directories = { NTN_SKILLS_HOME: 'state', NTN_SKILLS_CONFIG_HOME: 'config', NTN_SKILLS_CACHE_HOME: 'cache', NTN_SKILLS_DATA_HOME: 'data', NTN_SKILLS_SCHEDULER_ROOT: 'scheduler' };
  const inherited = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: fixture.ownership.temporaryRoot,
    NTN_SKILLS_DEV_ROOT: join(fixture.root, 'inherited-dev'),
    ...Object.fromEntries(Object.entries(directories).map(([key, directory]) => [key, join(fixture.root, 'inherited-' + directory)])) };
  const before = { ...inherited }, env = agentWorkflowEnvironment(inherited, { stateRoot, sourceConfigPath, evidence: fixture.root });
  const keys = [...Object.keys(directories), 'CONTEXT_BROKER_CONFIG', 'NTN_SKILLS_DEV_ROOT', 'HOME', 'TMPDIR'];
  const child = await execute(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.fromEntries(' + JSON.stringify(keys) + '.map(key=>[key,process.env[key]]))))'], { env });
  const observed = JSON.parse(child.stdout);
  for (const [key, directory] of Object.entries(directories)) assert.equal(observed[key], join(stateRoot, directory));
  assert.equal(observed.CONTEXT_BROKER_CONFIG, sourceConfigPath);
  assert.equal(observed.NTN_SKILLS_DEV_ROOT, undefined);
  assert.equal(observed.HOME, inherited.HOME); assert.equal(observed.TMPDIR, inherited.TMPDIR);
  assert.deepEqual(inherited, before, 'The launch environment must not mutate the caller');
});

test('the public candidate-plan command dynamically loads workflows and reports a missing corpus without an await cycle', async t => {
  const fixture = await temporaryFixture(t), configPath = join(fixture.root, 'config.json');
  const config = { version: 1, scope: 'notion-agent-workflow', profile: 'daily', model: 'magpie/group/worker', thinkingLevel: 'high',
    scenarioFile: join(fixture.root, 'missing-corpus.json'), bindingsFile: join(fixture.root, 'bindings.json'),
    brokerRoot: join(fixture.root, 'broker'), cliRoot: join(fixture.root, 'cli'), evidenceRoot: join(fixture.root, 'evidence') };
  await writeFile(configPath, JSON.stringify(config));
  await assert.rejects(execute(process.execPath, ['scripts/verify-pi-daily-installation.mjs', 'candidate-plan', '--config', configPath],
    { timeout: 15000 }), error => {
    assert.equal(error.code, 1, 'The public dispatch must reach configuration validation');
    assert.match(error.stderr, /ENOENT.*missing-corpus\.json/u);
    assert.doesNotMatch(error.stderr, /unsettled top-level await/u);
    return true;
  });
});

test('temporary evidence rejects missing ownership, a foreign token, an escaped path and a symlink', async t => {
  for (const mode of ['missing', 'foreign-token', 'outside-root', 'symlink']) await t.test(mode, async t => {
    const fixture = await temporaryFixture(t), marker = join(fixture.root, 'ownership.json');
    if (mode === 'missing') {
      delete fixture.ownership.temporaryRoot;
      await writeFile(marker, JSON.stringify(fixture.ownership));
    } else if (mode === 'foreign-token') {
      fixture.ownership.token = 'someone-else';
    } else if (mode === 'outside-root') {
      fixture.ownership.temporaryRoot = join(fixture.root, '..', 'outside');
      await writeFile(marker, JSON.stringify(fixture.ownership));
    } else {
      const preserved = join(fixture.root, 'preserved');
      await rename(fixture.ownership.temporaryRoot, preserved);
      await symlink(preserved, fixture.ownership.temporaryRoot);
    }
    await assert.rejects(prepareWorkflowTemporaryEnvironment(fixture, {}));
  });
});

test('temporary context refuses an existing native context file and a project outside its owner', async t => {
  for (const name of ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']) await t.test(name, async t => {
    const fixture = await temporaryFixture(t), path = join(fixture.projectRoot, name), content = '# Existing project instructions\n';
    await writeFile(path, content);
    await assert.rejects(prepareWorkflowTemporaryEnvironment(fixture, {}), /existing project context/u);
    assert.equal(await readFile(path, 'utf8'), content);
  });
  const fixture = await temporaryFixture(t);
  fixture.projectRoot = fixture.root;
  await assert.rejects(prepareWorkflowTemporaryEnvironment(fixture, {}), /owned project/u);
  const linked = await temporaryFixture(t), original = join(linked.root, 'original-project');
  await rename(linked.projectRoot, original); await symlink(original, linked.projectRoot);
  await assert.rejects(prepareWorkflowTemporaryEnvironment(linked, {}), /project cannot be a symlink/u);
  await assert.rejects(readFile(join(original, 'AGENTS.md')), { code: 'ENOENT' });
});

test('daily and no-native-skills use the same real worker and retain normal extension discovery', () => {
  const config = { model: 'magpie/group/worker', thinkingLevel: 'high', profile: 'daily' };
  const daily = agentWorkflowArgs(config, '/owned/sessions', ['/owned/passive.mjs']);
  const comparison = agentWorkflowArgs({ ...config, profile: 'no-native-skills' }, '/owned/sessions', ['/owned/passive.mjs']);
  assert.deepEqual(comparison, ['-ns', ...daily]);
  assert.deepEqual(daily.slice(daily.indexOf('--provider'), daily.indexOf('--thinking') + 2), ['--provider', 'magpie', '--model', 'group/worker', '--thinking', 'high']);
  for (const args of [daily, comparison]) for (const forbidden of ['-ne', '--no-extensions', '--skill', '--no-session', '--system-prompt']) assert.ok(!args.includes(forbidden));
  for (const change of [{ profile: 'notion-only' }, { profile: 'normal' }, { model: 'magpie/group/flash' }, { thinkingLevel: 'off' }])
    assert.throws(() => agentWorkflowArgs({ ...config, ...change }, '/owned/sessions', []));
});

test('source attribution retains complete overlapping operations and excludes an earlier management write', () => {
  const row = (phase, requestId, at, rest = {}) => ({ phase, requestId, monotonicNs: String(at), ...rest });
  const events = [row('started', 'old-write', 1), row('attempt', 'old-write', 2, { method: 'PATCH' }), row('completed', 'old-write', 3),
    row('started', 'background-list', 4), row('attempt', 'background-list', 6), row('metrics', 'background-list', 15), row('completed', 'background-list', 16),
    row('started', 'read', 7), row('attempt', 'read', 8), row('metrics', 'read', 9), row('completed', 'read', 10),
    row('started', 'later', 20), row('completed', 'later', 21)];
  const actual = workflowSourceSlice(events, '5', '12');
  assert.deepEqual([...new Set(actual.map(row => row.requestId))], ['background-list', 'read']);
  assert.equal(actual.filter(row => row.requestId === 'background-list').length, 4);
  assert.ok(!actual.some(row => row.method === 'PATCH'));
});

test('declared compact budget changes only the owned project and is consistent for the whole session', () => {
  const settings = { packages: ['normal-package'], compaction: { enabled: true } }, before = structuredClone(settings);
  const ordinary = { turns: [{ id: 'continue' }] };
  assert.deepEqual(agentWorkflowProjectSettings(settings, ordinary), settings);
  const compact = { turns: [{ before: [{ kind: 'compact', keepRecentTokens: 128 }] }] };
  assert.deepEqual(agentWorkflowProjectSettings(settings, compact), { ...settings, compaction: { enabled: true, keepRecentTokens: 128 } });
  assert.deepEqual(settings, before);
  assert.throws(() => agentWorkflowProjectSettings(settings, { turns: [{ before: [
    { kind: 'compact', keepRecentTokens: 128 }, { kind: 'compact', keepRecentTokens: 256 },
  ] }] }), /one declared compaction/u);
});

test('negative notion_use means zero actual attempts, including a failed or guard-rejected call', () => {
  const observed = { costs: [], transport: [], tasks: [{ phase: 'tool_call', toolName: 'notion_use', toolCallId: 'bad' },
    { phase: 'tool_result', toolName: 'notion_use', toolCallId: 'bad', isError: true }] };
  assert.throws(() => validateCandidateTurn({ requireUse: false }, observed), /unnecessary notion_use attempt/u);
});

test('catalog barriers require the actual owned SDK failure and never turn cancellation or an unrelated failure into readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-catalog-')), file = join(root, 'source.jsonl');
  const options = { sourceId: 'selected', database: '01234567-89ab-cdef-0123-456789abcdef' };
  const start = { phase: 'started', kind: 'sdk', operation: 'list', requestId: 'request', monotonicNs: '1',
    source_id: options.sourceId, database: options.database };
  const end = { phase: 'completed', requestId: start.requestId, monotonicNs: '2', status: 'failed', sdkStarted: true, errorCode: 'STATE_UNAVAILABLE' };
  const put = async (first = start, last = end) => writeFile(file, [first, last].map(JSON.stringify).join('\n') + '\n');
  await put();
  await assert.rejects(awaitWorkflowCatalog(file, 20, options), /Normal catalog preparation failed/u);
  const faulted = { ...options, expectedFailure: { mode: 'store-unavailable', expectedErrorCode: 'STATE_UNAVAILABLE' } };
  assert.equal((await awaitWorkflowCatalog(file, 20, faulted)).observedErrorCode, 'STATE_UNAVAILABLE');
  for (const change of [{ status: 'completed' }, { status: 'cancelled' }, { errorCode: 'SOURCE_SDK_UNAVAILABLE' }, { sdkStarted: false }]) {
    await put(start, { ...end, ...change }); await assert.rejects(awaitWorkflowCatalog(file, 20, faulted));
  }
  for (const change of [{ source_id: 'other' }, { database: 'different' }, { operation: 'read' }]) {
    await put({ ...start, ...change }); await assert.rejects(awaitWorkflowCatalog(file, 20, faulted), /required terminal state/u);
  }
});

test('a declared Store outage needs sealed probe artifacts and the still-active owned physical blocker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-store-barrier-')), state = join(root, 'state');
  const record = async (name, value) => {
    const path = join(root, name), bytes = Buffer.from(JSON.stringify(value)); await writeFile(path, bytes);
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  };
  const fixture = { root, ownership: { token: 'owned-token' }, faults: [] }, bindings = { private: { fixture } };
  assert.equal(await workflowCatalogFault(bindings, state), undefined);
  const marker = { fixtureFault: fixture.ownership.token, restoreFrom: join(root, 'quarantine') };
  const blocker = await record('marker.json', marker); await writeFile(state, JSON.stringify(marker));
  const selected = { owner: 'owner', snapshot_id: 'snapshot' };
  const fault = { mode: 'store-unavailable', source: state, target: marker.restoreFrom, status: 'active',
    probe: { roots: { NTN_SKILLS_HOME: state }, selected }, proof: {
      before: { status: 'passed', command: await record('before.json', { ok: true }), observed: { ...selected, totalRequests: 0, remoteWrites: 'none' } },
      after: { status: 'failed', expected: true, code: 'STATE_UNAVAILABLE', details: { phase: 'sqlite_state', native_code: 'ENOTDIR' }, command: await record('after.json', { ok: false }) },
      blocker: { kind: 'regular-file', observedPath: state, readPath: join(state, 'state.sqlite'), readError: 'ENOTDIR', artifact: blocker },
    } };
  fixture.faults.push(fault);
  assert.equal((await workflowCatalogFault(bindings, state)).expectedErrorCode, 'STATE_UNAVAILABLE');
  await writeFile(state, 'another owner'); await assert.rejects(workflowCatalogFault(bindings, state));
  await writeFile(state, JSON.stringify(marker));
  await writeFile(fault.proof.after.command.path, '{}'); await assert.rejects(workflowCatalogFault(bindings, state));
  fault.status = 'restored'; assert.equal(await workflowCatalogFault(bindings, state), undefined);
});
