import assert from 'node:assert/strict';
import { fingerprint } from './protocol.mjs';

const safe = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/.test(value);
const exact = (value, keys, message) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), message);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), message);
};
const modes = new Set(['missing-object', 'missing-manifest', 'store-unavailable']);

/** A finite diagnostic changes owned Store state, never the subject task or grader. */
export function validateFixtureDiagnostics(value) {
  if (value === undefined) return null;
  exact(value, ['version', 'kind', 'pairs', 'scenarios'], 'DIAGNOSTIC_POLICY_SHAPE');
  assert.equal(value.version, 1); assert.equal(value.kind, 'owned-store-clean-fault');
  assert.ok(Array.isArray(value.pairs) && value.pairs.length === 2, 'DIAGNOSTIC_TWO_PRODUCT_PAIRS');
  for (const pair of value.pairs) {
    exact(pair, ['clean', 'fault'], 'DIAGNOSTIC_PAIR_SHAPE');
    assert.ok([pair.clean, pair.fault].every(id => /^m0-e[0-3]$/.test(id)), 'DIAGNOSTIC_ONE_MODEL_FOUR_CELLS');
  }
  assert.equal(new Set(value.pairs.flatMap(pair => [pair.clean, pair.fault])).size, 4, 'DIAGNOSTIC_REPEATED_CELL');
  assert.ok(Array.isArray(value.scenarios) && value.scenarios.length === 2, 'DIAGNOSTIC_TWO_JOURNEYS');
  const ids = new Set(), cases = new Set();
  for (const scenario of value.scenarios) {
    exact(scenario, ['id', 'case_id', 'skill_id', 'mode', 'before_turn', 'restore_before_turn',
      ...(scenario.probe_skill_id === undefined ? [] : ['probe_skill_id'])], 'DIAGNOSTIC_SCENARIO_SHAPE');
    assert.ok(safe(scenario.id) && safe(scenario.case_id) && safe(scenario.skill_id), 'DIAGNOSTIC_STABLE_ID_REQUIRED');
    assert.ok(!ids.has(scenario.id) && !cases.has(scenario.case_id), 'DIAGNOSTIC_REPEATED_JOURNEY');
    ids.add(scenario.id); cases.add(scenario.case_id);
    assert.ok(modes.has(scenario.mode), 'DIAGNOSTIC_STORE_FAULT_MODE');
    if (scenario.probe_skill_id !== undefined) {
      assert.ok(safe(scenario.probe_skill_id), 'DIAGNOSTIC_PROBE_ID_REQUIRED');
      assert.equal(scenario.mode, 'store-unavailable', 'DIAGNOSTIC_DISTINCT_PROBE_REQUIRES_GLOBAL_STORE_FAULT');
      assert.notEqual(scenario.probe_skill_id, scenario.skill_id, 'DIAGNOSTIC_DISTINCT_PROBE_REQUIRED');
    }
    assert.ok(safe(scenario.before_turn) && safe(scenario.restore_before_turn), 'DIAGNOSTIC_TURN_REQUIRED');
  }
  return structuredClone(value);
}

/** Validate the complete schedule before allocating any remote episode fixture. */
export function validateDiagnosticSchedule(value, { cases, slots, candidates }) {
  const policy = validateFixtureDiagnostics(value); if (!policy) return null;
  const cells = policy.pairs.flatMap(pair => [pair.clean, pair.fault]).sort();
  assert.deepEqual(Object.keys(candidates).sort(), cells, 'DIAGNOSTIC_SCHEDULE_CELLS');
  assert.equal(slots.length, 8, 'DIAGNOSTIC_EIGHT_SLOTS');
  assert.deepEqual(cases.map(binding => binding.id).sort(), policy.scenarios.map(scenario => scenario.case_id).sort(), 'DIAGNOSTIC_SCHEDULE_CASES');
  for (const pair of policy.pairs) {
    const clean = candidates[pair.clean], fault = candidates[pair.fault];
    assert.equal(clean.mode, 'broker', 'DIAGNOSTIC_NATIVE_UNSUPPORTED');
    assert.equal(fault.mode, 'broker', 'DIAGNOSTIC_NATIVE_UNSUPPORTED');
    assert.equal(clean.build_id, fault.build_id, 'DIAGNOSTIC_PRODUCT_CHANGED_BETWEEN_ARMS');
  }
  assert.notEqual(candidates[policy.pairs[0].clean].build_id, candidates[policy.pairs[1].clean].build_id, 'DIAGNOSTIC_TWO_SELECTED_PRODUCTS');
  for (const scenario of policy.scenarios) {
    const binding = cases.find(item => item.id === scenario.case_id);
    const turns = binding.public_case.turns.map(turn => turn.id);
    const start = turns.indexOf(scenario.before_turn), restore = turns.indexOf(scenario.restore_before_turn);
    assert.ok(start > 0 && restore > start, 'DIAGNOSTIC_REQUIRES_PRIOR_TURN_AND_LATER_RESTORE');
    assert.ok(binding.skill_inventory.some(file => file.skill_id === scenario.skill_id && file.resource_path === 'SKILL.md'), 'DIAGNOSTIC_SKILL_OUTSIDE_MATERIAL');
    if (scenario.probe_skill_id !== undefined) assert.ok(binding.skill_inventory.some(file => file.skill_id === scenario.probe_skill_id && file.resource_path === 'SKILL.md'), 'DIAGNOSTIC_PROBE_OUTSIDE_MATERIAL');
    const selected = slots.filter(slot => slot.case_id === scenario.case_id);
    assert.deepEqual(selected.map(slot => slot.condition_id).sort(), cells, 'DIAGNOSTIC_MISSING_OR_REPEATED_CELL');
    assert.ok(selected.every(slot => slot.repeat === 0), 'DIAGNOSTIC_NO_REPETITIONS');
    const eventIds = new Set((binding.events ?? []).map(event => event.id));
    assert.ok(!eventIds.has(scenario.id + '-fault') && !eventIds.has(scenario.id + '-restore'), 'DIAGNOSTIC_EVENT_ID_COLLISION');
  }
  return policy;
}

/** Return a private per-slot projection while retaining the canonical public case. */
export function diagnosticBinding(binding, conditionId, policy) {
  if (!policy) return { binding, events: [], requiresFixture: (binding.events?.length ?? 0) > 0 };
  const scenario = policy.scenarios.find(item => item.case_id === binding.id);
  const pair = policy.pairs.find(item => item.clean === conditionId || item.fault === conditionId);
  assert.ok(scenario && pair, 'DIAGNOSTIC_UNDECLARED_SLOT');
  const arm = pair.clean === conditionId ? 'clean' : 'fault';
  const probeSkillId = scenario.probe_skill_id ?? scenario.skill_id;
  const operation = { skill_id: probeSkillId, path: 'SKILL.md', intent: scenario.probe_skill_id ? 'probe-owned-store-availability' : 'consume-skill' };
  const events = arm === 'clean' ? [] : [
    { id: scenario.id + '-fault', before_turn: scenario.before_turn, kind: 'fault', skill_id: probeSkillId,
      mode: scenario.mode, logical_operation: operation },
    { id: scenario.id + '-restore', before_turn: scenario.restore_before_turn, kind: 'restore-fault', skill_id: probeSkillId,
      logical_operation: operation },
  ];
  return { requiresFixture: true, events, binding: { ...binding,
    events: [...(binding.events ?? []), ...events],
    diagnostic: { version: 1, kind: policy.kind, policy_sha256: fingerprint(policy), scenario_id: scenario.id, arm,
      counterpart_condition_id: arm === 'clean' ? pair.fault : pair.clean, logical_operation: operation,
      ...(scenario.probe_skill_id ? { fault_scope: 'owned-store', probe_skill_id: probeSkillId,
        expected_subject_operation: { skill_id: scenario.skill_id, path: 'SKILL.md', intent: 'first-use-business-consumption' },
        subject_operation_observed: false } : {}) },
  } };
}

export function episodeFixtureSelections({ cases, slots, candidates, diagnostics }) {
  const policy = validateDiagnosticSchedule(diagnostics, { cases, slots, candidates });
  const selected = new Map();
  for (const slot of slots) {
    const baseBinding = cases.find(binding => binding.id === slot.case_id); assert.ok(baseBinding, 'FIXTURE_CASE_NOT_FOUND');
    const selection = diagnosticBinding(baseBinding, slot.condition_id, policy);
    if (selection.requiresFixture) selected.set(slot.slot_id, { ...selection, baseBinding, slot });
  }
  return selected;
}
