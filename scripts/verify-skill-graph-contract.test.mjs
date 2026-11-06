import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as modelContracts from './verify-skill-graph-contract.mjs';
import { CONTRACT_VERSION, PROMPT_VERSION, TASK, TASK_V1, EVIDENCE_COLUMNS, NEGATIVE_CASES, contractFixture, evaluateGraphTrace, frozenPrompt, selfTest } from './verify-skill-graph-contract.mjs';

const dailyConfig = () => ({ modelContract: 'daily-route-v1', model: 'magpie/group/flash', thinkingLevel: 'high', rpcTimeoutMs: 300000 });

test('daily route is an explicit frozen contract and cannot borrow legacy fallback authorization', () => {
  const profile = modelContracts.dailyRouteContract(dailyConfig());
  assert.deepEqual(profile, { ...dailyConfig(), controllerRetries: 0, fallback: 'forbidden',
    ownedProjectRetry: { retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } } });
  assert.equal(modelContracts.dailyRouteContract({ model: 'magpie/group/flash-free' }), undefined);
  for (const change of [
    { modelContract: 'unknown' }, { model: 'magpie/group/flash-free' }, { model: 'magpie/group/worker' },
    { thinkingLevel: 'off' }, { rpcTimeoutMs: 600000 }, { previousFailures: ['old-free-failure'] },
    { workerAuthorization: {} }, { fallback: 'allowed' }, { controllerRetries: 1 },
    { ownedProjectRetry: { retry: { enabled: true } } },
  ]) assert.throws(() => modelContracts.dailyRouteContract({ ...dailyConfig(), ...change }), JSON.stringify(change));
});

test('daily thinking is verified from actual session state without inventing a retry state field', () => {
  const profile = modelContracts.dailyRouteContract(dailyConfig());
  const state = { model: { provider: 'magpie', id: 'group/flash' }, thinkingLevel: 'high' };
  assert.deepEqual(modelContracts.verifyDailyRouteState(profile, state), { provider: 'magpie', model: 'group/flash', thinkingLevel: 'high' });
  for (const value of [undefined, {}, { ...state, thinkingLevel: 'off' },
    { ...state, model: { provider: 'magpie/group', id: 'flash' } },
    { ...state, model: { provider: 'magpie', id: 'group/flash-free' } }, { ...state, model: { provider: 'foreign', id: 'group/flash' } }])
    assert.throws(() => modelContracts.verifyDailyRouteState(profile, value));
});

function dailyEvidence(profile, requests = [{ sequence: 10 }, { sequence: 20 }]) {
  const bound = requests.map((request, index) => ({ ...request, model: profile.model, reasoningEffort: 'high',
    observedPayloadSha256: String(index + 1).repeat(64) }));
  return { states: [{ model: { provider: 'magpie', id: 'group/flash' }, thinkingLevel: 'high' }], requests: bound,
    transports: bound.map(request => ({ providerSequence: request.sequence, wireModel: 'group/flash',
      reasoningEffort: 'high', observedPayloadSha256: request.observedPayloadSha256 })),
    responses: bound.map(request => ({ providerSequence: request.sequence, providerPayloadSha256: request.observedPayloadSha256,
      provider: 'magpie', model: 'group/flash', responseModel: 'controlled/backend-v1', stopReason: 'stop',
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 } })) };
}

test('daily model evidence binds effective state, every wire effort and actual routed response usage', () => {
  const profile = modelContracts.dailyRouteContract(dailyConfig()), evidence = dailyEvidence(profile);
  assert.deepEqual(modelContracts.verifyDailyRouteEvidence(profile, evidence).responseModels, ['controlled/backend-v1']);
  for (const change of [value => { value.states = []; }, value => { value.states[0].thinkingLevel = 'off'; },
    value => { delete value.requests[0].reasoningEffort; }, value => { value.transports[0].reasoningEffort = 'low'; },
    value => { value.transports[0].observedPayloadSha256 = 'f'.repeat(64); }, value => { value.transports.push(value.transports[0]); },
    value => { value.responses[0].providerSequence = 999; }, value => { value.responses[0].responseModel = null; },
    value => { value.responses[0].model = 'group/worker'; }, value => { value.responses[0].usage = null; },
    value => { Object.assign(value.responses[0], { provider: 'magpie/group', model: 'flash' }); },
    value => { value.responses[0].usage.totalTokens = 0; }]) {
    const invalid = structuredClone(evidence); change(invalid);
    assert.throws(() => modelContracts.verifyDailyRouteEvidence(profile, invalid));
  }
});

test('graph evaluator requires the separate daily contract and its actual model evidence', () => {
  const { trace, oracle } = contractFixture(), profile = modelContracts.dailyRouteContract(dailyConfig());
  const evidence = dailyEvidence(profile, trace.providerRequests.map((request, index) => ({ ...request, sequence: index + 1 })));
  trace.modelProfile = profile; trace.model.selector = profile.model; trace.providerRequests = evidence.requests;
  Object.assign(trace.model, { stateReadbacks: evidence.states, transports: evidence.transports, responses: evidence.responses });
  assert.equal(evaluateGraphTrace(trace, oracle).status, 'contract-valid');
  for (const change of [value => { delete value.modelProfile; }, value => { value.model.workerAuthorization = {}; },
    value => { value.model.previousFailures = [{ selector: 'magpie/group/flash-free' }]; },
    value => { value.model.stateReadbacks[0].thinkingLevel = 'off'; }, value => { value.model.responses[0].responseModel = null; }]) {
    const invalid = structuredClone(trace); change(invalid);
    assert.throws(() => evaluateGraphTrace(invalid, oracle));
  }
});

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

function explicitWorkerAuthorization(trace, mutate = () => {}) {
  const receipt = { version: 1, kind: 'explicit-user-worker-authorization', model: 'magpie/group/worker',
    scope: { gate: trace.gate, rootRef: trace.selectedRoots[0], promptSha256: trace.prompt.sha256 },
    authorizationQuestion: 'Controlled fixture: authorize worker after task failure?', userReply: 'Controlled fixture: continue.' };
  mutate(receipt);
  const raw = JSON.stringify(receipt, null, 2) + '\n';
  return { path: '/private/tmp/controlled-worker-authorization.json', sha256: createHash('sha256').update(raw).digest('hex'), raw };
}

test('explicit worker authorization is independently checked without relaxing graph consumption', () => {
  for (const gate of ['A', 'B']) {
    const fixture = contractFixture(gate);
    fixture.trace.model.selector = 'magpie/group/worker';
    fixture.trace.model.workerAuthorization = explicitWorkerAuthorization(fixture.trace);
    assert.equal(evaluateGraphTrace(fixture.trace, fixture.oracle).status, 'contract-valid');
    fixture.trace.reads.pop();
    assert.throws(() => evaluateGraphTrace(fixture.trace, fixture.oracle), { code: 'READ_MISSING' });
  }
});

test('explicit worker authorization in a trace rejects tampering and authorization for another scope or model', () => {
  for (const mutate of [receipt => { receipt.model = 'another/model'; }, receipt => { receipt.scope.gate = 'B'; },
    receipt => { receipt.scope.rootRef += '-different'; }, receipt => { receipt.scope.promptSha256 = 'a'.repeat(64); },
    receipt => { receipt.extra = true; }, receipt => { receipt.scope.extra = true; }]) {
    const fixture = contractFixture(); fixture.trace.model.selector = 'magpie/group/worker';
    fixture.trace.model.workerAuthorization = explicitWorkerAuthorization(fixture.trace, mutate);
    assert.throws(() => evaluateGraphTrace(fixture.trace, fixture.oracle), { code: 'MODEL_AUTHORIZATION' });
  }
  const changed = contractFixture(); changed.trace.model.selector = 'magpie/group/worker';
  changed.trace.model.workerAuthorization = explicitWorkerAuthorization(changed.trace);
  changed.trace.model.workerAuthorization.raw += ' ';
  assert.throws(() => evaluateGraphTrace(changed.trace, changed.oracle), { code: 'MODEL_AUTHORIZATION' });
  const third = contractFixture(); third.trace.model.selector = 'another/model';
  third.trace.model.workerAuthorization = explicitWorkerAuthorization(third.trace);
  assert.throws(() => evaluateGraphTrace(third.trace, third.oracle), { code: 'MODEL_SELECTOR' });
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
