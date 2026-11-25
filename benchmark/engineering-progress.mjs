import assert from 'node:assert/strict';

const resources = ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms'];
const known = usage => resources.every(key => Number.isFinite(usage?.[key]) && usage[key] >= 0);

/** The old ledger records a monotonic clock, not an elapsed-duration claim. */
export function invocationWallClockMs(rows) {
  const end = rows.at(-1), start = rows.findLast(row => row.type === 'batch_opened');
  assert.equal(end?.type, 'batch_closed', 'ENGINEERING_BATCH_NOT_CLOSED');
  assert.ok(start && start.clock_domain === end.clock_domain, 'ENGINEERING_BATCH_CLOCK_CHANGED');
  assert.match(start.monotonic_ns, /^\d+$/); assert.match(end.monotonic_ns, /^\d+$/);
  const elapsed = BigInt(end.monotonic_ns) - BigInt(start.monotonic_ns);
  assert.ok(elapsed >= 0n, 'ENGINEERING_BATCH_CLOCK_REVERSED');
  return Number(elapsed) / 1e6;
}

/** Classify only the exact, closed, observed prefix of one frozen engineering
 * plan. This function neither authorizes a run nor changes a ledger. */
export function classifyEngineeringProgress({ plan, rows, beforeCompleted, requestedLimit, now = Date.now() }) {
  assert.ok(Number.isSafeInteger(beforeCompleted) && beforeCompleted >= 0);
  assert.ok(Number.isSafeInteger(requestedLimit) && requestedLimit > 0);
  const starts = rows.filter(row => row.type === 'episode_started');
  const completed = rows.filter(row => row.type === 'episode_completed');
  const sameSlot = (row, slot) => row && Object.entries(slot).every(([key, value]) => row[key] === value);
  let prefix = 0;
  for (const slot of plan.slots) {
    const run = plan.id + '-' + String(slot.order + 1).padStart(3, '0');
    if (starts[prefix]?.run_id !== run || completed[prefix]?.run_id !== run
      || !sameSlot(starts[prefix], slot) || !sameSlot(completed[prefix], slot)
      || starts[prefix].seq >= completed[prefix].seq
      || (prefix > 0 && completed[prefix - 1].seq >= starts[prefix].seq)) break;
    prefix++;
  }
  const delta = prefix - beforeCompleted, last = rows.at(-1);
  const summary = { completed_prefix: prefix, completed_run_ids: completed.slice(0, prefix).map(row => row.run_id),
    new_completed: Math.max(0, delta), started: starts.length, completed: completed.length,
    remaining: Math.max(0, plan.slots.length - prefix), checkpoint_required: true, analyze_prefix: false };
  const stop = reason => ({ ...summary, action: 'stop', reason });
  if (rows.some((row, index) => row.seq !== index + 1)) return stop('ledger_sequence_changed');
  if (new Set(starts.map(row => row.run_id)).size !== starts.length
    || new Set(completed.map(row => row.run_id)).size !== completed.length) return stop('duplicate_run');
  if (starts.length !== completed.length) return stop('unresolved_execution');
  if (starts.some((row, index) => row.seq >= completed[index].seq || (index > 0 && completed[index - 1].seq >= row.seq)))
    return stop('ledger_order_changed');
  if (starts.some((row, index) => !plan.slots[index] || !sameSlot(row, plan.slots[index]) || !sameSlot(completed[index], plan.slots[index])))
    return stop('frozen_slot_changed');
  let batchOpen = false, activeRun = null;
  for (const row of rows) {
    if (row.type === 'batch_opened') { if (batchOpen) return stop('ledger_batch_boundary_changed'); batchOpen = true; }
    else if (row.type === 'batch_closed') { if (!batchOpen || activeRun !== null) return stop('ledger_batch_boundary_changed'); batchOpen = false; }
    else if (row.type === 'episode_started') { if (!batchOpen || activeRun !== null) return stop('ledger_batch_boundary_changed'); activeRun = row.run_id; }
    else if (row.type === 'episode_completed') { if (!batchOpen || activeRun !== row.run_id) return stop('ledger_batch_boundary_changed'); activeRun = null; }
    else return stop('unexpected_ledger_event');
  }
  if (prefix !== starts.length || delta < 0 || delta > requestedLimit) return stop('unexpected_prefix');
  if (last?.type !== 'batch_closed') return stop('batch_not_closed');
  summary.analyze_prefix = delta > 0;
  if (completed.some(row => !known(row.result?.budget_usage))) return stop('unknown_usage');
  if (completed.some(row => row.result.stop_batch !== false || row.result.stop_reason)) return stop('core_stop');
  const open = rows.findLastIndex(row => row.type === 'batch_opened');
  if (open < 0 || rows.slice(open).filter(row => row.type === 'episode_started').length !== last.new_episodes
    || last.new_episodes !== delta) return stop('closure_progress_changed');
  if (prefix === plan.slots.length) {
    if (!['planned_slots_completed', 'operator_slice_limit'].includes(last.reason)) return stop('unexpected_complete_closure');
    return { ...summary, action: 'finish', reason: 'planned_slots_completed' };
  }
  if (delta === 0) return stop('zero_progress');
  const condition = plan.protocol.conditions.find(item => item.id === plan.slots[prefix].condition_id);
  const model = plan.protocol.models.find(item => item.id === condition.model_id);
  if (!Number.isFinite(now) || now < Date.parse(model.backend.window.start) || now >= Date.parse(model.backend.window.end))
    return stop('model_window_closed');
  const budget = plan.protocol.policies.budgets.find(item => item.id === condition.budget_id);
  const usage = Object.fromEntries(resources.map(key => [key, completed.reduce((sum, row) => sum + row.result.budget_usage[key], 0)]));
  if (prefix >= budget.batch.max_episodes || resources.some(key => usage[key] + budget.episode['max_' + key] > budget.batch['max_' + key]))
    return stop('cumulative_budget_exhausted');
  if (last.reason === 'operator_slice_limit') {
    if (delta !== requestedLimit) return stop('operator_slice_underfilled');
    return { ...summary, action: 'continue', reason: 'operator_slice_limit' };
  }
  if (last.reason !== 'batch_budget_exhausted') return stop(last.reason === 'model_window_closed' ? last.reason : 'unexpected_closure');
  let elapsed;
  try { elapsed = invocationWallClockMs(rows); } catch { return stop('invalid_wallclock_evidence'); }
  if (elapsed < budget.batch.max_duration_ms) return stop('budget_stop_without_wallclock_exhaustion');
  return { ...summary, action: 'continue', reason: 'wallclock_partial', elapsed_ms: elapsed, cumulative_usage: usage };
}

export function preflightEngineeringProgress({ plan, rows, now = Date.now() }) {
  if (rows.length) {
    const completed = rows.filter(row => row.type === 'episode_completed').length, delta = rows.at(-1)?.new_episodes;
    const result = classifyEngineeringProgress({ plan, rows,
      beforeCompleted: Number.isSafeInteger(delta) && delta >= 0 && delta <= completed ? completed - delta : completed,
      requestedLimit: Number.isSafeInteger(delta) && delta > 0 ? delta : 1, now });
    return { ...result, new_completed: 0, analyze_prefix: false };
  }
  const condition = plan.protocol.conditions.find(item => item.id === plan.slots[0].condition_id);
  const model = plan.protocol.models.find(item => item.id === condition.model_id), budget = plan.protocol.policies.budgets.find(item => item.id === condition.budget_id);
  const summary = { completed_prefix: 0, completed_run_ids: [], new_completed: 0, started: 0, completed: 0,
    remaining: plan.slots.length, checkpoint_required: true, analyze_prefix: false };
  if (!Number.isFinite(now) || now < Date.parse(model.backend.window.start) || now >= Date.parse(model.backend.window.end))
    return { ...summary, action: 'stop', reason: 'model_window_closed' };
  if (budget.batch.max_episodes < 1 || resources.some(key => budget.episode['max_' + key] > budget.batch['max_' + key]))
    return { ...summary, action: 'stop', reason: 'cumulative_budget_exhausted' };
  return { ...summary, action: 'continue', reason: 'unstarted' };
}

/** The concrete runner supplies its model invocation and artifact operations.
 * Each positive iteration consumes a new part of this one frozen schedule;
 * zero progress always terminates, so no retry/resumption loop is introduced. */
export async function runEngineeringSlices({ plan, maximumSlice, readRows, runSlice, analyzePrefix, writeCheckpoint, verifySnapshot, now = Date.now }) {
  assert.ok(Number.isSafeInteger(maximumSlice) && maximumSlice > 0);
  assert.equal(typeof verifySnapshot, 'function');
  let before = null;
  for (let invocation = 1; invocation <= plan.slots.length + 1; invocation++) {
    let rows = await readRows();
    const preflight = preflightEngineeringProgress({ plan, rows, now: now() });
    if (before !== null && preflight.completed_prefix !== before) { preflight.action = 'stop'; preflight.reason = 'prefix_changed_between_invocations'; }
    if (preflight.action !== 'continue') {
      const checkpoint = { invocation, phase: 'before_dispatch', requested_limit: 0, ...preflight };
      await writeCheckpoint(checkpoint); await verifySnapshot(checkpoint); return checkpoint;
    }
    before = preflight.completed_prefix;
    const limit = Math.min(maximumSlice, Math.max(1, plan.slots.length - before));
    let failure;
    try { await runSlice(limit); } catch (error) { failure = { name: error.name, message: error.message }; }
    rows = await readRows();
    const progress = classifyEngineeringProgress({ plan, rows, beforeCompleted: before, requestedLimit: limit, now: now() });
    if (failure) { progress.action = 'stop'; progress.reason = 'invocation_failed'; progress.failure = failure; }
    const checkpoint = { invocation, phase: 'after_dispatch', requested_limit: limit, ...progress };
    await writeCheckpoint(checkpoint);
    await verifySnapshot(checkpoint);
    if (progress.analyze_prefix) { await analyzePrefix(checkpoint); await verifySnapshot(checkpoint); }
    if (progress.action !== 'continue') return checkpoint;
    before = progress.completed_prefix;
  }
  assert.fail('ENGINEERING_INVOCATION_BOUND_EXCEEDED');
}
