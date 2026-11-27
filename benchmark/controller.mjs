import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { batchStatus, runBatch, validateBatchPlan } from './batch.mjs';
import { readSubjectTurnControl, runSubject } from './execute.mjs';
import { readEvidenceBundle } from './evidence/store.mjs';
import { scoreExperiment } from './analysis/compare.mjs';
import { writeAnalysisReport } from './analysis/report.mjs';
import { verifyExecutionImplementation } from './implementation.mjs';
import { verifyZeroSendRepair } from './resumption.mjs';
import { readEpisodeFixtureBindings } from './fixture-dispatch.mjs';
import { verifyCollectionRecovery, verifyCollectionRecoveryResults } from './collection-recovery.mjs';
import { modelWindowContains } from './model-window.mjs';
import { readConditionMaterialBindings, selectCaseBinding } from './condition-bindings.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

export function assertSubjectModelWindow(model, now = Date.now()) {
  assert.ok(modelWindowContains(model.backend.window, now), 'The declared model route window is not open');
}

export async function loadExecution(plan) {
  validateBatchPlan(plan);
  const input = plan.execution;
  const bytes = await readFile(input.case_bindings_file);
  assert.equal(sha(bytes), input.case_bindings_sha256, 'Frozen case bindings changed');
  assert.equal(sha(await readFile(input.models_file)), input.models_sha256, 'Selected model registry changed');
  const bindings = JSON.parse(bytes);
  const conditionBindings = await readConditionMaterialBindings({ execution: input, bindings });
  const slotBindings = await readEpisodeFixtureBindings({ id: plan.id, registration: input.episode_fixtures,
    environmentRoot: input.environment_root, controlRoot: input.control_root, cases: bindings, slots: plan.slots,
    candidates: input.conditions, runtime: input.runtime });
  for (const slot of plan.slots) if (slotBindings.has(slot.slot_id))
    assert.ok(input.conditions[slot.condition_id]?.expectations?.[slot.slot_id], 'Writable slots require their own frozen startup expectation');
  return { input, bindings, slotBindings, conditionBindings };
}

async function collect(raw, plan, slot, condition, model, binding, outputDirectory, reanalysisOf, adapterEvidencePath = plan.execution.adapter_evidence_file) {
  const required = (binding.public_case?.turns?.length ?? 0) > 1 || (binding.events?.length ?? 0) > 0 || (binding.clarification?.length ?? 0) > 0;
  raw.turn_control_verification = await readSubjectTurnControl({ controlRoot: plan.execution.control_root,
    runRoot: raw.root, runId: raw.run_id, required });
  if (!raw.turn_control) raw.turn_control = raw.turn_control_verification.result;
  const { collectEpisode } = await import('./collect.mjs');
  return collectEpisode({ raw, binding, protocol: plan.protocol, slot, condition,
    model: { ...model, adapter_evidence_path: adapterEvidencePath }, outputDirectory,
    environmentRoot: plan.execution.environment_root, ...(reanalysisOf ? { reanalysisOf } : {}) });
}

function localRequestLimitReached(raw, collected, episodeBudget) {
  const runtime = raw.episode, episode = collected.bundle?.episode, usage = collected.budget_usage;
  const cap = episodeBudget?.max_model_requests, state = runtime?.budget;
  const known = (value, expected) => value?.status === 'known' && value.value === expected;
  if (!Number.isSafeInteger(cap) || cap <= 0 || episodeBudget.max_retries !== 0
    || raw.status !== 'failed' || runtime?.status !== 'failed'
    || runtime.error?.code !== 'BENCHMARK_PROVIDER_TERMINAL_ERROR'
    || runtime.error.details?.assistant?.stop_reason !== 'error'
    || runtime.error.details?.assistant?.error !== 'BENCHMARK_REQUEST_LIMIT'
    || state?.stop?.code !== 'BENCHMARK_REQUEST_LIMIT' || state.usage_unknown !== false
    || state.requests !== cap || state.attempts !== cap
    || raw.shared?.spawned !== true || raw.shared.exit_code !== 1 || raw.shared.timed_out !== false
    || raw.shared.signal !== null && raw.shared.signal !== undefined
    || runtime.admission?.status !== 'accepted_before_task'
    || runtime.completion?.agent_settled !== true
    || !['abort_settled', 'shutdown_emitted', 'dispose_called'].every(key => runtime.completion.cleanup?.[key] === true)
    || collected.validity !== 'valid' || collected.stop_batch !== false || episode?.admission?.status !== 'valid'
    || !['attempts', 'tools', 'interventions'].every(key => runtime.coverage?.[key] === 'complete' && episode.admission.completeness?.[key] === 'complete')
    || !['model_requests', 'input_tokens', 'output_tokens', 'duration_ms'].every(key => Number.isFinite(usage?.[key]) && usage[key] >= 0)
    || usage.model_requests !== cap || state.input_tokens !== usage.input_tokens || state.output_tokens !== usage.output_tokens
    || state.tokens !== usage.input_tokens + usage.output_tokens || runtime.timing?.duration_ms !== usage.duration_ms
    || !known(episode.measurements?.actual_attempts, cap)
    || !known(episode.measurements?.input_total?.value, usage.input_tokens)
    || !known(episode.measurements?.output_total?.value, usage.output_tokens)
    || !known(episode.timing?.duration_ms, usage.duration_ms)) return false;
  for (const [used, limit] of [[cap, 'max_http_attempts'], [usage.input_tokens, 'max_input_tokens'],
    [usage.output_tokens, 'max_output_tokens'], [usage.duration_ms, 'max_duration_ms']])
    if (!Number.isFinite(episodeBudget[limit]) || used > episodeBudget[limit]) return false;
  if (!Array.isArray(runtime.requests) || runtime.requests.length !== cap
    || !Array.isArray(episode.attempts) || episode.attempts.length !== cap
    || new Set(runtime.requests.map(request => request.id)).size !== cap) return false;
  let input = 0, output = 0;
  for (const [index, request] of runtime.requests.entries()) {
    if (request.sequence !== index + 1 || request.accounted !== true || request.attempts?.length !== 1) return false;
    const attempt = request.attempts[0], normalized = episode.attempts[index], end = attempt.transport_end, observed = request.usage;
    if (attempt.sent !== true || attempt.status !== 200 || normalized.sent !== true || normalized.id !== attempt.id
      || normalized.request_id !== request.id || normalized.transport_id !== attempt.transport_id || normalized.adapter?.verified !== true
      || observed?.complete_for_token_budget !== true || !Number.isSafeInteger(observed.input) || observed.input < 0
      || !Number.isSafeInteger(observed.output) || observed.output < 0 || observed.total !== observed.input + observed.output
      || !known(normalized.full_input, observed.input) || !known(normalized.full_output, observed.output)
      || end?.category !== 'model' || end.status !== 200 || end.requestSent !== true) return false;
    // Keep the transport failure recorded. The existing observer may see SDK
    // cancellation after the one complete Completions SSE [DONE] boundary.
    if (end.outcome !== 'completed' && !(end.outcome === 'failure' && end.errorName === 'AbortError' && end.errorCode === 20
      && end.modelApi === 'openai-completions' && end.contentEncoding === 'identity' && end.contentType === 'text/event-stream'
      && end.sseCompletion?.method === 'bounded-sse-data-done-v1' && end.sseCompletion.doneEvents === 1)) return false;
    input += observed.input; output += observed.output;
  }
  return input === usage.input_tokens && output === usage.output_tokens;
}

/** Retain every business fact; only a proved local request cap is an episode stop. */
export function completedEpisodeRecord(raw, collected, { episodeBudget = null } = {}) {
  const verification = raw.turn_control_verification;
  const controlIncomplete = verification?.required && (verification.status !== 'verified' || verification.result?.status !== 'completed');
  const controlStopped = raw.turn_control && raw.turn_control.status !== 'completed';
  const sharedIncomplete = raw.shared?.runtime_check?.status !== 'unchanged' || raw.shared?.frozen_artifacts !== 'passed';
  const subjectStop = Boolean(raw.stop_batch) && !localRequestLimitReached(raw, collected, episodeBudget);
  const stopped = Boolean(subjectStop || raw.dispatch_error || controlIncomplete || controlStopped || sharedIncomplete || collected.stop_batch);
  const reason = raw.dispatch_error ? 'subject_dispatch_error'
    : controlIncomplete ? 'turn_control_unverified_or_stopped'
      : controlStopped ? (raw.turn_control.reason ?? 'turn_control_stopped')
        : sharedIncomplete ? 'subject_runtime_or_artifact_check_failed'
          : subjectStop ? 'subject_requested_stop' : collected.stop_reason ?? null;
  return { status: raw.status, run_root: raw.root, normalized_directory: collected.stored.directory,
    episode_sha256: collected.bundle.episode.episode_sha256, budget_usage: collected.budget_usage,
    stop_batch: stopped, stop_reason: reason,
    ...(raw.dispatch_error ? { dispatch_error: raw.dispatch_error } : {}),
    ...(verification?.required ? { turn_control: { verification: verification.status,
      status: verification.result?.status ?? raw.turn_control?.status ?? 'unknown',
      reason: verification.reason ?? verification.result?.reason ?? null,
      receipt: verification.receipt ?? raw.turn_control?.receipt ?? null } } : {}) };
}

export function executionForSlot({ plan, bindings, slotBindings, conditionBindings, slot }) {
  const condition = plan.protocol.conditions.find(value => value.id === slot.condition_id);
  const model = plan.protocol.models.find(value => value.id === condition?.model_id);
  const owned = slotBindings.get(slot.slot_id);
  const binding = selectCaseBinding({ execution: plan.execution, bindings, conditionBindings, slotBindings, slot });
  const candidate = plan.execution.conditions[slot.condition_id];
  assert.ok(condition && model && binding && candidate);
  const expectation = candidate.expectations[owned ? slot.slot_id : slot.case_id];
  assert.ok(expectation, owned ? 'Writable slot has no frozen startup expectation' : 'Case has no frozen startup expectation');
  return { condition, model, binding, candidate, expectation };
}

export async function executeBatchPlan({ plan, maximumNewEpisodes = Infinity, analysisRevisionFile, collectionRecoveryFile }) {
  const { input, bindings, slotBindings, conditionBindings } = await loadExecution(plan);
  const status = await batchStatus(input.control_root);
  const analysisRevisionReference = analysisRevisionFile ? { path: analysisRevisionFile, sha256: sha(await readFile(analysisRevisionFile)) }
    : status.analysis_revision;
  assert.ok(!collectionRecoveryFile || !analysisRevisionReference, 'Collection recovery and analysis revision cannot be combined');
  const collectionRecoveryReference = collectionRecoveryFile
    ? { path: collectionRecoveryFile, sha256: sha(await readFile(collectionRecoveryFile)) } : null;
  let collectionRecovery = collectionRecoveryReference
    ? await verifyCollectionRecovery({ reference: collectionRecoveryReference, plan }) : null;
  if (collectionRecovery?.closeout_only)
    assert.equal(maximumNewEpisodes, 0, 'Standing zero-send collection recovery requires --limit 0 and cannot continue dispatch');
  if (collectionRecovery?.repairs.some(item => !status.episodes.some(episode => episode.run_id === item.run_id)))
    assert.equal(maximumNewEpisodes, 0, 'Recover retained collection with --limit 0 before starting another slot');
  let analysisRevision = null;
  if (analysisRevisionReference) {
    const { verifyAnalysisRevision } = await import('./revision.mjs');
    analysisRevision = await verifyAnalysisRevision({ reference: analysisRevisionReference, plan });
  }
  const implementation = collectionRecovery?.implementation ?? analysisRevision?.implementation ?? input.implementation;
  await verifyExecutionImplementation(implementation);
  if (input.resumption) await verifyZeroSendRepair({ reference: input.resumption.repair, environmentRoot: input.environment_root });
  const argsFor = slot => executionForSlot({ plan, bindings, slotBindings, conditionBindings, slot });
  async function storeResult(raw, slot, reanalysisOf) {
    const { condition, model, binding } = argsFor(slot);
    if (collectionRecoveryReference) {
      await verifyExecutionImplementation(implementation);
      collectionRecovery = await verifyCollectionRecovery({ reference: collectionRecoveryReference, plan });
    }
    const projected = collectionRecovery?.projectedBindings.find(item => item.case_id === binding.id);
    assert.ok(!collectionRecovery || projected, 'Collection recovery has no frozen case projection');
    const output = collectionRecovery
      ? join(input.control_root, 'collection-repair-results', raw.run_id) : join(raw.root, 'benchmark/normalized');
    // Only postprocessing receives the path projection. Subject execution below
    // keeps the original frozen binding, input, materials and startup expectation.
    const result = await collect(raw, plan, slot, condition, model, projected?.binding ?? binding, output, reanalysisOf,
      collectionRecovery?.adapter_projection?.owned.path ?? input.adapter_evidence_file);
    const episodeBudget = plan.protocol.policies.budgets.find(budget => budget.id === condition.budget_id)?.episode ?? null;
    return { ...completedEpisodeRecord(raw, result, { episodeBudget }),
      ...(collectionRecoveryReference ? { collection_recovery: collectionRecoveryReference } : {}) };
  }
  return runBatch({ plan, maximumNewEpisodes, pilotLedgerRoot: input.pilot_ledger_root, analysisRevisionReference, analysisRevision, collectionRecoveryReference,
    executeEpisode: async ({ slot, runId, budget }) => {
      assert.ok(!collectionRecovery?.closeout_only, 'Standing zero-send collection recovery cannot execute a subject');
      await verifyExecutionImplementation(implementation);
      if (collectionRecoveryReference)
        collectionRecovery = await verifyCollectionRecovery({ reference: collectionRecoveryReference, plan });
      const { condition, model, binding, candidate, expectation } = argsFor(slot);
      assertSubjectModelWindow(model);
      const raw = await runSubject({ environmentRoot: input.environment_root, buildId: candidate.build_id,
        mode: candidate.mode, binding, model: { ...model, baseUrl: input.model_base_url }, modelsFile: input.models_file,
        runtime: input.runtime, controlRoot: input.control_root, runId, conditionId: condition.id, budget: budget.episode, budgetMode: budget.mode ?? 'bounded',
        codeMode: condition.code_mode, expected: expectation, credential: input.credential, resourceProfile: candidate.resource_profile,
        notionEntry: candidate.mode === 'broker' ? binding.notion_entry ?? candidate.notion_entry : undefined });
      return storeResult(raw, slot);
    },
    reconcileEpisode: async previous => {
      const root = join(input.environment_root, 'runs', previous.run_id);
      let shared, episode;
      try { shared = await readJson(join(root, 'result.json')); episode = await readJson(join(root, 'benchmark/runtime/episode-result.json')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      const raw = { version: 1, status: episode.status, run_id: previous.run_id, root, shared, episode,
        result_path: join(root, 'benchmark/runtime/episode-result.json') };
      return storeResult(raw, previous);
    } });
}

export async function analyzeBatch({ root, outputDirectory, reanalysis = false }) {
  assert.ok(isAbsolute(root) && isAbsolute(outputDirectory));
  const plan = validateBatchPlan(await readJson(join(root, 'plan.json'))), status = await batchStatus(root);
  const reportRelative = relative(plan.execution.environment_root, outputDirectory);
  assert.ok(reportRelative && !reportRelative.startsWith('..') && !isAbsolute(reportRelative), 'Reports must remain within the task-owned environment');
  const recovery = await verifyCollectionRecoveryResults(plan, status.episodes);
  const episodes = [];
  const { bindings, slotBindings, conditionBindings } = await loadExecution(plan);
  for (const finished of status.episodes) {
    if (!reanalysis) {
      const bundle = await readEvidenceBundle({ directory: finished.result.normalized_directory, rawRoot: plan.execution.environment_root });
      episodes.push(bundle.episode); continue;
    }
    const slot = plan.slots.find(slot => slot.slot_id === finished.slot_id);
    const { condition, model, binding: originalBinding } = executionForSlot({ plan, bindings, slotBindings, conditionBindings, slot });
    const runRoot = finished.result.run_root, resultPath = join(runRoot, 'benchmark/runtime/episode-result.json');
    const raw = { root: runRoot, run_id: finished.run_id, result_path: resultPath, shared: await readJson(join(runRoot, 'result.json')), episode: await readJson(resultPath) };
    raw.status = raw.episode.status;
    const collectionBinding = recovery?.projectedBindings.find(item => item.case_id === slot.case_id)?.binding ?? originalBinding;
    const result = await collect(raw, plan, slot, condition, model, collectionBinding,
      join(outputDirectory, 'reanalysis', finished.run_id), finished.result.episode_sha256,
      recovery?.adapter_projection?.owned.path ?? plan.execution.adapter_evidence_file);
    episodes.push(result.bundle.episode);
  }
  const input = { protocol: plan.protocol, episodes }, analysis = scoreExperiment(input);
  const report = await writeAnalysisReport({ directory: outputDirectory, analysis, input, includeRaw: true, rawRoot: plan.execution.environment_root });
  return { status: 'analyzed', kind: reanalysis ? 'raw-evidence-reanalysis' : 'normalized-evidence-analysis', model_requests: 0,
    episodes: episodes.length, analysis_sha256: analysis.analysis_sha256, report, completeness: analysis.completeness };
}
