import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import * as candidate from './verify-pi-daily-candidate.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const sourceHeader = { type: 'session', version: 3, id: 'original', timestamp: '2026-11-11T00:00:00.000Z', cwd: '/private/tmp/notion-candidate-print-old' };
const history = [
  { type: 'model_change', id: 'model', parentId: null, provider: 'magpie', modelId: 'group/worker' },
  { type: 'message', id: 'user', parentId: 'model', message: { role: 'user', content: [{ type: 'text', text: '介绍该 Skill。' }] } },
  { type: 'message', id: 'answer', parentId: 'user', message: { role: 'assistant', provider: 'magpie', model: 'group/worker', stopReason: 'stop', content: [{ type: 'text', text: '完整介绍。' }] } },
];
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const historyText = lines(history);
const fork = { parentSession: '/owned/C1.jsonl', sourceSessionId: sourceHeader.id, cwd: '/private/tmp/notion-candidate-print-new',
  history: { bytes: Buffer.byteLength(historyText), sha256: sha(historyText), entries: history.length } };
const forkHeader = { ...sourceHeader, id: 'forked', cwd: fork.cwd, parentSession: fork.parentSession };
const options = { provider: 'magpie', model: 'group/worker' };

test('default linear inspection remains unchanged and rejects an unbound fork', () => {
  assert.equal(candidate.inspectCandidatePrintSession(lines([sourceHeader, ...history]), options).sessionId, 'original');
  assert.throws(() => candidate.inspectCandidatePrintSession(lines([forkHeader, ...history]), options));
});

test('an explicit public fork binds its new header and exact ordered non-header history', () => {
  const inspected = candidate.inspectCandidatePrintSession(lines([forkHeader, ...history]), { ...options, fork });
  assert.equal(inspected.sessionId, 'forked');
  assert.equal(inspected.fork.history.sha256, fork.history.sha256);
  assert.equal(inspected.fork.history.entries, history.length);
});

test('fork inspection rejects wrong parent/cwd/id, reordered or changed history and a wrong byte bound', () => {
  for (const header of [{ ...forkHeader, parentSession: '/wrong.jsonl' }, { ...forkHeader, cwd: '/wrong' }, { ...forkHeader, id: sourceHeader.id }]) {
    assert.throws(() => candidate.inspectCandidatePrintSession(lines([header, ...history]), { ...options, fork }));
  }
  for (const entries of [[history[1], history[0], history[2]], [history[0], history[1], { ...history[2], note: 'changed' }], history.slice(0, -1)]) {
    assert.throws(() => candidate.inspectCandidatePrintSession(lines([forkHeader, ...entries]), { ...options, fork }));
  }
  assert.throws(() => candidate.inspectCandidatePrintSession(lines([forkHeader, ...history]), { ...options, fork: { ...fork, history: { ...fork.history, bytes: fork.history.bytes - 1 } } }));
});

test('the disproven isolated linear resume option is rejected before filesystem/auth/launch work', async () => {
  await assert.rejects(candidate.runCandidatePrint({ version: 1, scope: 'project-scoped-candidate-print', id: 'old-resume', arm: 'normal',
    model: 'magpie/group/worker', thinkingLevel: 'high', prompt: '沿用刚才内容。', isolateResumeCwd: true, resumeFrom: {} }), /isolateResumeCwd.*--fork/u);
});

test('introduction fork rejects slash commands and project paths before filesystem/auth/launch work', async () => {
  const config = { version: 1, scope: 'project-scoped-candidate-print', id: 'fork', arm: 'normal', model: 'magpie/group/worker', thinkingLevel: 'high',
    prompt: '沿用刚才内容。', forkIntroductionResume: true, resumeFrom: {} };
  await assert.rejects(candidate.runCandidatePrint({ ...config, prompt: '/some-command' }), /non-slash/u);
  await assert.rejects(candidate.runCandidatePrint({ ...config, project: 'owned-ticket-service' }), /introduction/u);
});

test('the notion-only introduction fork reaches the same auth boundary before any filesystem or launch work', async () => {
  const token = process.env.NOTION_API_TOKEN;
  delete process.env.NOTION_API_TOKEN;
  try {
    await assert.rejects(candidate.runCandidatePrint({ version: 1, scope: 'project-scoped-candidate-print', id: 'fork-ns', arm: 'notion-only',
      model: 'magpie/group/worker', thinkingLevel: 'high', prompt: 'Review the previous introduction.', forkIntroductionResume: true, resumeFrom: {},
      evidenceRoot: '/unopened-evidence', brokerRoot: '/unopened-broker', sourceId: 'owned', database: 'owned' }), /already authorized Notion identity/u);
  } finally {
    if (token === undefined) delete process.env.NOTION_API_TOKEN; else process.env.NOTION_API_TOKEN = token;
  }
});

function guardFixture(nativeSkillCount = 69) {
  const bytes = Buffer.from('frozen broker entry\n'), entry = '/frozen/broker/src/index.ts', prompt = '沿用刚才内容，不执行工作流。';
  const expected = { entry: { realpath: entry, sha256: sha(bytes) }, cwd: fork.cwd, promptSha256: sha(prompt), provider: 'magpie', model: 'group/worker', thinkingLevel: 'high', nativeSkillCount };
  const handlers = new Map(), rows = [], commands = [{ name: 'context-broker', source: 'extension', sourceInfo: { path: entry } },
    ...Array.from({ length: nativeSkillCount }, (_, i) => ({ name: 'skill:' + i, source: 'skill' }))];
  const api = { on: (name, fn) => handlers.set(name, fn), getCommands: () => commands, getThinkingLevel: () => 'high' };
  const fs = { realpathSync: path => path, readFileSync: () => bytes, writeFileSync: (_path, text) => rows.push(JSON.parse(text)),
    appendFileSync: (_path, text) => rows.push(JSON.parse(text)) };
  const ctx = { cwd: expected.cwd, model: { provider: 'magpie', id: 'group/worker' } };
  return { bytes, entry, prompt, expected, handlers, rows, commands, api, fs, ctx };
}
function install(fixture) {
  assert.equal(typeof candidate.guardCandidateInputIdentity, 'function');
  candidate.guardCandidateInputIdentity(fixture.api, { fs: fixture.fs, crypto: { createHash }, output: '/owned/input-guard.jsonl', expected: fixture.expected });
  assert.deepEqual([...fixture.handlers.keys()], ['input']);
  return () => fixture.handlers.get('input')({ text: fixture.prompt }, fixture.ctx);
}

test('the independent input guard passes only the exact public host identity and unchanged prompt', () => {
  const f = guardFixture(), input = install(f);
  assert.deepEqual(input(), { action: 'continue' }); assert.equal(f.rows.length, 1); assert.equal(f.rows[0].allowed, true);
  assert.equal(f.rows[0].observed.nativeSkillCount, 69); assert.equal(f.rows[0].observed.entry.sha256, f.expected.entry.sha256);
});

test('the notion-only input guard requires exactly zero native Skill commands', () => {
  const f = guardFixture(0);
  assert.deepEqual(install(f)(), { action: 'continue' }); assert.equal(f.rows[0].observed.nativeSkillCount, 0);
  const changed = guardFixture(0); changed.commands.push({ name: 'skill:unexpected', source: 'skill' });
  assert.deepEqual(install(changed)(), { action: 'handled' }); assert.equal(changed.rows[0].allowed, false);
});

test('identity and prompt mismatches are recorded and explicitly handled before a provider call', () => {
  const changes = [
    f => { f.commands[0].sourceInfo.path = '/old/broker/src/index.ts'; },
    f => { f.fs.readFileSync = () => Buffer.from('changed'); },
    f => { f.commands.push(f.commands[0]); },
    f => { f.commands.shift(); },
    f => { f.ctx.cwd = '/old/cwd'; },
    f => { f.ctx.model.provider = 'different'; },
    f => { f.ctx.model.id = 'group/flash'; },
    f => { f.api.getThinkingLevel = () => 'low'; },
    f => { f.commands.pop(); },
    f => { f.prompt += ' changed'; },
  ];
  for (const change of changes) {
    const f = guardFixture(); change(f); const input = install(f); let providers = 0;
    if (input().action !== 'handled') providers++;
    assert.equal(providers, 0); assert.equal(f.rows.length, 1); assert.equal(f.rows[0].allowed, false);
  }
});

test('lookup/realpath/read errors stay handled with a failure receipt instead of escaping to host catch-and-continue', () => {
  for (const method of ['getCommands', 'getThinkingLevel', 'realpathSync', 'readFileSync']) {
    const f = guardFixture(); (method.startsWith('get') ? f.api : f.fs)[method] = () => { throw new Error('injected ' + method); };
    assert.deepEqual(install(f)(), { action: 'handled' }); assert.equal(f.rows[0].allowed, false); assert.match(f.rows[0].error.message, /injected/u);
  }
});

test('failure to persist the guard receipt also handles the input and records a stderr fallback', () => {
  const f = guardFixture(); f.fs.writeFileSync = () => { throw new Error('ledger unwritable'); };
  const input = install(f), original = process.stderr.write; let stderr = '';
  process.stderr.write = chunk => { stderr += chunk; return true; };
  try { assert.deepEqual(input(), { action: 'handled' }); } finally { process.stderr.write = original; }
  assert.equal(f.rows.length, 0); assert.match(stderr, /ledger unwritable/u); assert.match(stderr, /"allowed":false/u);
});

test('the serialized independent extension needs no module closure and allows only one frozen input', () => {
  const f = guardFixture();
  const serialized = new Function('return (' + candidate.guardCandidateInputIdentity.toString() + ');')();
  serialized(f.api, { fs: f.fs, crypto: { createHash }, output: '/owned/input-guard.jsonl', expected: f.expected });
  const input = f.handlers.get('input');
  assert.deepEqual(input({ text: f.prompt }, f.ctx), { action: 'continue' });
  assert.deepEqual(input({ text: f.prompt }, f.ctx), { action: 'handled' });
  assert.deepEqual(f.rows.map(row => row.allowed), [true, false]);
});
