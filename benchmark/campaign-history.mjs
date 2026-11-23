import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { readEvidenceBundle } from './evidence/store.mjs';
import { verifyAnalysisRevision } from './revision.mjs';
import { verifyCollectionRecoveryResults } from './collection-recovery.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const usageKeys = ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms'];
const knownUsage = usage => usageKeys.every(key => Number.isFinite(usage?.[key]) && usage[key] >= 0);
const reference = async path => ({ path, sha256: sha(await readFile(path)) });
const read = async path => JSON.parse(await readFile(path, 'utf8'));

// Hooks are module-owned contract checks, never read from a setup or a receipt.
// The legacy wrapper keeps its pilot-only identity requirement and exact output.
async function readClosedLedger(path) {
  const bytes = await readFile(path);
  assert.ok(bytes.length > 0 && bytes.at(-1) === 10, 'COHORT_HISTORY_INCOMPLETE_LEDGER');
  const rows = bytes.toString('utf8').trimEnd().split('\n').map((line, i) => {
    const row = JSON.parse(line); assert.equal(row.seq, i + 1, 'COHORT_HISTORY_LEDGER_SEQUENCE'); return row;
  });
  assert.equal(rows.at(-1).type, 'batch_closed', 'COHORT_HISTORY_OPEN_BATCH');
  return rows;
}

async function noLease(path) {
  try { await readFile(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.fail('COHORT_HISTORY_LEASE_REQUIRES_RECONCILIATION: ' + path);
}

/** Freeze completed observations in their own environment, including unknown
 * sends and registered same-raw analysis. No old observation earns new credit. */
export async function readCampaignHistory({ planFiles, pilotLedgerRoot, expected, assertPlan, assertModelEvidence, assertOriginalCompleted }) {
  assert.equal(typeof assertPlan, 'function', 'Campaign history requires its trusted plan contract');
  assert.equal(typeof assertModelEvidence, 'function', 'Campaign history requires its trusted model contract');
  assert.ok(isAbsolute(pilotLedgerRoot) && resolve(pilotLedgerRoot) === pilotLedgerRoot);
  assert.equal(await realpath(pilotLedgerRoot), pilotLedgerRoot, 'COHORT_HISTORY_LEDGER_SYMLINK');
  const names = (await readdir(pilotLedgerRoot)).filter(name => /^\d{3}\.json$/.test(name)).sort();
  assert.ok(names.length <= 144, 'PILOT_CAP');
  for (const [index, name] of names.entries()) assert.equal(name, String(index + 1).padStart(3, '0') + '.json', 'COHORT_HISTORY_RESERVATION_GAP');
  const count = expected?.scheduled_episodes ?? names.length;
  assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= names.length, 'COHORT_HISTORY_MISSING');
  const selected = await Promise.all(names.slice(0, count).map(async (name, index) => {
    const path = join(pilotLedgerRoot, name); return { ordinal: index + 1, reference: await reference(path), value: await read(path) };
  }));
  assert.equal(new Set(selected.map(item => item.value.run_id)).size, count, 'COHORT_HISTORY_DUPLICATE_RUN');
  assert.ok(Array.isArray(planFiles)); assert.equal(new Set(planFiles).size, planFiles.length, 'COHORT_HISTORY_DUPLICATE_PLAN');
  const plans = [], owners = new Map();
  for (const path of [...planFiles].sort()) {
    assert.ok(isAbsolute(path)); const plan = await read(path); await assertPlan(plan);
    assert.equal(path, join(plan.execution.control_root, 'plan.json'));
    assert.equal(plan.execution.pilot_ledger_root, pilotLedgerRoot, 'COHORT_HISTORY_FOREIGN_LEDGER');
    assert.ok(isAbsolute(plan.execution.environment_root)); assert.ok(!owners.has(plan.id), 'COHORT_HISTORY_DUPLICATE_PLAN');
    await noLease(join(plan.execution.control_root, 'lease.json'));
    const ledgerPath = join(plan.execution.control_root, 'ledger.jsonl'), rows = await readClosedLedger(ledgerPath);
    const starts = rows.filter(row => row.type === 'episode_started'), completed = rows.filter(row => row.type === 'episode_completed');
    assert.ok(starts.length > 0, 'COHORT_HISTORY_UNUSED_PLAN');
    assert.equal(starts.length, completed.length, 'COHORT_HISTORY_UNRESOLVED');
    assert.equal(new Set(starts.map(row => row.run_id)).size, starts.length);
    assert.equal(new Set(starts.map(row => row.slot_id)).size, starts.length, 'COHORT_HISTORY_DUPLICATE_SLOT');
    assert.equal(new Set(completed.map(row => row.run_id)).size, completed.length);
    assert.ok(starts.every(row => completed.some(item => item.run_id === row.run_id && item.slot_id === row.slot_id)), 'COHORT_HISTORY_UNRESOLVED');
    const applied = rows.filter(row => row.type === 'analysis_revision_applied');
    assert.ok(applied.length <= 1, 'COHORT_HISTORY_REVISION_CHAIN_UNSUPPORTED');
    const revisionReference = applied[0]?.reference ?? null;
    if (assertOriginalCompleted) for (const event of completed) {
      const reservation = selected.find(item => item.value.run_id === event.run_id && item.value.experiment_id === plan.id);
      if (reservation) await assertOriginalCompleted({ plan, event, ordinal: reservation.ordinal, hasRevision: Boolean(revisionReference) });
    }
    const revision = revisionReference ? await verifyAnalysisRevision({ reference: revisionReference, plan }) : null;
    const recovery = await verifyCollectionRecoveryResults(plan, completed);
    const item = { plan: await reference(path), ledger: await reference(ledgerPath), analysis_revision: revisionReference,
      ...(recovery ? { collection_recovery: recovery.reference } : {}) };
    plans.push(item); owners.set(plan.id, { plan, starts, completed, revision, reference: item.plan });
  }
  const episodes = [], subtotal = Object.fromEntries(usageKeys.map(key => [key, 0]));
  for (const item of selected) {
    const reservation = item.value, owner = owners.get(reservation.experiment_id);
    assert.ok(owner, 'COHORT_HISTORY_PLAN_MISSING');
    if (reservation.plan) { assert.deepEqual(reservation.plan, owner.reference); assert.equal(reservation.plan_sha256, owner.plan.plan_sha256); }
    const events = owner.completed.filter(row => row.run_id === reservation.run_id); assert.equal(events.length, 1, 'COHORT_HISTORY_RESULT_MISSING');
    const event = events[0]; assert.equal(event.slot_id, reservation.slot_id);
    const slot = owner.plan.slots.find(slot => slot.slot_id === reservation.slot_id); assert.ok(slot, 'COHORT_HISTORY_UNKNOWN_SLOT');
    const replacement = owner.revision?.replacements.find(row => row.run_id === reservation.run_id);
    if (replacement) assert.equal(replacement.original_episode_sha256, event.result.episode_sha256);
    const directory = replacement?.directory ?? event.result.normalized_directory;
    const { episode } = await readEvidenceBundle({ directory, rawRoot: owner.plan.execution.environment_root });
    assert.equal(episode.episode_sha256, replacement?.new_episode_sha256 ?? event.result.episode_sha256);
    assert.equal(episode.identity.run_id, reservation.run_id); assert.equal(episode.identity.experiment_id, owner.plan.id);
    assert.equal(episode.identity.case_id, slot.case_id); assert.equal(episode.identity.condition_id, slot.condition_id);
    const condition = owner.plan.protocol.conditions.find(condition => condition.id === slot.condition_id);
    const environment = owner.plan.protocol.environments.find(environment => environment.id === condition.environment_id);
    const model = owner.plan.protocol.models.find(model => model.id === condition.model_id);
    assert.equal(episode.identity.model_id, condition.model_id); assert.equal(episode.identity.environment_sha256, environment.manifest_sha256);
    assert.equal(episode.identity.build_id, environment.build.id);
    await assertModelEvidence(episode, model, owner.plan);
    const usage = { model_requests: episode.measurements.actual_attempts.status === 'known' ? episode.measurements.actual_attempts.value : null,
      input_tokens: episode.measurements.input_total.value.status === 'known' ? episode.measurements.input_total.value.value : null,
      output_tokens: episode.measurements.output_total.value.status === 'known' ? episode.measurements.output_total.value.value : null,
      duration_ms: episode.timing.duration_ms.status === 'known' ? episode.timing.duration_ms.value : null };
    assert.deepEqual(usage, replacement?.budget_usage ?? event.result.budget_usage, 'COHORT_HISTORY_USAGE_MISMATCH');
    for (const key of usageKeys) if (usage[key] !== null) subtotal[key] += usage[key];
    episodes.push({ run_id: reservation.run_id, pilot_ordinal: item.ordinal, experiment_id: owner.plan.id,
      directory, episode_sha256: episode.episode_sha256, admission: episode.admission.status, budget_usage: usage,
      core_evidence: episode.admission.status === 'valid' && ['attempts', 'tools', 'interventions'].every(key => episode.admission.completeness[key] === 'complete')
        && knownUsage(usage) && usage.model_requests > 0 && episode.attempts.filter(attempt => attempt.sent).every(attempt => attempt.adapter.verified)
        ? 'complete' : 'incomplete',
      quality_credit: 'excluded_from_new_scope', stop_batch: replacement ? replacement.stop_batch : Boolean(event.result.stop_batch),
      ...(event.result.collection_recovery ? { collection_recovery: event.result.collection_recovery } : {}),
      ...(replacement ? { analysis_revision: plans.find(item => item.plan.path === owner.reference.path).analysis_revision,
        original_directory: event.result.normalized_directory, original_episode_sha256: event.result.episode_sha256 } : {}) });
  }
  assert.equal([...owners.values()].reduce((sum, owner) => sum + owner.starts.length, 0), count, 'COHORT_HISTORY_UNRESERVED_EPISODE');
  const unknown = episodes.filter(item => !knownUsage(item.budget_usage)).map(item => item.run_id).sort();
  const value = { reservations: selected.map(({ ordinal, reference }) => ({ ordinal, reference })), plans, episodes,
    unknown_usage_run_ids: unknown, known_subtotal: subtotal,
    total_usage: Object.fromEntries(usageKeys.map(key => [key, episodes.every(item => item.budget_usage[key] !== null) ? subtotal[key] : null])),
    total_usage_status: unknown.length ? 'incomplete' : 'known', monetary_status: 'unpriced', scheduled_episodes: count };
  if (expected) assert.deepEqual(value, expected, 'COHORT_HISTORY_CHANGED');
  return value;
}

