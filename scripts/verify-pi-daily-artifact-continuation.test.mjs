import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as candidate from './verify-pi-daily-candidate.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const nativeText = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const parentPath = process.env.PI_ARTIFACT_RECOVERY_V9_RESULT;
const restoredParentPath = process.env.PI_ARTIFACT_RECOVERY_V10_RESULT;
const editedParentPath = process.env.PI_ARTIFACT_RECOVERY_V13_B_RESULT;
const legacyParents = process.env.PI_ARTIFACT_RECOVERY_V3_PARENTS;
const complete = [{ id: 'complete', prompt: '继续完成原完整任务，补齐文件与 helper；只生成，不执行。' }];
const config = { artifactOutput: true, project: 'owned-ticket-service', timeoutMs: 600000,
  artifactRecovery: { parent: { path: '/owned/result.json', sha256: 'a'.repeat(64) }, timeoutMs: 600000, stages: complete } };
const metrics = { providerRequests: 1, toolCalls: 2, payloadBytes: 1000 };

async function scratch(t, prefix = 'notion-artifact-completion-proof-') {
  const path = await mkdtemp('/private/tmp/' + prefix);
  t.diagnostic(JSON.stringify({ ownedScratch: [path], cleanup: 'Exact roots only; evidence then system Trash.' }));
  return path;
}

test('one complete stage uses the existing bounded runner and cannot return a draft verdict', async () => {
  assert.deepEqual(candidate.validateCandidateArtifactRecovery(config).stages, complete);
  let calls = 0;
  const clock = { timeoutMs: 600000 };
  const result = await candidate.runCandidateArtifactStages(complete, clock, async (stage, shared, index) => {
    calls++; assert.equal(index, 0); assert.equal(stage.id, 'complete');
    assert.equal(candidate.beginCandidateArtifactBudget(shared, 1000n), 600000);
    return { id: stage.id, status: 'passed', recoveryMetrics: metrics };
  }, () => 1000n);
  assert.equal(calls, 1); assert.equal(result.length, 1);
  assert.equal(candidate.inspectCandidateArtifactRecoveryLimits(result).providerRequests, 1);
  assert.throws(() => candidate.inspectCandidateArtifactRecoveryLimits([{ ...result[0], status: 'stage-completed' }]));
  assert.throws(() => candidate.inspectCandidateArtifactRecoveryLimits([{ ...result[0], recoveryMetrics: { ...metrics, payloadBytes: 4000001 } }]));
});

test('actual failed v9 native and retained draft are admitted, restored byte-exactly, and remain incomplete without a helper', { skip: !parentPath }, async t => {
  const parent = await json(parentPath), proof = await candidate.inspectArtifactForkSource(parent);
  assert.equal(proof.native.sha256, 'd3835c5d1929c7f6a5df526773f0b004c45ffdc1a054f9fae5a9c961f620ae29');
  assert.equal(proof.historicalRejectedCalls.length, 2);
  assert.equal(proof.artifactSeed.files.length, 1);
  assert.equal(proof.artifactSeed.files[0].sha256, 'f3ec7ecf5a116e67e7ef6ce46b97d61af71f250ff91bbf020348885051f96c49');
  const evidence = await scratch(t), root = await scratch(t, 'notion-candidate-artifacts-'), stat = await lstat(root);
  const policy = { root, dev: stat.dev, ino: stat.ino, projectFiles: parent.project.files.map(file => file.path) };
  const restored = await candidate.restoreCandidateArtifactSeed(proof, { policy, evidence });
  assert.equal(restored.files.length, 1); assert.notEqual(root, parent.artifactOutput.files.root);
  assert.equal(sha(await readFile(join(root, restored.files[0].path))), proof.artifactSeed.files[0].sha256);
  const captured = await candidate.retainCandidateArtifactFiles({ policy, evidence });
  await assert.rejects(() => candidate.retainCandidateFilePlan({ evidence, project: parent.project, artifactFiles: captured,
    final: { success: true, stopReason: 'stop', text: 'Only the retained draft exists.' }, prompt: { sha256: sha('test') } }), /Node helper/u);
  assert.equal(sha(await readFile(parent.session.path)), parent.session.sha256);
});

async function alteredParent(t, mutate, sourcePath = parentPath) {
  const parent = await json(sourcePath), evidence = await scratch(t);
  const rows = (await readFile(parent.session.path, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const guard = (await readFile(parent.artifactOutput.guard, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  parent.evidence = evidence; parent.artifactOutput.ownership.evidence = evidence;
  parent.artifactOutput.guard = join(evidence, 'observation/artifact-output-guard.jsonl');
  parent.artifactOutput.guardHistory = [parent.artifactOutput.guard];
  await mkdir(dirname(parent.artifactOutput.guard), { recursive: true });
  const original = await json(sourcePath);
  for (const file of parent.artifactOutput.files.files) {
    const target = join(evidence, file.evidencePath); await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(original.evidence, file.evidencePath)), { flag: 'wx' });
  }
  await mutate({ parent, rows, guard, evidence });
  const text = nativeText(rows), path = join(evidence, 'native.jsonl'); await writeFile(path, text, { flag: 'wx' });
  parent.session = { path, bytes: Buffer.byteLength(text), sha256: sha(text) };
  await writeFile(parent.artifactOutput.guard, nativeText(guard), { flag: 'wx' });
  await writeFile(join(evidence, 'owned-artifacts.json'), JSON.stringify(parent.artifactOutput.files) + '\n', { flag: 'wx' });
  await writeFile(join(evidence, 'artifact-output-ownership.json'), JSON.stringify(parent.artifactOutput.ownership) + '\n', { flag: 'wx' });
  if (parent.artifactOutput.seedRestoration) await writeFile(join(evidence, 'artifact-seed-restoration.json'), JSON.stringify(parent.artifactOutput.seedRestoration) + '\n', { flag: 'wx' });
  return parent;
}

test('actual-parent counterexamples reject unapproved write, outside read, unproven rejection, executed command and changed seed bytes', { skip: !parentPath }, async t => {
  await candidate.inspectArtifactForkSource(await alteredParent(t, () => {}));
  const mutations = [
    ({ rows, guard }) => { const call = rows.flatMap(row => row.message?.content ?? []).find(part => part.type === 'toolCall' && part.name === 'write');
      call.arguments.path = '/private/tmp/unowned/SKILL.md'; guard.find(row => row.allowed === true).inputSha256 = sha(JSON.stringify(call.arguments)); },
    ({ rows }) => { const call = rows.flatMap(row => row.message?.content ?? []).find(part => part.type === 'toolCall' && part.name === 'read' && part.arguments.path?.includes('notion-candidate-artifacts-'));
      call.arguments.path = '/private/tmp/unowned/SKILL.md'; },
    ({ guard }) => { guard.splice(guard.findIndex(row => row.allowed === false), 1); },
    ({ rows }) => { const result = rows.find(row => row.message?.role === 'toolResult' && row.message.toolName === 'bash' && row.message.isError);
      result.message.isError = false; result.message.content = [{ type: 'text', text: 'Executed.' }]; },
    async ({ parent, evidence }) => { await writeFile(join(evidence, parent.artifactOutput.files.files[0].evidencePath), 'changed draft\n'); },
  ];
  for (const mutate of mutations) await assert.rejects(() => alteredParent(t, mutate).then(candidate.inspectArtifactForkSource));
});

test('actual B failed-parent admission retains the final helper after its bound write and three-block native edit', { skip: !editedParentPath }, async () => {
  const original = await readFile(editedParentPath), parent = JSON.parse(original), native = await readFile(parent.session.path);
  const proof = await candidate.inspectArtifactForkSource(parent);
  assert.equal(proof.native.sha256, 'fb5364658957049e4b19d38d619ebf5f8de039bf7313363648aa7c0d8c3e7ac1');
  assert.equal(proof.originalStatus, 'failed'); assert.equal(proof.artifactSeed.files.length, 1);
  const file = proof.artifactSeed.files[0];
  assert.equal(file.bytes, 18905); assert.equal(file.sha256, '7703bc6c49da03119edb182168d767236f26bad6c6617357d6b4d6a82d3d5814');
  assert.equal(file.sourcePath, join(parent.evidence, file.evidencePath));
  assert.deepEqual(proof.artifactSeed.guardRows.filter(row => row.phase === 'tool_call').map(row => row.toolName), ['write', 'edit']);
  assert.equal(sha(await readFile(file.sourcePath)), file.sha256);
  assert.deepEqual(await readFile(editedParentPath), original); assert.deepEqual(await readFile(parent.session.path), native);
});

test('B failed-parent reads bind the version present before its later native edit', { skip: !editedParentPath }, async t => {
  const parent = await alteredParent(t, ({ rows }) => {
    const write = rows.flatMap(row => row.message?.content ?? []).find(part => part.type === 'toolCall' && part.name === 'write');
    const index = rows.findIndex(row => row.message?.toolCallId === write.id), previous = rows[index].id;
    const parts = write.arguments.content.split('\n');
    const text = parts.slice(189, 214).join('\n') + '\n\n[' + (parts.length - 214) + ' more lines in file. Use offset=215 to continue.]';
    const call = { type: 'message', id: 'intermediate-read-call', parentId: previous, message: {
      role: 'assistant', provider: 'magpie', model: 'group/worker', stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'intermediate-read', name: 'read', arguments: { path: write.arguments.path, offset: 190, limit: 25 } }] } };
    const result = { type: 'message', id: 'intermediate-read-result', parentId: call.id, message: {
      role: 'toolResult', toolCallId: 'intermediate-read', toolName: 'read', isError: false, content: [{ type: 'text', text }] } };
    rows[index + 1].parentId = result.id; rows.splice(index + 1, 0, call, result);
  }, editedParentPath);
  assert.equal((await candidate.inspectArtifactForkSource(parent)).artifactSeed.files[0].bytes, 18905);
});

test('B failed-parent edits reject wrong or ambiguous old text, missing approvals, outside paths, missing writes and wrong intermediate hashes', { skip: !editedParentPath }, async t => {
  await candidate.inspectArtifactForkSource(await alteredParent(t, () => {}, editedParentPath));
  const mutateEdit = change => ({ rows, guard }) => {
    const call = rows.flatMap(row => row.message?.content ?? []).find(part => part.type === 'toolCall' && part.name === 'edit');
    change(call.arguments); guard.find(row => row.phase === 'tool_call' && row.toolCallId === call.id).inputSha256 = sha(JSON.stringify(call.arguments));
  };
  const mutations = [
    [mutateEdit(input => { input.edits[0].oldText = 'missing exact old text'; }), /unique exact/u],
    [mutateEdit(input => { input.edits[0].oldText = 'const'; }), /unique exact/u],
    [({ guard }) => { guard.splice(guard.findIndex(row => row.phase === 'tool_call' && row.toolName === 'edit'), 1); }, /approval|Bind each|strictly equal/u],
    [mutateEdit(input => { input.path = '/private/tmp/unowned/helper.mjs'; }), /retained owned artifact/u],
    [({ rows, guard }) => {
      const callRow = rows.find(row => Array.isArray(row.message?.content) && row.message.content.some(part => part.type === 'toolCall' && part.name === 'write'));
      const call = callRow.message.content.find(part => part.type === 'toolCall' && part.name === 'write');
      const result = rows.find(row => row.message?.toolCallId === call.id);
      rows.find(row => row.parentId === result.id).parentId = callRow.parentId;
      rows.splice(0, rows.length, ...rows.filter(row => row !== callRow && row !== result));
      guard.splice(0, guard.length, ...guard.filter(row => row.toolCallId !== call.id));
    }, /prior bound write/u],
    [({ guard }) => { guard.find(row => row.phase === 'artifact_file').sha256 = '0'.repeat(64); }, /Historical artifact version/u],
  ];
  for (const [mutate, reason] of mutations)
    await assert.rejects(() => alteredParent(t, mutate, editedParentPath).then(candidate.inspectArtifactForkSource), reason);
});

test('actual B/normal and D-natural/-ns read-only parents permit only the frozen guidance-only product transition', { skip: !parentPath || !legacyParents }, async () => {
  const current = await json(parentPath), index = await json(legacyParents);
  for (const id of ['final-v3-B-normal', 'final-v3-D-natural-notion-only']) {
    const previous = await json(index.results.find(row => row.id === id).result.path);
    const proof = await candidate.inspectArtifactForkSource(previous); assert.equal(proof.artifactSeed, undefined);
    const transition = await candidate.inspectCandidateArtifactProduct(previous, current.baselineFiles, current.runtime);
    assert.equal(transition.mode, 'frozen-guidance-only-transition');
    assert.deepEqual(transition.changedFiles, ['src/index.ts']);
    await assert.rejects(() => candidate.inspectCandidateArtifactProduct(previous, current.baselineFiles,
      { ...current.runtime, sdk_sha256: '0'.repeat(64) }));
    const changed = structuredClone(current.baselineFiles); changed[1].sha256 = '0'.repeat(64);
    await assert.rejects(() => candidate.inspectCandidateArtifactProduct(previous, changed, current.runtime));
  }
});

test('generic resource resume validates and retains an artifact fork binding instead of accepting an unbound parent header', { skip: !parentPath }, async t => {
  const parent = await json(parentPath), evidence = await scratch(t), rows = (await readFile(parent.session.path, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const user = { type: 'message', id: 'test-complete-user', parentId: rows.at(-1).id, message: { role: 'user', content: [{ type: 'text', text: 'Complete the task.' }] } };
  rows.push(user, { type: 'message', id: 'test-complete-final', parentId: user.id, message: { role: 'assistant', provider: 'magpie', model: 'group/worker', stopReason: 'stop', content: [{ type: 'text', text: 'Synthetic completed final for fork-binding validation only.' }] } });
  const path = join(evidence, 'completed-native.jsonl'), text = nativeText(rows); await writeFile(path, text, { flag: 'wx' });
  const completed = { ...parent, status: 'passed', process: { ...parent.process, code: 0, timedOut: false },
    expectedUserMessages: parent.expectedUserMessages + 1, session: { path, bytes: Buffer.byteLength(text), sha256: sha(text) } };
  const binding = await candidate.inspectCandidateArtifactResume(completed);
  assert.deepEqual(binding, parent.launch.artifactFork.binding);
  assert.throws(() => candidate.inspectCandidatePrintSession(text, { provider: 'magpie', model: 'group/worker', expectedUserMessages: completed.expectedUserMessages }), /unbound fork/u);
  const changed = structuredClone(completed); changed.launch.artifactFork.binding.history.sha256 = '0'.repeat(64);
  await assert.rejects(() => candidate.inspectCandidateArtifactResume(changed));
});

const splitStages = [{ id: 'procedure', prompt: '本轮交付 Node helper 与精简主规程，其余引用仍待完成。' },
  { id: 'complete', prompt: '补齐原任务的引用文件并给出完整最终交付。' }];
const splitConfig = { ...config, artifactRecovery: { ...config.artifactRecovery, budgetMode: 'per-stage', stages: splitStages } };

test('per-stage is explicit and gives exactly two independent 600-second model deadlines, excluding preparation', async () => {
  assert.equal(candidate.validateCandidateArtifactRecovery(splitConfig).budgetMode, 'per-stage');
  for (const change of [{ budgetMode: 'unbounded' }, { stages: complete }, { stages: splitStages.toReversed() }])
    assert.throws(() => candidate.validateCandidateArtifactRecovery({ ...splitConfig, artifactRecovery: { ...splitConfig.artifactRecovery, ...change } }));
  let now = 1000000000n;
  const clock = { timeoutMs: 600000, budgetMode: 'per-stage' }, received = [];
  const stages = await candidate.runCandidateArtifactStages(splitStages, clock, async (stage, own) => {
    now += 20000000000n; // Separate setup work before each actual spawn.
    assert.equal(candidate.beginCandidateArtifactBudget(own, now), 600000); received.push(own);
    const startedNs = now.toString(); now += 590000000000n;
    return { id: stage.id, status: stage.id === 'procedure' ? 'stage-completed' : 'passed',
      process: { code: 0, timedOut: false, startedNs, endedNs: now.toString() },
      recoveryMetrics: { providerRequests: 8, toolCalls: 40, payloadBytes: 4000000 } };
  }, () => now);
  assert.equal(stages.length, 2); assert.notEqual(received[0], received[1]);
  assert.equal(clock.stageClocks.length, 2);
  assert.equal(BigInt(received[1].startedNs) - BigInt(received[0].startedNs), 610000000000n);
  assert.equal(received.reduce((sum, own) => sum + Number(BigInt(own.deadlineNs) - BigInt(own.startedNs)) / 1e6, 0), 1200000);
  const totals = candidate.inspectCandidateArtifactRecoveryLimits(stages, { budgetMode: 'per-stage' });
  assert.deepEqual(totals.limits, { providerRequests: 16, toolCalls: 80, payloadBytes: 8000000 });
  assert.deepEqual(totals.perStageLimits, { providerRequests: 8, toolCalls: 40, payloadBytes: 4000000 });
  assert.equal(totals.payloadBytes, 8000000);
});

test('per-stage failure, deadline overrun or per-input overflow stops the second invocation', async () => {
  for (const change of [{ status: 'failed' }, { recoveryMetrics: { ...metrics, providerRequests: 9 } },
    { recoveryMetrics: { ...metrics, payloadBytes: 4000001 } }, { endedNs: '601000000001' }]) {
    let calls = 0;
    const result = await candidate.runCandidateArtifactStages(splitStages, { timeoutMs: 600000, budgetMode: 'per-stage' }, async (_stage, own) => {
      calls++; candidate.beginCandidateArtifactBudget(own, 1000000000n);
      return { status: 'stage-completed', recoveryMetrics: metrics, ...change,
        process: { code: 0, timedOut: false, startedNs: '1000000000', endedNs: change.endedNs ?? '2000000000' } };
    }, () => 2000000000n);
    assert.equal(calls, 1); assert.equal(result[1].status, 'not_run');
  }
  const stages = [{ status: 'stage-completed', recoveryMetrics: { ...metrics, providerRequests: 9 } },
    { status: 'passed', recoveryMetrics: metrics }];
  assert.throws(() => candidate.inspectCandidateArtifactRecoveryLimits(stages, { budgetMode: 'per-stage' }), /stage|input/u);
});

test('actual v10 admission retains both fork ancestors and verifies inherited guard plus byte-bound restoration', { skip: !restoredParentPath }, async t => {
  const parent = await json(restoredParentPath), proof = await candidate.inspectArtifactForkSource(parent);
  assert.equal(proof.native.sha256, 'dd6e9efa853362ca89720d1c3e42709e6b485f8b2a0cf89b5d93edc9a41e8bc2');
  assert.equal(proof.history.sha256, '5b1ac32c41e9abe7de34f21ef38f6520cf275af2e717363b3f31070203d08b60');
  assert.equal(proof.history.entries, 117); assert.equal(proof.historicalRejectedCalls.length, 2);
  assert.equal(proof.ancestor.ancestor.native.sha256, '9e8a134cc2dc2a2e6cb25181edd4c41f654d9df3420f56f43d37a88ac4210b56');
  assert.equal(proof.artifactSeed.files[0].sha256, 'f3ec7ecf5a116e67e7ef6ce46b97d61af71f250ff91bbf020348885051f96c49');
  assert.equal(proof.artifactSeed.guardRows.filter(row => row.phase === 'artifact_file').length, 1);
  assert.ok(proof.artifactSeed.inputs.some(file => file.path.endsWith('/artifact-seed-restoration.json')));
  await candidate.inspectArtifactForkSource(await alteredParent(t, () => {}, restoredParentPath));
  for (const mutate of [
    ({ parent }) => { parent.artifactOutput.inheritedArtifactProof.guardRows = []; },
    ({ parent }) => { parent.artifactOutput.seedRestoration.files[0].sourcePath = '/private/tmp/unreviewed/SKILL.md'; },
    ({ parent }) => { parent.artifactOutput.seedRestoration.files[0].sha256 = '0'.repeat(64); },
  ]) await assert.rejects(() => alteredParent(t, mutate, restoredParentPath).then(candidate.inspectArtifactForkSource));
  const evidence = await scratch(t), rows = (await readFile(parent.session.path, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const cwd = '/private/tmp/notion-candidate-print-thirdfork';
  rows[0] = { ...rows[0], id: 'third-fork', cwd, parentSession: proof.native.realpath };
  rows.push({ type: 'message', id: 'third-fork-user', parentId: rows.at(-1).id, message: { role: 'user', content: [{ type: 'text', text: 'Another input.' }] } });
  const path = join(evidence, 'third-fork.jsonl'), text = nativeText(rows); await writeFile(path, text, { flag: 'wx' });
  const third = { ...parent, expectedUserMessages: parent.expectedUserMessages + 1, session: { path, bytes: Buffer.byteLength(text), sha256: sha(text) },
    artifactRecoveryStage: { ...parent.artifactRecoveryStage, parentResult: { path: restoredParentPath, sha256: sha(await readFile(restoredParentPath)) } },
    launch: { ...parent.launch, cwd, artifactFork: { original: proof.native,
      binding: { parentSession: proof.native.realpath, sourceSessionId: proof.header.id, cwd, history: proof.history } } } };
  await assert.rejects(() => candidate.inspectArtifactForkSource(third), /two.*fork|fork.*depth/u);
  assert.equal(sha(await readFile(parent.session.path)), parent.session.sha256);
});

test('new procedure requires current native delivery of both helper and Skill, while references stay pending', async t => {
  const evidence = await scratch(t), root = '/private/tmp/notion-candidate-artifacts-procedure';
  const files = [];
  for (const [path, text] of [['.cursor/skills/check/SKILL.md', '# Procedure\n\nReference: refs/check.md (pending)\n'],
    ['.cursor/skills/check/scripts/check.mjs', 'process.stdout.write("review only\\n");\n']]) {
    const evidencePath = 'owned-artifact-files/' + path; await mkdir(dirname(join(evidence, evidencePath)), { recursive: true });
    await writeFile(join(evidence, evidencePath), text, { flag: 'wx' });
    files.push({ path, evidencePath, bytes: Buffer.byteLength(text), sha256: sha(text) });
  }
  const input = { evidence, artifactFiles: { root, files }, final: { success: true, stopReason: 'stop', text: 'Helper and procedure delivered; references pending.' },
    currentNativeCalls: files.map((file, index) => ({ id: 'new-write-' + index, name: 'write', isError: false, arguments: { path: join(root, file.path) } })), requireHelper: true };
  const receipt = await candidate.inspectCandidateProcedureDelivery(input);
  assert.equal(receipt.fullTaskAccepted, false); assert.equal(receipt.executed, false);
  await assert.rejects(() => candidate.inspectCandidateProcedureDelivery({ ...input, artifactFiles: { root, files: files.slice(0, 1) } }), /Node helper/u);
  await assert.rejects(() => candidate.inspectCandidateProcedureDelivery({ ...input, currentNativeCalls: input.currentNativeCalls.slice(1) }), /current.*stage/u);
  await assert.rejects(() => candidate.inspectCandidateProcedureDelivery({ ...input, final: { ...input.final, success: false } }), /final/u);
  const legacy = await candidate.inspectCandidateProcedureDelivery({ evidence, artifactFiles: { root, files: files.slice(0, 1) } });
  assert.equal(legacy.fullTaskAccepted, false, 'The old shared-budget procedure still accepts its original Skill-only stage');
});
