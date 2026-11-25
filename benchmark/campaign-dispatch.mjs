import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fingerprint } from './protocol.mjs';
import { isProspectiveCohort } from './prospective-cohort.mjs';
import { preparePilotScope, readPilotScopeAmendment, verifyPilotScope,
  acquirePilotScopeLease, checkCampaignScope as checkLegacyCampaignScope,
  scopeReservationFields, reconcilePilotScopeLease } from './pilot-scope.mjs';
import { FINITE_CAMPAIGN, isFiniteCampaign, prepareFiniteCampaign, readFiniteCampaignAmendment,
  assertFiniteCampaignPlan, verifyFiniteCampaignScope, verifyFiniteCampaignCurrentState, finiteCampaignReservationFields } from './finite-campaign.mjs';
import { readApprovedCampaign } from './approved-campaign.mjs';
import { isEngineeringHistoricalPredecessor, readEngineeringHistoricalPredecessor, isEngineeringContinuationAuthority } from './campaign-engineering-window-continuation.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hasFiniteScope = plan => Boolean(plan.protocol.policies.campaign || plan.execution.campaign_scope);
async function readRecord(path) {
  assert.ok(isAbsolute(path));
  assert.ok((await lstat(path)).isFile(), 'Campaign records must be ordinary files');
  assert.equal(await realpath(path), path, 'Campaign record path is not canonical');
  const bytes = await readFile(path);
  return { value: JSON.parse(bytes), reference: { path, sha256: sha(bytes) } };
}
async function read(path) { return (await readRecord(path)).value; }
async function verified(ref) {
  assert.ok(isAbsolute(ref?.path ?? '') && /^[a-f0-9]{64}$/.test(ref.sha256 ?? ''));
  const record = await readRecord(ref.path);
  assert.equal(record.reference.sha256, ref.sha256, 'Campaign reference changed');
  return record.value;
}
async function save(path, value) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await read(path);
    assert.equal(await readFile(path, 'utf8'), bytes, 'Existing campaign record differs');
  }
}

/** Legacy readers keep their original admission rules. Only the explicit new
 * discriminant can select the finite campaign implementation. */
export async function readCampaignAmendment(ref) {
  const value = await verified(ref);
  return isFiniteCampaign(value) ? readFiniteCampaignAmendment(ref) : readPilotScopeAmendment(ref);
}

export function assertCampaignSuccession({ row, amendment, previous, sequence }) {
  assert.equal(row.version, 1); assert.equal(row.sequence, sequence);
  assert.deepEqual(row.predecessor, previous.reference, 'CAMPAIGN_REGISTRATION_HISTORY_CHANGED');
  assert.equal(row.id, amendment.id);
  assert.deepEqual(amendment.predecessor.registration, previous.reference);
  assert.deepEqual(amendment.predecessor.amendment, previous.value.amendment);
  if (isFiniteCampaign(amendment)) assert.equal(row.kind, 'benchmark-finite-campaign-succession');
  else if (isProspectiveCohort(amendment)) assert.equal(row.kind, 'benchmark-prospective-cohort-succession');
  else {
    assert.ok(sequence === 2 || sequence === 3, 'CAMPAIGN_LEGACY_SUCCESSION_CLOSED');
    assert.equal(row.kind, sequence === 2 ? 'benchmark-zero-send-scope-succession' : 'benchmark-manual-auth-route-succession');
    assert.equal(amendment.version, sequence);
  }
}

async function latestRegistration(root, engineeringAuthority, currentPreview) {
  assert.equal(await realpath(root), root, 'Campaign ledger must be canonical');
  const firstPath = join(root, 'scope-registration.json');
  const firstRecord = await readRecord(firstPath), first = firstRecord.value;
  const original = await verified(first.amendment);
  assert.equal(original.version, 1); assert.equal(original.kind, 'benchmark-pilot-scope-amendment');
  assert.equal(first.id, original.id);
  let latest = { value: first, reference: firstRecord.reference, sequence: 1 }, preview = original;
  const names = (await readdir(root)).filter(name => /^scope-registration-\d{3}\.json$/.test(name)).sort();
  for (const [index, name] of names.entries()) {
    const sequence = index + 2, path = join(root, name);
    assert.equal(name, 'scope-registration-' + String(sequence).padStart(3, '0') + '.json', 'CAMPAIGN_REGISTRATION_GAP');
    const record = await readRecord(path), row = record.value;
    // checkCampaignScope may have read this exact reference moments earlier
    // to select its historical producer. Reuse that metadata only within this
    // call; the full reader below independently rechecks every source byte.
    const amendment = currentPreview?.reference.path === row.amendment.path && currentPreview.reference.sha256 === row.amendment.sha256
      ? currentPreview.value : await verified(row.amendment);
    assertCampaignSuccession({ row, amendment, previous: latest, sequence });
    latest = { value: { id: row.id, amendment: row.amendment }, reference: record.reference, sequence }; preview = amendment;
  }
  // Every registered link above retains its own byte hash and succession checks.
  // The latest full reader then verifies the entire predecessor lineage and its
  // historical observations. Replaying that full proof at each older row only
  // repeats overlapping prefixes; it does not add another registration guard.
  const verifiedAmendment = isEngineeringHistoricalPredecessor(latest.value.amendment, engineeringAuthority)
    ? await readEngineeringHistoricalPredecessor(latest.value.amendment, engineeringAuthority)
    : isFiniteCampaign(preview) ? await readFiniteCampaignAmendment(latest.value.amendment) : await readPilotScopeAmendment(latest.value.amendment);
  return { ...latest, verifiedAmendment };
}

async function engineeringAuthority(reference) {
  return reference && isEngineeringContinuationAuthority(await verified(reference)) ? readApprovedCampaign(reference) : undefined;
}

export async function prepareCampaignScope(input) {
  const { setup, protocol, execution } = input;
  if (!setup.campaign_scope) {
    const registration = await preparePilotScope(input);
    return registration ? { field: 'pilot_scope', registration } : null;
  }
  assert.equal(setup.pilot_scope, undefined, 'Campaign scopes cannot be mixed');
  assert.equal(setup.campaign_scope.kind, FINITE_CAMPAIGN);
  const declared = setup.campaign_scope.predecessor;
  const engineering = await engineeringAuthority(setup.campaign_scope.prospective_authorization);
  const predecessor = isEngineeringHistoricalPredecessor(declared.amendment, engineering)
    ? await readEngineeringHistoricalPredecessor(declared.amendment, engineering) : await readCampaignAmendment(declared.amendment);
  const previous = await verified(declared.registration);
  assert.equal(previous.id, predecessor.id); assert.deepEqual(previous.amendment, declared.amendment);
  const latest = await latestRegistration(execution.pilot_ledger_root, engineering);
  assert.deepEqual(latest.reference, declared.registration, 'CAMPAIGN_PREDECESSOR_NOT_CURRENT');
  const amendment = await prepareFiniteCampaign({ ...input, predecessor });
  const path = join(execution.control_root, 'finite-campaign-amendment.json');
  const bytes = JSON.stringify(amendment, null, 2) + '\n';
  const registration = { version: 1, kind: FINITE_CAMPAIGN, id: amendment.id, role: amendment.role,
    amendment: { path, sha256: sha(bytes) } };
  await save(path, amendment);
  return { field: 'campaign_scope', registration };
}

export function verifyCampaignScope(plan, options = {}) {
  return hasFiniteScope(plan) ? verifyFiniteCampaignScope(plan, options) : verifyPilotScope(plan, options);
}

/** One fresh live boundary. Historical readers use verifyCampaignScope instead.
 * The amendment is proved in this call and consumed immediately; callers cannot
 * provide a cached amendment or suppress any current-state checks. */
export async function verifyCampaignDispatch(plan, { activate = false, ...options } = {}) {
  const amendment = await checkCampaignScope(plan, { activate });
  return hasFiniteScope(plan) ? verifyFiniteCampaignCurrentState(plan, amendment, options) : verifyPilotScope(plan, options);
}

// The same physical lease serializes legacy and finite controllers together.
export const acquireCampaignLease = acquirePilotScopeLease;

export function campaignReservationFields(plan, amendment, planReference) {
  return hasFiniteScope(plan) ? finiteCampaignReservationFields(plan, amendment, planReference)
    : scopeReservationFields(plan, amendment, planReference);
}

export async function checkCampaignScope(plan, { activate = false } = {}) {
  if (!hasFiniteScope(plan)) return checkLegacyCampaignScope(plan, { activate });
  const registration = plan.execution.campaign_scope;
  assert.ok(registration && isFiniteCampaign(plan.protocol.policies.campaign));
  const preview = await verified(registration.amendment);
  const engineering = await engineeringAuthority(preview.prospective_authorization?.reference);
  const latest = await latestRegistration(plan.execution.pilot_ledger_root, engineering, { reference: registration.amendment, value: preview });
  const wanted = { id: registration.id, amendment: registration.amendment };
  const active = fingerprint(latest.value) === fingerprint(wanted);
  // The last registration has just passed its full reader, including history.
  // Reuse only that result in this call; every subsequent check reads it again.
  const amendment = active ? latest.verifiedAmendment : await readFiniteCampaignAmendment(registration.amendment);
  assert.ok(isFiniteCampaign(amendment), 'FINITE_REGISTERED_AMENDMENT_REQUIRED');
  assertFiniteCampaignPlan(plan, amendment);
  if (active) return amendment;
  assert.deepEqual(amendment.predecessor.registration, latest.reference, 'CAMPAIGN_OTHER_ACTIVE_AMENDMENT');
  const predecessor = latest.verifiedAmendment;
  assert.deepEqual(amendment.predecessor.amendment, latest.value.amendment, 'CAMPAIGN_PREDECESSOR_AMENDMENT_CHANGED');
  assert.deepEqual(latest.value, { id: predecessor.id, amendment: amendment.predecessor.amendment });
  if (activate) await save(join(plan.execution.pilot_ledger_root,
    'scope-registration-' + String(latest.sequence + 1).padStart(3, '0') + '.json'),
   { version: 1, kind: 'benchmark-finite-campaign-succession', sequence: latest.sequence + 1,
     predecessor: latest.reference, ...wanted });
  return amendment;
}

export async function reconcileCampaignLease({ plan, leaseId, batchLease }) {
  if (!hasFiniteScope(plan)) return reconcilePilotScopeLease({ plan, leaseId, batchLease });
  const registration = plan.execution.campaign_scope;
  assert.ok(registration && isFiniteCampaign(plan.protocol.policies.campaign));
  const path = join(plan.execution.pilot_ledger_root, 'campaign.lease.json');
  let lease;
  try { lease = await read(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  assert.equal(lease.scope_id, registration.id);
  assert.equal(lease.plan_sha256, plan.plan_sha256); assert.equal(lease.control_root, plan.execution.control_root);
  if (batchLease) { assert.equal(lease.pid, batchLease.pid); assert.equal(batchLease.id, leaseId); }
  else assert.equal(lease.id, leaseId, 'Recovery must name the observed dead campaign lease');
  let alive = true;
  try { process.kill(lease.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
  assert.equal(alive, false, 'Campaign lease owner is still alive');
  const retained = join(plan.execution.pilot_ledger_root, 'scope-' + registration.id + '.lease-reconciled-' + lease.id + '.json');
  await rename(path, retained);
  return { scope_lease_id: lease.id, retained, model_requests: 0 };
}
