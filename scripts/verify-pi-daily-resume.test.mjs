import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { candidateProjectSettings, inspectIsolatedIntroductionResume } from './verify-pi-daily-candidate.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('a candidate-package warm introduction uses a new cwd only after binding its unchanged owned origin', async t => {
  const cwd = await realpath(await mkdtemp('/tmp/notion-candidate-print-'));
  const proof = await realpath(await mkdtemp('/tmp/notion-resume-proof-'));
  t.diagnostic(JSON.stringify({ ownedScratch: [cwd, proof], cleanup: 'Retained for evidence-first system Trash cleanup; never delete by pattern.' }));
  await mkdir(join(cwd, '.pi'));
  const settingsPath = join(cwd, '.pi/settings.json');
  const settings = JSON.stringify(candidateProjectSettings('/old/live-broker', '/frozen/v3-broker')) + '\n';
  await writeFile(settingsPath, settings, { flag: 'wx' });
  const rows = [
    { type: 'session', id: 'owned-introduction', version: 3 },
    { type: 'model_change', id: 'model', parentId: null, provider: 'magpie', modelId: 'group/worker' },
    { type: 'message', id: 'user', parentId: 'model', message: { role: 'user', content: [{ type: 'text', text: 'Introduce the named Skill; do not execute it.' }] } },
    { type: 'message', id: 'call', parentId: 'user', message: { role: 'assistant', provider: 'magpie', model: 'group/worker', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'sr:Roriginal-reference', readOnly: true } }] } },
    { type: 'message', id: 'result', parentId: 'call', message: { role: 'toolResult', toolName: 'read', toolCallId: 'read-1', isError: false, content: [{ type: 'text', text: 'Complete reference.' }] } },
    { type: 'message', id: 'answer', parentId: 'result', message: { role: 'assistant', provider: 'magpie', model: 'group/worker', stopReason: 'stop', content: [{ type: 'text', text: 'The requested introduction.' }] } },
  ];
  const native = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const nativePath = join(proof, 'native.jsonl');
  await writeFile(nativePath, native, { flag: 'wx' });
  const previous = { scope: 'project-scoped-candidate-print', status: 'passed', expectedUserMessages: 1,
    assertions: { scriptExecutionToolCalls: 0, ownedProjectInspectionToolCalls: 0 },
    launch: { cwd }, baselineFiles: [{ realpath: '/frozen/v3-broker/package.json' }],
    session: { path: nativePath, sha256: sha(native) } };
  const options = { oldSource: '/old/live-broker' };

  await t.test('default resume still rejects a changed candidate package mapping', async () => {
    assert.throws(() => assert.deepEqual(JSON.parse(settings), candidateProjectSettings('/old/live-broker', '/frozen/v4-broker')));
    const before = { settings: sha(await readFile(settingsPath)), native: sha(await readFile(nativePath)) };
    const review = await inspectIsolatedIntroductionResume(previous, options);
    assert.equal(review.originalCwd, cwd); assert.equal(review.originalBrokerRoot, '/frozen/v3-broker');
    assert.equal(review.settings.sha256, before.settings); assert.equal(review.native.sha256, before.native);
    assert.equal(sha(await readFile(settingsPath)), before.settings); assert.equal(sha(await readFile(nativePath)), before.native);
  });
  await t.test('rejects both prior and requested owned application projects', async () => {
    await assert.rejects(inspectIsolatedIntroductionResume({ ...previous, project: { kind: 'owned-ticket-service' } }, options));
    await assert.rejects(inspectIsolatedIntroductionResume(previous, { ...options, project: 'owned-ticket-service' }));
  });
  await t.test('rejects failed parents, already-continued histories and execution-capable prior tasks', async () => {
    await assert.rejects(inspectIsolatedIntroductionResume({ ...previous, status: 'failed' }, options));
    await assert.rejects(inspectIsolatedIntroductionResume({ ...previous, expectedUserMessages: 2 }, options));
    await assert.rejects(inspectIsolatedIntroductionResume({ ...previous, assertions: { ...previous.assertions, scriptExecutionToolCalls: 1 } }, options));
  });
  await t.test('rejects extra original cwd content without copying or deleting it', async () => {
    const extra = join(cwd, 'README.md'); await writeFile(extra, 'not an empty introduction cwd\n', { flag: 'wx' });
    await assert.rejects(inspectIsolatedIntroductionResume(previous, options));
    await rename(extra, join(proof, 'extra-cwd-file.md'));
  });
  await t.test('rejects wrong original package settings', async () => {
    const wrong = JSON.stringify(candidateProjectSettings('/old/live-broker', '/unbound/broker'));
    await writeFile(settingsPath, wrong);
    await assert.rejects(inspectIsolatedIntroductionResume(previous, options));
    await writeFile(join(proof, 'wrong-settings.json'), wrong, { flag: 'wx' });
    await writeFile(settingsPath, settings);
  });
  await t.test('rejects original native prefix drift and accepts only its restored exact bytes', async () => {
    const drifted = native + '{}\n'; await writeFile(nativePath, drifted);
    await assert.rejects(inspectIsolatedIntroductionResume(previous, options));
    await writeFile(join(proof, 'drifted-native.jsonl'), drifted, { flag: 'wx' });
    await writeFile(nativePath, native);
    const after = await inspectIsolatedIntroductionResume(previous, options);
    assert.equal(after.settings.sha256, sha(settings)); assert.equal(after.native.sha256, sha(native));
  });
});
