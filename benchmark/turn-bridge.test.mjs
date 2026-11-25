import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTurnBridgeController, readTurnBridgeJournal } from './turn-bridge.mjs';

const moduleUrl = new URL('./turn-bridge.mjs', import.meta.url).href;
const sha = value => createHash('sha256').update(value).digest('hex');
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
let number = 0;
async function setup(name, extra = {}) {
  let root;
  if (process.env.BENCHMARK_TURN_BRIDGE_PROOF_ROOT) {
    const base = await realpath(process.env.BENCHMARK_TURN_BRIDGE_PROOF_ROOT);
    root = join(base, String(++number).padStart(2, '0') + '-' + name); await mkdir(root);
  } else root = await mkdtemp(join(await realpath(tmpdir()), 'benchmark-turn-bridge-'));
  const runRoot = join(root, 'run'), controllerRoot = join(root, 'controller');
  await mkdir(join(runRoot, 'benchmark/runtime'), { recursive: true });
  await mkdir(join(runRoot, 'workspace'));
  await save(join(runRoot, 'run.json'), { run_id: 'owned-run' });
  await writeFile(join(runRoot, 'workspace/policy.txt'), 'v1\n');
  const config = { runRoot, controllerRoot, runId: 'owned-run', episodeId: 'owned-episode',
    turns: [{ id: 'turn-1', prompt: 'Inspect the current policy.' }, { id: 'turn-2', prompt: 'Inspect the policy again.' }],
    events: [{ id: 'policy-v2', before_turn: 'turn-2', kind: 'publish-version', skill_id: 'stable-skill', version: 'v2', private_marker: 'PRIVATE_EVENT_POLICY_DO_NOT_DELIVER' }],
    clarifications: [], limits: { wallMs: 15000, waitMs: 8000, eventMs: 2000, pollMs: 5 }, ...extra };
  return { root, config };
}
function child(file, args = []) {
  const process = spawn(globalThis.process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process.stdout.on('data', chunk => { stdout += chunk; }); process.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => { process.once('error', reject); process.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
  return { process, done };
}
const subjectSource = `
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectTurnBridge } from ${JSON.stringify(moduleUrl)};
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const turns = config.turns, observed = [], events = join(config.runRoot, 'benchmark/runtime/events.jsonl');
let sequence = 0, bridge;
const record = async (type, turn, data) => {
  const event = { version:1,sequence:++sequence,run_id:config.runId,episode_id:config.episodeId,turn_id:turn.id,type,data,monotonic_ns:process.hrtime.bigint().toString() };
  await appendFile(events,JSON.stringify(event)+'\\n',{mode:0o600});
  return {artifact_id:'events',line:sequence};
};
try {
  bridge = await connectTurnBridge(config);
  if(config.cancelAfterMs)setTimeout(()=>void bridge.close(),config.cancelAfterMs);
  for(const turn of turns) {
    const state = await readFile(join(config.runRoot,'workspace/policy.txt'),'utf8');
    observed.push({id:turn.id,prompt:turn.prompt,state,pid:process.pid});
    const final_text = turn.id==='turn-1'?'Which delivery mode should I use?':'Observed public turn complete.';
    await record('user_turn_end',turn,{id:turn.id,settled:true,is_idle:true,session_id:config.changeSession&&turn.id==='turn-2'?'changed-session':'same-owned-session',final_text});
    const ref = await record('controller_pause_start',turn,{turn_id:turn.id});
    await bridge.afterTurn({turn_id:turn.id,ref});
    if(config.duplicateFirst&&turn.id==='turn-1')await bridge.afterTurn({turn_id:turn.id,ref});
  }
}catch(error){process.exitCode=2;observed.push({stopped:error.code??error.message});}
finally{
  await bridge?.close();
  await writeFile(join(config.runRoot,'subject-observed.json'),JSON.stringify(observed,null,2)+'\\n',{flag:'wx'});
}
`;
async function launchSubject(fixture, extras = {}) {
  const file = join(fixture.root, 'subject.mjs'), publicConfig = join(fixture.config.runRoot, 'subject-config.json');
  await writeFile(file, subjectSource, { flag: 'wx' });
  const { runRoot, runId, episodeId, turns, limits } = fixture.config;
  await save(publicConfig, { runRoot, runId, episodeId, turns, limits, ...extras });
  return child(file, [publicConfig]);
}
async function receipt(config, eventId, status, suffix = '', extra = {}) {
  const file = join(config.controllerRoot, 'effect-' + eventId + suffix + '.json');
  const current = await readFile(join(config.runRoot, 'workspace/policy.txt'));
  await save(file, { version: 1, event_id: eventId, episode_id: config.episodeId, status,
    readback: { sha256: sha(current), bytes: current.length }, ...extra });
  return { status, event_id: eventId, logical_operation: 'stable-skill/SKILL.md', evidence_id: 'effect-' + eventId,
    receipt: { path: file, sha256: sha(await readFile(file)) } };
}
async function contents(root) {
  const result = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const file = join(root, item.name);
    if (item.isDirectory()) result.push(...await contents(file));
    else if (item.isFile()) result.push(await readFile(file, 'utf8'));
  }
  return result.join('\n');
}
async function retainProof(fixture, result, subjectResult, extra = {}) {
  const publicFiles = await contents(fixture.config.runRoot);
  assert.ok(!publicFiles.includes('PRIVATE_EVENT_POLICY_DO_NOT_DELIVER'));
  assert.ok(!publicFiles.includes('PRIVATE_EXPECTED_VALUE_DO_NOT_DELIVER'));
  await save(join(fixture.root, 'apparatus-proof.json'), { version: 1, kind: 'owned-real-process-turn-bridge-apparatus',
    scope: 'no-model-no-remote-fixture', runtime_module: { path: fileURLToPath(moduleUrl), sha256: sha(await readFile(fileURLToPath(moduleUrl))) },
    result, subject: subjectResult, ...extra });
}

test('unbounded turn exchange completes with real child, delayed event, and no implicit null deadlines', { timeout: 15000 }, async () => {
  const f = await setup('unbounded-exchange', { limits: { mode: 'unbounded', wallMs: null, waitMs: null, eventMs: null, pollMs: 5 } });
  const controller = await createTurnBridgeController(f.config), subject = await launchSubject(f);
  let writes = 0;
  const result = await controller.serve({ subject: subject.done, executeEvent: async ({ eventId }) => {
    await new Promise(resolve => setTimeout(resolve, 50)); writes++;
    await writeFile(join(f.config.runRoot, 'workspace/policy.txt'), 'v2\n'); return receipt(f.config, eventId, 'applied');
  } });
  const exited = await subject.done;
  assert.equal(result.status, 'completed'); assert.equal(exited.code, 0, exited.stderr); assert.equal(writes, 1);
  await retainProof(f, result, exited, { actual_fixture_writes: writes });
});

test('unbounded controller remains cancellable while waiting for the subject', { timeout: 15000 }, async () => {
  const f = await setup('unbounded-cancel', { events: [], limits: { mode: 'unbounded', wallMs: null, waitMs: null, eventMs: null, pollMs: 5 } });
  const controller = await createTurnBridgeController(f.config), abort = new AbortController();
  setTimeout(() => abort.abort(), 50);
  const result = await controller.serve({ subject: new Promise(() => {}), signal: abort.signal });
  assert.equal(result.status, 'stopped'); assert.equal(result.reason, 'TURN_BRIDGE_CANCELLED');
});

test('unbounded pending event cancels on subject exit and retains unknown effect without a resume', { timeout: 15000 }, async () => {
  const f = await setup('unbounded-event-cancel', { limits: { mode: 'unbounded', wallMs: null, waitMs: null, eventMs: null, pollMs: 5 } });
  const controller = await createTurnBridgeController(f.config), subject = await launchSubject(f, { cancelAfterMs: 100 });
  let cancelled = false;
  const result = await controller.serve({ subject: subject.done, executeEvent: ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => { cancelled = true; resolve({ status: 'unknown', effect_unknown: true }); }, { once: true });
  }) });
  const exited = await subject.done;
  assert.equal(exited.code, 2); assert.equal(result.status, 'stopped'); assert.equal(cancelled, true);
  const rows = await readTurnBridgeJournal(result.journal.path);
  assert.equal(rows.find(row => row.type === 'event_result').data.result.status, 'unknown');
  assert.equal(rows.some(row => row.type === 'checkpoint_decided' && row.data.response.action === 'continue'), false);
  await retainProof(f, result, exited, { actual_fixture_writes: 0 });
});

test('real child pauses, receives only frozen public clarification, then observes one verified update in the same session', { timeout: 15000 }, async () => {
  const f = await setup('multiturn', { clarifications: [{ topic_id: 'delivery-mode', max_questions: 1, response: '请使用普通配送。', expected_value: 'PRIVATE_EXPECTED_VALUE_DO_NOT_DELIVER' }] });
  const controller = await createTurnBridgeController(f.config), subject = await launchSubject(f, { duplicateFirst: true });
  let writes = 0;
  const result = await controller.serve({ subject: subject.done,
    selectClarification: ({ turn, observation }) => {
      if (turn.id === 'turn-1') { assert.match(observation.final_text, /delivery mode/); return 'delivery-mode'; } return null;
    },
    executeEvent: async ({ eventId }) => { writes++; await writeFile(join(f.config.runRoot, 'workspace/policy.txt'), 'v2\n'); return receipt(f.config, eventId, 'applied'); },
  });
  const exited = await subject.done;
  assert.equal(exited.code, 0, exited.stderr); assert.equal(result.status, 'completed'); assert.equal(result.completed_checkpoints, 3); assert.equal(writes, 1);
  const observed = JSON.parse(await readFile(join(f.config.runRoot, 'subject-observed.json'), 'utf8'));
  assert.deepEqual(observed.map(row => row.id), ['turn-1', 'clarification-1', 'turn-2']);
  assert.deepEqual(observed.map(row => row.state), ['v1\n', 'v1\n', 'v2\n']);
  assert.equal(new Set(observed.map(row => row.pid)).size, 1); assert.equal(observed[1].prompt, '请使用普通配送。');
  const log = await readTurnBridgeJournal(result.journal.path);
  assert.equal(log.filter(row => row.type === 'event_started').length, 1);
  assert.equal(log.filter(row => row.type === 'checkpoint_decided').length, 3);
  assert.ok(!(await readFile(controller.plan.path, 'utf8')).includes('expected_value'));
  await retainProof(f, result, exited, { actual_fixture_writes: writes, observed });
});

test('a write followed by lost acknowledgement stops; replay does not repeat the mutation', { timeout: 15000 }, async () => {
  const f = await setup('unknown-write'), controller = await createTurnBridgeController(f.config), subject = await launchSubject(f);
  let writes = 0;
  const result = await controller.serve({ subject: subject.done, executeEvent: async () => {
    writes++; await writeFile(join(f.config.runRoot, 'workspace/policy.txt'), 'v2\n'); throw new Error('controlled acknowledgement loss after the actual write');
  } });
  const exited = await subject.done;
  assert.equal(exited.code, 2); assert.equal(result.status, 'stopped'); assert.equal(writes, 1);
  assert.equal(await readFile(join(f.config.runRoot, 'workspace/policy.txt'), 'utf8'), 'v2\n');
  const replay = await createTurnBridgeController(f.config);
  const repeated = await replay.serve({ subject: new Promise(() => {}), executeEvent: () => { writes++; throw new Error('must never replay an unknown effect'); } });
  assert.equal(repeated.status, 'stopped'); assert.equal(writes, 1);
  const rows = await readTurnBridgeJournal(repeated.journal.path);
  assert.equal(rows.find(row => row.type === 'event_result').data.result.status, 'unknown');
  await retainProof(f, repeated, exited, { actual_fixture_writes: writes });
});

test('controller death converges through read-only applied/not-applied evidence before the waiting child resumes', { timeout: 15000 }, async () => {
  for (const beforeWrite of [false, true]) {
  const f = await setup(beforeWrite ? 'controller-crash-before-write' : 'controller-crash-after-write');
  await mkdir(f.config.controllerRoot);
  const privateConfig = join(f.config.controllerRoot, 'controller-config.json'), workerFile = join(f.root, 'crashing-controller.mjs');
  await save(privateConfig, f.config);
  await writeFile(workerFile, `
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createTurnBridgeController} from ${JSON.stringify(moduleUrl)};
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const controller=await createTurnBridgeController(config);
await controller.serve({subject:new Promise(()=>{}),executeEvent:async()=>{
 if(${beforeWrite})process.exit(72);
 await writeFile(join(config.runRoot,'workspace/policy.txt'),'v2\\n');
 await appendFile(join(config.controllerRoot,'actual-writes.txt'),'write\\n');
 process.exit(73);
}});
`, { flag: 'wx' });
  const crashed = child(workerFile, [privateConfig]), subject = await launchSubject(f);
  const death = await crashed.done; assert.equal(death.code, beforeWrite ? 72 : 73, death.stderr);
  const controller = await createTurnBridgeController(f.config);
  let reconciles = 0, writes = 0;
  const result = await controller.serve({ subject: subject.done,
    executeEvent: async ({ eventId }) => { assert.equal(beforeWrite, true, 'replay forbidden after applied readback'); writes++;
      await writeFile(join(f.config.runRoot, 'workspace/policy.txt'), 'v2\n'); await appendFile(join(f.config.controllerRoot, 'actual-writes.txt'), 'write\n');
      return receipt(f.config, eventId, 'applied'); },
    reconcileEvent: async ({ eventId }) => { reconciles++; assert.equal(await readFile(join(f.config.runRoot, 'workspace/policy.txt'), 'utf8'), beforeWrite ? 'v1\n' : 'v2\n');
      return receipt(f.config, eventId, beforeWrite ? 'not_applied' : 'applied', '-reconciled'); },
  });
  const exited = await subject.done;
  assert.equal(exited.code, 0, exited.stderr); assert.equal(result.status, 'completed'); assert.equal(reconciles, 1); assert.equal(writes, beforeWrite ? 1 : 0);
  assert.equal(await readFile(join(f.config.controllerRoot, 'actual-writes.txt'), 'utf8'), 'write\n');
  const rows = await readTurnBridgeJournal(result.journal.path);
  assert.equal(rows.filter(row => row.type === 'event_started').length, beforeWrite ? 2 : 1);
  assert.equal(rows.filter(row => row.type === 'event_reconciled').length, 1);
  await retainProof(f, result, exited, { controller_exit: death, actual_fixture_writes: 1, readonly_reconciliations: reconciles });
  }
});

test('failed events and receipts for another episode cannot release a later natural turn', { timeout: 15000 }, async () => {
  for (const scenario of ['failed', 'wrong-episode']) {
    const f = await setup(scenario), controller = await createTurnBridgeController(f.config), subject = await launchSubject(f);
    const result = await controller.serve({ subject: subject.done, executeEvent: ({ eventId }) =>
      receipt(f.config, eventId, scenario === 'failed' ? 'failed' : 'applied', '', scenario === 'wrong-episode' ? { episode_id: 'other-episode' } : {}) });
    const exited = await subject.done;
    assert.equal(result.status, 'stopped'); assert.equal(exited.code, 2);
    const observed = JSON.parse(await readFile(join(f.config.runRoot, 'subject-observed.json'), 'utf8'));
    assert.ok(!observed.some(turn => turn.id === 'turn-2'));
    const rows = await readTurnBridgeJournal(result.journal.path);
    assert.equal(rows.find(row => row.type === 'event_result').data.result.status, scenario === 'failed' ? 'failed' : 'unknown');
    await retainProof(f, result, exited);
  }
});

test('a changed session is rejected at its actual second checkpoint', { timeout: 15000 }, async () => {
  const f = await setup('session-change', { events: [] }), controller = await createTurnBridgeController(f.config), subject = await launchSubject(f, { changeSession: true });
  const result = await controller.serve({ subject: subject.done }), exited = await subject.done;
  assert.equal(result.status, 'stopped'); assert.match(result.reason, /SESSION_CHANGED/); assert.equal(exited.code, 2);
  await retainProof(f, result, exited);
});

test('owned channel refuses symlink escape before creating packets in the target', async () => {
  const f = await setup('symlink', { events: [] }), target = join(f.root, 'unrelated-owned-test-target');
  await mkdir(target); await symlink(target, join(f.config.runRoot, 'benchmark/turn-bridge'));
  const controller = await createTurnBridgeController(f.config);
  const result = await controller.serve({ subject: new Promise(() => {}) });
  assert.equal(result.status, 'stopped'); assert.deepEqual(await readdir(target), []);
});

test('closing a subject with a pending checkpoint cancels its wait without a fabricated resume', { timeout: 15000 }, async () => {
  const f = await setup('cancel-pending', { limits: { wallMs: 10000, waitMs: 1000, eventMs: 200, pollMs: 5 } });
  const controller = await createTurnBridgeController(f.config), subject = await launchSubject(f, { cancelAfterMs: 50 });
  const result = await controller.serve({ subject: subject.done, executeEvent: ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve({ status: 'unknown', effect_unknown: true }), { once: true });
  }) });
  const exited = await subject.done;
  assert.equal(exited.code, 2); assert.equal(result.status, 'stopped');
  const observed = JSON.parse(await readFile(join(f.config.runRoot, 'subject-observed.json'), 'utf8'));
  assert.equal(observed.at(-1).stopped, 'TURN_BRIDGE_CANCELLED'); assert.ok(!observed.some(row => row.id === 'turn-2'));
  await retainProof(f, result, exited, { actual_fixture_writes: 0 });
});

test('initial empty or partial run manifest waits for complete publication before the real child connects', { timeout: 15000 }, async () => {
  for (const initial of ['', '{"run_id":']) {
    const f = await setup(initial ? 'partial-run-publication' : 'empty-run-publication', { events: [] });
    const path = join(f.config.runRoot, 'run.json'); await writeFile(path, initial);
    const controller = await createTurnBridgeController(f.config), subject = await launchSubject(f);
    const serving = controller.serve({ subject: subject.done });
    const began = performance.now();
    for (;;) {
      const rows = await readTurnBridgeJournal(join(f.config.controllerRoot, 'controller.jsonl'));
      if (rows.some(row => row.type === 'run_manifest_pending')) break;
      assert.ok(performance.now() - began < 2000, 'Controller must actually observe the incomplete publication');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await writeFile(path, JSON.stringify({ run_id: f.config.runId }) + '\n');
    const result = await serving, exited = await subject.done;
    assert.equal(result.status, 'completed'); assert.equal(exited.code, 0, exited.stderr);
    const rows = await readTurnBridgeJournal(result.journal.path), pending = rows.find(row => row.type === 'run_manifest_pending');
    assert.equal(pending.data.observation.sha256, sha(initial)); assert.equal(pending.data.observation.bytes, Buffer.byteLength(initial));
    assert.ok(rows.some(row => row.type === 'run_manifest_observed'));
    await retainProof(f, result, exited, { initial_manifest_sha256: sha(initial), initial_manifest_bytes: Buffer.byteLength(initial) });
  }
});

test('persistently invalid run manifest stops at its fixed deadline with retained corruption evidence', async () => {
  const f = await setup('invalid-run-publication', { events: [], limits: { wallMs: 2000, waitMs: 100, eventMs: 50, pollMs: 5 } });
  const invalid = '{ invalid owned test manifest', path = join(f.config.runRoot, 'run.json'); await writeFile(path, invalid);
  const controller = await createTurnBridgeController(f.config), began = performance.now();
  const result = await controller.serve({ subject: new Promise(() => {}) });
  assert.equal(result.status, 'stopped'); assert.equal(result.reason, 'TURN_BRIDGE_RUN_MANIFEST_TIMEOUT');
  assert.ok(performance.now() - began >= 100); assert.ok(performance.now() - began < 1500);
  const rows = await readTurnBridgeJournal(result.journal.path), unavailable = rows.find(row => row.type === 'run_manifest_unavailable');
  assert.equal(unavailable.data.last_observation.sha256, sha(invalid)); assert.equal(await readFile(path, 'utf8'), invalid);
  await assert.rejects(readFile(join(f.config.runRoot, 'benchmark/turn-bridge/ready.json')), { code: 'ENOENT' });
  await retainProof(f, result, { scope: 'subject not launched; readiness never published' }, { invalid_manifest_sha256: sha(invalid) });
});

test('complete wrong run identity fails immediately and is never treated as a pending publication', async () => {
  const f = await setup('wrong-run-publication', { events: [], limits: { wallMs: 15000, waitMs: 8000, eventMs: 2000, pollMs: 5 } });
  const path = join(f.config.runRoot, 'run.json'); await writeFile(path, JSON.stringify({ run_id: 'another-run' }) + '\n');
  const controller = await createTurnBridgeController(f.config), began = performance.now();
  const result = await controller.serve({ subject: new Promise(() => {}) });
  assert.equal(result.status, 'stopped'); assert.match(result.reason, /TURN_BRIDGE_SHARED_RUN_ID/);
  assert.ok(performance.now() - began < 2000);
  const rows = await readTurnBridgeJournal(result.journal.path);
  assert.equal(rows.some(row => row.type === 'run_manifest_pending'), false);
  await retainProof(f, result, { scope: 'subject not launched; wrong identity rejected' });
});
