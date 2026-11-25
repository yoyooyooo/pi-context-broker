import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { validateBatchPlan } from './batch.mjs';
import { executeBatchPlan, analyzeBatch } from './controller.mjs';
import { verifyStandingPlan } from './standing-campaign.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const resources = ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms'];

/** Prefix analysis is serial with dispatch and needs no provider or Notion
 * credential. Restore the caller's exact environment even when analysis fails. */
export async function withoutStandingAnalysisCredentials({ apiKeyEnv, environment = process.env }, analyze) {
  const names = [...new Set([apiKeyEnv, 'NOTION_API_TOKEN'].filter(Boolean))];
  const prior = names.map(name => ({ name, present: Object.hasOwn(environment, name), value: environment[name] }));
  for (const name of names) delete environment[name];
  try { return await analyze(); }
  finally {
    for (const { name, present, value } of prior) {
      if (present) environment[name] = value;
      else delete environment[name];
    }
  }
}

/** A checkpoint interval controls review frequency. Only the finite scientific
 * design determines completion; no cumulative resource allowance is inferred. */
export function classifyStandingProgress({ plan, rows, beforeCompleted = 0, requestedLimit }) {
  assert.ok(Number.isSafeInteger(beforeCompleted) && beforeCompleted >= 0);
  assert.ok(Number.isSafeInteger(requestedLimit) && requestedLimit > 0);
  const starts = rows.filter(row => row.type === 'episode_started'), completed = rows.filter(row => row.type === 'episode_completed');
  const summary = { completed_prefix: completed.length, completed_run_ids: completed.map(row => row.run_id),
    new_completed: Math.max(0, completed.length - beforeCompleted), started: starts.length, completed: completed.length,
    remaining: Math.max(0, plan.slots.length - completed.length), checkpoint_required: true, analyze_prefix: false };
  const stop = reason => ({ ...summary, action: 'stop', reason });
  if (!rows.length) return { ...summary, action: 'continue', reason: 'unstarted' };
  if (rows.some((row, index) => row.seq !== index + 1)) return stop('ledger_sequence_changed');
  if (new Set(starts.map(row => row.run_id)).size !== starts.length || new Set(completed.map(row => row.run_id)).size !== completed.length)
    return stop('duplicate_run');
  if (starts.length !== completed.length) return stop('unresolved_execution');
  let batchOpen = false, activeRun = null;
  for (const row of rows) {
    if (row.type === 'batch_opened') { if (batchOpen) return stop('ledger_batch_boundary_changed'); batchOpen = true; }
    else if (row.type === 'batch_closed') { if (!batchOpen || activeRun !== null) return stop('ledger_batch_boundary_changed'); batchOpen = false; }
    else if (row.type === 'episode_started') { if (!batchOpen || activeRun !== null) return stop('ledger_batch_boundary_changed'); activeRun = row.run_id; }
    else if (row.type === 'episode_completed') { if (!batchOpen || activeRun !== row.run_id) return stop('ledger_batch_boundary_changed'); activeRun = null; }
    else return stop('unresolved_or_unexpected_ledger_event');
  }
  for (const [index, row] of completed.entries()) {
    const slot = plan.slots[index], start = starts[index];
    if (!slot || row.run_id !== plan.id + '-' + String(slot.order + 1).padStart(3, '0') || start.run_id !== row.run_id
      || Object.entries(slot).some(([key, value]) => start[key] !== value || row[key] !== value)) return stop('frozen_slot_changed');
    if (start.seq >= row.seq || index > 0 && completed[index - 1].seq >= start.seq) return stop('ledger_order_changed');
  }
  const delta = completed.length - beforeCompleted, last = rows.at(-1);
  if (delta < 0 || delta > requestedLimit) return stop('unexpected_prefix');
  if (last.type !== 'batch_closed' || batchOpen) return stop('batch_not_closed');
  if (completed.some(row => !resources.every(key => Number.isFinite(row.result?.budget_usage?.[key]) && row.result.budget_usage[key] >= 0)))
    return stop('unknown_usage');
  if (completed.some(row => row.result.stop_batch !== false || row.result.stop_reason)) return stop('core_stop');
  const open = rows.findLastIndex(row => row.type === 'batch_opened');
  if (open < 0 || rows.slice(open).filter(row => row.type === 'episode_started').length !== last.new_episodes || last.new_episodes !== delta)
    return stop('closure_progress_changed');
  summary.analyze_prefix = delta > 0;
  if (completed.length === plan.slots.length) {
    if (!['planned_slots_completed', 'operator_slice_limit'].includes(last.reason)) return stop('unexpected_complete_closure');
    return { ...summary, action: 'finish', reason: 'planned_slots_completed' };
  }
  if (last.reason !== 'operator_slice_limit') return stop(last.reason ?? 'unexpected_closure');
  if (delta === 0) return stop('zero_progress');
  if (delta !== requestedLimit || last.new_episodes !== delta) return stop('operator_slice_underfilled');
  return { ...summary, action: 'continue', reason: 'operator_slice_limit' };
}

function preflight(plan, rows) {
  if (!rows.length) return classifyStandingProgress({ plan, rows, requestedLimit: 1 });
  const count = rows.filter(row => row.type === 'episode_completed').length;
  const previous = rows.at(-1)?.new_episodes;
  const progress = classifyStandingProgress({ plan, rows,
    beforeCompleted: Number.isSafeInteger(previous) && previous >= 0 && previous <= count ? count - previous : count,
    requestedLimit: Number.isSafeInteger(previous) && previous > 0 ? previous : 1 });
  return { ...progress, new_completed: 0, analyze_prefix: false };
}

export async function runStandingSlices({ plan, maximumSlice, readRows, runSlice, writeCheckpoint, verifySnapshot, analyzePrefix }) {
  assert.ok(Number.isSafeInteger(maximumSlice) && maximumSlice > 0);
  let expectedPrefix = null, invocation = 0;
  for (;;) {
    const before = preflight(plan, await readRows());
    if (expectedPrefix !== null && before.completed_prefix !== expectedPrefix) { before.action = 'stop'; before.reason = 'prefix_changed_between_invocations'; }
    if (before.action !== 'continue') {
      const checkpoint = { invocation, phase: 'before_dispatch', requested_limit: 0, ...before };
      await writeCheckpoint(checkpoint); await verifySnapshot(checkpoint); return checkpoint;
    }
    const limit = Math.min(maximumSlice, plan.slots.length - before.completed_prefix); invocation++;
    assert.ok(limit > 0); let failure;
    try { await runSlice(limit); } catch (error) { failure = { name: error.name, message: error.message }; }
    const progress = classifyStandingProgress({ plan, rows: await readRows(), beforeCompleted: before.completed_prefix, requestedLimit: limit });
    if (progress.action === 'continue' && progress.new_completed === 0) { progress.action = 'stop'; progress.reason = 'zero_progress'; }
    if (failure) { progress.action = 'stop'; progress.reason = 'invocation_failed'; progress.failure = failure; }
    const checkpoint = { invocation, phase: 'after_dispatch', requested_limit: limit, ...progress };
    await writeCheckpoint(checkpoint); await verifySnapshot(checkpoint);
    if (progress.analyze_prefix) { await analyzePrefix(checkpoint); await verifySnapshot(checkpoint); }
    if (progress.action !== 'continue') return checkpoint;
    expectedPrefix = progress.completed_prefix;
  }
}

export async function runStandingBatch({ planFile, outputRoot, maximumSlice = 8 }) {
  assert.ok(isAbsolute(planFile) && isAbsolute(outputRoot)); assert.equal(resolve(planFile), planFile);
  assert.equal(await realpath(planFile), planFile); assert.equal(resolve(outputRoot), outputRoot);
  assert.equal(await realpath(dirname(outputRoot)), dirname(outputRoot));
  assert.ok(Number.isSafeInteger(maximumSlice) && maximumSlice > 0);
  const bytes = await readFile(planFile), plan = JSON.parse(bytes); validateBatchPlan(plan);
  assert.equal(planFile, join(plan.execution.control_root, 'plan.json'));
  const amendment = await verifyStandingPlan(plan);
  assert.ok(outputRoot.startsWith(plan.execution.environment_root + '/control/'));
  await mkdir(outputRoot, { mode: 0o700 });
  const planReference = { path: planFile, sha256: sha(bytes) };
  await save(join(outputRoot, 'claim.json'), { version: 1, kind: 'standing-campaign-runner-claim',
    plan: planReference, authorization: amendment.authorization, work_plan: amendment.work_plan,
    work_item_id: amendment.work_item_id, attempt_id: plan.id, pid: process.pid, started_at: new Date().toISOString(),
    checkpoint_interval: maximumSlice, resource_policy: { mode: 'unbounded' }, supervised_recovery_authorized: true });
  let checkpoints = 0, ledgerSnapshot = null;
  const ledgerPath = join(plan.execution.control_root, 'ledger.jsonl');
  const ledgerReference = async () => {
    try { return { path: ledgerPath, sha256: sha(await readFile(ledgerPath)) }; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const readRows = async () => {
    let bytes;
    try { bytes = await readFile(ledgerPath); }
    catch (error) { if (error.code === 'ENOENT') { ledgerSnapshot = null; return []; } throw error; }
    assert.ok(!bytes.length || bytes.at(-1) === 10, 'STANDING_INCOMPLETE_LEDGER'); ledgerSnapshot = { path: ledgerPath, sha256: sha(bytes) };
    return bytes.toString().split('\n').filter(Boolean).map(JSON.parse);
  };
  try {
    const result = await runStandingSlices({ plan, maximumSlice, readRows,
      runSlice: limit => executeBatchPlan({ plan, maximumNewEpisodes: limit }),
      writeCheckpoint: async checkpoint => {
        checkpoints++; await save(join(outputRoot, 'checkpoint-' + String(checkpoints).padStart(3, '0') + '.json'), {
          version: 1, kind: 'standing-campaign-prefix-checkpoint', recorded_at: new Date().toISOString(), ...checkpoint,
          plan: planReference, ledger: ledgerSnapshot });
      },
      verifySnapshot: async () => {
        assert.deepEqual(await ledgerReference(), ledgerSnapshot, 'STANDING_LEDGER_CHANGED_DURING_REVIEW');
        await verifyStandingPlan(plan);
        assert.deepEqual(await ledgerReference(), ledgerSnapshot, 'STANDING_LEDGER_CHANGED_DURING_REVIEW');
      },
      analyzePrefix: async checkpoint => {
        const analysis = join(outputRoot, 'analysis-prefix-' + String(checkpoint.completed_prefix).padStart(3, '0'));
        await withoutStandingAnalysisCredentials({ apiKeyEnv: plan.execution.credential.api_key_env },
          () => analyzeBatch({ root: plan.execution.control_root, outputDirectory: analysis }));
        await save(join(outputRoot, 'analysis-' + String(checkpoints).padStart(3, '0') + '.json'), {
          completed_prefix: checkpoint.completed_prefix, output: analysis, new_completed: checkpoint.new_completed });
      },
    });
    const receipt = { version: 1, kind: 'standing-campaign-runner-receipt', status: result.action === 'finish' ? 'completed' : 'stopped',
      plan: planReference, authorization: amendment.authorization, work_plan: amendment.work_plan, work_item_id: amendment.work_item_id,
      attempt_id: plan.id, completed_at: new Date().toISOString(), checkpoints, result, ledger: await ledgerReference(),
      resource_policy: { mode: 'unbounded' }, supervised_recovery_authorized: true };
    await save(join(outputRoot, 'receipt.json'), receipt); return receipt;
  } catch (error) {
    let ledger = null; try { ledger = await ledgerReference(); } catch {}
    const receipt = { version: 1, kind: 'standing-campaign-runner-receipt', status: 'stopped', completed_at: new Date().toISOString(),
      plan: planReference, authorization: amendment.authorization, work_plan: amendment.work_plan, work_item_id: amendment.work_item_id,
      attempt_id: plan.id, checkpoints, ledger, error: { name: error.name, message: error.message }, execution_performed: null,
      resource_policy: { mode: 'unbounded' }, supervised_recovery_authorized: true };
    await save(join(outputRoot, 'receipt.json'), receipt); return receipt;
  }
}
