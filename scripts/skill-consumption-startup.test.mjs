import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNotionFixture, database } from './notion-integration-fixture.mjs';
import { parseStartupArgs, reconcileStartupBatch, summarizeStartupSample } from './skill-consumption-startup.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'skill-consumption-startup.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'startup-cost-test-'));
after(() => { if (existsSync('/usr/bin/trash')) execFileSync('/usr/bin/trash', [scratch]); });
const ns = value => (BigInt(value) * 1000000n).toString();
const input = ({ providerAt = 2030, endAt = 2032, directoryAt = 2020, failedList = false } = {}) => ({
  scenario: { id: 'case', group: 'cold-delay', cache: 'cold', session: 'new', failList: failedList },
  submission: { monotonicNs: ns(10), boundary: 'immediately-before-native-rpc-prompt-call' },
  observerEvents: [{ phase: 'message_update', firstEffectiveText: true, monotonicNs: ns(providerAt + 1) },
    { phase: 'agent_end', monotonicNs: ns(endAt) }, { phase: 'observer_end', complete: true, monotonicNs: ns(2400) }],
  providerCalls: [{ monotonicNs: ns(providerAt), context: { bytes: 100 }, skillBodyMarkerCount: 0, resourceMarkerCount: 0 }],
  sourceCalls: [{ id: 's', command: 'list', phase: 'source-start', monotonicNs: ns(20) },
    { id: 's', command: 'list', phase: 'source-close', monotonicNs: ns(directoryAt), code: failedList ? 1 : 0, signal: null, stdoutBytes: 90, stderrBytes: 0 }],
  lifecycle: [{ event: 'spawn', boundary: 'spawnHost-return', pid: 1, monotonicNs: ns(1) },
    { event: 'close', boundary: 'child-close-event', pid: 1, code: 0, signal: null, monotonicNs: ns(2400) }],
  rpcFrames: [{ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'OK' }] }] }],
});

test('startup summary distinguishes directory-blocked dispatch from an early ordinary turn with background work', () => {
  const blocked = summarizeStartupSample(input());
  assert.equal(blocked.status, 'observed'); assert.equal(blocked.timings.submitToFirstProviderMs, 2020);
  assert.equal(blocked.directory.providerAfterAllObservedListCompletions, true);
  assert.equal(blocked.consumption.beforeProviderHookEvents, 0);
  assert.equal(blocked.consumption.modelHttpAttempts, null); assert.equal(blocked.consumption.inputTokens, null);
  const early = summarizeStartupSample(input({ providerAt: 30, endAt: 32 }));
  assert.equal(early.status, 'observed'); assert.equal(early.timings.submitToFirstProviderMs, 20);
  assert.equal(early.directory.providerAfterAllObservedListCompletions, false);
  assert.equal(early.consumption.activeSourceCallsAtCompletion, 1);
  assert.equal(early.calls[0].durationMs, 2000);
});

test('directory failures remain measured and missing close/end evidence cannot masquerade as a completed measurement', () => {
  const failed = summarizeStartupSample(input({ failedList: true }));
  assert.equal(failed.taskStatus, 'completed'); assert.equal(failed.directory.failedListCalls, 1);
  assert.equal(failed.status, 'observed');
  const missing = input(); missing.sourceCalls.pop(); missing.lifecycle.pop(); missing.observerEvents.pop();
  const incomplete = summarizeStartupSample(missing);
  assert.equal(incomplete.status, 'incomplete'); assert.equal(incomplete.timings.submitToFirstProviderMs, 2020);
  assert.ok(incomplete.errors.includes('STARTUP_SOURCE_CLOSE_MISSING'));
  assert.ok(incomplete.errors.includes('STARTUP_PROCESS_CLOSE_INCOMPLETE'));
  assert.ok(incomplete.errors.includes('STARTUP_OBSERVER_INCOMPLETE'));
  assert.equal(incomplete.consumption.sourceStdoutBytes, null);
});

test('a completed warm task with zero source observations is not a complete startup measurement', () => {
  const observed = input(); observed.scenario.cache = 'warm'; observed.sourceCalls = [];
  const sample = summarizeStartupSample(observed);
  assert.equal(sample.taskStatus, 'completed'); assert.equal(sample.status, 'incomplete');
  assert.ok(sample.errors.includes('STARTUP_SOURCE_NOT_OBSERVED'));
  assert.equal(sample.consumption.sourceStdoutBytes, null);
});

function batchFixture(name, { noSource = false, failList = false, legacyObserved = false } = {}) {
  const evidence = join(scratch, name), directory = join(evidence, 'case'); mkdirSync(directory, { recursive: true });
  const captured = input({ failedList: failList }); captured.scenario.cache = 'warm';
  captured.lifecycle = captured.lifecycle.map(event => ({ ...event, pid: 2147483600 }));
  captured.sourceCalls = noSource ? [] : [
    { ...captured.sourceCalls[0], sampleId: 'case', pid: 2147483601 },
    { sampleId: 'case', id: 's', command: 'list', phase: 'source-child-spawn-return', pid: 2147483601, childPid: 2147483602, monotonicNs: ns(21) },
    { ...captured.sourceCalls[1], sampleId: 'case', childPid: 2147483602 },
  ];
  const sample = summarizeStartupSample(captured);
  // Reproduce the old warm-6 result, which called a zero-observation snapshot complete.
  if (legacyObserved) { sample.status = 'observed'; sample.errors = []; }
  const json = (file, value) => writeFileSync(join(directory, file), JSON.stringify(value) + '\n', { mode: 0o600 });
  const jsonl = events => events.map(event => JSON.stringify(event) + '\n').join('');
  json('result.json', sample); json('process-lifecycle.json', captured.lifecycle);
  writeFileSync(join(directory, 'observer.jsonl'), jsonl(captured.observerEvents), { mode: 0o600 });
  writeFileSync(join(directory, 'provider.jsonl'), jsonl(captured.providerCalls), { mode: 0o600 });
  const ledger = join(evidence, 'source-calls.jsonl'); writeFileSync(ledger, jsonl(captured.sourceCalls), { mode: 0o600 });
  return { evidence, directory, ledger, sample, captured, jsonl };
}

test('batch reread catches an orphan source starting after host close without rewriting the successful snapshot or inventing its exit', async () => {
  const f = batchFixture('late-orphan', { noSource: true, legacyObserved: true });
  const original = readFileSync(join(f.directory, 'result.json'));
  appendFileSync(f.ledger, f.jsonl([
    { sampleId: 'case', id: 'late', command: 'ctl', phase: 'source-start', pid: 2147483601, monotonicNs: ns(2500) },
    { sampleId: 'case', id: 'late', command: 'ctl', phase: 'source-child-spawn-return', pid: 2147483601, childPid: 2147483602, monotonicNs: ns(2501) },
  ]));
  const result = await reconcileStartupBatch(f.evidence, [f.sample]), final = result.samples[0];
  assert.equal(result.status, 'incomplete'); assert.equal(final.taskStatus, 'completed');
  assert.equal(result.sourceStarts, 1); assert.equal(result.sourceCloses, 0);
  for (const error of ['STARTUP_SOURCE_LATE_OBSERVATION', 'STARTUP_SOURCE_AFTER_HOST_CLOSE', 'STARTUP_SOURCE_CLOSE_MISSING']) assert.ok(final.errors.includes(error));
  assert.equal(final.calls[0].completedNs, null); assert.equal(final.calls[0].code, null);
  assert.equal(final.consumption.sourceStdoutBytes, null); assert.equal(final.consumption.backgroundCallsStartedAfterCompletion, 1);
  assert.ok(result.ownedProcesses.every(process => process.present === false));
  assert.deepEqual(readFileSync(join(f.directory, 'result.json')), original);
  assert.equal(f.sample.status, 'observed'); assert.equal(f.sample.calls.length, 0);
});

test('batch reconciliation retains a failed source and uses the actual close ledger instead of an earlier successful result', async () => {
  const f = batchFixture('failed-source', { failList: true });
  const complete = await reconcileStartupBatch(f.evidence, [f.sample]);
  assert.equal(complete.status, 'observed'); assert.equal(complete.samples[0].directory.failedListCalls, 1);
  assert.equal(complete.samples[0].consumption.sourceStdoutBytes, 90);
  writeFileSync(join(f.directory, 'process-lifecycle.json'), JSON.stringify(f.captured.lifecycle.slice(0, 1)) + '\n');
  const missing = await reconcileStartupBatch(f.evidence, [f.sample]);
  assert.equal(missing.status, 'incomplete');
  assert.ok(missing.samples[0].errors.includes('STARTUP_PROCESS_CLOSE_INCOMPLETE'));
  assert.equal(missing.samples[0].directory.failedListCalls, 1);
});

test('recorded PID presence and unknown sample activity cannot be silently excluded from final accounting', async () => {
  const f = batchFixture('unresolved-process');
  const events = f.captured.sourceCalls.map(event => event.phase === 'source-start' ? { ...event, pid: process.pid } : event);
  writeFileSync(f.ledger, f.jsonl(events));
  const active = await reconcileStartupBatch(f.evidence, [f.sample]);
  assert.equal(active.status, 'incomplete');
  assert.ok(active.samples[0].errors.includes('STARTUP_RECORDED_PID_UNRESOLVED'));
  assert.equal(active.ownedProcesses.find(row => row.pid === process.pid).present, true);
  appendFileSync(f.ledger, f.jsonl([{ sampleId: 'not-planned', id: 'unassigned', command: 'list', phase: 'source-start', monotonicNs: ns(3000) }]));
  const unassigned = await reconcileStartupBatch(f.evidence, [f.sample]);
  assert.ok(unassigned.errors.includes('STARTUP_SOURCE_SAMPLE_UNKNOWN'));
  assert.equal(unassigned.sourceStarts, 2);
});

test('source proxy forwards the fixture command and response while recording successful and failed child closes', async () => {
  const fixture = await createNotionFixture(join(scratch, 'fixture'));
  const config = join(scratch, 'proxy.json'), ledger = join(scratch, 'calls.jsonl');
  writeFileSync(config, JSON.stringify({ command: fixture.command, ledger }), { mode: 0o600 });
  const args = ['list', '--database', database], env = { ...process.env, SKILL_STARTUP_SAMPLE_ID: 'proxy-test' };
  await fixture.setScenario('normal', { listDelayMs: 30, cacheIdentity: true });
  const output = execFileSync(process.execPath, [script, 'source-proxy', config, ...args], { env, timeout: 5000 });
  const value = JSON.parse(output.toString('utf8'));
  assert.equal(value.ok, true); assert.equal(value.count, 1);
  const calls = readFileSync(fixture.callsPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.find(call => call.command === 'list').args, args.slice(1));
  let events = readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(event => event.phase), ['source-start', 'source-child-spawn-return', 'source-close']);
  assert.equal(events.at(-1).stdoutBytes, output.length); assert.equal(events.at(-1).code, 0);
  assert.ok(BigInt(events.at(-1).monotonicNs) - BigInt(events[0].monotonicNs) >= 30000000n);
  assert.equal(statSync(ledger).mode & 0o777, 0o600);
  await fixture.setScenario('normal', { failList: true });
  assert.throws(() => execFileSync(process.execPath, [script, 'source-proxy', config, ...args], { env, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }), error => {
    assert.equal(error.status, 1); assert.equal(JSON.parse(error.stdout.toString()).ok, false); return true;
  });
  events = readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(event => event.phase === 'source-close').length, 2);
  assert.equal(events.at(-1).code, 1);
});

test('help does not discover runtimes and a baseline cannot silently reduce the required sample matrix', () => {
  assert.deepEqual(parseStartupArgs(['help']), { action: 'help' });
  assert.throws(() => parseStartupArgs(['run', '--evidence-root', scratch, '--cold-samples', '1']), /OPTION_INVALID/);
  assert.throws(() => parseStartupArgs(['run', '--evidence-root', scratch, '--failure-samples', '1']), /OPTION_INVALID/);
  assert.throws(() => parseStartupArgs(['run', '--evidence-root', scratch, '--warm-samples', '5']), /AT_LEAST_20/);
  const options = parseStartupArgs(['run', '--evidence-root', scratch, '--warm-samples', '20']);
  assert.equal(options.coldSamples, 5); assert.equal(options.failureSamples, 5); assert.equal(options.warmSamples, 20);
});
