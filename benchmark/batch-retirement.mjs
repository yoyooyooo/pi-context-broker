import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { batchStatus, validateBatchPlan } from './batch.mjs';
import { acquireCampaignLease } from './campaign-dispatch.mjs';
import { executionImplementation } from './implementation.mjs';
import { assertCompletedStandingEvidence, inspectStandingLedger, readStandingAmendment,
  readStandingAuthorization } from './standing-campaign.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ref = (path, bytes) => ({ path, sha256: sha(bytes) });
async function optional(path) {
  try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function dead(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'RETIREMENT_OWNER_REQUIRED');
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  assert.fail('RETIREMENT_OWNER_STILL_ALIVE');
}

/** Retirement closes a controller invocation, never an unobserved subject run. */
export function assertRetirablePrefix({ plan, rows, lease, reservations }) {
  assert.ok(rows.length, 'RETIREMENT_EMPTY_LEDGER');
  const starts = [], completed = [];
  let opened = null, active = null, invocationStarts = 0;
  for (const [index, row] of rows.entries()) {
    assert.equal(row.seq, index + 1, 'RETIREMENT_LEDGER_SEQUENCE');
    if (row.type === 'batch_opened') {
      assert.equal(opened, null, 'RETIREMENT_NESTED_INVOCATION');
      assert.equal(row.plan_sha256, plan.plan_sha256, 'RETIREMENT_PLAN_CHANGED');
      opened = row; invocationStarts = 0;
    } else if (row.type === 'batch_closed') {
      assert.ok(opened && active === null, 'RETIREMENT_UNRESOLVED_EXECUTION');
      assert.equal(row.new_episodes, invocationStarts, 'RETIREMENT_CLOSURE_COUNT');
      opened = null;
    } else if (row.type === 'episode_started') {
      assert.ok(opened && active === null, 'RETIREMENT_UNRESOLVED_EXECUTION');
      const slot = plan.slots[starts.length]; assert.ok(slot, 'RETIREMENT_OUTSIDE_DESIGN');
      for (const [key, value] of Object.entries(slot)) assert.deepEqual(row[key], value, 'RETIREMENT_SLOT_CHANGED');
      assert.equal(row.run_id, plan.id + '-' + String(slot.order + 1).padStart(3, '0'), 'RETIREMENT_RUN_CHANGED');
      active = row; starts.push(row); invocationStarts++;
    } else if (row.type === 'episode_completed') {
      assert.ok(active && opened, 'RETIREMENT_UNSTARTED_RESULT');
      for (const key of ['run_id', ...Object.keys(plan.slots[completed.length])])
        assert.deepEqual(row[key], active[key], 'RETIREMENT_RESULT_CHANGED');
      completed.push(row); active = null;
    } else assert.fail('RETIREMENT_AMBIGUOUS_LEDGER_EVENT');
  }
  assert.ok(opened && active === null, 'RETIREMENT_UNRESOLVED_OR_CLOSED');
  assert.equal(opened.lease_id, lease.id, 'RETIREMENT_LEASE_CHANGED');
  assert.equal(starts.length, completed.length, 'RETIREMENT_UNRESOLVED_EXECUTION');
  assert.equal(new Set(starts.map(row => row.run_id)).size, starts.length, 'RETIREMENT_DUPLICATE_RUN');
  assert.equal(reservations.length, starts.length, 'RETIREMENT_ORPHAN_RESERVATION');
  for (const [index, reservation] of reservations.entries()) {
    assert.equal(reservation.run_id, starts[index].run_id, 'RETIREMENT_RESERVATION_CHANGED');
    assert.equal(reservation.slot_id, starts[index].slot_id, 'RETIREMENT_RESERVATION_CHANGED');
  }
  return { completed, invocationStarts };
}

/** A new controller can retire an old, byte-bound invocation without claiming
 * to execute its frozen implementation. The intent retains the exact prefix
 * and footer, so retries cannot append a second closure or invent observations. */
export async function retireInterruptedStandingBatch(options) {
  assert.ok(isAbsolute(options.controlRoot) && resolve(options.controlRoot) === options.controlRoot);
  assert.equal(await realpath(options.controlRoot), options.controlRoot);
  if (options.inspectOnly) return retireOwned(options);
  const plan = validateBatchPlan(JSON.parse(await readFile(join(options.controlRoot, 'plan.json'))));
  assert.ok(plan.execution.standing_scope, 'RETIREMENT_REQUIRES_STANDING_PLAN');
  const amendment = await readStandingAmendment(plan.execution.standing_scope.amendment);
  const release = await acquireCampaignLease(plan, amendment);
  try { return await retireOwned({ ...options, campaignLeaseOwned: true }); }
  finally { await release(); }
}

async function retireOwned({ controlRoot, leaseId, reason, inspectOnly = false, campaignLeaseOwned = false }) {
  assert.ok(isAbsolute(controlRoot) && resolve(controlRoot) === controlRoot);
  assert.equal(await realpath(controlRoot), controlRoot);
  assert.match(leaseId, /^[A-Za-z0-9-]+$/);
  assert.ok(typeof reason === 'string' && reason.trim(), 'RETIREMENT_REASON_REQUIRED');
  const planPath = join(controlRoot, 'plan.json'), planBytes = await readFile(planPath);
  const plan = validateBatchPlan(JSON.parse(planBytes));
  assert.equal(plan.execution.control_root, controlRoot);
  assert.ok(plan.execution.standing_scope, 'RETIREMENT_REQUIRES_STANDING_PLAN');
  const amendment = await readStandingAmendment(plan.execution.standing_scope.amendment);
  await readStandingAuthorization(amendment.authorization);
  const leasePath = join(controlRoot, 'lease.json'), retainedPath = join(controlRoot, 'lease-retired-' + leaseId + '.json');
  const interruptedPath = join(controlRoot, 'lease-interrupted-' + leaseId + '.json');
  const intentPath = join(controlRoot, 'retirement-' + leaseId + '.json');
  let intentBytes = await optional(intentPath), intent = intentBytes && JSON.parse(intentBytes);
  const activeLeaseBytes = await optional(leasePath), retainedLeaseBytes = await optional(retainedPath);
  const interruptedLeaseBytes = await optional(interruptedPath);
  const leaseBytes = activeLeaseBytes ?? retainedLeaseBytes ?? interruptedLeaseBytes;
  assert.ok(leaseBytes, 'RETIREMENT_MATCHING_LEASE_REQUIRED');
  const lease = JSON.parse(leaseBytes);
  assert.equal(lease.id, leaseId); assert.equal(lease.plan_sha256, plan.plan_sha256); dead(lease.pid);
  assert.ok(!activeLeaseBytes || !retainedLeaseBytes, 'RETIREMENT_DUPLICATE_LEASE');
  const ledgerPath = join(controlRoot, 'ledger.jsonl'), ledgerBytes = await readFile(ledgerPath);
  const prefix = intent ? ledgerBytes.subarray(0, intent.ledger_before.bytes) : ledgerBytes;
  assert.ok(prefix.length && prefix.at(-1) === 10, 'RETIREMENT_INCOMPLETE_PREFIX');
  const rows = prefix.toString().split('\n').filter(Boolean).map(JSON.parse);
  const boundary = await inspectStandingLedger({ ledgerRoot: amendment.pilot_ledger_root, baseline: amendment.baseline });
  if (campaignLeaseOwned) {
    assert.equal(boundary.lease?.pid, process.pid, 'RETIREMENT_CAMPAIGN_LEASE_NOT_OWNED');
    assert.equal(boundary.lease.plan_sha256, plan.plan_sha256);
    assert.equal(boundary.lease.control_root, controlRoot); assert.equal(boundary.lease.scope_id, plan.id);
  } else assert.equal(boundary.lease, null, 'RETIREMENT_CAMPAIGN_LEASE_ACTIVE');
  const registration = boundary.registrations.find(item => item.value.id === plan.id);
  assert.ok(registration); assert.deepEqual(registration.value.plan, ref(planPath, planBytes));
  if (activeLeaseBytes) assert.equal(boundary.registrations.at(-1).value.id, plan.id, 'RETIREMENT_ATTEMPT_ALREADY_RETIRED');
  const checked = assertRetirablePrefix({ plan, rows, lease,
    reservations: boundary.reservations.filter(item => item.value.scope_id === plan.id).map(item => item.value) });
  for (const event of checked.completed) await assertCompletedStandingEvidence(plan, event);
  const identity = { version: 1, kind: 'benchmark-standing-invocation-retirement', plan: ref(planPath, planBytes),
    lease: ref(retainedPath, leaseBytes), lease_id: leaseId, reason,
    ledger_before: { ...ref(ledgerPath, prefix), bytes: prefix.length }, model_execution: false, model_requests: 0 };
  if (intent) {
    for (const [key, value] of Object.entries(identity)) assert.deepEqual(intent[key], value, 'RETIREMENT_INTENT_CHANGED');
    assert.deepEqual(intent.implementation, await executionImplementation(), 'RETIREMENT_IMPLEMENTATION_CHANGED');
    const { at, monotonic_ns, ...closure } = intent.closure;
    assert.ok(typeof at === 'string' && Number.isFinite(Date.parse(at)));
    assert.match(monotonic_ns, /^[0-9]+$/);
    assert.deepEqual(closure, { version: 1, seq: rows.length + 1,
      clock_domain: 'retirement-' + leaseId, type: 'batch_closed', reason: 'interrupted_controller_failure',
      new_episodes: checked.invocationStarts, retirement: intentPath, retained_lease_id: leaseId,
      model_execution: false, detail: reason }, 'RETIREMENT_CLOSURE_CHANGED');
  } else {
    assert.ok(activeLeaseBytes || interruptedLeaseBytes, 'RETIREMENT_INTENT_REQUIRED');
    intent = { ...identity, implementation: await executionImplementation(), closure: {
      version: 1, seq: rows.length + 1, at: new Date().toISOString(), monotonic_ns: process.hrtime.bigint().toString(),
      clock_domain: 'retirement-' + leaseId, type: 'batch_closed', reason: 'interrupted_controller_failure',
      new_episodes: checked.invocationStarts, retirement: intentPath, retained_lease_id: leaseId,
      model_execution: false, detail: reason } };
    intentBytes = Buffer.from(JSON.stringify(intent, null, 2) + '\n');
  }
  const footer = Buffer.from(JSON.stringify(intent.closure) + '\n'), expected = Buffer.concat([prefix, footer]);
  assert.ok(ledgerBytes.length <= expected.length && ledgerBytes.equals(expected.subarray(0, ledgerBytes.length)),
    'RETIREMENT_LEDGER_CHANGED');
  if (inspectOnly) return { ...identity, completed: checked.completed.length, planned: plan.slots.length, inspection: 'passed' };
  if (!(await optional(intentPath))) await writeFile(intentPath, intentBytes, { flag: 'wx', mode: 0o600 });
  assert.deepEqual(await readFile(intentPath), intentBytes, 'RETIREMENT_INTENT_CHANGED');
  // A fixed offset with the immutable intended bytes makes an interrupted
  // footer write recoverable without deleting or rewriting the original prefix.
  if (ledgerBytes.length !== expected.length) {
    assert.ok(activeLeaseBytes || interruptedLeaseBytes, 'RETIREMENT_DEAD_LEASE_REQUIRED');
    const file = await open(ledgerPath, 'r+');
    try {
      assert.deepEqual(await readFile(ledgerPath), ledgerBytes, 'RETIREMENT_LEDGER_CHANGED');
      let written = 0;
      while (written < footer.length) {
        const next = await file.write(footer, written, footer.length - written, prefix.length + written);
        assert.ok(next.bytesWritten > 0); written += next.bytesWritten;
      }
      await file.sync();
    } finally { await file.close(); }
  }
  assert.deepEqual(await readFile(ledgerPath), expected, 'RETIREMENT_CLOSURE_CHANGED');
  if (activeLeaseBytes) {
    try {
      assert.deepEqual(await readFile(leasePath), leaseBytes, 'RETIREMENT_LEASE_CHANGED');
      await rename(leasePath, retainedPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      assert.deepEqual(await readFile(interruptedPath), leaseBytes, 'RETIREMENT_LEASE_CHANGED');
    }
  }
  if (!(await optional(retainedPath))) {
    assert.deepEqual(await readFile(interruptedPath), leaseBytes, 'RETIREMENT_LEASE_CHANGED');
    await writeFile(retainedPath, leaseBytes, { flag: 'wx', mode: 0o600 });
  }
  assert.deepEqual(await readFile(retainedPath), leaseBytes);
  return { ...await batchStatus(controlRoot), retirement: ref(intentPath, intentBytes), model_requests: 0, execution_performed: false };
}
