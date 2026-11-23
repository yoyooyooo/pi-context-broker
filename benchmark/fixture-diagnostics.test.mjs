import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCorpus, planCaseVariant } from './corpus/index.mjs';
import { fingerprint } from './protocol.mjs';
import { diagnosticBinding, episodeFixtureSelections, validateDiagnosticSchedule, validateFixtureDiagnostics } from './fixture-diagnostics.mjs';

function fixture() {
  const corpus = buildCorpus({ seed: 'diagnostic-freeze', split: 'development', materialVersion: '2' });
  const cases = ['implicit-01-a', 'references-01-b'].map(caseId => {
    const plan = planCaseVariant({ publicCorpus: corpus.publicCorpus, control: corpus.control, caseId, roundCount: 4 });
    return { id: plan.variant.id, public_case: plan.publicCase, events: plan.events,
      skill_inventory: plan.skills.flatMap(skill => skill.versions[skill.initial_version].files.map(file => ({ skill_id: skill.id, resource_path: file.path }))) };
  });
  const candidates = { 'm0-e0': { build_id: 'current', mode: 'broker' }, 'm0-e1': { build_id: 'reference', mode: 'broker' },
    'm0-e2': { build_id: 'current', mode: 'broker' }, 'm0-e3': { build_id: 'reference', mode: 'broker' } };
  const slots = cases.flatMap(binding => Object.keys(candidates).map(condition_id => ({ slot_id: condition_id + '--' + binding.id,
    case_id: binding.id, condition_id, repeat: 0 })));
  const diagnostics = { version: 1, kind: 'owned-store-clean-fault', pairs: [{ clean: 'm0-e0', fault: 'm0-e2' }, { clean: 'm0-e1', fault: 'm0-e3' }],
    scenarios: cases.map((binding, index) => ({ id: 'owned-read-' + index, case_id: binding.id,
      skill_id: corpus.control.cases.find(item => item.case_id === binding.public_case.id).target_skill_ids[0],
      mode: index === 0 ? 'missing-manifest' : 'store-unavailable', before_turn: 'turn-2', restore_before_turn: 'turn-3' })) };
  return { cases, candidates, slots, diagnostics };
}

test('the complete eight-cell design isolates both arms without changing tasks or graders', () => {
  const args = fixture(), original = fingerprint(args.cases);
  const selected = episodeFixtureSelections(args); assert.equal(selected.size, 8);
  assert.equal(fingerprint(args.cases), original);
  for (const slot of args.slots) {
    const actual = selected.get(slot.slot_id), canonical = args.cases.find(binding => binding.id === slot.case_id);
    assert.equal(actual.requiresFixture, true);
    assert.deepEqual(actual.binding.public_case, canonical.public_case);
    const fault = ['m0-e2', 'm0-e3'].includes(slot.condition_id);
    assert.equal(actual.binding.diagnostic.arm, fault ? 'fault' : 'clean');
    assert.equal(actual.events.length, fault ? 2 : 0);
    assert.deepEqual(actual.binding.events, actual.events);
    if (fault) {
      assert.deepEqual(actual.events.map(event => event.before_turn), ['turn-2', 'turn-3']);
      assert.deepEqual(actual.events[0].logical_operation, actual.events[1].logical_operation);
    }
  }
});

test('diagnostics reject a native surface, crossed versions, incomplete cells and changed event timing before effects', () => {
  const mutations = [
    args => { args.candidates['m0-e3'].mode = 'native'; },
    args => { args.candidates['m0-e2'].build_id = 'unpaired'; },
    args => { args.candidates['m0-e1'].build_id = args.candidates['m0-e3'].build_id = 'current'; },
    args => { args.slots.pop(); },
    args => { args.slots[0] = args.slots[1]; },
    args => { args.slots[0].repeat = 1; },
    args => { args.diagnostics.pairs[1].clean = 'm0-e0'; },
    args => { args.diagnostics.scenarios[0].before_turn = 'turn-1'; },
    args => { args.diagnostics.scenarios[0].restore_before_turn = 'turn-2'; },
    args => { args.diagnostics.scenarios[0].restore_before_turn = 'missing-turn'; },
    args => { args.diagnostics.scenarios[0].skill_id = 'not-visible'; },
    args => { args.diagnostics.scenarios[0].mode = 'arbitrary-command'; },
    args => { args.diagnostics.scenarios[0].command = 'never-execute'; },
    args => { args.cases[0].events.push({ id: args.diagnostics.scenarios[0].id + '-fault' }); },
  ];
  for (const mutate of mutations) {
    const args = fixture(); mutate(args);
    assert.throws(() => validateDiagnosticSchedule(args.diagnostics, args));
  }
});

test('a diagnostic policy cannot add a fifth cell, third case or unregistered slot', () => {
  const args = fixture();
  assert.throws(() => validateFixtureDiagnostics({ ...args.diagnostics, extra: true }), /DIAGNOSTIC_POLICY_SHAPE/);
  const fifth = structuredClone(args); fifth.candidates['m1-e0'] = { build_id: 'current', mode: 'broker' };
  assert.throws(() => validateDiagnosticSchedule(fifth.diagnostics, fifth), /DIAGNOSTIC_SCHEDULE_CELLS/);
  const extra = structuredClone(args.diagnostics); extra.scenarios.push({ ...extra.scenarios[0], id: 'third' });
  assert.throws(() => validateFixtureDiagnostics(extra), /DIAGNOSTIC_TWO_JOURNEYS/);
  assert.throws(() => diagnosticBinding(args.cases[0], 'unregistered', args.diagnostics), /DIAGNOSTIC_UNDECLARED_SLOT/);
});

test('an absent policy keeps the existing stateful and read-only fixture selection', () => {
  const args = fixture(); delete args.diagnostics;
  assert.equal(episodeFixtureSelections(args).size, 0);
  args.cases[0].events = [{ id: 'owned-version', before_turn: 'turn-2', kind: 'publish-version' }];
  const selected = episodeFixtureSelections(args); assert.equal(selected.size, 4);
  for (const item of selected.values()) { assert.equal(item.binding, args.cases[0]); assert.deepEqual(item.events, []); }
});
