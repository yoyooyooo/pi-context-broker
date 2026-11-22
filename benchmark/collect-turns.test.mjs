import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fingerprint } from './protocol.mjs';
import { createTurnBridgeController } from './turn-bridge.mjs';
import { createFixtureTurnAdapter } from './fixture-turn-adapter.mjs';
import { readSubjectTurnControl } from './execute.mjs';
import { readTurnControlEvidence, collectTurnFacts } from './collect-turns.mjs';
import { collectEpisode } from './collect.mjs';
import { exampleProtocol } from './analysis/fixtures.mjs';
import { resolveEvidenceRef, verifyBundle } from './evidence/store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = path => readFile(path, 'utf8').then(JSON.parse);
async function save(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const bytes = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  await writeFile(path, bytes, { flag: 'wx', mode }); await chmod(path, mode);
  return { path, sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
}
const main = '# Retained apparatus Skill\nRead references/routing.json.\n';
const v1 = '{"version":1}\n', v2 = '{"version":2}\n';
const bridgeUrl = new URL('./turn-bridge.mjs', import.meta.url).href;
// This child is deliberately a no-model apparatus. Every tool body below is
// read from an owned file; truncation is an explicit negative delivery case.
const subjectSource = `
import {appendFile,readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {connectTurnBridge} from ${JSON.stringify(bridgeUrl)};
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const turns=config.turns,observed=[],snapshots=[],session='owned-collector-session-'+process.pid;
const events=join(config.runRoot,'benchmark/runtime/events.jsonl');
let sequence=0,bridge,status='completed';
const hash=b=>createHash('sha256').update(b).digest('hex');
const record=async(type,turn,data)=>{
 const row={version:1,sequence:++sequence,run_id:config.runId,episode_id:config.runId,candidate_id:'native',task_id:'c1',
 turn_id:turn?.id??null,type,monotonic_ns:String(sequence*1000000),data};
 await appendFile(events,JSON.stringify(row)+'\\n');return {artifact_id:'events',line:sequence};
};
await record('runtime_start',null,{cwd:join(config.runRoot,'workspace'),pid:process.pid,scope:'no-model-collector-apparatus'});
try {
 bridge=await connectTurnBridge(config);
 for(const turn of turns){
  await record('user_turn_start',turn,{id:turn.id,prompt:turn.prompt,...(config.omitKind?{}:{kind:turn.kind??'task'}),session_id:session});
  if(turn.id==='turn-2'&&!config.skipV2Read){
   const path=join(config.nativeRoot,'owned-skill/references/routing.json');
   const complete=await readFile(path,'utf8'),text=config.truncateV2Read?complete.slice(0,-2):complete;
   await record('session_event',turn,{type:'tool_execution_start',toolCallId:'read-v2',toolName:'read',args:{path}});
   await record('session_event',turn,{type:'tool_execution_end',toolCallId:'read-v2',toolName:'read',result:{content:[{type:'text',text}],structuredContent:text},isError:false});
  }
  const final=turn.id==='turn-1'?'Which delivery mode should I use?':'Read current routing.';
  const end=await record('user_turn_end',turn,{id:turn.id,settled:true,is_idle:true,session_id:session,final_text:final});
  const files=[];
  if(turn.id==='turn-2'){
   const text='{"answer":7}\\n',path=join(config.runRoot,'workspace/output/result.json');
   await mkdir(join(path,'..'),{recursive:true});await writeFile(path,text,{flag:'wx'});files.push({path:'output/result.json',sha256:hash(text)});
  }
  const content=JSON.stringify({files})+'\\n',snapshotPath=join(config.runRoot,'benchmark/runtime/workspace-'+turn.id+'.json');
  await writeFile(snapshotPath,content,{flag:'wx'});
  const artifact={id:'workspace-'+turn.id,path:snapshotPath,sha256:hash(content),bytes:Buffer.byteLength(content),kind:'json'};snapshots.push(artifact);
  observed.push({...turn,kind:turn.kind??'task',session_id:session,pid:process.pid,end_ref:end,workspace_manifest_ref:{artifact_id:artifact.id,sha256:artifact.sha256,pointer:''}});
  const ref=await record('controller_pause_start',turn,{turn_id:turn.id});
  await bridge.afterTurn({turn_id:turn.id,ref});
  await record('controller_pause_end',turn,{turn_id:turn.id});
 }
}catch(error){status='invalid';await record('runtime_error',null,{message:error.message});}
finally{
 const journal=await bridge?.close();
 if(journal)await writeFile(join(config.runRoot,'benchmark/turn-bridge/subject-result.json'),JSON.stringify(journal)+'\\n',{flag:'wx'});
 await writeFile(join(config.runRoot,'observed.json'),JSON.stringify({status,turns:observed,snapshots})+'\\n',{flag:'wx'});
}
`;

let fixtureNumber = 0;
async function fixture({ state = false, unknownWrite = false, omitKind = false, skipV2Read = false, truncateV2Read = false } = {}) {
  const retainedRoot = process.env.BENCHMARK_COLLECT_TURNS_PROOF_ROOT;
  const root = retainedRoot ? join(await realpath(retainedRoot), String(++fixtureNumber).padStart(2, '0'))
    : await realpath(await mkdtemp(join(tmpdir(), 'benchmark-collect-turns-')));
  await mkdir(root, { recursive: true });
  const runId = 'owned-collector-run', runRoot = join(root, 'runs', runId), controlRoot = join(root, 'control');
  const controllerRoot = join(controlRoot, 'turn-control', runId), fixtureRoot = join(controlRoot, 'fixture');
  const nativeRoot = join(runRoot, 'skills/native'), initialRoot = join(controlRoot, 'initial-skills');
  await mkdir(join(runRoot, 'benchmark/runtime'), { recursive: true }); await mkdir(join(runRoot, 'workspace'));
  await mkdir(controllerRoot, { recursive: true });
  const run = { run_id: runId, root: runRoot, pi_launch: { mode: 'native', native_corpus: { root: nativeRoot } } };
  const runRef = await save(join(runRoot, 'run.json'), run);
  const inventory = [];
  for (const [resource_path, content] of [['SKILL.md', main], ['references/routing.json', v1]])
    inventory.push({ ...await save(join(initialRoot, 'owned-skill', resource_path), content, 0o400),
      skill_id: 'routing', resource_path, mode: '100644' });
  await cp(initialRoot, nativeRoot, { recursive: true });
  const event = { id: 'policy-v2', before_turn: 'turn-2', kind: 'publish-version', skill_id: 'routing', version: 'v2' };
  const binding = { id: 'c1', skills_root: initialRoot, skill_inventory: inventory,
    public_case: { id: 'c1', title: 'No-model owned turn-collection apparatus', turns: [{ id: 'turn-1', kind: 'task', prompt: 'Read current routing.' },
      { id: 'turn-2', kind: 'task', prompt: 'Read current routing again.' }], completion: { paths: ['output/result.json'] } },
    events: state ? [event] : [], clarification: [{ topic_id: 'delivery-mode', max_questions: 1,
      response: '请使用普通配送。', expected_value: 'PRIVATE_EXPECTED_VALUE_MUST_NOT_ENTER_EVIDENCE' }] };
  let applyCalls = 0, versionFiles = [], adapter;
  if (state) {
    const plan = { schema_version: 1, kind: 'benchmark-controller-fixture', access: 'episode-owned', control_root: fixtureRoot,
      episode_id: runId, owned_runtime_root: runRoot, events: [event], private_marker: 'PRIVATE_FIXTURE_POLICY_MUST_NOT_ENTER_EVIDENCE' };
    plan.plan_sha256 = hash(JSON.stringify(plan));
    binding.fixture_control = await save(join(fixtureRoot, 'plan.json'), plan);
    const versionRoot = join(fixtureRoot, 'event-native-versions/v2');
    for (const [resource_path, content] of [['SKILL.md', main], ['references/routing.json', v2]])
      versionFiles.push({ ...await save(join(versionRoot, 'owned-skill', resource_path), content, 0o400),
        skill_id: 'routing', resource_path, mode: '100644', version: 'v2' });
    const rawReadback = await save(join(fixtureRoot, 'readbacks/raw.json'), { scope: 'synthetic-source-response-no-network', version: 2 });
    const readback = await save(join(fixtureRoot, 'readbacks/sealed.json'), { status: 'passed', rawEvidence: rawReadback,
      observed: { files: versionFiles.map(file => ({ path: file.resource_path, sha256: file.sha256, bytes: file.bytes, mode: file.mode })) } });
    adapter = await createFixtureTurnAdapter({ runRoot, runId, mode: 'native', binding, controllerRoot, operations: {
      apply: async () => {
        applyCalls++;
        await save(join(fixtureRoot, 'actual-owned-effect.json'), { version: 2 });
        if (unknownWrite) throw new Error('Lost acknowledgement after owned write');
        const value = { schema_version: 1, event_id: event.id, episode_id: runId, status: 'applied', effect_verified: true,
          effect_unknown: false, effect_evidence: [readback, rawReadback], native_version: { skill_root: versionRoot,
            target_name: 'owned-skill', files: versionFiles, readback, raw_readback: rawReadback } };
        return { ...value, receipt: await save(join(fixtureRoot, 'event-receipt.json'), value) };
      }, reconcile: async () => { throw new Error('No automatic replay'); }, attach: async () => { throw new Error('No Notion fault in native test'); },
    } });
  }
  const controller = await createTurnBridgeController({ runRoot, runId, episodeId: runId, controllerRoot,
    turns: binding.public_case.turns, events: binding.events, clarifications: binding.clarification,
    policy: { sentinel: 'PRIVATE_TURN_PLAN_MUST_NOT_ENTER_EVIDENCE' }, evidenceRoots: adapter?.evidenceRoots ?? [],
    limits: { wallMs: 10000, waitMs: 8000, eventMs: 2000, pollMs: 5 } });
  const config = await save(join(runRoot, 'subject-config.json'), { ...controller.publicConfig, turns: binding.public_case.turns,
    nativeRoot, omitKind, skipV2Read, truncateV2Read });
  const script = await save(join(root, 'subject.mjs'), subjectSource);
  const child = spawn(process.execPath, [script.path, config.path], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 12000);
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }).finally(() => clearTimeout(timeout));
  const result = await controller.serve({ subject: done, executeEvent: adapter?.executeEvent, reconcileEvent: adapter?.reconcileEvent,
    selectClarification: ({ turn }) => turn.id === 'turn-1' ? 'delivery-mode' : null });
  const exited = await done; assert.equal(exited.code, 0, stderr);
  const resultRef = await save(join(controllerRoot, 'result.json'), result);
  const verification = await readSubjectTurnControl({ controlRoot, runRoot, runId, required: true });
  assert.equal(verification.status, 'verified', JSON.stringify(verification));
  const observed = await readJson(join(runRoot, 'observed.json'));
  const eventPath = join(runRoot, 'benchmark/runtime/events.jsonl'), eventBytes = await readFile(eventPath);
  const eventArtifact = { id: 'events', path: eventPath, sha256: hash(eventBytes), bytes: eventBytes.length, kind: 'jsonl' };
  const turns = observed.turns.map(turn => ({ ...turn, end_ref: { ...turn.end_ref, sha256: eventArtifact.sha256 } }));
  const episode = { version: 1, status: observed.status, turns, requests: [], artifacts: [eventArtifact, ...observed.snapshots],
    correlation: { run_id: runId, episode_id: runId, candidate_id: 'native', task_id: 'c1' },
    admission: { status: 'accepted_before_task', refs: [] }, coverage: { attempts: 'complete', tools: 'complete', interventions: 'complete' },
    completion: { cleanup: { abort_settled: true, dispose_called: true } }, interventions: [], timing: { duration_ms: 30, started_monotonic_ns: '0' } };
  const raw = { root: runRoot, run_id: runId, episode, turn_control: { ...result, receipt: resultRef }, turn_control_verification: verification };
  const initialMaterials = inventory.map(file => ({ skill_id: file.skill_id, path: file.resource_path, actual_sha256: file.sha256,
    canonical_sha256: file.sha256, native_path: file.path, actual_source: file.path, identity: {}, refs: [] }));
  const snapshots = new Map(await Promise.all(observed.snapshots.map(async artifact => [artifact.id, { ref: { artifact_id: artifact.id, sha256: artifact.sha256, pointer: '' }, value: await readJson(artifact.path) }])));
  return { root, environmentRoot: root, runRoot, controlRoot, controllerRoot, fixtureRoot, runId, run, runRef, binding,
    raw, episode, eventBytes, eventArtifact, initialMaterials, versionFiles, applyCalls, resolveRef: ref => snapshots.get(ref.artifact_id) ?? null };
}
const inspect = (f, extra = {}) => readTurnControlEvidence({ ...f, ...extra });
const facts = async (f, turnControl = null) => collectTurnFacts({ ...f, turnControl: turnControl ?? await inspect(f) });

test('real owned IPC gives three same-session checkpoints and excludes every private plan', async () => {
  const f = await fixture(), result = await inspect(f);
  assert.equal(result.summary.verified_completed, true, result.summary.reason);
  assert.deepEqual(result.checkpoints.map(row => row.turn_id), ['turn-1', 'clarification-1', 'turn-2']);
  assert.equal(new Set(result.checkpoints.map(row => row.session_id)).size, 1);
  assert.equal(result.sources.length, 10); assert.deepEqual(result.problems, []);
  assert.ok(!result.sources.some(source => source.artifact.path.endsWith('/plan.json')));
  assert.ok(!result.sources.some(source => /PRIVATE_(TURN_PLAN|EXPECTED_VALUE|FIXTURE_POLICY)/.test(source.bytes.toString('utf8'))));
  const derived = await facts(f, result);
  assert.equal(derived.clarifications.length, 1); assert.equal(derived.clarifications[0].before_completion, true);
  assert.equal(derived.coverage.clarifications, 'partial'); assert.deepEqual(derived.problems, []);
});

test('a required controller cannot be inferred from missing verification or receipt', async () => {
  const f = await fixture();
  for (const verification of [undefined, { status: 'unavailable', required: true }, { status: 'verified', required: true }]) {
    const result = await inspect(f, { raw: { ...f.raw, turn_control_verification: verification } });
    assert.equal(result.summary.verified_completed, false); assert.equal(result.summary.status, 'unavailable');
    assert.ok(result.problems.includes('turn_control_evidence_unavailable'));
  }
});

test('actual unknown write is retained as stopped and never produces applied state facts', async () => {
  const f = await fixture({ state: true, unknownWrite: true }), result = await inspect(f);
  assert.equal(f.applyCalls, 1); assert.equal(result.summary.status, 'verified');
  assert.equal(result.summary.controller_status, 'stopped'); assert.equal(result.summary.verified_completed, false);
  assert.ok(result.problems.includes('turn_control_stopped'));
  assert.deepEqual((await facts(f, result)).state_events, []);
  assert.deepEqual(f.episode.turns.map(turn => turn.id), ['turn-1', 'clarification-1']);
});

test('lost launcher acknowledgement preserves completion evidence but prevents verified completion', async () => {
  const f = await fixture(), result = await inspect(f, { raw: { ...f.raw, dispatch_error: { message: 'Lost acknowledgement' } } });
  assert.equal(result.summary.status, 'verified'); assert.equal(result.summary.controller_status, 'completed');
  assert.equal(result.summary.verified_completed, false); assert.ok(result.problems.includes('subject_dispatch_error'));
});

test('terminal hash, caller identity, actual turn order, and runtime prefix tampering fail closed', async () => {
  const f = await fixture();
  const variants = [
    { raw: { ...f.raw, turn_control_verification: { ...f.raw.turn_control_verification, receipt: { ...f.raw.turn_control_verification.receipt, sha256: '0'.repeat(64) } } } },
    { raw: { ...f.raw, turn_control: { ...f.raw.turn_control, run_id: 'different-run' } } },
    { episode: { ...f.episode, turns: [...f.episode.turns].reverse() } },
  ];
  const changed = Buffer.from(f.eventBytes.toString('utf8').replace('Read current routing.', 'Changed public prompt.'));
  variants.push({ eventBytes: changed, eventArtifact: { ...f.eventArtifact, sha256: hash(changed), bytes: changed.length } });
  for (const variant of variants) {
    const result = await inspect(f, variant);
    assert.equal(result.summary.status, 'unavailable'); assert.equal(result.summary.verified_completed, false);
    assert.deepEqual(result.checkpoints, []);
  }
});

test('a modified public receipt is rejected even while private terminal and runtime prefixes remain intact', async () => {
  const f = await fixture(), path = join(f.runRoot, 'benchmark/turn-bridge/receipts/000001.json');
  const value = await readJson(path); value.continuation.prompt = 'Unapproved replacement text';
  await chmod(path, 0o600);
  await writeFile(path, JSON.stringify(value) + '\n');
  const result = await inspect(f); assert.equal(result.summary.verified_completed, false);
  assert.match(result.summary.reason, /TURN_CONTROL_RESPONSE_FILE_CHANGED/);
});

test('a continuation decision without actual runtime kind is not clarification delivery proof', async () => {
  const f = await fixture({ omitKind: true }), result = await inspect(f), derived = await facts(f, result);
  assert.equal(result.summary.verified_completed, true); assert.equal(derived.clarifications.length, 0);
  assert.ok(derived.limitations.some(reason => /actual runtime kind/.test(reason)));
});

test('native v2 mapping requires full readback and installed bytes, and reuses an existing owner artifact ID', async () => {
  const f = await fixture({ state: true });
  const result = await inspect(f, { knownArtifacts: [{ id: 'existing-run', ...f.runRef, kind: 'json' }] });
  const derived = await facts(f, result);
  assert.deepEqual(derived.problems, [], derived.limitations.join('\n'));
  assert.equal(derived.state_events[0].status, 'applied'); assert.equal(derived.coverage.state_events, 'complete');
  assert.equal(derived.material_rows.length, 2);
  const resource = derived.material_rows.find(row => row.path === 'references/routing.json');
  assert.equal(resource.actual_sha256, hash(v2)); assert.equal(resource.canonical_sha256, hash(v2));
  assert.equal(resource.available_from_turn_id, 'turn-2'); assert.equal(resource.version, 'v2');
  assert.ok(resource.refs.some(ref => ref.artifact_id === 'existing-run'));
  assert.ok(!result.sources.some(source => source.artifact.path.endsWith('/plan.json')));
  assert.equal(derived.state_events[0].agent_consumption, 'not inferred from the state readback');
  const registry = [...new Map([...f.episode.artifacts, { id: 'existing-run', ...f.runRef, kind: 'json' },
    ...result.sources.map(source => source.artifact)].map(artifact => [artifact.id, artifact])).values()];
  const references = [...result.summary.refs, ...derived.evidence_refs.values()].flat()
    .concat(derived.material_rows.flatMap(row => row.refs));
  for (const ref of references) await resolveEvidenceRef(ref, registry, { root: f.root });
  assert.ok(references.length > 30);
});

test('post-installation source drift makes the version unknown instead of reusing an expected hash', async () => {
  const f = await fixture({ state: true }), result = await inspect(f);
  const file = f.versionFiles.find(file => file.resource_path === 'references/routing.json');
  await chmod(file.path, 0o600); await writeFile(file.path, '{"version":999}\n');
  const derived = await facts(f, result);
  assert.equal(derived.state_events[0].status, 'unknown'); assert.equal(derived.coverage.state_events, 'partial');
  assert.equal(derived.material_rows.length, 0); assert.ok(derived.problems.includes('turn_event_readback_unavailable'));
});

async function collect(f) {
  const oracle = { schema_version: 1, case_id: 'c1', capability_scope: 'common', required_capabilities: ['workspace-files'], contracts: [
    { id: 'deliverable', kind: 'artifact-json', path: 'output/result.json', comparison: 'exact', expected: { answer: 7 }, critical: true },
  ] };
  const oracleRef = await save(join(f.controlRoot, 'oracle.json'), oracle);
  const adapter = await save(join(f.controlRoot, 'adapter.json'), { scope: 'no-model-test-adapter', status: 'passed' });
  const p = exampleProtocol({ cases: [{ id: 'c1', family: 'unit', material_id: 'material', cluster_id: 'cluster', split: 'development', contract_sha256: fingerprint(oracle) }] });
  p.corpus.content_sha256 = 'a'.repeat(64);
  p.corpus.capabilities = [{ id: 'workspace-files', scope: 'common', environment_ids: p.conditions.map(condition => condition.environment_id) }];
  const model = { id: 'model', provider: 'apparatus', route: 'no-model', api: 'openai-completions', parameters: {},
    adapter: { id: 'apparatus', version: '1', verification: 'verified', evidence_sha256: adapter.sha256 } };
  p.models = [model]; for (const condition of p.conditions) condition.environment_sha256 = 'b'.repeat(64);
  p.protocol_sha256 = fingerprint({ ...p, protocol_sha256: null });
  const condition = p.conditions[0], shared = { run_id: f.runId, root: f.runRoot, build_id: 'no-model-apparatus',
    status: 'passed', exit_code: 0, signal: null, timed_out: false, spawned: true, runtime_check: { status: 'unchanged' }, frozen_artifacts: 'passed' };
  await save(join(f.runRoot, 'result.json'), shared);
  const trace = []; let previous = null;
  for (const fields of [{ phase: 'transport_start' }, { phase: 'transport_end', attempts: 0, errors: 0, incompleteRequestIds: [], pendingForkRebind: false, complete: true }]) {
    const row = { version: 1, sequence: trace.length + 1, previousSha256: previous, clockId: f.runId, monotonicNs: String(trace.length + 1), ...fields };
    row.eventSha256 = hash(JSON.stringify(row)); previous = row.eventSha256; trace.push(row);
  }
  const transport = { id: 'transport', ...await save(join(f.runRoot, 'transport.jsonl'), trace.map(JSON.stringify).join('\n') + '\n'), kind: 'jsonl' };
  const episode = { ...f.episode, correlation: { ...f.episode.correlation, candidate_id: condition.id }, artifacts: [...f.episode.artifacts, transport] };
  const episodeRef = await save(join(f.runRoot, 'benchmark/runtime/episode-result.json'), episode);
  return collectEpisode({ raw: { ...f.raw, episode, shared, result_path: episodeRef.path },
    binding: { ...f.binding, oracle_path: oracleRef.path, oracle_sha256: oracleRef.sha256, protocol_case: p.corpus.cases[0] },
    protocol: p, slot: { slot_id: 'unit-slot', pair_id: 'c1-r0', case_id: 'c1', condition_id: condition.id, repeat: 0, seed: 0 },
    condition, model: { ...model, adapter_evidence_path: adapter.path }, environmentRoot: f.root, outputDirectory: join(f.controlRoot, 'collected') });
}

test('full collector requires actual complete tool delivery before claiming v2 consumption', async () => {
  for (const delivery of ['complete', 'absent', 'truncated']) {
    const f = await fixture({ state: true, skipV2Read: delivery === 'absent', truncateV2Read: delivery === 'truncated' });
    const result = await collect(f);
    assert.equal((await verifyBundle(result.bundle, { root: f.root })).valid, true);
    assert.equal(result.readback.turn_control.verified_completed, true);
    assert.equal(result.readback.evidence.state_events[0].status, 'applied');
    const consumed = result.readback.evidence.resource_reads.filter(row => row.version === 'v2');
    assert.equal(consumed.length, delivery === 'complete' ? 1 : 0, delivery);
    if (delivery === 'complete') {
      assert.equal(consumed[0].actual_sha256, hash(v2)); assert.equal(consumed[0].turn_id, 'turn-2');
      assert.equal(consumed[0].tool_call_id, 'read-v2'); assert.equal(consumed[0].state_event_id, 'policy-v2');
      assert.equal(result.validity, 'valid', JSON.stringify(result.bundle.episode.admission));
    }
    assert.equal(result.budget_usage.model_requests, 0);
    assert.ok(!result.bundle.episode.artifacts.some(artifact => artifact.path.endsWith('/plan.json')));
  }
});
