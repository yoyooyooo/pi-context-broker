import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fingerprint, validateProtocol } from './protocol.mjs';
import { verifyGateReference } from './gate.mjs';
import { verifyCampaignScope, verifyCampaignDispatch, acquireCampaignLease, campaignReservationFields, reconcileCampaignLease } from './campaign-dispatch.mjs';
import { isProspectiveCohort } from './prospective-cohort.mjs';
import { scheduleProtocol } from './campaign-selection.mjs';
export { scheduleProtocol } from './campaign-selection.mjs';

const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const safe = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value);

function validatePilotLedger(protocol, execution) {
  const finite = protocol.policies.campaign || execution.campaign_scope;
  if (finite) {
    const policy = protocol.policies.campaign, registration = execution.campaign_scope;
    assert.ok(policy && registration, 'A finite policy and its execution registration must agree');
    assert.equal(policy.kind, 'benchmark-finite-campaign'); assert.equal(registration.kind, policy.kind);
    assert.equal(registration.version, 1); assert.equal(registration.id, policy.id); assert.equal(registration.role, policy.role);
    assert.ok(['pilot', 'confirmation'].includes(protocol.phase));
    assert.equal(protocol.policies.pilot.scope, undefined); assert.equal(execution.pilot_scope, undefined);
    assert.equal(execution.resumption, undefined, 'A finite campaign is not a legacy resumption');
    assert.ok(isAbsolute(registration.amendment?.path ?? '') && /^[a-f0-9]{64}$/.test(registration.amendment.sha256));
    assert.ok(isAbsolute(execution.pilot_ledger_root ?? ''));
    assert.equal(execution.pilot_ledger_root, resolve(execution.pilot_ledger_root));
    return;
  }
  if (execution.pilot_ledger_root) assert.equal(protocol.phase, 'pilot', 'A shared pilot ledger cannot be used as a development bypass');
  assert.equal(Boolean(protocol.policies.pilot.scope), Boolean(execution.pilot_scope), 'Pilot scope policy and execution registration must agree');
  if (execution.pilot_scope) {
    assert.equal(protocol.phase, 'pilot');
    assert.equal(execution.pilot_scope.id, protocol.policies.pilot.scope.id);
    assert.equal(execution.pilot_scope.role, protocol.policies.pilot.scope.role);
    assert.ok(isAbsolute(execution.pilot_scope.amendment?.path ?? '') && /^[a-f0-9]{64}$/.test(execution.pilot_scope.amendment.sha256));
  }
  if (protocol.phase !== 'pilot') return;
  const path = execution.pilot_ledger_root;
  assert.ok(typeof path === 'string' && isAbsolute(path), 'Pilot plans must freeze their shared pilot ledger');
  assert.equal(path, resolve(path), 'Pilot ledger must use a canonical absolute path');
}

export function freezeBatchPlan({ protocol, execution, registeredAt = new Date().toISOString() }) {
  const validation = validateProtocol(protocol, { stage: 'execute' });
  assert.ok(validation.valid, JSON.stringify(validation.errors));
  assert.ok(execution && isAbsolute(execution.environment_root) && isAbsolute(execution.control_root));
  assert.ok(safe(protocol.id));
  assert.equal(protocol.policies.ordering.concurrency, 1, 'The first implementation dispatches one subject at a time');
  validatePilotLedger(protocol, execution);
  const value = { version: 1, kind: 'benchmark-batch-plan', id: protocol.id, registered_at: registeredAt,
    protocol, execution, slots: scheduleProtocol(protocol), plan_sha256: null };
  value.plan_sha256 = fingerprint(value);
  return value;
}

export function validateBatchPlan(plan) {
  assert.equal(plan?.version, 1); assert.equal(plan.kind, 'benchmark-batch-plan');
  assert.equal(plan.id, plan.protocol.id); assert.ok(safe(plan.id));
  assert.equal(plan.plan_sha256, fingerprint({ ...plan, plan_sha256: null }), 'Frozen execution plan was modified');
  const validation = validateProtocol(plan.protocol, { stage: 'execute' });
  assert.ok(validation.valid, JSON.stringify(validation.errors));
  assert.deepEqual(plan.slots, scheduleProtocol(plan.protocol));
  if (plan.execution.resumption) {
    assert.equal(plan.execution.resumption.kind, 'benchmark-zero-send-resumption');
    assert.deepEqual(plan.execution.resumption.excluded_slot_ids, [plan.slots[0].slot_id]);
    assert.equal(plan.execution.resumption.gate_policy.version, 2);
    assert.equal(plan.execution.resumption.gate_policy.scheduled, 24);
    assert.equal(plan.execution.resumption.gate_policy.minimum_valid_real_per_model_mode, 3);
  }
  assert.ok(isAbsolute(plan.execution.environment_root) && isAbsolute(plan.execution.control_root));
  validatePilotLedger(plan.protocol, plan.execution);
  assert.equal(plan.protocol.policies.ordering.concurrency, 1);
  return plan;
}

export async function verifyRouteGate(plan, revisionOptions = {}) {
  const reference = plan.execution.route_gate;
  if (!reference || !isAbsolute(reference.path ?? '')) return { passed: false, reason: 'route_gate_pending' };
  const gate = await verifyGateReference({ reference, environmentRoot: plan.execution.environment_root });
  if (plan.execution.pilot_scope) {
    const amendment = await verifyCampaignScope(plan, revisionOptions);
    if (isProspectiveCohort(amendment)) {
      assert.equal(gate.kind, 'benchmark-cohort-gate', 'The cohort requires its own gate'); assert.equal(gate.version, 1);
    } else assert.equal(gate.version, 3, 'The legacy scope requires its own v3 gate');
    assert.deepEqual(gate.amendment, plan.execution.pilot_scope.amendment, 'Route gate belongs to another scope amendment');
    assert.equal(gate.scope_id, plan.execution.pilot_scope.id);
    return { passed: true, sha256: reference.sha256 };
  }
  assert.ok(gate.scheduled_episodes >= plan.protocol.policies.pilot.route_gate_episodes);
  assert.ok(gate.episode_evidence.length >= plan.protocol.policies.pilot.route_gate_episodes);
  assert.equal(gate.observer_version, plan.protocol.policies.evidence.observer_version);
  assert.deepEqual(gate.instrumentation, plan.execution.instrumentation, 'The route gate does not cover the actual observer and collector implementation');
  for (const model of plan.protocol.models) assert.ok(gate.model_conditions.includes(fingerprint({ provider: model.provider, route: model.route,
    api: model.api, parameters: model.parameters, adapter: model.adapter })), 'Route gate does not cover a selected model condition');
  for (const environment of plan.protocol.environments) assert.ok(gate.pi_sdk_sha256.includes(environment.runtime.pi.sha256), 'Route gate does not cover the maintained Pi SDK');
  return { passed: true, sha256: reference.sha256 };
}

async function readLedger(path) {
  try {
    const bytes = await readFile(path, 'utf8');
    assert.ok(bytes === '' || bytes.endsWith('\n'), 'Ledger has an incomplete final append; reconcile it before running');
    return bytes.split('\n').filter(Boolean).map((line, i) => {
      const value = JSON.parse(line); assert.equal(value.seq, i + 1, 'Ledger sequence is not contiguous'); return value;
    });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function batchStatus(controlRoot) {
  const plan = validateBatchPlan(JSON.parse(await readFile(join(controlRoot, 'plan.json'), 'utf8')));
  const ledger = await readLedger(join(controlRoot, 'ledger.jsonl'));
  const completed = ledger.filter(e => e.type === 'episode_completed');
  const starts = ledger.filter(e => e.type === 'episode_started');
  const resolved = new Set(completed.map(e => e.run_id));
  const applied = ledger.filter(event => event.type === 'analysis_revision_applied').at(-1);
  let revision = null;
  if (applied) {
    const { verifyAnalysisRevision } = await import('./revision.mjs');
    revision = await verifyAnalysisRevision({ reference: applied.reference, plan });
  }
  const episodes = completed.map(event => {
    const replacement = revision?.replacements.find(item => item.run_id === event.run_id);
    if (!replacement) return { slot_id: event.slot_id, run_id: event.run_id, result: event.result };
    assert.equal(event.result.episode_sha256, replacement.original_episode_sha256);
    return { slot_id: event.slot_id, run_id: event.run_id, result: { ...event.result,
      normalized_directory: replacement.directory, episode_sha256: replacement.new_episode_sha256,
      budget_usage: replacement.budget_usage, stop_batch: false, stop_reason: null, analysis_revision: applied.reference } };
  });
  return { id: plan.id, plan_sha256: plan.plan_sha256, planned: plan.slots.length, scheduled: starts.length,
    completed: completed.length, not_dispatched: ledger.filter(event => event.type === 'episode_not_dispatched'),
    planned_dispatch: plan.slots.length - (plan.execution.resumption?.excluded_slot_ids.length ?? 0),
    unresolved_runs: starts.filter(e => !resolved.has(e.run_id)).map(e => e.run_id),
    last: ledger.at(-1) ?? null, analysis_revision: applied?.reference ?? null, episodes, ledger };
}

/** Restart is read/reconcile only for a started run. It never guesses whether a model call happened. */
export async function runBatch({ plan, executeEpisode, maximumNewEpisodes = Infinity, reconcileEpisode, pilotLedgerRoot,
  analysisRevisionReference, analysisRevision }) {
  validateBatchPlan(plan);
  const scopeAmendment = await verifyCampaignDispatch(plan, { analysisRevisionReference, analysisRevision });
  if (scopeAmendment && plan.execution.pilot_scope?.role === 'expansion') {
    const gate = await verifyRouteGate(plan, { analysisRevisionReference, analysisRevision });
    assert.ok(gate.passed, 'PILOT_SCOPE_GATE_REQUIRED: expansion cannot start before the prospective gate passes');
  }
  const release = scopeAmendment ? await acquireCampaignLease(plan, scopeAmendment) : null;
  try {
    // The lease can be acquired after another controller changed the boundary.
    // Re-read both registration and current evidence under our own lease.
    await verifyCampaignDispatch(plan, { activate: true, analysisRevisionReference, analysisRevision });
    return await runBatchOwned({ plan, executeEpisode, maximumNewEpisodes, reconcileEpisode, pilotLedgerRoot,
      analysisRevisionReference, analysisRevision, scopeAmendment });
  } finally { if (release) await release(); }
}

async function runBatchOwned({ plan, executeEpisode, maximumNewEpisodes, reconcileEpisode, pilotLedgerRoot,
  analysisRevisionReference, analysisRevision, scopeAmendment }) {
  validateBatchPlan(plan);
  assert.ok(typeof executeEpisode === 'function');
  assert.ok(maximumNewEpisodes === Infinity || Number.isSafeInteger(maximumNewEpisodes) && maximumNewEpisodes >= 0);
  if (plan.protocol.phase === 'pilot' || plan.execution.campaign_scope) {
    const frozen = plan.execution.pilot_ledger_root;
    assert.ok(pilotLedgerRoot === undefined || pilotLedgerRoot === frozen, 'Pilot ledger override differs from the frozen plan');
    assert.equal(await realpath(dirname(frozen)), dirname(frozen), 'Pilot ledger parent must be canonical');
    await mkdir(frozen, { recursive: true });
    assert.equal(await realpath(frozen), frozen, 'Pilot ledger cannot be a symlink');
    pilotLedgerRoot = frozen;
  }
  const root = plan.execution.control_root;
  await mkdir(root, { recursive: true });
  const planPath = join(root, 'plan.json');
  try { await save(planPath, plan); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.deepEqual(JSON.parse(await readFile(planPath, 'utf8')), plan); }
  // Exclusive lease remains as an audit record. A crashed lease requires explicit evidence-based recovery.
  const leasePath = join(root, 'lease.json');
  const lease = { id: randomUUID(), pid: process.pid, started_at: new Date().toISOString(), plan_sha256: plan.plan_sha256 };
  try { await save(leasePath, lease); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const old = JSON.parse(await readFile(leasePath, 'utf8'));
    throw Object.assign(new Error('Existing batch lease ' + old.id + ' must finish or be explicitly reconciled; no model execution was started'),
      { code: 'BATCH_LEASE_EXISTS', lease: old });
  }
  const path = join(root, 'ledger.jsonl'), ledger = await readLedger(path);
  async function append(type, data = {}) {
    const event = { version: 1, seq: ledger.length + 1, at: new Date().toISOString(), monotonic_ns: process.hrtime.bigint().toString(),
      clock_domain: 'batch-' + lease.id, type, ...data };
    await appendFile(path, JSON.stringify(event) + '\n', { mode: 0o600 }); ledger.push(event); return event;
  }
  await append('batch_opened', { plan_sha256: plan.plan_sha256, lease_id: lease.id });
  if (analysisRevisionReference) {
    assert.ok(analysisRevision);
    const previousRevision = ledger.filter(event => event.type === 'analysis_revision_applied').at(-1);
    if (previousRevision) assert.deepEqual(previousRevision.reference, analysisRevisionReference, 'Only the registered analysis revision may be resumed');
    else await append('analysis_revision_applied', { reference: analysisRevisionReference, model_execution: false,
      replacement_run_ids: analysisRevision.replacements.map(item => item.run_id), source_implementation_sha256: analysisRevision.implementation.sha256 });
  }
  let newCount = 0, stopReason = null;
  const retainedStop = ledger.find(event => event.type === 'episode_completed' && event.result?.stop_batch
    && !analysisRevision?.replacements.some(item => item.run_id === event.run_id && item.stop_batch === false));
  if (retainedStop) stopReason = retainedStop.result.stop_reason ?? 'retained_core_evidence_failure';
  const startedAt = performance.now();
  const limits = plan.protocol.policies.budgets;
  function usageFor(budgetId) {
    const conditionIds = new Set(plan.protocol.conditions.filter(c => c.budget_id === budgetId).map(c => c.id));
    const events = ledger.filter(e => e.type === 'episode_completed' && conditionIds.has(e.condition_id));
    const sums = { episodes: ledger.filter(e => e.type === 'episode_started' && conditionIds.has(e.condition_id)).length,
      model_requests: 0, input_tokens: 0, output_tokens: 0, duration_ms: 0, unknown: false };
    for (const event of events) {
      const replacement = analysisRevision?.replacements.find(item => item.run_id === event.run_id);
      for (const key of ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms']) {
        const n = (replacement?.budget_usage ?? event.result?.budget_usage)?.[key];
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) sums.unknown = true;
        else sums[key] += n;
      }
    }
    return sums;
  }
  let verifiedPilotGate = false;
  function deadlineReason(condition, budget) {
    if (performance.now() - startedAt >= budget.batch.max_duration_ms) return 'batch_budget_exhausted';
    const model = plan.protocol.models.find(item => item.id === condition.model_id), now = Date.now();
    if (now < Date.parse(model.backend.window.start) || now >= Date.parse(model.backend.window.end)) return 'model_window_closed';
    return null;
  }
  async function reservePilot(runId, slot, condition, budget) {
    if (plan.protocol.phase !== 'pilot' && !plan.execution.campaign_scope) return;
    assert.equal(pilotLedgerRoot, plan.execution.pilot_ledger_root, 'Pilot ledger must remain bound to the frozen plan');
    assert.equal(await realpath(pilotLedgerRoot), pilotLedgerRoot, 'Pilot ledger cannot change to a symlink');
    await verifyCampaignDispatch(plan, { forReservation: Boolean(scopeAmendment) });
    const scopeFields = scopeAmendment ? campaignReservationFields(plan, scopeAmendment,
      { path: planPath, sha256: createHash('sha256').update(await readFile(planPath)).digest('hex') }) : {};
    // O_EXCL reservations make the cap independent of retries, batch names and concurrent controllers.
    for (let n = 1; n <= plan.protocol.policies.pilot.max_scheduled_episodes; n++) {
      if (!scopeAmendment && n > plan.protocol.policies.pilot.route_gate_episodes && !verifiedPilotGate) {
        const gate = await verifyRouteGate(plan);
        if (!gate.passed) throw Object.assign(new Error('Route evidence gate must pass before expanding beyond the first 24 scheduled episodes'), { code: 'ROUTE_GATE' });
        verifiedPilotGate = true;
      }
      // History, the legacy route gate and an EEXIST scan can cross a deadline.
      // Check immediately before every exclusive reservation, not only before
      // the costly proof. Expiration closes the batch without a started slot.
      const reason = deadlineReason(condition, budget); if (reason) return { reason };
      try { await save(join(pilotLedgerRoot, String(n).padStart(3, '0') + '.json'), { run_id: runId, experiment_id: plan.id, slot_id: slot.slot_id, at: new Date().toISOString(), ...scopeFields }); return { ordinal: n }; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    throw Object.assign(new Error('Pilot scheduling cap reached including invalid and replacements'), { code: 'PILOT_CAP' });
  }
  for (const slot of plan.slots) {
    if (stopReason) break;
    if (plan.execution.resumption?.excluded_slot_ids.includes(slot.slot_id)) {
      if (!ledger.some(event => event.type === 'episode_not_dispatched' && event.slot_id === slot.slot_id))
        await append('episode_not_dispatched', { ...slot, reason: 'retained_prior_zero_send_invalid',
          prior_run_id: plan.execution.resumption.prior_run_id, prior_plan: plan.execution.resumption.prior_plan,
          repair: plan.execution.resumption.repair, current_plan_observation: 'missing; not credited as success' });
      continue;
    }
    const finished = ledger.find(e => e.type === 'episode_completed' && e.slot_id === slot.slot_id);
    if (finished) continue;
    const previous = ledger.find(e => e.type === 'episode_started' && e.slot_id === slot.slot_id);
    if (previous) {
      const recovered = reconcileEpisode ? await reconcileEpisode(previous, plan) : null;
      if (!recovered) { stopReason = 'unresolved_previous_execution'; await append('batch_stopped', { reason: stopReason, run_id: previous.run_id }); break; }
      await append('episode_completed', { ...slot, run_id: previous.run_id, condition_id: slot.condition_id, result: recovered, reconciled: true });
      if (recovered.stop_batch) { stopReason = recovered.stop_reason ?? 'core_evidence_failure'; break; }
      continue;
    }
    if (newCount >= maximumNewEpisodes) { stopReason = 'operator_slice_limit'; break; }
    const condition = plan.protocol.conditions.find(c => c.id === slot.condition_id);
    const budget = limits.find(b => b.id === condition.budget_id), used = usageFor(budget.id);
    if (used.unknown) { stopReason = 'unknown_budget_usage'; break; }
    const deadline = deadlineReason(condition, budget);
    if (deadline) { stopReason = deadline; break; }
    if (used.episodes >= budget.batch.max_episodes
      || ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms'].some(k => used[k] + budget.episode['max_' + k] > budget.batch['max_' + k])) {
      stopReason = 'batch_budget_exhausted'; break;
    }
    const runId = plan.id + '-' + String(slot.order + 1).padStart(3, '0');
    assert.ok(safe(runId));
    try {
      const reservation = await reservePilot(runId, slot, condition, budget);
      if (reservation?.reason) { stopReason = reservation.reason; break; }
    }
    catch (error) {
      if (!['PILOT_CAP', 'COHORT_CAP', 'ROUTE_GATE'].includes(error.code)) throw error;
      stopReason = error.code === 'PILOT_CAP' ? 'pilot_cap' : error.code === 'COHORT_CAP' ? 'cohort_cap' : 'route_gate_pending'; break;
    }
    await append('episode_started', { ...slot, run_id: runId, condition_id: slot.condition_id, budget_id: budget.id });
    newCount++;
    let result;
    try { result = await executeEpisode({ slot, runId, condition, budget, plan }); }
    catch (error) {
      await append('episode_unresolved', { ...slot, run_id: runId, error: { name: error.name, message: error.message } });
      stopReason = 'unresolved_execution_error'; break;
    }
    assert.ok(result && typeof result === 'object');
    await append('episode_completed', { ...slot, run_id: runId, condition_id: slot.condition_id, result });
    if (result.stop_batch) { stopReason = result.stop_reason ?? 'core_evidence_failure'; break; }
  }
  await append('batch_closed', { reason: stopReason ?? (plan.execution.resumption ? 'declared_continuation_completed' : 'planned_slots_completed'), new_episodes: newCount });
  await save(join(root, 'lease-completed-' + lease.id + '.json'), { ...lease, completed_at: new Date().toISOString(), reason: stopReason });
  await rename(leasePath, join(root, 'lease-retained-' + lease.id + '.json'));
  return batchStatus(root);
}

/** Explicit controller recovery preserves the old lease and never executes a subject. */
export async function reconcileBatchLease({ controlRoot, leaseId }) {
  assert.ok(isAbsolute(controlRoot));
  const path = join(controlRoot, 'lease.json');
  let lease;
  try { lease = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const plan = validateBatchPlan(JSON.parse(await readFile(join(controlRoot, 'plan.json'), 'utf8')));
    const recovered = await reconcileCampaignLease({ plan, leaseId });
    assert.ok(recovered, 'No matching interrupted batch or scope lease');
    return { ...await batchStatus(controlRoot), scope_recovery: recovered };
  }
  assert.equal(lease.id, leaseId, 'Recovery must name the observed interrupted lease');
  let live = false;
  try { process.kill(lease.pid, 0); live = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
  assert.ok(!live, 'An active owner cannot be recovered');
  const status = await batchStatus(controlRoot);
  await save(join(controlRoot, 'lease-recovery-' + leaseId + '.json'), { lease, at: new Date().toISOString(), unresolved_runs: status.unresolved_runs,
    action: 'release_dead_owner_only', model_execution: false });
  const plan = validateBatchPlan(JSON.parse(await readFile(join(controlRoot, 'plan.json'), 'utf8')));
  await reconcileCampaignLease({ plan, leaseId, batchLease: lease });
  await rename(path, join(controlRoot, 'lease-interrupted-' + leaseId + '.json'));
  return status;
}
