import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRetirablePrefix } from './batch-retirement.mjs';
import { parseBenchmarkArgs } from './cli.mjs';

function fixture() {
  const plan = { id: 'retirement-fixture', plan_sha256: 'a'.repeat(64),
    slots: Array.from({ length: 24 }, (_, order) => ({ order, slot_id: 'slot-' + order,
      case_id: 'case-' + order, condition_id: 'condition-a', repeat: 0, seed: 42 })) };
  const lease = { id: 'dead-lease' }, slot = plan.slots[0], run_id = plan.id + '-001';
  const rows = [{ seq: 1, type: 'batch_opened', plan_sha256: plan.plan_sha256, lease_id: lease.id },
    { seq: 2, type: 'episode_started', ...slot, run_id },
    { seq: 3, type: 'episode_completed', ...slot, run_id, result: { stop_batch: false } }];
  return { plan, lease, rows, reservations: [{ run_id, slot_id: slot.slot_id }] };
}

test('retirement closes the observed invocation while retaining 23 missing scientific slots', () => {
  const input = fixture(), before = structuredClone(input);
  const result = assertRetirablePrefix(input);
  assert.equal(result.completed.length, 1); assert.equal(result.invocationStarts, 1);
  assert.equal(input.plan.slots.length - result.completed.length, 23);
  assert.deepEqual(input, before);
});

test('retirement requires exact ordered starts, completions, reservations and the observed lease', () => {
  for (const mutate of [
    input => { input.rows.pop(); },
    input => { input.rows[2].run_id = 'foreign-001'; },
    input => { input.rows[2].case_id = 'different-case'; },
    input => { input.rows[2].type = 'episode_unresolved'; },
    input => { input.rows[1].run_id = 'foreign-001'; input.rows[2].run_id = 'foreign-001'; },
    input => { input.rows[1].order = 1; },
    input => { input.rows[0].lease_id = 'different-lease'; },
    input => { input.rows[0].plan_sha256 = 'b'.repeat(64); },
    input => { input.rows[2].seq = 4; },
    input => { input.reservations.push({ run_id: 'orphan', slot_id: 'slot-1' }); },
    input => { input.reservations[0].run_id = 'different-001'; },
    input => { input.reservations[0].slot_id = 'slot-1'; },
    input => { input.rows.push({ seq: 4, type: 'batch_closed', new_episodes: 1 }); },
  ]) {
    const input = fixture(); mutate(input); assert.throws(() => assertRetirablePrefix(input), /RETIREMENT_/);
  }
});

test('equal start and result counts do not hide crossed or duplicated run identities', () => {
  for (const crossed of [true, false]) {
    const input = fixture(), slot = input.plan.slots[1], run_id = input.plan.id + '-002';
    input.rows.push({ seq: 4, type: 'episode_started', ...slot, run_id },
      { seq: 5, type: 'episode_completed', ...slot, run_id });
    input.reservations.push({ run_id, slot_id: slot.slot_id });
    if (crossed) [input.rows[2].run_id, input.rows[4].run_id] = [input.rows[4].run_id, input.rows[2].run_id];
    else input.rows[3].run_id = input.rows[4].run_id = input.rows[1].run_id;
    assert.throws(() => assertRetirablePrefix(input), /RETIREMENT_/);
  }
});

test('a later interrupted invocation retains earlier slices and counts only its own new runs', () => {
  const input = fixture();
  input.rows.push({ seq: 4, type: 'batch_closed', new_episodes: 1 },
    { seq: 5, type: 'batch_opened', plan_sha256: input.plan.plan_sha256, lease_id: input.lease.id });
  const result = assertRetirablePrefix(input);
  assert.equal(result.completed.length, 1); assert.equal(result.invocationStarts, 0);
});

test('retirement is an explicit reasoned CLI action and introduces no execution override', () => {
  const args = ['reconcile', '--root', '/old/batch', '--lease', 'dead-lease'];
  assert.equal(parseBenchmarkArgs(args)['retire-reason'], undefined);
  assert.equal(parseBenchmarkArgs([...args, '--retire-reason', 'Controller schema defect'])['retire-reason'], 'Controller schema defect');
  for (const flag of ['--allow-unresolved', '--ignore-identity', '--controller', '--budget', '--model'])
    assert.throws(() => parseBenchmarkArgs([...args, flag, '/override']));
});
