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

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

export async function loadExecution(plan) {
  validateBatchPlan(plan);
  const input = plan.execution;
  const bytes = await readFile(input.case_bindings_file);
  assert.equal(sha(bytes), input.case_bindings_sha256, 'Frozen case bindings changed');
  assert.equal(sha(await readFile(input.models_file)), input.models_sha256, 'Selected model registry changed');
  const bindings = JSON.parse(bytes);
  const slotBindings = await readEpisodeFixtureBindings({ id: plan.id, registration: input.episode_fixtures,
    environmentRoot: input.environment_root, controlRoot: input.control_root, cases: bindings, slots: plan.slots,
    candidates: input.conditions, runtime: input.runtime });
  for (const slot of plan.slots) if (slotBindings.has(slot.slot_id))
    assert.ok(input.conditions[slot.condition_id]?.expectations?.[slot.slot_id], 'Writable slots require their own frozen startup expectation');
  return { input, bindings, slotBindings };
}

async function collect(raw, plan, slot, condition, model, binding, outputDirectory, reanalysisOf) {
  const required = (binding.public_case?.turns?.length ?? 0) > 1 || (binding.events?.length ?? 0) > 0 || (binding.clarification?.length ?? 0) > 0;
  raw.turn_control_verification = await readSubjectTurnControl({ controlRoot: plan.execution.control_root,
    runRoot: raw.root, runId: raw.run_id, required });
  if (!raw.turn_control) raw.turn_control = raw.turn_control_verification.result;
  const { collectEpisode } = await import('./collect.mjs');
  return collectEpisode({ raw, binding, protocol: plan.protocol, slot, condition,
    model: { ...model, adapter_evidence_path: plan.execution.adapter_evidence_file }, outputDirectory,
    environmentRoot: plan.execution.environment_root, ...(reanalysisOf ? { reanalysisOf } : {}) });
}

/** Preserve metering and business evidence while making every controller stop authoritative. */
export function completedEpisodeRecord(raw, collected) {
  const verification = raw.turn_control_verification;
  const controlIncomplete = verification?.required && (verification.status !== 'verified' || verification.result?.status !== 'completed');
  const controlStopped = raw.turn_control && raw.turn_control.status !== 'completed';
  const sharedIncomplete = raw.shared?.runtime_check?.status !== 'unchanged' || raw.shared?.frozen_artifacts !== 'passed';
  const stopped = Boolean(raw.stop_batch || raw.dispatch_error || controlIncomplete || controlStopped || sharedIncomplete || collected.stop_batch);
  const reason = raw.dispatch_error ? 'subject_dispatch_error'
    : controlIncomplete ? 'turn_control_unverified_or_stopped'
      : controlStopped ? (raw.turn_control.reason ?? 'turn_control_stopped')
        : sharedIncomplete ? 'subject_runtime_or_artifact_check_failed'
          : raw.stop_batch ? 'subject_requested_stop' : collected.stop_reason ?? null;
  return { status: raw.status, run_root: raw.root, normalized_directory: collected.stored.directory,
    episode_sha256: collected.bundle.episode.episode_sha256, budget_usage: collected.budget_usage,
    stop_batch: stopped, stop_reason: reason,
    ...(raw.dispatch_error ? { dispatch_error: raw.dispatch_error } : {}),
    ...(verification?.required ? { turn_control: { verification: verification.status,
      status: verification.result?.status ?? raw.turn_control?.status ?? 'unknown',
      reason: verification.reason ?? verification.result?.reason ?? null,
      receipt: verification.receipt ?? raw.turn_control?.receipt ?? null } } : {}) };
}

export function executionForSlot({ plan, bindings, slotBindings, slot }) {
  const condition = plan.protocol.conditions.find(value => value.id === slot.condition_id);
  const model = plan.protocol.models.find(value => value.id === condition?.model_id);
  const owned = slotBindings.get(slot.slot_id);
  const binding = owned?.binding ?? bindings.find(value => value.id === slot.case_id);
  const candidate = plan.execution.conditions[slot.condition_id];
  assert.ok(condition && model && binding && candidate);
  const expectation = candidate.expectations[owned ? slot.slot_id : slot.case_id];
  assert.ok(expectation, owned ? 'Writable slot has no frozen startup expectation' : 'Case has no frozen startup expectation');
  return { condition, model, binding, candidate, expectation };
}

export async function executeBatchPlan({ plan, maximumNewEpisodes = Infinity, analysisRevisionFile }) {
  const { input, bindings, slotBindings } = await loadExecution(plan);
  const status = await batchStatus(input.control_root);
  const analysisRevisionReference = analysisRevisionFile ? { path: analysisRevisionFile, sha256: sha(await readFile(analysisRevisionFile)) }
    : status.analysis_revision;
  let analysisRevision = null;
  if (analysisRevisionReference) {
    const { verifyAnalysisRevision } = await import('./revision.mjs');
    analysisRevision = await verifyAnalysisRevision({ reference: analysisRevisionReference, plan });
  }
  const implementation = analysisRevision?.implementation ?? input.implementation;
  await verifyExecutionImplementation(implementation);
  if (input.resumption) await verifyZeroSendRepair({ reference: input.resumption.repair, environmentRoot: input.environment_root });
  const argsFor = slot => executionForSlot({ plan, bindings, slotBindings, slot });
  async function storeResult(raw, slot, reanalysisOf) {
    const { condition, model, binding } = argsFor(slot);
    const output = join(raw.root, 'benchmark/normalized');
    const result = await collect(raw, plan, slot, condition, model, binding, output, reanalysisOf);
    return completedEpisodeRecord(raw, result);
  }
  return runBatch({ plan, maximumNewEpisodes, pilotLedgerRoot: input.pilot_ledger_root, analysisRevisionReference, analysisRevision,
    executeEpisode: async ({ slot, runId, budget }) => {
      await verifyExecutionImplementation(implementation);
      const { condition, model, binding, candidate, expectation } = argsFor(slot);
      const now = Date.now();
      assert.ok(now >= Date.parse(model.backend.window.start) && now <= Date.parse(model.backend.window.end), 'The declared model route window has expired');
      const raw = await runSubject({ environmentRoot: input.environment_root, buildId: candidate.build_id,
        mode: candidate.mode, binding, model: { ...model, baseUrl: input.model_base_url }, modelsFile: input.models_file,
        runtime: input.runtime, controlRoot: input.control_root, runId, conditionId: condition.id, budget: budget.episode,
        codeMode: condition.code_mode, expected: expectation, credential: input.credential,
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
  const episodes = [];
  const { bindings, slotBindings } = await loadExecution(plan);
  for (const finished of status.episodes) {
    if (!reanalysis) {
      const bundle = await readEvidenceBundle({ directory: finished.result.normalized_directory, rawRoot: plan.execution.environment_root });
      episodes.push(bundle.episode); continue;
    }
    const slot = plan.slots.find(slot => slot.slot_id === finished.slot_id);
    const condition = plan.protocol.conditions.find(c => c.id === slot.condition_id), model = plan.protocol.models.find(m => m.id === condition.model_id);
    const runRoot = finished.result.run_root, resultPath = join(runRoot, 'benchmark/runtime/episode-result.json');
    const raw = { root: runRoot, run_id: finished.run_id, result_path: resultPath, shared: await readJson(join(runRoot, 'result.json')), episode: await readJson(resultPath) };
    raw.status = raw.episode.status;
    const result = await collect(raw, plan, slot, condition, model, slotBindings.get(slot.slot_id)?.binding ?? bindings.find(b => b.id === slot.case_id),
      join(outputDirectory, 'reanalysis', finished.run_id), finished.result.episode_sha256);
    episodes.push(result.bundle.episode);
  }
  const input = { protocol: plan.protocol, episodes }, analysis = scoreExperiment(input);
  const report = await writeAnalysisReport({ directory: outputDirectory, analysis, input, includeRaw: true, rawRoot: plan.execution.environment_root });
  return { status: 'analyzed', kind: reanalysis ? 'raw-evidence-reanalysis' : 'normalized-evidence-analysis', model_requests: 0,
    episodes: episodes.length, analysis_sha256: analysis.analysis_sha256, report, completeness: analysis.completeness };
}
