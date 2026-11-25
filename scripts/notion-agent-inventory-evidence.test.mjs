import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as diagnostics from 'node:diagnostics_channel';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { directoryInventoryPlan, captureDirectoryInventorySpawn, verifyNotionAgentDirectoryInventory } from './notion-agent-inventory-evidence.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const now = () => process.hrtime.bigint().toString();

test('inventory grammar excludes shell execution and ripgrep subprocess/configuration features', () => {
  assert.deepEqual(directoryInventoryPlan('pwd; ls -la; rg --files --hidden -g "!.git" | head -50').programs, ['ls', 'rg', 'head']);
  for (const command of ['curl https://example.com', 'pwd; touch changed', 'ls > changed', 'ls $(touch changed)',
    'ls ' + String.fromCharCode(96) + 'touch changed' + String.fromCharCode(96), 'PATH=/other ls', 'rg --pre tool --files',
    'rg --files | bash', 'rg --files | head -n -50', 'ls; ', 'pwd && ls', 'rg --files | head -0', 'rg --files | head -301', 'ls /outside', 'bash -c pwd', 'pwd &', 'ls\\n; pwd'])
    assert.equal(directoryInventoryPlan(command), undefined, command);
});

test('real child inventory permits result before close within its observation; unknown contexts fail', async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'notion-directory-proof-')));
  const command = 'pwd; ls -la', rows = [];
  let captured, optionsObserved;
  const callback = event => {
    if (event.options?.file !== '/bin/bash') return;
    assert.equal(captured, undefined);
    optionsObserved = event.options;
    captured = captureDirectoryInventorySpawn(event.options, { fs, crypto, path });
    assert.ok(captured, 'The actual normalized spawn must produce the bounded proof');
    rows.push({ phase: 'unmatched_child_start', childId: 'owned-child', parentPid: process.pid,
      childPid: null, argumentCount: event.options.args.length, executableSha256: sha(event.options.file), argvSha256: sha(JSON.stringify(event.options.args)), directoryInventory: captured.proof, monotonicNs: now() });
  };
  const startTime = now(), originalSpawn = spawn;
  diagnostics.subscribe('tracing:child_process.spawn:start', callback);
  let child, closed, resultTime;
  try {
    child = spawn('/bin/bash', ['-c', command], { cwd, env: { PATH: '/bin:/usr/bin', SYNTHETIC_API_KEY: 'never-record-this-value' }, stdio: ['ignore', 'pipe', 'pipe'] });
    // The reviewed Pi waiter completes on exit plus both stdio end events; it
    // does not wait for close. Keep their actual times, including the later close.
    let exited = false, stdoutEnded = false, stderrEnded = false;
    const completeResult = () => {
      if (exited && stdoutEnded && stderrEnded) resultTime ??= now();
    };
    child.stdout.once('end', () => { stdoutEnded = true; completeResult(); });
    child.stderr.once('end', () => { stderrEnded = true; completeResult(); });
    child.stdout.resume(); child.stderr.resume();
    child.once('spawn', () => rows.push({ phase: 'unmatched_child_spawn', childId: 'owned-child', parentPid: process.pid, childPid: child.pid, monotonicNs: now() }));
    child.once('exit', (code, signal) => {
      rows.push({ phase: 'unmatched_child_exit', childId: 'owned-child', parentPid: process.pid, childPid: child.pid, code, signal, monotonicNs: now() });
      exited = true; completeResult();
    });
    closed = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        rows.push({ phase: 'unmatched_child_close', childId: 'owned-child', parentPid: process.pid, childPid: child.pid, code, signal,
          directoryInventoryUnchanged: captured?.unchanged() ?? false, monotonicNs: now() });
        resolve({ code, signal });
      });
    });
  } finally { diagnostics.unsubscribe('tracing:child_process.spawn:start', callback); }
  assert.deepEqual(closed, { code: 0, signal: null }); assert.equal(spawn, originalSpawn);
  assert.ok(BigInt(rows[2].monotonicNs) <= BigInt(resultTime));
  assert.ok(BigInt(resultTime) < BigInt(rows[3].monotonicNs), 'Real exit/stdout completion precedes close');
  assert.equal(captured.unchanged(), true);
  assert.equal(JSON.stringify(captured.proof).includes('never-record-this-value'), false);
  const arguments_ = { command }, inputSha256 = sha(JSON.stringify(arguments_));
  const call = { id: 'native-call', name: 'bash', arguments: arguments_,
    event: { toolSource: { source: 'builtin', path: 'builtin:bash' }, pid: process.pid, inputSha256, monotonicNs: startTime },
    result: { pid: process.pid, inputSha256, isError: false, monotonicNs: resultTime } };
  const runtimeEvidence = new Map([[call.id, { implementation: { profile: 'reviewed-test-runtime' },
    toolCallId: call.id, toolName: 'bash', pid: process.pid, inputSha256 }]]);
  const sourceObservationWindow = { startedNs: startTime, endedNs: now() };
  const observed = { source: rows, session: { header: { cwd } }, runtimeEvidence, sourceObservationWindow };
  assert.equal(verifyNotionAgentDirectoryInventory(call, observed).status, 'passed');
  assert.equal(verifyNotionAgentDirectoryInventory({ ...call,
    result: { ...call.result, monotonicNs: sourceObservationWindow.endedNs } }, observed).status, 'passed');
  for (const mutate of [
    x => { x[0].argvSha256 = '0'.repeat(64); },
    x => { x[0].directoryInventory.cwd = '/outside'; },
    x => { delete x[0].directoryInventory.programs; },
    x => { delete x[0].directoryInventory.startup; },
    x => { delete x[0].directoryInventory.actions; },
    x => { delete x[0].directoryInventory.shell.sha256; },
    x => { x[0].directoryInventory.programs[0].uid = 999; },
    x => { x[0].directoryInventory.startup = { kind: 'unknown' }; },
    x => { x[0].parentPid++; },
    x => { x[2].code = 1; },
    x => { x[3].code = 1; },
    x => { x[3].childPid++; },
    x => { x[3].childId = 'other-child'; },
    x => { x[3].directoryInventoryUnchanged = false; },
    x => { x.pop(); },
    x => { x.push({ ...x[0] }); },
    x => { x.push({ ...x[3] }); },
    x => { x[2].monotonicNs = (BigInt(call.result.monotonicNs) + 1n).toString(); },
    x => { x[3].monotonicNs = (BigInt(x[2].monotonicNs) - 1n).toString(); },
    x => { x[3].monotonicNs = (BigInt(sourceObservationWindow.endedNs) + 1n).toString(); },
  ]) {
    const altered = structuredClone(rows); mutate(altered);
    assert.equal(verifyNotionAgentDirectoryInventory(call, { ...observed, source: altered }).status, 'blocked');
  }
  for (const window of [undefined, {},
    { ...sourceObservationWindow, startedNs: 'invalid' },
    { ...sourceObservationWindow, endedNs: 'invalid' },
    { ...sourceObservationWindow, startedNs: (BigInt(startTime) + 1n).toString() },
    { ...sourceObservationWindow, endedNs: (BigInt(resultTime) - 1n).toString() },
    { ...sourceObservationWindow, endedNs: resultTime },
  ]) assert.equal(verifyNotionAgentDirectoryInventory(call, { ...observed, sourceObservationWindow: window }).status, 'blocked');
  assert.equal(verifyNotionAgentDirectoryInventory(call, { ...observed, runtimeEvidence: new Map() }).status, 'blocked');
  const alterEnv = pair => ({ ...optionsObserved, envPairs: [...optionsObserved.envPairs, pair] });
  for (const pair of ['BASH_ENV=/unknown/bootstrap', 'ENV=/unknown', 'BASH_FUNC_ls%%=() { touch changed; }',
    'SHELLOPTS=xtrace', 'RIPGREP_CONFIG_PATH=/unknown', 'LD_PRELOAD=/unknown', 'DYLD_INSERT_LIBRARIES=/unknown'])
    assert.equal(captureDirectoryInventorySpawn(alterEnv(pair), { fs, crypto, path }), undefined, pair.split('=')[0]);
  const shadow = path.join(cwd, 'shadow'); fs.mkdirSync(shadow);
  const beforeShadow = captureDirectoryInventorySpawn({ ...optionsObserved, envPairs: ['PATH=' + shadow + ':/bin:/usr/bin'] }, { fs, crypto, path });
  assert.ok(beforeShadow); assert.equal(beforeShadow.unchanged(), true);
  fs.writeFileSync(path.join(shadow, 'ls'), '#!/bin/bash\\ntouch changed\\n', { mode: 0o755, flag: 'wx' });
  assert.equal(beforeShadow.unchanged(), false);
  const shadowOptions = { ...optionsObserved, envPairs: ['PATH=' + shadow + ':/bin:/usr/bin'] };
  assert.equal(captureDirectoryInventorySpawn(shadowOptions, { fs, crypto, path }), undefined);
  assert.equal(fs.existsSync(path.join(cwd, 'changed')), false);
});
