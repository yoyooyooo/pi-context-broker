import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentWorkflowArgs, agentWorkflowProjectSettings, workflowSourceSlice, workflowCatalogFault, awaitWorkflowCatalog } from './notion-agent-workflow-runtime.mjs';
import { validateCandidateTurn } from './verify-pi-daily-candidate.mjs';

test('daily and no-native-skills use the same real worker and retain normal extension discovery', () => {
  const config = { model: 'magpie/group/worker', thinkingLevel: 'high', profile: 'daily' };
  const daily = agentWorkflowArgs(config, '/owned/sessions', ['/owned/passive.mjs']);
  const comparison = agentWorkflowArgs({ ...config, profile: 'no-native-skills' }, '/owned/sessions', ['/owned/passive.mjs']);
  assert.deepEqual(comparison, ['-ns', ...daily]);
  assert.deepEqual(daily.slice(daily.indexOf('--provider'), daily.indexOf('--thinking') + 2), ['--provider', 'magpie', '--model', 'group/worker', '--thinking', 'high']);
  for (const args of [daily, comparison]) for (const forbidden of ['-ne', '--no-extensions', '--skill', '--no-session', '--system-prompt']) assert.ok(!args.includes(forbidden));
  for (const change of [{ profile: 'notion-only' }, { profile: 'normal' }, { model: 'magpie/group/flash' }, { thinkingLevel: 'off' }])
    assert.throws(() => agentWorkflowArgs({ ...config, ...change }, '/owned/sessions', []));
});

test('source attribution retains complete overlapping operations and excludes an earlier management write', () => {
  const row = (phase, requestId, at, rest = {}) => ({ phase, requestId, monotonicNs: String(at), ...rest });
  const events = [row('started', 'old-write', 1), row('attempt', 'old-write', 2, { method: 'PATCH' }), row('completed', 'old-write', 3),
    row('started', 'background-list', 4), row('attempt', 'background-list', 6), row('metrics', 'background-list', 15), row('completed', 'background-list', 16),
    row('started', 'read', 7), row('attempt', 'read', 8), row('metrics', 'read', 9), row('completed', 'read', 10),
    row('started', 'later', 20), row('completed', 'later', 21)];
  const actual = workflowSourceSlice(events, '5', '12');
  assert.deepEqual([...new Set(actual.map(row => row.requestId))], ['background-list', 'read']);
  assert.equal(actual.filter(row => row.requestId === 'background-list').length, 4);
  assert.ok(!actual.some(row => row.method === 'PATCH'));
});

test('declared compact budget changes only the owned project and is consistent for the whole session', () => {
  const settings = { packages: ['normal-package'], compaction: { enabled: true } }, before = structuredClone(settings);
  const ordinary = { turns: [{ id: 'continue' }] };
  assert.deepEqual(agentWorkflowProjectSettings(settings, ordinary), settings);
  const compact = { turns: [{ before: [{ kind: 'compact', keepRecentTokens: 128 }] }] };
  assert.deepEqual(agentWorkflowProjectSettings(settings, compact), { ...settings, compaction: { enabled: true, keepRecentTokens: 128 } });
  assert.deepEqual(settings, before);
  assert.throws(() => agentWorkflowProjectSettings(settings, { turns: [{ before: [
    { kind: 'compact', keepRecentTokens: 128 }, { kind: 'compact', keepRecentTokens: 256 },
  ] }] }), /one declared compaction/u);
});

test('negative notion_use means zero actual attempts, including a failed or guard-rejected call', () => {
  const observed = { costs: [], transport: [], tasks: [{ phase: 'tool_call', toolName: 'notion_use', toolCallId: 'bad' },
    { phase: 'tool_result', toolName: 'notion_use', toolCallId: 'bad', isError: true }] };
  assert.throws(() => validateCandidateTurn({ requireUse: false }, observed), /unnecessary notion_use attempt/u);
});

test('catalog barriers require the actual owned SDK failure and never turn cancellation or an unrelated failure into readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-catalog-')), file = join(root, 'source.jsonl');
  const options = { sourceId: 'selected', database: '01234567-89ab-cdef-0123-456789abcdef' };
  const start = { phase: 'started', kind: 'sdk', operation: 'list', requestId: 'request', monotonicNs: '1',
    source_id: options.sourceId, database: options.database };
  const end = { phase: 'completed', requestId: start.requestId, monotonicNs: '2', status: 'failed', sdkStarted: true, errorCode: 'STATE_UNAVAILABLE' };
  const put = async (first = start, last = end) => writeFile(file, [first, last].map(JSON.stringify).join('\n') + '\n');
  await put();
  await assert.rejects(awaitWorkflowCatalog(file, 20, options), /Normal catalog preparation failed/u);
  const faulted = { ...options, expectedFailure: { mode: 'store-unavailable', expectedErrorCode: 'STATE_UNAVAILABLE' } };
  assert.equal((await awaitWorkflowCatalog(file, 20, faulted)).observedErrorCode, 'STATE_UNAVAILABLE');
  for (const change of [{ status: 'completed' }, { status: 'cancelled' }, { errorCode: 'SOURCE_SDK_UNAVAILABLE' }, { sdkStarted: false }]) {
    await put(start, { ...end, ...change }); await assert.rejects(awaitWorkflowCatalog(file, 20, faulted));
  }
  for (const change of [{ source_id: 'other' }, { database: 'different' }, { operation: 'read' }]) {
    await put({ ...start, ...change }); await assert.rejects(awaitWorkflowCatalog(file, 20, faulted), /required terminal state/u);
  }
});

test('a declared Store outage needs sealed probe artifacts and the still-active owned physical blocker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-store-barrier-')), state = join(root, 'state');
  const record = async (name, value) => {
    const path = join(root, name), bytes = Buffer.from(JSON.stringify(value)); await writeFile(path, bytes);
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  };
  const fixture = { root, ownership: { token: 'owned-token' }, faults: [] }, bindings = { private: { fixture } };
  assert.equal(await workflowCatalogFault(bindings, state), undefined);
  const marker = { fixtureFault: fixture.ownership.token, restoreFrom: join(root, 'quarantine') };
  const blocker = await record('marker.json', marker); await writeFile(state, JSON.stringify(marker));
  const selected = { owner: 'owner', snapshot_id: 'snapshot' };
  const fault = { mode: 'store-unavailable', source: state, target: marker.restoreFrom, status: 'active',
    probe: { roots: { NTN_SKILLS_HOME: state }, selected }, proof: {
      before: { status: 'passed', command: await record('before.json', { ok: true }), observed: { ...selected, totalRequests: 0, remoteWrites: 'none' } },
      after: { status: 'failed', expected: true, code: 'STATE_UNAVAILABLE', details: { phase: 'sqlite_state', native_code: 'ENOTDIR' }, command: await record('after.json', { ok: false }) },
      blocker: { kind: 'regular-file', observedPath: state, readPath: join(state, 'state.sqlite'), readError: 'ENOTDIR', artifact: blocker },
    } };
  fixture.faults.push(fault);
  assert.equal((await workflowCatalogFault(bindings, state)).expectedErrorCode, 'STATE_UNAVAILABLE');
  await writeFile(state, 'another owner'); await assert.rejects(workflowCatalogFault(bindings, state));
  await writeFile(state, JSON.stringify(marker));
  await writeFile(fault.proof.after.command.path, '{}'); await assert.rejects(workflowCatalogFault(bindings, state));
  fault.status = 'restored'; assert.equal(await workflowCatalogFault(bindings, state), undefined);
});
