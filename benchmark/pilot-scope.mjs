import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fingerprint } from './protocol.mjs';
import { readEvidenceBundle, verifyArtifactFiles } from './evidence/store.mjs';
import { verifyAnalysisRevision } from './revision.mjs';
import { verifyCollectionRecoveryResults } from './collection-recovery.mjs';
import { assertZeroSendInvalid } from './resumption.mjs';
import { readProviderTransport } from '../scripts/skill-consumption-provider.mjs';
import { isProspectiveCohort, prospectiveCohortPolicy, prepareProspectiveCohort, verifyProspectiveCohort,
  assertProspectiveCohortPlan, assertCohortModelEvidence, scopeModelIdentity, scopeEnvironmentIdentity } from './prospective-cohort.mjs';
export { scopeModelIdentity, scopeEnvironmentIdentity } from './prospective-cohort.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safe = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const usageKeys = ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms'];
const knownUsage = usage => usageKeys.every(key => typeof usage?.[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0);
const sorted = values => [...values].sort();
const MODEL_VARIANT = 'gpt-6.2-sol';
const ref = async path => ({ path, sha256: sha(await readFile(path)) });
const save = async (path, value) => {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await readFile(path, 'utf8'), bytes, 'Existing scope registration differs'); }
};
async function verified(reference) {
  assert.ok(isAbsolute(reference?.path ?? '') && digest(reference.sha256));
  const bytes = await readFile(reference.path); assert.equal(sha(bytes), reference.sha256, 'PILOT_SCOPE_HISTORY_CHANGED: ' + reference.path);
  return JSON.parse(bytes);
}
async function ledger(path) {
  let bytes;
  try { bytes = await readFile(path); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  assert.ok(bytes.length === 0 || bytes.at(-1) === 10, 'PILOT_SCOPE_INCOMPLETE_LEDGER');
  return bytes.toString('utf8').split('\n').filter(Boolean).map((line, i) => {
    const row = JSON.parse(line); assert.equal(row.seq, i + 1, 'PILOT_SCOPE_LEDGER_SEQUENCE'); return row;
  });
}
function planIdentity(plan) {
  assert.equal(plan?.version, 1); assert.equal(plan.kind, 'benchmark-batch-plan');
  assert.equal(plan.plan_sha256, fingerprint({ ...plan, plan_sha256: null }), 'PILOT_SCOPE_PLAN_CHANGED');
  assert.equal(plan.protocol.protocol_sha256, fingerprint({ ...plan.protocol, protocol_sha256: null }), 'PILOT_SCOPE_PROTOCOL_CHANGED');
  assert.equal(plan.id, plan.protocol.id); assert.equal(plan.protocol.phase, 'pilot');
  assert.equal(plan.protocol.policies.pilot.max_scheduled_episodes, 144);
}

export function pilotScopePolicy(input, { modelCount } = {}) {
  if (!input) return undefined;
  if (isProspectiveCohort(input)) return prospectiveCohortPolicy(input, modelCount);
  assert.ok(safe(input.id)); assert.ok(['gate', 'expansion'].includes(input.role));
  if (input.role === 'gate') {
    assert.equal(input.gate_episodes, 16); assert.equal(input.minimum_valid_real_per_condition, 4);
  }
  return { version: 1, id: input.id, role: input.role, gate_episodes: 16, minimum_valid_real_per_condition: 4,
    history_quality: 'excluded_retained_in_campaign_costs', legacy_first24: 'incomplete_not_satisfied', new_unknown_usage: 'stop_scope' };
}

export function assertScopePlan(plan, amendment) {
  const policy = plan.protocol.policies.pilot.scope, execution = plan.execution.pilot_scope;
  assert.ok(policy && execution, 'PILOT_SCOPE_POLICY_REQUIRED');
  assert.equal(policy.id, amendment.id); assert.equal(execution.id, amendment.id); assert.equal(execution.role, policy.role);
  assert.equal(plan.protocol.phase, 'pilot'); assert.equal(plan.execution.resumption, undefined, 'Scope amendments are not zero-send continuations');
  assert.equal(plan.execution.pilot_ledger_root, amendment.pilot_ledger_root, 'PILOT_SCOPE_FOREIGN_LEDGER');
  assert.equal(plan.execution.environment_root, amendment.environment_root, 'PILOT_SCOPE_FOREIGN_ENVIRONMENT');
  assert.deepEqual(sorted(plan.protocol.models.map(scopeModelIdentity)), amendment.model_conditions, 'PILOT_SCOPE_MODEL_CHANGED');
  assert.deepEqual(sorted(plan.protocol.environments.map(scopeEnvironmentIdentity)), amendment.environment_conditions, 'PILOT_SCOPE_ENVIRONMENT_CHANGED');
  assert.deepEqual(plan.execution.instrumentation, amendment.instrumentation, 'PILOT_SCOPE_INSTRUMENTATION_CHANGED');
  assert.equal(plan.protocol.policies.evidence.observer_version, amendment.observer_version);
  assert.equal(plan.protocol.policies.pilot.max_scheduled_episodes, 144);
  assert.equal(policy.gate_episodes, amendment.gate.scheduled_episodes);
  assert.equal(policy.minimum_valid_real_per_condition, amendment.gate.minimum_valid_real_per_condition);
  if (isProspectiveCohort(amendment)) return assertProspectiveCohortPlan(plan, amendment);
  if (amendment.version === 3) assert.equal(plan.execution.models_sha256, amendment.manual_route_replacement.model_registry_after.sha256,
    'PILOT_SCOPE_ROUTE_REGISTRY_CHANGED');
  if (policy.role === 'gate') {
    if (amendment.version === 2) assert.deepEqual(plan.protocol, amendment.repair_protocol, 'PILOT_SCOPE_REPAIR_PROTOCOL_CHANGED');
    if (amendment.version === 3) {
      assert.deepEqual(plan.protocol, amendment.route_protocol, 'PILOT_SCOPE_ROUTE_PROTOCOL_CHANGED');
      assert.deepEqual({ path: plan.execution.models_file, sha256: plan.execution.models_sha256 }, amendment.manual_route_replacement.model_registry_after,
        'PILOT_SCOPE_ROUTE_REGISTRY_CHANGED');
    }
    assert.equal(plan.id, amendment.gate.experiment_id, 'PILOT_SCOPE_GATE_PLAN_CHANGED');
    assert.equal(plan.execution.control_root, amendment.gate.control_root, 'PILOT_SCOPE_GATE_ROOT_CHANGED');
    assert.deepEqual(plan.slots, amendment.gate.slots, 'PILOT_SCOPE_GATE_SCHEDULE_CHANGED');
    assert.equal(plan.slots.length, 16); assert.equal(plan.protocol.models.length, 2);
    assert.deepEqual(sorted(plan.protocol.environments.map(environment => environment.pi.mode)), ['broker', 'native']);
    assert.equal(plan.protocol.conditions.length, 4);
    for (const condition of plan.protocol.conditions) assert.equal(plan.slots.filter(slot => slot.condition_id === condition.id).length, 4);
  }
}

async function reservations(root) {
  assert.ok(isAbsolute(root) && root === resolve(root));
  assert.equal(await realpath(root), root, 'PILOT_SCOPE_LEDGER_SYMLINK');
  const names = (await readdir(root)).filter(name => /^\d{3}\.json$/.test(name)).sort();
  assert.ok(names.length <= 144, 'PILOT_CAP');
  const values = [];
  for (const [index, name] of names.entries()) {
    assert.equal(name, String(index + 1).padStart(3, '0') + '.json', 'PILOT_SCOPE_RESERVATION_GAP');
    const path = join(root, name); values.push({ ordinal: index + 1, reference: await ref(path), reservation: await read(path) });
  }
  assert.equal(new Set(values.map(item => item.reservation.run_id)).size, values.length, 'PILOT_SCOPE_DUPLICATE_RUN');
  return values;
}

/** History is read from completed evidence, including its registered same-raw correction. */
async function historicalAccounting({ planFiles, pilotLedgerRoot, environmentRoot, expected }) {
  const all = await reservations(pilotLedgerRoot), selected = expected ? all.slice(0, expected.reservations.length) : all;
  assert.equal(selected.length, 3, 'The prospective amendment retains the three original pilot reservations');
  assert.equal(selected.length, expected?.reservations.length ?? selected.length, 'PILOT_SCOPE_HISTORY_MISSING');
  const plans = [], byId = new Map();
  for (const path of planFiles) {
    assert.ok(isAbsolute(path)); const plan = await read(path); planIdentity(plan);
    assert.equal(plan.execution.pilot_ledger_root, pilotLedgerRoot, 'PILOT_SCOPE_FOREIGN_LEDGER');
    assert.equal(plan.execution.environment_root, environmentRoot);
    assert.equal(plan.execution.pilot_scope, undefined, 'This amendment only succeeds the retained original pilot');
    assert.equal(path, join(plan.execution.control_root, 'plan.json'));
    assert.ok(!byId.has(plan.id));
    const ledgerPath = join(plan.execution.control_root, 'ledger.jsonl'), rows = await ledger(ledgerPath);
    const starts = rows.filter(row => row.type === 'episode_started'), completed = rows.filter(row => row.type === 'episode_completed');
    assert.equal(starts.length, completed.length, 'PILOT_SCOPE_HISTORY_UNRESOLVED');
    assert.equal(new Set(completed.map(row => row.run_id)).size, completed.length);
    assert.ok(starts.every(row => completed.some(item => item.run_id === row.run_id)));
    const applications = rows.filter(row => row.type === 'analysis_revision_applied');
    assert.ok(applications.length <= 1, 'Multiple historical analysis revisions require separate review');
    const revisionReference = applications[0]?.reference ?? null;
    const revision = revisionReference ? await verifyAnalysisRevision({ reference: revisionReference, plan }) : null;
    const item = { plan: await ref(path), ledger: await ref(ledgerPath), analysis_revision: revisionReference };
    plans.push(item); byId.set(plan.id, { plan, rows, starts, completed, revision });
  }
  const episodes = [], totals = { model_requests: 0, input_tokens: 0, output_tokens: 0, duration_ms: 0 };
  for (const item of selected) {
    const reservation = item.reservation, owner = byId.get(reservation.experiment_id);
    assert.ok(owner, 'PILOT_SCOPE_HISTORY_PLAN_MISSING');
    const completed = owner.completed.filter(row => row.run_id === reservation.run_id);
    assert.equal(completed.length, 1, 'PILOT_SCOPE_HISTORY_RESULT_MISSING');
    const event = completed[0], replacement = owner.revision?.replacements.find(row => row.run_id === event.run_id);
    assert.equal(event.slot_id, reservation.slot_id);
    const directory = replacement?.directory ?? event.result.normalized_directory;
    const expectedHash = replacement?.new_episode_sha256 ?? event.result.episode_sha256;
    const { episode } = await readEvidenceBundle({ directory, rawRoot: environmentRoot });
    assert.equal(episode.episode_sha256, expectedHash); assert.equal(episode.identity.run_id, reservation.run_id);
    assert.equal(episode.identity.experiment_id, owner.plan.id);
    assert.equal(episode.measurements.actual_attempts.status, 'known', 'Historical sends must be observed');
    const usage = { model_requests: episode.measurements.actual_attempts.value,
      input_tokens: episode.measurements.input_total.value.status === 'known' ? episode.measurements.input_total.value.value : null,
      output_tokens: episode.measurements.output_total.value.status === 'known' ? episode.measurements.output_total.value.value : null,
      duration_ms: episode.timing.duration_ms.status === 'known' ? episode.timing.duration_ms.value : null };
    assert.deepEqual(usage, replacement?.budget_usage ?? event.result.budget_usage, 'PILOT_SCOPE_HISTORY_USAGE_MISMATCH');
    for (const key of usageKeys) if (usage[key] !== null) totals[key] += usage[key];
    episodes.push({ run_id: reservation.run_id, pilot_ordinal: item.ordinal, experiment_id: owner.plan.id,
      directory, episode_sha256: episode.episode_sha256, admission: episode.admission.status, budget_usage: usage,
      quality_credit: 'excluded_from_new_scope', stop_batch: replacement ? replacement.stop_batch : Boolean(event.result.stop_batch) });
  }
  assert.equal([...byId.values()].reduce((sum, owner) => sum + owner.starts.length, 0), selected.length, 'PILOT_SCOPE_HISTORY_UNRESERVED_EPISODE');
  const unknown = episodes.filter(item => !knownUsage(item.budget_usage)).map(item => item.run_id).sort();
  const value = { reservations: selected.map(({ ordinal, reference }) => ({ ordinal, reference })), plans,
    episodes, unknown_usage_run_ids: unknown, known_subtotal: totals,
    total_usage_status: unknown.length ? 'incomplete' : 'known', monetary_status: 'unpriced', scheduled_episodes: selected.length };
  if (expected) assert.deepEqual(value, expected, 'PILOT_SCOPE_HISTORY_CHANGED');
  return value;
}

function repairProtocolBoundary(protocol) {
  const value = structuredClone(protocol);
  delete value.id; delete value.registered_at; delete value.protocol_sha256;
  delete value.policies.pilot.scope.id;
  value.conditions.forEach(condition => { delete condition.environment_sha256; });
  value.environments = value.environments.map(environment => ({ id: environment.id,
    paired_environment_id: environment.paired_environment_id, runtime: environment.runtime, policies: environment.policies,
    cli_commit: environment.build.cli.commit, cli_source_sha256: environment.build.cli.source_sha256, sdk_sha256: environment.build.cli.sdk_sha256,
    pi: { mode: environment.pi.mode, entry: environment.pi.entry, entry_kind: environment.pi.entry_kind,
      config_sha256: environment.pi.config_sha256, tools: environment.pi.tools, active_tools: environment.pi.active_tools,
      extensions: environment.pi.extensions.filter(extension => extension.role !== 'observer').map(({ id, role, sha256 }) => ({ id, role, sha256 })),
      sources: environment.pi.sources, native_root: environment.pi.native_root } }));
  return value;
}

function productInventory(build) {
  return Object.fromEntries(['cli', 'broker'].map(name => [name, build.packages[name].files
    .filter(file => file.path.startsWith('src/') || file.path.startsWith('node_modules/')
      || ['package.json', 'package-lock.json'].includes(file.path)
      || file.path.startsWith('dist/') && !['dist/next-build.json', 'dist/ntn-skills-runtime.json'].includes(file.path))
    .map(file => structuredClone(file))]));
}

async function verifyRepairCaptures({ repair, prior, protocol, environmentRoot }) {
  assert.deepEqual(repairProtocolBoundary(protocol), repairProtocolBoundary(prior.protocol), 'PILOT_SCOPE_REPAIR_TASK_OR_MODEL_CHANGED');
  const cells = new Set(), builds = new Map();
  for (const capture of repair.captures) {
    const expectation = await verified(capture.expectation), runtime = await verified(capture.runtime), shared = await verified(capture.shared);
    assert.equal(runtime.correlation.run_id, capture.run_id); assert.equal(shared.run_id, capture.run_id);
    assert.equal(runtime.status, 'captured'); assert.equal(runtime.requests.length, 1); assert.equal(runtime.turns.length, 0);
    assert.equal(runtime.requests[0].attempts.length, 0); assert.equal(runtime.requests[0].usage, null);
    assert.equal(runtime.budget.requests, 0); assert.equal(runtime.budget.attempts, 0); assert.equal(runtime.budget.tools, 0);
    assert.equal(shared.status, 'passed'); assert.equal(shared.runtime_check.status, 'unchanged'); assert.equal(shared.frozen_artifacts, 'passed');
    const artifacts = await verifyArtifactFiles(runtime.artifacts, { root: environmentRoot });
    assert.deepEqual(JSON.parse(artifacts.get('candidate-observed').bytes).projection, expectation.projection);
    const transport = await readProviderTransport(artifacts.get('transport').path);
    assert.equal(transport.at(-1).complete, true);
    assert.ok(!transport.some(event => event.phase === 'request_start' && event.category === 'model'));
    const environment = protocol.environments.find(item => item.pi.mode === capture.mode);
    const before = prior.protocol.environments.find(item => item.pi.mode === capture.mode);
    assert.ok(environment && before && protocol.models.some(model => model.id === capture.model_id));
    assert.equal(shared.build_id, environment.build.id);
    assert.equal(expectation.projection.mode, capture.mode);
    assert.ok(capture.model_id.endsWith('/' + expectation.projection.model.id));
    assert.notEqual(environment.build.id, before.build.id, 'A repair must use a new paired build');
    for (const item of [before, environment]) if (!builds.has(item.build.id)) {
      const reference = { path: join(environmentRoot, 'builds', item.build.id, 'build.json'), sha256: item.build.receipt_sha256 };
      builds.set(item.build.id, await verified(reference));
    }
    assert.equal(expectation.projection.build.sha256, environment.build.receipt_sha256);
    assert.deepEqual(productInventory(builds.get(environment.build.id)), productInventory(builds.get(before.build.id)),
      'PILOT_SCOPE_REPAIR_PRODUCT_BYTES_CHANGED');
    assert.ok(!cells.has(capture.model_id + '/' + capture.mode)); cells.add(capture.model_id + '/' + capture.mode);
  }
  assert.equal(cells.size, 4, 'The repaired apparatus needs fresh captures for all four conditions');
}

async function successorHistory({ predecessor, repair, environmentRoot, expected }) {
  const previous = await readPilotScopeAmendment(predecessor.amendment);
  assert.equal(previous.version, 1, 'Only the first prospective final-request zero-send repair is supported');
  assert.equal(previous.environment_root, environmentRoot);
  const prior = await verified(predecessor.plan); planIdentity(prior); assertScopePlan(prior, previous);
  assert.equal(prior.execution.pilot_scope.role, 'gate');
  assert.deepEqual(prior.execution.pilot_scope.amendment, predecessor.amendment);
  assert.deepEqual(await verified(predecessor.registration), { id: previous.id, amendment: predecessor.amendment });
  const all = await reservations(previous.pilot_ledger_root), ordinal = previous.history.scheduled_episodes + 1;
  if (!expected) assert.equal(all.length, ordinal, 'A zero-send successor cannot absorb any other new reservation');
  const item = all[ordinal - 1]; assert.ok(item);
  assert.equal(item.reservation.run_id, repair.run_id); assert.equal(item.reservation.experiment_id, prior.id);
  assert.equal(item.reservation.scope_amendment_sha256, previous.amendment_sha256);
  assert.deepEqual(item.reservation.plan, predecessor.plan);
  const ledgerPath = join(prior.execution.control_root, 'ledger.jsonl'), rows = await ledger(ledgerPath);
  assert.equal(rows.at(-1)?.type, 'batch_closed', 'The stopped predecessor controller must have closed');
  assert.ok(!rows.some(row => row.type === 'analysis_revision_applied'), 'An analysis revision cannot substitute for zero-send repair');
  const starts = rows.filter(row => row.type === 'episode_started'), completed = rows.filter(row => row.type === 'episode_completed');
  assert.equal(starts.length, 1); assert.equal(completed.length, 1);
  const event = completed[0]; assert.equal(event.run_id, repair.run_id); assert.equal(starts[0].run_id, repair.run_id);
  assert.equal(event.slot_id, prior.slots[0].slot_id); assert.equal(event.slot_id, item.reservation.slot_id);
  assert.equal(event.result.stop_batch, true); assert.equal(event.result.status, 'admission_rejected');
  const root = event.result.run_root;
  assert.equal(root, join(environmentRoot, 'runs', repair.run_id));
  const runtimeRef = await ref(join(root, 'benchmark/runtime/episode-result.json')), sharedRef = await ref(join(root, 'result.json'));
  const { episode } = await readEvidenceBundle({ directory: event.result.normalized_directory, rawRoot: environmentRoot });
  assert.equal(episode.episode_sha256, event.result.episode_sha256); assert.equal(episode.identity.run_id, repair.run_id);
  assert.equal(episode.identity.experiment_id, prior.id); assert.equal(episode.identity.case_id, prior.slots[0].case_id);
  assert.equal(episode.identity.condition_id, prior.slots[0].condition_id);
  const condition = prior.protocol.conditions.find(value => value.id === prior.slots[0].condition_id);
  assert.equal(episode.identity.model_id, condition.model_id); assert.equal(episode.identity.environment_sha256, condition.environment_sha256);
  await assertZeroSendInvalid({ episode, runtime: await verified(runtimeRef), shared: await verified(sharedRef),
    rejection: 'final_request_contract', environmentRoot });
  const usage = { model_requests: 0, input_tokens: 0, output_tokens: 0, duration_ms: episode.timing.duration_ms.value };
  assert.deepEqual(event.result.budget_usage, usage);
  const history = structuredClone(previous.history);
  history.reservations.push({ ordinal, reference: item.reference });
  history.plans.push({ plan: predecessor.plan, ledger: await ref(ledgerPath), analysis_revision: null });
  history.episodes.push({ run_id: repair.run_id, pilot_ordinal: ordinal, experiment_id: prior.id,
    directory: event.result.normalized_directory, episode_sha256: episode.episode_sha256, admission: 'invalid', budget_usage: usage,
    quality_credit: 'excluded_from_new_scope', stop_batch: true, runtime: runtimeRef, shared: sharedRef });
  history.scheduled_episodes++; history.known_subtotal.duration_ms += usage.duration_ms;
  if (expected) assert.deepEqual(history, expected, 'PILOT_SCOPE_REPAIR_HISTORY_CHANGED');
  return { history, previous, prior };
}

/** This is a retained provider-authentication observation, never a zero-send repair. */
export async function assertManualAuthRejection({ episode, runtime, shared, environmentRoot, model }) {
  assertRouteModel(model);
  assert.equal(episode.admission.status, 'invalid'); assert.equal(episode.identity.model_id, model.id);
  for (const key of ['attempts', 'tools', 'interventions']) assert.equal(episode.admission.completeness[key], 'complete');
  assert.equal(episode.measurements.actual_attempts.status, 'known'); assert.equal(episode.measurements.actual_attempts.value, 1);
  for (const key of ['input_total', 'output_total']) assert.equal(episode.measurements[key].value.status, 'unknown');
  assert.equal(episode.timing.duration_ms.status, 'known'); assert.equal(episode.result.verified_success, false);
  assert.equal(episode.tools.length, 0); assert.equal(episode.attempts.length, 1); assert.equal(episode.attempts[0].sent, true);
  assert.equal(runtime.status, 'invalid'); assert.equal(runtime.error.code, 'BENCHMARK_USAGE_UNKNOWN');
  assert.equal(runtime.correlation.run_id, episode.identity.run_id); assert.equal(runtime.correlation.episode_id, episode.identity.episode_id);
  assert.equal(runtime.correlation.candidate_id, episode.identity.condition_id); assert.equal(runtime.correlation.task_id, episode.identity.case_id);
  assert.equal(shared.run_id, episode.identity.run_id); assert.equal(shared.build_id, episode.identity.build_id);
  assert.equal(shared.status, 'failed');
  assert.equal(shared.runtime_check.status, 'unchanged'); assert.equal(shared.frozen_artifacts, 'passed');
  assert.equal(runtime.requests.length, 1); assert.equal(runtime.turns.length, 1); assert.equal(runtime.turns[0].final_text, null);
  assert.equal(runtime.budget.requests, 1); assert.equal(runtime.budget.attempts, 1); assert.equal(runtime.budget.tools, 0); assert.equal(runtime.budget.usage_unknown, true);
  const request = runtime.requests[0]; assert.equal(request.attempts.length, 1); assert.equal(request.usage, null);
  assert.equal(request.attempts[0].sent, true); assert.equal(request.attempts[0].status, 200);
  const artifacts = await verifyArtifactFiles(runtime.artifacts, { root: environmentRoot });
  assert.deepEqual(JSON.parse(artifacts.get('admission-comparison').bytes).differences, []);
  assert.deepEqual(JSON.parse(artifacts.get('first-request-catalog-comparison').bytes).differences, []);
  assert.deepEqual(JSON.parse(artifacts.get('first-request-contract-comparison').bytes).differences, []);
  const transport = await readProviderTransport(artifacts.get('transport').path);
  assert.equal(transport.at(-1).complete, true);
  const sends = transport.filter(event => event.phase === 'request_start' && event.category === 'model');
  assert.equal(sends.length, 1); assert.equal(sends[0].id, request.attempts[0].transport_id);
  const ends = transport.filter(event => event.phase === 'request_end' && event.id === sends[0].id);
  assert.equal(ends.length, 1); assert.equal(ends[0].status, 200); assert.equal(ends[0].outcome, 'completed');
  assert.equal(ends[0].requestSent, true); assert.equal(ends[0].modelApi, 'openai-completions');
  assert.match(ends[0].contentType, /^text\/event-stream/); assert.ok(ends[0].responseEntityBytes > 0);
  assert.ok(digest(ends[0].responseEntitySha256));
  const events = artifacts.get('events').bytes.toString('utf8').trim().split('\n').map(JSON.parse);
  const errors = events.filter(event => event.type === 'session_event' && event.data?.type === 'message_end'
    && event.request_id === request.id);
  assert.equal(errors.length, 1); const observed = errors[0], message = observed.data.message;
  assert.equal(observed.run_id, episode.identity.run_id); assert.equal(observed.candidate_id, episode.identity.condition_id);
  assert.equal(observed.task_id, episode.identity.case_id); assert.equal(message.model, model.route);
  assert.equal(message.api, 'openai-completions'); assert.equal(message.stopReason, 'error'); assert.deepEqual(message.content, []);
  assert.match(message.errorMessage, /^Command Code Plan: Your API key has expired\./);
  assert.match(message.errorMessage, /\(HTTP 401\)$/);
  assert.equal(request.assistant?.stop_reason, 'error'); assert.equal(request.assistant.error, message.errorMessage);
  const accounting = events.filter(event => event.type === 'request_usage_accounted' && event.request_id === request.id);
  assert.equal(accounting.length, 1); assert.equal(accounting[0].data.raw_usage_observed, false);
  assert.equal(accounting[0].data.guarded_fetch_attempts, 1); assert.equal(accounting[0].data.budget.usage_unknown, true);
  assert.ok(!events.some(event => event.type === 'provider_stream_event' && event.data?.event?.usage != null), 'Auth replacement cannot discard observed usage');
  return { provenance: 'sdk_error_event_inside_observed_http_200_sse', outer_http_status: 200,
    reported_auth_status: 401, actual_model_requests: 1, actual_usage: 'unknown',
    event: { path: artifacts.get('events').path, sha256: sha(artifacts.get('events').bytes), line: events.indexOf(observed) + 1 },
    transport: { path: artifacts.get('transport').path, sha256: sha(artifacts.get('transport').bytes) } };
}

function assertRouteModel(model) {
  assert.ok(model && typeof model.provider === 'string' && model.provider.length > 0, 'PILOT_SCOPE_ROUTE_MODEL_REQUIRED');
  assert.ok(typeof model.route === 'string' && model.route.split('/').every(Boolean), 'PILOT_SCOPE_ROUTE_MODEL_REQUIRED');
  assert.ok(!['auto', 'group'].includes(model.route.split('/')[0].toLowerCase()), 'PILOT_SCOPE_AUTOMATIC_ROUTE_FORBIDDEN');
  assert.equal(model.id, model.provider + '/' + model.route, 'PILOT_SCOPE_UNREGISTERED_ROUTE');
  assert.equal(model.route.split('/').at(-1), MODEL_VARIANT, 'PILOT_SCOPE_ROUTE_VARIANT_CHANGED');
  assert.equal(model.family, model.route, 'PILOT_SCOPE_ROUTE_VARIANT_CHANGED');
  assert.equal(model.api, 'openai-completions');
}

function manualRouteModels(change, priorProtocol, protocol) {
  assert.equal(change.variant, MODEL_VARIANT);
  assert.ok(typeof change.from_model_id === 'string' && typeof change.to_model_id === 'string');
  assert.notEqual(change.from_model_id, change.to_model_id, 'PILOT_SCOPE_ROUTE_NOT_REPLACED');
  const before = priorProtocol.models.filter(model => model.id === change.from_model_id);
  const after = protocol.models.filter(model => model.id === change.to_model_id);
  assert.equal(before.length, 1, 'PILOT_SCOPE_UNREGISTERED_PREDECESSOR_ROUTE');
  assert.equal(after.length, 1, 'PILOT_SCOPE_UNREGISTERED_ROUTE');
  const beforeModel = before[0], afterModel = after[0]; assertRouteModel(beforeModel); assertRouteModel(afterModel);
  assert.equal(afterModel.provider, beforeModel.provider, 'PILOT_SCOPE_ROUTE_PROVIDER_CHANGED');
  assert.ok(!protocol.models.some(model => model.id === change.from_model_id), 'The failed route cannot remain selected');
  return { beforeModel, afterModel };
}

function manualRouteBoundary(protocol, change, beforeModel) {
  const value = structuredClone(protocol); delete value.id; delete value.registered_at; delete value.protocol_sha256;
  delete value.policies.pilot.scope.id;
  for (const model of value.models) if (model.id === change.to_model_id) {
    model.id = beforeModel.id; model.route = beforeModel.route; model.family = beforeModel.family;
  }
  for (const condition of value.conditions) {
    if (condition.model_id === change.to_model_id) condition.model_id = beforeModel.id;
    delete condition.environment_sha256;
  }
  for (const environment of value.environments) {
    delete environment.manifest_sha256; delete environment.pi.catalog_sha256; delete environment.pi.injection_sha256;
    environment.pi.extensions = environment.pi.extensions.map(({ path, ...extension }) => extension);
  }
  return value;
}

function registeredRuntimeModel(registry, model) {
  const provider = registry.providers[model.provider]; assert.ok(provider);
  const values = provider.models.filter(item => item.id === model.route); assert.equal(values.length, 1);
  return { ...values[0], provider: model.provider, baseUrl: provider.baseUrl };
}

async function verifyManualRouteCaptures({ change, prior, protocol, environmentRoot }) {
  const { beforeModel, afterModel } = manualRouteModels(change, prior.protocol, protocol);
  assert.equal(change.administrative_hold, 'full_prior_episode_allocation_not_actual_upper_bound');
  const before = await verified(change.model_registry_before), after = await verified(change.model_registry_after);
  assert.deepEqual(manualRouteBoundary(protocol, change, beforeModel), manualRouteBoundary(prior.protocol, change, beforeModel),
    'PILOT_SCOPE_ROUTE_TASK_OR_MODEL_CHANGED');
  assert.deepEqual(change.model_registry_before, { path: prior.execution.models_file, sha256: prior.execution.models_sha256 },
    'PILOT_SCOPE_PREDECESSOR_REGISTRY_CHANGED');
  assert.equal(beforeModel.api, 'openai-completions'); assert.equal(afterModel.api, beforeModel.api);
  assert.deepEqual(afterModel.parameters, { thinkingLevel: 'medium', maxTokens: 4096 });
  const oldRegistryModel = registeredRuntimeModel(before, beforeModel), newRegistryModel = registeredRuntimeModel(after, afterModel);
  assert.equal(oldRegistryModel.contextWindow, 1050000); assert.equal(newRegistryModel.contextWindow, 922000);
  const stableMetadata = ({ id, name, contextWindow, ...value }) => value;
  assert.deepEqual(stableMetadata(oldRegistryModel), stableMetadata(newRegistryModel), 'PILOT_SCOPE_ROUTE_OTHER_METADATA_CHANGED');
  for (const model of protocol.models.filter(model => model.id !== change.to_model_id)) {
    const old = prior.protocol.models.find(item => item.id === model.id); assert.ok(old);
    assert.deepEqual(registeredRuntimeModel(before, old), registeredRuntimeModel(after, model), 'PILOT_SCOPE_UNCHANGED_ROUTE_CHANGED');
  }
  const cells = new Set();
  for (const capture of change.captures) {
    const expectation = await verified(capture.expectation), runtime = await verified(capture.runtime), shared = await verified(capture.shared);
    const model = protocol.models.find(model => model.id === capture.model_id), environment = protocol.environments.find(item => item.pi.mode === capture.mode);
    assert.ok(model && environment); assert.equal(runtime.correlation.run_id, capture.run_id); assert.equal(shared.run_id, capture.run_id);
    assert.equal(shared.build_id, environment.build.id); assert.equal(shared.status, 'passed');
    assert.equal(shared.runtime_check.status, 'unchanged'); assert.equal(shared.frozen_artifacts, 'passed');
    assert.equal(runtime.status, 'captured'); assert.equal(runtime.requests.length, 1); assert.equal(runtime.turns.length, 0);
    assert.equal(runtime.requests[0].attempts.length, 0); assert.equal(runtime.requests[0].usage, null);
    assert.equal(runtime.budget.requests, 0); assert.equal(runtime.budget.attempts, 0); assert.equal(runtime.budget.tools, 0);
    const artifacts = await verifyArtifactFiles(runtime.artifacts, { root: environmentRoot });
    assert.deepEqual(JSON.parse(artifacts.get('candidate-observed').bytes).projection, expectation.projection);
    assert.equal(expectation.projection.mode, capture.mode); assert.equal(expectation.projection.build.sha256, environment.build.receipt_sha256);
    const { provider, ...actualModel } = expectation.projection.model, { provider: expectedProvider, ...expectedModel } = registeredRuntimeModel(after, model);
    assert.ok([expectedProvider, '[REDACTED_CREDENTIAL]'].includes(provider));
    assert.deepEqual(actualModel, expectedModel, 'PILOT_SCOPE_ROUTE_CAPTURE_METADATA_CHANGED');
    const transport = await readProviderTransport(artifacts.get('transport').path);
    assert.equal(transport.at(-1).complete, true);
    assert.ok(!transport.some(event => event.phase === 'request_start' && event.category === 'model'));
    assert.ok(!cells.has(capture.model_id + '/' + capture.mode)); cells.add(capture.model_id + '/' + capture.mode);
  }
  assert.equal(cells.size, 4, 'The new pinned route needs four fresh model/environment captures');
}

async function manualRouteHistory({ predecessor, change, environmentRoot, expected }) {
  const previous = await readPilotScopeAmendment(predecessor.amendment);
  assert.equal(previous.version, 2, 'Only one manual route amendment from the zero-send successor is authorized');
  assert.equal(previous.environment_root, environmentRoot);
  const prior = await verified(predecessor.plan); planIdentity(prior); assertScopePlan(prior, previous);
  assert.equal(prior.execution.pilot_scope.role, 'gate'); assert.deepEqual(prior.execution.pilot_scope.amendment, predecessor.amendment);
  const active = await verified(predecessor.registration);
  assert.equal(active.version, 1); assert.equal(active.sequence, 2); assert.equal(active.kind, 'benchmark-zero-send-scope-succession');
  assert.deepEqual(active.predecessor, previous.predecessor.registration);
  assert.equal(active.id, previous.id); assert.deepEqual(active.amendment, predecessor.amendment);
  const all = await reservations(previous.pilot_ledger_root), ordinal = previous.history.scheduled_episodes + 1;
  assert.equal(ordinal, 5); if (!expected) assert.equal(all.length, ordinal, 'A route amendment cannot absorb another new reservation');
  const item = all[ordinal - 1]; assert.ok(item);
  assert.equal(item.reservation.run_id, change.run_id); assert.equal(item.reservation.experiment_id, prior.id);
  assert.equal(item.reservation.scope_amendment_sha256, previous.amendment_sha256); assert.deepEqual(item.reservation.plan, predecessor.plan);
  const ledgerPath = join(prior.execution.control_root, 'ledger.jsonl'), rows = await ledger(ledgerPath);
  assert.equal(rows.at(-1)?.type, 'batch_closed'); assert.ok(!rows.some(row => row.type === 'analysis_revision_applied'));
  const starts = rows.filter(row => row.type === 'episode_started'), completed = rows.filter(row => row.type === 'episode_completed');
  assert.equal(starts.length, 1, 'A route amendment cannot discard other observations'); assert.equal(completed.length, 1);
  const event = completed[0]; assert.equal(event.run_id, change.run_id); assert.equal(starts[0].run_id, change.run_id);
  assert.equal(event.slot_id, prior.slots[0].slot_id); assert.equal(item.reservation.slot_id, event.slot_id);
  assert.equal(event.result.stop_batch, true); assert.equal(event.result.status, 'invalid');
  const root = event.result.run_root; assert.equal(root, join(environmentRoot, 'runs', change.run_id));
  const runtimeRef = await ref(join(root, 'benchmark/runtime/episode-result.json')), sharedRef = await ref(join(root, 'result.json'));
  const { episode } = await readEvidenceBundle({ directory: event.result.normalized_directory, rawRoot: environmentRoot });
  assert.equal(episode.episode_sha256, event.result.episode_sha256); assert.equal(episode.identity.run_id, change.run_id);
  assert.equal(episode.identity.experiment_id, prior.id); assert.equal(episode.identity.case_id, prior.slots[0].case_id);
  assert.equal(episode.identity.condition_id, prior.slots[0].condition_id);
  const condition = prior.protocol.conditions.find(item => item.id === prior.slots[0].condition_id);
  assert.equal(condition.model_id, change.from_model_id); assert.equal(episode.identity.environment_sha256, condition.environment_sha256);
  const model = prior.protocol.models.find(model => model.id === condition.model_id);
  const auth = await assertManualAuthRejection({ episode, runtime: await verified(runtimeRef), shared: await verified(sharedRef), environmentRoot, model });
  const usage = { model_requests: 1, input_tokens: null, output_tokens: null, duration_ms: episode.timing.duration_ms.value };
  assert.deepEqual(event.result.budget_usage, usage);
  const budget = prior.protocol.policies.budgets.find(budget => budget.id === condition.budget_id);
  const history = structuredClone(previous.history);
  history.reservations.push({ ordinal, reference: item.reference });
  history.plans.push({ plan: predecessor.plan, ledger: await ref(ledgerPath), analysis_revision: null });
  history.episodes.push({ run_id: change.run_id, pilot_ordinal: ordinal, experiment_id: prior.id,
    directory: event.result.normalized_directory, episode_sha256: episode.episode_sha256, admission: 'invalid', budget_usage: usage,
    quality_credit: 'excluded_from_new_scope', stop_batch: true, runtime: runtimeRef, shared: sharedRef, authentication_observation: auth });
  history.scheduled_episodes++; history.known_subtotal.model_requests++; history.known_subtotal.duration_ms += usage.duration_ms;
  history.unknown_usage_run_ids = sorted([...history.unknown_usage_run_ids, change.run_id]); history.total_usage_status = 'incomplete';
  history.administrative_holds = [{ run_id: change.run_id, basis: 'prior_frozen_episode_allocation', budget_id: budget.id,
    allocation: budget.episode, monetary: budget.monetary, actual_usage: 'unknown', proven_actual_upper_bound: false,
    accounting: 'allocation_hold_only_not_added_to_observed_usage_or_reservation_count' }];
  if (expected) assert.deepEqual(history, expected, 'PILOT_SCOPE_ROUTE_HISTORY_CHANGED');
  return { history, previous, prior };
}

export async function preparePilotScope({ setup, protocol, execution, slots, captures = [] }) {
  const input = setup.pilot_scope; if (!input) return undefined;
  assert.equal(protocol.phase, 'pilot');
  if (input.role === 'expansion') {
    assert.ok(input.amendment); const amendment = await readPilotScopeAmendment(input.amendment);
    assert.equal(input.id, amendment.id);
    const registration = { id: input.id, role: input.role, amendment: input.amendment };
    assertScopePlan({ id: protocol.id, protocol, execution: { ...execution, pilot_scope: registration }, slots }, amendment);
    return registration;
  }
  assert.equal(input.role, 'gate'); assert.ok(typeof input.authorization === 'string' && input.authorization.trim().length > 0);
  if (isProspectiveCohort(input)) {
    assert.ok(input.predecessor?.registration && input.predecessor?.amendment, 'COHORT_PREDECESSOR_REQUIRED');
    const predecessor = await readPilotScopeAmendment(input.predecessor.amendment);
    const previous = await verified(input.predecessor.registration);
    assert.equal(previous.id, predecessor.id); assert.deepEqual(previous.amendment, input.predecessor.amendment);
    const amendment = await prepareProspectiveCohort({ setup, protocol, execution, slots, predecessor });
    const path = join(execution.control_root, 'pilot-scope-amendment.json');
    const registration = { id: input.id, role: input.role, amendment: { path, sha256: sha(JSON.stringify(amendment, null, 2) + '\n') } };
    assertScopePlan({ id: protocol.id, protocol, execution: { ...execution, pilot_scope: registration }, slots }, amendment);
    await save(path, amendment); return registration;
  }
  let history, successor = {};
  if (input.manual_route_replacement) {
    assert.ok(input.predecessor && !input.zero_send_repair);
    assert.ok(typeof input.manual_route_replacement.reason === 'string' && input.manual_route_replacement.reason.trim());
    const predecessor = { ...input.predecessor, registration: await ref(join(execution.pilot_ledger_root, 'scope-registration-002.json')) };
    const prior = await verified(predecessor.plan);
    const change = { ...input.manual_route_replacement, kind: 'named-same-variant-auth-route-replacement',
      model_registry_before: { path: prior.execution.models_file, sha256: prior.execution.models_sha256 },
      model_registry_after: { path: execution.models_file, sha256: execution.models_sha256 },
      captures: await Promise.all(captures.map(async capture => ({ run_id: capture.raw.run_id, model_id: capture.model.id, mode: capture.candidate.mode,
        expectation: capture.expectation, runtime: await ref(capture.raw.result_path), shared: await ref(join(capture.raw.root, 'result.json')) }))) };
    const evidence = await manualRouteHistory({ predecessor, change, environmentRoot: execution.environment_root });
    assert.notEqual(input.id, evidence.previous.id); assert.equal(execution.pilot_ledger_root, evidence.previous.pilot_ledger_root);
    assert.deepEqual(execution.instrumentation, evidence.prior.execution.instrumentation, 'PILOT_SCOPE_ROUTE_APPARATUS_CHANGED');
    assert.deepEqual(slots, evidence.prior.slots, 'The manual route amendment preserves the complete gate schedule');
    await verifyManualRouteCaptures({ change, prior: evidence.prior, protocol, environmentRoot: execution.environment_root });
    history = evidence.history; successor = { predecessor, manual_route_replacement: change, route_protocol: protocol };
  } else if (input.predecessor) {
    assert.ok(typeof input.zero_send_repair?.reason === 'string' && input.zero_send_repair.reason.trim());
    const predecessor = { ...input.predecessor, registration: await ref(join(execution.pilot_ledger_root, 'scope-registration.json')) };
    const repair = { kind: 'final-request-contract-zero-send', ...input.zero_send_repair,
      captures: await Promise.all(captures.map(async capture => ({ run_id: capture.raw.run_id, model_id: capture.model.id, mode: capture.candidate.mode,
        expectation: capture.expectation, runtime: await ref(capture.raw.result_path), shared: await ref(join(capture.raw.root, 'result.json')) }))) };
    const evidence = await successorHistory({ predecessor, repair, environmentRoot: execution.environment_root });
    assert.notEqual(input.id, evidence.previous.id); assert.equal(execution.pilot_ledger_root, evidence.previous.pilot_ledger_root);
    assert.deepEqual(slots, evidence.prior.slots, 'A zero-send apparatus repair preserves the complete gate schedule');
    await verifyRepairCaptures({ repair, prior: evidence.prior, protocol, environmentRoot: execution.environment_root });
    history = evidence.history; successor = { predecessor, zero_send_repair: repair, repair_protocol: protocol };
  } else {
    assert.ok(!input.zero_send_repair);
    assert.ok(Array.isArray(input.history_plan_files) && input.history_plan_files.length > 0);
    history = await historicalAccounting({ planFiles: input.history_plan_files, pilotLedgerRoot: execution.pilot_ledger_root,
      environmentRoot: execution.environment_root });
  }
  assert.deepEqual(sorted(input.acknowledged_unknown_run_ids ?? []), history.unknown_usage_run_ids, 'PILOT_SCOPE_UNKNOWN_ACK_MISMATCH');
  const amendment = { version: input.manual_route_replacement ? 3 : input.predecessor ? 2 : 1, kind: 'benchmark-pilot-scope-amendment', id: input.id, ...successor,
    authorization: input.authorization, registered_at: protocol.registered_at,
    environment_root: execution.environment_root, pilot_ledger_root: execution.pilot_ledger_root, max_scheduled_episodes: 144,
    legacy_first24: { status: 'incomplete_not_satisfied', scheduled_episodes: 24 }, history,
    model_conditions: sorted(protocol.models.map(scopeModelIdentity)), environment_conditions: sorted(protocol.environments.map(scopeEnvironmentIdentity)),
    instrumentation: execution.instrumentation, observer_version: protocol.policies.evidence.observer_version,
    gate: { experiment_id: protocol.id, control_root: execution.control_root, scheduled_episodes: 16,
      minimum_valid_real_per_condition: 4, slots }, amendment_sha256: null };
  amendment.amendment_sha256 = fingerprint(amendment);
  const path = join(execution.control_root, 'pilot-scope-amendment.json');
  const registration = { id: input.id, role: input.role, amendment: { path, sha256: sha(JSON.stringify(amendment, null, 2) + '\n') } };
  assertScopePlan({ id: protocol.id, protocol, execution: { ...execution, pilot_scope: registration }, slots }, amendment);
  await save(path, amendment); return registration;
}

export async function readPilotScopeAmendment(reference) {
  const value = await verified(reference);
  if (isProspectiveCohort(value)) {
    const predecessor = await readPilotScopeAmendment(value.predecessor.amendment);
    const previous = await verified(value.predecessor.registration);
    assert.equal(previous.id, predecessor.id); assert.deepEqual(previous.amendment, value.predecessor.amendment);
    assert.notEqual(value.id, predecessor.id); assert.equal(value.pilot_ledger_root, predecessor.pilot_ledger_root);
    assert.ok(value.history.scheduled_episodes >= predecessor.history.scheduled_episodes, 'COHORT_HISTORY_PREFIX_TRUNCATED');
    if (isProspectiveCohort(predecessor)) {
      assert.deepEqual(value.history_exemption, predecessor.history_exemption, 'COHORT_HISTORY_EXEMPTION_CHANGED');
      assert.equal(value.history.scheduled_episodes, predecessor.history.scheduled_episodes + predecessor.reservation_limit, 'COHORT_PREDECESSOR_INCOMPLETE');
      const previousEpisodes = value.history.episodes.slice(predecessor.history.scheduled_episodes);
      for (const [role, phase] of Object.entries({ gate: predecessor.gate, expansion: predecessor.expansion })) {
        assert.equal(previousEpisodes.filter(episode => episode.experiment_id === phase.experiment_id).length,
          phase.scheduled_episodes, 'COHORT_PREDECESSOR_PHASE_INCOMPLETE');
        const entry = value.history.plans.find(item => item.plan.path === join(phase.control_root, 'plan.json'));
        assert.ok(entry, 'COHORT_PREDECESSOR_PLAN_MISSING');
        const owner = await verified(entry.plan); planIdentity(owner); assertScopePlan(owner, predecessor);
        assert.equal(owner.execution.pilot_scope.role, role); assert.deepEqual(owner.execution.pilot_scope.amendment, value.predecessor.amendment);
      }
      for (const entry of value.history.reservations.slice(predecessor.history.scheduled_episodes)) {
        const reservation = await verified(entry.reference);
        assert.equal(reservation.scope_id, predecessor.id); assert.equal(reservation.scope_amendment_sha256, predecessor.amendment_sha256);
        const phase = predecessor[reservation.scope_role]; assert.ok(phase && ['gate', 'expansion'].includes(reservation.scope_role));
        assert.equal(reservation.experiment_id, phase.experiment_id);
        assert.equal(reservation.plan.path, join(phase.control_root, 'plan.json'));
      }
    } else assert.deepEqual(value.history_exemption, { scheduled_episodes: value.history.scheduled_episodes,
      unknown_usage_run_ids: value.history.unknown_usage_run_ids, checkpoint_sha256: fingerprint(value.history) }, 'COHORT_HISTORY_EXEMPTION_CHANGED');
    return verifyProspectiveCohort(value);
  }
  assert.ok([1, 2, 3].includes(value.version)); assert.equal(value.kind, 'benchmark-pilot-scope-amendment'); assert.ok(safe(value.id));
  assert.equal(value.amendment_sha256, fingerprint({ ...value, amendment_sha256: null }), 'PILOT_SCOPE_AMENDMENT_CHANGED');
  assert.equal(value.max_scheduled_episodes, 144); assert.equal(value.gate.scheduled_episodes, 16);
  assert.equal(value.gate.minimum_valid_real_per_condition, 4);
  assert.deepEqual(value.legacy_first24, { status: 'incomplete_not_satisfied', scheduled_episodes: 24 });
  if (value.version === 1) {
    assert.equal(value.predecessor, undefined); assert.equal(value.zero_send_repair, undefined);
    assert.equal(value.manual_route_replacement, undefined);
    await historicalAccounting({ planFiles: value.history.plans.map(item => item.plan.path), pilotLedgerRoot: value.pilot_ledger_root,
      environmentRoot: value.environment_root, expected: value.history });
  } else if (value.version === 2) {
    assert.equal(value.manual_route_replacement, undefined);
    assert.equal(value.zero_send_repair.kind, 'final-request-contract-zero-send');
    const { prior, previous } = await successorHistory({ predecessor: value.predecessor, repair: value.zero_send_repair,
      environmentRoot: value.environment_root, expected: value.history });
    assert.equal(value.pilot_ledger_root, previous.pilot_ledger_root); assert.notEqual(value.id, previous.id);
    assert.deepEqual(value.gate.slots, prior.slots);
    assert.equal(value.repair_protocol.id, value.gate.experiment_id);
    assert.deepEqual(value.model_conditions, previous.model_conditions);
    assert.deepEqual(value.environment_conditions, sorted(value.repair_protocol.environments.map(scopeEnvironmentIdentity)));
    await verifyRepairCaptures({ repair: value.zero_send_repair, prior, protocol: value.repair_protocol, environmentRoot: value.environment_root });
  } else {
    assert.equal(value.manual_route_replacement.kind, 'named-same-variant-auth-route-replacement');
    assert.equal(value.zero_send_repair, undefined);
    const { prior, previous } = await manualRouteHistory({ predecessor: value.predecessor, change: value.manual_route_replacement,
      environmentRoot: value.environment_root, expected: value.history });
    assert.equal(value.pilot_ledger_root, previous.pilot_ledger_root); assert.notEqual(value.id, previous.id);
    assert.deepEqual(value.gate.slots, prior.slots); assert.equal(value.route_protocol.id, value.gate.experiment_id);
    assert.deepEqual(value.instrumentation, prior.execution.instrumentation, 'PILOT_SCOPE_ROUTE_APPARATUS_CHANGED');
    assert.deepEqual(value.model_conditions, sorted(value.route_protocol.models.map(scopeModelIdentity)));
    assert.deepEqual(value.environment_conditions, sorted(value.route_protocol.environments.map(scopeEnvironmentIdentity)));
    await verifyManualRouteCaptures({ change: value.manual_route_replacement, prior, protocol: value.route_protocol, environmentRoot: value.environment_root });
  }
  return value;
}

/** Read effective analysis without changing any original completion or reservation.
 * A caller may propose a fully verified revision only for this exact plan. Other
 * plans are read using their own append-only revision registration. */
export async function readScopeCompletedResults(plan, { analysisRevisionReference, analysisRevision } = {}) {
  const rows = await ledger(join(plan.execution.control_root, 'ledger.jsonl'));
  const applied = rows.filter(row => row.type === 'analysis_revision_applied');
  assert.ok(applied.length <= 1, 'PILOT_SCOPE_REVISION_CHAIN_UNSUPPORTED');
  assert.equal(Boolean(analysisRevisionReference), Boolean(analysisRevision), 'PILOT_SCOPE_VERIFIED_REVISION_REQUIRED');
  const reference = analysisRevisionReference ?? applied[0]?.reference ?? null;
  if (analysisRevisionReference && applied.length)
    assert.deepEqual(analysisRevisionReference, applied[0].reference, 'PILOT_SCOPE_OTHER_REGISTERED_REVISION');
  let revision = null;
  if (reference) {
    revision = await verifyAnalysisRevision({ reference, plan });
    if (analysisRevision) assert.deepEqual(analysisRevision, revision, 'PILOT_SCOPE_REVISION_OBJECT_CHANGED');
    assert.deepEqual(revision.instrumentation, plan.execution.instrumentation, 'PILOT_SCOPE_REVISION_INSTRUMENTATION_CHANGED');
  }
  const completed = rows.filter(row => row.type === 'episode_completed').map(event => {
    const replacement = revision?.replacements.find(item => item.run_id === event.run_id);
    if (!replacement) return event;
    assert.equal(event.result.episode_sha256, replacement.original_episode_sha256, 'PILOT_SCOPE_REVISION_ORIGINAL_CHANGED');
    assert.equal(event.slot_id, replacement.slot_id);
    return { ...event, result: { ...event.result, normalized_directory: replacement.directory,
      episode_sha256: replacement.new_episode_sha256, budget_usage: replacement.budget_usage,
      stop_batch: false, stop_reason: null, analysis_revision: reference },
      revision_provenance: { analysis_revision: reference, original_episode_sha256: event.result.episode_sha256,
        original_directory: event.result.normalized_directory } };
  });
  const recovery = await verifyCollectionRecoveryResults(plan, completed);
  return { rows, completed, analysis_revision: reference, revision,
    ...(recovery ? { collection_recovery: recovery.reference } : {}) };
}

/** Recheck every later reservation, so another control root cannot forget a stop. */
export async function verifyPilotScope(plan, revisionOptions = {}) {
  const registration = plan.execution.pilot_scope;
  if (!registration) { assert.equal(plan.protocol.policies.pilot.scope, undefined); return null; }
  const amendment = await readPilotScopeAmendment(registration.amendment); assertScopePlan(plan, amendment);
  const all = await reservations(amendment.pilot_ledger_root), ownerResults = new Map();
  const cohort = isProspectiveCohort(amendment), reservedSlots = new Set();
  if (cohort) {
    const scheduled = all.length - amendment.history.scheduled_episodes;
    assert.ok(scheduled <= amendment.reservation_limit, 'COHORT_RESERVATION_LIMIT');
    if (revisionOptions.forReservation && scheduled === amendment.reservation_limit)
      throw Object.assign(new Error('The registered cohort reservation limit is exhausted'), { code: 'COHORT_CAP' });
  }
  if (revisionOptions.analysisRevisionReference || revisionOptions.analysisRevision)
    ownerResults.set(plan.plan_sha256, await readScopeCompletedResults(plan, revisionOptions));
  for (const item of all.slice(amendment.history.scheduled_episodes)) {
    const reservation = item.reservation;
    assert.equal(reservation.scope_amendment_sha256, amendment.amendment_sha256, 'PILOT_SCOPE_FOREIGN_RESERVATION');
    assert.equal(reservation.scope_id, amendment.id);
    const owner = await verified(reservation.plan); planIdentity(owner); assertScopePlan(owner, amendment);
    const { validateBatchPlan } = await import('./batch.mjs'); validateBatchPlan(owner);
    assert.equal(owner.plan_sha256, reservation.plan_sha256); assert.equal(owner.id, reservation.experiment_id);
    assert.equal(reservation.plan.path, join(owner.execution.control_root, 'plan.json'));
    assert.deepEqual(owner.execution.pilot_scope.amendment, registration.amendment);
    const slot = owner.slots.find(slot => slot.slot_id === reservation.slot_id); assert.ok(slot, 'PILOT_SCOPE_UNKNOWN_SLOT');
    if (cohort) {
      const key = owner.id + '/' + slot.slot_id;
      assert.ok(!reservedSlots.has(key), 'COHORT_DUPLICATE_RESERVED_SLOT'); reservedSlots.add(key);
      assert.equal(reservation.scope_role, owner.execution.pilot_scope.role, 'COHORT_RESERVATION_ROLE_CHANGED');
    }
    if (!ownerResults.has(owner.plan_sha256)) ownerResults.set(owner.plan_sha256,
      await readScopeCompletedResults(owner, owner.plan_sha256 === plan.plan_sha256 ? revisionOptions : {}));
    const { rows, completed: effective } = ownerResults.get(owner.plan_sha256);
    const starts = rows.filter(row => row.type === 'episode_started' && row.run_id === reservation.run_id);
    assert.equal(starts.length, 1, 'PILOT_SCOPE_ORPHAN_RESERVATION');
    const completed = effective.filter(row => row.run_id === reservation.run_id);
    assert.ok(completed.length <= 1, 'PILOT_SCOPE_DUPLICATE_RESULT');
    if (!completed.length) {
      assert.equal(owner.plan_sha256, plan.plan_sha256, 'PILOT_SCOPE_UNRESOLVED_OTHER_PLAN');
      continue; // The same plan may reconcile retained evidence, never redispatch this slot.
    }
    assert.equal(Boolean(completed[0].result.stop_batch), false, 'PILOT_SCOPE_RETAINED_CORE_STOP');
    const result = completed[0].result;
    assert.ok(knownUsage(result.budget_usage), 'PILOT_SCOPE_UNKNOWN_NEW_USAGE');
    const { episode } = await readEvidenceBundle({ directory: result.normalized_directory, rawRoot: amendment.environment_root });
    assert.equal(episode.episode_sha256, result.episode_sha256, 'PILOT_SCOPE_NEW_EVIDENCE_CHANGED');
    assert.equal(episode.identity.run_id, reservation.run_id); assert.equal(episode.identity.experiment_id, owner.id);
    assert.equal(episode.identity.condition_id, slot.condition_id); assert.equal(episode.identity.case_id, slot.case_id);
    const condition = owner.protocol.conditions.find(condition => condition.id === slot.condition_id);
    const environment = owner.protocol.environments.find(environment => environment.id === condition.environment_id);
    assert.equal(episode.identity.model_id, condition.model_id);
    if (cohort) assertCohortModelEvidence(episode, owner.protocol.models.find(model => model.id === condition.model_id));
    assert.equal(episode.identity.environment_sha256, environment.manifest_sha256); assert.equal(episode.identity.build_id, environment.build.id);
    assert.equal(episode.admission.status, 'valid', 'PILOT_SCOPE_NEW_CORE_INVALID');
    for (const key of ['attempts', 'tools', 'interventions']) assert.equal(episode.admission.completeness[key], 'complete', 'PILOT_SCOPE_NEW_CORE_INCOMPLETE');
    assert.equal(episode.measurements.actual_attempts.status, 'known');
    assert.ok(episode.measurements.actual_attempts.value > 0, 'PILOT_SCOPE_NO_REAL_SEND');
    assert.equal(episode.measurements.input_total.value.status, 'known', 'PILOT_SCOPE_UNKNOWN_NEW_USAGE');
    assert.equal(episode.measurements.output_total.value.status, 'known', 'PILOT_SCOPE_UNKNOWN_NEW_USAGE');
    assert.equal(episode.timing.duration_ms.status, 'known', 'PILOT_SCOPE_UNKNOWN_NEW_USAGE');
    assert.ok(episode.attempts.filter(attempt => attempt.sent).every(attempt => attempt.adapter.verified));
    assert.deepEqual(result.budget_usage, { model_requests: episode.measurements.actual_attempts.value,
      input_tokens: episode.measurements.input_total.value.value, output_tokens: episode.measurements.output_total.value.value,
      duration_ms: episode.timing.duration_ms.value }, 'PILOT_SCOPE_NEW_USAGE_MISMATCH');
  }
  return amendment;
}

export function scopeReservationFields(plan, amendment, planReference) {
  return { scope_id: amendment.id, scope_amendment_sha256: amendment.amendment_sha256,
    plan: planReference, plan_sha256: plan.plan_sha256, scope_role: plan.execution.pilot_scope.role };
}

/** All scopes in one campaign share a controller lease. Old per-scope leases
 * remain blocking until their dead owners have been explicitly reconciled. */
export async function acquirePilotScopeLease(plan, amendment) {
  const root = amendment.pilot_ledger_root, path = join(root, 'campaign.lease.json');
  const legacyLeases = (await readdir(root)).filter(name => /^scope-.+\.lease\.json$/.test(name));
  assert.equal(legacyLeases.length, 0, 'PILOT_SCOPE_LEGACY_LEASE_REQUIRES_RECONCILIATION');
  const lease = { id: randomUUID(), pid: process.pid, plan_sha256: plan.plan_sha256,
    scope_id: amendment.id, control_root: plan.execution.control_root, created_at: new Date().toISOString() };
  await writeFile(path, JSON.stringify(lease, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return async () => rename(path, join(root, 'campaign.lease-retained-' + lease.id + '.json'));
}

export async function reconcilePilotScopeLease({ plan, leaseId, batchLease }) {
  const registration = plan.execution.pilot_scope; if (!registration) return null;
  let path = join(plan.execution.pilot_ledger_root, 'campaign.lease.json'), lease;
  try { lease = await read(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    path = join(plan.execution.pilot_ledger_root, 'scope-' + registration.id + '.lease.json');
    try { lease = await read(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  assert.equal(lease.plan_sha256, plan.plan_sha256); assert.equal(lease.control_root, plan.execution.control_root);
  if (batchLease) { assert.equal(lease.pid, batchLease.pid); assert.equal(batchLease.id, leaseId); }
  else assert.equal(lease.id, leaseId, 'Scope-only recovery must name the observed dead scope lease');
  let alive = true; try { process.kill(lease.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
  assert.equal(alive, false, 'Scope lease owner is still alive');
  const retained = join(plan.execution.pilot_ledger_root, 'scope-' + registration.id + '.lease-reconciled-' + lease.id + '.json');
  await rename(path, retained);
  return { scope_lease_id: lease.id, retained, model_requests: 0 };
}

export async function checkCampaignScope(plan, { activate = false } = {}) {
  if (plan.protocol.phase !== 'pilot') return;
  const path = join(plan.execution.pilot_ledger_root, 'scope-registration.json');
  let existing;
  try { existing = await read(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const registration = plan.execution.pilot_scope;
  if (existing) {
    assert.ok(registration, 'PILOT_SCOPE_REQUIRED_FOR_ACTIVE_CAMPAIGN');
    let latest = { value: existing, reference: await ref(path), sequence: 1 };
    const names = (await readdir(plan.execution.pilot_ledger_root)).filter(name => /^scope-registration-\d{3}\.json$/.test(name)).sort();
    for (const [index, name] of names.entries()) {
      const sequence = index + 2, successorPath = join(plan.execution.pilot_ledger_root, name);
      assert.equal(name, 'scope-registration-' + String(sequence).padStart(3, '0') + '.json', 'PILOT_SCOPE_REGISTRATION_GAP');
      const successor = await read(successorPath);
      assert.equal(successor.version, 1); assert.equal(successor.sequence, sequence);
      assert.deepEqual(successor.predecessor, latest.reference, 'PILOT_SCOPE_REGISTRATION_HISTORY_CHANGED');
      const amendment = await readPilotScopeAmendment(successor.amendment);
      if (isProspectiveCohort(amendment)) assert.equal(successor.kind, 'benchmark-prospective-cohort-succession');
      else {
        assert.ok(sequence === 2 || sequence === 3, 'PILOT_SCOPE_LEGACY_SUCCESSION_CLOSED');
        assert.equal(successor.kind, sequence === 2 ? 'benchmark-zero-send-scope-succession' : 'benchmark-manual-auth-route-succession');
        assert.equal(amendment.version, sequence);
      }
      assert.equal(amendment.id, successor.id);
      assert.deepEqual(amendment.predecessor.registration, latest.reference);
      assert.deepEqual(amendment.predecessor.amendment, latest.value.amendment);
      latest = { value: { id: successor.id, amendment: successor.amendment }, reference: await ref(successorPath), sequence };
    }
    const wanted = { id: registration.id, amendment: registration.amendment };
    if (fingerprint(latest.value) === fingerprint(wanted)) return;
    const amendment = await readPilotScopeAmendment(registration.amendment);
    const prospective = isProspectiveCohort(amendment);
    if (!prospective) assert.ok(latest.sequence < 3 && amendment.version === latest.sequence + 1, 'PILOT_SCOPE_OTHER_ACTIVE_AMENDMENT');
    assert.deepEqual(amendment.predecessor.registration, latest.reference, 'PILOT_SCOPE_OTHER_ACTIVE_AMENDMENT');
    assert.deepEqual(latest.value, { id: (await readPilotScopeAmendment(amendment.predecessor.amendment)).id,
      amendment: amendment.predecessor.amendment });
    if (activate) await save(join(plan.execution.pilot_ledger_root, 'scope-registration-' + String(latest.sequence + 1).padStart(3, '0') + '.json'),
      { version: 1, kind: prospective ? 'benchmark-prospective-cohort-succession'
        : amendment.version === 2 ? 'benchmark-zero-send-scope-succession' : 'benchmark-manual-auth-route-succession',
        sequence: latest.sequence + 1, predecessor: latest.reference, ...wanted });
  } else if (registration) {
    const amendment = await readPilotScopeAmendment(registration.amendment);
    assert.ok(!isProspectiveCohort(amendment) && amendment.version === 1, 'A successor requires the retained original campaign registration');
    if (activate) await save(path, { id: registration.id, amendment: registration.amendment });
  }
}
