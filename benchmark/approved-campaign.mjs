import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fingerprint } from './protocol.mjs';

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
    'allocations', 'authorization_sha256'], 'APPROVED_CAMPAIGN_SHAPE');
  assert.equal(value.version, 1); assert.equal(value.kind, APPROVED_CAMPAIGN); assert.ok(safe(value.id));
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
    assert.ok(['unstarted_followup', 'route_gate_only', 'acceptance'].includes(allocation.role));
    assert.ok(Number.isSafeInteger(allocation.reservation_limit) && allocation.reservation_limit > 0);
  }
  assert.equal(value.allocations.reduce((sum, item) => sum + item.reservation_limit, 0), value.new_reservation_ceiling);
}

async function verifyApproval(value) {
  assertShape(value);
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
  assert.equal(sha(bytes), stop.normalized_episode_sha256, 'APPROVAL_RETAINED_STOP_BYTES_CHANGED');
  const normalized = JSON.parse(bytes); assert.equal(normalized.episode_sha256, episode.episode_sha256);
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

export async function readApprovedCampaign(reference) {
  const value = await verified(reference);
  assert.ok(inside(value.environment_root, reference.path), 'APPROVAL_DOCUMENT_OUTSIDE_OWNER');
  return verifyApproval(value);
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
