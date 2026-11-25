import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fingerprint, validateProtocol } from './protocol.mjs';
import { ENGINEERING_WINDOW_CONTINUATION, declaredSchedule } from './campaign-selection.mjs';
import { readRegisteredAllocationScopes } from './campaign-history-extension.mjs';
import { readCampaignHistory } from './campaign-history.mjs';
import { assertFiniteCampaignPlan, verifyAuthorizedHistoryPlan, verifyFiniteOriginalResults,
  assertHistoricalAccountingPrefixes, finiteCampaignPolicy } from './finite-campaign.mjs';
import { assertCohortModelEvidence, isProspectiveCohort } from './prospective-cohort.mjs';
import { assertRetainedAliasEpisode } from './campaign-alias-revision.mjs';
import { assertRetainedProviderStopEpisode } from './campaign-provider-stop-continuation.mjs';
import { assertSameConfirmationModels } from './campaign-confirmation-continuation.mjs';
import { assertObserverRepairSetup, assertObserverRepairEngineeringCases } from './campaign-observer-repair-continuation.mjs';
import { preregisterComparison } from './planning.mjs';
import { invocationWallClockMs } from './engineering-progress.mjs';
import { executionImplementation } from './implementation.mjs';

export const ENGINEERING_WINDOW_REVISION = 'accepted-engineering-window-continuation';
export const ENGINEERING_WINDOW_DRAFT = 'engineering-window-continuation-proposal-not-executable';
export const ENGINEERING_SOURCE3_CONTROLLER_SHA256 = '62055507c7aa4d6a298841bd74cc7db2dc5d03e302f33c46846a653904cf719c';
export const ENGINEERING_CONTROLLER_OVERLAY = Object.freeze(['batch.mjs', 'campaign-dispatch.mjs', 'finite-campaign.mjs', 'campaign-selection.mjs',
  'protocol.mjs', 'schemas/protocol.schema.json', 'approved-campaign.mjs', 'campaign-engineering-window-continuation.mjs',
  'engineering-progress.mjs', 'engineering-runner.mjs', 'engineering-source.mjs', 'configure.mjs', 'controller.mjs', 'cli.mjs']);
export const ENGINEERING_WINDOW_SCIENCE = Object.freeze({ reporting: 'separate-model-window-protocols',
  paired_denominator: 'original_declared_schedule', missing_cells: 'retained_unknown', cross_window_pairing: false });
const resources = ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms'];
const known = usage => resources.every(key => Number.isFinite(usage?.[key]) && usage[key] >= 0);
const safe = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const sorted = values => [...values].sort();
const clean = ref => ({ path: ref.path, sha256: ref.sha256 });
const keys = (value, expected) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'ENGINEERING_WINDOW_SHAPE');
  assert.deepEqual(sorted(Object.keys(value)), sorted(expected), 'ENGINEERING_WINDOW_SHAPE');
};
async function file(path) {
  assert.ok(isAbsolute(path) && resolve(path) === path); assert.equal(await realpath(path), path);
  const first = await lstat(path); assert.ok(first.isFile() && !first.isSymbolicLink());
  const bytes = await readFile(path), last = await lstat(path);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(first[key], last[key]);
  return { bytes, reference: { path, sha256: createHash('sha256').update(bytes).digest('hex') } };
}
async function verified(ref) {
  keys(ref, ['path', 'sha256']); const actual = await file(ref.path);
  assert.deepEqual(actual.reference, ref, 'ENGINEERING_WINDOW_REFERENCE_CHANGED'); return JSON.parse(actual.bytes);
}
export async function assertEngineeringWindowCurrentBoundary(root) {
  const names = await readdir(root);
  assert.ok(!names.some(name => name === 'campaign.lease.json' || /^scope-.+\.lease\.json$/.test(name)), 'ENGINEERING_WINDOW_ACTIVE_LEASE');
  assert.equal(names.filter(name => /^\d{3}\.json$/.test(name)).length, 104, 'ENGINEERING_WINDOW_BOUNDARY_ADVANCED');
  assert.equal(names.filter(name => /^scope-registration(?:-\d{3})?\.json$/.test(name)).length, 13, 'ENGINEERING_WINDOW_REGISTRY_ADVANCED');
}

export function engineeringRemainingBudget(sourceBudget, completed) {
  assert.equal(sourceBudget.batch.max_episodes, 24, 'ENGINEERING_WINDOW_SOURCE_LIMIT');
  assert.equal(completed.length, 7, 'ENGINEERING_WINDOW_EXACT_SEVEN_REQUIRED');
  assert.ok(completed.every(row => known(row.result?.budget_usage)), 'ENGINEERING_WINDOW_UNKNOWN_USAGE');
  const consumedUsage = Object.fromEntries(resources.map(key => [key, completed.reduce((sum, row) => sum + row.result.budget_usage[key], 0)]));
  const remainingBudget = structuredClone(sourceBudget); remainingBudget.batch.max_episodes = 17;
  for (const key of resources) {
    const remainder = sourceBudget.batch['max_' + key] - consumedUsage[key];
    assert.ok(remainder >= sourceBudget.episode['max_' + key], 'ENGINEERING_WINDOW_NO_RESOURCE_HEADROOM');
    remainingBudget.batch['max_' + key] = Math.floor(remainder);
  }
  return { source_budget: structuredClone(sourceBudget), consumed_usage: consumedUsage, remaining_budget: remainingBudget,
    duration_rounding_ms: sourceBudget.batch.max_duration_ms - consumedUsage.duration_ms - remainingBudget.batch.max_duration_ms,
    duration_rounding: 'floor_remaining_milliseconds', wallclock_policy: 'remaining_duration_cap_per_new_invocation' };
}

function assertParent(parent) {
  assert.equal(parent.version, 6, 'ENGINEERING_WINDOW_PARENT_VERSION');
  assert.equal(parent.kind, 'benchmark-approved-prospective-campaign');
  assert.equal(parent.authorization_sha256, fingerprint({ ...parent, authorization_sha256: null }));
  assert.equal(parent.history.scheduled_episodes, 89); assert.equal(parent.total_reservation_ceiling, 139); assert.equal(parent.max_scheduled_episodes, 144);
  assert.deepEqual(parent.allocations.map(item => [item.work_index, item.role, item.reservation_limit]), [
    [3, 'confirmation_continuation', 8], [4, 'acceptance', 24], ...Array.from({ length: 5 }, () => [5, 'acceptance', 2]), [6, 'acceptance', 8],
  ], 'ENGINEERING_WINDOW_ORIGINAL_ALLOCATIONS_CHANGED');
}

async function sourceBoundary({ parent, parentReference, predecessor, checkpoint, continuation, currentBoundary = false }) {
  assertParent(parent);
  assert.ok(checkpoint.path.startsWith(parent.environment_root + '/control/')); await verified(checkpoint);
  if (currentBoundary) await assertEngineeringWindowCurrentBoundary(parent.pilot_ledger_root);
  const scopes = await readRegisteredAllocationScopes(parent, parentReference, predecessor, { partialTerminal: true });
  const derived = deriveEngineeringWindowTransition(parent, scopes, continuation);
  if (currentBoundary) await assertEngineeringWindowCurrentBoundary(parent.pilot_ledger_root);
  return derived;
}

/** The registered-source reader owns file/ledger integrity. This exact domain
 * projection owns the104/13 transition, never-started selection and resources. */
export function deriveEngineeringWindowTransition(parent, scopes, continuation) {
  assertParent(parent); keys(continuation, ['allocation_id', 'experiment_id']);
  for (const id of Object.values(continuation)) assert.ok(safe(id));
  assert.ok(!parent.allocations.some(item => item.id === continuation.allocation_id), 'ENGINEERING_WINDOW_NEW_OWNER_REQUIRED');
  assert.equal(scopes.length, 2, 'ENGINEERING_WINDOW_OWN_THEN_CODEMODE_REQUIRED');
  for (const [index, scope] of scopes.entries()) assert.deepEqual(scope.allocation, parent.allocations[index]);
  const [own, partial] = scopes, source = partial.plan;
  assert.equal(own.completed.length, 8); assert.equal(partial.completed.length, 7);
  assert.equal(partial.registration.sequence, 13); assert.equal(own.registration.sequence, 12);
  assert.equal(partial.ledger.rows.length, 16, 'ENGINEERING_WINDOW_EXACT_SOURCE_INVOCATION');
  assert.equal(partial.ledger.rows.filter(row => row.type === 'batch_opened').length, 1);
  assert.equal(partial.ledger.rows.at(-1).new_episodes, 7);
  assert.equal(partial.ledger.rows.at(-1).reason, 'batch_budget_exhausted', 'ENGINEERING_WINDOW_WALLCLOCK_STOP_REQUIRED');
  assert.equal(source.slots.length, 24); assert.equal(source.protocol.phase, 'pilot'); assert.equal(source.protocol.purpose, 'environment_iteration');
  assert.equal(source.protocol.policies.decision.mode, 'descriptive'); assert.equal(source.protocol.policies.budgets.length, 1);
  assert.deepEqual(declaredSchedule(source.protocol), source.slots, 'ENGINEERING_WINDOW_SCIENTIFIC_DESIGN_CHANGED');
  for (const scope of scopes) for (const row of scope.completed) {
    assert.equal(row.result.status, 'completed', 'ENGINEERING_WINDOW_NEW_CORE_FAILURE');
    assert.equal(row.result.stop_batch, false, 'ENGINEERING_WINDOW_NEW_CORE_STOP');
    assert.equal(row.result.stop_reason ?? null, null, 'ENGINEERING_WINDOW_NEW_CORE_STOP');
    assert.ok(known(row.result.budget_usage), 'ENGINEERING_WINDOW_UNKNOWN_USAGE');
  }
  const resourceCarryover = engineeringRemainingBudget(source.protocol.policies.budgets[0], partial.completed);
  const elapsed = invocationWallClockMs(partial.ledger.rows);
  assert.ok(elapsed >= resourceCarryover.source_budget.batch.max_duration_ms, 'ENGINEERING_WINDOW_WALLCLOCK_NOT_EXHAUSTED');
  assert.ok(!parent.history.episodes.some(item => item.experiment_id === continuation.experiment_id));
  assert.ok(scopes.every(scope => scope.plan.id !== continuation.experiment_id), 'ENGINEERING_WINDOW_EXPERIMENT_ALREADY_USED');
  const selection = { source_plan_sha256: source.plan_sha256, slot_ids: source.slots.slice(7).map(slot => slot.slot_id) };
  const transition = { source_allocation_id: partial.allocation.id, allocation_id: continuation.allocation_id,
    experiment_id: continuation.experiment_id, source_plan: partial.planReference, source_ledger: partial.ledger.reference,
    source_plan_sha256: source.plan_sha256, source_limit: 24, source_spent: 7, remaining: 17, selection };
  const allocations = [{ ...partial.allocation, id: continuation.allocation_id, role: ENGINEERING_WINDOW_CONTINUATION, reservation_limit: 17 },
    ...structuredClone(parent.allocations.slice(2))];
  assert.equal(allocations.reduce((sum, item) => sum + item.reservation_limit, 0), 35);
  return { scopes, source, transition, allocations, consumed: [own.allocation.id], resourceCarryover,
    remainingBudget: resourceCarryover.remaining_budget, oldWallclockMs: elapsed };
}

function draftValue(request, parent, derived) {
  assert.ok(safe(request.id));
  const value = { version: 1, kind: ENGINEERING_WINDOW_DRAFT, id: request.id, approved: false, execution_authority: null,
    parent_authorization: clean(request.parent_authorization), predecessor: structuredClone(request.predecessor), checkpoint: clean(request.checkpoint),
    controller_source: clean(request.controller_source),
    continuation: structuredClone(request.continuation), boundary: { scheduled_episodes: 104, registration_sequence: 13,
      unknown_usage_run_ids: structuredClone(parent.history.unknown_usage_run_ids) }, transition: derived.transition,
    consumed_allocations: derived.consumed, allocations: derived.allocations, resource_carryover: derived.resourceCarryover,
    source_invocation_elapsed_ms: derived.oldWallclockMs, new_reservation_ceiling: 35, total_reservation_ceiling: 139,
    max_scheduled_episodes: 144, unallocated_headroom: 5, engineering_designs: clean(parent.revision.engineering_designs),
    model_window: { previous: { start: parent.revision.model_window.start, end: parent.revision.model_window.end },
      proposed: { start: null, end: null }, duration_hours: 24, automatic_renewal: false }, science: structuredClone(ENGINEERING_WINDOW_SCIENCE),
    proposal_sha256: null };
  value.proposal_sha256 = fingerprint(value); return value;
}

/** Draft preparation reads exact retained source records. It deliberately does
 * not create an authority; the future preparer performs the full raw proof. */
export async function prepareEngineeringWindowDraft(request) {
  keys(request, ['id', 'parent_authorization', 'predecessor', 'checkpoint', 'continuation', 'controller_source']);
  const parent = await verified(request.parent_authorization);
  const derived = await sourceBoundary({ parent, parentReference: request.parent_authorization, predecessor: request.predecessor,
    checkpoint: request.checkpoint, continuation: request.continuation, currentBoundary: true });
  const { verifyReviewedEngineeringOverlay } = await import('./engineering-source.mjs');
  // Prove the prospective source's Git provenance before the composition
  // reader imports its implementation/protocol dependency chain.
  await verifyReviewedEngineeringOverlay(await verified(request.controller_source));
  await readEngineeringControllerComposition(request.controller_source, derived.source);
  return draftValue(request, parent, derived);
}

export async function readEngineeringWindowDecision(draftReference, decisionReference) {
  const decision = await verified(decisionReference);
  keys(decision, ['version', 'kind', 'approved', 'source', 'user_message', 'recorded_at_utc', 'approved_draft', 'parent_authorization',
    'checkpoint', 'controller_source', 'predecessor', 'source_plan', 'source_ledger', 'accepted_history_reservations', 'registration_sequence',
    'approved_remaining_reservations', 'total_reservation_ceiling', 'max_scheduled_episodes', 'model_window', 'future_stop_policy']);
  assert.equal(decision.version, 1); assert.equal(decision.kind, 'user-approved-engineering-window-continuation');
  assert.equal(decision.approved, true, 'ENGINEERING_WINDOW_EXPLICIT_APPROVAL_REQUIRED');
  assert.equal(decision.source, 'current-user-message'); assert.ok(decision.user_message?.trim());
  assert.deepEqual(decision.approved_draft, draftReference, 'ENGINEERING_WINDOW_DRAFT_REFERENCE_CHANGED');
  const draft = await verified(draftReference);
  assert.equal(draft.version, 1); assert.equal(draft.kind, ENGINEERING_WINDOW_DRAFT);
  assert.equal(draft.approved, false); assert.equal(draft.execution_authority, null);
  assert.equal(draft.proposal_sha256, fingerprint({ ...draft, proposal_sha256: null }), 'ENGINEERING_WINDOW_DRAFT_CHANGED');
  assert.deepEqual(draft.model_window.proposed, { start: null, end: null });
  assert.equal(draft.model_window.duration_hours, 24); assert.equal(draft.model_window.automatic_renewal, false);
  for (const key of ['parent_authorization', 'checkpoint', 'controller_source', 'predecessor']) assert.deepEqual(decision[key], draft[key], 'ENGINEERING_WINDOW_APPROVAL_BINDING_CHANGED');
  assert.deepEqual(decision.source_plan, draft.transition.source_plan); assert.deepEqual(decision.source_ledger, draft.transition.source_ledger);
  assert.deepEqual([decision.accepted_history_reservations, decision.registration_sequence, decision.approved_remaining_reservations,
    decision.total_reservation_ceiling, decision.max_scheduled_episodes], [104, 13, 35, 139, 144], 'ENGINEERING_WINDOW_APPROVAL_LIMIT_CHANGED');
  keys(decision.model_window, ['start', 'end', 'automatic_renewal']);
  const start = Date.parse(decision.model_window.start), end = Date.parse(decision.model_window.end), approvedAt = Date.parse(decision.recorded_at_utc);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(approvedAt), 'ENGINEERING_WINDOW_TIMESTAMPS_REQUIRED');
  assert.equal(end - start, 24 * 60 * 60 * 1000, 'ENGINEERING_WINDOW_EXACT_24H_REQUIRED');
  assert.ok(start >= Date.parse(draft.model_window.previous.end) && start >= approvedAt, 'ENGINEERING_WINDOW_OVERLAP_OR_BACKDATE');
  assert.equal(decision.model_window.automatic_renewal, false);
  assert.deepEqual(decision.future_stop_policy, { core: 'stop', usage_unknown: 'stop', retry: false, renew_window: false });
  return { draft, decision, modelWindow: { mode: 'single_new_24h', start: decision.model_window.start, end: decision.model_window.end } };
}

/** The trusted authority reader supplies its freshly verified v6 parent. Only
 * preparation requires today's physical boundary still to be exactly104/13. */
export async function readEngineeringWindowHistory({ parent: authorized, parentReference, draft, predecessor,
  expected, currentBoundary = false }) {
  const parent = authorized.value;
  assert.deepEqual(draft.parent_authorization, parentReference); assert.deepEqual(draft.predecessor, predecessor);
  const derived = await sourceBoundary({ parent, parentReference, predecessor, checkpoint: draft.checkpoint,
    continuation: draft.continuation, currentBoundary });
  assert.deepEqual(draft, draftValue({ id: draft.id, parent_authorization: parentReference, predecessor, checkpoint: draft.checkpoint,
    continuation: draft.continuation, controller_source: draft.controller_source }, parent, derived), 'ENGINEERING_WINDOW_DERIVED_DRAFT_CHANGED');
  const controller = await readEngineeringControllerComposition(draft.controller_source, derived.source);
  const controllerImplementation = controller.implementation;
  if (currentBoundary) {
    const { verifyReviewedEngineeringOverlay } = await import('./engineering-source.mjs');
    await verifyReviewedEngineeringOverlay(controller.composition);
  }
  const plans = new Map(), planFiles = [...parent.history.plans.map(item => item.plan.path), ...derived.scopes.map(item => item.planReference.path)];
  const history = await readCampaignHistory({ planFiles, pilotLedgerRoot: parent.pilot_ledger_root, ...(expected ? { expected } : {}),
    assertPlan: async plan => {
      assert.equal(plan.plan_sha256, fingerprint({ ...plan, plan_sha256: null })); assert.equal(validateProtocol(plan.protocol, { stage: 'execute' }).valid, true);
      const path = join(plan.execution.control_root, 'plan.json'); plans.set(path, plan.id);
      const scope = derived.scopes.find(item => item.planReference.path === path);
      if (scope) await verifySource3HistoricalPlan(plan, scope.amendment, authorized, parentReference, controller.historicalController);
      else {
        const previous = parent.history.plans.find(item => item.plan.path === path); assert.ok(previous);
        assert.deepEqual((await file(path)).reference, previous.plan);
        if (plan.execution.campaign_scope) assertFiniteCampaignPlan(plan, await verified(plan.execution.campaign_scope.amendment));
      }
    },
    assertOriginalCompleted: async input => {
      if (input.ordinal <= 89) return;
      assert.equal(input.hasRevision, false, 'ENGINEERING_WINDOW_SOURCE_REINTERPRETED');
      await verifyFiniteOriginalResults(input.plan, [input.event]);
    },
    assertModelEvidence: (episode, model, plan) => {
      if (authorized.retainedProviderStop && episode.identity.run_id === authorized.retainedProviderStop.run_id)
        assertRetainedProviderStopEpisode(episode, model, plan, authorized.retainedProviderStop);
      else if (authorized.retainedAliasStop && episode.identity.run_id === authorized.retainedAliasStop.retained.run_id)
        assertRetainedAliasEpisode(episode, model, plan, authorized.retainedAliasStop.retained);
      else if (plan.protocol.policies.campaign || isProspectiveCohort(plan.protocol.policies.pilot.scope)) assertCohortModelEvidence(episode, model);
    } });
  assert.equal(history.scheduled_episodes, 104); assert.deepEqual(history.unknown_usage_run_ids, parent.history.unknown_usage_run_ids);
  assert.ok(!history.episodes.some(item => item.experiment_id === draft.continuation.experiment_id), 'ENGINEERING_WINDOW_EXPERIMENT_ALREADY_USED');
  assertHistoricalAccountingPrefixes(history, [parent.history, ...derived.scopes.map(scope => scope.amendment.history)], plans);
  let ordinal = 89;
  for (const scope of derived.scopes) for (const completed of scope.completed) {
    const entry = history.reservations[ordinal++], reservation = await verified(entry.reference), episode = history.episodes[ordinal - 1];
    assert.equal(entry.ordinal, ordinal); assert.equal(reservation.run_id, completed.run_id); assert.equal(reservation.slot_id, completed.slot_id);
    assert.equal(reservation.experiment_id, scope.plan.id); assert.equal(reservation.scope_id, scope.allocation.id);
    assert.equal(reservation.scope_role, scope.allocation.role); assert.equal(reservation.scope_kind, 'benchmark-finite-campaign');
    assert.equal(reservation.scope_amendment_sha256, scope.amendment.amendment_sha256); assert.deepEqual(reservation.plan, scope.planReference);
    assert.equal(reservation.plan_sha256, scope.plan.plan_sha256); assert.equal(episode.analysis_revision, undefined);
    assert.equal(episode.collection_recovery, undefined); assert.equal(episode.core_evidence, 'complete'); assert.equal(episode.stop_batch, false);
  }
  assert.equal(ordinal, 104);
  if (currentBoundary) await assertEngineeringWindowCurrentBoundary(parent.pilot_ledger_root);
  return { ...derived, history, parent: authorized, parentReference: clean(parentReference), controllerImplementation,
    controllerSource: clean(draft.controller_source),
    historicalController: controller.historicalController, historicalAuthorityReferences: await authorityReferences(parentReference),
    engineeringDesigns: authorized.confirmationContinuation.engineeringDesigns,
    science: structuredClone(ENGINEERING_WINDOW_SCIENCE) };
}

const controllerOverlay = new Set(ENGINEERING_CONTROLLER_OVERLAY);
const observationDependencies = new Set(['benchmark/campaign-selection.mjs', 'benchmark/protocol.mjs', 'benchmark/schemas/protocol.schema.json']);

/** Bind the new controller composition to the retained private source. Public
 * collector changes are intentionally not an allowed part of this repair. */
export async function readEngineeringControllerComposition(reference, source) {
  const composition = await verified(reference);
  keys(composition, ['version', 'kind', 'base_controller', 'source_root', 'reviewed_repository', 'reviewed_commit', 'implementation', 'overlay_files']);
  assert.equal(composition.version, 1); assert.equal(composition.kind, 'benchmark-engineering-controller-composition');
  assert.match(composition.reviewed_commit, /^[a-f0-9]{40}$/);
  assert.equal(composition.base_controller.sha256, ENGINEERING_SOURCE3_CONTROLLER_SHA256, 'ENGINEERING_WINDOW_RETAINED_SOURCE3_REQUIRED');
  const original = await verified(composition.base_controller);
  assert.deepEqual(original.implementation, source.execution.implementation, 'ENGINEERING_WINDOW_SOURCE_CONTROLLER_CHANGED');
  return verifyEngineeringControllerFiles(composition, original);
}

/** Internal file proof, shared with offline composition fixtures. This does
 * not authorize a composition: the public reader above first requires the
 * fixed source3 manifest and the frozen CodeMode plan's exact implementation. */
export async function verifyEngineeringControllerFiles(composition, original) {
  const historicalController = { reference: clean(composition.base_controller), source_root: original.source_root, implementation: original.implementation };
  await verifyHistoricalController(historicalController);
  assert.ok(isAbsolute(composition.source_root) && resolve(composition.source_root) === composition.source_root);
  assert.equal(await realpath(composition.source_root), composition.source_root); assert.notEqual(composition.source_root, original.source_root);
  const implementation = composition.implementation;
  assert.equal(implementation.version, original.implementation.version); assert.equal(implementation.scope, original.implementation.scope);
  assert.equal(implementation.sha256, fingerprint(implementation.files), 'ENGINEERING_WINDOW_IMPLEMENTATION_CHANGED');
  assert.deepEqual(implementation.files.map(item => item.path), [...new Set(implementation.files.map(item => item.path))].sort((a, b) => a.localeCompare(b)));
  const prior = new Map(original.implementation.files.map(item => [item.path, item])), changed = [];
  for (const item of implementation.files) {
    const path = resolve(composition.source_root, 'benchmark', item.path);
    assert.ok(path.startsWith(composition.source_root + '/'), 'ENGINEERING_WINDOW_SOURCE_OUTSIDE_OWNER');
    const actual = await file(path); assert.equal(actual.reference.sha256, item.sha256); assert.equal(actual.bytes.length, item.bytes);
    if (!prior.has(item.path) || fingerprint(item) !== fingerprint(prior.get(item.path))) {
      assert.ok(controllerOverlay.has(item.path), 'ENGINEERING_WINDOW_UNREVIEWED_SOURCE_CHANGE:' + item.path); changed.push(item);
    }
    prior.delete(item.path);
  }
  assert.equal(prior.size, 0, 'ENGINEERING_WINDOW_SOURCE_FILE_REMOVED');
  assert.deepEqual(changed, composition.overlay_files, 'ENGINEERING_WINDOW_OVERLAY_CHANGED');
  const oldCollector = original.implementation.files.find(item => item.path === 'collect.mjs'); assert.ok(oldCollector);
  assert.deepEqual(implementation.files.find(item => item.path === 'collect.mjs'), oldCollector, 'ENGINEERING_WINDOW_COLLECTOR_CHANGED');
  // implementation.mjs is retained from the verified base. Its static walker
  // reads (but does not execute) the CLI/controller dependency graph, so a
  // self-consistent manifest cannot silently omit a newly imported module.
  const producer = await import(pathToFileURL(join(composition.source_root, 'benchmark/implementation.mjs')));
  assert.deepEqual(await producer.executionImplementation(), implementation, 'ENGINEERING_WINDOW_INCOMPLETE_IMPLEMENTATION');
  return { implementation, historicalController, composition };
}

async function verifyHistoricalController(controller) {
  const original = await verified(controller.reference);
  assert.equal(original.source_root, controller.source_root); assert.deepEqual(original.implementation, controller.implementation);
  assert.equal(original.implementation.sha256, fingerprint(original.implementation.files));
  assert.equal(await realpath(original.source_root), original.source_root);
  for (const item of original.implementation.files) {
    const path = resolve(original.source_root, 'benchmark', item.path);
    assert.ok(path.startsWith(original.source_root + '/'), 'ENGINEERING_WINDOW_HISTORICAL_SOURCE_OUTSIDE_OWNER');
    const actual = await file(path); assert.equal(actual.reference.sha256, item.sha256, 'ENGINEERING_WINDOW_HISTORICAL_SOURCE_CHANGED');
    assert.equal(actual.bytes.length, item.bytes);
  }
}

async function historicalModule(controller, name) {
  // Prove every dependency before importing any historical verifier code.
  await verifyHistoricalController(controller);
  assert.ok(controller.implementation.files.some(item => item.path === name));
  return import(pathToFileURL(join(controller.source_root, 'benchmark', name)));
}

async function authorityReferences(parentReference) {
  const refs = [], seen = new Set(); let cursor = parentReference;
  while (cursor) {
    assert.ok(refs.length < 6 && !seen.has(cursor.path), 'ENGINEERING_WINDOW_PARENT_CHAIN_CHANGED');
    seen.add(cursor.path); refs.push(clean(cursor)); const value = await verified(cursor);
    cursor = value.version === 1 ? null : value.revision.parent_authorization;
  }
  return refs;
}

/** Verify the original v6 authority with its byte-bound original producer. No
 * current collector hash is substituted into an old observation contract. */
export async function readEngineeringWindowParent(draft, ancestors = new Set()) {
  const source = await verified(draft.transition.source_plan);
  assert.equal(source.plan_sha256, draft.transition.source_plan_sha256);
  const controller = await readEngineeringControllerComposition(draft.controller_source, source);
  const preview = await verified(draft.parent_authorization); assertParent(preview);
  const reader = await historicalModule(controller.historicalController, 'approved-campaign.mjs');
  const parent = await reader.readApprovedCampaign(draft.parent_authorization, ancestors); assertParent(parent.value);
  return parent;
}

export async function readEngineeringHistoricalAuthority(reference, authorized) {
  assert.equal(authorized.value.version, 7); const continuation = authorized.engineeringContinuation;
  assert.ok(continuation.historicalAuthorityReferences.some(item => fingerprint(item) === fingerprint(reference)), 'ENGINEERING_WINDOW_FOREIGN_HISTORICAL_AUTHORITY');
  const reader = await historicalModule(continuation.historicalController, 'approved-campaign.mjs');
  return reader.readApprovedCampaign(reference);
}

async function verifySource3HistoricalPlan(plan, amendment, parent, parentReference, controller) {
  assert.equal(parent.value.version, 6); assert.deepEqual(plan.execution.implementation, controller.implementation);
  assert.deepEqual(amendment.prospective_authorization.reference, parentReference);
  const reader = await historicalModule(controller, 'finite-campaign.mjs');
  return reader.verifyAuthorizedHistoryPlan(plan, amendment, parent, parentReference);
}

export async function verifyEngineeringHistoricalPlan(plan, amendment, authorized) {
  assert.equal(authorized.value.version, 7); const continuation = authorized.engineeringContinuation;
  const scope = continuation.scopes.find(item => item.plan.id === plan.id); assert.ok(scope, 'ENGINEERING_WINDOW_FOREIGN_HISTORICAL_PLAN');
  assert.deepEqual((await file(join(plan.execution.control_root, 'plan.json'))).reference, scope.planReference);
  assert.deepEqual(amendment, scope.amendment);
  return verifySource3HistoricalPlan(plan, amendment, continuation.parent, continuation.parentReference, continuation.historicalController);
}

export function isEngineeringHistoricalPredecessor(reference, authorized) {
  return authorized?.value.version === 7 && fingerprint(reference) === fingerprint(authorized.value.predecessor.amendment);
}

export async function readEngineeringHistoricalPredecessor(reference, authorized) {
  assert.ok(isEngineeringHistoricalPredecessor(reference, authorized), 'ENGINEERING_WINDOW_FOREIGN_HISTORICAL_PREDECESSOR');
  const reader = await historicalModule(authorized.engineeringContinuation.historicalController, 'finite-campaign.mjs');
  // The historical reader does not assert that predecessor13 is still active.
  return reader.readFiniteCampaignAmendment(reference);
}

export function assertEngineeringInstrumentation(execution, continuation) {
  assert.deepEqual(execution.implementation, continuation.controllerImplementation, 'ENGINEERING_WINDOW_CONTROLLER_COMPOSITION_CHANGED');
  const original = continuation.source.execution.instrumentation, current = execution.instrumentation;
  const actualFiles = new Map(current.collector_files.map(item => [item.path, item]));
  assert.equal(actualFiles.size, current.collector_files.length);
  assert.deepEqual(current.collector_files.map(item => item.path), original.collector_files.map(item => item.path), 'ENGINEERING_WINDOW_COLLECTOR_CLOSURE_CHANGED');
  for (const old of original.collector_files) {
    const actual = actualFiles.get(old.path);
    if (!observationDependencies.has(old.path)) assert.deepEqual(actual, old, 'ENGINEERING_WINDOW_COLLECTOR_CHANGED:' + old.path);
    else {
      const path = old.path.startsWith('benchmark/') ? old.path.slice('benchmark/'.length) : '../' + old.path;
      const approved = continuation.controllerImplementation.files.find(item => item.path === path); assert.ok(approved);
      assert.deepEqual(actual, { ...approved, path: old.path }, 'ENGINEERING_WINDOW_OBSERVER_DEPENDENCY_CHANGED:' + old.path);
    }
  }
  assert.equal(current.collector_sha256, fingerprint(current.collector_files));
  assert.deepEqual({ ...current, collector_files: null, collector_sha256: null }, { ...original, collector_files: null, collector_sha256: null },
    'ENGINEERING_WINDOW_OBSERVER_RUNTIME_CHANGED');
}

/** Recompute the actual expectation projections with the approved private
 * producer. The authority reader has already validated this composition's
 * original source3 anchor; its exact new code is rechecked before this import. */
export async function verifyEngineeringInstrumentation(execution, continuation) {
  assertEngineeringInstrumentation(execution, continuation);
  const composition = await verified(continuation.controllerSource);
  assert.equal(composition.base_controller.sha256, ENGINEERING_SOURCE3_CONTROLLER_SHA256);
  assert.deepEqual(composition.implementation, continuation.controllerImplementation);
  for (const item of composition.implementation.files) {
    const path = resolve(composition.source_root, 'benchmark', item.path);
    assert.ok(path.startsWith(composition.source_root + '/'));
    const actual = await file(path); assert.equal(actual.reference.sha256, item.sha256); assert.equal(actual.bytes.length, item.bytes);
  }
  const producer = await import(pathToFileURL(join(composition.source_root, 'benchmark/implementation.mjs')));
  assert.deepEqual(execution.instrumentation, await producer.instrumentationIdentity(execution), 'ENGINEERING_WINDOW_CURRENT_INSTRUMENTATION_CHANGED');
}

async function engineeringSetupDesign(setup, authorized) {
  assert.equal(authorized.value.version, 7, 'ENGINEERING_WINDOW_AUTHORITY_REQUIRED');
  const continuation = authorized.engineeringContinuation, allocation = authorized.value.allocations.find(item => item.id === setup.campaign_scope?.allocation_id);
  assert.ok(allocation, 'ENGINEERING_WINDOW_ALLOCATION_REQUIRED'); assert.equal(setup.campaign_scope.id, allocation.id);
  assert.equal(setup.campaign_scope.role, allocation.role); assert.equal(setup.budget.batch.max_episodes, allocation.reservation_limit);
  assert.deepEqual(setup.models.window, { start: continuation.modelWindow.start, end: continuation.modelWindow.end }, 'ENGINEERING_WINDOW_MODEL_WINDOW_CHANGED');
  const partial = allocation.role === ENGINEERING_WINDOW_CONTINUATION;
  const oldId = partial ? continuation.transition.source_allocation_id : allocation.id;
  const entry = continuation.engineeringDesigns.entries.find(item => item.allocation_id === oldId); assert.ok(entry);
  const original = await verified(clean(entry.setup)), normalized = structuredClone(setup);
  if (partial) {
    assert.equal(allocation.id, continuation.transition.allocation_id); assert.equal(setup.id, continuation.transition.experiment_id);
    assert.deepEqual(setup.campaign_scope.selection, continuation.transition.selection, 'ENGINEERING_WINDOW_SELECTION_CHANGED');
    assert.deepEqual(setup.budget, continuation.remainingBudget, 'ENGINEERING_WINDOW_BUDGET_CARRYOVER_CHANGED');
    normalized.id = original.id; normalized.budget = structuredClone(original.budget);
    for (const key of ['id', 'allocation_id', 'role']) normalized.campaign_scope[key] = original.campaign_scope[key];
    delete normalized.campaign_scope.selection;
  } else {
    assert.equal(allocation.role, 'acceptance'); assert.equal(setup.campaign_scope.selection, undefined);
    assert.deepEqual(setup.budget, original.budget, 'ENGINEERING_WINDOW_UNSTARTED_BUDGET_CHANGED');
  }
  normalized.models.window = { start: continuation.parent.value.revision.model_window.start, end: continuation.parent.value.revision.model_window.end };
  const proof = await assertObserverRepairSetup(normalized, continuation.parent);
  assert.deepEqual(proof.source_setup, clean(entry.setup));
  return { ...proof, original };
}

/** Configure calls this before creating its output directory or any capture. */
export async function assertEngineeringWindowSetup(setup, authorized) {
  const proof = await engineeringSetupDesign(setup, authorized);
  assert.deepEqual(await executionImplementation(), authorized.engineeringContinuation.controllerImplementation,
    'ENGINEERING_WINDOW_EXECUTING_SOURCE_CHANGED');
  return proof;
}

/** Historical reads compare frozen execution identity with the approved private
 * composition; they do not require the verifier itself to be that controller. */
export async function assertEngineeringWindowProtocol(protocol, execution, slots, amendment, authorized) {
  assert.equal(authorized.value.version, 7, 'ENGINEERING_WINDOW_AUTHORITY_REQUIRED');
  const continuation = authorized.engineeringContinuation;
  assertSameConfirmationModels(protocol, continuation.source, continuation.modelWindow);
  await verifyEngineeringInstrumentation(execution, continuation);
  for (const environment of protocol.environments) {
    const pair = continuation.parent.confirmationContinuation.repair.builds.find(item => item.target.id === environment.build.id); assert.ok(pair);
    assert.deepEqual(environment.build, pair.target.identity, 'ENGINEERING_WINDOW_SUBJECT_BUILD_CHANGED');
  }
  const setup = JSON.parse((await file(join(execution.control_root, 'setup.json'))).bytes), proof = await engineeringSetupDesign(setup, authorized);
  assert.equal(setup.campaign_scope.id, amendment.id); assert.equal(setup.campaign_scope.allocation_id, amendment.prospective_authorization.allocation_id);
  assert.deepEqual(setup.campaign_scope.prospective_authorization, amendment.prospective_authorization.reference);
  assert.deepEqual(setup.campaign_scope.predecessor, amendment.predecessor);
  if (amendment.role === ENGINEERING_WINDOW_CONTINUATION) {
    assert.equal(protocol.id, continuation.transition.experiment_id);
    assert.deepEqual(amendment.selection, continuation.transition.selection);
    assert.deepEqual(declaredSchedule(protocol), continuation.source.slots, 'ENGINEERING_WINDOW_SCIENTIFIC_DENOMINATOR_CHANGED');
    assert.deepEqual(slots, continuation.source.slots.slice(7).map((slot, order) => ({ ...slot, order })), 'ENGINEERING_WINDOW_EXACT_SUFFIX_REQUIRED');
    assert.equal(execution.episode_fixtures, undefined, 'ENGINEERING_WINDOW_STATEFUL_REPLAY_FORBIDDEN');
  } else assert.deepEqual(slots, (await verified(proof.source_schedule)).slots, 'ENGINEERING_WINDOW_UNSTARTED_SCHEDULE_CHANGED');
  const cases = await verified({ path: execution.case_bindings_file, sha256: execution.case_bindings_sha256 });
  if (amendment.role === ENGINEERING_WINDOW_CONTINUATION) assert.ok(cases.every(item => item.events.length === 0), 'ENGINEERING_WINDOW_STATEFUL_REPLAY_FORBIDDEN');
  const corpus = JSON.parse((await file(join(execution.control_root, 'corpus-public/corpus.json'))).bytes);
  assert.equal(corpus.seed, setup.corpus.seed); assert.equal(corpus.split, setup.corpus.split); assert.equal(corpus.version, setup.corpus.material_version);
  await assertObserverRepairEngineeringCases({ setup, sourceSetup: proof.original, corpus, cases });
  const expected = preregisterComparison({ id: setup.id, phase: setup.phase, purpose: setup.purpose,
    environments: protocol.environments, models: protocol.models, corpus, cases, repetitions: setup.repetitions ?? 1,
    budget: setup.budget, decision: setup.decision, analysis: setup.analysis,
    campaignScope: finiteCampaignPolicy(setup.campaign_scope, { scheduledEpisodes: slots.length }), environmentPairs: setup.environment_pairs,
    allowedChanges: setup.allowed_changes, orderingSeed: setup.ordering_seed, registeredAt: protocol.registered_at });
  assert.deepEqual(protocol, expected, 'ENGINEERING_WINDOW_SCIENTIFIC_CONTRACT_CHANGED');
  assert.deepEqual(execution.runtime, setup.runtime);
  for (const [index, candidate] of setup.candidates.entries()) {
    const environment = protocol.environments[index], condition = execution.conditions['m0-e' + index];
    assert.equal(environment.id, candidate.id); assert.equal(environment.build.id, candidate.build_id);
    assert.equal(environment.pi.mode, candidate.mode); assert.equal(environment.policies.code_mode, candidate.code_mode);
    assert.equal(condition.build_id, candidate.build_id); assert.equal(condition.mode, candidate.mode);
  }
}
