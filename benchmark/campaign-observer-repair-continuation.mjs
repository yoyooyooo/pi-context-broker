import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fingerprint, validateProtocol } from './protocol.mjs';
import { CONFIRMATION_CONTINUATION, declaredSchedule } from './campaign-selection.mjs';
import { readRegisteredAllocationScopes } from './campaign-history-extension.mjs';
import { readCampaignHistory } from './campaign-history.mjs';
import { assertFiniteCampaignPlan, verifyAuthorizedHistoryPlan, verifyFiniteOriginalResults, finiteCampaignPolicy } from './finite-campaign.mjs';
import { assertCohortModelEvidence, isProspectiveCohort } from './prospective-cohort.mjs';
import { assertRetainedAliasEpisode } from './campaign-alias-revision.mjs';
import { assertRetainedProviderStopEpisode } from './campaign-provider-stop-continuation.mjs';
import { assertSameConfirmationDesign, assertSameConfirmationModels } from './campaign-confirmation-continuation.mjs';
import { readEvidenceBundle } from './evidence/store.mjs';
import { verifyResolveObserverRepair, resolveRepairBuild } from './resolve-observer-repair.mjs';
import { bindMaterializedCases, preregisterComparison, protocolCaseForVariant } from './planning.mjs';
import { planCaseVariant, validateCorpus } from './corpus/index.mjs';
import { readCorpusSnapshot } from './corpus/snapshot.mjs';
import { inventoryPublicInputs } from './subject.mjs';

export const OBSERVER_REPAIR_REVISION = 'accepted-resolve-observer-continuation';
const usageKeys = ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms'];
const known = value => Number.isFinite(value) && value >= 0;
const clean = ref => ({ path: ref.path, sha256: ref.sha256 });
const sorted = values => [...values].sort();
const safe = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const keys = (value, expected) => assert.deepEqual(sorted(Object.keys(value)), sorted(expected), 'OBSERVER_CONTINUATION_SHAPE');
async function file(path) {
  assert.ok(isAbsolute(path) && resolve(path) === path); assert.equal(await realpath(path), path);
  const first = await lstat(path); assert.ok(first.isFile() && !first.isSymbolicLink());
  const bytes = await readFile(path), last = await lstat(path);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(first[key], last[key]);
  return { bytes, reference: { path, sha256: createHash('sha256').update(bytes).digest('hex') } };
}
async function verified(ref) {
  keys(ref, ['path', 'sha256']); const actual = await file(ref.path);
  assert.deepEqual(actual.reference, ref, 'OBSERVER_CONTINUATION_REFERENCE_CHANGED'); return JSON.parse(actual.bytes);
}
async function boundary(root, count, sequence) {
  const names = await readdir(root);
  assert.ok(!names.some(name => name === 'campaign.lease.json' || /^scope-.+\.lease\.json$/.test(name)), 'OBSERVER_CONTINUATION_ACTIVE_LEASE');
  assert.equal(names.filter(name => /^\d{3}\.json$/.test(name)).length, count, 'OBSERVER_CONTINUATION_BOUNDARY_ADVANCED');
  if (sequence !== undefined) assert.equal(names.filter(name => /^scope-registration(?:-\d{3})?\.json$/.test(name)).length, sequence);
}
async function decision(parent, parentReference, reference) {
  // A new explicit decision accepts this existing stop only. v6 cannot be chained.
  assert.equal(parent.version, 5, 'OBSERVER_CONTINUATION_PARENT_VERSION');
  assert.ok(reference.path.startsWith(parent.environment_root + '/control/'));
  const value = await verified(reference);
  keys(value, ['version', 'kind', 'approved', 'source', 'user_message', 'recorded_at_utc', 'parent_authorization', 'retained_stop',
    'accepted_history_reservations', 'approved_remaining_reservations', 'total_reservation_ceiling', 'max_scheduled_episodes',
    'continuation', 'model_window', 'apparatus_repair', 'engineering_designs', 'future_stop_policy']);
  assert.equal(value.version, 1); assert.equal(value.kind, 'user-approved-observer-repair-continuation');
  assert.equal(value.approved, true); assert.equal(value.source, 'current-user-message'); assert.ok(value.user_message?.trim());
  assert.deepEqual(value.parent_authorization, parentReference);
  for (const key of ['total_reservation_ceiling', 'max_scheduled_episodes']) assert.equal(value[key], parent[key], 'OBSERVER_CONTINUATION_BUDGET_CHANGED');
  assert.equal(value.accepted_history_reservations + value.approved_remaining_reservations, parent.total_reservation_ceiling);
  assert.ok(value.accepted_history_reservations > parent.history.scheduled_episodes && value.approved_remaining_reservations > 0);
  keys(value.continuation, ['allocation_id', 'experiment_id']);
  for (const name of Object.values(value.continuation)) assert.ok(safe(name));
  assert.ok(!parent.allocations.some(item => item.id === value.continuation.allocation_id), 'OBSERVER_CONTINUATION_NEW_OWNER_REQUIRED');
  keys(value.retained_stop, ['run_id', 'source_plan', 'source_ledger']); assert.ok(safe(value.retained_stop.run_id));
  const { start, end } = parent.revision.model_window; assert.deepEqual(value.model_window, { start, end }, 'OBSERVER_CONTINUATION_WINDOW_CHANGED');
  const time = Date.parse(value.recorded_at_utc); assert.ok(Number.isFinite(time) && time >= Date.parse(start) && time < Date.parse(end), 'OBSERVER_CONTINUATION_DECISION_OUTSIDE_WINDOW');
  assert.deepEqual(value.future_stop_policy, { core: 'stop', usage_unknown: 'stop', retry: false, renew_window: false });
  assert.ok(value.engineering_designs.path.startsWith(parent.environment_root + '/control/'));
  const designs = await verified(value.engineering_designs);
  assert.equal(designs.version, 1); assert.equal(designs.kind, 'engineering-execution-drafts');
  assert.deepEqual(designs.entries.map(item => [item.allocation_id, item.reservations]),
    parent.allocations.slice(1).map(item => [item.id, item.reservation_limit]), 'OBSERVER_CONTINUATION_ENGINEERING_ALLOCATIONS_CHANGED');
  assert.equal(designs.total_future_reservations, parent.allocations.slice(1).reduce((sum, item) => sum + item.reservation_limit, 0));
  return { value, designs, repair: await verifyResolveObserverRepair(value.apparatus_repair, parent.environment_root) };
}

/** Only the approved invalid observer observation can enter the accepted history. */
export function assertObserverStopObservation({ episode, runtime, terminal, experimentId }) {
  assert.equal(terminal.result.status, 'invalid'); assert.equal(terminal.result.stop_batch, true);
  assert.equal(terminal.result.stop_reason, 'subject_requested_stop');
  assert.equal(episode.episode_sha256, terminal.result.episode_sha256);
  assert.equal(episode.identity.run_id, terminal.run_id); assert.equal(episode.identity.experiment_id, experimentId);
  assert.equal(episode.admission.status, 'invalid');
  assert.deepEqual(sorted(episode.admission.reasons), ['core_notion_evidence_incomplete', 'runtime_not_a_business_episode:invalid']);
  for (const key of ['attempts', 'tools', 'interventions']) assert.equal(episode.admission.completeness[key], 'complete');
  assert.equal(episode.measurements.actual_attempts.status, 'known');
  for (const name of ['input_total', 'output_total']) assert.equal(episode.measurements[name].value.status, 'known');
  assert.equal(episode.timing.duration_ms.status, 'known');
  const actualUsage = { model_requests: episode.measurements.actual_attempts.value, input_tokens: episode.measurements.input_total.value.value,
    output_tokens: episode.measurements.output_total.value.value, duration_ms: episode.timing.duration_ms.value };
  assert.deepEqual(terminal.result.budget_usage, actualUsage, 'OBSERVER_CONTINUATION_STOP_USAGE_CHANGED');
  assert.ok(usageKeys.every(key => known(actualUsage[key])) && actualUsage.model_requests > 0, 'OBSERVER_CONTINUATION_KNOWN_USAGE_REQUIRED');
  assert.equal(runtime.status, 'invalid'); assert.equal(runtime.error, null); assert.equal(runtime.budget.usage_unknown, false); assert.equal(runtime.budget.stop, null);
  for (const [field, key] of [['requests', 'model_requests'], ['input_tokens', 'input_tokens'], ['output_tokens', 'output_tokens']]) assert.equal(runtime.budget[field], actualUsage[key]);
  assert.deepEqual(runtime.notion.coverage, { sdk: 'partial', owned_http: 'partial', child_lifecycle: 'partial', descendant_transport: 'unobserved' });
  return actualUsage;
}

/** Retain a complete cost observation of the exact invalid observer episode. */
export async function assertRetainedObserverStop(scope, terminal, environmentRoot, repair) {
  const { episode } = await readEvidenceBundle({ directory: terminal.result.normalized_directory, rawRoot: environmentRoot });
  const artifacts = episode.artifacts.filter(item => item.id === 'collection-runtime-result'); assert.equal(artifacts.length, 1);
  const runtime = await verified(clean(artifacts[0]));
  const actualUsage = assertObserverStopObservation({ episode, runtime, terminal, experimentId: scope.id });
  const condition = scope.protocol.conditions.find(item => item.id === terminal.condition_id); assert.ok(condition);
  const environment = scope.protocol.environments.find(item => item.id === condition.environment_id); assert.ok(environment);
  assert.equal(episode.identity.build_id, environment.build.id); assert.equal(episode.identity.environment_sha256, environment.manifest_sha256);
  const pair = repair.builds.find(item => item.source.id === environment.build.id); assert.ok(pair, 'OBSERVER_CONTINUATION_STOP_BUILD_REQUIRED');
  assert.deepEqual(environment.build, pair.source.identity, 'OBSERVER_CONTINUATION_STOP_BUILD_CHANGED');
  assertCohortModelEvidence(episode, scope.protocol.models.find(item => item.id === condition.model_id));
  return { episode: (await file(join(terminal.result.normalized_directory, 'episode.json'))).reference,
    episode_sha256: episode.episode_sha256, runtime_result: clean(artifacts[0]), usage: actualUsage };
}

export async function readObserverRepairHistory({ parent: authorized, parentReference, userApproval, predecessor,
  planFiles, pilotLedgerRoot, expected, currentBoundary = false }) {
  const parent = authorized.value, accepted = await decision(parent, parentReference, userApproval), approval = accepted.value;
  assert.equal(pilotLedgerRoot, parent.pilot_ledger_root);
  if (currentBoundary) await boundary(pilotLedgerRoot, approval.accepted_history_reservations);
  const scopes = await readRegisteredAllocationScopes(parent, parentReference, predecessor, { partialTerminal: true });
  assert.equal(scopes.length, 1, 'OBSERVER_CONTINUATION_SINGLE_PARTIAL_SCOPE');
  const partial = scopes[0], old = partial.plan, source = authorized.confirmationContinuation.source;
  assert.deepEqual(partial.allocation, parent.allocations[0]); assert.equal(partial.allocation.role, CONFIRMATION_CONTINUATION);
  const completed = partial.completed.length, spent = authorized.confirmationContinuation.transition.spent + completed;
  const count = parent.history.scheduled_episodes + completed, remaining = source.slots.length - spent;
  assert.ok(completed > 0 && completed < old.slots.length && remaining > 0, 'OBSERVER_CONTINUATION_UNSTARTED_SUFFIX_REQUIRED');
  assert.equal(count, approval.accepted_history_reservations);
  assert.deepEqual(declaredSchedule(old.protocol), source.slots);
  assert.deepEqual(old.slots, source.slots.slice(spent - completed).map((slot, order) => ({ ...slot, order })));
  assert.deepEqual(partial.planReference, approval.retained_stop.source_plan); assert.deepEqual(partial.ledger.reference, approval.retained_stop.source_ledger);
  assert.equal(partial.ledger.rows.at(-1).reason, 'subject_requested_stop');
  const terminal = partial.completed.at(-1);
  assert.equal(terminal.run_id, approval.retained_stop.run_id); assert.equal(terminal.result.status, 'invalid'); assert.equal(terminal.result.stop_batch, true);
  const stop = await assertRetainedObserverStop(old, terminal, parent.environment_root, accepted.repair);
  assert.deepEqual(sorted(planFiles), sorted([...parent.history.plans.map(item => item.plan.path), partial.planReference.path]), 'OBSERVER_CONTINUATION_PLAN_SET_CHANGED');
  const history = await readCampaignHistory({ planFiles, pilotLedgerRoot, ...(expected ? { expected } : {}),
    assertPlan: async plan => {
      assert.equal(plan.plan_sha256, fingerprint({ ...plan, plan_sha256: null })); assert.equal(validateProtocol(plan.protocol, { stage: 'execute' }).valid, true);
      const path = join(plan.execution.control_root, 'plan.json');
      if (path === partial.planReference.path) await verifyAuthorizedHistoryPlan(plan, partial.amendment, authorized, parentReference);
      else {
        const entry = parent.history.plans.find(item => item.plan.path === path); assert.ok(entry); assert.deepEqual((await file(path)).reference, entry.plan);
        if (plan.execution.campaign_scope) assertFiniteCampaignPlan(plan, await verified(plan.execution.campaign_scope.amendment));
      }
    },
    assertOriginalCompleted: async input => {
      if (input.ordinal <= parent.history.scheduled_episodes) return;
      assert.equal(input.hasRevision, false, 'OBSERVER_CONTINUATION_SOURCE_REINTERPRETED');
      if (input.ordinal === count) { assert.equal(input.plan.plan_sha256, old.plan_sha256); assert.deepEqual(input.event, terminal); }
      else await verifyFiniteOriginalResults(input.plan, [input.event]);
    },
    assertModelEvidence: (episode, model, plan) => {
      if (authorized.retainedProviderStop && episode.identity.run_id === authorized.retainedProviderStop.run_id)
        assertRetainedProviderStopEpisode(episode, model, plan, authorized.retainedProviderStop);
      else if (authorized.retainedAliasStop && episode.identity.run_id === authorized.retainedAliasStop.retained.run_id)
        assertRetainedAliasEpisode(episode, model, plan, authorized.retainedAliasStop.retained);
      else if (plan.protocol.policies.campaign || isProspectiveCohort(plan.protocol.policies.pilot.scope)) assertCohortModelEvidence(episode, model);
    } });
  assert.equal(history.scheduled_episodes, count);
  for (const key of ['episodes', 'reservations']) assert.deepEqual(history[key].slice(0, parent.history.scheduled_episodes), parent.history[key]);
  for (const owner of parent.history.plans) assert.deepEqual(history.plans.find(item => item.plan.path === owner.plan.path), owner);
  assert.deepEqual(history.unknown_usage_run_ids, parent.history.unknown_usage_run_ids, 'OBSERVER_CONTINUATION_NEW_UNKNOWN_USAGE');
  assert.deepEqual(partial.amendment.history, parent.history);
  for (const observed of history.episodes.slice(parent.history.scheduled_episodes, -1)) {
    assert.equal(observed.core_evidence, 'complete'); assert.equal(observed.stop_batch, false);
  }
  assert.equal(history.episodes.at(-1).admission, 'invalid'); assert.equal(history.episodes.at(-1).stop_batch, true);
  const selection = { source_plan_sha256: old.plan_sha256, slot_ids: old.slots.slice(completed).map(slot => slot.slot_id) };
  const transition = { source_allocation_id: partial.allocation.id, experiment_id: approval.continuation.experiment_id,
    original_limit: source.slots.length, source_limit: old.slots.length, source_spent: completed, spent, remaining,
    source_plan: partial.planReference, source_plan_sha256: old.plan_sha256,
    scientific_source_plan: authorized.confirmationContinuation.transition.scientific_source_plan,
    excluded_slot_ids: source.slots.slice(0, spent).map(slot => slot.slot_id), selection };
  assert.ok(!history.episodes.some(item => item.experiment_id === transition.experiment_id));
  const allocations = [{ ...partial.allocation, id: approval.continuation.allocation_id, reservation_limit: remaining }, ...structuredClone(parent.allocations.slice(1))];
  assert.equal(allocations.reduce((sum, item) => sum + item.reservation_limit, 0), approval.approved_remaining_reservations);
  if (currentBoundary) await boundary(pilotLedgerRoot, count, partial.registration.sequence);
  return { history, allocations, transition, source, repair: accepted.repair, engineeringDesigns: accepted.designs, decision: approval,
    modelWindow: structuredClone(parent.revision.model_window), retained: { ...stop, source_plan: partial.planReference,
      source_ledger: partial.ledger.reference, reservation: history.reservations.at(-1).reference,
      run_id: terminal.run_id, source_slot_id: terminal.slot_id, allocation_id: partial.allocation.id, ordinal: count } };
}

/** Before any setup side effect, keep every declared engineering science field.
 * Only previously unbound execution locators and the proved observer builds move. */
export async function assertObserverRepairSetup(setup, authorized) {
  assert.equal(authorized.value.version, 6); const continuation = authorized.confirmationContinuation;
  assert.equal(setup.environment_root, authorized.value.environment_root);
  if (setup.campaign_scope.role === CONFIRMATION_CONTINUATION) return;
  assert.equal(setup.campaign_scope.role, 'acceptance');
  const matches = continuation.engineeringDesigns.entries.filter(item => item.allocation_id === setup.campaign_scope.allocation_id);
  assert.equal(matches.length, 1, 'OBSERVER_CONTINUATION_ENGINEERING_DESIGN_REQUIRED');
  const reference = clean(matches[0].setup), original = await verified(reference), current = structuredClone(setup);
  assert.equal(current.id, original.id, 'OBSERVER_CONTINUATION_ENGINEERING_ID_CHANGED');
  assert.equal(current.budget.batch.max_episodes, matches[0].reservations);
  assert.ok(current.control_root.startsWith(current.environment_root + '/control/'));
  current.control_root = original.control_root;
  assert.deepEqual(current.models.window, { start: authorized.value.revision.model_window.start, end: authorized.value.revision.model_window.end });
  current.models.window = original.models.window;
  // The actual resolved model definition is checked in assertObserverRepairModels.
  assert.ok(isAbsolute(current.models.source_file)); current.models.source_file = original.models.source_file;
  for (const [index, candidate] of current.candidates.entries()) {
    const before = original.candidates[index]; assert.ok(before);
    resolveRepairBuild(continuation.repair, before.build_id, candidate.build_id); candidate.build_id = before.build_id;
    if (before.notion_entry === undefined && candidate.notion_entry !== undefined) {
      assert.equal(candidate.mode, 'broker'); assert.match(candidate.notion_entry, /^[a-f0-9-]{36}$/i);
      assert.ok(isAbsolute(current.materialization_binding_file)); delete candidate.notion_entry;
    }
  }
  if (original.materialization_binding_file == null) {
    assert.ok(current.materialization_binding_file == null || isAbsolute(current.materialization_binding_file));
    if (Object.hasOwn(original, 'materialization_binding_file')) current.materialization_binding_file = original.materialization_binding_file;
    else delete current.materialization_binding_file;
  }
  for (const key of ['authorization', 'predecessor', 'history_plan_files', 'prospective_authorization'])
    current.campaign_scope[key] = structuredClone(original.campaign_scope[key]);
  // proposal is explanatory preparation metadata, never consumed by configure.
  delete current.proposal; const expected = structuredClone(original); delete expected.proposal;
  assert.deepEqual(current, expected, 'OBSERVER_CONTINUATION_ENGINEERING_SCIENCE_CHANGED');
  return { source_setup: reference, source_schedule: clean(matches[0].schedule) };
}

/** Re-derive the cases from the original corpus and selections, not current case claims. */
export async function assertObserverRepairEngineeringCases({ setup, sourceSetup, corpus, cases }) {
  const frozen = await readCorpusSnapshot(sourceSetup)
    ?? (await verified(clean(sourceSetup.proposal.materialization_recipe))).corpus;
  validateCorpus(frozen); assert.deepEqual(corpus, frozen.publicCorpus, 'OBSERVER_CONTINUATION_ENGINEERING_CORPUS_CHANGED');
  assert.equal(cases.length, sourceSetup.corpus.selections.length);
  let derived = [];
  for (const [index, selection] of sourceSetup.corpus.selections.entries()) {
    const selected = planCaseVariant({ ...frozen, ...selection }), actual = cases[index];
    const inputs = await inventoryPublicInputs(actual.input_root);
    const expectedInputs = selected.publicCase.attachments.map(item => ({ path: item.path, sha256: item.sha256,
      bytes: item.bytes, executable: item.mode === '100755' }));
    const byPath = (a, b) => a.path.localeCompare(b.path);
    assert.deepEqual([...inputs].sort(byPath), expectedInputs.sort(byPath), 'OBSERVER_CONTINUATION_ENGINEERING_INPUTS_CHANGED');
    assert.equal(createHash('sha256').update(JSON.stringify(inputs)).digest('hex'), actual.input_inventory_sha256);
    assert.deepEqual(await verified({ path: actual.oracle_path, sha256: actual.oracle_sha256 }), selected.oracle,
      'OBSERVER_CONTINUATION_ENGINEERING_ORACLE_CHANGED');
    const expected = { ...actual, id: selected.variant.id, base_case_id: selected.publicCase.id, variant: selected.variant,
      public_case: selected.publicCase, events: selected.events, clarification: selected.clarification,
      protocol_case: protocolCaseForVariant(selected) };
    delete expected.identity_map; derived.push(expected);
  }
  if (setup.materialization_binding_file) {
    const materialization = JSON.parse((await file(setup.materialization_binding_file)).bytes);
    const bound = await bindMaterializedCases({ cases: derived.filter(item => !item.events.length), materialization });
    derived = derived.map(item => bound.find(other => other.id === item.id) ?? item);
  }
  for (const [index, expected] of derived.entries())
    for (const key of ['id', 'base_case_id', 'variant', 'public_case', 'events', 'clarification', 'protocol_case', 'identity_map'])
      assert.deepEqual(cases[index][key], expected[key], 'OBSERVER_CONTINUATION_ENGINEERING_CASE_CHANGED:' + key);
}

/** The frozen executable plan must still match the same bound setup and schedule. */
export async function assertObserverRepairEngineeringProtocol(protocol, execution, slots, amendment, authorized) {
  assertObserverRepairModels(protocol, authorized);
  const setup = JSON.parse((await file(join(execution.control_root, 'setup.json'))).bytes);
  const proof = await assertObserverRepairSetup(setup, authorized);
  assert.equal(setup.campaign_scope.id, amendment.id); assert.equal(setup.campaign_scope.allocation_id, amendment.prospective_authorization.allocation_id);
  assert.deepEqual(setup.campaign_scope.prospective_authorization, amendment.prospective_authorization.reference);
  assert.deepEqual(setup.campaign_scope.predecessor, amendment.predecessor);
  const scheduled = await verified(proof.source_schedule); assert.deepEqual(slots, scheduled.slots, 'OBSERVER_CONTINUATION_ENGINEERING_SCHEDULE_CHANGED');
  const cases = await verified({ path: execution.case_bindings_file, sha256: execution.case_bindings_sha256 });
  const corpus = JSON.parse((await file(join(execution.control_root, 'corpus-public/corpus.json'))).bytes);
  assert.equal(corpus.seed, setup.corpus.seed); assert.equal(corpus.split, setup.corpus.split); assert.equal(corpus.version, setup.corpus.material_version);
  await assertObserverRepairEngineeringCases({ setup, sourceSetup: await verified(proof.source_setup), corpus, cases });
  const expected = preregisterComparison({ id: setup.id, phase: setup.phase, purpose: setup.purpose,
    environments: protocol.environments, models: protocol.models, corpus, cases, repetitions: setup.repetitions ?? 1,
    budget: setup.budget, decision: setup.decision, analysis: setup.analysis,
    campaignScope: finiteCampaignPolicy(setup.campaign_scope, { scheduledEpisodes: slots.length }),
    environmentPairs: setup.environment_pairs, allowedChanges: setup.allowed_changes,
    orderingSeed: setup.ordering_seed, registeredAt: protocol.registered_at });
  assert.deepEqual(protocol, expected, 'OBSERVER_CONTINUATION_ENGINEERING_PROTOCOL_CHANGED');
  assert.deepEqual(execution.runtime, setup.runtime);
  for (const [index, candidate] of setup.candidates.entries()) {
    const environment = protocol.environments[index], condition = execution.conditions['m0-e' + index];
    assert.equal(environment.id, candidate.id); assert.equal(environment.build.id, candidate.build_id);
    assert.equal(environment.pi.mode, candidate.mode); assert.equal(environment.policies.code_mode, candidate.code_mode);
    assert.equal(condition.build_id, candidate.build_id); assert.equal(condition.mode, candidate.mode);
  }
}

export function assertObserverRepairModels(protocol, authorized) {
  assert.equal(authorized.value.version, 6);
  assertSameConfirmationModels(protocol, authorized.confirmationContinuation.source, authorized.value.revision.model_window);
  // Each subject build must be one of the independently checked repaired products.
  for (const environment of protocol.environments) {
    const pair = authorized.confirmationContinuation.repair.builds.find(item => item.target.id === environment.build.id);
    assert.ok(pair, 'OBSERVER_CONTINUATION_REPAIRED_BUILD_REQUIRED'); assert.deepEqual(environment.build, pair.target.identity);
  }
}

export async function assertObserverRepairContinuation(protocol, execution, slots, amendment, authorized) {
  assertObserverRepairModels(protocol, authorized);
  const continuation = authorized.confirmationContinuation;
  for (const environment of continuation.source.protocol.environments)
    resolveRepairBuild(continuation.repair, environment.build.id, protocol.environments.find(item => item.id === environment.id)?.build.id);
  await assertSameConfirmationDesign(protocol, execution, slots, amendment, continuation, authorized.value.revision.next_allocation_id,
    { observerRepair: continuation.repair });
  return [continuation.transition.scientific_source_plan, continuation.transition.source_plan];
}
