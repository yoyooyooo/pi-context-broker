import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fingerprint } from './protocol.mjs';
import { ENGINEERING_WINDOW_REVISION, ENGINEERING_WINDOW_SCIENCE, assertEngineeringWindowCurrentBoundary,
  engineeringRemainingBudget, readEngineeringControllerComposition } from './campaign-engineering-window-continuation.mjs';

export const ENGINEERING_PREFLIGHT_REPAIR_REVISION = 'accepted-engineering-preflight-repair';
export const ENGINEERING_PREFLIGHT_REPAIR_DRAFT = 'engineering-preflight-repair-proposal-not-executable';
export const ENGINEERING_PREFLIGHT_REPAIR_OWNER = Object.freeze({
  allocation_id: 'engineering-codemode-window-17-2', experiment_id: 'benchmark-codemode-window-17-2' });
const oldOwner = Object.freeze({ allocation_id: 'engineering-codemode-window-17-1', experiment_id: 'benchmark-codemode-window-17-1' });
const stopPolicy = Object.freeze({ core: 'stop', usage_unknown: 'stop', retry: false, renew_window: false });
const zeroBudget = Object.freeze({ requests: 0, attempts: 0, tools: 0, input_tokens: 0,
  output_tokens: 0, tokens: 0, usage_unknown: false, stop: null });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clean = ref => ({ path: ref.path, sha256: ref.sha256 });
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'ENGINEERING_PREFLIGHT_REPAIR_SHAPE');
const inside = (root, path) => isAbsolute(path) && resolve(path) === path && path.startsWith(root + '/');
async function bytes(reference) {
  assert.ok(reference && /^[a-f0-9]{64}$/.test(reference.sha256), 'ENGINEERING_PREFLIGHT_REPAIR_REFERENCE_REQUIRED');
  keys(reference, reference.bytes === undefined ? ['path', 'sha256'] : ['path', 'sha256', 'bytes']);
  assert.ok(isAbsolute(reference.path) && resolve(reference.path) === reference.path);
  assert.equal(await realpath(reference.path), reference.path, 'ENGINEERING_PREFLIGHT_REPAIR_SYMLINK');
  const before = await lstat(reference.path); assert.ok(before.isFile() && !before.isSymbolicLink());
  const value = await readFile(reference.path), after = await lstat(reference.path);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(before[key], after[key]);
  assert.equal(sha(value), reference.sha256, 'ENGINEERING_PREFLIGHT_REPAIR_REFERENCED_BYTES_CHANGED');
  if (reference.bytes !== undefined) assert.equal(value.length, reference.bytes);
  return value;
}
const verified = async reference => JSON.parse(await bytes(reference));
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.fail('ENGINEERING_PREFLIGHT_REPAIR_OCCUPIED_PATH:' + path);
}
function lines(value) {
  assert.ok(value.length > 0 && value.at(-1) === 10, 'ENGINEERING_PREFLIGHT_REPAIR_INCOMPLETE_JOURNAL');
  return value.toString().split('\n').filter(Boolean).map(JSON.parse);
}

/** Only this unactivated parent-v7 owner can be replaced. This pure projection
 * is also used by offline fixtures; the authority entry points verify parent
 * bytes and its complete original104 history before calling it. */
export function deriveEngineeringPreflightRepair(parent) {
  const value = parent.value, c = parent.engineeringContinuation;
  assert.equal(value.version, 7, 'ENGINEERING_PREFLIGHT_REPAIR_PARENT_V7_ONLY');
  assert.equal(value.revision.kind, ENGINEERING_WINDOW_REVISION);
  assert.equal(value.history.scheduled_episodes, 104); assert.equal(value.history.unknown_usage_run_ids.length, 6);
  assert.deepEqual([value.new_reservation_ceiling, value.total_reservation_ceiling, value.max_scheduled_episodes], [35, 139, 144]);
  assert.deepEqual(value.allocations.map(a => [a.work_index, a.role, a.reservation_limit]), [
    [4, 'engineering_window_continuation', 17], ...Array.from({ length: 5 }, () => [5, 'acceptance', 2]), [6, 'acceptance', 8],
  ]);
  assert.equal(value.allocations[0].id, oldOwner.allocation_id);
  assert.equal(c.transition.allocation_id, oldOwner.allocation_id); assert.equal(c.transition.experiment_id, oldOwner.experiment_id);
  assert.equal(c.transition.source_limit, 24); assert.equal(c.transition.source_spent, 7); assert.equal(c.transition.remaining, 17);
  assert.deepEqual(c.transition, value.revision.partial_allocation); assert.deepEqual(c.allocations, value.allocations);
  assert.equal(c.source.slots.length, 24);
  assert.deepEqual(c.transition.selection, { source_plan_sha256: c.source.plan_sha256, slot_ids: c.source.slots.slice(7).map(s => s.slot_id) });
  assert.deepEqual(c.science, ENGINEERING_WINDOW_SCIENCE); assert.deepEqual(c.modelWindow, value.revision.model_window);
  assert.equal(Date.parse(c.modelWindow.end) - Date.parse(c.modelWindow.start), 86400000);
  assert.deepEqual(c.remainingBudget, c.resourceCarryover.remaining_budget);
  assert.deepEqual(c.resourceCarryover, value.revision.resource_carryover);
  assert.deepEqual(c.resourceCarryover, engineeringRemainingBudget(c.source.protocol.policies.budgets[0], c.scopes[1].completed));
  assert.equal(c.remainingBudget.batch.max_episodes, 17);
  const transition = { ...structuredClone(c.transition), ...ENGINEERING_PREFLIGHT_REPAIR_OWNER };
  const allocations = structuredClone(value.allocations); allocations[0].id = transition.allocation_id;
  assert.ok(!value.allocations.some(a => a.id === transition.allocation_id));
  assert.ok(!value.history.episodes.some(e => e.experiment_id === transition.experiment_id));
  return { transition, allocations };
}

/** Recheck the actual native terminal and transport, not a report's zero count.
 * A serialized model payload is not a send; the blocked admission and complete
 * zero-attempt transport must agree with the runtime result. */
export function assertEngineeringNativeZeroSend({ runId, capture, episode, child, process, events, transport }) {
  assert.equal(capture.status, 'captured'); assert.equal(capture.dispatch_error, null); assert.equal(capture.stop_batch, false);
  assert.deepEqual(capture.shared, child); assert.deepEqual(capture.episode, episode);
  assert.equal(child.status, 'passed'); assert.equal(child.exit_code, 0); assert.equal(child.spawned, true);
  assert.equal(child.timed_out, false); assert.equal(child.signal, null); assert.equal(child.runtime_check.status, 'unchanged');
  assert.ok(Number.isSafeInteger(process.pid) && process.pid > 0); assert.equal(process.pid, process.process_group);
  assert.equal(episode.status, 'captured'); assert.equal(episode.admission.status, 'captured_not_authorized');
  assert.deepEqual(episode.budget, zeroBudget);
  assert.deepEqual(episode.coverage, { attempts: 'complete', tools: 'complete', interventions: 'complete',
    notion_sdk: 'complete', notion_owned_http: 'complete' });
  assert.equal(episode.requests.length, 1); assert.deepEqual(episode.requests[0].attempts, []); assert.equal(episode.requests[0].accounted, false);
  assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1));
  assert.ok(events.every(e => e.run_id === runId)); assert.equal(events[0].type, 'runtime_start');
  assert.equal(events[0].data.pid, process.pid);
  const blocked = events.filter(e => e.type === 'provider_send_blocked'), reconciled = events.filter(e => e.type === 'transport_reconciliation');
  assert.equal(blocked.length, 1); assert.equal(blocked[0].data.error.code, 'BENCHMARK_ADMISSION_CAPTURE_COMPLETE');
  assert.equal(reconciled.length, 1); const reconciliation = reconciled[0].data;
  assert.equal(reconciliation.model_http_requests, 0); assert.equal(reconciliation.guarded_fetch_attempts, 0); assert.equal(reconciliation.complete, true);
  const terminal = events.at(-1); assert.equal(terminal.type, 'runtime_end'); assert.equal(terminal.data.status, 'captured');
  assert.deepEqual(terminal.data.budget, zeroBudget); assert.deepEqual(terminal.data.coverage, episode.coverage);
  assert.deepEqual(terminal.data.cleanup, { abort_settled: true, shutdown_emitted: true, dispose_called: true });
  assert.deepEqual(transport, reconciliation.transport_validation);
  assert.deepEqual(transport.map(e => e.phase), ['transport_start', 'model_selected', 'session_shutdown', 'transport_end']);
  assert.deepEqual(transport.map(e => e.sequence), [1, 2, 3, 4]);
  assert.deepEqual(transport.map(e => e.previousSha256), [null, ...transport.slice(0, -1).map(e => e.eventSha256)]);
  const end = transport.at(-1); assert.equal(end.complete, true); assert.equal(end.attempts, 0); assert.equal(end.errors, 0);
  assert.equal(end.pendingForkRebind, false); assert.deepEqual(end.incompleteRequestIds, []);
}

async function recorded(reference, exitCode) {
  const value = await verified(reference); assert.equal(value.exit_code, exitCode);
  assert.equal(reference.path, join(value.evidence, 'result.json'));
  assert.deepEqual(value.files.map(f => basename(f.path)), ['stdout.log', 'stderr.log', 'started.json']);
  for (const ref of value.files) { assert.equal(dirname(ref.path), value.evidence); await bytes(ref); }
  return { value, started: await verified(value.files[2]), stdout: await bytes(value.files[0]) };
}

/** This evidence type describes exactly the failed first v7 configure. It is
 * not a generic retry certificate. Historical reads retain the failure and all
 * old paths, while current-boundary checks belong only to preparation. */
export async function readEngineeringPreflightZeroSend({ parent, parentReference, proofReference, reviewRecordReference }) {
  const report = await verified(proofReference), root = parent.value.environment_root;
  assert.ok(inside(root + '/control', proofReference.path) && inside(root + '/control', reviewRecordReference.path));
  assert.equal(report.version, 1); assert.equal(report.kind, 'independent-stopped-engineering-invocation-review');
  assert.equal(report.status, 'passed'); assert.deepEqual(report.findings, []);
  assert.deepEqual(clean(report.authority), clean(parentReference));
  assert.deepEqual([report.configure_calls, report.capture_attempts_retained, report.capture_design_total, report.captures_completed], [1, 3, 4, 1]);
  for (const key of ['subject_runner_calls', 'normal_analysis_calls', 'new_reservations', 'new_registrations', 'new_closed_observations',
    'independently_established_subject_model_sends']) assert.equal(report[key], 0);
  assert.equal(report.zero_send_inferred_from_reservation_count, false);
  assert.equal(report.claim_retained, true); assert.equal(report.later_captures_not_retried, true);
  assert.equal(report.retry_resume_or_window_renewal_performed, false); assert.equal(report.successor_dispatch_allowed_by_this_review, false);
  assert.ok(Array.isArray(report.checked_references) && report.checked_references.length > 0);
  for (const ref of report.checked_references) await bytes(ref);
  await bytes(report.review_program); await bytes(report.helper_program);
  const review = await recorded(reviewRecordReference, 0);
  assert.ok(review.started.command.includes(report.review_program.path), 'ENGINEERING_PREFLIGHT_REPAIR_INDEPENDENT_REVIEW_REQUIRED');
  assert.ok(!inside(dirname(report.claim.path), report.review_program.path), 'ENGINEERING_PREFLIGHT_REPAIR_SEPARATE_REVIEW_REQUIRED');
  const reviewOutput = JSON.parse(review.stdout);
  assert.equal(reviewOutput.status, 'passed'); assert.deepEqual(clean(reviewOutput.review), clean(proofReference), 'ENGINEERING_PREFLIGHT_REPAIR_REVIEW_RECEIPT_UNBOUND');
  assert.equal(reviewOutput.execution_status, 'stopped'); assert.equal(reviewOutput.subject_model_sends, 0);
  assert.equal(reviewOutput.owned_processes_remaining, 0); assert.equal(reviewOutput.publication_ready, false);
  const claim = await verified(report.claim), receipt = await verified(report.receipt), binding = await verified(report.binding);
  assert.equal(claim.kind, 'engineering-seven-scope-exclusive-claim');
  assert.equal(claim.automatic_retry, false); assert.equal(claim.automatic_resume, false);
  assert.equal(report.receipt.path, join(claim.out, 'receipt.json'));
  assert.equal(report.claim.path, join(dirname(claim.out), 'execution-claim.json'));
  assert.deepEqual(clean(claim.binding), clean(report.binding)); assert.deepEqual(clean(receipt.binding), clean(report.binding));
  assert.deepEqual(clean(binding.authority), clean(parentReference)); assert.deepEqual(binding.model_window,
    { start: parent.engineeringContinuation.modelWindow.start, end: parent.engineeringContinuation.modelWindow.end });
  await bytes(claim.source); assert.deepEqual(clean(receipt.source), clean(claim.source));
  assert.equal(receipt.kind, 'engineering-seven-scope-sequence'); assert.equal(receipt.status, 'stopped'); assert.equal(receipt.reason, 'operation_failed');
  assert.equal(receipt.automatic_retry, false); assert.equal(receipt.automatic_resume, false);
  assert.equal(receipt.actual_new_reservations, 0); assert.equal(receipt.closed_new_observations, 0); assert.equal(receipt.publication_ready, false);
  assert.equal(receipt.boundary.physical, 104); assert.equal(receipt.boundary.registrations, 13); assert.equal(receipt.boundary.no_active_leases, true);
  assert.deepEqual(clean(receipt.boundary.registration), parent.value.predecessor.registration);
  assert.equal(receipt.scopes.length, 1); const scope = receipt.scopes[0];
  assert.equal(scope.scope_id, oldOwner.allocation_id); assert.equal(scope.dispatch_limit, 17); assert.equal(scope.scientific_denominator, 24);
  assert.equal(scope.runner, null); assert.equal(scope.analysis, null);
  assert.equal(scope.observation.registered, false); assert.equal(scope.observation.completed, 0); assert.equal(scope.observation.unresolved, false);
  assert.equal(scope.observation.ledger, null); assert.deepEqual(scope.observation.blocked_run_ids, []);
  assert.equal(receipt.commands.length, 1); assert.equal(receipt.commands[0].stage, oldOwner.allocation_id + '-configure');
  assert.deepEqual(clean(receipt.commands[0].receipt), clean(report.configure_record));
  const command = await recorded(report.configure_record, 1), outer = await recorded(report.outer_record, 1);
  assert.ok(command.started.command.includes('configure') && !command.started.command.includes('run'));
  assert.ok(outer.started.command.includes('run') && outer.started.command.includes(claim.out));
  const state = await verified(report.state), journal = lines(await bytes(report.journal));
  assert.equal(state.active, null); assert.equal(state.completed_commands, 1); assert.deepEqual(state.last_event, journal.at(-1));
  assert.deepEqual(journal.map(e => e.seq), journal.map((_, i) => i + 1));
  assert.deepEqual(journal.map(e => e.type), ['sequence_started', 'command_starting', 'recorder_started', 'child_started',
    'command_retained', 'scope_checkpoint', 'scope_checkpoint', 'sequence_retained']);
  assert.deepEqual(journal[1].command, command.started.command);
  const controlRoot = scope.setup.control_root;
  assert.equal(controlRoot, join(claim.out, 'scopes', oldOwner.allocation_id));
  for (const name of ['plan.json', 'ledger.jsonl', 'configuration-proof.json', 'runner-claim.json']) await absent(join(controlRoot, name));
  const ids = [0, 1, 2].map(n => oldOwner.experiment_id + '-capture-m0-e' + n + '-c0');
  assert.deepEqual(report.captures.map(c => c.run_id), ids);
  assert.deepEqual((await readdir(controlRoot)).filter(n => /\.(capture|launch)\.json$/.test(n)).sort(), ids.flatMap(id => [id + '.capture.json', id + '.launch.json']).sort());
  assert.deepEqual((await readdir(join(root, 'runs'))).filter(n => n.startsWith(oldOwner.experiment_id + '-')).sort(), ids.slice().sort());
  for (const [index, item] of report.captures.entries()) {
    const runId = ids[index], runRoot = join(root, 'runs', runId);
    assert.equal(item.launch.path, join(controlRoot, runId + '.launch.json')); assert.equal(item.capture.path, join(controlRoot, runId + '.capture.json'));
    const launch = await verified(item.launch), capture = await verified(item.capture);
    assert.equal(launch.run_id, runId); assert.equal(capture.run_id, runId); assert.equal(capture.root, runRoot);
    assert.deepEqual(launch.runtime_config.admission, { captureOnly: true });
    assert.equal(launch.runtime_config.mode, index === 1 ? 'native' : 'broker');
    assert.equal(item.subject_model_sends, 0); assert.equal(item.original_labels_modified, false);
    assert.equal(await realpath(runRoot), runRoot); assert.ok((await lstat(runRoot)).isDirectory());
    if (index !== 1) {
      assert.equal(capture.status, 'invalid'); assert.equal(capture.shared, null); assert.equal(capture.episode, null);
      assert.equal(capture.turn_control, null); assert.equal(capture.stop_batch, true);
      assert.deepEqual(capture.dispatch_error, { name: 'AssertionError', message: 'Environment variable is not set: NOTION_API_TOKEN' });
      assert.equal(capture.error, 'No terminal runtime receipt; actual request/cost status remains unknown');
      assert.deepEqual(await readdir(runRoot), []); assert.equal(item.original_generic_request_cost_label, 'unknown');
      assert.equal(item.subject_spawned, false); continue;
    }
    for (const [key, path] of Object.entries({ episode: 'benchmark/runtime/episode-result.json', runtime_events: 'benchmark/runtime/events.jsonl',
      transport: 'benchmark/runtime/transport.jsonl', child_result: 'result.json', child_process: 'command.process.json' })) assert.equal(item[key].path, join(runRoot, path));
    const episode = await verified(item.episode); assert.equal(capture.result_path, item.episode.path);
    assertEngineeringNativeZeroSend({ runId, capture, episode, child: await verified(item.child_result), process: await verified(item.child_process),
      events: lines(await bytes(item.runtime_events)), transport: lines(await bytes(item.transport)) });
  }
  const sourceProof = report.pre_spawn_source_proof, composition = await verified(parent.engineeringContinuation.controllerSource);
  for (const [key, path] of [['execute', 'execute.mjs'], ['launcher', '../scripts/paired-environment.mjs']]) {
    const item = composition.implementation.files.find(f => f.path === path); assert.ok(item);
    assert.equal(sourceProof[key].path, resolve(composition.source_root, 'benchmark', path)); assert.equal(sourceProof[key].sha256, item.sha256);
  }
  const execute = (await bytes(sourceProof.execute)).toString(), launcher = (await bytes(sourceProof.launcher)).toString();
  assert.ok(execute.includes("'pass-env': [credential.api_key_env, ...(notionEntry ? ['NOTION_API_TOKEN'] : [])]"));
  assert.ok(launcher.includes("assert.ok(inherited[name], 'Environment variable is not set: ' + name);"));
  const tokens = ['export async function runEnvironment(options)', 'await fresh(root);',
    "const env = runtimeEnvironment(root, buildRoot, process.env, options['pass-env']", "for (const path of ['bin', 'tmp'", 'const result = await child(command, args,'];
  let position = -1; for (const token of tokens) { position = launcher.indexOf(token, position + 1); assert.ok(position >= 0, 'ENGINEERING_PREFLIGHT_REPAIR_PRESPAWN_ORDER_CHANGED'); }
  assert.equal(report.process_observation.status, 'passed');
  assert.deepEqual(report.process_observation.surviving_known_pids_descendants_or_native_group, []);
  await recorded(report.process_record, 0);
  assert.equal(report.prior_boundary.physical, 104); assert.equal(report.prior_boundary.registrations, 13);
  assert.deepEqual(report.prior_boundary.active_leases, []);
  assert.equal(report.prior_boundary.verified_original_references.length, 121);
  assert.equal(new Set(report.prior_boundary.verified_original_references.map(ref => ref.path)).size, 121);
  assert.equal(report.prior_boundary.original_six_unknown_usage_preserved, true);
  for (const ref of report.prior_boundary.verified_original_references) await bytes(ref);
  assert.ok(Date.parse(review.value.completed_at) >= Date.parse(report.completed_at));
  return { retainedAttempt: { claim: clean(report.claim), receipt: clean(report.receipt), binding: clean(report.binding) },
    stoppedAt: receipt.completed_at, reviewedAt: review.value.completed_at };
}

function draftValue(request, parent, derived, evidence) {
  assert.match(request.id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/); assert.notEqual(request.id, parent.value.id);
  const c = parent.engineeringContinuation;
  const value = { version: 1, kind: ENGINEERING_PREFLIGHT_REPAIR_DRAFT, id: request.id, approved: false, execution_authority: null,
    parent_authorization: clean(request.parent_authorization), controller_source: clean(request.controller_source),
    zero_send_proof: clean(request.zero_send_proof), zero_send_review_record: clean(request.zero_send_review_record),
    retained_attempt: evidence.retainedAttempt, stopped_at: evidence.stoppedAt, zero_send_reviewed_at: evidence.reviewedAt,
    predecessor: structuredClone(parent.value.predecessor), checkpoint: clean(parent.value.revision.checkpoint),
    superseded_unactivated_owner: structuredClone(oldOwner), continuation: structuredClone(ENGINEERING_PREFLIGHT_REPAIR_OWNER),
    boundary: { scheduled_episodes: 104, registration_sequence: 13, unknown_usage_run_ids: structuredClone(parent.value.history.unknown_usage_run_ids) },
    transition: derived.transition, allocations: derived.allocations, resource_carryover: structuredClone(c.resourceCarryover),
    new_reservation_ceiling: 35, total_reservation_ceiling: 139, max_scheduled_episodes: 144, unallocated_headroom: 5,
    model_window: structuredClone(c.modelWindow), science: structuredClone(c.science),
    automatic_retry: false, automatic_renewal: false, proposal_sha256: null };
  value.proposal_sha256 = fingerprint(value); return value;
}

function assertActiveWindow(window) {
  assert.ok(Date.now() >= Date.parse(window.start) && Date.now() < Date.parse(window.end), 'ENGINEERING_PREFLIGHT_REPAIR_ORIGINAL_WINDOW_CLOSED');
}
async function context(request, { ancestors = new Set(), currentBoundary = false } = {}) {
  keys(request, ['id', 'parent_authorization', 'controller_source', 'zero_send_proof', 'zero_send_review_record']);
  const preview = await verified(request.parent_authorization);
  assert.equal(preview.version, 7, 'ENGINEERING_PREFLIGHT_REPAIR_PARENT_V7_ONLY');
  const { readApprovedCampaign } = await import('./approved-campaign.mjs');
  const parent = await readApprovedCampaign(request.parent_authorization, ancestors), derived = deriveEngineeringPreflightRepair(parent);
  if (currentBoundary) { assertActiveWindow(parent.engineeringContinuation.modelWindow); await assertEngineeringWindowCurrentBoundary(parent.value.pilot_ledger_root); }
  assert.notDeepEqual(request.controller_source, parent.engineeringContinuation.controllerSource, 'ENGINEERING_PREFLIGHT_REPAIR_NEW_CONTROLLER_REQUIRED');
  if (currentBoundary) {
    const { verifyReviewedEngineeringOverlay } = await import('./engineering-source.mjs');
    await verifyReviewedEngineeringOverlay(await verified(request.controller_source));
  }
  const controller = await readEngineeringControllerComposition(request.controller_source, parent.engineeringContinuation.source);
  assert.ok(controller.implementation.files.some(f => f.path === 'campaign-engineering-preflight-repair.mjs'), 'ENGINEERING_PREFLIGHT_REPAIR_CONTROLLER_REQUIRED');
  const evidence = await readEngineeringPreflightZeroSend({ parent, parentReference: request.parent_authorization,
    proofReference: request.zero_send_proof, reviewRecordReference: request.zero_send_review_record });
  if (currentBoundary) {
    await assertEngineeringWindowCurrentBoundary(parent.value.pilot_ledger_root); assertActiveWindow(parent.engineeringContinuation.modelWindow);
    assert.ok(!(await readdir(join(parent.value.environment_root, 'runs'))).some(name => name.startsWith(ENGINEERING_PREFLIGHT_REPAIR_OWNER.experiment_id + '-')),
      'ENGINEERING_PREFLIGHT_REPAIR_NEW_OWNER_OCCUPIED');
  }
  return { parent, derived, controller, evidence, draft: draftValue(request, parent, derived, evidence) };
}

export async function prepareEngineeringPreflightRepairDraft(request) { return (await context(request, { currentBoundary: true })).draft; }

export async function readEngineeringPreflightRepairDecision(draftReference, decisionReference) {
  const draft = await verified(draftReference), decision = await verified(decisionReference);
  assert.equal(draft.version, 1); assert.equal(draft.kind, ENGINEERING_PREFLIGHT_REPAIR_DRAFT);
  assert.equal(draft.approved, false); assert.equal(draft.execution_authority, null);
  assert.equal(draft.proposal_sha256, fingerprint({ ...draft, proposal_sha256: null }));
  keys(decision, ['version', 'kind', 'approved', 'source', 'user_message', 'recorded_at_utc', 'approved_draft', 'parent_authorization',
    'controller_source', 'zero_send_proof', 'zero_send_review_record', 'retained_claim', 'retained_receipt', 'continuation',
    'accepted_history_reservations', 'registration_sequence', 'approved_remaining_reservations', 'total_reservation_ceiling',
    'max_scheduled_episodes', 'model_window', 'future_stop_policy']);
  assert.equal(decision.version, 1); assert.equal(decision.kind, 'user-approved-engineering-preflight-repair');
  assert.equal(decision.approved, true, 'ENGINEERING_PREFLIGHT_REPAIR_EXPLICIT_APPROVAL_REQUIRED');
  assert.equal(decision.source, 'current-user-message'); assert.ok(decision.user_message?.trim());
  assert.deepEqual(decision.approved_draft, clean(draftReference));
  for (const key of ['parent_authorization', 'controller_source', 'zero_send_proof', 'zero_send_review_record', 'continuation']) assert.deepEqual(decision[key], draft[key]);
  assert.deepEqual(decision.retained_claim, draft.retained_attempt.claim); assert.deepEqual(decision.retained_receipt, draft.retained_attempt.receipt);
  assert.deepEqual(decision.continuation, ENGINEERING_PREFLIGHT_REPAIR_OWNER);
  assert.deepEqual([decision.accepted_history_reservations, decision.registration_sequence, decision.approved_remaining_reservations,
    decision.total_reservation_ceiling, decision.max_scheduled_episodes], [104, 13, 35, 139, 144]);
  assert.deepEqual(decision.model_window, { start: draft.model_window.start, end: draft.model_window.end, automatic_renewal: false },
    'ENGINEERING_PREFLIGHT_REPAIR_WINDOW_CHANGED');
  assert.equal(draft.automatic_retry, false); assert.equal(draft.automatic_renewal, false); assert.deepEqual(decision.future_stop_policy, stopPolicy);
  const at = Date.parse(decision.recorded_at_utc), start = Date.parse(draft.model_window.start), end = Date.parse(draft.model_window.end);
  assert.ok(Number.isFinite(at) && at <= Date.now() && end - start === 86400000 && at >= start && at < end && at >= Date.parse(draft.stopped_at)
    && at >= Date.parse(draft.zero_send_reviewed_at), 'ENGINEERING_PREFLIGHT_REPAIR_APPROVAL_TIME');
  return { draft, decision };
}

/** Historical reads verify immutable evidence but allow the child to have
 * legitimately reached105/14. Only prospective preparation requires104/13. */
export async function readEngineeringPreflightRepairContext({ draft, ancestors, currentBoundary = false }) {
  const request = Object.fromEntries(['id', 'parent_authorization', 'controller_source', 'zero_send_proof', 'zero_send_review_record'].map(k => [k, draft[k]]));
  const result = await context(request, { ancestors, currentBoundary });
  assert.deepEqual(draft, result.draft, 'ENGINEERING_PREFLIGHT_REPAIR_DERIVED_DRAFT_CHANGED');
  const c = result.parent.engineeringContinuation;
  return { ...result, continuation: { ...c, ...result.derived, controllerSource: clean(draft.controller_source),
    controllerImplementation: result.controller.implementation, historicalController: result.controller.historicalController } };
}
