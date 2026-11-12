import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { candidateProjectSettings, inspectIntroductionForkSource } from './verify-pi-daily-candidate.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('a public candidate introduction fork requires its unchanged reviewed owned origin', async t => {
  const cwd = await realpath(await mkdtemp('/tmp/notion-candidate-print-'));
  const proof = await realpath(await mkdtemp('/tmp/notion-resume-proof-'));
  t.diagnostic(JSON.stringify({ ownedScratch: [cwd, proof], cleanup: 'Retained for evidence-first system Trash cleanup; never delete by pattern.' }));
  await mkdir(join(cwd, '.pi'));
  const settingsPath = join(cwd, '.pi/settings.json');
  const settings = JSON.stringify(candidateProjectSettings('/old/live-broker', '/frozen/v3-broker')) + '\n';
  await writeFile(settingsPath, settings, { flag: 'wx' });
  const rows = [
    { type: 'session', id: 'owned-introduction', version: 3, cwd, timestamp: '2026-11-11T00:00:00.000Z' },
    { type: 'model_change', id: 'model', parentId: null, provider: 'magpie', modelId: 'group/worker' },
    { type: 'message', id: 'user', parentId: 'model', message: { role: 'user', content: [{ type: 'text', text: 'Introduce the named Skill; do not execute it.' }] } },
    { type: 'message', id: 'call', parentId: 'user', message: { role: 'assistant', provider: 'magpie', model: 'group/worker', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'sr:Roriginal-reference' } }] } },
    { type: 'message', id: 'result', parentId: 'call', message: { role: 'toolResult', toolName: 'read', toolCallId: 'read-1', isError: false, content: [{ type: 'text', text: 'Complete reference.' }], details: { effects: { version: 1, remote_writes: 'none', author_content: 'unchanged', retention: [] } } } },
    { type: 'message', id: 'answer', parentId: 'result', message: { role: 'assistant', provider: 'magpie', model: 'group/worker', stopReason: 'stop', content: [{ type: 'text', text: 'The requested introduction.' }] } },
  ];
  const native = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const nativePath = join(proof, 'native.jsonl');
  await writeFile(nativePath, native, { flag: 'wx' });
  const previous = { scope: 'project-scoped-candidate-print', status: 'passed', expectedUserMessages: 1,
    assertions: { scriptExecutionToolCalls: 0, ownedProjectInspectionToolCalls: 0 },
    launch: { cwd }, baselineFiles: [{ realpath: '/frozen/v3-broker/package.json' }],
    session: { path: nativePath, sha256: sha(native) } };
  const options = {};

  await t.test('default resume still rejects a changed candidate package mapping', async () => {
    assert.throws(() => assert.deepEqual(JSON.parse(settings), candidateProjectSettings('/old/live-broker', '/frozen/v4-broker')));
    const before = { settings: sha(await readFile(settingsPath)), native: sha(await readFile(nativePath)) };
    const review = await inspectIntroductionForkSource(previous, options);
    assert.equal(review.originalCwd, cwd); assert.equal(review.originalBrokerRoot, '/frozen/v3-broker');
    assert.equal(review.native.sha256, before.native);
    assert.equal(sha(await readFile(settingsPath)), before.settings); assert.equal(sha(await readFile(nativePath)), before.native);
  });
  await t.test('rejects both prior and requested owned application projects', async () => {
    await assert.rejects(inspectIntroductionForkSource({ ...previous, project: { kind: 'owned-ticket-service' } }, options));
    await assert.rejects(inspectIntroductionForkSource(previous, { ...options, project: 'owned-ticket-service' }));
  });
  await t.test('rejects failed parents, wrong turn counts and execution-capable prior tasks', async () => {
    await assert.rejects(inspectIntroductionForkSource({ ...previous, status: 'failed' }, options));
    for (const expectedUserMessages of [0, -1, 1.5, 2]) {
      await assert.rejects(inspectIntroductionForkSource({ ...previous, expectedUserMessages }, options));
    }
    await assert.rejects(inspectIntroductionForkSource({ ...previous, assertions: { ...previous.assertions, scriptExecutionToolCalls: 1 } }, options));
    await assert.rejects(inspectIntroductionForkSource({ ...previous, assertions: { ...previous.assertions, ownedProjectInspectionToolCalls: 1 } }, options));
  });
  await t.test('does not inspect or alter unrelated content in the old cwd', async () => {
    const extra = join(cwd, 'README.md'); await writeFile(extra, 'not an empty introduction cwd\n', { flag: 'wx' });
    try {
      assert.equal((await inspectIntroductionForkSource(previous, options)).native.sha256, sha(native));
      assert.equal(await readFile(extra, 'utf8'), 'not an empty introduction cwd\n');
    } finally { await rename(extra, join(proof, 'extra-cwd-file.md')); }
  });
  await t.test('does not bind archived history to current old cwd settings or registration', async () => {
    const wrong = JSON.stringify(candidateProjectSettings('/old/live-broker', '/unbound/broker'));
    await writeFile(settingsPath, wrong);
    try {
      assert.equal((await inspectIntroductionForkSource(previous, options)).native.sha256, sha(native));
      assert.equal(await readFile(settingsPath, 'utf8'), wrong);
    } finally {
      await writeFile(join(proof, 'wrong-settings.json'), wrong, { flag: 'wx' });
      await writeFile(settingsPath, settings);
    }
  });
  await t.test('accepts the bound original session after its old cwd has been cleaned', async () => {
    const retained = join(proof, 'retained-old-cwd');
    await rename(cwd, retained);
    try {
      const review = await inspectIntroductionForkSource(previous, options);
      assert.equal(review.originalCwd, cwd); assert.equal(review.native.sha256, sha(native));
      await assert.rejects(realpath(cwd), { code: 'ENOENT' });
    } finally { await rename(retained, cwd); }
  });
  await t.test('accepts every unchanged turn of an already-bound public fork', async () => {
    const forkCwd = '/private/tmp/notion-candidate-print-already-cleaned';
    const history = rows.slice(1).map(row => JSON.stringify(row)).join('\n') + '\n';
    const binding = { parentSession: nativePath, sourceSessionId: rows[0].id, cwd: forkCwd,
      history: { bytes: Buffer.byteLength(history), sha256: sha(history), entries: rows.length - 1 } };
    const continued = [
      { ...rows[0], id: 'continued-introduction', cwd: forkCwd, parentSession: nativePath }, ...rows.slice(1),
      { type: 'message', id: 'user-2', parentId: 'answer', message: { role: 'user', content: [{ type: 'text', text: 'Review the preceding introduction against the sources already read.' }] } },
      { type: 'message', id: 'answer-2', parentId: 'user-2', message: { role: 'assistant', provider: 'magpie', model: 'group/worker', stopReason: 'stop', content: [{ type: 'text', text: 'The complete reviewed introduction.' }] } },
    ];
    const bytes = continued.map(row => JSON.stringify(row)).join('\n') + '\n';
    const path = join(proof, 'continued-native.jsonl'); await writeFile(path, bytes, { flag: 'wx' });
    const parent = { ...previous, expectedUserMessages: 2, launch: { cwd: forkCwd, introductionFork: { binding } }, session: { path, sha256: sha(bytes) } };
    const review = await inspectIntroductionForkSource(parent, options);
    assert.equal(review.header.parentSession, nativePath); assert.equal(review.history.entries, continued.length - 1);
    assert.equal(review.history.sha256, sha(bytes.slice(bytes.indexOf('\n') + 1)));
    assert.equal(sha(await readFile(path)), sha(bytes)); assert.equal(sha(await readFile(nativePath)), sha(native));
    await assert.rejects(inspectIntroductionForkSource({ ...parent, launch: { cwd: forkCwd } }, options));
    for (const bad of [{ ...binding, parentSession: '/unbound.jsonl' }, { ...binding, history: { ...binding.history, sha256: '0'.repeat(64) } }]) {
      await assert.rejects(inspectIntroductionForkSource({ ...parent, launch: { cwd: forkCwd, introductionFork: { binding: bad } } }, options));
    }
  });
  await t.test('rejects original native prefix drift and accepts only its restored exact bytes', async () => {
    const drifted = native + '{}\n'; await writeFile(nativePath, drifted);
    await assert.rejects(inspectIntroductionForkSource(previous, options));
    await writeFile(join(proof, 'drifted-native.jsonl'), drifted, { flag: 'wx' });
    await writeFile(nativePath, native);
    const after = await inspectIntroductionForkSource(previous, options);
    assert.equal(after.native.sha256, sha(native));
  });
  await t.test('a readOnly argument cannot replace complete successful none effects', async () => {
    const none = { version: 1, remote_writes: 'none', author_content: 'unchanged', retention: [] };
    const variants = [
      { effects: undefined, isError: false },
      { effects: { ...none, remote_writes: 'unknown' }, isError: false },
      { effects: { ...none, remote_writes: 'retained', retention: [{ snapshot_id: 'retained' }] }, isError: false },
      { effects: { ...none, retention: [{ snapshot_id: 'inconsistent' }] }, isError: false },
      { effects: none, isError: true },
    ];
    for (const [index, variant] of variants.entries()) {
      const changed = structuredClone(rows);
      changed[3].message.content[0].arguments.readOnly = true;
      changed[4].message.details = { effects: variant.effects }; changed[4].message.isError = variant.isError;
      const bytes = changed.map(row => JSON.stringify(row)).join('\n') + '\n';
      await writeFile(nativePath, bytes);
      await writeFile(join(proof, 'invalid-effects-' + index + '.jsonl'), bytes, { flag: 'wx' });
      await assert.rejects(inspectIntroductionForkSource({ ...previous, session: { path: nativePath, sha256: sha(bytes) } }, options));
    }
    await writeFile(nativePath, native);
    assert.equal((await inspectIntroductionForkSource(previous, options)).native.sha256, sha(native));
  });
});
