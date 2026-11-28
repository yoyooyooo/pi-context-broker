import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runSubject, readSubjectTurnControl } from './execute.mjs';
import { createFixtureTurnAdapter } from './fixture-turn-adapter.mjs';
import { inventoryPublicInputs } from './subject.mjs';
import { readTurnBridgeJournal } from './turn-bridge.mjs';
import { executionImplementation } from './implementation.mjs';
import { collectEpisode } from './collect.mjs';
import { preflightCapacity } from '../scripts/paired-capacity.mjs';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => readFile(path, 'utf8').then(JSON.parse);
async function save(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const bytes = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  await writeFile(path, bytes, { flag: 'wx', mode }); await chmod(path, mode);
  return { path, sha256: sha(bytes), bytes: Buffer.byteLength(bytes) };
}
const runtimeSource = `
import {appendFile,readFile,readdir,stat,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
export async function runEpisode(config,hooks={}) {
  await mkdir(config.controlDir,{recursive:true});
  const events=join(config.controlDir,'events.jsonl'), observed=[], session='owned-apparatus-session-'+process.pid;
  let sequence=0,status='completed',error=null;
  const record=async(type,turn,data)=>{
    const row={version:1,sequence:++sequence,...config.correlation,turn_id:turn?.id??null,type,data};
    await appendFile(events,JSON.stringify(row)+'\\n');
    return {artifact_id:'events',line:sequence};
  };
  const native=join(config.runRoot,'skills/native/owned-skill');
  const tree=async()=> {
    const result=[];
    for(const path of (await readdir(native)).sort()){
      const bytes=await readFile(join(native,path));result.push({path,text:bytes.toString('utf8'),executable:Boolean((await stat(join(native,path))).mode&0o111)});
    }return result;
  };
  await record('runtime_start',null,{cwd:config.workspace,pid:process.pid,scope:'deterministic-no-model-apparatus'});
  try {
    for(const turn of config.turns){
      observed.push({id:turn.id,prompt:turn.prompt,pid:process.pid,session_id:session,files:await tree()});
      await record('user_turn_start',turn,{id:turn.id,session_id:session});
      await record('user_turn_end',turn,{id:turn.id,settled:true,is_idle:true,session_id:session,final_text:turn.id==='turn-1'?'请问配送方式？':'已读取当前文件。'});
      const ref=await record('controller_pause_start',turn,{turn_id:turn.id});
      if(hooks.afterTurn)await hooks.afterTurn({turn_id:turn.id,ref});
      await record('controller_pause_end',turn,{turn_id:turn.id});
    }
  }catch(e){status='invalid';error={code:e.code??null,message:e.message};await record('runtime_error',null,error);}
  const result={version:1,status,correlation:config.correlation,requests:[],turns:observed,timing:{duration_ms:0},budget:{model_requests:0},scope:'deterministic-no-model-apparatus',error};
  await writeFile(join(config.controlDir,'episode-result.json'),JSON.stringify(result,null,2)+'\\n',{flag:'wx'});
  return result;
}
`;
let sequence = 0;
async function fixture({ clarifications = true, kind = 'publish-version', malformed = false, unknownWrite = false, failLauncherAfterTerminal = false } = {}) {
  const base = process.env.BENCHMARK_TURN_INTEGRATION_ROOT;
  const root = base ? join(await realpath(base), String(++sequence).padStart(2, '0') + '-' + kind)
    : await realpath(await mkdtemp(join(tmpdir(), 'benchmark-turn-integration-')));
  await mkdir(root, { recursive: true });
  const runId = 'integration-' + randomUUID().slice(0, 8), runRoot = join(root, 'runs', runId), controlRoot = join(root, 'control');
  const buildRoot = join(root, 'builds/apparatus'), source = join(buildRoot, 'source/broker'), fixtureRoot = join(controlRoot, 'fixture');
  const copy = async path => { await mkdir(dirname(join(source, path)), { recursive: true }); await cp(join(repository, path), join(source, path)); };
  // Keep the real source dependency closure; substitute only the explicit no-model runtime.
  for (const file of (await executionImplementation()).files)
    if (file.path !== 'runtime/episode-runner.mjs') await copy(join('benchmark', file.path));
  await save(join(source, 'benchmark/runtime/episode-runner.mjs'), runtimeSource);
  // The apparatus replaces the runtime, so these declared bytes only exercise
  // projection provenance. The real reference implementation is checked separately.
  const sdkBytes = 'apparatus-only-sdk', refBytes = 'apparatus-only-ref';
  await save(join(buildRoot, 'cli/dist/sdk.js'), sdkBytes);
  await save(join(buildRoot, 'cli/dist/ref.cjs'), refBytes);
  await save(join(buildRoot, 'broker/dist/ntn-skills-sdk.mjs'), sdkBytes);
  await save(join(buildRoot, 'broker/dist/ntn-skills-ref.cjs'), refBytes);
  await save(join(buildRoot, 'broker/dist/ntn-skills-runtime.json'), { version: 1, package: 'ntn-skills', sdk_version: 3,
    skill_ref_version: 2, sdk_sha256: sha(sdkBytes), ref_sha256: sha(refBytes) });
  const skillRoot = join(controlRoot, 'initial-skills'), initial = [
    { resource_path: 'SKILL.md', content: '---\nname: owned-skill\ndescription: Controlled apparatus\n---\nVersion one.\n', mode: '100644' },
    { resource_path: 'routing.json', content: '{"version":1}\n', mode: '100644' },
    { resource_path: 'stale.txt', content: 'Removed in the full second tree.\n', mode: '100644' },
  ];
  const skillInventory = [];
  for (const file of initial) skillInventory.push({ ...await save(join(skillRoot, 'owned-skill', file.resource_path), file.content, 0o400),
    skill_id: 'routing', resource_path: file.resource_path, mode: file.mode });
  const inputRoot = join(controlRoot, 'inputs'); await save(join(inputRoot, 'input/task.json'), { task: 'apparatus' });
  const event = { id: 'policy-v2', before_turn: 'turn-2', kind, skill_id: 'routing', ...(kind === 'publish-version' ? { version: 'v2' } : { mode: 'store-unavailable' }) };
  const privatePlan = { schema_version: 1, kind: 'benchmark-controller-fixture', access: 'episode-owned', control_root: fixtureRoot,
    episode_id: runId, owned_runtime_root: runRoot, events: [{ ...event, logical_operation: { skill_id: 'routing', path: 'routing.json', intent: kind } }],
    private_marker: 'PRIVATE_FIXTURE_POLICY_83627' };
  privatePlan.plan_sha256 = sha(JSON.stringify(privatePlan));
  const fixtureRef = await save(join(fixtureRoot, 'plan.json'), privatePlan);
  const binding = { id: 'controller-apparatus', input_root: inputRoot, input_inventory_sha256: sha(JSON.stringify(await inventoryPublicInputs(inputRoot))),
    skills_root: skillRoot, skill_inventory: skillInventory, events: [event], fixture_control: { path: fixtureRef.path, sha256: fixtureRef.sha256 },
    public_case: { turns: [{ id: 'turn-1', prompt: 'Read current routing.' }, { id: 'turn-2', prompt: 'Read current routing again.' }] },
    clarification: clarifications ? [{ topic_id: 'delivery-mode', max_questions: 1, response: '请使用普通配送。', expected_value: 'PRIVATE_EXPECTED_VALUE_83627' }] : [] };
  const versionRoot = join(fixtureRoot, 'event-native-versions/v2'), versionFiles = [];
  for (const file of [
    { resource_path: 'SKILL.md', content: '---\nname: owned-skill\ndescription: Controlled apparatus\n---\nVersion two.\n', mode: '100644' },
    { resource_path: 'routing.json', content: '{"version":2}\n', mode: '100644' },
    { resource_path: 'run.sh', content: '#!/bin/sh\nprintf controlled\n', mode: '100755' },
  ]) versionFiles.push({ ...await save(join(versionRoot, 'owned-skill', file.resource_path), file.content, file.mode === '100755' ? 0o500 : 0o400),
    skill_id: 'routing', resource_path: file.resource_path, mode: file.mode, version: 'v2' });
  if (malformed) await save(join(versionRoot, 'owned-skill/unlisted.txt'), 'Unlisted source bytes.\n');
  const rawReadback = await save(join(fixtureRoot, 'readbacks/raw.json'), { scope: 'synthetic-source-response-apparatus-not-notion', version: 2 });
  const readback = await save(join(fixtureRoot, 'readbacks/receipt.json'), { status: 'passed', observed: { files: versionFiles.map(file => ({
    path: file.resource_path, sha256: file.sha256, bytes: file.bytes, mode: file.mode,
  })) }, rawEvidence: rawReadback });
  let applyCalls = 0, reconcileCalls = 0, childCalls = 0;
  const operations = {
    async apply() {
      applyCalls++; await save(join(fixtureRoot, 'actual-effect-' + applyCalls + '.json'), { version: 2 });
      if (unknownWrite) throw new Error('Acknowledgement lost after the owned effect');
      const value = { schema_version: 1, status: 'applied', event_id: event.id, episode_id: runId, effect_unknown: false,
        effect_verified: true, effect_evidence: [readback, rawReadback], native_version: {
          skill_root: versionRoot, target_name: 'owned-skill', files: versionFiles, readback, raw_readback: rawReadback,
        } };
      return { ...value, receipt: await save(join(fixtureRoot, 'event-receipt.json'), value) };
    },
    async reconcile() { reconcileCalls++; throw new Error('No invented reconciliation proof'); },
    async attach() { throw new Error('Native fixture must not attach a Notion Store fault'); },
  };
  const launch = async shared => {
    childCalls++;
    assert.equal(shared['command-source'], 'none');
    await mkdir(join(runRoot, 'workspace'), { recursive: true }); await mkdir(join(runRoot, 'pi-agent'));
    await save(join(source, 'corpus/oracle.json'), { sentinel: 'PRIVATE_ORACLE_83627' });
    await mkdir(join(runRoot, 'skills'), { recursive: true }); await cp(skillRoot, join(runRoot, 'skills/native'), { recursive: true });
    const run = { run_id: runId, root: runRoot, build_root: buildRoot, paths: {}, command_source: 'none',
      pi_launch: { mode: 'native', native_corpus: { root: join(runRoot, 'skills/native') } } };
    for (const key of ['NTN_SKILLS_HOME', 'NTN_SKILLS_CONFIG_HOME', 'NTN_SKILLS_CACHE_HOME', 'NTN_SKILLS_DATA_HOME']) {
      run.paths[key] = join(runRoot, key); await mkdir(run.paths[key]);
    }
    await save(join(runRoot, 'run.json'), run);
    const childEnv = { ...process.env, PAIRED_RUN_ROOT: runRoot, PAIRED_BUILD_ROOT: buildRoot };
    for (const name of ['PAIRED_CLI_SOURCE', 'PAIRED_BROKER_SOURCE', 'CONTEXT_BROKER_GRAPH_CORE', 'NTN_SKILLS_BUILD_ENTRY']) delete childEnv[name];
    const child = spawn(process.execPath, shared.args.slice(1), { cwd: join(runRoot, 'workspace'), env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    const terminal = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timeout));
    const result = { run_id: runId, root: runRoot, status: terminal.code === 0 ? 'passed' : 'failed', exit_code: terminal.code,
      signal: terminal.signal, runtime_check: { status: 'unchanged' }, frozen_artifacts: 'passed',
      scope: 'owned-process-apparatus-launcher', stdout, stderr };
    await save(join(runRoot, 'result.json'), result);
    if (failLauncherAfterTerminal) throw new Error('Controller lost launcher acknowledgement after actual terminal');
    return result;
  };
  const models = await save(join(controlRoot, 'models.json'), { synthetic: true }), expected = await save(join(controlRoot, 'expected.json'), { synthetic: true });
  const options = { environmentRoot: root, buildId: 'apparatus', mode: 'native', binding, model: { provider: 'apparatus', id: 'no-model',
    api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', parameters: { maxTokens: 64, thinkingLevel: 'off' } },
    modelsFile: models.path, runtime: {}, controlRoot, runId, conditionId: 'apparatus-native',
    budget: { max_duration_ms: 5000, max_model_requests: 0, max_http_attempts: 0, max_input_tokens: 0, max_output_tokens: 0 },
    expected, credential: { source_file: '/apparatus-no-credentials-read', provider: 'apparatus', api_key_env: 'BENCHMARK_TURN_TEST_KEY' } };
  return { root, runRoot, controlRoot, fixtureRoot, runId, binding, event, options, operations,
    deps: { runEnvironment: launch, fixtureOperations: operations, resolveModelCredential: async () => ({}),
      verifyTurnRuntimeBuild: async () => ({ version: 1, required: true, status: 'apparatus_only',
        scope: 'deterministic no-model runtime substitute; does not certify a production build' }) },
    counts: () => ({ apply: applyCalls, reconcile: reconcileCalls, child: childCalls }) };
}
async function run(f) {
  const result = await runSubject(f.options, f.deps);
  await save(join(f.root, 'apparatus-proof.json'), { kind: 'owned-real-process-turn-integration', scope: 'no-model-no-remote',
    result, counts: f.counts(), source_sha256: Object.fromEntries(await Promise.all([
      'benchmark/execute.mjs', 'benchmark/subject.mjs', 'benchmark/turn-bridge.mjs', 'benchmark/fixture-turn-adapter.mjs',
    ].map(async path => [path, sha(await readFile(join(repository, path)))]))) });
  return result;
}
async function textFiles(root) {
  const output = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) output.push(...await textFiles(path)); else if (item.isFile()) output.push(await readFile(path, 'utf8'));
  } return output;
}

test('runSubject launches a real isolated child; clarification and complete native replacement preserve one session', async () => {
  const f = await fixture(), result = await run(f);
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.stop_batch, false);
  assert.equal(Object.hasOwn(result, 'dispatch_diagnostic'), false);
  await assert.rejects(lstat(join(f.controlRoot, f.runId + '.dispatch-error.json')), { code: 'ENOENT' });
  assert.equal(result.turn_control.status, 'completed'); assert.deepEqual(f.counts(), { apply: 1, reconcile: 0, child: 1 });
  assert.deepEqual(result.episode.turns.map(turn => turn.id), ['turn-1', 'clarification-1', 'turn-2']);
  assert.equal(new Set(result.episode.turns.map(turn => turn.session_id)).size, 1); assert.equal(new Set(result.episode.turns.map(turn => turn.pid)).size, 1);
  assert.ok(result.episode.turns[0].files.some(file => file.path === 'stale.txt'));
  assert.ok(result.episode.turns[1].files.some(file => file.path === 'stale.txt'));
  assert.ok(!result.episode.turns[2].files.some(file => file.path === 'stale.txt'));
  assert.equal(result.episode.turns[2].files.find(file => file.path === 'run.sh').executable, true);
  assert.equal(result.episode.requests.length, 0);
  const launch = await json(join(f.controlRoot, f.runId + '.launch.json'));
  assert.deepEqual(Object.keys(launch.turn_bridge).sort(), ['episodeId', 'limits', 'runId', 'runRoot']);
  const publicText = (await textFiles(f.runRoot)).join('\n');
  for (const marker of ['PRIVATE_FIXTURE_POLICY_83627', 'PRIVATE_EXPECTED_VALUE_83627', 'PRIVATE_ORACLE_83627']) assert.ok(!publicText.includes(marker));
  const visibility = await json(join(f.runRoot, 'subject-visibility.json'));
  assert.equal(visibility.source_disposition, 'not_copied'); assert.equal(visibility.command_source, 'none');
  assert.equal(visibility.source_moved_outside_run, false);
  await assert.rejects(lstat(join(f.runRoot, 'source')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.controlRoot, 'controller-sources')), { code: 'ENOENT' });
  assert.ok(visibility.files.some(file => file.path === 'benchmark/turn-bridge.mjs'));
  assert.ok(visibility.files.some(file => file.path === 'benchmark/reported-model.mjs'));
  assert.ok(!visibility.files.some(file => /fixture|corpus|grader/.test(file.path)));
  const terminal = await json(join(f.controlRoot, 'turn-control', f.runId, 'fixture-adapter/policy-v2/receipt.json'));
  const installation = await json(terminal.native_installation.path);
  assert.equal(installation.before_retained.length, 3); assert.equal(installation.after.length, 3);
  assert.deepEqual(installation.before, installation.before_retained);
  assert.equal(installation.after.find(file => file.path === 'run.sh').mode, '100755');
  await readTurnBridgeJournal(result.turn_control.journal.path);
  const restored = await readSubjectTurnControl({ controlRoot: f.controlRoot, runRoot: f.runRoot, runId: f.runId, required: true });
  assert.equal(restored.status, 'verified'); assert.equal(restored.result.status, 'completed');
  assert.deepEqual({ path: restored.receipt.path, sha256: restored.receipt.sha256 }, result.turn_control.receipt);
});

test('unknown write stops the child and preserves both actual terminal and cost substrate without replay', async () => {
  const f = await fixture({ clarifications: false, unknownWrite: true }), result = await run(f);
  assert.equal(result.stop_batch, true); assert.equal(result.turn_control.status, 'stopped');
  assert.equal(result.episode.turns.length, 1); assert.equal(result.episode.requests.length, 0);
  assert.equal(result.shared.exit_code, 1); assert.ok(await readFile(join(f.runRoot, 'result.json')));
  const adapter = await createFixtureTurnAdapter({ runRoot: f.runRoot, runId: f.runId, mode: 'native', binding: f.binding,
    controllerRoot: join(f.controlRoot, 'turn-control', f.runId), operations: f.operations });
  const again = await adapter.executeEvent({ event: f.event, eventId: f.event.id, episodeId: f.runId });
  assert.equal(again.status, 'unknown'); assert.deepEqual(f.counts(), { apply: 1, reconcile: 0, child: 1 });
  const restored = await readSubjectTurnControl({ controlRoot: f.controlRoot, runRoot: f.runRoot, runId: f.runId, required: true });
  assert.equal(restored.status, 'verified'); assert.equal(restored.result.status, 'stopped');
});

test('ordinary Broker dispatch selects the current Library argument in the shared launcher', async () => {
  const f = await fixture({ clarifications: false });
  f.binding.events = []; f.options.mode = 'broker'; f.options.notionEntry = '4215636c-236e-81e8-8168-ee2ac696f73a';
  const launch = f.deps.runEnvironment;
  let selected = false;
  f.deps.runEnvironment = async options => {
    assert.equal(options.library, f.options.notionEntry); assert.equal(options.entry, undefined);
    selected = true; return launch(options);
  };
  const result = await run(f);
  assert.equal(selected, true); assert.equal(result.status, 'completed'); assert.equal(result.episode.requests.length, 0);
});

test('Notion Store fault has no native counterpart and is blocked before any mutation', async () => {
  const f = await fixture({ clarifications: false, kind: 'fault' }), result = await run(f);
  assert.equal(result.stop_batch, true); assert.equal(result.episode.turns.length, 1);
  assert.deepEqual(f.counts(), { apply: 0, reconcile: 0, child: 1 });
  const receipt = await json(join(f.controlRoot, 'turn-control', f.runId, 'fixture-adapter/policy-v2/receipt.json'));
  assert.equal(receipt.status, 'blocked'); assert.equal(receipt.capability_scope, 'unsupported_native'); assert.equal(receipt.dispatched, false);
});

test('an unlisted native file invalidates the proposed full tree and cannot be delivered to turn two', async () => {
  const f = await fixture({ clarifications: false, malformed: true }), result = await run(f);
  assert.equal(result.stop_batch, true); assert.equal(result.episode.turns.length, 1);
  assert.ok((await readFile(join(f.runRoot, 'skills/native/owned-skill/routing.json'), 'utf8')).includes(':1'));
});

test('launcher acknowledgement failure retains actual child result and metering and stops further dispatch', async () => {
  const f = await fixture({ failLauncherAfterTerminal: true }), result = await run(f);
  assert.equal(result.episode.status, 'completed'); assert.equal(result.episode.turns.length, 3);
  assert.equal(result.episode.requests.length, 0); assert.equal(result.shared.exit_code, 0);
  assert.equal(result.stop_batch, true); assert.match(result.dispatch_error.message, /acknowledgement/);
  assert.equal(result.dispatch_diagnostic.status, 'retained');
  const retained = await json(result.dispatch_diagnostic.receipt.path);
  assert.equal(retained.error.message, result.dispatch_error.message);
  assert.equal(Object.hasOwn(retained.error, 'capacity'), false);
});

test('controller recovery cannot infer success from a missing or changed private receipt', async () => {
  const f = await fixture(), result = await run(f);
  const missing = await readSubjectTurnControl({ controlRoot: f.controlRoot, runRoot: f.runRoot, runId: 'missing-run', required: true });
  assert.equal(missing.status, 'unavailable'); assert.equal(missing.required, true);
  const legacy = await readSubjectTurnControl({ controlRoot: f.controlRoot, runRoot: f.runRoot, runId: 'historical-single-turn' });
  assert.equal(legacy.status, 'absent'); assert.equal(legacy.required, false);
  const journal = result.turn_control.journal.path;
  await writeFile(journal, (await readFile(journal, 'utf8')).replace('controller_end', 'changed_terminal'));
  const changed = await readSubjectTurnControl({ controlRoot: f.controlRoot, runRoot: f.runRoot, runId: f.runId, required: true });
  assert.equal(changed.status, 'unavailable'); assert.match(changed.reason, /JOURNAL_CHANGED/);
  assert.equal((await json(join(f.runRoot, 'benchmark/runtime/episode-result.json'))).requests.length, 0);
});


// These fixtures stop at the existing dispatch boundary. No product build,
// provider, Source, fixture turn adapter or real credentials are needed.
async function dispatchFailureFixture(t, { outsideControl = false } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-dispatch-error-')));
  const root = join(base, 'environment'); await mkdir(root);
  const runId = 'dispatch-' + randomUUID().slice(0, 8), runRoot = join(root, 'runs', runId);
  const controlRoot = join(outsideControl ? base : root, 'control');
  const expected = await save(join(controlRoot, 'expectation.json'), { scope: 'no-model-dispatch-fixture' });
  const options = { environmentRoot: root, buildId: 'fixture-build', mode: 'native',
    binding: { id: 'dispatch-fixture', input_root: join(root, 'input-not-read'), input_inventory_sha256: '1'.repeat(64),
      skills_root: join(root, 'skills-not-read'), public_case: { turns: [{ id: 'turn-1', prompt: 'Local fixture.' }] } },
    model: { provider: 'apparatus', id: 'no-model', api: 'openai-completions', parameters: {} },
    modelsFile: join(controlRoot, 'models-not-read.json'), runtime: {}, controlRoot, runId, conditionId: 'fixture',
    expected, budget: { max_duration_ms: 1000, max_model_requests: 0, max_http_attempts: 0,
      max_input_tokens: 0, max_output_tokens: 0 },
    credential: { source_file: '/not-read', provider: 'apparatus', api_key_env: 'DISPATCH_ERROR_TEST_KEY' } };
  const deps = { resolveModelCredential: async () => ({}),
    verifyTurnRuntimeBuild: async () => ({ status: 'apparatus_only', required: true }) };
  const diagnosticPath = join(controlRoot, runId + '.dispatch-error.json');
  t.diagnostic('Owned no-model fixture retained: ' + base);
  return { base, root, runRoot, controlRoot, runId, options, deps, diagnosticPath };
}

async function failedDispatch(f, failure, t) {
  const lines = [], stderr = t.mock.method(process.stderr, 'write', chunk => { lines.push(String(chunk)); return true; });
  let calls = 0, result;
  try { result = await runSubject(f.options, { ...f.deps, runEnvironment: async options => { calls++; return failure(options); } }); }
  finally { stderr.mock.restore(); }
  assert.equal(calls, 1, 'Diagnostic retention never retries a dispatch');
  return { result, stderr: lines.join('') };
}

const ordinaryDispatchError = () => Object.assign(new Error('original local dispatch failure'), {
  code: 'EAPPARATUS', unrelated: 'PRIVATE_PROPERTY_MUST_NOT_BE_SERIALIZED' });

function assertUnknownDispatch(result) {
  assert.equal(result.status, 'invalid'); assert.equal(result.episode, null); assert.equal(result.shared, null);
  assert.equal(result.stop_batch, true);
  assert.match(result.error, /actual request\/cost status remains unknown/);
  for (const name of ['budget_usage', 'requests', 'input_tokens', 'output_tokens', 'terminal_disposition', 'zero_send'])
    assert.equal(Object.hasOwn(result, name), false, 'Diagnostic does not create ' + name);
}

test('dispatch failure retains a real typed capacity refusal before collector realpath can mask it', async t => {
  const f = await dispatchFailureFixture(t);
  await save(join(f.root, 'capacity-policy.json'), { version: 1, min_free_bytes: Number.MAX_SAFE_INTEGER });
  let original;
  const { result, stderr } = await failedDispatch(f, async () => {
    try { await preflightCapacity({ root: f.root }, 'run-preparation', { known_copy_bytes: 0, unknown: [] }, f.runRoot); }
    catch (error) { original = error; throw error; }
    assert.fail('The fixture policy must refuse before creating a run directory');
  }, t);
  assert.equal(original.code, 'PAIRED_CAPACITY_REFUSED'); assertUnknownDispatch(result);
  assert.deepEqual(result.dispatch_error, { name: original.name, message: original.message }, 'Legacy raw error shape remains unchanged');
  await assert.rejects(lstat(f.runRoot), { code: 'ENOENT' });
  const bytes = await readFile(f.diagnosticPath), receipt = JSON.parse(bytes);
  assert.equal(receipt.version, 1); assert.equal(receipt.kind, 'benchmark-subject-dispatch-error');
  assert.equal(receipt.stage, 'runEnvironment'); assert.equal(receipt.run_id, f.runId);
  assert.equal(receipt.environment_root, f.root); assert.equal(receipt.build_id, f.options.buildId);
  assert.equal(receipt.error.code, original.code); assert.deepEqual(receipt.error.capacity, original.capacity);
  assert.equal(receipt.error.name, original.name); assert.equal(receipt.error.message, original.message);
  assert.match(receipt.observed_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  const launchPath = join(f.controlRoot, f.runId + '.launch.json'), launchBytes = await readFile(launchPath);
  assert.deepEqual(receipt.launch, { path: launchPath, sha256: sha(launchBytes), bytes: launchBytes.length });
  assert.deepEqual(receipt.expected, { path: f.options.expected.path, sha256: f.options.expected.sha256 });
  assert.equal(receipt.resource_profile, null); assert.match(receipt.scope, /diagnostic/);
  const info = await stat(f.diagnosticPath);
  assert.equal(info.mode & 0o777, 0o600); if (process.getuid) assert.equal(info.uid, process.getuid());
  assert.deepEqual(result.dispatch_diagnostic, { status: 'retained', receipt: { path: f.diagnosticPath, sha256: sha(bytes), bytes: bytes.length } });
  assert.equal(stderr, '');
  await assert.rejects(collectEpisode({ raw: result, environmentRoot: f.root,
    outputDirectory: join(f.runRoot, 'benchmark/normalized') }), error => error.code === 'ENOENT' && error.syscall === 'realpath');
  assert.deepEqual(await readFile(f.diagnosticPath), bytes, 'The downstream error cannot erase the retained original');
  await assert.rejects(lstat(f.runRoot), { code: 'ENOENT' });
});

test('dispatch failure retains ordinary errors without adding capacity or arbitrary properties', async t => {
  const f = await dispatchFailureFixture(t), error = ordinaryDispatchError();
  error.capacity = { untrusted: true };
  const { result, stderr } = await failedDispatch(f, async () => { throw error; }, t);
  const receipt = await json(f.diagnosticPath); assertUnknownDispatch(result);
  assert.deepEqual(receipt.error, { name: error.name, message: error.message, code: error.code });
  assert.deepEqual(result.dispatch_error, { name: error.name, message: error.message });
  assert.ok(!(await readFile(f.diagnosticPath, 'utf8')).includes(error.unrelated)); assert.equal(stderr, '');
});

test('dispatch failure never overwrites an existing diagnostic or follows its symlink', async t => {
  for (const kind of ['file', 'partial', 'symlink']) await t.test(kind, async t => {
    const f = await dispatchFailureFixture(t), original = ordinaryDispatchError();
    const first = kind === 'partial' ? '{"version":' : 'first owned evidence\n';
    const target = kind === 'symlink' ? join(f.base, 'untouched-target.json') : f.diagnosticPath;
    await writeFile(target, first, { flag: 'wx', mode: 0o600 });
    if (kind === 'symlink') await symlink(target, f.diagnosticPath);
    const { result, stderr } = await failedDispatch(f, async () => { throw original; }, t);
    assertUnknownDispatch(result); assert.equal(result.dispatch_diagnostic.status, 'unavailable');
    assert.equal(result.dispatch_diagnostic.path, f.diagnosticPath); assert.equal(result.dispatch_diagnostic.error.code, 'EEXIST');
    assert.equal(Object.hasOwn(result.dispatch_diagnostic, 'receipt'), false);
    assert.equal(await readFile(target, 'utf8'), first);
    assert.match(stderr, /benchmark_dispatch_error_retention_failed/); assert.ok(stderr.includes(original.message));
    assert.match(stderr, /EEXIST/); assert.ok(!stderr.includes(original.unrelated));
    if (kind === 'symlink') assert.equal((await lstat(f.diagnosticPath)).isSymbolicLink(), true);
  });
});

test('dispatch failure refuses diagnostic output outside the owned environment', async t => {
  const f = await dispatchFailureFixture(t, { outsideControl: true }), original = ordinaryDispatchError();
  const { result, stderr } = await failedDispatch(f, async () => { throw original; }, t);
  assertUnknownDispatch(result); assert.equal(result.dispatch_diagnostic.status, 'unavailable');
  await assert.rejects(lstat(f.diagnosticPath), { code: 'ENOENT' });
  assert.match(result.dispatch_diagnostic.error.message, /DISPATCH_DIAGNOSTIC_CONTROL_ROOT/);
  assert.ok(stderr.includes(original.message)); assert.match(stderr, /DISPATCH_DIAGNOSTIC_CONTROL_ROOT/);
});


test('dispatch failure refuses a symlinked controller directory', async t => {
  const f = await dispatchFailureFixture(t), original = ordinaryDispatchError();
  const moved = join(f.root, 'real-control'); await rename(f.controlRoot, moved); await symlink(moved, f.controlRoot);
  const { result, stderr } = await failedDispatch(f, async () => { throw original; }, t);
  assertUnknownDispatch(result); assert.equal(result.dispatch_diagnostic.status, 'unavailable');
  await assert.rejects(lstat(f.diagnosticPath), { code: 'ENOENT' });
  assert.match(result.dispatch_diagnostic.error.message, /DISPATCH_DIAGNOSTIC_CONTROL_ROOT/);
  assert.ok(stderr.includes(original.message));
});

test('dispatch failure diagnostic write failure preserves a complete child and its original acknowledgement error', async t => {
  const f = await fixture({ failLauncherAfterTerminal: true });
  const path = join(f.controlRoot, f.runId + '.dispatch-error.json'), first = 'first evidence must survive\n';
  await writeFile(path, first, { flag: 'wx', mode: 0o600 });
  const lines = [], stderr = t.mock.method(process.stderr, 'write', chunk => { lines.push(String(chunk)); return true; });
  let result;
  try { result = await run(f); } finally { stderr.mock.restore(); }
  assert.equal(result.episode.status, 'completed'); assert.equal(result.episode.turns.length, 3);
  assert.equal(result.episode.requests.length, 0); assert.equal(result.shared.exit_code, 0);
  assert.equal(result.stop_batch, true); assert.match(result.dispatch_error.message, /acknowledgement/);
  assert.equal(result.dispatch_diagnostic.status, 'unavailable'); assert.equal(result.dispatch_diagnostic.error.code, 'EEXIST');
  assert.equal(await readFile(path, 'utf8'), first);
  assert.ok(lines.join('').includes(result.dispatch_error.message)); assert.match(lines.join(''), /EEXIST/);
  assert.deepEqual(await json(join(f.runRoot, 'benchmark/runtime/episode-result.json')), result.episode);
  assert.deepEqual(await json(join(f.runRoot, 'result.json')), result.shared);
  assert.equal(f.counts().child, 1, 'Retention failure does not repeat an already completed child');
});
