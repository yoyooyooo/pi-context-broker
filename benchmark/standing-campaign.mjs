import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fingerprint } from './protocol.mjs';
import { verifyExecutionImplementation } from './implementation.mjs';
import { readEvidenceBundle } from './evidence/store.mjs';
import { assertCohortModelEvidence } from './prospective-cohort.mjs';

export const STANDING_CAMPAIGN = 'benchmark-standing-campaign';
export const STANDING_WORK_PLAN = 'benchmark-standing-work-plan';
export const isStandingCampaign = value => value?.kind === STANDING_CAMPAIGN;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safe = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const canonical = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path;
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'STANDING_RECORD_FIELDS_CHANGED');
const resources = ['model_requests', 'input_tokens', 'output_tokens', 'duration_ms'];
const knownUsage = usage => resources.every(key => Number.isFinite(usage?.[key]) && usage[key] >= 0);
const reference = (path, bytes) => ({ path, sha256: sha(bytes) });
const timestamp = value => assert.ok(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'STANDING_TIMESTAMP_REQUIRED');

async function record(path) {
  assert.ok(canonical(path), 'STANDING_CANONICAL_FILE_REQUIRED');
  assert.ok((await lstat(path)).isFile(), 'STANDING_ORDINARY_FILE_REQUIRED');
  assert.equal(await realpath(path), path, 'STANDING_FILE_SYMLINK');
  const bytes = await readFile(path);
  return { value: JSON.parse(bytes), reference: reference(path, bytes) };
}
async function verified(ref) {
  keys(ref, ['path', 'sha256']); assert.match(ref.sha256, /^[a-f0-9]{64}$/);
  const actual = await record(ref.path); assert.deepEqual(actual.reference, ref, 'STANDING_REFERENCE_CHANGED');
  return actual.value;
}
async function save(path, value) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await readFile(path, 'utf8'), bytes, 'STANDING_EXISTING_RECORD_DIFFERS'); }
  return reference(path, bytes);
}
async function optional(path) {
  try { return await record(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function rowsAt(controlRoot) {
  let bytes;
  try { bytes = await readFile(join(controlRoot, 'ledger.jsonl')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  assert.ok(!bytes.length || bytes.at(-1) === 10, 'STANDING_INCOMPLETE_LEDGER');
  const rows = bytes.toString().split('\n').filter(Boolean).map(JSON.parse);
  rows.forEach((row, index) => assert.equal(row.seq, index + 1, 'STANDING_LEDGER_SEQUENCE_CHANGED'));
  return rows;
}

/** The grant has no expiry, allocation, batch count or resource ceiling. */
export async function readStandingAuthorization(ref) {
  const value = await verified(ref);
  keys(value, ['version', 'kind', 'id', 'approved', 'source', 'user_message', 'recorded_at_utc', 'task',
    'authorization_expiry', 'per_batch_approval_required', 'resource_policy', 'supervised_recovery_authorized']);
  assert.equal(value.version, 1); assert.equal(value.kind, 'user-standing-benchmark-authorization');
  assert.ok(safe(value.id)); assert.equal(value.approved, true); assert.equal(value.source, 'current-user-message');
  assert.ok(typeof value.user_message === 'string' && value.user_message.trim()); timestamp(value.recorded_at_utc);
  assert.equal(value.task, 'Notion Skills Benchmark'); assert.equal(value.authorization_expiry, null);
  assert.equal(value.per_batch_approval_required, false); assert.equal(value.supervised_recovery_authorized, true);
  assert.deepEqual(value.resource_policy, { mode: 'unbounded' });
  return { value, reference: structuredClone(ref) };
}

async function verifyControllerFiles(controller) {
  keys(controller, ['source_root', 'implementation']); assert.ok(canonical(controller.source_root));
  assert.equal(await realpath(controller.source_root), controller.source_root);
  const implementation = controller.implementation;
  assert.equal(implementation.version, 1); assert.equal(implementation.sha256, fingerprint(implementation.files));
  assert.deepEqual(implementation.files.map(item => item.path), [...new Set(implementation.files.map(item => item.path))].sort((a, b) => a.localeCompare(b)));
  for (const item of implementation.files) {
    const path = resolve(controller.source_root, 'benchmark', item.path);
    assert.ok(path.startsWith(controller.source_root + '/'), 'STANDING_CONTROLLER_OUTSIDE_SOURCE');
    assert.ok((await lstat(path)).isFile()); assert.equal(await realpath(path), path);
    const bytes = await readFile(path); assert.equal(sha(bytes), item.sha256, 'STANDING_CONTROLLER_CHANGED'); assert.equal(bytes.length, item.bytes);
  }
  assert.ok(implementation.files.some(item => item.path === 'implementation.mjs'));
  const producer = await import(pathToFileURL(join(controller.source_root, 'benchmark/implementation.mjs')));
  assert.deepEqual(await producer.executionImplementation(), implementation, 'STANDING_CONTROLLER_CLOSURE_CHANGED');
}

/** Bootstrap once with the byte-verified historical producer. Later live checks
 * bind this immutable receipt and do not replay all historical observations. */
export async function createStandingHistoryBaseline({ id, historicalAuthorization, controller, publishedEvidence = [] }) {
  assert.ok(safe(id)); await verifyControllerFiles(controller);
  assert.ok(controller.implementation.files.some(item => item.path === 'approved-campaign.mjs'));
  const reader = await import(pathToFileURL(join(controller.source_root, 'benchmark/approved-campaign.mjs')));
  const authorized = await reader.readApprovedCampaign(historicalAuthorization);
  const history = authorized.value.history; assert.ok(history && Number.isSafeInteger(history.scheduled_episodes));
  const ledgerRoot = authorized.value.pilot_ledger_root;
  const names = (await readdir(ledgerRoot)).filter(name => /^scope-registration(?:-\d{3,})?\.json$/.test(name))
    .sort((a, b) => registrationNumber(a) - registrationNumber(b));
  const registrations = [];
  for (const [index, name] of names.entries()) {
    assert.equal(registrationNumber(name), index + 1, 'STANDING_HISTORICAL_REGISTRATION_GAP');
    registrations.push((await record(join(ledgerRoot, name))).reference);
  }
  for (const ref of publishedEvidence) await verified(ref);
  assert.equal(await optional(join(ledgerRoot, 'campaign.lease.json')), null, 'STANDING_HISTORICAL_LEASE_ACTIVE');
  assert.ok(!(await readdir(ledgerRoot)).some(name => /^scope-.+\.lease\.json$/.test(name)), 'STANDING_HISTORICAL_LEASE_ACTIVE');
  return { version: 1, kind: 'benchmark-standing-history-baseline', id, environment_root: authorized.value.environment_root,
    ledger_root: ledgerRoot, historical_authorization: structuredClone(historicalAuthorization), controller: structuredClone(controller),
    observations: history.scheduled_episodes, registrations: registrations.length, registration_refs: registrations,
    history: structuredClone(history), published_evidence: structuredClone(publishedEvidence), verified_at: new Date().toISOString() };
}

export async function readStandingHistoryBaseline(ref) {
  const value = await verified(ref);
  keys(value, ['version', 'kind', 'id', 'environment_root', 'ledger_root', 'historical_authorization', 'controller',
    'observations', 'registrations', 'registration_refs', 'history', 'published_evidence', 'verified_at']);
  assert.equal(value.version, 1); assert.equal(value.kind, 'benchmark-standing-history-baseline'); assert.ok(safe(value.id));
  assert.ok(canonical(value.environment_root) && canonical(value.ledger_root)); timestamp(value.verified_at);
  assert.ok(Number.isSafeInteger(value.observations) && value.observations >= 0);
  assert.ok(Number.isSafeInteger(value.registrations) && value.registrations >= 0);
  assert.equal(value.history.scheduled_episodes, value.observations); assert.equal(value.registration_refs.length, value.registrations);
  assert.equal(value.history.reservations.length, value.observations); assert.equal(value.history.episodes.length, value.observations);
  await verified(value.historical_authorization);
  for (const item of value.registration_refs) await verified(item);
  for (const item of value.published_evidence) await verified(item);
  return { value, reference: structuredClone(ref) };
}

export async function readStandingWorkPlan({ authorization, workPlan }) {
  const grant = await readStandingAuthorization(authorization), value = await verified(workPlan);
  keys(value, ['version', 'kind', 'id', 'task', 'environment_root', 'authorization', 'resource_policy', 'condition_epoch',
    'controller', 'baseline', 'entries', 'created_at']);
  assert.equal(value.version, 1); assert.equal(value.kind, STANDING_WORK_PLAN); assert.ok(safe(value.id));
  assert.equal(value.task, grant.value.task); assert.deepEqual(value.authorization, authorization);
  assert.deepEqual(value.resource_policy, grant.value.resource_policy); assert.ok(canonical(value.environment_root)); timestamp(value.created_at);
  keys(value.condition_epoch, ['id', 'started_at', 'authorization']); assert.ok(safe(value.condition_epoch.id)); timestamp(value.condition_epoch.started_at);
  assert.deepEqual(value.condition_epoch.authorization, authorization);
  const baseline = await readStandingHistoryBaseline(value.baseline); assert.equal(baseline.value.environment_root, value.environment_root);
  await verifyControllerFiles(value.controller); await verifyExecutionImplementation(value.controller.implementation);
  assert.ok(Array.isArray(value.entries) && value.entries.length > 0);
  assert.equal(new Set(value.entries.map(item => item.id)).size, value.entries.length, 'STANDING_DUPLICATE_WORK_ITEM');
  for (const item of value.entries) {
    keys(item, ['id', 'setup', 'planned_episodes']); assert.ok(safe(item.id));
    assert.ok(Number.isSafeInteger(item.planned_episodes) && item.planned_episodes > 0);
    const setup = await verified(item.setup); assert.equal(setup.standing, undefined, 'STANDING_TEMPLATE_SELF_REFERENCE');
    assert.equal(setup.campaign_scope, undefined); assert.equal(setup.pilot_scope, undefined);
    assert.equal(setup.environment_root, value.environment_root); assertUnboundedSetup(setup, value.condition_epoch);
  }
  return { authorization: grant, workPlan: { value, reference: structuredClone(workPlan) }, items: value.entries,
    baseline, controller: value.controller, resourcePolicy: value.resource_policy, conditionEpoch: value.condition_epoch };
}

function assertUnboundedSetup(setup, epoch) {
  assert.equal(setup.budget?.mode, 'unbounded');
  for (const key of ['max_duration_ms', 'max_model_requests', 'max_input_tokens', 'max_output_tokens', 'max_http_attempts', 'max_retries'])
    assert.equal(setup.budget.episode[key], null, 'STANDING_EPISODE_QUOTA_FORBIDDEN');
  for (const key of ['max_duration_ms', 'max_model_requests', 'max_input_tokens', 'max_output_tokens', 'max_episodes'])
    assert.equal(setup.budget.batch[key], null, 'STANDING_BATCH_QUOTA_FORBIDDEN');
  assert.equal(setup.budget.batch.max_concurrency, 1); assert.equal(setup.budget.monetary.max_amount, null);
  assert.deepEqual(setup.models.window, { mode: 'standing', start: epoch.started_at, end: null });
}
export function standingSetupProjection(setup) {
  const { id, control_root, standing, ...science } = setup;
  return science;
}
export async function assertStandingSetup(setup) {
  const input = setup.standing; keys(input, ['authorization', 'work_plan', 'work_item_id', 'attempt_id', 'ledger_root']);
  assert.equal(setup.pilot_scope, undefined); assert.equal(setup.campaign_scope, undefined); assert.equal(setup.resumption, undefined);
  assert.equal(setup.pilot_ledger_root, undefined, 'STANDING_LEDGER_USES_STANDING_BINDING');
  assert.ok(safe(input.attempt_id)); assert.equal(setup.id, input.attempt_id);
  assert.ok(canonical(input.ledger_root) && canonical(setup.control_root));
  const context = await readStandingWorkPlan({ authorization: input.authorization, workPlan: input.work_plan });
  assert.ok(input.ledger_root.startsWith(context.workPlan.value.environment_root + '/control/'));
  assert.ok(setup.control_root.startsWith(context.workPlan.value.environment_root + '/control/'));
  assert.notEqual(input.ledger_root, context.baseline.value.ledger_root, 'STANDING_HISTORY_LEDGER_IMMUTABLE');
  const item = context.items.find(item => item.id === input.work_item_id); assert.ok(item, 'STANDING_WORK_ITEM_REQUIRED');
  const template = await verified(item.setup);
  assert.deepEqual(standingSetupProjection(setup), standingSetupProjection(template), 'STANDING_SCIENTIFIC_TEMPLATE_CHANGED');
  return { ...context, item, attemptId: input.attempt_id, ledgerRoot: input.ledger_root };
}

export function standingCampaignPolicy(context, { scheduledEpisodes }) {
  assert.equal(scheduledEpisodes, context.item.planned_episodes, 'STANDING_SCIENTIFIC_COVERAGE_CHANGED');
  return { version: 1, kind: STANDING_CAMPAIGN, id: context.attemptId, role: 'task_continuation',
    authorization_id: context.authorization.value.id, work_plan_id: context.workPlan.value.id, work_item_id: context.item.id,
    condition_epoch: structuredClone(context.conditionEpoch), planned_episodes: scheduledEpisodes, resource_policy: { mode: 'unbounded' } };
}

function registrationNumber(name) { return name === 'scope-registration.json' ? 1 : Number(name.match(/\d+/)?.[0]); }
export function numericStandingNames(names, type = 'reservation') {
  const pattern = type === 'registration' ? /^scope-registration-(\d{3,})\.json$/ : /^(\d{3,})\.json$/;
  return names.filter(name => pattern.test(name)).map(name => ({ name, ordinal: Number(name.match(pattern)[1]) }))
    .sort((a, b) => a.ordinal - b.ordinal).map(item => {
      assert.ok(Number.isSafeInteger(item.ordinal) && item.ordinal > 0, 'STANDING_ORDINAL_INVALID');
      const expected = (type === 'registration' ? 'scope-registration-' : '') + String(item.ordinal).padStart(3, '0') + '.json';
      assert.equal(item.name, expected, 'STANDING_NONCANONICAL_ORDINAL'); return item;
    });
}

export async function inspectStandingLedger({ ledgerRoot, baseline: baselineReference }) {
  const baseline = await readStandingHistoryBaseline(baselineReference); assert.ok(canonical(ledgerRoot));
  assert.notEqual(ledgerRoot, baseline.value.ledger_root, 'STANDING_HISTORY_LEDGER_IMMUTABLE');
  let names;
  try { names = await readdir(ledgerRoot); assert.equal(await realpath(ledgerRoot), ledgerRoot); }
  catch (error) { if (error.code !== 'ENOENT') throw error; names = null; }
  const reservations = [], registrations = [], owners = new Map();
  const header = names ? await record(join(ledgerRoot, 'ledger-baseline.json')) : null;
  let previous = header;
  if (previous) {
    keys(previous.value, ['version', 'kind', 'baseline', 'authorization']); assert.equal(previous.value.version, 1);
    assert.equal(previous.value.kind, 'benchmark-standing-ledger'); assert.deepEqual(previous.value.baseline, baselineReference);
    await readStandingAuthorization(previous.value.authorization);
  }
  for (const { name, ordinal } of numericStandingNames(names ?? [])) {
    assert.equal(ordinal, baseline.value.observations + reservations.length + 1, 'STANDING_RESERVATION_GAP');
    reservations.push({ ordinal, ...await record(join(ledgerRoot, name)) });
  }
  for (const { name, ordinal: sequence } of numericStandingNames(names ?? [], 'registration')) {
    assert.equal(sequence, registrations.length + 1, 'STANDING_REGISTRATION_GAP');
    const actual = await record(join(ledgerRoot, name)), value = actual.value;
    keys(value, ['version', 'kind', 'sequence', 'global_sequence', 'predecessor', 'id', 'amendment', 'plan']);
    assert.equal(value.version, 1); assert.equal(value.kind, 'benchmark-standing-registration'); assert.equal(value.sequence, sequence);
    assert.equal(value.global_sequence, baseline.value.registrations + sequence); assert.deepEqual(value.predecessor, previous.reference);
    const amendment = await readStandingAmendment(value.amendment); assert.equal(amendment.id, value.id);
    assert.equal(amendment.pilot_ledger_root, ledgerRoot); assert.deepEqual(amendment.baseline, baselineReference);
    assert.deepEqual(amendment.authorization, header.value.authorization);
    const plan = await verified(value.plan); assert.equal(plan.id, value.id); assert.deepEqual(plan.execution.standing_scope.amendment, value.amendment);
    assert.equal(plan.execution.standing_scope.id, value.id); assert.equal(plan.execution.control_root, amendment.control_root);
    assert.equal(plan.execution.pilot_ledger_root, ledgerRoot);
    assert.equal(plan.plan_sha256, fingerprint({ ...plan, plan_sha256: null }));
    owners.set(value.id, { plan, amendment });
    registrations.push({ sequence, global_sequence: value.global_sequence, ...actual }); previous = actual;
  }
  assert.equal(new Set(registrations.map(item => item.value.id)).size, registrations.length, 'STANDING_DUPLICATE_ATTEMPT');
  assert.equal(new Set(reservations.map(item => item.value.run_id)).size, reservations.length, 'STANDING_DUPLICATE_RESERVED_RUN');
  for (const { value } of reservations) {
    const owner = registrations.find(item => item.value.id === value.scope_id); assert.ok(owner, 'STANDING_UNREGISTERED_RESERVATION');
    const { plan, amendment } = owners.get(value.scope_id);
    for (const [key, expected] of Object.entries(standingReservationFields(plan, amendment, owner.value.plan)))
      assert.deepEqual(value[key], expected, 'STANDING_RESERVATION_BINDING_CHANGED');
    assert.equal(value.experiment_id, plan.id);
  }
  return { exists: names !== null, baseline, history_observations: baseline.value.observations, history_registrations: baseline.value.registrations,
    local_observations: reservations.length, local_registrations: registrations.length,
    global_observations: baseline.value.observations + reservations.length, global_registrations: baseline.value.registrations + registrations.length,
    authorization: header?.value.authorization ?? null, reservations, registrations,
    lease: names ? (await optional(join(ledgerRoot, 'campaign.lease.json')))?.value ?? null : null };
}

export async function prepareStandingScope({ setup, protocol, execution, slots }) {
  const context = await assertStandingSetup(setup);
  assert.deepEqual(protocol.policies.campaign, standingCampaignPolicy(context, { scheduledEpisodes: slots.length }));
  assert.deepEqual(execution.implementation, context.controller.implementation);
  await mkdir(context.ledgerRoot, { recursive: true }); assert.equal(await realpath(context.ledgerRoot), context.ledgerRoot);
  await save(join(context.ledgerRoot, 'ledger-baseline.json'), { version: 1, kind: 'benchmark-standing-ledger',
    baseline: context.workPlan.value.baseline, authorization: context.authorization.reference });
  const boundary = await inspectStandingLedger({ ledgerRoot: context.ledgerRoot, baseline: context.workPlan.value.baseline });
  assert.equal(boundary.lease, null, 'STANDING_CAMPAIGN_LEASE_ACTIVE');
  assert.ok(!boundary.registrations.some(item => item.value.id === setup.id), 'STANDING_ATTEMPT_ALREADY_REGISTERED');
  const value = { version: 1, kind: STANDING_CAMPAIGN, id: setup.id, role: 'task_continuation',
    authorization: context.authorization.reference, work_plan: context.workPlan.reference, work_item_id: context.item.id,
    condition_epoch: structuredClone(context.conditionEpoch), baseline: context.workPlan.value.baseline,
    environment_root: execution.environment_root, pilot_ledger_root: context.ledgerRoot, control_root: execution.control_root,
    setup: (await record(join(execution.control_root, 'setup.json'))).reference,
    protocol_sha256: protocol.protocol_sha256, execution_sha256: fingerprint(execution),
    planned_episodes: slots.length, slots: structuredClone(slots), registered_at: new Date().toISOString(), amendment_sha256: null };
  value.amendment_sha256 = fingerprint(value);
  const ref = await save(join(execution.control_root, 'standing-campaign-amendment.json'), value);
  return { field: 'standing_scope', registration: { version: 1, kind: STANDING_CAMPAIGN, id: value.id, role: value.role, amendment: ref } };
}

export async function readStandingAmendment(ref) {
  const value = await verified(ref);
  keys(value, ['version', 'kind', 'id', 'role', 'authorization', 'work_plan', 'work_item_id', 'condition_epoch', 'baseline',
    'environment_root', 'pilot_ledger_root', 'control_root', 'setup', 'protocol_sha256', 'execution_sha256', 'planned_episodes',
    'slots', 'registered_at', 'amendment_sha256']);
  assert.equal(value.version, 1); assert.equal(value.kind, STANDING_CAMPAIGN); assert.ok(safe(value.id)); assert.equal(value.role, 'task_continuation');
  assert.equal(value.amendment_sha256, fingerprint({ ...value, amendment_sha256: null }));
  return value;
}

export function standingReservationFields(plan, amendment, planReference) {
  assert.equal(planReference.path, join(plan.execution.control_root, 'plan.json')); assert.match(planReference.sha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.execution.standing_scope.id, amendment.id);
  return { scope_id: amendment.id, scope_amendment_sha256: amendment.amendment_sha256, scope_kind: STANDING_CAMPAIGN,
    scope_role: amendment.role, plan: planReference, plan_sha256: plan.plan_sha256,
    authorization: amendment.authorization, work_plan: amendment.work_plan, work_item_id: amendment.work_item_id,
    condition_epoch_id: amendment.condition_epoch.id };
}

/** Verify retained raw bytes and the normalizer's admission/completeness contract. */
export async function assertCompletedStandingEvidence(plan, event) {
  const result = event.result, slot = plan.slots.find(item => item.slot_id === event.slot_id);
  assert.ok(slot); assert.ok(typeof result.stop_batch === 'boolean');
  const { episode } = await readEvidenceBundle({ directory: result.normalized_directory, rawRoot: plan.execution.environment_root });
  assert.equal(episode.episode_sha256, result.episode_sha256, 'STANDING_NEW_EVIDENCE_CHANGED');
  const condition = plan.protocol.conditions.find(item => item.id === slot.condition_id);
  const environment = plan.protocol.environments.find(item => item.id === condition.environment_id);
  for (const [key, value] of Object.entries({ run_id: event.run_id, experiment_id: plan.id, case_id: slot.case_id,
    condition_id: slot.condition_id, model_id: condition.model_id, environment_sha256: environment.manifest_sha256, build_id: environment.build.id }))
    assert.equal(episode.identity[key], value, 'STANDING_EPISODE_IDENTITY_CHANGED');
  const measurement = value => value?.status === 'known' ? value.value : null;
  assert.deepEqual(result.budget_usage, { model_requests: measurement(episode.measurements.actual_attempts),
    input_tokens: measurement(episode.measurements.input_total.value), output_tokens: measurement(episode.measurements.output_total.value),
    duration_ms: measurement(episode.timing.duration_ms) }, 'STANDING_USAGE_CHANGED');
  if (!result.stop_batch) {
    assertCohortModelEvidence(episode, plan.protocol.models.find(item => item.id === condition.model_id));
    assert.equal(episode.admission.status, 'valid', 'STANDING_NEW_CORE_INVALID');
    for (const key of ['attempts', 'tools', 'interventions'])
      assert.equal(episode.admission.completeness[key], 'complete', 'STANDING_NEW_CORE_INCOMPLETE: ' + key);
    assert.equal(episode.measurements.actual_attempts.status, 'known'); assert.ok(episode.measurements.actual_attempts.value > 0);
    assert.equal(episode.measurements.input_total.value.status, 'known'); assert.equal(episode.measurements.output_total.value.status, 'known');
    assert.equal(episode.timing.duration_ms.status, 'known'); assert.ok(episode.attempts.filter(item => item.sent).every(item => item.adapter.verified));
  }
}

/** Every dispatch reads the live closure and ledger. Historical evidence is
 * bound through the baseline receipt; it never becomes a renewable allowance. */
export async function verifyStandingPlan(plan, { activate = false, forReservation = false } = {}) {
  const registration = plan.execution.standing_scope; assert.ok(registration && isStandingCampaign(plan.protocol.policies.campaign));
  assert.equal(plan.execution.campaign_scope, undefined); assert.equal(plan.execution.pilot_scope, undefined); assert.equal(plan.execution.resumption, undefined);
  const amendment = await readStandingAmendment(registration.amendment), setup = await verified(amendment.setup);
  const context = await assertStandingSetup(setup);
  assert.equal(registration.version, 1); assert.equal(registration.kind, STANDING_CAMPAIGN); assert.equal(registration.role, amendment.role);
  assert.equal(plan.id, amendment.id); assert.equal(registration.id, amendment.id); assert.equal(plan.protocol.id, amendment.id);
  assert.deepEqual(amendment.authorization, context.authorization.reference); assert.deepEqual(amendment.work_plan, context.workPlan.reference);
  assert.equal(amendment.work_item_id, context.item.id); assert.deepEqual(amendment.baseline, context.workPlan.value.baseline);
  assert.deepEqual(amendment.condition_epoch, context.conditionEpoch);
  assert.equal(amendment.environment_root, context.workPlan.value.environment_root); assert.equal(plan.execution.environment_root, amendment.environment_root);
  assert.equal(amendment.pilot_ledger_root, context.ledgerRoot); assert.equal(plan.execution.pilot_ledger_root, context.ledgerRoot);
  assert.equal(amendment.control_root, setup.control_root); assert.equal(plan.execution.control_root, setup.control_root);
  assert.equal(amendment.protocol_sha256, plan.protocol.protocol_sha256); assert.deepEqual(amendment.slots, plan.slots);
  assert.equal(amendment.planned_episodes, plan.slots.length);
  assert.deepEqual(plan.protocol.policies.campaign, standingCampaignPolicy(context, { scheduledEpisodes: plan.slots.length }));
  const { standing_scope, ...execution } = plan.execution;
  assert.equal(fingerprint(execution), amendment.execution_sha256); assert.deepEqual(execution.implementation, context.controller.implementation);
  const actualPlan = await record(join(execution.control_root, 'plan.json')); assert.deepEqual(actualPlan.value, plan, 'STANDING_PLAN_CHANGED');
  const boundary = await inspectStandingLedger({ ledgerRoot: context.ledgerRoot, baseline: amendment.baseline });
  assert.equal(boundary.exists, true); assert.deepEqual(boundary.authorization, amendment.authorization);
  let latest = boundary.registrations.at(-1);
  const own = boundary.registrations.find(item => item.value.id === plan.id);
  if (own) { assert.deepEqual(own.value.amendment, registration.amendment); assert.deepEqual(own.value.plan, actualPlan.reference); }
  if (activate && !own) {
    assert.ok(boundary.lease && boundary.lease.pid === process.pid && boundary.lease.plan_sha256 === plan.plan_sha256,
      'STANDING_ACTIVATION_REQUIRES_OWN_LEASE');
    if (latest) {
      const predecessor = await verified(latest.value.plan), rows = await rowsAt(predecessor.execution.control_root);
      assert.ok(rows.length && rows.at(-1).type === 'batch_closed', 'STANDING_PREDECESSOR_NOT_CLOSED');
      assert.equal(rows.filter(item => item.type === 'episode_started').length,
        rows.filter(item => item.type === 'episode_completed').length, 'STANDING_PREDECESSOR_UNRESOLVED');
      for (const event of rows.filter(item => item.type === 'episode_completed')) await assertCompletedStandingEvidence(predecessor, event);
      assert.equal(await optional(join(predecessor.execution.control_root, 'lease.json')), null, 'STANDING_PREDECESSOR_LEASE_ACTIVE');
    }
    const sequence = boundary.local_registrations + 1;
    const row = { version: 1, kind: 'benchmark-standing-registration', sequence,
      global_sequence: boundary.history_registrations + sequence,
      predecessor: latest?.reference ?? (await record(join(context.ledgerRoot, 'ledger-baseline.json'))).reference,
      id: plan.id, amendment: registration.amendment, plan: actualPlan.reference };
    const ref = await save(join(context.ledgerRoot, 'scope-registration-' + String(sequence).padStart(3, '0') + '.json'), row);
    latest = { value: row, reference: ref };
  }
  if (activate || forReservation) assert.equal(latest?.value.id, plan.id, 'STANDING_ATTEMPT_RETIRED_OR_UNREGISTERED');
  const reservations = boundary.reservations.filter(item => item.value.scope_id === plan.id);
  const rows = await rowsAt(execution.control_root), starts = rows.filter(item => item.type === 'episode_started');
  const completed = rows.filter(item => item.type === 'episode_completed');
  assert.equal(starts.length, reservations.length, 'STANDING_ORPHAN_RESERVATION');
  assert.equal(new Set(starts.map(item => item.run_id)).size, starts.length, 'STANDING_DUPLICATE_START');
  assert.equal(new Set(completed.map(item => item.run_id)).size, completed.length, 'STANDING_DUPLICATE_RESULT');
  assert.ok(completed.every(item => starts.some(start => start.run_id === item.run_id && start.slot_id === item.slot_id)), 'STANDING_UNSTARTED_RESULT');
  const fields = standingReservationFields(plan, amendment, actualPlan.reference);
  for (const [index, { value }] of reservations.entries()) {
    const slot = plan.slots[index]; assert.ok(slot, 'STANDING_RESERVATION_OUTSIDE_DESIGN');
    assert.equal(value.experiment_id, plan.id); assert.equal(value.slot_id, slot.slot_id);
    assert.equal(value.run_id, plan.id + '-' + String(slot.order + 1).padStart(3, '0'));
    for (const [key, expected] of Object.entries(fields)) assert.deepEqual(value[key], expected, 'STANDING_RESERVATION_BINDING_CHANGED');
    assert.equal(starts[index].run_id, value.run_id);
    for (const [key, expected] of Object.entries(slot)) assert.deepEqual(starts[index][key], expected, 'STANDING_START_SLOT_CHANGED');
  }
  for (const event of completed) await assertCompletedStandingEvidence(plan, event);
  if (forReservation) {
    assert.equal(starts.length, completed.length, 'STANDING_UNRESOLVED_PREVIOUS_EXECUTION');
    assert.ok(completed.every(item => item.result.stop_batch === false && knownUsage(item.result.budget_usage)), 'STANDING_REPAIR_REQUIRED');
    assert.ok(reservations.length < plan.slots.length, 'STANDING_SCIENTIFIC_DESIGN_COMPLETE');
  }
  return amendment;
}

export async function reserveStandingEpisode({ plan, amendment, slot, runId, planReference }) {
  const current = await verifyStandingPlan(plan, { forReservation: true }); assert.deepEqual(current, amendment);
  const boundary = await inspectStandingLedger({ ledgerRoot: amendment.pilot_ledger_root, baseline: amendment.baseline });
  assert.ok(boundary.lease && boundary.lease.pid === process.pid && boundary.lease.plan_sha256 === plan.plan_sha256, 'STANDING_RESERVATION_REQUIRES_OWN_LEASE');
  const ordinal = boundary.global_observations + 1; assert.ok(Number.isSafeInteger(ordinal));
  assert.deepEqual(slot, plan.slots[boundary.reservations.filter(item => item.value.scope_id === plan.id).length]);
  assert.equal(runId, plan.id + '-' + String(slot.order + 1).padStart(3, '0'));
  const value = { run_id: runId, experiment_id: plan.id, slot_id: slot.slot_id, at: new Date().toISOString(),
    ...standingReservationFields(plan, amendment, planReference) };
  await writeFile(join(amendment.pilot_ledger_root, String(ordinal).padStart(3, '0') + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ordinal };
}

export async function reconcileStandingLease({ plan, leaseId, batchLease }) {
  const registration = plan.execution.standing_scope, path = join(plan.execution.pilot_ledger_root, 'campaign.lease.json');
  const actual = await optional(path); if (!actual) return null; const lease = actual.value;
  assert.equal(lease.scope_id, registration.id); assert.equal(lease.plan_sha256, plan.plan_sha256); assert.equal(lease.control_root, plan.execution.control_root);
  if (batchLease) { assert.equal(lease.pid, batchLease.pid); assert.equal(batchLease.id, leaseId); }
  else assert.equal(lease.id, leaseId);
  let alive = true; try { process.kill(lease.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
  assert.equal(alive, false, 'STANDING_LEASE_OWNER_ALIVE');
  const retained = join(plan.execution.pilot_ledger_root, 'scope-' + registration.id + '.lease-reconciled-' + lease.id + '.json');
  await rename(path, retained); return { scope_lease_id: lease.id, retained, model_requests: 0 };
}
