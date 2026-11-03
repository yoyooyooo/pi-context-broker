import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT_VERSION, EVIDENCE_COLUMNS, NEGATIVE_CASES, contractFixture, evaluateGraphTrace, frozenPrompt, selfTest } from './verify-skill-graph-contract.mjs';

test('Gate A and B freeze only their own root and the same natural task', () => {
  const a = frozenPrompt('A', '$pstack@notion'), b = frozenPrompt('B', '$poteto-mode@notion');
  assert.equal(a.version, CONTRACT_VERSION);
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
