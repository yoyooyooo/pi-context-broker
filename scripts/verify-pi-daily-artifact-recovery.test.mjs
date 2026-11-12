import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as candidate from './verify-pi-daily-candidate.mjs';
import { ownedProjectFiles } from './notion-skill-graph-project.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const config = { artifactOutput: true, project: 'owned-ticket-service', timeoutMs: 600000,
  artifactRecovery: { parent: { path: '/owned/result.json', sha256: 'a'.repeat(64) }, timeoutMs: 600000,
    stages: [{ id: 'procedure', prompt: '先保存规程主文，不执行。' }, { id: 'complete', prompt: '补齐本地引用与 helper，完整交付，不执行。' }] } };
const noWrites = { version: 1, remote_writes: 'none', author_content: 'unchanged', retention: [] };
const metrics = { providerRequests: 1, toolCalls: 1, payloadBytes: 1000 };
const rejection = 'This owned project task permits only pwd, ls and bounded find inventory within its fixed cwd. Project execution, content search, outside paths and other shell commands remain blocked.';

async function parentFixture(t, { blocked = false, pending = false } = {}) {
  const evidence = await mkdtemp('/private/tmp/notion-artifact-recovery-proof-');
  t.diagnostic(JSON.stringify({ ownedScratch: [evidence], cleanup: 'Evidence-first system Trash only.' }));
  const cwd = '/private/tmp/notion-candidate-print-removed', header = { type: 'session', version: 3, id: 'source',
    timestamp: '2026-11-12T00:00:00.000Z', cwd };
  const rows = [{ type: 'model_change', id: 'model', parentId: null, provider: 'magpie', modelId: 'group/worker' },
    { type: 'message', id: 'user', parentId: 'model', message: { role: 'user', content: [{ type: 'text', text: '原完整生成任务。' }] } }];
  const calls = [{ id: 'source-read', name: 'notion_use', arguments: { ref: 'sr:fixed', readOnly: true } },
    ...Object.keys(ownedProjectFiles).map((path, i) => ({ id: 'file-' + i, name: 'read', arguments: { path: join(cwd, path) } }))];
  if (blocked) calls.push({ id: 'rejected', name: 'bash', arguments: { command: 'find . -maxdepth 5 -type f' } });
  rows.push({ type: 'message', id: 'tools', parentId: 'user', message: { role: 'assistant', provider: 'magpie', model: 'group/worker',
    stopReason: 'toolUse', content: calls.map(call => ({ type: 'toolCall', ...call })) } });
  let previous = 'tools';
  for (const [i, call] of calls.entries()) {
    if (pending && i === calls.length - 1) break;
    const text = call.name === 'bash' ? rejection : call.name === 'notion_use' ? '完整来源正文。' : ownedProjectFiles[call.arguments.path.slice(cwd.length + 1)];
    const id = 'result-' + i;
    rows.push({ type: 'message', id, parentId: previous, message: { role: 'toolResult', toolCallId: call.id,
      toolName: call.name, isError: call.name === 'bash', content: [{ type: 'text', text }], details: call.name === 'notion_use' ? { contextBrokerPreparation: { effects: noWrites } } : {} } });
    previous = id;
  }
  const native = lines([header, ...rows]), path = join(evidence, 'native.jsonl');
  await writeFile(path, native, { flag: 'wx' });
  const files = Object.entries(ownedProjectFiles).map(([path, text]) => ({ path, sha256: sha(text), bytes: Buffer.byteLength(text) }));
  const parent = { scope: 'project-scoped-candidate-print', status: 'failed', expectedUserMessages: 1,
    project: { kind: 'owned-ticket-service', root: cwd, files, sha256: sha(JSON.stringify(files)) },
    process: { code: 143, timedOut: true, startedNs: '1', endedNs: '600000000001' },
    launch: { cwd }, session: { path, bytes: Buffer.byteLength(native), sha256: sha(native) },
    normalConfigurationUnchanged: true, baselineFilesUnchanged: true, projectFilesUnchanged: true };
  return { evidence, parent, native, rows, header };
}

test('staged recovery is explicit, two-phase, same-project, and cannot combine alternative mutations or caps', () => {
  assert.equal(candidate.validateCandidateArtifactRecovery(config).stages.length, 2);
  for (const patch of [{ artifactOutput: false }, { project: undefined }, { resumeFrom: {} }, { publicCli: {} },
    { existingState: {} }, { forkIntroductionResume: true }, { maxCompletionTokens: 32768 }, { timeoutMs: 1200000 }])
    assert.throws(() => candidate.validateCandidateArtifactRecovery({ ...config, ...patch }));
  for (const change of [{ timeoutMs: 1200000 }, { stages: config.artifactRecovery.stages.slice(0, 1) },
    { stages: config.artifactRecovery.stages.toReversed() }, { parent: { path: 'relative', sha256: 'a'.repeat(64) } }])
    assert.throws(() => candidate.validateCandidateArtifactRecovery({ ...config, artifactRecovery: { ...config.artifactRecovery, ...change } }));
  assert.throws(() => candidate.candidateArtifactOutputEnabled({ ...config, resumeFrom: {} }));
});

test('a terminal failed generation parent retains complete source/project history without requiring its removed cwd', async t => {
  const f = await parentFixture(t);
  assert.throws(() => candidate.inspectCandidatePrintSession(f.native, { provider: 'magpie', model: 'group/worker' }), /successful final/u);
  const result = await candidate.inspectArtifactForkSource(f.parent);
  assert.equal(result.history.sha256, sha(lines(f.rows))); assert.equal(result.history.entries, f.rows.length);
  assert.equal(result.native.sha256, f.parent.session.sha256); assert.equal(result.originalStatus, 'failed');
  assert.deepEqual(result.projectFiles, f.parent.project.files);
  assert.deepEqual(await readFile(f.parent.session.path, 'utf8'), f.native);
});

test('the frozen historical inventory rejection is retained, while incomplete effects or ordinary command failures are rejected', async t => {
  const f = await parentFixture(t, { blocked: true });
  assert.equal((await candidate.inspectArtifactForkSource(f.parent)).historicalRejectedCalls.length, 1);
  const changed = structuredClone(f.rows);
  changed.at(-1).message.content[0].text = 'Command exited with code 1 after changing files.';
  const native = lines([f.header, ...changed]); await writeFile(f.parent.session.path, native);
  await assert.rejects(() => candidate.inspectArtifactForkSource({ ...f.parent, session: { ...f.parent.session, sha256: sha(native), bytes: Buffer.byteLength(native) } }), /rejection|read-only/u);
  const incomplete = await parentFixture(t, { pending: true });
  await assert.rejects(() => candidate.inspectArtifactForkSource(incomplete.parent), /terminal result/u);
});

test('parent admission rejects nonterminal processes, source writes, changed project and changed native bytes', async t => {
  const f = await parentFixture(t);
  for (const patch of [{ status: 'running' }, { process: { ...f.parent.process, endedNs: undefined } },
    { projectFilesUnchanged: false }, { project: { ...f.parent.project, sha256: '0'.repeat(64) } },
    { session: { ...f.parent.session, sha256: '0'.repeat(64) } }])
    await assert.rejects(() => candidate.inspectArtifactForkSource({ ...f.parent, ...patch }));
  const changed = structuredClone(f.rows); changed[3].message.details.contextBrokerPreparation.effects.remote_writes = 'occurred';
  const native = lines([f.header, ...changed]); await writeFile(f.parent.session.path, native);
  await assert.rejects(() => candidate.inspectArtifactForkSource({ ...f.parent, session: { ...f.parent.session, sha256: sha(native), bytes: Buffer.byteLength(native) } }), /read-only/u);
});

test('the second stage receives only the shared deadline remainder and cannot start after the first exhausts it', async () => {
  let now = 1000000000n, calls = 0;
  const clock = { timeoutMs: 600000 };
  const result = await candidate.runCandidateArtifactStages(config.artifactRecovery.stages, clock, async (stage, shared) => {
    calls++; candidate.beginCandidateArtifactBudget(shared, now);
    assert.equal(candidate.remainingCandidateArtifactBudget(shared, now), calls === 1 ? 600000 : 350000);
    now += calls === 1 ? 250000000000n : 1000000000n;
    return { status: stage.id === 'procedure' ? 'stage-completed' : 'passed', recoveryMetrics: metrics };
  }, () => now);
  assert.equal(result.length, 2); assert.equal(calls, 2);
  now = 1000000000n; calls = 0;
  const exhausted = await candidate.runCandidateArtifactStages(config.artifactRecovery.stages, { timeoutMs: 600000 }, async (_stage, shared) => {
    calls++; candidate.beginCandidateArtifactBudget(shared, now); now += 600000000000n; return { status: 'stage-completed', recoveryMetrics: metrics };
  }, () => now);
  assert.equal(calls, 1); assert.equal(exhausted[1].status, 'not_run');
});

test('a partial or failed first phase cannot be promoted or trigger completion', async () => {
  for (const status of ['failed', 'passed', 'not_run']) {
    let calls = 0;
    const result = await candidate.runCandidateArtifactStages(config.artifactRecovery.stages, { timeoutMs: 600000 }, async () => {
      calls++; return { status };
    });
    assert.equal(calls, 1); assert.equal(result.length, 2); assert.equal(result[1].status, 'not_run');
  }
});

test('aggregate staged limits count each new phase once and preserve over-budget failure', () => {
  const stages = [{ status: 'stage-completed', recoveryMetrics: { providerRequests: 2, toolCalls: 3, payloadBytes: 600000 } },
    { status: 'passed', recoveryMetrics: { providerRequests: 3, toolCalls: 7, payloadBytes: 900000 } }];
  assert.deepEqual(candidate.inspectCandidateArtifactRecoveryLimits(stages), { providerRequests: 5, toolCalls: 10, payloadBytes: 1500000,
    limits: { providerRequests: 8, toolCalls: 40, payloadBytes: 4000000 }, enforcement: 'post-run acceptance; not a pre-send cap' });
  for (const changed of [{ providerRequests: 7 }, { toolCalls: 40 }, { payloadBytes: 4000000 }])
    assert.throws(() => candidate.inspectCandidateArtifactRecoveryLimits([stages[0], { ...stages[1], recoveryMetrics: { ...stages[1].recoveryMetrics, ...changed } }]));
});

test('stage-boundary exhaustion stops the second model invocation without pretending to enforce a pre-send cap', async () => {
  for (const exhausted of [{ providerRequests: 8 }, { providerRequests: 9 }, { toolCalls: 40 }, { payloadBytes: 4000000 }]) {
    let calls = 0;
    const result = await candidate.runCandidateArtifactStages(config.artifactRecovery.stages, { timeoutMs: 600000 }, async () => {
      calls++; return { status: 'stage-completed', recoveryMetrics: { ...metrics, ...exhausted } };
    });
    assert.equal(calls, 1); assert.equal(result[1].status, 'not_run'); assert.match(result[1].reason, /call budget/u);
    assert.deepEqual(result[0].recoveryMetrics, { ...metrics, ...exhausted });
  }
});

test('a second public linear continuation keeps the first fork header and full original history binding', async t => {
  const f = await parentFixture(t);
  const proof = await candidate.inspectArtifactForkSource(f.parent), cwd = '/private/tmp/notion-candidate-print-new';
  const binding = { parentSession: proof.native.realpath, sourceSessionId: proof.header.id, cwd, history: proof.history };
  const header = { ...f.header, id: 'forked', parentSession: binding.parentSession, cwd };
  const append = (id, parentId, role, text) => ({ type: 'message', id, parentId,
    message: { role, content: [{ type: 'text', text }], ...(role === 'assistant' ? { provider: 'magpie', model: 'group/worker', stopReason: 'stop' } : {}) } });
  const stage1 = lines([header, ...f.rows, append('stage1-user', f.rows.at(-1).id, 'user', '规程阶段'),
    append('stage1-final', 'stage1-user', 'assistant', '规程已保存，引用与helper待完成。')]);
  const stage2 = stage1 + lines([append('stage2-user', 'stage1-final', 'user', '完整阶段'),
    append('stage2-final', 'stage2-user', 'assistant', '完整文件清单与未执行步骤。')]);
  const inspected = candidate.inspectCandidatePrintSession(stage2, { provider: 'magpie', model: 'group/worker', expectedUserMessages: 3, fork: binding });
  assert.equal(inspected.userLines.length, 3);
  assert.equal(inspected.calls.length, 6, 'No new tool calls occurred in this native-history fixture');
  assert.equal(stage2.slice(0, stage1.length), stage1);
  assert.throws(() => candidate.inspectCandidatePrintSession(stage2, { provider: 'magpie', model: 'group/worker', expectedUserMessages: 3 }), /unbound fork/u);
});
