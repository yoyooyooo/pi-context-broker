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

async function alteredParent(t, mutate) {
  const parent = await json(parentPath), evidence = await scratch(t);
  const rows = (await readFile(parent.session.path, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  const guard = (await readFile(parent.artifactOutput.guard, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  parent.evidence = evidence; parent.artifactOutput.ownership.evidence = evidence;
  parent.artifactOutput.guard = join(evidence, 'observation/artifact-output-guard.jsonl');
  parent.artifactOutput.guardHistory = [parent.artifactOutput.guard];
  await mkdir(dirname(parent.artifactOutput.guard), { recursive: true });
  const original = await json(parentPath);
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
