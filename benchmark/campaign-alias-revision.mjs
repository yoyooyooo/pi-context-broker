import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fingerprint, validateProtocol } from './protocol.mjs';
import { readEvidenceBundle } from './evidence/store.mjs';
import { canonicalAutoGroupLabel } from './reported-model.mjs';

export const ALIAS_REVISION = 'retained-reported-model-alias-stop';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const usageKeys = ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms'];
const knownUsage = usage => usageKeys.every(key => Number.isFinite(usage?.[key]) && usage[key] >= 0);
const clean = ref => ({ path: ref.path, sha256: ref.sha256 });
async function file(path) {
  assert.ok(isAbsolute(path) && resolve(path) === path, 'ALIAS_REVISION_CANONICAL_PATH');
  const before = await lstat(path); assert.ok(before.isFile() && !before.isSymbolicLink());
  assert.equal(await realpath(path), path);
  const bytes = await readFile(path), after = await lstat(path);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(before[key], after[key]);
  return { reference: { path, sha256: sha(bytes) }, bytes };
}
async function verified(ref) {
  assert.match(ref?.sha256 ?? '', /^[a-f0-9]{64}$/);
  const value = await file(ref.path); assert.deepEqual(value.reference, clean(ref), 'ALIAS_REVISION_SOURCE_CHANGED');
  return JSON.parse(value.bytes);
}

/** Recognize this retained failure as a failure, never with its future allowlist. */
export function assertRetainedAliasEpisode(episode, model, plan, retained) {
  assert.equal(plan.plan_sha256, retained.source_plan_sha256, 'ALIAS_REVISION_PLAN_CHANGED');
  assert.equal(episode.identity.run_id, retained.run_id, 'ALIAS_REVISION_RUN_CHANGED');
  const slot = plan.slots[0], condition = plan.protocol.conditions.find(item => item.id === slot.condition_id);
  const environment = plan.protocol.environments.find(item => item.id === condition.environment_id);
  assert.equal(episode.identity.experiment_id, plan.id);
  assert.equal(episode.identity.case_id, slot.case_id); assert.equal(episode.identity.condition_id, slot.condition_id);
  assert.equal(episode.identity.model_id, model.id); assert.equal(condition.model_id, model.id);
  assert.equal(episode.identity.environment_sha256, environment.manifest_sha256);
  assert.equal(episode.identity.build_id, environment.build.id);
  assert.equal(episode.episode_sha256, retained.episode_sha256, 'ALIAS_REVISION_EPISODE_CHANGED');
  assert.equal(episode.admission.status, 'invalid');
  assert.deepEqual([...episode.admission.reasons].sort(), ['reported_model_mismatch', 'runtime_not_a_business_episode:invalid']);
  for (const key of ['attempts', 'tools', 'interventions']) assert.equal(episode.admission.completeness[key], 'complete');
  assert.deepEqual(episode.identity.model_routing, model.routing);
  for (const [key, value] of [['model_route', model.route], ['model_api', model.api], ['model_provider', model.provider]]) assert.equal(episode.identity[key], value);
  assert.equal(model.routing.mode, 'auto-route');
  assert.equal(retained.reported_model_id, canonicalAutoGroupLabel(model.routing.model_variant), 'ALIAS_REVISION_NONCANONICAL_GROUP');
  assert.ok(!model.routing.reported_model_ids.includes(retained.reported_model_id), 'ALIAS_REVISION_ALREADY_DECLARED');
  assert.equal(episode.attempts.length, 1); const attempt = episode.attempts[0];
  assert.equal(attempt.sent, true); assert.equal(attempt.adapter.verified, true);
  const reported = attempt.reported_model;
  assert.equal(reported.status, 'mismatch'); assert.equal(reported.reason, 'reported_model_mismatch');
  assert.equal(reported.provider_error, false); assert.equal(reported.label_kind, 'unrecognized_label');
  assert.deepEqual(reported.reported_ids, [retained.reported_model_id]);
  assert.ok(reported.observations.length > 0 && reported.observations.every(item => item.bound === true && item.value === retained.reported_model_id));
  assert.equal(episode.measurements.actual_attempts.status, 'known'); assert.equal(episode.measurements.actual_attempts.value, 1);
  for (const name of ['input_total', 'output_total']) assert.equal(episode.measurements[name].value.status, 'known');
  assert.equal(episode.timing.duration_ms.status, 'known');
  assert.deepEqual(retained.budget_usage, { model_requests: 1, input_tokens: episode.measurements.input_total.value.value,
    output_tokens: episode.measurements.output_total.value.value, duration_ms: episode.timing.duration_ms.value });
  assert.ok(knownUsage(retained.budget_usage), 'ALIAS_REVISION_UNKNOWN_USAGE');
}

/** A single metered alias stop, in the first route allocation after approval.
 * It remains invalid; the original eight-slot plan is never resumed. */
export async function readAliasRevisionStop({ parent, parentReference, predecessor, sourcePlan, metadata }) {
  assert.equal(parent.version, 1, 'ALIAS_REVISION_ORIGINAL_APPROVAL_ONLY');
  const source = await verified(sourcePlan);
  assert.equal(source.kind, 'benchmark-batch-plan'); assert.equal(source.version, 1);
  assert.equal(source.plan_sha256, fingerprint({ ...source, plan_sha256: null }));
  assert.equal(validateProtocol(source.protocol, { stage: 'execute' }).valid, true);
  assert.equal(source.id, source.protocol.id); assert.equal(source.slots.length, 8);
  const registration = source.execution.campaign_scope;
  assert.equal(registration?.kind, 'benchmark-finite-campaign'); assert.equal(registration.role, 'route_gate_only');
  assert.deepEqual(registration.amendment, predecessor.amendment);
  const amendment = await verified(registration.amendment), registered = await verified(predecessor.registration);
  assert.equal(amendment.version, 2); assert.equal(amendment.id, registration.id);
  assert.equal(amendment.amendment_sha256, fingerprint({ ...amendment, amendment_sha256: null }));
  assert.equal(amendment.reservation_limit, 8); assert.deepEqual(amendment.history, parent.history);
  assert.deepEqual(amendment.predecessor, parent.predecessor);
  assert.deepEqual(amendment.prospective_authorization.reference, clean(parentReference));
  assert.equal(amendment.prospective_authorization.allocation_id, amendment.id);
  assert.equal(registered.id, amendment.id); assert.equal(registered.kind, 'benchmark-finite-campaign-succession');
  assert.deepEqual(registered.amendment, registration.amendment);
  assert.deepEqual(registered.predecessor, parent.predecessor.registration);
  const priorRegistration = await verified(parent.predecessor.registration);
  assert.equal(registered.sequence, (priorRegistration.sequence ?? 1) + 1);
  assert.equal(predecessor.registration.path, join(parent.pilot_ledger_root, 'scope-registration-' + String(registered.sequence).padStart(3, '0') + '.json'));
  assert.equal(source.execution.environment_root, parent.environment_root); assert.equal(source.execution.pilot_ledger_root, parent.pilot_ledger_root);
  assert.equal(sourcePlan.path, join(source.execution.control_root, 'plan.json'));
  const { campaign_scope: ignored, ...execution } = source.execution;
  assert.equal(amendment.plan.execution_sha256, fingerprint(execution));
  assert.equal(amendment.plan.protocol_sha256, source.protocol.protocol_sha256);
  assert.deepEqual(amendment.plan.slots, source.slots);
  const allocation = parent.allocations.find(item => item.id === amendment.id);
  assert.ok(allocation && allocation.role === 'route_gate_only' && allocation.reservation_limit === 8, 'ALIAS_REVISION_ROUTE_ALLOCATION');
  const ledgerFile = await file(join(source.execution.control_root, 'ledger.jsonl'));
  assert.equal(ledgerFile.bytes.at(-1), 10);
  const rows = ledgerFile.bytes.toString().trimEnd().split('\n').map((line, i) => { const row = JSON.parse(line); assert.equal(row.seq, i + 1); return row; });
  assert.equal(rows.at(-1)?.type, 'batch_closed', 'ALIAS_REVISION_OPEN_SOURCE');
  assert.ok(!rows.some(row => ['analysis_revision_applied', 'collection_recovery_applied'].includes(row.type)), 'ALIAS_REVISION_SOURCE_REINTERPRETED');
  const starts = rows.filter(row => row.type === 'episode_started'), completed = rows.filter(row => row.type === 'episode_completed');
  assert.equal(starts.length, 1); assert.equal(completed.length, 1, 'ALIAS_REVISION_SINGLE_FAILURE_ONLY');
  const first = source.slots[0], event = completed[0], runId = source.id + '-001';
  for (const row of [starts[0], event]) { assert.equal(row.slot_id, first.slot_id); assert.equal(row.run_id, runId); }
  assert.equal(event.result.stop_batch, true); assert.equal(event.result.status, 'invalid');
  assert.ok(knownUsage(event.result.budget_usage), 'ALIAS_REVISION_UNKNOWN_USAGE');
  assert.equal(event.result.budget_usage.model_requests, 1, 'ALIAS_REVISION_SINGLE_REQUEST_ONLY');
  const ordinal = parent.history.scheduled_episodes + 1;
  const reservationFile = await file(join(parent.pilot_ledger_root, String(ordinal).padStart(3, '0') + '.json'));
  const reservation = JSON.parse(reservationFile.bytes);
  assert.equal(reservation.run_id, runId); assert.equal(reservation.experiment_id, source.id); assert.equal(reservation.slot_id, first.slot_id);
  assert.equal(reservation.scope_id, amendment.id); assert.equal(reservation.scope_role, 'route_gate_only');
  assert.equal(reservation.scope_kind, 'benchmark-finite-campaign'); assert.equal(reservation.scope_amendment_sha256, amendment.amendment_sha256);
  assert.equal(reservation.plan_sha256, source.plan_sha256); assert.deepEqual(reservation.plan, clean(sourcePlan));
  const model = source.protocol.models[0]; assert.equal(source.protocol.models.length, 1);
  const route = await verified(metadata);
  assert.equal(route.exit_code, 0); assert.equal(route.command.length, 3);
  assert.deepEqual(route.command.slice(0, 2), ['magpie', 'group']);
  assert.match(route.command[2], /^auto-[a-z0-9][a-z0-9-]*$/);
  assert.ok(route.stdout.split('\n')[0].trim().split(/\s+/).includes(model.route), 'ALIAS_REVISION_GROUP_ROUTE_CHANGED');
  const reportedId = 'group/' + route.command[2];
  const { episode } = await readEvidenceBundle({ directory: event.result.normalized_directory, rawRoot: parent.environment_root });
  const retained = { kind: ALIAS_REVISION, source_plan: clean(sourcePlan), source_plan_sha256: source.plan_sha256,
    source_ledger: ledgerFile.reference, reservation: reservationFile.reference,
    episode: (await file(join(event.result.normalized_directory, 'episode.json'))).reference,
    episode_sha256: event.result.episode_sha256, run_id: runId, ordinal, source_slot_id: first.slot_id,
    allocation_id: allocation.id, metadata: clean(metadata), reported_model_id: reportedId,
    budget_usage: structuredClone(event.result.budget_usage) };
  assertRetainedAliasEpisode(episode, model, source, retained);
  const runtimeArtifact = episode.artifacts.find(item => item.id === 'collection-runtime-result');
  assert.ok(runtimeArtifact, 'ALIAS_REVISION_RUNTIME_RESULT_REQUIRED');
  const runtime = await verified(runtimeArtifact);
  assert.equal(runtime.status, 'invalid'); assert.equal(runtime.error?.code, 'BENCHMARK_REPORTED_MODEL_MISMATCH');
  assert.equal(runtime.error.details?.reported_model?.provider_error, false);
  assert.deepEqual(runtime.error.details.reported_model.reported_ids, [reportedId]);
  assert.equal(runtime.budget.usage_unknown, false); assert.equal(runtime.budget.requests, 1); assert.equal(runtime.budget.attempts, 1);
  assert.equal(runtime.budget.input_tokens, retained.budget_usage.input_tokens); assert.equal(runtime.budget.output_tokens, retained.budget_usage.output_tokens);
  retained.runtime_result = clean(runtimeArtifact);
  return { retained, source, episode, event, allocation };
}
