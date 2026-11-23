import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const UNSTARTED_FOLLOWUP = 'unstarted_followup';
const sorted = values => [...values].sort();

export function assertFollowupSelection(selection) {
  assert.ok(selection && typeof selection === 'object' && !Array.isArray(selection), 'FOLLOWUP_SELECTION_REQUIRED');
  assert.deepEqual(sorted(Object.keys(selection)), ['slot_ids', 'source_plan_sha256'], 'FOLLOWUP_SELECTION_SHAPE');
  assert.match(selection.source_plan_sha256, /^[a-f0-9]{64}$/, 'FOLLOWUP_SOURCE_PLAN_HASH');
  assert.ok(Array.isArray(selection.slot_ids) && selection.slot_ids.length > 0, 'FOLLOWUP_EMPTY_SELECTION');
  assert.ok(selection.slot_ids.every(id => typeof id === 'string' && id.length > 0), 'FOLLOWUP_SLOT_ID');
  assert.equal(new Set(selection.slot_ids).size, selection.slot_ids.length, 'FOLLOWUP_DUPLICATE_SLOT');
  return selection;
}

/** The scientific design remains complete even when a separately authorized
 * descriptive follow-up executes only its previously unstarted suffix. */
export function declaredSchedule(protocol) {
  const ordered = protocol.pairs.map(pair => ({ pair, key: createHash('sha256')
    .update(String(protocol.policies.ordering.seed) + '\0' + pair.id).digest('hex') }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const slots = [];
  for (const [index, { pair }] of ordered.entries()) {
    const conditions = index % 2 === 0 ? pair.condition_ids : [...pair.condition_ids].reverse();
    for (const condition_id of conditions) slots.push({ slot_id: condition_id + '--' + pair.case_id + '--r' + pair.repeat,
      pair_id: pair.id, case_id: pair.case_id, condition_id, repeat: pair.repeat, seed: pair.seed });
  }
  for (const item of protocol.assessments) if (item.expected_support === 'supported') slots.push({ slot_id: item.id,
    assessment_id: item.id, case_id: item.case_id, condition_id: item.condition_id, repeat: item.repeat ?? 0, seed: item.seed ?? 0 });
  assert.equal(new Set(slots.map(slot => slot.slot_id)).size, slots.length, 'Scheduled slots must be unique');
  return slots.map((slot, order) => ({ ...slot, order }));
}

export function scheduleProtocol(protocol) {
  const slots = declaredSchedule(protocol), campaign = protocol.policies.campaign;
  if (campaign?.role !== UNSTARTED_FOLLOWUP) {
    assert.equal(campaign?.selection, undefined, 'FOLLOWUP_SELECTION_ROLE_REQUIRED');
    return slots;
  }
  const selection = assertFollowupSelection(campaign.selection), selected = new Set(selection.slot_ids);
  const retained = slots.filter(slot => selected.has(slot.slot_id));
  assert.deepEqual(retained.map(slot => slot.slot_id), selection.slot_ids, 'FOLLOWUP_SELECTION_ORDER_OR_MEMBERSHIP');
  return retained.map((slot, order) => ({ ...slot, order }));
}
