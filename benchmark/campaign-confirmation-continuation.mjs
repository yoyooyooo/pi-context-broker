import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fingerprint, validateProtocol } from './protocol.mjs';
import { declaredSchedule, CONFIRMATION_CONTINUATION, UNSTARTED_FOLLOWUP } from './campaign-selection.mjs';
import { readCampaignHistory } from './campaign-history.mjs';
import { readRegisteredAllocationScopes } from './campaign-history-extension.mjs';
import { assertFiniteCampaignPlan, verifyAuthorizedHistoryPlan, verifyFiniteOriginalResults } from './finite-campaign.mjs';
import { assertCohortModelEvidence, isProspectiveCohort } from './prospective-cohort.mjs';
import { assertRetainedAliasEpisode } from './campaign-alias-revision.mjs';
import { readEvidenceBundle } from './evidence/store.mjs';
import { assertZeroSendInvalid } from './resumption.mjs';
import { readProviderTransport } from '../scripts/skill-consumption-provider.mjs';

export const CONFIRMATION_REVISION = 'accepted-partial-confirmation-continuation';
const usageKeys = ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms'];
const known = value => Number.isFinite(value) && value >= 0;
const tokenUnknown = usage => !known(usage?.input_tokens) || !known(usage?.output_tokens);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clean = ref => ({ path: ref.path, sha256: ref.sha256 });
const sorted = values => [...values].sort();
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const keys = (value, expected, code = 'CONFIRMATION_CONTINUATION_SHAPE') => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), code);
  assert.deepEqual(sorted(Object.keys(value)), sorted(expected), code);
};
async function file(path) {
  assert.ok(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'CONFIRMATION_CONTINUATION_CANONICAL_PATH');
  const before = await lstat(path); assert.ok(before.isFile() && !before.isSymbolicLink()); assert.equal(await realpath(path), path);
  const bytes = await readFile(path), after = await lstat(path);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(before[key], after[key], 'CONFIRMATION_CONTINUATION_READ_CHANGED');
  return { reference: { path, sha256: sha(bytes) }, bytes };
}
async function verified(ref, json = true) {
  keys(ref, ['path', 'sha256', ...(ref.bytes === undefined ? [] : ['bytes'])]);
  assert.match(ref.sha256, /^[a-f0-9]{64}$/);
  const value = await file(ref.path); assert.deepEqual(value.reference, clean(ref), 'CONFIRMATION_CONTINUATION_REFERENCE_CHANGED');
  if (ref.bytes !== undefined) assert.equal(value.bytes.length, ref.bytes);
  return json ? JSON.parse(value.bytes) : value.bytes;
}
async function boundary(root, count, sequence) {
  const names = await readdir(root);
  assert.ok(!names.some(name => name === 'campaign.lease.json' || /^scope-.+\.lease\.json$/.test(name)), 'CONFIRMATION_CONTINUATION_ACTIVE_LEASE');
  assert.equal(names.filter(name => /^\d{3}\.json$/.test(name)).length, count, 'CONFIRMATION_CONTINUATION_BOUNDARY_ADVANCED');
  if (sequence !== undefined) assert.equal(names.filter(name => /^scope-registration(?:-\d{3})?\.json$/.test(name)).length, sequence, 'CONFIRMATION_CONTINUATION_REGISTRY_ADVANCED');
}
function sourcePin(proposal, id, reference) {
  const matches = proposal.source_refs.filter(item => item.id === id);
  assert.equal(matches.length, 1, 'CONFIRMATION_CONTINUATION_SOURCE_PIN_REQUIRED');
  assert.equal(matches[0].sha256, reference.sha256, 'CONFIRMATION_CONTINUATION_SOURCE_PIN_CHANGED');
}

async function decision(parent, parentReference, userApproval) {
  // This contract cannot be chained to buy another window or retain another
  // partial stop. A later stop needs its own separately reviewed contract.
  assert.equal(parent.version, 3, 'CONFIRMATION_CONTINUATION_PARENT_VERSION');
  assert.ok(inside(parent.environment_root, userApproval.path));
  const value = await verified(userApproval);
  keys(value, ['version', 'kind', 'approved', 'source', 'user_message', 'approval_observed_at', 'accepted_at', 'timestamp_semantics',
    'authorization_scope', 'accepted_proposal', 'accepted_reviewable_draft', 'accepted_public_commit', 'accepted_public_url',
    'parent_authorization', 'stopped80_checkpoint', 'accepted_history_reservations', 'approved_remaining_reservations',
    'total_reservation_ceiling', 'max_scheduled_episodes', 'unallocated_headroom', 'additional_reservations', 'remaining_sequence',
    'retained_stop_run_id', 'retained_stop_usage', 'retained_effective_unknown_token_episodes', 'retained_original_unknown_token_episodes',
    'retained_stop_remains_invalid', 'future_core_stop_policy', 'future_unknown_usage_policy', 'model_parameters_unchanged',
    'new_model_window_permission', 'cold_operator_policy', 'provider_diagnosis_authorized', 'execution_ready', 'authority_created', 'required_before_dispatch']);
  assert.equal(value.version, 1); assert.equal(value.kind, 'user-approved-partial-confirmation-continuation-decision');
  assert.equal(value.approved, true, 'CONFIRMATION_CONTINUATION_EXPLICIT_DECISION_REQUIRED'); assert.equal(value.source, 'current-user-message');
  for (const key of ['user_message', 'authorization_scope']) assert.ok(typeof value[key] === 'string' && value[key].trim());
  assert.ok(Number.isFinite(Date.parse(value.accepted_at))); assert.equal(value.approval_observed_at, value.accepted_at);
  assert.deepEqual(clean(value.parent_authorization), parentReference, 'CONFIRMATION_CONTINUATION_PARENT_CHANGED');
  const proposal = await verified(value.accepted_proposal), checkpoint = await verified(value.stopped80_checkpoint);
  assert.ok((await verified(value.accepted_reviewable_draft, false)).length > 0);
  assert.equal(proposal.version, 1); assert.equal(proposal.kind, 'public-own-partial-stop-next-decision-draft');
  assert.equal(proposal.approved, false, 'CONFIRMATION_CONTINUATION_ORIGINAL_DRAFT_CHANGED');
  assert.equal(proposal.user_approval, null); assert.equal(proposal.execution_authority, null); assert.equal(proposal.execution_ready, false);
  assert.equal(proposal.status, 'awaiting_user_decision_and_explicit_contract_implementation');
  assert.equal(checkpoint.publicDecisionBinding.json_sha256, value.accepted_proposal.sha256);
  assert.equal(checkpoint.publicDecisionBinding.markdown_sha256, value.accepted_reviewable_draft.sha256, 'CONFIRMATION_CONTINUATION_DRAFT_CHANGED');
  assert.equal(checkpoint.publicDecisionBinding.public_commit, value.accepted_public_commit);
  assert.equal(checkpoint.physicalReservations, value.accepted_history_reservations);
  assert.equal(checkpoint.closedReservations, value.accepted_history_reservations); assert.equal(checkpoint.paidActive, false);
  assert.equal(checkpoint.newCoreStop.runId, value.retained_stop_run_id);
  sourcePin(proposal, 'current-authority3', parentReference);
  for (const key of ['total_reservation_ceiling', 'max_scheduled_episodes']) assert.equal(value[key], parent[key], 'CONFIRMATION_CONTINUATION_BUDGET_CHANGED');
  assert.equal(value.additional_reservations, 0); assert.equal(value.unallocated_headroom, parent.max_scheduled_episodes - parent.total_reservation_ceiling);
  assert.equal(value.accepted_history_reservations + value.approved_remaining_reservations, parent.total_reservation_ceiling);
  for (const [key, proposed] of [['accepted_history_reservations', proposal.budget.retained_physical], ['approved_remaining_reservations', proposal.budget.requested_future],
    ['total_reservation_ceiling', proposal.budget.approved_total_ceiling], ['max_scheduled_episodes', proposal.budget.hard_limit], ['unallocated_headroom', proposal.budget.unallocated],
    ['retained_effective_unknown_token_episodes', proposal.physical_history.effective_unknown_usage_runs], ['retained_original_unknown_token_episodes', proposal.physical_history.original_completion_unknown_usage_runs]])
    assert.equal(value[key], proposed, 'CONFIRMATION_CONTINUATION_PROPOSAL_CHANGED');
  assert.equal(proposal.budget.additional_budget, 0); assert.equal(proposal.budget.retry_reservations, 0);
  assert.equal(proposal.physical_history.physical, value.accepted_history_reservations); assert.equal(proposal.physical_history.completed, value.accepted_history_reservations);
  assert.equal(proposal.physical_history.execution_unresolved, 0); assert.equal(proposal.allocation_transition.parent_accepted_history, parent.history.scheduled_episodes);
  assert.equal(value.retained_stop_run_id, proposal.stop.run_id); assert.equal(value.retained_stop_usage, 'known_zero_model_requests_and_tokens');
  assert.equal(value.retained_stop_remains_invalid, true); assert.equal(value.future_core_stop_policy, 'stop'); assert.equal(value.future_unknown_usage_policy, 'stop');
  assert.equal(proposal.stop.runtime_status, 'admission_rejected'); assert.equal(proposal.stop.validity, 'invalid'); assert.equal(proposal.stop.stop_batch, true);
  assert.equal(proposal.stop.reason_code, 'BENCHMARK_ADMISSION_MISMATCH'); assert.equal(proposal.stop.usage_unknown, false); assert.equal(proposal.stop.retry_allowed, false);
  assert.equal(proposal.stop.model_http_requests, 0); assert.equal(proposal.stop.guarded_fetch_attempts, 0); assert.equal(proposal.stop.reconciliation_complete, true);
  assert.deepEqual(proposal.future_stop_policy, { new_core_stop_blocks_dispatch: true, new_unknown_usage_blocks_dispatch: true,
    automatic_retry: false, automatic_route_switch: false, automatic_budget_extension: false });
  assert.deepEqual(value.model_parameters_unchanged, { model: proposal.model_condition.variant, ...proposal.model_condition.parameters });
  keys(value.new_model_window_permission, ['conditional_on_need_after_preparation', 'maximum_new_windows', 'duration_hours', 'created', 'actual_start', 'actual_end', 'automatic_renewal']);
  assert.deepEqual(value.new_model_window_permission, { conditional_on_need_after_preparation: true, maximum_new_windows: 1, duration_hours: 24,
    created: false, actual_start: null, actual_end: null, automatic_renewal: false });
  assert.equal(proposal.window.proposed_change.maximum_new_windows, 1); assert.equal(proposal.window.proposed_change.duration_hours, 24);
  assert.equal(proposal.window.proposed_change.automatic_renewal, false);
  return { value, proposal };
}

function modelWindow(source, input, accepted) {
  const original = source.protocol.models[0].backend.window;
  assert.ok(source.protocol.models.every(model => fingerprint(model.backend.window) === fingerprint(original)));
  assert.deepEqual(original, accepted.proposal.window.existing, 'CONFIRMATION_CONTINUATION_ORIGINAL_WINDOW_CHANGED');
  const selected = input ?? original; keys(selected, ['start', 'end']);
  const retained = fingerprint(selected) === fingerprint(original);
  if (!retained) {
    assert.ok(Date.parse(selected.start) >= Date.parse(accepted.value.accepted_at), 'CONFIRMATION_CONTINUATION_WINDOW_BEFORE_DECISION');
    assert.equal(Date.parse(selected.end) - Date.parse(selected.start), 24 * 60 * 60 * 1000, 'CONFIRMATION_CONTINUATION_SINGLE_24H_WINDOW');
  }
  return { mode: retained ? 'retained_original' : 'single_new_24h', ...structuredClone(selected) };
}

export function assertContinuationModels(protocol, authorized) {
  assert.equal(authorized.value.version, 4, 'CONFIRMATION_CONTINUATION_AUTHORITY_REQUIRED');
  assertSameConfirmationModels(protocol, authorized.confirmationContinuation.source, authorized.value.revision.model_window);
}

export function assertSameConfirmationModels(protocol, source, { start, end }) {
  const models = structuredClone(source.protocol.models);
  for (const model of models) model.backend.window = { start, end };
  assert.deepEqual(protocol.models, models, 'CONFIRMATION_CONTINUATION_MODEL_CHANGED');
}

async function continuationCaptures(protocol, execution, source) {
  assert.deepEqual(sorted(Object.keys(execution.conditions)), sorted(Object.keys(source.execution.conditions)), 'CONFIRMATION_CONTINUATION_CONDITIONS_CHANGED');
  const captures = new Map(), firstRuns = new Map();
  for (const condition of protocol.conditions) {
    const current = execution.conditions[condition.id], original = source.execution.conditions[condition.id];
    const { expectations, ...candidate } = current, { expectations: oldExpectations, ...oldCandidate } = original;
    assert.deepEqual(candidate, oldCandidate, 'CONFIRMATION_CONTINUATION_SUBJECT_CHANGED');
    assert.deepEqual(sorted(Object.keys(expectations)), sorted(Object.keys(oldExpectations)), 'CONFIRMATION_CONTINUATION_FULL_CAPTURE_MAPPING_REQUIRED');
    for (const [caseId, reference] of Object.entries(expectations)) {
      assert.equal(reference.sha256, oldExpectations[caseId].sha256, 'CONFIRMATION_CONTINUATION_EXPECTATION_CHANGED');
      await verified(oldExpectations[caseId], false);
      const expectation = await verified(reference);
      assert.ok(inside(execution.control_root, reference.path), 'CONFIRMATION_CONTINUATION_NEW_CAPTURE_REQUIRED');
      const name = basename(reference.path); assert.ok(name.startsWith(protocol.id + '-capture-') && name.endsWith('.expectation.json'));
      const runId = name.slice(0, -'.expectation.json'.length), runRoot = join(execution.environment_root, 'runs', runId);
      if (!firstRuns.has(condition.environment_id)) firstRuns.set(condition.environment_id, {
        current: runId, original: basename(oldExpectations[caseId].path, '.expectation.json') });
      if (captures.has(runId)) { assert.equal(captures.get(runId), reference.sha256); continue; }
      captures.set(runId, reference.sha256);
      // Configure has just made these actual no-model observations. Reading the
      // old expectation alone cannot stand in for the new caller's capture.
      const runtime = JSON.parse((await file(join(runRoot, 'benchmark/runtime/episode-result.json'))).bytes);
      const shared = JSON.parse((await file(join(runRoot, 'result.json'))).bytes);
      assert.equal(runtime.status, 'captured'); assert.equal(shared.run_id, runId); assert.equal(shared.status, 'passed');
      assert.equal(shared.build_id, original.build_id); assert.equal(runtime.correlation.run_id, runId); assert.equal(runtime.correlation.episode_id, runId);
      assert.equal(runtime.correlation.candidate_id, condition.id); assert.ok(Object.hasOwn(expectations, runtime.correlation.task_id));
      assert.equal(runtime.paths.result, join(runRoot, 'benchmark/runtime/episode-result.json'));
      assert.equal(runtime.paths.expectation, join(runRoot, 'benchmark/runtime/candidate-expectation.json'));
      assert.equal(shared.runtime_check.status, 'unchanged'); assert.equal(shared.frozen_artifacts, 'passed');
      for (const key of ['requests', 'attempts', 'tools', 'input_tokens', 'output_tokens', 'tokens']) assert.equal(runtime.budget[key], 0);
      assert.equal(runtime.budget.usage_unknown, false);
      assert.equal(sha((await file(runtime.paths.expectation)).bytes), reference.sha256, 'CONFIRMATION_CONTINUATION_CAPTURE_CHANGED');
      const observed = runtime.artifacts.find(item => item.id === 'candidate-observed'); assert.ok(observed);
      assert.equal(observed.path, join(runRoot, 'benchmark/runtime/candidate-observed.json'));
      assert.deepEqual((await verified(clean(observed))).projection, expectation.projection, 'CONFIRMATION_CONTINUATION_CAPTURE_CHANGED');
      const transportRef = runtime.artifacts.find(item => item.id === 'transport'); assert.ok(transportRef);
      assert.equal(transportRef.path, join(runRoot, 'benchmark/runtime/transport.jsonl'));
      await verified(clean(transportRef), false); const transport = await readProviderTransport(transportRef.path);
      assert.equal(transport[0].clockId, runId); assert.equal(transport.at(-1).complete, true);
      assert.ok(!transport.some(item => item.phase === 'request_start' && item.category !== 'other'), 'CONFIRMATION_CONTINUATION_CAPTURE_MODEL_SEND');
    }
  }
  assert.equal(protocol.environments.length, source.protocol.environments.length);
  for (const [index, environment] of protocol.environments.entries()) {
    const original = source.protocol.environments[index], copy = structuredClone(environment), runs = firstRuns.get(environment.id); assert.ok(runs);
    assert.equal(environment.manifest_sha256, fingerprint({ ...environment, manifest_sha256: null }));
    assert.equal(copy.pi.extensions.length, original.pi.extensions.length);
    for (const [i, extension] of copy.pi.extensions.entries()) {
      const before = original.pi.extensions[i];
      if (extension.role !== 'observer') { assert.deepEqual(extension, before); continue; }
      const suffix = 'subject-runtime/benchmark/runtime/episode-runner.mjs';
      assert.equal(extension.path, join(execution.environment_root, 'runs', runs.current, suffix), 'CONFIRMATION_CONTINUATION_OBSERVER_PATH_CHANGED');
      assert.equal(before.path, join(execution.environment_root, 'runs', runs.original, suffix));
      assert.deepEqual({ ...extension, path: before.path }, before, 'CONFIRMATION_CONTINUATION_OBSERVER_CHANGED');
      extension.path = before.path;
    }
    copy.manifest_sha256 = original.manifest_sha256;
    assert.deepEqual(copy, original, 'CONFIRMATION_CONTINUATION_ENVIRONMENT_CHANGED');
  }
}

/** The sole exposed-material exception retains the exact original design and
 * actual startup contracts. It cannot be used for a new blind confirmation. */
export async function assertConfirmationContinuation(protocol, execution, slots, amendment, authorized) {
  assertContinuationModels(protocol, authorized);
  return assertSameConfirmationDesign(protocol, execution, slots, amendment, authorized.confirmationContinuation, authorized.value.revision.next_allocation_id);
}

/** Both approved continuation contracts retain the same original scientific
 * design. Their separate history readers establish the permitted suffix. */
export async function assertSameConfirmationDesign(protocol, execution, slots, amendment, continuation, nextAllocationId) {
  const { source, transition } = continuation;
  assert.equal(amendment.role, CONFIRMATION_CONTINUATION);
  assert.equal(amendment.id, nextAllocationId, 'CONFIRMATION_CONTINUATION_NEW_OWNER_CHANGED');
  assert.equal(protocol.id, transition.experiment_id, 'CONFIRMATION_CONTINUATION_EXPERIMENT_CHANGED');
  assert.deepEqual(amendment.selection, transition.selection, 'CONFIRMATION_CONTINUATION_SELECTION_CHANGED');
  assert.deepEqual(slots, source.slots.slice(transition.spent).map((slot, order) => ({ ...slot, order })), 'CONFIRMATION_CONTINUATION_SUFFIX_CHANGED');
  assert.deepEqual(declaredSchedule(protocol), source.slots, 'CONFIRMATION_CONTINUATION_SCIENTIFIC_DENOMINATOR_CHANGED');
  assert.equal(protocol.phase, 'confirmation'); assert.equal(protocol.policies.decision.mode, 'acceptance');
  const budget = structuredClone(source.protocol.policies.budgets); budget[0].batch.max_episodes = transition.remaining;
  assert.deepEqual(protocol.policies.budgets, budget, 'CONFIRMATION_CONTINUATION_BUDGET_POLICY_CHANGED');
  await continuationCaptures(protocol, execution, source);
  const same = structuredClone(protocol);
  Object.assign(same, { id: source.protocol.id, registered_at: source.protocol.registered_at, protocol_sha256: source.protocol.protocol_sha256,
    environments: source.protocol.environments, models: source.protocol.models });
  for (const condition of same.conditions) {
    const original = source.protocol.conditions.find(item => item.id === condition.id); assert.ok(original);
    condition.environment_sha256 = original.environment_sha256;
  }
  same.policies.campaign = source.protocol.policies.campaign; same.policies.budgets = source.protocol.policies.budgets;
  assert.deepEqual(same, source.protocol, 'CONFIRMATION_CONTINUATION_SCIENTIFIC_CONTRACT_CHANGED');
  assert.equal(execution.episode_fixtures, undefined); assert.equal(source.execution.episode_fixtures, undefined);
  const changing = ['control_root', 'implementation', 'instrumentation', 'case_bindings_file', 'case_bindings_sha256', 'models_file', 'campaign_scope', 'conditions'];
  const stable = value => Object.fromEntries(Object.entries(value).filter(([key]) => !changing.includes(key)));
  assert.deepEqual(stable(execution), stable(source.execution), 'CONFIRMATION_CONTINUATION_EXECUTION_CHANGED');
  for (const key of ['case_bindings_file', 'models_file']) assert.ok(inside(execution.control_root, execution[key]), 'CONFIRMATION_CONTINUATION_NEW_OWNER_REQUIRED');
  const dependencyChanges = ['benchmark/campaign-selection.mjs', 'benchmark/protocol.mjs', 'benchmark/schemas/protocol.schema.json'];
  assert.deepEqual(execution.instrumentation.collector_files.map(item => item.path), source.execution.instrumentation.collector_files.map(item => item.path),
    'CONFIRMATION_CONTINUATION_APPARATUS_FILES_CHANGED');
  const instrumentation = value => ({ ...value, collector_sha256: null,
    collector_files: value.collector_files.filter(item => !dependencyChanges.includes(item.path)) });
  assert.deepEqual(instrumentation(execution.instrumentation), instrumentation(source.execution.instrumentation), 'CONFIRMATION_CONTINUATION_APPARATUS_CHANGED');
  return transition.source_plan;
}

// Verify the original rejection, not a later diagnostic's conclusion. Non-model
// HTTP observations remain present and cost/duration are never changed to zero.
async function retainedZeroAdmission(scope, terminal, accepted, observed) {
  const { episode } = await readEvidenceBundle({ directory: terminal.result.normalized_directory, rawRoot: scope.plan.execution.environment_root });
  const artifact = id => { const matches = episode.artifacts.filter(item => item.id === id); assert.equal(matches.length, 1, 'CONFIRMATION_CONTINUATION_STOP_ARTIFACT'); return clean(matches[0]); };
  const runtimeRef = artifact('collection-runtime-result'), sharedRef = artifact('collection-launcher-result');
  const runtime = await verified(runtimeRef), shared = await verified(sharedRef);
  await assertZeroSendInvalid({ episode, runtime, shared });
  assert.equal(episode.episode_sha256, observed.episode_sha256); assert.equal(episode.identity.run_id, terminal.run_id);
  assert.deepEqual(runtime.correlation, { run_id: terminal.run_id, episode_id: episode.identity.episode_id,
    candidate_id: terminal.condition_id, task_id: terminal.case_id });
  assert.equal(episode.attempts.length, 0); assert.equal(episode.tools.length, 0);
  for (const key of ['requests', 'attempts', 'tools', 'input_tokens', 'output_tokens', 'tokens']) assert.equal(runtime.budget[key], 0, 'CONFIRMATION_CONTINUATION_NOT_KNOWN_ZERO');
  assert.deepEqual(terminal.result.budget_usage, { model_requests: 0, input_tokens: 0, output_tokens: 0, duration_ms: episode.timing.duration_ms.value });
  const comparisonRef = artifact('admission-comparison'), comparison = await verified(comparisonRef);
  const paths = ['/git/bytes', '/git/realpath', '/git/sha256', '/git/version'];
  assert.deepEqual(runtime.error.details.differences, paths, 'CONFIRMATION_CONTINUATION_OTHER_ADMISSION_FAILURE');
  assert.deepEqual(comparison.differences.map(item => item.path), paths, 'CONFIRMATION_CONTINUATION_OTHER_ADMISSION_FAILURE');
  const expectedRef = scope.plan.execution.conditions[terminal.condition_id].expectations[terminal.case_id];
  assert.deepEqual(clean(comparison.expected_file), clean(expectedRef), 'CONFIRMATION_CONTINUATION_EXPECTATION_CHANGED');
  const expected = await verified(expectedRef), observedRef = artifact('candidate-observed'), candidate = await verified(observedRef);
  const { git: expectedGit, ...expectedProjection } = expected.projection, { git: actualGit, ...actualProjection } = candidate.projection;
  assert.deepEqual(actualProjection, expectedProjection, 'CONFIRMATION_CONTINUATION_OTHER_ADMISSION_FAILURE');
  const otherGit = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['bytes', 'realpath', 'sha256', 'version'].includes(key)));
  assert.deepEqual(otherGit(actualGit), otherGit(expectedGit), 'CONFIRMATION_CONTINUATION_OTHER_GIT_DRIFT');
  assert.deepEqual(comparison.differences, paths.map(path => ({ path, expected: expectedGit[path.slice(5)], actual: actualGit[path.slice(5)] })));
  assert.equal(expectedGit.version, 'git version ' + accepted.proposal.stop.expected_git_version);
  assert.equal(actualGit.version, 'git version ' + accepted.proposal.stop.observed_git_version);
  const eventsRef = artifact('events'), transportRef = artifact('transport');
  const bytes = await verified(eventsRef, false); assert.equal(bytes.at(-1), 10, 'CONFIRMATION_CONTINUATION_TRUNCATED_EVENTS');
  const events = bytes.toString().trimEnd().split('\n').map(JSON.parse);
  for (const [index, event] of events.entries()) { assert.equal(event.sequence, index + 1); assert.equal(event.run_id, terminal.run_id); }
  const reconciliations = events.filter(event => event.type === 'transport_reconciliation'); assert.equal(reconciliations.length, 1);
  const reconciliation = reconciliations[0].data;
  assert.equal(reconciliation.complete, true); assert.equal(reconciliation.model_http_requests, 0); assert.equal(reconciliation.guarded_fetch_attempts, 0);
  assert.equal(events.at(-1)?.type, 'runtime_end');
  await verified(transportRef, false); const transport = await readProviderTransport(transportRef.path);
  assert.equal(transport[0].clockId, terminal.run_id); assert.equal(transport.at(-1).complete, true); assert.equal(transport.at(-1).errors, 0);
  const starts = transport.filter(event => event.phase === 'request_start');
  assert.ok(starts.every(event => event.category === 'other'), 'CONFIRMATION_CONTINUATION_MODEL_TRANSPORT');
  assert.equal(starts.length, accepted.proposal.stop.other_http_requests);
  return { runtime_result: runtimeRef, launcher_result: sharedRef, admission_comparison: comparisonRef,
    observed_candidate: observedRef, expected_candidate: clean(expectedRef), events: eventsRef, transport: transportRef };
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

/** Read-only: accept a closed original confirmation prefix and transfer its
 * exact never-started suffix. It neither registers nor resumes the old scope. */
export async function readPartialConfirmationHistory({ parent: authorized, parentReference, userApproval, predecessor,
  planFiles, pilotLedgerRoot, expected, currentBoundary = false, modelWindow: window }) {
  const parent = authorized.value, accepted = await decision(parent, parentReference, userApproval), { proposal, value: approval } = accepted;
  assert.equal(pilotLedgerRoot, parent.pilot_ledger_root);
  if (currentBoundary) await boundary(pilotLedgerRoot, approval.accepted_history_reservations);
  const scopes = await readRegisteredAllocationScopes(parent, parentReference, predecessor, { partialTerminal: true });
  assert.equal(scopes.length, 2, 'CONFIRMATION_CONTINUATION_TWO_SOURCE_SCOPES');
  assert.deepEqual(scopes.map(scope => scope.allocation), parent.allocations.slice(0, 2), 'CONFIRMATION_CONTINUATION_ALLOCATION_ORDER');
  const [complete, partial] = scopes, source = partial.plan, spent = partial.completed.length, remaining = source.slots.length - spent;
  assert.equal(complete.allocation.role, UNSTARTED_FOLLOWUP); assert.equal(partial.allocation.role, 'acceptance');
  assert.equal(source.protocol.phase, 'confirmation'); assert.equal(source.protocol.policies.decision.mode, 'acceptance');
  assert.equal(source.protocol.models.length, 1);
  assert.equal(source.protocol.models[0].routing.model_variant, proposal.model_condition.variant, 'CONFIRMATION_CONTINUATION_SOURCE_MODEL_CHANGED');
  assert.deepEqual(source.protocol.models[0].parameters, proposal.model_condition.parameters, 'CONFIRMATION_CONTINUATION_SOURCE_MODEL_CHANGED');
  assert.ok(spent > 0 && remaining > 0, 'CONFIRMATION_CONTINUATION_PARTIAL_PREFIX_REQUIRED');
  assert.deepEqual(declaredSchedule(source.protocol), source.slots, 'CONFIRMATION_CONTINUATION_FULL_ORIGINAL_DESIGN_REQUIRED');
  assert.equal(partial.ledger.rows.at(-1).reason, 'subject_requested_stop', 'CONFIRMATION_CONTINUATION_CLOSED_STOP_REQUIRED');
  assert.deepEqual(proposal.allocation_transition.fully_consumed_allocation, { id: complete.allocation.id, reservations: complete.completed.length });
  assert.deepEqual(proposal.allocation_transition.partial_original_allocation,
    { id: partial.allocation.id, original_limit: partial.allocation.reservation_limit, spent, never_started_to_transfer: remaining });
  const count = parent.history.scheduled_episodes + complete.completed.length + spent;
  assert.equal(count, approval.accepted_history_reservations); assert.equal(proposal.allocation_transition.additional_closed, count - parent.history.scheduled_episodes);
  const own = proposal.own;
  assert.equal(own.original_scope_id, partial.allocation.id); assert.equal(own.original_experiment_id, source.id);
  assert.equal(own.original_phase, source.protocol.phase); assert.equal(own.original_scientific_slots, source.slots.length); assert.equal(own.original_selected_slots, source.slots.length);
  assert.equal(own.already_started, spent); assert.equal(own.unstarted, remaining); assert.equal(proposal.budget.own_remaining, remaining);
  const selection = { source_plan_sha256: source.plan_sha256, slot_ids: source.slots.slice(spent).map(slot => slot.slot_id) };
  assert.deepEqual(own.remaining_slots.map(({ source_order, prospective_selected_order, ...item }) => {
    const { operator_id, cold_precommitted, ...slot } = item; return { ...slot, order: source_order, selected_order: prospective_selected_order };
  }), source.slots.slice(spent).map((slot, selected_order) => ({ ...slot, selected_order })), 'CONFIRMATION_CONTINUATION_SUFFIX_CHANGED');
  assert.deepEqual(own.excluded_started_slots.map(item => ({ source_order: item.source_order, slot_id: item.slot_id, run_id: item.run_id, must_never_retry: item.must_never_retry })),
    source.slots.slice(0, spent).map(slot => ({ source_order: slot.order, slot_id: slot.slot_id, run_id: source.id + '-' + String(slot.order + 1).padStart(3, '0'), must_never_retry: true })), 'CONFIRMATION_CONTINUATION_STARTED_SLOT_CHANGED');
  const allocations = [{ id: own.proposed_scope_id, work_index: partial.allocation.work_index, role: CONFIRMATION_CONTINUATION, reservation_limit: remaining }, ...parent.allocations.slice(2)];
  assert.ok(!parent.allocations.some(item => item.id === own.proposed_scope_id), 'CONFIRMATION_CONTINUATION_NEW_OWNER_REQUIRED');
  assert.deepEqual(approval.remaining_sequence[0], { id: own.proposed_scope_id, source_allocation_id: partial.allocation.id,
    source_order_first: spent, source_order_last: source.slots.length - 1, reservation_limit: remaining, cold_positions_subset: proposal.cold.remaining_within_own17 });
  assert.deepEqual(approval.remaining_sequence.slice(1), allocations.slice(1).map(({ id, reservation_limit }) => ({ id, reservation_limit })), 'CONFIRMATION_CONTINUATION_REMAINING_ALLOCATION_CHANGED');
  assert.deepEqual(proposal.engineering.entries.map(item => ({ id: item.allocation_id, work_index: item.work_index, reservation_limit: item.selected_reservations })),
    allocations.slice(1).map(({ id, work_index, reservation_limit }) => ({ id, work_index, reservation_limit })));
  for (const [index, item] of proposal.engineering.entries.entries()) assert.equal(item.proposed_predecessor_scope_id, allocations[index].id);
  assert.equal(allocations.slice(1).reduce((sum, item) => sum + item.reservation_limit, 0), proposal.budget.engineering_remaining);
  assert.equal(allocations.reduce((sum, item) => sum + item.reservation_limit, 0), approval.approved_remaining_reservations);
  sourcePin(proposal, 'original-own-plan', partial.planReference); sourcePin(proposal, 'original-own-closed-ledger', partial.ledger.reference);
  assert.deepEqual(sorted(planFiles), sorted([...parent.history.plans.map(item => item.plan.path), ...scopes.map(scope => scope.planReference.path)]), 'CONFIRMATION_CONTINUATION_PLAN_SET_CHANGED');
  const terminal = partial.completed.at(-1); assert.equal(terminal.run_id, approval.retained_stop_run_id); assert.equal(terminal.slot_id, proposal.stop.slot_id);
  assert.equal(proposal.stop.physical_ordinal, count); assert.equal(proposal.stop.source_order, spent - 1);
  assert.equal(terminal.result.status, 'admission_rejected'); assert.equal(terminal.result.stop_batch, true);
  const plans = new Map(), originals = new Map();
  const history = await readCampaignHistory({ planFiles, pilotLedgerRoot, ...(expected ? { expected } : {}),
    assertPlan: async plan => {
      assert.equal(plan.plan_sha256, fingerprint({ ...plan, plan_sha256: null })); assert.equal(validateProtocol(plan.protocol, { stage: 'execute' }).valid, true);
      const path = join(plan.execution.control_root, 'plan.json'); plans.set(path, plan); const scope = scopes.find(item => item.planReference.path === path);
      if (scope) await verifyAuthorizedHistoryPlan(plan, scope.amendment, authorized, parentReference);
      else { const entry = parent.history.plans.find(item => item.plan.path === path); assert.ok(entry); assert.deepEqual((await file(path)).reference, entry.plan);
        if (plan.execution.campaign_scope) assertFiniteCampaignPlan(plan, await verified(plan.execution.campaign_scope.amendment)); }
    },
    assertOriginalCompleted: async input => {
      originals.set(input.ordinal, input.event); if (input.ordinal <= parent.history.scheduled_episodes) return;
      assert.equal(input.hasRevision, false, 'CONFIRMATION_CONTINUATION_SOURCE_REINTERPRETED');
      if (input.ordinal === count) { assert.equal(input.plan.plan_sha256, source.plan_sha256); assert.deepEqual(input.event, terminal); }
      else await verifyFiniteOriginalResults(input.plan, [input.event]);
    },
    assertModelEvidence: (episode, model, plan) => {
      if (authorized.retainedAliasStop && episode.identity.run_id === authorized.retainedAliasStop.retained.run_id)
        assertRetainedAliasEpisode(episode, model, plan, authorized.retainedAliasStop.retained);
      else if (plan.protocol.policies.campaign || isProspectiveCohort(plan.protocol.policies.pilot.scope)) assertCohortModelEvidence(episode, model);
    } });
  assert.equal(history.scheduled_episodes, count);
  for (const key of ['episodes', 'reservations']) assert.deepEqual(history[key].slice(0, parent.history.scheduled_episodes), parent.history[key], 'CONFIRMATION_CONTINUATION_PREFIX_CHANGED');
  for (const owner of parent.history.plans) assert.deepEqual(history.plans.find(item => item.plan.path === owner.plan.path), owner);
  let ordinal = parent.history.scheduled_episodes;
  const prior = await verified(parent.predecessor.amendment);
  for (const scope of scopes) {
    assert.deepEqual(scope.amendment.history, before(history, ordinal, plans)); assert.deepEqual(scope.amendment.history_exemption, prior.history_exemption);
    for (const slot of scope.plan.slots.slice(0, scope.completed.length)) {
      const item = history.reservations[ordinal++], reservation = await verified(item.reference), observed = history.episodes[ordinal - 1];
      assert.equal(item.ordinal, ordinal); assert.equal(reservation.run_id, scope.plan.id + '-' + String(slot.order + 1).padStart(3, '0'));
      assert.equal(reservation.slot_id, slot.slot_id); assert.equal(reservation.experiment_id, scope.plan.id); assert.equal(reservation.scope_id, scope.allocation.id);
      assert.equal(reservation.scope_role, scope.allocation.role); assert.equal(reservation.scope_kind, 'benchmark-finite-campaign');
      assert.equal(reservation.scope_amendment_sha256, scope.amendment.amendment_sha256); assert.equal(reservation.plan_sha256, scope.plan.plan_sha256); assert.deepEqual(reservation.plan, scope.planReference);
      assert.equal(observed.analysis_revision, undefined); assert.equal(observed.collection_recovery, undefined);
      if (ordinal !== count) { assert.equal(observed.core_evidence, 'complete'); assert.equal(observed.stop_batch, false, 'CONFIRMATION_CONTINUATION_EXTRA_STOP'); }
    }
  }
  const observed = history.episodes.at(-1); assert.equal(observed.admission, 'invalid'); assert.equal(observed.stop_batch, true); assert.equal(observed.core_evidence, 'incomplete');
  assert.deepEqual(history.unknown_usage_run_ids, parent.history.unknown_usage_run_ids, 'CONFIRMATION_CONTINUATION_UNKNOWN_LIST_CHANGED');
  assert.equal(history.episodes.filter(item => tokenUnknown(item.budget_usage)).length, approval.retained_effective_unknown_token_episodes);
  assert.equal([...originals.values()].filter(item => tokenUnknown(item.result.budget_usage)).length, approval.retained_original_unknown_token_episodes);
  const stopRefs = await retainedZeroAdmission(partial, terminal, accepted, observed);
  const retained = { source_plan: partial.planReference, source_ledger: partial.ledger.reference, reservation: history.reservations.at(-1).reference,
    episode: (await file(join(observed.directory, 'episode.json'))).reference, episode_sha256: observed.episode_sha256, ...stopRefs,
    run_id: terminal.run_id, ordinal: count, source_slot_id: terminal.slot_id, allocation_id: partial.allocation.id };
  const transition = { source_allocation_id: partial.allocation.id, experiment_id: own.proposed_experiment_id, original_limit: source.slots.length, spent, remaining,
    source_plan: partial.planReference, source_plan_sha256: source.plan_sha256, excluded_slot_ids: source.slots.slice(0, spent).map(slot => slot.slot_id), selection };
  const boundWindow = modelWindow(source, window, accepted);
  if (currentBoundary) await boundary(pilotLedgerRoot, count, partial.registration.sequence);
  return { history, consumed: [complete.allocation.id], allocations, retained, transition, source, modelWindow: boundWindow, decision: approval };
}
