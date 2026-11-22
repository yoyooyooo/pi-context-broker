import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../control/probe-lifecycle-fixtures');
const probeUrl = new URL('./runtime/probe-child.mjs', import.meta.url).href;
const rpcUrl = new URL('../packages/context-broker/scripts/context-broker-rpc-harness.mjs', import.meta.url).href;
const nonce = '0123456789abcdef0123456789abcdef';
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
async function until(check, message, timeoutMs = 6000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error(message);
}
async function json(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}
function launch(file, args, options) {
  const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout = (stdout + value).slice(-32768); });
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-32768); });
  const closed = new Promise((resolveClose, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
  void closed.catch(() => {});
  return { child, closed, output: () => ({ stdout, stderr }) };
}
async function boundedClose(processHandle, timeoutMs = 8000) {
  let timer;
  try {
    return await Promise.race([processHandle.closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture process did not exit: ' +
        JSON.stringify(processHandle.output()))), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
function killGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

const wrapperSource = String.raw`#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { appendFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const root = process.env.PAIRED_RUN_ROOT;
const record = event => appendFileSync(join(root, 'fixture-events.jsonl'),
  JSON.stringify({ event, pid: process.pid }) + '\n');
process.on('SIGTERM', () => {
  record('wrapper_sigterm');
  if (process.env.FIXTURE_LEADER_EXITS === '1') process.exit(0);
});
process.on('SIGINT', () => record('wrapper_sigint'));
const descendant = spawn(process.execPath, ['-e', [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const root = process.env.PAIRED_RUN_ROOT;",
  "process.on('SIGTERM', () => {});",
  "process.on('SIGINT', () => {});",
  "fs.writeFileSync(path.join(root, 'descendant-ready.json'), JSON.stringify({ pid: process.pid }));",
  "setInterval(() => {}, 1000);",
].join('\n')], { stdio: ['ignore', 'inherit', 'inherit'] });
writeFileSync(join(root, 'wrapper-ready.json'), JSON.stringify({
  pid: process.pid, descendant: descendant.pid,
}));
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    setTimeout(() => process.stdout.write(JSON.stringify({
      type: 'response', id: command.id, command: command.type, success: true,
      data: { model: { provider: 'benchmark-phase0', id: 'no-request' },
        thinkingLevel: 'off', isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
    }) + '\n'), 100);
  } else if (command.type === 'get_commands') {
    writeFileSync(join(root, 'get-commands-held.json'), JSON.stringify({ pid: process.pid }));
    // Deliberately do not answer, and ignore SIGTERM. This is an actual child
    // process boundary test, never a model substitute or a successful probe.
  } else {
    record('unexpected_command_' + command.type);
  }
});
setInterval(() => {}, 1000);
`;

async function fixture(t, { deadlineMs, signal, leaderExits = false, heldStart = false }) {
  await mkdir(testRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(testRoot, 'run-'));
  await mkdir(join(root, 'bin'), { mode: 0o700 });
  const observer = join(root, 'observer.mjs');
  await writeFile(observer, '// Unloaded lifecycle-only fixture.\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(root, 'bin/pi'), wrapperSource, { flag: 'wx', mode: 0o700 });
  await chmod(join(root, 'bin/pi'), 0o700);

  const sentinelFile = join(root, 'sentinel.json');
  const sentinel = launch(process.execPath, ['-e', `
    const fs = require('node:fs');
    let count = 0;
    setInterval(() => fs.writeFileSync(${JSON.stringify(sentinelFile)},
      JSON.stringify({ pid: process.pid, count: ++count })), 25);
  `], { detached: true });
  let harness;
  let ownedPids;
  t.after(async () => {
    // Kill only process groups created by this fixture, including on assertion
    // failure. Generated evidence remains under the task-owned control folder.
    if (harness && harness.child.exitCode === null && harness.child.signalCode === null) {
      killGroup(harness.child.pid);
    }
    if (ownedPids) killGroup(ownedPids.pid);
    killGroup(sentinel.child.pid);
    await Promise.allSettled([sentinel.closed, harness?.closed].filter(Boolean));
    t.diagnostic('Lifecycle evidence retained: ' + root);
  });
  await until(async () => (await json(sentinelFile))?.count > 1, 'sentinel never became live');

  const driver = join(root, 'driver.mjs');
  await writeFile(driver, `
    import { runPhaseZeroProbe } from ${JSON.stringify(probeUrl)};
    import { startRpc } from ${JSON.stringify(rpcUrl)};
    import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const root = process.env.PAIRED_RUN_ROOT;
    process.on('SIGTERM', () => writeFileSync(join(root, 'signal-received.json'), JSON.stringify({ signal: 'SIGTERM' })));
    process.on('SIGINT', () => writeFileSync(join(root, 'signal-received.json'), JSON.stringify({ signal: 'SIGINT' })));
    const startRpcForTesting = ${heldStart ? `async options => {
      const handle = await startRpc(options);
      writeFileSync(join(root, 'start-held.json'), JSON.stringify({ held: true }));
      while (!existsSync(join(root, 'release-start'))) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return handle;
    }` : 'startRpc'};
    const result = await runPhaseZeroProbe({
      args: ${JSON.stringify([nonce, observer])},
      deadlineMs: ${deadlineMs},
      startRpcForTesting,
    });
    process.stdout.write(JSON.stringify({ status: result.status }) + '\\n');
    process.exitCode = result.status === 'passed' ? 0 : 1;
  `, { flag: 'wx', mode: 0o600 });
  const started = performance.now();
  harness = launch(process.execPath, [driver], {
    detached: true, cwd: root,
    env: { ...process.env, PAIRED_RUN_ROOT: root, FIXTURE_LEADER_EXITS: leaderExits ? '1' : '0' },
  });
  await until(async () => {
    ownedPids = await json(join(root, 'wrapper-ready.json'));
    return ownedPids && await json(join(root, 'descendant-ready.json'));
  }, 'owned wrapper and descendant never became live');
  assert.notEqual(ownedPids.pid, sentinel.child.pid);
  assert.ok(alive(ownedPids.pid));
  assert.ok(alive(ownedPids.descendant));

  if (signal) {
    await until(async () => json(join(root, heldStart ? 'start-held.json' : 'get-commands-held.json')),
      'probe never reached the cancellation checkpoint');
    assert.equal(harness.child.kill(signal), true);
    await until(async () => (await json(join(root, 'signal-received.json')))?.signal === signal,
      'signal was not delivered to the real harness');
    if (heldStart) await writeFile(join(root, 'release-start'), 'release\n', { flag: 'wx' });
  }
  const exit = await boundedClose(harness);
  const elapsedMs = performance.now() - started;
  assert.deepEqual(exit, { code: 1, signal: null }, JSON.stringify(harness.output()));
  assert.ok(elapsedMs < 8000, 'one total budget plus owned cleanup must bound process lifetime');
  const probe = await json(join(root, 'benchmark/probe.json'));
  assert.equal(probe.status, 'failed');
  assert.equal(probe.control_scope.business_tasks_submitted, 0);
  assert.equal(probe.lifecycle_control.total_deadline_ms, deadlineMs);
  assert.equal(probe.lifecycle_control.termination.kind, signal ? 'signal' : 'deadline');
  if (signal) assert.equal(probe.lifecycle_control.termination.signal, signal);
  assert.equal(probe.lifecycle_control.cleanup.owned_pid, ownedPids.pid);
  assert.equal(probe.lifecycle_control.cleanup.converged, true);
  if (leaderExits) assert.equal(probe.lifecycle_control.cleanup.group_kill_fallback, true);
  if (heldStart) assert.deepEqual(probe.control_scope.commands, []);
  else assert.deepEqual(probe.control_scope.commands.map(command => command.type),
    ['get_state', 'get_commands']);
  const frames = await json(join(root, 'benchmark/rpc-frames.json'));
  const lifecycle = await json(join(root, 'benchmark/lifecycle.json'));
  assert.ok(Array.isArray(frames));
  assert.ok(lifecycle.some(event => event.event === 'spawn' && event.pid === ownedPids.pid));
  assert.ok(lifecycle.some(event => event.event === 'close' && event.pid === ownedPids.pid));
  await until(() => !alive(ownedPids.pid) && !alive(ownedPids.descendant),
    'owned wrapper or descendant survived cleanup', 1000);
  const before = await json(sentinelFile);
  await until(async () => (await json(sentinelFile))?.count > before.count,
    'independent sentinel stopped making progress', 1000);
  assert.ok(alive(sentinel.child.pid));
  assert.equal(sentinel.child.exitCode, null);
  assert.equal(sentinel.child.signalCode, null);
  return { root, probe, elapsedMs };
}

test('one total probe deadline stops a hung real RPC group and preserves failure evidence', {
  skip: process.platform === 'win32', timeout: 12000,
}, async t => {
  await fixture(t, { deadlineMs: 1000 });
});

test('SIGTERM cleans descendants even after their RPC leader exits, without touching an independent process', {
  skip: process.platform === 'win32', timeout: 12000,
}, async t => {
  await fixture(t, { deadlineMs: 10000, signal: 'SIGTERM', leaderExits: true });
});

test('SIGINT before startRpc handle assignment adopts and stops the pending real child', {
  skip: process.platform === 'win32', timeout: 12000,
}, async t => {
  await fixture(t, { deadlineMs: 10000, signal: 'SIGINT', heldStart: true });
});
