import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCorpus, planCaseVariant, validateCorpus } from './corpus/index.mjs';
import { fingerprint } from './protocol.mjs';
import { buildStoreDiagnosticCorpus, STORE_FIRST_USE_GENERATOR } from './diagnostic-corpus.mjs';
import { diagnosticBinding, validateDiagnosticSchedule } from './fixture-diagnostics.mjs';

const options = { seed: 'store-first-use-test', split: 'development', materialVersion: '2' };

test('independent Store diagnostics retain a real warmup and three different first-use business batches', () => {
  const source = buildCorpus(options), original = fingerprint(source.publicCorpus), corpus = buildStoreDiagnosticCorpus(options);
  assert.equal(fingerprint(source.publicCorpus), original);
  assert.deepEqual(buildStoreDiagnosticCorpus(options).publicCorpus, corpus.publicCorpus);
  assert.notEqual(corpus.publicCorpus.content_sha256, source.publicCorpus.content_sha256);
  assert.equal(corpus.publicCorpus.provenance.generator, STORE_FIRST_USE_GENERATOR);
  assert.equal(validateCorpus(corpus).case_count, 2);
  assert.equal(new Set(corpus.publicCorpus.cases.map(item => item.cluster_id)).size, 2);
  for (const item of corpus.publicCorpus.cases) {
    assert.ok(!source.publicCorpus.cases.some(old => old.id === item.id));
    const controlled = corpus.control.cases.find(value => value.case_id === item.id), expected = controlled.diagnostic;
    const warmup = planCaseVariant({ ...source, caseId: expected.source_case_ids[0] });
    const target = planCaseVariant({ ...source, caseId: expected.source_case_ids[1], roundCount: 4 });
    assert.equal(item.turns.length, 4); assert.equal(item.attachments.length, 4);
    assert.equal(new Set(item.attachments.map(file => file.sha256)).size, 4);
    assert.deepEqual(item.turns[0], warmup.publicCase.turns[0]);
    assert.ok(item.turns[1].prompt.endsWith(target.publicCase.turns[0].prompt));
    assert.deepEqual(item.turns.slice(2).map(turn => turn.prompt), target.publicCase.turns.slice(1, 3).map(turn => turn.prompt));
    assert.notEqual(expected.probe_skill_id, expected.expected_target_skill_id);
    assert.equal(expected.observed_target_consumption, false);
    const business = controlled.oracles[4].contracts.filter(contract => contract.kind === 'artifact-json');
    assert.deepEqual(business.map(contract => contract.turn_id), ['turn-1', 'turn-2', 'turn-3', 'turn-4']);
    assert.equal(new Set(business.map(contract => contract.path)).size, 4);
    assert.deepEqual(business[0].expected, warmup.oracle.contracts.find(contract => contract.kind === 'artifact-json').expected);
    assert.deepEqual(business.slice(1).map(contract => contract.expected), target.oracle.contracts.filter(contract => contract.kind === 'artifact-json').slice(0, 3).map(contract => contract.expected));
    assert.equal(item.authorization.remote_write, false);
    assert.throws(() => planCaseVariant({ ...corpus, caseId: item.id, roundCount: 8 }), /not registered/);
  }
  assert.throws(() => buildStoreDiagnosticCorpus({ ...options, split: 'confirmation' }), /development/);
});

test('a global Store fault records probe A separately from the unobserved prospective target B', () => {
  const corpus = buildStoreDiagnosticCorpus(options);
  const cases = corpus.publicCorpus.cases.map(item => {
    const plan = planCaseVariant({ ...corpus, caseId: item.id });
    return { id: plan.variant.id, public_case: plan.publicCase, events: plan.events,
      skill_inventory: plan.skills.flatMap(skill => skill.versions[skill.initial_version].files.map(file => ({ skill_id: skill.id, resource_path: file.path }))) };
  });
  const candidates = Object.fromEntries([0, 1, 2, 3].map(index => ['m0-e' + index, { mode: 'broker', build_id: index % 2 ? 'reference' : 'candidate' }]));
  const slots = cases.flatMap(binding => Object.keys(candidates).map(condition_id => ({ slot_id: condition_id + binding.id, condition_id, case_id: binding.id, repeat: 0 })));
  const policy = { version: 1, kind: 'owned-store-clean-fault', pairs: [{ clean: 'm0-e0', fault: 'm0-e2' }, { clean: 'm0-e1', fault: 'm0-e3' }],
    scenarios: cases.map((binding, index) => { const spec = corpus.control.cases[index].diagnostic; return {
      id: 'first-use-' + index, case_id: binding.id, skill_id: spec.expected_target_skill_id, probe_skill_id: spec.probe_skill_id,
      mode: 'store-unavailable', before_turn: 'turn-2', restore_before_turn: 'turn-3' };
    }) };
  validateDiagnosticSchedule(policy, { cases, candidates, slots });
  for (const binding of cases) {
    const clean = diagnosticBinding(binding, 'm0-e0', policy), fault = diagnosticBinding(binding, 'm0-e2', policy);
    assert.deepEqual(clean.binding.public_case, fault.binding.public_case);
    const diagnostic = fault.binding.diagnostic;
    assert.equal(diagnostic.fault_scope, 'owned-store'); assert.equal(diagnostic.subject_operation_observed, false);
    assert.notEqual(diagnostic.probe_skill_id, diagnostic.expected_subject_operation.skill_id);
    assert.ok(fault.events.every(event => event.skill_id === diagnostic.probe_skill_id && event.logical_operation.skill_id === diagnostic.probe_skill_id));
  }
  const local = structuredClone(policy); local.scenarios[0].mode = 'missing-manifest';
  assert.throws(() => validateDiagnosticSchedule(local, { cases, candidates, slots }), /GLOBAL_STORE_FAULT/);
  const absent = structuredClone(policy); absent.scenarios[0].probe_skill_id = 'not-in-catalog';
  assert.throws(() => validateDiagnosticSchedule(absent, { cases, candidates, slots }), /PROBE_OUTSIDE_MATERIAL/);
});
