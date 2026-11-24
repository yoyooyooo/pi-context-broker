import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fingerprint, validateProtocol } from './protocol.mjs';
import { readCampaignHistory } from './campaign-history.mjs';
import { assertCohortModelEvidence, isProspectiveCohort } from './prospective-cohort.mjs';
import { assertRetainedAliasEpisode } from './campaign-alias-revision.mjs';
import { readEvidenceBundle } from './evidence/store.mjs';
// These functions check a supplied plan/parent or original result. They never
// resolve an authority or walk lineage. Keep this dependency shallow.
import { assertFiniteCampaignPlan, verifyAuthorizedHistoryPlan, verifyFiniteOriginalResults } from './finite-campaign.mjs';

export const HISTORY_EXTENSION = 'accepted-history-extension';
const usageKeys = ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms'];
const known = value => Number.isFinite(value) && value >= 0;
const tokenUnknown = usage => !known(usage?.input_tokens) || !known(usage?.output_tokens);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clean = ref => ({ path: ref.path, sha256: ref.sha256 });
const sorted = values => [...values].sort();
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const keys = (value, expected, code) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), code);
  assert.deepEqual(sorted(Object.keys(value)), sorted(expected), code);
};
async function file(path) {
  assert.ok(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'HISTORY_EXTENSION_CANONICAL_PATH');
  const before = await lstat(path); assert.ok(before.isFile() && !before.isSymbolicLink(), 'HISTORY_EXTENSION_REGULAR_FILE');
  assert.equal(await realpath(path), path, 'HISTORY_EXTENSION_PATH_SYMLINK');
  const bytes = await readFile(path), after = await lstat(path);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(before[key], after[key], 'HISTORY_EXTENSION_READ_CHANGED');
  return { reference: { path, sha256: sha(bytes) }, bytes };
}
async function verified(reference, { json = true } = {}) {
  keys(reference, ['path', 'sha256'], 'HISTORY_EXTENSION_REFERENCE_SHAPE');
  assert.match(reference.sha256, /^[a-f0-9]{64}$/);
  const result = await file(reference.path);
  assert.deepEqual(result.reference, reference, 'HISTORY_EXTENSION_REFERENCED_BYTES_CHANGED');
  return json ? JSON.parse(result.bytes) : result.bytes;
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.fail('HISTORY_EXTENSION_ACTIVE_LEASE: ' + path);
}
async function currentBoundarySnapshot(root, count, sequence) {
  const names = await readdir(root);
  await absent(join(root, 'campaign.lease.json'));
  assert.ok(!names.some(name => /^scope-.+\.lease\.json$/.test(name)), 'HISTORY_EXTENSION_ACTIVE_LEASE');
  assert.equal(names.filter(name => /^\d{3}\.json$/.test(name)).length, count, 'HISTORY_EXTENSION_CURRENT_BOUNDARY_CHANGED');
  if (sequence !== undefined)
    assert.equal(names.filter(name => /^scope-registration(?:-\d{3})?\.json$/.test(name)).length, sequence, 'HISTORY_EXTENSION_REGISTRY_ADVANCED');
  return names;
}
async function closedLedger(plan) {
  await absent(join(plan.execution.control_root, 'lease.json'));
  const result = await file(join(plan.execution.control_root, 'ledger.jsonl'));
  assert.equal(result.bytes.at(-1), 10, 'HISTORY_EXTENSION_INCOMPLETE_LEDGER');
  const rows = result.bytes.toString().trimEnd().split('\n').map((line, index) => {
    const row = JSON.parse(line); assert.equal(row.seq, index + 1, 'HISTORY_EXTENSION_LEDGER_SEQUENCE'); return row;
  });
  assert.equal(rows.at(-1)?.type, 'batch_closed', 'HISTORY_EXTENSION_OPEN_SCOPE');
  return { rows, reference: result.reference };
}
function prefix(current, previous) {
  assert.ok(current.scheduled_episodes >= previous.scheduled_episodes, 'HISTORY_EXTENSION_PREFIX_COUNT');
  for (const key of ['reservations', 'episodes'])
    assert.deepEqual(current[key].slice(0, previous.scheduled_episodes), previous[key], 'HISTORY_EXTENSION_PREFIX_CHANGED');
  for (const owner of previous.plans)
    assert.deepEqual(current.plans.find(item => item.plan.path === owner.plan.path), owner, 'HISTORY_EXTENSION_PREFIX_OWNER_CHANGED');
}

async function decision({ parent, parentReference, userApproval }) {
  assert.ok([2, 3].includes(parent.version), 'HISTORY_EXTENSION_PARENT_VERSION');
  assert.ok(inside(parent.environment_root, userApproval?.path ?? ''), 'HISTORY_EXTENSION_DECISION_OUTSIDE_OWNER');
  const value = await verified(userApproval);
  keys(value, ['version', 'kind', 'approved', 'source', 'user_message', 'accepted_at', 'authorization_scope',
    'parent_authorization', 'accepted_proposal', 'accepted_reviewable_draft', 'current_reservations',
    'retained_effective_unknown_token_episodes', 'retained_original_unknown_token_episodes', 'approved_remaining_reservations',
    'total_reservation_ceiling', 'max_scheduled_episodes', 'unallocated_headroom', 'additional_reservations',
    'next_allocation_id', 'remaining_allocations', 'future_core_stop_policy', 'future_unknown_usage_policy',
    'retained_stop', 'provider_diagnosis_authorized'], 'HISTORY_EXTENSION_DECISION_SHAPE');
  assert.equal(value.version, 1); assert.equal(value.kind, 'user-approved-campaign-history-extension-decision');
  assert.equal(value.approved, true, 'HISTORY_EXTENSION_EXPLICIT_DECISION_REQUIRED');
  assert.equal(value.source, 'current-user-message');
  for (const key of ['user_message', 'authorization_scope']) assert.ok(typeof value[key] === 'string' && value[key].trim());
  assert.ok(Number.isFinite(Date.parse(value.accepted_at)), 'HISTORY_EXTENSION_DECISION_TIMESTAMP');
  assert.equal(typeof value.provider_diagnosis_authorized, 'boolean');
  assert.deepEqual(value.parent_authorization, parentReference, 'HISTORY_EXTENSION_DECISION_PARENT_CHANGED');
  const proposal = await verified(value.accepted_proposal);
  assert.equal(proposal.version, 1); assert.equal(proposal.kind, 'prospective-decision-draft-not-an-authorization');
  assert.equal(proposal.status, 'awaiting_user_decision');
  assert.equal(proposal.approved, false, 'HISTORY_EXTENSION_ORIGINAL_DRAFT_CHANGED'); assert.equal(proposal.execution_authority, null);
  assert.deepEqual(proposal.existing_campaign_authority, parentReference, 'HISTORY_EXTENSION_DRAFT_PARENT_CHANGED');
  assert.deepEqual(proposal.existing_ordinary_work_approval, parent.user_approval, 'HISTORY_EXTENSION_ORIGINAL_APPROVAL_CHANGED');
  assert.deepEqual(proposal.approved_proposal_constraints_source, parent.proposal, 'HISTORY_EXTENSION_ORIGINAL_PROPOSAL_CHANGED');
  assert.deepEqual(value.accepted_reviewable_draft, proposal.reviewable_draft, 'HISTORY_EXTENSION_DRAFT_CHANGED');
  assert.ok((await verified(value.accepted_reviewable_draft, { json: false })).length > 0);
  assert.deepEqual(value.retained_stop, proposal.retained_stop, 'HISTORY_EXTENSION_DECISION_STOP_CHANGED');
  for (const [left, right] of [['current_reservations', 'current_reservations'],
    ['retained_effective_unknown_token_episodes', 'retained_effective_unknown_token_episodes'],
    ['retained_original_unknown_token_episodes', 'retained_original_unknown_token_episodes'],
    ['total_reservation_ceiling', 'total_approved_ceiling_unchanged'], ['max_scheduled_episodes', 'absolute_ceiling_unchanged'],
    ['additional_reservations', 'additional_reservations_requested'], ['unallocated_headroom', 'unallocated_reservations_stay_unused'],
    ['remaining_allocations', 'remaining_allocations']]) assert.deepEqual(value[left], proposal[right], 'HISTORY_EXTENSION_DRAFT_LIMIT_CHANGED');
  for (const key of ['total_reservation_ceiling', 'max_scheduled_episodes'])
    assert.equal(value[key], parent[key], 'HISTORY_EXTENSION_BUDGET_CHANGED');
  assert.equal(value.additional_reservations, 0, 'HISTORY_EXTENSION_ADDED_BUDGET');
  assert.equal(value.current_reservations + value.approved_remaining_reservations, parent.total_reservation_ceiling);
  assert.equal(value.unallocated_headroom, parent.max_scheduled_episodes - parent.total_reservation_ceiling);
  assert.equal(value.future_core_stop_policy, 'stop'); assert.equal(value.future_unknown_usage_policy, 'stop');
  assert.equal(value.next_allocation_id, value.remaining_allocations[0]?.id, 'HISTORY_EXTENSION_NEXT_ALLOCATION_CHANGED');
  const stop = await verified(value.retained_stop);
  for (const [left, right] of [['physical_reservations', 'current_reservations'], ['approved_total', 'total_reservation_ceiling'],
    ['hard_limit', 'max_scheduled_episodes'], ['remaining_approved_unsent', 'approved_remaining_reservations'], ['unallocated_spare', 'unallocated_headroom']])
    assert.equal(stop[left], value[right], 'HISTORY_EXTENSION_STOP_LIMIT_CHANGED');
  return { value, proposal, stop };
}

// Derive consumed allocations from the immutable registration chain, never from
// a caller-supplied list. A scope must spend its entire original allocation.
export async function readRegisteredAllocationScopes(parent, parentReference, predecessor, { partialTerminal = false } = {}) {
  keys(predecessor, ['registration', 'amendment'], 'HISTORY_EXTENSION_PREDECESSOR_SHAPE');
  const reverse = [], seen = new Set(); let cursor = predecessor;
  while (fingerprint(cursor) !== fingerprint(parent.predecessor)) {
    assert.ok(reverse.length < parent.allocations.length, 'HISTORY_EXTENSION_REGISTRATION_CHAIN');
    assert.ok(!seen.has(cursor.registration.path), 'HISTORY_EXTENSION_REGISTRATION_CYCLE'); seen.add(cursor.registration.path);
    const registration = await verified(cursor.registration), amendment = await verified(cursor.amendment);
    assert.equal(registration.version, 1); assert.equal(registration.kind, 'benchmark-finite-campaign-succession');
    assert.equal(amendment.version, 2); assert.equal(amendment.kind, 'benchmark-finite-campaign');
    assert.deepEqual(registration.amendment, cursor.amendment, 'HISTORY_EXTENSION_REGISTERED_AMENDMENT_CHANGED');
    assert.equal(registration.id, amendment.id);
    assert.deepEqual(registration.predecessor, amendment.predecessor.registration, 'HISTORY_EXTENSION_REGISTRATION_PREDECESSOR_CHANGED');
    assert.deepEqual(amendment.prospective_authorization?.reference, parentReference, 'HISTORY_EXTENSION_SCOPE_AUTHORITY_CHANGED');
    const allocation = parent.allocations.find(item => item.id === amendment.id);
    assert.ok(allocation, 'HISTORY_EXTENSION_FOREIGN_ALLOCATION');
    assert.equal(amendment.role, allocation.role, 'HISTORY_EXTENSION_ALLOCATION_ROLE_CHANGED');
    assert.equal(amendment.reservation_limit, allocation.reservation_limit, 'HISTORY_EXTENSION_PARTIAL_ALLOCATION');
    await absent(join(parent.pilot_ledger_root, 'scope-' + allocation.id + '.lease.json'));
    assert.equal(amendment.environment_root, parent.environment_root); assert.equal(amendment.pilot_ledger_root, parent.pilot_ledger_root);
    assert.equal(cursor.registration.path, join(parent.pilot_ledger_root, 'scope-registration-' + String(registration.sequence).padStart(3, '0') + '.json'));
    assert.equal(cursor.amendment.path, join(amendment.plan.control_root, 'finite-campaign-amendment.json'));
    const planFile = await file(join(amendment.plan.control_root, 'plan.json')), plan = JSON.parse(planFile.bytes);
    assert.deepEqual(plan.execution.campaign_scope?.amendment, cursor.amendment, 'HISTORY_EXTENSION_PLAN_AMENDMENT_CHANGED');
    assertFiniteCampaignPlan(plan, amendment);
    const ledger = await closedLedger(plan);
    assert.ok(!ledger.rows.some(row => ['analysis_revision_applied', 'collection_recovery_applied', 'episode_not_dispatched'].includes(row.type)), 'HISTORY_EXTENSION_SOURCE_REINTERPRETED');
    const starts = ledger.rows.filter(row => row.type === 'episode_started'), completed = ledger.rows.filter(row => row.type === 'episode_completed');
    const selected = partialTerminal && reverse.length === 0 ? plan.slots.slice(0, starts.length) : plan.slots;
    assert.ok(selected.length > 0 && selected.length <= allocation.reservation_limit, 'HISTORY_EXTENSION_PARTIAL_SCOPE');
    for (const rows of [starts, completed]) {
      assert.equal(rows.length, selected.length, 'HISTORY_EXTENSION_PARTIAL_SCOPE');
      assert.equal(new Set(rows.map(row => row.run_id)).size, rows.length, 'HISTORY_EXTENSION_DUPLICATE_RUN');
      assert.deepEqual(rows.map(row => row.slot_id), selected.map(slot => slot.slot_id), 'HISTORY_EXTENSION_SLOT_ORDER');
      for (const [index, row] of rows.entries())
        assert.equal(row.run_id, plan.id + '-' + String(plan.slots[index].order + 1).padStart(3, '0'), 'HISTORY_EXTENSION_RUN_ID_CHANGED');
    }
    for (const row of completed) assert.equal(row.result.collection_recovery, undefined, 'HISTORY_EXTENSION_SOURCE_REINTERPRETED');
    reverse.push({ reference: structuredClone(cursor), registration, amendment, allocation, plan, planReference: planFile.reference, ledger, completed });
    cursor = amendment.predecessor;
  }
  assert.ok(reverse.length > 0, 'HISTORY_EXTENSION_EMPTY_SUFFIX');
  const scopes = reverse.reverse(), prior = await verified(parent.predecessor.registration);
  assert.equal(scopes[0].allocation.id, parent.version === 2 ? parent.revision.followup_allocation_id : parent.revision.next_allocation_id,
    'HISTORY_EXTENSION_FIRST_ALLOCATION_CHANGED');
  assert.equal(new Set(scopes.map(scope => scope.allocation.id)).size, scopes.length, 'HISTORY_EXTENSION_ALLOCATION_REUSED');
  for (const [index, scope] of scopes.entries()) assert.equal(scope.registration.sequence, (prior.sequence ?? 1) + index + 1, 'HISTORY_EXTENSION_REGISTRATION_GAP');
  return scopes;
}

function before(history, count, plans) {
  const episodes = history.episodes.slice(0, count), ids = new Set(episodes.map(item => item.experiment_id));
  const subtotal = Object.fromEntries(usageKeys.map(key => [key, episodes.reduce((sum, item) => sum + (item.budget_usage[key] ?? 0), 0)]));
  const unknown = episodes.filter(item => !usageKeys.every(key => known(item.budget_usage[key]))).map(item => item.run_id).sort();
  return { reservations: history.reservations.slice(0, count), plans: history.plans.filter(item => ids.has(plans.get(item.plan.path).id)), episodes,
    unknown_usage_run_ids: unknown, known_subtotal: subtotal,
    total_usage: Object.fromEntries(usageKeys.map(key => [key, episodes.every(item => item.budget_usage[key] !== null) ? subtotal[key] : null])),
    total_usage_status: unknown.length ? 'incomplete' : 'known', monetary_status: 'unpriced', scheduled_episodes: count };
}

/** Re-read the original sources at the accepted boundary. Existing authorities
 * may be read during a later batch; only preparation requires the ledger to be
 * exactly at this boundary and all campaign leases to be absent. */
export async function readHistoryExtension({ parent: authorized, parentReference, userApproval, predecessor,
  planFiles, pilotLedgerRoot, expected, currentBoundary = false }) {
  const parent = authorized.value, accepted = await decision({ parent, parentReference, userApproval });
  assert.equal(pilotLedgerRoot, parent.pilot_ledger_root);
  const names = currentBoundary ? await currentBoundarySnapshot(pilotLedgerRoot, accepted.value.current_reservations) : [];
  const scopes = await readRegisteredAllocationScopes(parent, parentReference, predecessor);
  const last = scopes.at(-1), terminal = last.completed.at(-1), count = parent.history.scheduled_episodes + scopes.reduce((sum, scope) => sum + scope.allocation.reservation_limit, 0);
  assert.equal(count, accepted.value.current_reservations, 'HISTORY_EXTENSION_SCOPE_COUNT_CHANGED');
  if (currentBoundary) {
    const registrations = names.filter(name => /^scope-registration(?:-\d{3})?\.json$/.test(name));
    assert.equal(registrations.length, last.registration.sequence, 'HISTORY_EXTENSION_REGISTRY_ADVANCED');
  }
  assert.equal(terminal.run_id, accepted.stop.last_run, 'HISTORY_EXTENSION_STOP_RUN_CHANGED');
  assert.deepEqual(terminal.result, accepted.stop.last_run_result, 'HISTORY_EXTENSION_STOP_RESULT_CHANGED');
  assert.deepEqual(last.ledger.reference, accepted.stop.ledger, 'HISTORY_EXTENSION_STOP_LEDGER_CHANGED');
  assert.equal(accepted.stop.scope_completed, last.allocation.reservation_limit);
  assert.equal(terminal.result.stop_batch, true, 'HISTORY_EXTENSION_TERMINAL_STOP_REQUIRED');
  assert.equal(terminal.result.status, 'invalid'); assert.ok(tokenUnknown(terminal.result.budget_usage), 'HISTORY_EXTENSION_STOP_USAGE_MUST_REMAIN_UNKNOWN');
  const expectedPlans = [...parent.history.plans.map(item => item.plan.path), ...scopes.map(scope => scope.planReference.path)];
  assert.deepEqual(sorted(planFiles), sorted(expectedPlans), 'HISTORY_EXTENSION_PLAN_SET_CHANGED');
  const consumed = scopes.map(scope => scope.allocation.id), allocations = parent.allocations.filter(item => !consumed.includes(item.id));
  assert.deepEqual(allocations, accepted.value.remaining_allocations, 'HISTORY_EXTENSION_ALLOCATION_CHANGED');
  assert.equal(allocations.reduce((sum, item) => sum + item.reservation_limit, 0), accepted.value.approved_remaining_reservations);
  const plans = new Map(), originals = new Map();
  const history = await readCampaignHistory({ planFiles, pilotLedgerRoot, ...(expected ? { expected } : {}),
    assertPlan: async plan => {
      assert.equal(plan.version, 1); assert.equal(plan.kind, 'benchmark-batch-plan');
      assert.equal(plan.plan_sha256, fingerprint({ ...plan, plan_sha256: null }), 'HISTORY_EXTENSION_PLAN_CHANGED');
      assert.equal(validateProtocol(plan.protocol, { stage: 'execute' }).valid, true);
      assert.equal(plan.id, plan.protocol.id); assert.equal(plan.protocol.policies.pilot.max_scheduled_episodes, 144);
      const path = join(plan.execution.control_root, 'plan.json'); plans.set(path, plan);
      const scope = scopes.find(item => item.planReference.path === path);
      if (scope) await verifyAuthorizedHistoryPlan(plan, scope.amendment, authorized, parentReference);
      else {
        const entry = parent.history.plans.find(item => item.plan.path === path); assert.ok(entry);
        assert.deepEqual((await file(path)).reference, entry.plan, 'HISTORY_EXTENSION_PREFIX_PLAN_CHANGED');
        if (plan.execution.campaign_scope) assertFiniteCampaignPlan(plan, await verified(clean(plan.execution.campaign_scope.amendment)));
      }
    },
    assertOriginalCompleted: async input => {
      originals.set(input.ordinal, input.event);
      if (input.ordinal <= parent.history.scheduled_episodes) return;
      assert.equal(input.hasRevision, false, 'HISTORY_EXTENSION_SOURCE_REINTERPRETED');
      if (input.ordinal === count) {
        assert.equal(input.plan.plan_sha256, last.plan.plan_sha256); assert.deepEqual(input.event, terminal);
      } else await verifyFiniteOriginalResults(input.plan, [input.event]);
    },
    assertModelEvidence: (episode, model, plan) => {
      if (authorized.retainedAliasStop && episode.identity.run_id === authorized.retainedAliasStop.retained.run_id)
        assertRetainedAliasEpisode(episode, model, plan, authorized.retainedAliasStop.retained);
      else if (plan.protocol.policies.campaign || isProspectiveCohort(plan.protocol.policies.pilot.scope)) assertCohortModelEvidence(episode, model);
    } });
  assert.equal(history.scheduled_episodes, count, 'HISTORY_EXTENSION_HISTORY_COUNT_CHANGED'); prefix(history, parent.history);
  let ordinal = parent.history.scheduled_episodes;
  const priorAmendment = await verified(parent.predecessor.amendment);
  for (const scope of scopes) {
    assert.deepEqual(scope.amendment.history, before(history, ordinal, plans), 'HISTORY_EXTENSION_SCOPE_HISTORY_CHANGED');
    assert.deepEqual(scope.amendment.history_exemption, priorAmendment.history_exemption, 'HISTORY_EXTENSION_ORIGINAL_EXEMPTION_CHANGED');
    for (const slot of scope.plan.slots) {
      const item = history.reservations[ordinal++], reservation = await verified(item.reference);
      assert.equal(item.ordinal, ordinal); assert.equal(reservation.run_id, scope.plan.id + '-' + String(slot.order + 1).padStart(3, '0'));
      assert.equal(reservation.slot_id, slot.slot_id); assert.equal(reservation.experiment_id, scope.plan.id);
      assert.equal(reservation.scope_id, scope.allocation.id); assert.equal(reservation.scope_role, scope.allocation.role);
      assert.equal(reservation.scope_kind, 'benchmark-finite-campaign');
      assert.equal(reservation.scope_amendment_sha256, scope.amendment.amendment_sha256);
      assert.deepEqual(reservation.plan, scope.planReference); assert.equal(reservation.plan_sha256, scope.plan.plan_sha256);
      const episode = history.episodes[ordinal - 1];
      assert.equal(episode.analysis_revision, undefined); assert.equal(episode.collection_recovery, undefined, 'HISTORY_EXTENSION_SOURCE_REINTERPRETED');
      if (ordinal !== count) {
        assert.equal(episode.core_evidence, 'complete', 'HISTORY_EXTENSION_NEW_CORE_FAILURE'); assert.equal(episode.stop_batch, false, 'HISTORY_EXTENSION_EXTRA_STOP');
      }
    }
  }
  const observed = history.episodes.at(-1);
  assert.equal(observed.admission, 'invalid'); assert.equal(observed.stop_batch, true); assert.equal(observed.core_evidence, 'incomplete');
  assert.deepEqual(history.unknown_usage_run_ids, sorted([...parent.history.unknown_usage_run_ids, terminal.run_id]), 'HISTORY_EXTENSION_UNKNOWN_LIST_CHANGED');
  assert.equal(history.episodes.filter(item => tokenUnknown(item.budget_usage)).length, accepted.value.retained_effective_unknown_token_episodes, 'HISTORY_EXTENSION_EFFECTIVE_UNKNOWN_COUNT');
  assert.equal([...originals.values()].filter(item => tokenUnknown(item.result.budget_usage)).length, accepted.value.retained_original_unknown_token_episodes, 'HISTORY_EXTENSION_ORIGINAL_UNKNOWN_COUNT');
  const { episode } = await readEvidenceBundle({ directory: terminal.result.normalized_directory, rawRoot: parent.environment_root });
  const artifact = episode.artifacts.find(item => item.id === 'collection-runtime-result'); assert.ok(artifact, 'HISTORY_EXTENSION_RUNTIME_RESULT_REQUIRED');
  const runtime = await verified(clean(artifact));
  assert.equal(runtime.status, 'invalid'); assert.ok(typeof runtime.error?.code === 'string' && runtime.error.code.length, 'HISTORY_EXTENSION_RUNTIME_STOP_REQUIRED');
  assert.equal(runtime.budget?.usage_unknown, true, 'HISTORY_EXTENSION_RUNTIME_USAGE_CHANGED');
  assert.equal(episode.measurements.actual_attempts.status, 'known'); assert.ok(episode.measurements.actual_attempts.value > 0);
  assert.equal(runtime.budget.requests, episode.measurements.actual_attempts.value); assert.equal(runtime.budget.attempts, episode.measurements.actual_attempts.value);
  for (const [key, measurement] of [['input_tokens', 'input_total'], ['output_tokens', 'output_total']])
    assert.equal(runtime.budget[key], episode.measurements[measurement].known_subtotal, 'HISTORY_EXTENSION_PARTIAL_USAGE_CHANGED');
  const retained = { source_plan: last.planReference, source_ledger: last.ledger.reference, reservation: history.reservations.at(-1).reference,
    episode: (await file(join(observed.directory, 'episode.json'))).reference, episode_sha256: episode.episode_sha256,
    runtime_result: clean(artifact), run_id: terminal.run_id, ordinal: count, source_slot_id: last.plan.slots.at(-1).slot_id, allocation_id: last.allocation.id };
  if (currentBoundary) await currentBoundarySnapshot(pilotLedgerRoot, count, last.registration.sequence);
  return { history, consumed, allocations, retained, decision: accepted.value };
}
