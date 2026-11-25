import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyEngineeringProgress, invocationWallClockMs, preflightEngineeringProgress, runEngineeringSlices } from './engineering-progress.mjs';

const start = Date.parse('2030-01-01T00:00:00Z'), end = start + 86400000;
function plan() {
  return { id: 'engineering-window-fixture', slots: Array.from({ length: 17 }, (_, order) => ({ order, slot_id: 'slot-' + order, condition_id: 'condition' })),
    protocol: { conditions: [{ id: 'condition', model_id: 'sol', budget_id: 'residual' }], models: [{ id: 'sol', backend: { window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() } } }],
      policies: { budgets: [{ id: 'residual', episode: { max_model_requests: 10, max_input_tokens: 300000, max_output_tokens: 16000, max_duration_ms: 10 },
        batch: { max_episodes: 17, max_model_requests: 209, max_input_tokens: 7079778, max_output_tokens: 381132, max_duration_ms: 1000 } }] } } };
}
function append(rows, p, count, reason, { elapsed = reason === 'batch_budget_exhausted' ? 1000 : 5, result = {} } = {}) {
  const before = rows.filter(row => row.type === 'episode_started').length, invocation = rows.filter(row => row.type === 'batch_opened').length + 1;
  const clock = 'invocation-' + invocation, tick = BigInt(invocation) * 10000000000n;
  const put = row => rows.push({ seq: rows.length + 1, clock_domain: clock, monotonic_ns: tick.toString(), ...row });
  put({ type: 'batch_opened' });
  for (const slot of p.slots.slice(before, before + count)) {
    const run_id = p.id + '-' + String(slot.order + 1).padStart(3, '0');
    put({ type: 'episode_started', ...slot, run_id });
    put({ type: 'episode_completed', ...slot, run_id,
      result: { status: 'completed', stop_batch: false, stop_reason: null,
        budget_usage: { model_requests: 1, input_tokens: 10, output_tokens: 5, duration_ms: 1 }, ...structuredClone(result) } });
  }
  put({ type: 'batch_closed', reason, new_episodes: count, monotonic_ns: (tick + BigInt(elapsed * 1e6)).toString() });
}

test('the bounded runner advances by7 of8, then8 and2, and analyzes each actual positive prefix', async () => {
  const p = plan(), rows = [], calls = [], checkpoints = [], analyses = [], amounts = [7, 8, 2];
  const result = await runEngineeringSlices({ plan: p, maximumSlice: 8, verifySnapshot: async () => {}, readRows: async () => structuredClone(rows), now: () => start + 1,
    runSlice: async limit => { calls.push(limit); const count = amounts.shift(); append(rows, p, count, amounts.length ? count < limit ? 'batch_budget_exhausted' : 'operator_slice_limit' : 'planned_slots_completed'); },
    writeCheckpoint: async item => checkpoints.push(item), analyzePrefix: async item => analyses.push(item.completed_prefix) });
  assert.deepEqual(calls, [8, 8, 2]); assert.deepEqual(analyses, [7, 15, 17]);
  assert.deepEqual(checkpoints.map(item => item.new_completed), [7, 8, 2]); assert.equal(result.action, 'finish');
  assert.equal(result.completed_prefix, 17); assert.equal(new Set(rows.filter(row => row.type === 'episode_started').map(row => row.run_id)).size, 17);
});

test('analysis crossing the absolute deadline checkpoints the same7 and starts no second command', async () => {
  const p = plan(), rows = [], checkpoints = []; let now = start + 1, calls = 0, analyses = 0;
  const result = await runEngineeringSlices({ plan: p, maximumSlice: 8, verifySnapshot: async () => {}, readRows: async () => structuredClone(rows), now: () => now,
    runSlice: async () => { calls++; append(rows, p, 7, 'batch_budget_exhausted'); },
    writeCheckpoint: async item => checkpoints.push(item), analyzePrefix: async () => { analyses++; now = end; } });
  assert.equal(calls, 1); assert.equal(analyses, 1); assert.equal(result.reason, 'model_window_closed');
  assert.equal(result.phase, 'before_dispatch'); assert.equal(result.completed_prefix, 7); assert.equal(result.new_completed, 0);
  assert.equal(checkpoints.length, 2); assert.equal(checkpoints[1].analyze_prefix, false);
});

test('zero progress always retains a checkpoint and does not attempt empty analysis or another command', async () => {
  const p = plan(), rows = [], checkpoints = []; let calls = 0;
  const result = await runEngineeringSlices({ plan: p, maximumSlice: 8, verifySnapshot: async () => {}, readRows: async () => rows, now: () => start + 1,
    runSlice: async () => { calls++; append(rows, p, 0, 'batch_budget_exhausted'); },
    writeCheckpoint: async item => checkpoints.push(item), analyzePrefix: async () => assert.fail('No empty analysis') });
  assert.equal(calls, 1); assert.equal(result.reason, 'zero_progress'); assert.equal(result.completed_prefix, 0); assert.equal(checkpoints.length, 1);
});

test('an already complete plan finishes with zero invocation and no duplicate analysis', async () => {
  const p = plan(), rows = [], checkpoints = []; append(rows, p, 17, 'planned_slots_completed');
  const result = await runEngineeringSlices({ plan: p, maximumSlice: 8, verifySnapshot: async () => {}, readRows: async () => rows, now: () => end,
    runSlice: async () => assert.fail('Complete plans never enter dispatch'), writeCheckpoint: async item => checkpoints.push(item),
    analyzePrefix: async () => assert.fail('No repeated analysis') });
  assert.equal(result.action, 'finish'); assert.equal(result.completed_prefix, 17); assert.equal(result.requested_limit, 0); assert.equal(checkpoints.length, 1);
});

test('fresh core, unknown, unresolved, absent stop flag and bad closure remain stopping prefixes', () => {
  for (const [mutate, reason] of [
    [rows => { rows[2].result.stop_batch = true; rows[2].result.stop_reason = 'subject_requested_stop'; }, 'core_stop'],
    [rows => { rows[2].result.budget_usage.input_tokens = null; }, 'unknown_usage'],
    [rows => { delete rows[2].result.stop_batch; }, 'core_stop'],
    [rows => { rows.splice(2, 1); rows.forEach((row, index) => { row.seq = index + 1; }); }, 'unresolved_execution'],
    [rows => { rows.at(-1).reason = 'other'; }, 'unexpected_closure'],
  ]) {
    const p = plan(), rows = []; append(rows, p, 1, 'operator_slice_limit'); mutate(rows);
    assert.equal(preflightEngineeringProgress({ plan: p, rows, now: start + 1 }).reason, reason);
  }
});

test('a proved local request-cap failure retains known cost and is not promoted to a new core stop', () => {
  const p = plan(), rows = []; append(rows, p, 1, 'operator_slice_limit', { result: { status: 'failed' } });
  assert.equal(classifyEngineeringProgress({ plan: p, rows, beforeCompleted: 0, requestedLimit: 1, now: start + 1 }).action, 'continue');
  rows[2].result.stop_batch = true;
  assert.equal(classifyEngineeringProgress({ plan: p, rows, beforeCompleted: 0, requestedLimit: 1, now: start + 1 }).reason, 'core_stop');
});

test('budget closure needs both actual wallclock exhaustion and full next-episode resource headroom', () => {
  const p = plan(), rows = []; append(rows, p, 7, 'batch_budget_exhausted');
  assert.equal(invocationWallClockMs(rows), 1000);
  const classify = () => classifyEngineeringProgress({ plan: p, rows, beforeCompleted: 0, requestedLimit: 8, now: start + 1 });
  assert.equal(classify().reason, 'wallclock_partial');
  rows.at(-1).monotonic_ns = (BigInt(rows[0].monotonic_ns) + 999000000n).toString();
  assert.equal(classify().reason, 'budget_stop_without_wallclock_exhaustion');
  rows.at(-1).monotonic_ns = (BigInt(rows[0].monotonic_ns) + 1000000000n).toString();
  p.protocol.policies.budgets[0].batch.max_model_requests = 16;
  assert.equal(classify().reason, 'cumulative_budget_exhausted');
});

test('new or existing ineligible prefixes are rejected before any command', async () => {
  for (const variant of ['expired', 'core', 'unknown', 'unresolved']) {
    const p = plan(), rows = []; if (variant !== 'expired') append(rows, p, 1, 'operator_slice_limit');
    if (variant === 'core') rows[2].result.stop_batch = true;
    if (variant === 'unknown') rows[2].result.budget_usage.input_tokens = null;
    if (variant === 'unresolved') { rows.splice(2, 1); rows.forEach((row, index) => { row.seq = index + 1; }); }
    const checkpoints = [];
    const result = await runEngineeringSlices({ plan: p, maximumSlice: 8, verifySnapshot: async () => {}, readRows: async () => rows, now: () => variant === 'expired' ? end : start,
      runSlice: async () => assert.fail('Ineligible prefix must not invoke'), writeCheckpoint: async item => checkpoints.push(item),
      analyzePrefix: async () => assert.fail('No new completed prefix') });
    assert.equal(result.action, 'stop'); assert.equal(checkpoints.length, 1); assert.equal(result.requested_limit, 0);
  }
});

test('preflight rejects completion-before-start, overlapping runs and changed frozen slot identity', async () => {
  for (const variant of ['completion_first', 'overlap', 'nested_batch', 'crossed_batch', 'extra_event', 'case_id', 'condition_id', 'repeat', 'order', 'seed']) {
    const p = plan(), rows = [];
    p.slots = p.slots.map(slot => ({ ...slot, case_id: 'case', repeat: 0, seed: 1, pair_id: 'pair' }));
    append(rows, p, 2, 'operator_slice_limit');
    if (variant === 'completion_first') [rows[1], rows[2]] = [rows[2], rows[1]];
    else if (variant === 'overlap') [rows[2], rows[3]] = [rows[3], rows[2]];
    else if (variant === 'nested_batch') rows.splice(1, 0, { ...rows[0] });
    else if (variant === 'crossed_batch') rows.splice(2, 0, { type: 'batch_closed' }, { ...rows[0] });
    else if (variant === 'extra_event') rows.splice(1, 0, { type: 'analysis_revision_applied' });
    else rows[2][variant] = 'changed';
    rows.forEach((row, index) => { row.seq = index + 1; });
    const result = await runEngineeringSlices({ plan: p, maximumSlice: 8, readRows: async () => rows, now: () => start,
      verifySnapshot: async () => {}, runSlice: async () => assert.fail('Malformed ledger must not dispatch'),
      writeCheckpoint: async () => {}, analyzePrefix: async () => assert.fail('Malformed prefix must not be analyzed') });
    assert.equal(result.action, 'stop');
    assert.equal(result.reason, ['completion_first', 'overlap'].includes(variant) ? 'ledger_order_changed'
      : ['nested_batch', 'crossed_batch'].includes(variant) ? 'ledger_batch_boundary_changed' : variant === 'extra_event' ? 'unexpected_ledger_event' : 'frozen_slot_changed');
  }
});

test('a ledger advanced by a checkpoint callback cannot bind the old prefix to a new snapshot', async () => {
  const p = plan(), rows = []; let snapshot, calls = 0, analyses = 0;
  await assert.rejects(runEngineeringSlices({ plan: p, maximumSlice: 8, now: () => start,
    readRows: async () => { snapshot = JSON.stringify(rows); return structuredClone(rows); },
    runSlice: async () => { calls++; append(rows, p, 7, 'batch_budget_exhausted'); },
    writeCheckpoint: async checkpoint => { assert.equal(checkpoint.completed_prefix, 7); append(rows, p, 1, 'operator_slice_limit'); },
    verifySnapshot: async () => assert.equal(JSON.stringify(rows), snapshot, 'LEDGER_SNAPSHOT_CHANGED'),
    analyzePrefix: async () => { analyses++; } }), /LEDGER_SNAPSHOT_CHANGED/);
  assert.equal(calls, 1); assert.equal(analyses, 0);
});

test('an invocation exception preserves the actual positive prefix and stops with a nonzero engineering CLI result', async () => {
  const { benchmarkResultExitCode } = await import('./cli.mjs');
  const p = plan(), rows = [], analyses = []; let calls = 0;
  const result = await runEngineeringSlices({ plan: p, maximumSlice: 8, verifySnapshot: async () => {}, readRows: async () => structuredClone(rows), now: () => start,
    runSlice: async () => { calls++; append(rows, p, 1, 'operator_slice_limit'); throw new Error('fixture invocation error'); },
    writeCheckpoint: async () => {}, analyzePrefix: async checkpoint => analyses.push(checkpoint.completed_prefix) });
  assert.equal(result.action, 'stop'); assert.equal(result.reason, 'invocation_failed'); assert.equal(result.completed_prefix, 1);
  assert.equal(calls, 1); assert.deepEqual(analyses, [1]);
  assert.equal(benchmarkResultExitCode('run-engineering-window', { status: 'stopped', result }), 1);
  assert.equal(benchmarkResultExitCode('run-engineering-window', { status: 'completed' }), 0);
  assert.equal(benchmarkResultExitCode('run', { status: 'stopped' }), 0);
});
