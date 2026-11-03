import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_VERSION, PROMPT_VERSION, TASK, TASK_V1, EVIDENCE_COLUMNS, NEGATIVE_CASES, contractFixture, evaluateGraphTrace, frozenPrompt, selfTest } from './verify-skill-graph-contract.mjs';

test('prompt v2 clarifies complete file delivery while preserving v1 and the trace/oracle schema', () => {
  assert.equal(CONTRACT_VERSION, 1); assert.equal(PROMPT_VERSION, 2);
  const old = frozenPrompt('A', '$pstack@notion', 1), current = frozenPrompt('A', '$pstack@notion');
  assert.equal(old.text, '$pstack@notion ' + TASK_V1);
  assert.equal(current.text, '$pstack@notion ' + TASK);
  assert.notEqual(old.sha256, current.sha256);
  assert.equal(frozenPrompt('B', '$poteto-mode@notion').text.split(' ').slice(1).join(' '), TASK);
  assert.ok(!/create-verification-skill|skill:\/\/|feature-map|README/.test(TASK));
  const historical = contractFixture('A'); historical.trace.prompt = old;
  assert.equal(historical.oracle.version, 1); assert.equal(historical.trace.version, 1);
  assert.equal(evaluateGraphTrace(historical.trace, historical.oracle).status, 'contract-valid');
  assert.throws(() => frozenPrompt('A', '$pstack@notion', 3), { code: 'PROMPT_VERSION' });
});

test('Gate A and B freeze only their own root and the same natural task', () => {
  const a = frozenPrompt('A', '$pstack@notion'), b = frozenPrompt('B', '$poteto-mode@notion');
  assert.equal(a.version, PROMPT_VERSION);
  assert.ok(!a.text.includes('poteto-mode'));
  assert.ok(!b.text.toLowerCase().includes('pstack'));
  for (const value of [a, b]) assert.ok(!value.text.includes('create-verification-skill') && !value.text.includes('skill://'));
  assert.throws(() => frozenPrompt('A', '$pstack@notion $leaf'), { code: 'ROOT_SELECTION' });
  assert.throws(() => frozenPrompt('B', '$pstack@notion'), { code: 'ROOT_SELECTION' });
});

for (const gate of ['A', 'B']) test(`controlled positive contract ${gate} never claims a product pass`, () => {
  const fixture = contractFixture(gate), result = evaluateGraphTrace(fixture.trace, fixture.oracle);
  assert.equal(result.status, 'contract-valid');
  assert.equal(result.productAcceptance, 'not-inferred');
  assert.equal(result.observedNodes, 2);
});

for (const [id, code, mutate] of NEGATIVE_CASES) test(`reject ${id}`, () => {
  const fixture = contractFixture(); mutate(fixture);
  assert.throws(() => evaluateGraphTrace(fixture.trace, fixture.oracle), { code });
});

test('warm mode keeps oracle isolation and can reuse verified content', () => {
  const fixture = contractFixture();
  fixture.trace.cacheMode = 'warm';
  fixture.trace.isolation.prelaunch[0].entries = 3;
  fixture.trace.httpAttempts[0].kind = 'metadata';
  assert.equal(evaluateGraphTrace(fixture.trace, fixture.oracle).status, 'contract-valid');
  fixture.trace.isolation.oracleRoots = [fixture.trace.isolation.consumerRoots[1]];
  assert.throws(() => evaluateGraphTrace(fixture.trace, fixture.oracle), { code: 'ORACLE_WARMING' });
});

test('an unpinned directory proves stable candidate identity while final consumption still requires the oracle pin', () => {
  const fixture = contractFixture();
  fixture.trace.candidates[0].ref = fixture.oracle.target.ref.split('?')[0];
  assert.equal(evaluateGraphTrace(fixture.trace, fixture.oracle).status, 'contract-valid');
  const wrongOwner = structuredClone(fixture); wrongOwner.trace.candidates[0].ref = 'skill://different-owner/SKILL.md';
  assert.throws(() => evaluateGraphTrace(wrongOwner.trace, wrongOwner.oracle), { code: 'CANDIDATE_IDENTITY' });
  const resource = structuredClone(fixture); resource.trace.candidates[0].ref = fixture.trace.candidates[0].ref.replace('/SKILL.md', '/references/other.md');
  assert.throws(() => evaluateGraphTrace(resource.trace, resource.oracle), { code: 'CANDIDATE_IDENTITY' });
  const wrongPin = structuredClone(fixture); wrongPin.trace.reads[0].snapshot = 'other-version';
  assert.throws(() => evaluateGraphTrace(wrongPin.trace, wrongPin.oracle), { code: 'IDENTITY_MISMATCH' });
});

test('unknown body attribution is an observation gap, while an observed early member remains eager', () => {
  const fixture = contractFixture();
  fixture.trace.memberBodyReadsBeforeSelection = null;
  assert.throws(() => evaluateGraphTrace(fixture.trace, fixture.oracle), { code: 'OBSERVATION_INCOMPLETE' });
  fixture.trace.memberBodyReadsBeforeSelection = 1;
  assert.throws(() => evaluateGraphTrace(fixture.trace, fixture.oracle), { code: 'EAGER_MEMBERS' });
});

test('worker requires retained flash-free failure evidence', () => {
  const fixture = contractFixture();
  fixture.trace.model.selector = 'magpie/group/worker';
  fixture.trace.model.previousFailures = [{ selector: 'magpie/group/flash-free', status: 'failed', evidenceSha256: 'retained-fixture-hash' }];
  assert.equal(evaluateGraphTrace(fixture.trace, fixture.oracle).status, 'contract-valid');
});

test('warm verified reuse permits an observed empty HTTP ledger', () => {
  const fixture = contractFixture();
  fixture.trace.cacheMode = 'warm';
  fixture.trace.httpAttempts = [];
  assert.equal(evaluateGraphTrace(fixture.trace, fixture.oracle).status, 'contract-valid');
  fixture.trace.httpLedgerObserved = false;
  assert.throws(() => evaluateGraphTrace(fixture.trace, fixture.oracle), { code: 'HTTP_LEDGER' });
});

test('a network failure or absent response request ID is preserved without invention', () => {
  const fixture = contractFixture();
  fixture.trace.httpAttempts.unshift({ transport: 'direct_http', kind: 'body', status: null, networkError: 'ECONNRESET', requestIdAvailable: false, requestId: null });
  fixture.trace.httpAttempts[1].requestIdAvailable = false;
  fixture.trace.httpAttempts[1].requestId = null;
  assert.equal(evaluateGraphTrace(fixture.trace, fixture.oracle).status, 'contract-valid');
});

test('schema existence or zero tests cannot stand in for this self-test', () => {
  const result = selfTest();
  assert.equal(result.tests, NEGATIVE_CASES.length + 2);
  assert.ok(result.tests >= 30);
  assert.ok(result.cases.every(row => row.evidenceKind === 'controlled' && row.status === 'passed'));
  assert.deepEqual(EVIDENCE_COLUMNS, ['controlled', 'real_service', 'real_model', 'real_ui', 'installed_package']);
});
