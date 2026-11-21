import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';

// A protocol fixture, not a model substitute. It exercises the subprocess and
// JSONL ordering at the harness boundary, including native Pi's deferred
// agent_settled -> follow-up -> next agent_settled sequence.
const fixtureSource = String.raw`#!/usr/bin/env node
const { createInterface } = require('node:readline');
const mode = process.env.RPC_FIXTURE_MODE;
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const reply = (command, data) => send({ type: 'response', id: command.id, command: command.type, success: true, data });
const idle = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
let submitted = false, queries = 0, count = 0;
let busyState, busyWaiter;
const busyCheckpoint = command => reply(command, { submitted, queries, count, state: busyState });
const start = () => send({ type: 'agent_start' });
const end = (stopReason = 'stop') => send({ type: 'agent_end', messages: [
  { role: 'assistant', stopReason, content: [{ type: 'text', text: 'answer-' + (++count) }] },
] });
const settled = (aborted = false) => send({ type: 'agent_settled', aborted });
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'prompt') {
    submitted = true;
    if (mode === 'handled' || mode === 'not-invoked') {
      reply(command, mode === 'handled' ? { disposition: 'handled' } : { agentInvoked: false });
      return;
    }
    if (mode !== 'fast-before-ack') reply(command, { disposition: 'started' });
    start();
    if (mode === 'retry') {
      end('error');
      send({ type: 'auto_retry_start', attempt: 1 });
      start();
    }
    if (mode !== 'missing-end') end(mode === 'final-error' ? 'error' : 'stop');
    if (mode === 'omp') send({ type: 'prompt_result', status: 'completed', marker: 'omp-result' });
    else if (mode !== 'end-only') settled(mode === 'aborted');
    if (mode === 'fast-before-ack') reply(command, { disposition: 'started' });
    return;
  }
  if (command.type === 'release') {
    if (mode.startsWith('busy-')) {
      if (!busyState) throw new Error('Release requires the actual busy state query');
      start(); end();
    }
    settled(); reply(command, {}); return;
  }
  if (command.type === 'await_busy') {
    if (!mode.startsWith('busy-')) throw new Error('No busy state in this fixture');
    if (busyState) busyCheckpoint(command);
    else busyWaiter = command;
    return;
  }
  if (command.type === 'checkpoint') { reply(command, { submitted, queries, count }); return; }
  if (command.type === 'get_state') {
    if (!submitted) { reply(command, idle); return; }
    queries++;
    if (mode === 'missing-state') { reply(command, { isStreaming: false }); return; }
    if (mode === 'invalid-pending') { reply(command, { ...idle, pendingMessageCount: -1 }); return; }
    if (mode === 'deadline') {
      setTimeout(() => {
        start(); end(); settled();
        reply(command, { ...idle, isStreaming: queries < 6 });
      }, 70);
      return;
    }
    if (queries === 1 && ['busy-stream', 'busy-queue', 'busy-compaction', 'stale-idle'].includes(mode)) {
      const state = { ...idle };
      if (mode === 'busy-stream') state.isStreaming = true;
      if (mode === 'busy-queue') state.pendingMessageCount = 1;
      if (mode === 'busy-compaction') state.isCompacting = true;
      // A stale idle reply is overtaken by the full next run. Busy-state
      // cases instead wait for an explicit test release, with no newer event
      // to mask an implementation that ignores the state fields.
      if (mode === 'stale-idle') { start(); end(); settled(); }
      reply(command, state);
      if (mode.startsWith('busy-')) {
        busyState = state;
        if (busyWaiter) { busyCheckpoint(busyWaiter); busyWaiter = undefined; }
      }
      return;
    }
    reply(command, idle);
    return;
  }
  throw new Error('Unexpected command ' + command.type);
});
lines.on('close', () => process.exit(0));
`;

async function fixture(t, mode, { host, timeoutMs = 2_000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'broker-rpc-settle-'));
  const executable = join(root, host ?? 'pi-fixture');
  await writeFile(executable, fixtureSource);
  await chmod(executable, 0o700);
  let rpc;
  t.after(async () => { await rpc?.stop().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  // OMP's literal public host name selects its different completion protocol.
  // Only this synthetic test executable is on PATH; real-run launch is untouched.
  const previousPath = process.env.PATH;
  try {
    if (host) process.env.PATH = root + delimiter + previousPath;
    rpc = await startRpc({ host: host ?? executable, cwd: root, timeoutMs,
      env: { ...process.env, RPC_FIXTURE_MODE: mode } });
  } finally { process.env.PATH = previousPath; }
  return rpc;
}

test('Pi agent_end alone cannot finish a prompt, even when a state query would be idle', async t => {
  const rpc = await fixture(t, 'end-only');
  let completed = false;
  const prompt = rpc.prompt('business request').then(frame => { completed = true; return frame; });
  await rpc.command('checkpoint');
  const before = await rpc.command('checkpoint');
  assert.equal(before.count, 1);
  assert.equal(before.queries, 0);
  assert.equal(completed, false);
  await rpc.command('release');
  const result = await prompt;
  assert.equal(result.type, 'agent_end');
  assert.equal((await rpc.command('checkpoint')).queries, 1);
});

for (const mode of ['busy-stream', 'busy-queue', 'busy-compaction', 'stale-idle']) {
  test('Pi ' + mode + ' requires the following settled boundary and a fresh idle response', async t => {
    const rpc = await fixture(t, mode);
    let completed = false;
    const prompt = rpc.prompt('business request').then(frame => { completed = true; return frame; });
    if (mode !== 'stale-idle') {
      // Unrelated round trips do not prove that the harness processed prompt
      // acknowledgement and sent get_state. This reply follows that actual
      // query and its busy response, regardless of pipe/event-loop scheduling.
      const before = await rpc.command('await_busy');
      assert.equal(before.queries, 1);
      assert.equal(before.count, 1);
      assert.deepEqual(before.state, { isStreaming: mode === 'busy-stream',
        isCompacting: mode === 'busy-compaction', pendingMessageCount: mode === 'busy-queue' ? 1 : 0 });
      assert.equal(completed, false);
      await rpc.command('release');
    }
    const result = await prompt;
    assert.equal(result.messages[0].content[0].text, 'answer-2');
    assert.equal((await rpc.command('checkpoint')).queries, 2);
    assert.equal(rpc.frames.filter(frame => frame.type === 'agent_settled').length, 2);
    assert.deepEqual(rpc.frames.filter(frame => frame.type === 'agent_settled'),
      [{ type: 'agent_settled', aborted: false }, { type: 'agent_settled', aborted: false }]);
    const lastState = rpc.frames.findLast(frame => frame.type === 'response' && frame.command === 'get_state');
    assert.deepEqual(lastState.data, { isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  });
}

test('Pi fast settlement before prompt acknowledgement is retained, and low-level retry failure is not final', async t => {
  for (const mode of ['fast-before-ack', 'retry']) {
    const rpc = await fixture(t, mode);
    const result = await rpc.prompt('business request');
    assert.equal(result.messages[0].stopReason, 'stop');
    assert.equal(result.messages[0].content[0].text, mode === 'retry' ? 'answer-2' : 'answer-1');
  }
});

test('Pi handled/no-model commands need no agent_settled event and still prove idle', async t => {
  for (const mode of ['handled', 'not-invoked']) {
    const rpc = await fixture(t, mode);
    assert.equal((await rpc.prompt('/registered-command')).agentInvoked, false);
    assert.equal((await rpc.command('checkpoint')).queries, 1);
    assert.equal(rpc.frames.some(frame => frame.type === 'agent_settled'), false);
  }
});

test('missing settlement fields, missing native end, final error, and abort cannot pass', async t => {
  for (const [mode, pattern] of [
    ['missing-state', /lacks valid Pi settlement fields/],
    ['invalid-pending', /lacks valid Pi settlement fields/],
    ['missing-end', /no preceding agent_end/],
    ['final-error', /assistant error/],
    ['aborted', /prompt failed: aborted/],
  ]) {
    const rpc = await fixture(t, mode);
    await assert.rejects(rpc.prompt('business request'), pattern);
  }
});

test('automatic continuations and get_state share the original total prompt deadline', async t => {
  const rpc = await fixture(t, 'deadline', { timeoutMs: 180 });
  await assert.rejects(rpc.prompt('business request'), /prompt completion timed out after 180ms/);
  assert.ok(rpc.frames.filter(frame => frame.type === 'agent_settled').length >= 2);
  assert.ok(rpc.frames.filter(frame => frame.type === 'agent_settled').length < 7);
});

test('OMP keeps its native prompt_result completion contract', async t => {
  const rpc = await fixture(t, 'omp', { host: 'omp' });
  assert.deepEqual(await rpc.prompt('business request'),
    { type: 'prompt_result', status: 'completed', marker: 'omp-result' });
  assert.equal((await rpc.command('checkpoint')).queries, 0);
  assert.equal(rpc.frames.some(frame => frame.type === 'agent_settled'), false);
});
