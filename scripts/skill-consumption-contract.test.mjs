import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumptionFixture, evaluateConsumptionEvidence, selfTest, validateMap, expandCoverage } from './skill-consumption-contract.mjs';

test('SC01 retains the full task and journey map without promoting draft routes', () => {
  const result = validateMap();
  assert.equal(result.tasks, 24);
  assert.equal(result.journeys, 21);
  const coverage = expandCoverage();
  assert.ok(coverage.length > 1000);
  assert.ok(coverage.every(row => ['not_run', 'not_applicable'].includes(row.status)));
  assert.ok(coverage.filter(row => row.status === 'not_applicable').every(row => row.reason));
  for (const axis of ['cache', 'session', 'entry', 'intent']) assert.ok(new Set(coverage.map(row => row[axis])).size > 3);
});

test('only observed provider spans prove complete delivery, independently of source hashes', () => {
  const fixture = consumptionFixture();
  assert.equal(evaluateConsumptionEvidence(fixture).status, 'evidence-contract-valid');
  assert.equal(evaluateConsumptionEvidence(fixture).productAcceptance, 'not-inferred');
  const summary = structuredClone(fixture);
  summary.providerInputs[0] = 'Skill loaded. Summary only.';
  assert.throws(() => evaluateConsumptionEvidence(summary), { code: 'DELIVERY_BYTES' });
  const cached = structuredClone(fixture); cached.deliveries = [];
  assert.throws(() => evaluateConsumptionEvidence(cached), { code: 'DELIVERY_MISSING' });
});

test('source and projection identities are independently verified', () => {
  for (const [mutate, code] of [
    [value => { value.sources[0].content += ' altered'; }, 'SOURCE_HASH'],
    [value => { value.projections[0].sourceSha256 = '0'.repeat(64); }, 'PROJECTION_SOURCE'],
    [value => { value.projections[0].content += ' altered'; }, 'PROJECTION_HASH'],
    [value => { value.deliveries[0].scope = 'other-credential-scope'; }, 'DELIVERY_IDENTITY'],
    [value => { value.deliveries[0].snapshot = 'other-version'; }, 'DELIVERY_IDENTITY'],
  ]) {
    const fixture = consumptionFixture(); mutate(fixture);
    assert.throws(() => evaluateConsumptionEvidence(fixture), { code });
  }
});

test('unobserved or truncated transport cannot establish zero calls', () => {
  for (const channel of ['notion', 'attachments', 'provider']) {
    for (const field of ['observed', 'complete']) {
      const fixture = consumptionFixture(); fixture.transport[channel][field] = false;
      assert.throws(() => evaluateConsumptionEvidence(fixture), { code: 'TRANSPORT_INCOMPLETE' });
    }
  }
  const fixture = consumptionFixture(); fixture.observerErrors.push('lost frame');
  assert.throws(() => evaluateConsumptionEvidence(fixture), { code: 'OBSERVER_FAILURE' });
});

test('log-only proof, duplicate content, oracle warming and suppressed failures are rejected', () => {
  for (const [mutate, code] of [
    [value => { value.providerInputs = []; }, 'PROVIDER_MISSING'],
    [value => { value.providerInputs[0] += value.projections[0].content; }, 'DUPLICATE_BODY'],
    [value => { value.isolation.oracleWarmedConsumer = true; }, 'ORACLE_WARMING'],
    [value => { value.isolation.hiddenLocalCopies = ['other-copy']; }, 'LOCAL_COPY'],
    [value => { value.isolation.forcedToolArguments = true; }, 'FORCED_TOOLS'],
    [value => { value.processes[0].closeObserved = false; }, 'PROCESS_EVIDENCE'],
    [value => { value.samples.retained = ['successful-run']; }, 'SAMPLE_LOSS'],
    [value => { value.cleanup.retainedEvidence = []; }, 'EVIDENCE_LOSS'],
  ]) {
    const fixture = consumptionFixture(); mutate(fixture);
    assert.throws(() => evaluateConsumptionEvidence(fixture), { code });
  }
});

test('compiled projections require a separately frozen contract and cannot replace the old graph gate', () => {
  const fixture = consumptionFixture();
  fixture.projections[0].compiler = 'unfrozen-minimal-projection';
  assert.throws(() => evaluateConsumptionEvidence(fixture), { code: 'PROJECTION_CONTRACT_DRAFT' });
});

test('offline self-test exercises the inherited anti-oracle contract and new observation failures', () => {
  const result = selfTest();
  assert.equal(result.status, 'passed');
  assert.ok(result.graph.tests >= 30);
  assert.ok(result.consumption.tests >= 15);
  assert.equal(result.productAcceptance, 'not-inferred');
});
