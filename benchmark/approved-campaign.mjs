import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fingerprint } from './protocol.mjs';
import { ALIAS_REVISION, readAliasRevisionStop } from './campaign-alias-revision.mjs';
import { verifyApparatusBridge } from './apparatus-bridge.mjs';
import { HISTORY_EXTENSION, readHistoryExtension } from './campaign-history-extension.mjs';
import { CONFIRMATION_REVISION, readPartialConfirmationHistory } from './campaign-confirmation-continuation.mjs';
import { PROVIDER_STOP_REVISION, readProviderStopHistory } from './campaign-provider-stop-continuation.mjs';
import { CONFIRMATION_CONTINUATION } from './campaign-selection.mjs';

export const APPROVED_CAMPAIGN = 'benchmark-approved-prospective-campaign';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safe = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const sorted = values => [...values].sort();
const keys = (value, expected, code) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), code);
  assert.deepEqual(sorted(Object.keys(value)), sorted(expected), code);
};
const canonical = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path;
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const usageKeys = ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms'];
const knownUsage = value => usageKeys.every(key => Number.isFinite(value?.[key]) && value[key] >= 0);
const cleanReference = value => ({ path: value.path, sha256: value.sha256 });

async function fileBytes(path) {
  assert.ok(canonical(path), 'APPROVAL_CANONICAL_PATH');
  const first = await lstat(path); assert.ok(first.isFile() && !first.isSymbolicLink(), 'APPROVAL_REGULAR_FILE');
  assert.equal(await realpath(path), path, 'APPROVAL_PATH_SYMLINK');
  const bytes = await readFile(path), last = await lstat(path);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(first[key], last[key], 'APPROVAL_READ_CHANGED');
  return bytes;
}
async function verified(reference) {
  assert.ok(hash(reference?.sha256), 'APPROVAL_REFERENCE_REQUIRED');
  const bytes = await fileBytes(reference.path); assert.equal(sha(bytes), reference.sha256, 'APPROVAL_REFERENCED_BYTES_CHANGED');
  return JSON.parse(bytes);
}

async function decision(reference) {
  const approval = await verified(reference);
  assert.equal(approval.version, 1); assert.equal(approval.kind, 'user-prospective-benchmark-resumption-decision');
  assert.equal(approval.approved, true, 'APPROVAL_EXPLICIT_DECISION_REQUIRED');
  for (const key of ['source', 'user_message', 'authorization_scope']) assert.ok(typeof approval[key] === 'string' && approval[key].trim());
  assert.ok(Number.isFinite(Date.parse(approval.recorded_at_utc)), 'APPROVAL_TIMESTAMP');
  const proposalReference = cleanReference(approval.approved_proposal), proposal = await verified(proposalReference);
  assert.equal(proposal.version, 1); assert.equal(proposal.kind, 'prospective-resumption-proposal-not-executable');
  assert.equal(approval.approved_proposal.revision, proposal.revision, 'APPROVAL_PROPOSAL_REVISION');
  assert.equal(proposal.approved, false, 'APPROVAL_ORIGINAL_PROPOSAL_CHANGED');
  assert.equal(proposal.execution_authority, null);
  assert.equal(approval.campaign_absolute_limit, 144); assert.equal(proposal.campaign_absolute_limit, 144);
  for (const [left, right] of [['existing_reservations', 'current_physical_reservations'],
    ['retained_usage_unknown', 'retained_usage_unknown'], ['approved_new_reservation_ceiling', 'proposed_new_reservation_ceiling'],
    ['approved_total_ceiling', 'proposed_total_ceiling'], ['unallocated_headroom', 'unallocated_headroom']])
    assert.equal(approval[left], proposal[right], 'APPROVAL_PROPOSAL_LIMIT_CHANGED');
  assert.equal(approval.existing_reservations + approval.approved_new_reservation_ceiling, approval.approved_total_ceiling);
  assert.ok(approval.approved_total_ceiling <= 144 && approval.existing_reservations >= 13);
  assert.equal(144 - approval.approved_total_ceiling, approval.unallocated_headroom);
  return { approval, proposal, proposalReference };
}

function assertShape(value) {
  keys(value, ['version', 'kind', 'id', 'user_approval', 'proposal', 'predecessor', 'environment_root', 'pilot_ledger_root',
    'history', 'history_checkpoint_sha256', 'max_scheduled_episodes', 'new_reservation_ceiling', 'total_reservation_ceiling',
    'allocations', 'authorization_sha256', ...([2, 3, 4, 5].includes(value.version) ? ['revision'] : [])], 'APPROVED_CAMPAIGN_SHAPE');
  assert.ok([1, 2, 3, 4, 5].includes(value.version)); assert.equal(value.kind, APPROVED_CAMPAIGN); assert.ok(safe(value.id));
  assert.equal(value.authorization_sha256, fingerprint({ ...value, authorization_sha256: null }), 'APPROVED_CAMPAIGN_CHANGED');
  assert.ok(canonical(value.environment_root) && canonical(value.pilot_ledger_root));
  assert.equal(value.max_scheduled_episodes, 144);
  keys(value.predecessor, ['registration', 'amendment'], 'APPROVAL_PREDECESSOR_SHAPE');
  for (const ref of [value.user_approval, value.proposal, ...Object.values(value.predecessor)])
    assert.ok(canonical(ref?.path) && hash(ref.sha256), 'APPROVAL_REFERENCE_REQUIRED');
  const history = value.history;
  assert.equal(history?.scheduled_episodes, history?.episodes?.length);
  assert.equal(history.scheduled_episodes, history.reservations?.length);
  assert.ok(history.scheduled_episodes >= 13 && history.scheduled_episodes <= 144);
  assert.equal(value.history_checkpoint_sha256, fingerprint(history), 'APPROVAL_BASELINE_CHANGED');
  assert.equal(value.total_reservation_ceiling, history.scheduled_episodes + value.new_reservation_ceiling);
  assert.ok(value.total_reservation_ceiling <= 144);
  assert.ok(Array.isArray(value.allocations) && value.allocations.length > 0);
  assert.equal(new Set(value.allocations.map(item => item.id)).size, value.allocations.length, 'APPROVAL_DUPLICATE_ALLOCATION');
  for (const allocation of value.allocations) {
    keys(allocation, ['id', 'work_index', 'role', 'reservation_limit'], 'APPROVAL_ALLOCATION_SHAPE');
    assert.ok(safe(allocation.id)); assert.ok(Number.isSafeInteger(allocation.work_index) && allocation.work_index >= 0);
    assert.ok(['unstarted_followup', 'route_gate_only', 'acceptance', ...([4, 5].includes(value.version) ? [CONFIRMATION_CONTINUATION] : [])].includes(allocation.role));
    assert.ok(Number.isSafeInteger(allocation.reservation_limit) && allocation.reservation_limit > 0);
  }
  assert.equal(value.allocations.reduce((sum, item) => sum + item.reservation_limit, 0), value.new_reservation_ceiling);
}

async function verifyApproval(value) {
  assertShape(value); assert.equal(value.version, 1);
  const { approval, proposal, proposalReference } = await decision(value.user_approval);
  assert.deepEqual(value.proposal, proposalReference, 'APPROVAL_PROPOSAL_CHANGED');
  assert.equal(value.history.scheduled_episodes, approval.existing_reservations, 'APPROVAL_BASELINE_COUNT_CHANGED');
  assert.equal(value.history.unknown_usage_run_ids.length, approval.retained_usage_unknown, 'APPROVAL_BASELINE_UNKNOWN_CHANGED');
  assert.equal(value.new_reservation_ceiling, approval.approved_new_reservation_ceiling);
  assert.equal(value.total_reservation_ceiling, approval.approved_total_ceiling);
  assert.deepEqual([...new Set(value.allocations.map(item => item.work_index))].sort((a, b) => a - b), proposal.work.map((_item, index) => index), 'APPROVAL_WORK_COVERAGE');
  for (const [index, work] of proposal.work.entries()) {
    const allocations = value.allocations.filter(item => item.work_index === index);
    assert.equal(allocations.reduce((sum, item) => sum + item.reservation_limit, 0), work.maximum_new_reservations, 'APPROVAL_WORK_LIMIT_CHANGED');
    // The approved scale coverage needs five independently frozen catalogs.
    // Every other approved work item remains one indivisible allocation.
    if (index === 5) {
      assert.equal(allocations.length, 5, 'APPROVAL_SCALE_ALLOCATION_COUNT');
      assert.ok(allocations.every(item => item.reservation_limit === 2), 'APPROVAL_SCALE_ALLOCATION_LIMIT');
    } else assert.equal(allocations.length, 1, 'APPROVAL_WORK_ALLOCATION_COUNT');
  }
  for (const allocation of value.allocations) {
    const work = proposal.work[allocation.work_index];
    const role = allocation.work_index === 0 ? 'unstarted_followup' : work.route ? 'route_gate_only' : 'acceptance';
    assert.equal(allocation.role, role, 'APPROVAL_WORK_ROLE_CHANGED');
  }
  assert.equal(await realpath(value.environment_root), value.environment_root);
  assert.equal(await realpath(value.pilot_ledger_root), value.pilot_ledger_root);
  assert.ok(inside(value.environment_root, value.user_approval.path), 'APPROVAL_DECISION_OUTSIDE_OWNER');
  const stop = proposal.retained_stop, episode = value.history.episodes.find(item => item.run_id === stop.run_id);
  assert.ok(episode, 'APPROVAL_RETAINED_STOP_MISSING');
  assert.equal(stop.current_scope_still_stopped, true); assert.equal(stop.usage_still_unknown, true); assert.equal(stop.invalid_still_retained, true);
  assert.equal(episode.stop_batch, true); assert.equal(episode.admission, 'invalid'); assert.equal(knownUsage(episode.budget_usage), false);
  assert.ok(value.history.unknown_usage_run_ids.includes(stop.run_id));
  const bytes = await fileBytes(join(episode.directory, 'episode.json'));
  // The published proposal names the normalized semantic identity, not the
  // pretty-printed episode.json file digest. Raw bundle bytes are independently
  // checked by the campaign history reader before this boundary can dispatch.
  const normalized = JSON.parse(bytes);
  assert.equal(normalized.episode_sha256, stop.normalized_episode_sha256, 'APPROVAL_RETAINED_STOP_IDENTITY_CHANGED');
  assert.equal(fingerprint({ ...normalized, episode_sha256: null }), normalized.episode_sha256, 'APPROVAL_RETAINED_STOP_CONTENT_CHANGED');
  assert.equal(normalized.episode_sha256, episode.episode_sha256);
  assert.ok(normalized.admission.refs.some(ref => ref.sha256 === stop.result_sha256), 'APPROVAL_RETAINED_STOP_RESULT_CHANGED');
  return { value, approval, proposal };
}

/** Preparation returns data only. The caller owns an exclusive immutable write;
 * actual campaign readers independently verify all baseline raw evidence. */
export async function prepareApprovedCampaign({ id, userApproval, predecessor, environmentRoot, pilotLedgerRoot, history, allocations }) {
  const { approval, proposalReference } = await decision(userApproval);
  const value = { version: 1, kind: APPROVED_CAMPAIGN, id, user_approval: cleanReference(userApproval), proposal: proposalReference,
    predecessor: structuredClone(predecessor), environment_root: environmentRoot, pilot_ledger_root: pilotLedgerRoot,
    history: structuredClone(history), history_checkpoint_sha256: fingerprint(history), max_scheduled_episodes: 144,
    new_reservation_ceiling: approval.approved_new_reservation_ceiling, total_reservation_ceiling: approval.approved_total_ceiling,
    allocations: structuredClone(allocations), authorization_sha256: null };
  value.authorization_sha256 = fingerprint(value); await verifyApproval(value); return value;
}

export async function readApprovedCampaign(reference, ancestors = new Set()) {
  assert.ok(!ancestors.has(reference?.path), 'APPROVAL_ANCESTRY_CYCLE');
  assert.ok(ancestors.size < 144, 'APPROVAL_ANCESTRY_LIMIT');
  const next = new Set(ancestors); next.add(reference.path);
  const value = await verified(reference);
  assert.ok(inside(value.environment_root, reference.path), 'APPROVAL_DOCUMENT_OUTSIDE_OWNER');
  if (value.version === 5) return verifyProviderStopContinuation(value, next);
  if (value.version === 4) return verifyConfirmationContinuation(value, next);
  if (value.version === 3) return verifyHistoryExtension(value, next);
  return value.version === 2 ? verifyRevision(value) : verifyApproval(value);
}

export function approvedCampaignBinding(reference, value, allocationId) {
  assertShape(value); assert.ok(value.allocations.some(item => item.id === allocationId), 'APPROVAL_ALLOCATION_MISSING');
  return { reference: cleanReference(reference), allocation_id: allocationId,
    history_boundary: { scheduled_episodes: value.history.scheduled_episodes,
      checkpoint_sha256: value.history_checkpoint_sha256, unknown_usage_run_ids: value.history.unknown_usage_run_ids },
    campaign_limit: value.total_reservation_ceiling };
}

export function assertApprovedCampaignBinding(binding) {
  keys(binding, ['reference', 'allocation_id', 'history_boundary', 'campaign_limit'], 'APPROVAL_BINDING_SHAPE');
  assert.ok(canonical(binding.reference?.path) && hash(binding.reference.sha256)); assert.ok(safe(binding.allocation_id));
  keys(binding.history_boundary, ['scheduled_episodes', 'checkpoint_sha256', 'unknown_usage_run_ids'], 'APPROVAL_BOUNDARY_SHAPE');
  const boundary = binding.history_boundary;
  assert.ok(Number.isSafeInteger(boundary.scheduled_episodes) && boundary.scheduled_episodes >= 13);
  assert.ok(hash(boundary.checkpoint_sha256)); assert.ok(Array.isArray(boundary.unknown_usage_run_ids));
  assert.equal(new Set(boundary.unknown_usage_run_ids).size, boundary.unknown_usage_run_ids.length);
  assert.ok(Number.isSafeInteger(binding.campaign_limit) && binding.campaign_limit <= 144 && binding.campaign_limit > boundary.scheduled_episodes);
  return binding;
}

function exactHistoricalPrefix(current, previous) {
  assert.equal(current.scheduled_episodes, previous.scheduled_episodes + 1, 'ALIAS_REVISION_BASELINE_COUNT');
  for (const key of ['reservations', 'episodes']) assert.deepEqual(current[key].slice(0, previous.scheduled_episodes), previous[key], 'ALIAS_REVISION_BASELINE_CHANGED');
  assert.equal(current.plans.length, previous.plans.length + 1);
  for (const plan of previous.plans) assert.deepEqual(current.plans.find(item => item.plan.path === plan.plan.path), plan, 'ALIAS_REVISION_HISTORY_OWNER_CHANGED');
  assert.deepEqual(current.unknown_usage_run_ids, previous.unknown_usage_run_ids, 'ALIAS_REVISION_NEW_UNKNOWN');
}

function remainingAllocations(parent, stopped, followupId) {
  assert.ok(safe(followupId) && !parent.allocations.some(item => item.id === followupId), 'ALIAS_REVISION_FRESH_ALLOCATION_REQUIRED');
  return parent.allocations.map(item => item.id === stopped.allocation.id
    ? { id: followupId, work_index: item.work_index, role: 'unstarted_followup', reservation_limit: 7 }
    : structuredClone(item));
}

async function verifyRevision(value) {
  assertShape(value); assert.equal(value.version, 2);
  const revision = value.revision;
  keys(revision, ['kind', 'parent_authorization', 'retained_stop', 'followup_allocation_id', 'apparatus_bridges'], 'ALIAS_REVISION_SHAPE');
  assert.equal(revision.kind, ALIAS_REVISION);
  const parentValue = await verified(revision.parent_authorization);
  assert.equal(parentValue.version, 1, 'ALIAS_REVISION_ORIGINAL_APPROVAL_ONLY');
  assert.ok(inside(parentValue.environment_root, revision.parent_authorization.path));
  const original = await verifyApproval(parentValue), parent = original.value;
  for (const field of ['user_approval', 'proposal', 'environment_root', 'pilot_ledger_root', 'max_scheduled_episodes', 'total_reservation_ceiling'])
    assert.deepEqual(value[field], parent[field], 'ALIAS_REVISION_ORIGINAL_AUTHORITY_CHANGED');
  assert.notEqual(value.id, parent.id);
  exactHistoricalPrefix(value.history, parent.history);
  const stop = revision.retained_stop;
  const stopped = await readAliasRevisionStop({ parent, parentReference: revision.parent_authorization, predecessor: value.predecessor,
    sourcePlan: stop.source_plan, metadata: stop.metadata });
  assert.deepEqual(stop, stopped.retained, 'ALIAS_REVISION_STOP_BINDING_CHANGED');
  const last = value.history.episodes.at(-1);
  assert.equal(last.run_id, stop.run_id); assert.equal(last.pilot_ordinal, stop.ordinal);
  assert.equal(last.episode_sha256, stop.episode_sha256); assert.equal(last.experiment_id, stopped.source.id);
  assert.equal(last.directory, stopped.event.result.normalized_directory);
  assert.equal(last.admission, 'invalid'); assert.equal(last.stop_batch, true); assert.equal(last.core_evidence, 'incomplete');
  assert.equal(last.quality_credit, 'excluded_from_new_scope');
  assert.equal(last.analysis_revision, undefined); assert.equal(last.collection_recovery, undefined);
  assert.deepEqual(last.budget_usage, stop.budget_usage);
  assert.deepEqual(value.history.reservations.at(-1), { ordinal: stop.ordinal, reference: stop.reservation });
  const owner = value.history.plans.find(item => item.plan.path === stop.source_plan.path);
  assert.deepEqual(owner, { plan: stop.source_plan, ledger: stop.source_ledger, analysis_revision: null });
  for (const key of usageKeys) {
    assert.equal(value.history.known_subtotal[key], parent.history.known_subtotal[key] + stop.budget_usage[key], 'ALIAS_REVISION_COST_CHANGED');
    assert.equal(value.history.total_usage[key], parent.history.total_usage[key] === null ? null : parent.history.total_usage[key] + stop.budget_usage[key]);
  }
  assert.equal(value.history.total_usage_status, parent.history.total_usage_status);
  assert.equal(value.history.monetary_status, parent.history.monetary_status);
  assert.equal(value.new_reservation_ceiling, parent.new_reservation_ceiling - 1, 'ALIAS_REVISION_BUDGET_CHANGED');
  assert.deepEqual(value.allocations, remainingAllocations(parent, stopped, revision.followup_allocation_id), 'ALIAS_REVISION_ALLOCATION_CHANGED');
  assert.ok(Array.isArray(revision.apparatus_bridges) && revision.apparatus_bridges.length <= 1, 'ALIAS_REVISION_SINGLE_APPARATUS_BRIDGE');
  const apparatusBridges = [];
  for (const reference of revision.apparatus_bridges) {
    keys(reference, ['path', 'sha256'], 'ALIAS_REVISION_APPARATUS_REFERENCE');
    const preview = await verified(reference);
    const bridge = await verifyApparatusBridge(reference, { environmentRoot: value.environment_root,
      sourceBuildId: preview.source_build?.id, targetBuildId: preview.target_build?.id });
    assert.equal(bridge.status, 'passed');
    assert.ok(stopped.source.protocol.environments.some(environment => fingerprint(environment.build) === fingerprint(bridge.source_build.identity)),
      'ALIAS_REVISION_APPARATUS_SOURCE_CHANGED');
    apparatusBridges.push(bridge);
  }
  return { value, approval: original.approval, proposal: original.proposal, original, retainedAliasStop: stopped, apparatusBridges };
}

/** Data-only engineering revision under the original user decision. No new user
 * decision is invented, and the original authorization document is not changed. */
export async function prepareApprovedCampaignRevision({ id, parentAuthorization, predecessor, history, followupAllocationId, sourcePlan, metadata, apparatusBridges = [] }) {
  const original = await readApprovedCampaign(parentAuthorization), parent = original.value;
  assert.equal(parent.version, 1, 'ALIAS_REVISION_ORIGINAL_APPROVAL_ONLY');
  const stopped = await readAliasRevisionStop({ parent, parentReference: parentAuthorization, predecessor, sourcePlan, metadata });
  const value = { version: 2, kind: APPROVED_CAMPAIGN, id, user_approval: structuredClone(parent.user_approval), proposal: structuredClone(parent.proposal),
    predecessor: structuredClone(predecessor), environment_root: parent.environment_root, pilot_ledger_root: parent.pilot_ledger_root,
    history: structuredClone(history), history_checkpoint_sha256: fingerprint(history), max_scheduled_episodes: parent.max_scheduled_episodes,
    new_reservation_ceiling: parent.new_reservation_ceiling - 1, total_reservation_ceiling: parent.total_reservation_ceiling,
    allocations: remainingAllocations(parent, stopped, followupAllocationId),
    revision: { kind: ALIAS_REVISION, parent_authorization: cleanReference(parentAuthorization),
      retained_stop: stopped.retained, followup_allocation_id: followupAllocationId, apparatus_bridges: apparatusBridges.map(cleanReference) }, authorization_sha256: null };
  value.authorization_sha256 = fingerprint(value); await verifyRevision(value); return value;
}

async function verifyHistoryExtension(value, ancestors = new Set()) {
  assertShape(value); assert.equal(value.version, 3);
  const revision = value.revision;
  keys(revision, ['kind', 'parent_authorization', 'user_approval', 'consumed_allocations', 'retained_stop', 'next_allocation_id'], 'HISTORY_EXTENSION_REVISION_SHAPE');
  assert.equal(revision.kind, HISTORY_EXTENSION);
  const parent = await readApprovedCampaign(revision.parent_authorization, ancestors);
  for (const field of ['user_approval', 'proposal', 'environment_root', 'pilot_ledger_root', 'max_scheduled_episodes', 'total_reservation_ceiling'])
    assert.deepEqual(value[field], parent.value[field], 'HISTORY_EXTENSION_ORIGINAL_AUTHORITY_CHANGED');
  assert.notEqual(value.id, parent.value.id);
  const extension = await readHistoryExtension({ parent, parentReference: revision.parent_authorization, userApproval: revision.user_approval,
    predecessor: value.predecessor, planFiles: value.history.plans.map(item => item.plan.path), pilotLedgerRoot: value.pilot_ledger_root, expected: value.history });
  assert.deepEqual(revision.consumed_allocations, extension.consumed, 'HISTORY_EXTENSION_CONSUMED_ALLOCATION_CHANGED');
  assert.deepEqual(revision.retained_stop, extension.retained, 'HISTORY_EXTENSION_STOP_BINDING_CHANGED');
  assert.equal(revision.next_allocation_id, extension.decision.next_allocation_id, 'HISTORY_EXTENSION_NEXT_ALLOCATION_CHANGED');
  assert.deepEqual(value.allocations, extension.allocations, 'HISTORY_EXTENSION_ALLOCATION_CHANGED');
  assert.equal(value.new_reservation_ceiling, extension.decision.approved_remaining_reservations, 'HISTORY_EXTENSION_BUDGET_CHANGED');
  return { value, approval: parent.approval, proposal: parent.proposal, original: parent.original ?? parent,
    retainedAliasStop: parent.retainedAliasStop, apparatusBridges: parent.apparatusBridges, extensionDecision: extension.decision };
}

/** A new user decision can accept one terminal unknown stop after complete
 * allocations. It cannot grant budget, rewrite history, or register a scope. */
export async function prepareApprovedCampaignHistoryExtension({ id, parentAuthorization, userApproval, predecessor, history }) {
  const parent = await readApprovedCampaign(parentAuthorization);
  const extension = await readHistoryExtension({ parent, parentReference: parentAuthorization, userApproval, predecessor,
    planFiles: history.plans.map(item => item.plan.path), pilotLedgerRoot: parent.value.pilot_ledger_root, expected: history, currentBoundary: true });
  const previous = parent.value;
  const value = { version: 3, kind: APPROVED_CAMPAIGN, id, user_approval: structuredClone(previous.user_approval), proposal: structuredClone(previous.proposal),
    predecessor: structuredClone(predecessor), environment_root: previous.environment_root, pilot_ledger_root: previous.pilot_ledger_root,
    history: structuredClone(history), history_checkpoint_sha256: fingerprint(history), max_scheduled_episodes: previous.max_scheduled_episodes,
    new_reservation_ceiling: extension.decision.approved_remaining_reservations, total_reservation_ceiling: previous.total_reservation_ceiling,
    allocations: structuredClone(extension.allocations), revision: { kind: HISTORY_EXTENSION, parent_authorization: cleanReference(parentAuthorization),
      user_approval: cleanReference(userApproval), consumed_allocations: extension.consumed, retained_stop: extension.retained,
      next_allocation_id: extension.decision.next_allocation_id }, authorization_sha256: null };
  value.authorization_sha256 = fingerprint(value); await verifyHistoryExtension(value); return value;
}

async function verifyConfirmationContinuation(value, ancestors = new Set()) {
  assertShape(value); assert.equal(value.version, 4);
  const revision = value.revision;
  keys(revision, ['kind', 'parent_authorization', 'user_approval', 'consumed_allocations', 'partial_allocation', 'retained_stop', 'next_allocation_id', 'model_window'],
    'CONFIRMATION_CONTINUATION_REVISION_SHAPE');
  assert.equal(revision.kind, CONFIRMATION_REVISION);
  const parent = await readApprovedCampaign(revision.parent_authorization, ancestors);
  for (const field of ['user_approval', 'proposal', 'environment_root', 'pilot_ledger_root', 'max_scheduled_episodes', 'total_reservation_ceiling'])
    assert.deepEqual(value[field], parent.value[field], 'CONFIRMATION_CONTINUATION_ORIGINAL_AUTHORITY_CHANGED');
  assert.notEqual(value.id, parent.value.id);
  keys(revision.model_window, ['mode', 'start', 'end'], 'CONFIRMATION_CONTINUATION_WINDOW_SHAPE');
  const continuation = await readPartialConfirmationHistory({ parent, parentReference: revision.parent_authorization, userApproval: revision.user_approval,
    predecessor: value.predecessor, planFiles: value.history.plans.map(item => item.plan.path), pilotLedgerRoot: value.pilot_ledger_root, expected: value.history,
    modelWindow: { start: revision.model_window.start, end: revision.model_window.end } });
  assert.deepEqual(revision.consumed_allocations, continuation.consumed);
  assert.deepEqual(revision.partial_allocation, continuation.transition, 'CONFIRMATION_CONTINUATION_PARTIAL_ALLOCATION_CHANGED');
  assert.deepEqual(revision.retained_stop, continuation.retained, 'CONFIRMATION_CONTINUATION_STOP_BINDING_CHANGED');
  assert.deepEqual(revision.model_window, continuation.modelWindow, 'CONFIRMATION_CONTINUATION_WINDOW_CHANGED');
  assert.equal(revision.next_allocation_id, continuation.allocations[0].id);
  assert.deepEqual(value.allocations, continuation.allocations, 'CONFIRMATION_CONTINUATION_ALLOCATION_CHANGED');
  assert.equal(value.new_reservation_ceiling, continuation.decision.approved_remaining_reservations);
  return { value, approval: parent.approval, proposal: parent.proposal, original: parent.original ?? parent,
    retainedAliasStop: parent.retainedAliasStop, apparatusBridges: parent.apparatusBridges, confirmationContinuation: continuation };
}

/** Data only. The explicit decision retains a partial original confirmation;
 * it does not retry its invalid, reserve a slot, or create a model window. */
export async function prepareApprovedCampaignConfirmationContinuation({ id, parentAuthorization, userApproval, predecessor, history, modelWindow }) {
  const parent = await readApprovedCampaign(parentAuthorization);
  const continuation = await readPartialConfirmationHistory({ parent, parentReference: parentAuthorization, userApproval, predecessor,
    planFiles: history.plans.map(item => item.plan.path), pilotLedgerRoot: parent.value.pilot_ledger_root, expected: history, currentBoundary: true, modelWindow });
  const previous = parent.value;
  const value = { version: 4, kind: APPROVED_CAMPAIGN, id, user_approval: structuredClone(previous.user_approval), proposal: structuredClone(previous.proposal),
    predecessor: structuredClone(predecessor), environment_root: previous.environment_root, pilot_ledger_root: previous.pilot_ledger_root,
    history: structuredClone(history), history_checkpoint_sha256: fingerprint(history), max_scheduled_episodes: previous.max_scheduled_episodes,
    new_reservation_ceiling: continuation.decision.approved_remaining_reservations, total_reservation_ceiling: previous.total_reservation_ceiling,
    allocations: structuredClone(continuation.allocations), revision: { kind: CONFIRMATION_REVISION, parent_authorization: cleanReference(parentAuthorization),
      user_approval: cleanReference(userApproval), consumed_allocations: continuation.consumed, partial_allocation: continuation.transition,
      retained_stop: continuation.retained, next_allocation_id: continuation.allocations[0].id, model_window: continuation.modelWindow }, authorization_sha256: null };
  value.authorization_sha256 = fingerprint(value); await verifyConfirmationContinuation(value); return value;
}

async function verifyProviderStopContinuation(value, ancestors = new Set()) {
  assertShape(value); assert.equal(value.version, 5);
  const revision = value.revision;
  keys(revision, ['kind', 'parent_authorization', 'user_approval', 'partial_allocation', 'retained_stop', 'next_allocation_id', 'model_window'],
    'PROVIDER_STOP_REVISION_SHAPE');
  assert.equal(revision.kind, PROVIDER_STOP_REVISION);
  const parent = await readApprovedCampaign(revision.parent_authorization, ancestors);
  for (const field of ['user_approval', 'proposal', 'environment_root', 'pilot_ledger_root', 'max_scheduled_episodes', 'total_reservation_ceiling'])
    assert.deepEqual(value[field], parent.value[field], 'PROVIDER_STOP_ORIGINAL_AUTHORITY_CHANGED');
  assert.notEqual(value.id, parent.value.id);
  const continuation = await readProviderStopHistory({ parent, parentReference: revision.parent_authorization, userApproval: revision.user_approval,
    predecessor: value.predecessor, planFiles: value.history.plans.map(item => item.plan.path), pilotLedgerRoot: value.pilot_ledger_root, expected: value.history });
  assert.deepEqual(revision.partial_allocation, continuation.transition, 'PROVIDER_STOP_PARTIAL_ALLOCATION_CHANGED');
  assert.deepEqual(revision.retained_stop, continuation.retained, 'PROVIDER_STOP_STOP_BINDING_CHANGED');
  assert.deepEqual(revision.model_window, continuation.modelWindow, 'PROVIDER_STOP_WINDOW_CHANGED');
  assert.equal(revision.next_allocation_id, continuation.allocations[0].id);
  assert.deepEqual(value.allocations, continuation.allocations, 'PROVIDER_STOP_ALLOCATION_CHANGED');
  assert.equal(value.new_reservation_ceiling, continuation.decision.approved_remaining_reservations);
  return { value, approval: parent.approval, proposal: parent.proposal, original: parent.original ?? parent,
    retainedAliasStop: parent.retainedAliasStop, apparatusBridges: parent.apparatusBridges, confirmationContinuation: continuation,
    retainedProviderStop: { ...continuation.retained, source_plan_sha256: continuation.transition.source_plan_sha256 } };
}

/** Data only. A separately accepted provider failure stays in the old scope;
 * this authority transfers the exact unstarted suffix without renewing time. */
export async function prepareApprovedProviderStopContinuation({ id, parentAuthorization, userApproval, predecessor, history }) {
  const parent = await readApprovedCampaign(parentAuthorization);
  const continuation = await readProviderStopHistory({ parent, parentReference: parentAuthorization, userApproval, predecessor,
    planFiles: history.plans.map(item => item.plan.path), pilotLedgerRoot: parent.value.pilot_ledger_root, expected: history, currentBoundary: true });
  const previous = parent.value;
  const value = { version: 5, kind: APPROVED_CAMPAIGN, id, user_approval: structuredClone(previous.user_approval), proposal: structuredClone(previous.proposal),
    predecessor: structuredClone(predecessor), environment_root: previous.environment_root, pilot_ledger_root: previous.pilot_ledger_root,
    history: structuredClone(history), history_checkpoint_sha256: fingerprint(history), max_scheduled_episodes: previous.max_scheduled_episodes,
    new_reservation_ceiling: continuation.decision.approved_remaining_reservations, total_reservation_ceiling: previous.total_reservation_ceiling,
    allocations: structuredClone(continuation.allocations), revision: { kind: PROVIDER_STOP_REVISION, parent_authorization: cleanReference(parentAuthorization),
      user_approval: cleanReference(userApproval), partial_allocation: continuation.transition, retained_stop: continuation.retained,
      next_allocation_id: continuation.allocations[0].id, model_window: continuation.modelWindow }, authorization_sha256: null };
  value.authorization_sha256 = fingerprint(value); await verifyProviderStopContinuation(value); return value;
}
