import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCorpus, planCaseVariant, validateCorpus, rebindCorpusCatalog, gradeEpisode } from './corpus/index.mjs';
import { fingerprint } from './protocol.mjs';
import { buildStoreDiagnosticCorpus, STORE_FIRST_USE_GENERATOR, buildLongSessionDiagnosticCorpus, LONG_SESSION_GENERATOR } from './diagnostic-corpus.mjs';
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

test('long-session cases retain exact source Skills and share one material cluster without changing old cases', () => {
  const source = buildCorpus(options), before = fingerprint(source.publicCorpus), corpus = buildLongSessionDiagnosticCorpus(options);
  assert.equal(fingerprint(source.publicCorpus), before);
  assert.equal(validateCorpus(corpus).case_count, 2);
  assert.deepEqual(corpus.publicCorpus.skills, source.publicCorpus.skills);
  assert.deepEqual(buildLongSessionDiagnosticCorpus(options).publicCorpus, corpus.publicCorpus);
  assert.equal(corpus.publicCorpus.provenance.generator, LONG_SESSION_GENERATOR);
  assert.equal(corpus.publicCorpus.provenance.composition_source_sha256, source.publicCorpus.content_sha256);
  assert.equal(new Set(corpus.publicCorpus.cases.map(item => item.cluster_id)).size, 1);
  assert.ok(corpus.publicCorpus.cases.every(item => !source.publicCorpus.cases.some(old => old.id === item.id)));
  const skillIds = ['implicit-01-a-routing', 'explicit-01-a-refund', 'continuation-01-a-routing',
    'complementary-01-a-privacy', 'complementary-01-a-reconcile', 'references-01-a-grant', 'scripts-assets-02-a-tariff',
    ...source.publicCorpus.distractor_skill_ids.slice(0, 9)];
  const rebound = rebindCorpusCatalog({ corpus, caseIds: corpus.publicCorpus.cases.map(item => item.id), skillIds,
    reason: 'Reuse unchanged source material in the declared sixteen-candidate catalog' });
  assert.equal(validateCorpus(rebound).case_count, 2);
  assert.deepEqual(rebound.publicCorpus.skills, source.publicCorpus.skills);
  for (const item of rebound.publicCorpus.cases) assert.deepEqual(new Set(item.catalog.skill_ids), new Set(skillIds));
  assert.throws(() => buildLongSessionDiagnosticCorpus({ ...options, split: 'confirmation' }), /development/);
  assert.throws(() => buildLongSessionDiagnosticCorpus({ ...options, materialVersion: '1' }));
});

test('eight-turn prompts expose only their own inputs and vary both rules and ordinary work', () => {
  const corpus = buildLongSessionDiagnosticCorpus(options);
  for (const item of corpus.publicCorpus.cases) {
    assert.equal(item.turns.length, 8); assert.deepEqual(item.attachments, []); assert.deepEqual(item.variants, {});
    assert.throws(() => planCaseVariant({ ...corpus, caseId: item.id, roundCount: 4 }), /not registered/);
    const controlled = corpus.control.cases.find(control => control.case_id === item.id);
    const business = controlled.oracles[8].contracts.filter(contract => contract.kind === 'artifact-json');
    assert.deepEqual(business.map(contract => contract.turn_id), item.turns.map(turn => turn.id));
    assert.equal(new Set(business.map(contract => contract.path)).size, 8);
    for (const [index, turn] of item.turns.entries()) {
      assert.deepEqual(turn.attachment_paths, []);
      assert.doesNotMatch(turn.prompt, /notion_use|notion_list|notion_ctl|oracle|benchmark|下一轮|重新读取|不要重读|反超|摊薄|refresh/iu);
      const rows = JSON.parse(turn.prompt.split('\n')[1]);
      assert.ok(rows.length >= 3);
      for (const earlier of item.turns.slice(0, index)) {
        assert.ok(rows.every(row => !earlier.prompt.includes(row.id)), 'Future input rows leaked into an earlier prompt');
        assert.ok(!earlier.prompt.includes(business[index].path), 'Future output task leaked into an earlier prompt');
      }
    }
    const resources = controlled.oracles[8].contracts.filter(contract => contract.kind === 'resources');
    assert.ok(resources.every(contract => contract.alternatives.flat().every(item => !Object.hasOwn(item, 'turn_id'))), 'Resource contracts must allow history reuse');
    assert.deepEqual(controlled.events, []); assert.equal(item.authorization.remote_write, false);
  }
  const reused = corpus.control.cases.find(item => item.case_id === 'long-session-reuse-a');
  assert.equal(new Set(reused.oracles[8].contracts.filter(contract => contract.kind === 'artifact-json')
    .map(contract => contract.expected.map(row => row.route).join(','))).size, 8, 'Successive output categories must not be a repeated template');
  const switched = corpus.control.cases.find(item => item.case_id === 'long-session-switch-a');
  assert.deepEqual(switched.diagnostic.turn_requirements.map(item => item.task), ['routing', 'amounts', 'refund', 'statuses', 'routing', 'refund', 'groups', 'routing']);
  assert.deepEqual(switched.diagnostic.first_required_turns, [
    { skill_id: 'implicit-01-a-routing', turn_id: 'turn-1' }, { skill_id: 'explicit-01-a-refund', turn_id: 'turn-3' }]);
  const normal = corpus.publicCorpus.cases.find(item => item.id === switched.case_id).turns.filter((_, index) => [1, 3, 6].includes(index));
  assert.ok(normal.every(turn => !/Skill|运输路由|退货审批|bm-|读取/iu.test(turn.prompt)));
});

test('long-session oracles reject copied categories and output delivered on the wrong turn', () => {
  const corpus = buildLongSessionDiagnosticCorpus(options);
  for (const controlled of corpus.control.cases) {
    const oracle = controlled.oracles[8], business = oracle.contracts.filter(contract => contract.kind === 'artifact-json');
    const evidence = {
      artifacts: business.map(contract => ({ evidence_id: contract.id, path: contract.path, turn_id: contract.turn_id, content: JSON.stringify(contract.expected) })),
      resource_reads: oracle.contracts.filter(contract => contract.kind === 'resources').flatMap(contract => contract.alternatives[0]
        .map((row, index) => ({ ...row, evidence_id: contract.id + '-' + index, turn_id: controlled.diagnostic.first_required_turns.find(item => item.skill_id === row.skill_id).turn_id }))),
      selections: controlled.target_skill_ids.map(skill_id => ({ evidence_id: 'selected-' + skill_id, skill_id })),
      coverage: { artifacts: 'complete', resource_reads: 'complete', selections: 'complete' },
    };
    assert.equal(gradeEpisode({ oracle, evidence, capabilities: oracle.required_capabilities }).verified_success, true);
    const wrongTurn = structuredClone(evidence); wrongTurn.artifacts[0].turn_id = 'turn-2';
    const delayed = gradeEpisode({ oracle, evidence: wrongTurn, capabilities: oracle.required_capabilities });
    assert.equal(delayed.contracts.find(contract => contract.id === business[0].id).status, 'fail');
    const routeBusiness = business.filter(contract => Array.isArray(contract.expected) && Object.hasOwn(contract.expected[0], 'route'));
    const first = routeBusiness[0], later = routeBusiness[1], copied = structuredClone(evidence);
    copied.artifacts.find(artifact => artifact.path === later.path).content = JSON.stringify(later.expected.map((row, index) => ({ ...row, route: first.expected[index].route })));
    const copyGrade = gradeEpisode({ oracle, evidence: copied, capabilities: oracle.required_capabilities });
    assert.equal(copyGrade.contracts.find(contract => contract.id === later.id).status, 'fail');
    const incomplete = structuredClone(evidence); incomplete.resource_reads = []; incomplete.coverage.resource_reads = 'partial';
    const resourceGrade = gradeEpisode({ oracle, evidence: incomplete, capabilities: oracle.required_capabilities });
    assert.equal(resourceGrade.business_outcome, 'pass'); assert.equal(resourceGrade.verified_success, false);
    assert.ok(resourceGrade.contracts.filter(contract => contract.kind === 'resources').every(contract => contract.status === 'unknown'));
  }
});
