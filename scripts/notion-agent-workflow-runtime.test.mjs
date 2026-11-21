import test from 'node:test';
import assert from 'node:assert/strict';
import { agentWorkflowArgs, workflowSourceSlice } from './notion-agent-workflow-runtime.mjs';
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

test('negative notion_use means zero actual attempts, including a failed or guard-rejected call', () => {
  const observed = { costs: [], transport: [], tasks: [{ phase: 'tool_call', toolName: 'notion_use', toolCallId: 'bad' },
    { phase: 'tool_result', toolName: 'notion_use', toolCallId: 'bad', isError: true }] };
  assert.throws(() => validateCandidateTurn({ requireUse: false }, observed), /unnecessary notion_use attempt/u);
});
