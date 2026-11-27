import assert from 'node:assert/strict';
import test from 'node:test';
import { assessReportedModel, canonicalAutoGroupLabel, providerReportedModel, validateRoutingPolicy } from './reported-model.mjs';
import { verifiedModelConditions } from './models.mjs';

const routing = { mode: 'auto-route', model_variant: 'grok-4.7', reported_model_ids: ['grok-4.7', 'grok/grok-4.7'] };
const ref = line => ({ artifact_id: 'events', sha256: 'a'.repeat(64), line });
const observation = (value, line = 1) => ({ value, field: '/data/event/response/model', ref: ref(line) });

test('server model extraction never borrows the request route or normalized assistant model', () => {
  assert.equal(providerReportedModel('openai-completions', { response: { model: 'grok-4.7' } }), null);
  assert.equal(providerReportedModel('openai-responses', { model: 'grok-4.7' }), null);
  assert.deepEqual(providerReportedModel('openai-responses', { response: { model: 'grok/grok-4.7' } }),
    { value: 'grok/grok-4.7', field: '/data/event/response/model' });
  assert.deepEqual(providerReportedModel('openai-completions', { model: 'grok-4.7' }),
    { value: 'grok-4.7', field: '/data/event/model' });
});

test('every raw label is retained and an intervening wrong variant cannot be hidden by the final label', () => {
  const observations = ['grok/grok-4.7', 'grok/grok-4.6', 'grok/grok-4.7'].map((value,index)=>observation(value,index+1));
  const report = assessReportedModel({ routing, sent: true, observations });
  assert.equal(report.status, 'mismatch'); assert.equal(report.reason, 'reported_model_mismatch');
  assert.deepEqual(report.observations, observations); assert.equal(report.refs.length, 3);
  assert.equal(report.assurance, 'provider_reported_label_not_backend_attestation');
});

test('group labels and malformed labels are not concrete variant proof', () => {
  for (const value of ['auto/grok-4.7', 'provider/group/grok-4.7', '', ' grok-4.7', null, 47])
    assert.equal(assessReportedModel({ routing, sent: true, observations: [observation(value)] }).status, 'mismatch');
  assert.throws(() => validateRoutingPolicy({ ...routing, mode: 'fixed-route', reported_model_ids: ['auto/grok-4.7'] }));
  assert.throws(() => validateRoutingPolicy({ ...routing, reported_model_ids: ['group/grok-4.7'] }));
  assert.throws(() => validateRoutingPolicy({ ...routing, reported_model_ids: ['grok/grok-4.6'] }));
});

test('missing label, provider failure, unbound event and a pre-send capture have distinct results', () => {
  assert.equal(assessReportedModel({ routing, sent: true }).reason, 'reported_model_missing');
  assert.equal(assessReportedModel({ routing, sent: true, providerError: true }).reason, 'reported_model_unavailable_after_provider_error');
  assert.equal(assessReportedModel({ routing, sent: null, providerError: true }).status, 'send_unknown');
  assert.equal(assessReportedModel({ routing, sent: false }).status, 'not_sent');
  assert.equal(assessReportedModel({ routing, sent: false, observations: [observation('grok-4.7')] }).reason, 'reported_model_send_contradiction');
  assert.equal(assessReportedModel({ routing, sent: true, observations: [{ ...observation('grok-4.7'), bound: false }] }).reason, 'reported_model_event_binding_mismatch');
});

test('an explicitly frozen exact auto-route echo is a route label with opaque backend identity', () => {
  const policy = { ...routing, reported_model_ids: [...routing.reported_model_ids, 'auto/grok-4.7'] };
  validateRoutingPolicy(policy);
  const report = assessReportedModel({ routing: policy, sent: true, observations: [observation('auto/grok-4.7')] });
  assert.equal(report.status, 'matched'); assert.equal(report.label_kind, 'requested_route_alias');
  assert.equal(report.assurance, 'provider_reported_label_not_backend_attestation');
  for (const value of ['auto/grok-4.6', 'another/auto/grok-4.7', 'auto/another/grok-4.7', 'group/grok-4.7'])
    assert.equal(assessReportedModel({ routing: policy, sent: true, observations: [observation(value)] }).status, 'mismatch');
  assert.equal(assessReportedModel({ routing: policy, sent: true, observations: [observation('grok/grok-4.7')] }).label_kind, 'concrete_reported_label');
});

test('routing is frozen per exact selected route while legacy model conditions remain unchanged', () => {
  const args = { registry: { provider: 'unit', models: [{ id: 'auto/grok-4.7', api: 'openai-responses', maxTokens: 256 }] },
    adapterReceipts: [{ api: 'openai-responses', id: 'adapter', version: '1', status: 'passed', sha256: 'a'.repeat(64) }],
    parameters: { maxTokens: 128 }, window: { start: '2026-11-22T00:00:00Z', end: '2026-11-23T00:00:00Z' } };
  assert.equal(Object.hasOwn(verifiedModelConditions(args)[0], 'routing'), false);
  const policy = structuredClone(routing), models = verifiedModelConditions({ ...args, routing: { 'auto/grok-4.7': policy } });
  policy.reported_model_ids.length = 0;
  assert.deepEqual(models[0].routing, routing);
  assert.throws(() => verifiedModelConditions({ ...args, routing: {} }), /Every selected route/);
  assert.throws(() => verifiedModelConditions({ ...args, routing: { 'auto/grok-4.7': routing, extra: routing } }), /Every selected route/);
});

test('canonical auto-group echoes require an explicit declaration for the exact variant', () => {
  for (const [variant, label] of [['grok-4.7', 'group/auto-grok-4-7'], ['gpt-6.1-terra', 'group/auto-gpt-6-1-terra'],
    ['gpt-6.2-sol', 'group/auto-gpt-6-2-sol'], ['fixture-0', 'group/auto-fixture-0']]) {
    assert.equal(canonicalAutoGroupLabel(variant), label);
    const policy = { mode: 'auto-route', model_variant: variant, reported_model_ids: [variant, label] };
    validateRoutingPolicy(policy);
    const result = assessReportedModel({ routing: policy, sent: true, observations: [observation(label)] });
    assert.equal(result.status, 'matched'); assert.equal(result.label_kind, 'requested_route_alias');
    assert.equal(result.assurance, 'provider_reported_label_not_backend_attestation');
    assert.throws(() => validateRoutingPolicy({ ...policy, mode: 'fixed-route' }), /ALIAS_NOT_CONCRETE/);
  }
});

test('a prior undeclared group failure retains its full original mismatch report', () => {
  const observations = [observation('group/auto-grok-4-7')];
  assert.deepEqual(assessReportedModel({ routing, sent: true, observations }), {
    status: 'mismatch', reason: 'reported_model_mismatch', assurance: 'provider_reported_label_not_backend_attestation',
    label_kind: 'unrecognized_label', reported_ids: ['group/auto-grok-4-7'], observations,
    provider_error: false, refs: [ref(1)],
  });
});

test('declaring one canonical auto group cannot admit another group, variant or unbound observation', () => {
  const policy = { ...routing, reported_model_ids: [...routing.reported_model_ids, 'group/auto-grok-4-7'] };
  for (const value of ['group/grok-4.7', 'group/auto-grok-4-6', 'group/auto-grok-4.7', 'group/worker',
    'provider/group/auto-grok-4-7', 'group/auto-grok-4-7/extra', 'group/auto-grok-4-7 ', 'GROUP/auto-grok-4-7', null]) {
    assert.equal(assessReportedModel({ routing: policy, sent: true, observations: [observation(value)] }).status, 'mismatch');
    assert.throws(() => validateRoutingPolicy({ ...policy, reported_model_ids: [value] }));
  }
  assert.equal(assessReportedModel({ routing: policy, sent: true,
    observations: [{ ...observation('group/auto-grok-4-7'), bound: false }] }).reason, 'reported_model_event_binding_mismatch');
  const mixed = assessReportedModel({ routing: policy, sent: true,
    observations: ['group/auto-grok-4-7', 'group/auto-grok-4-6', 'grok-4.7'].map((value, i) => observation(value, i + 1)) });
  assert.equal(mixed.status, 'mismatch'); assert.equal(mixed.observations.length, 3);
  assert.equal(assessReportedModel({ routing: policy, sent: false,
    observations: [observation('group/auto-grok-4-7')] }).reason, 'reported_model_send_contradiction');
});

const mixedRouting = () => ({ mode: 'mixed-route', route: 'group/flash', configuration_sha256: 'b'.repeat(64),
  reported_model_ids: ['group/flash', 'deepseek-v4.1-flash', 'provider/gpt-6.1-terra'] });

test('an explicit mixed route retains every declared fallback model without claiming a single variant', () => {
  const policy = mixedRouting(); validateRoutingPolicy(policy);
  const observations = ['deepseek-v4.1-flash', 'provider/gpt-6.1-terra', 'deepseek-v4.1-flash']
    .map((value, index) => observation(value, index + 1));
  const report = assessReportedModel({ routing: policy, sent: true, observations });
  assert.equal(report.status, 'matched'); assert.equal(report.reason, null);
  assert.equal(report.label_kind, 'concrete_reported_label');
  assert.deepEqual(report.reported_ids, ['deepseek-v4.1-flash', 'provider/gpt-6.1-terra']);
  assert.deepEqual(report.observations, observations); assert.equal(report.refs.length, 3);
  assert.equal(report.assurance, 'provider_reported_label_not_backend_attestation');
  assert.equal(Object.hasOwn(policy, 'model_variant'), false);
});

test('a mixed-group echo identifies only the exact declared route, never its backend', () => {
  const policy = mixedRouting();
  const report = assessReportedModel({ routing: policy, sent: true, observations: [observation('group/flash')] });
  assert.equal(report.status, 'matched'); assert.equal(report.label_kind, 'requested_route_alias');
  assert.equal(report.assurance, 'provider_reported_label_not_backend_attestation');
  for (const value of ['group/worker', 'provider/group/flash', 'auto/deepseek-v4.1-flash', 'group/flash ', 'unknown-model'])
    assert.equal(assessReportedModel({ routing: policy, sent: true, observations: [observation(value)] }).status, 'mismatch');
  const concreteOnly = { ...policy, reported_model_ids: policy.reported_model_ids.slice(1) };
  assert.equal(assessReportedModel({ routing: concreteOnly, sent: true, observations: [observation('group/flash')] }).status, 'mismatch');
});

test('mixed identity still rejects missing, unbound and send-contradicting observations', () => {
  const policy = mixedRouting();
  assert.equal(assessReportedModel({ routing: policy, sent: true }).reason, 'reported_model_missing');
  assert.equal(assessReportedModel({ routing: policy, sent: null, providerError: true }).status, 'send_unknown');
  assert.equal(assessReportedModel({ routing: policy, sent: false }).status, 'not_sent');
  assert.equal(assessReportedModel({ routing: policy, sent: false, observations: [observation('group/flash')] }).reason, 'reported_model_send_contradiction');
  assert.equal(assessReportedModel({ routing: policy, sent: true,
    observations: [{ ...observation('deepseek-v4.1-flash'), bound: false }] }).reason, 'reported_model_event_binding_mismatch');
  const report = assessReportedModel({ routing: policy, sent: true,
    observations: ['deepseek-v4.1-flash', 'undeclared-model', 'provider/gpt-6.1-terra'].map((value, index) => observation(value, index + 1)) });
  assert.equal(report.status, 'mismatch'); assert.equal(report.observations.length, 3);
});

test('mixed routing requires its own closed configuration and cannot weaken a fixed model policy', () => {
  for (const change of [
    policy => { delete policy.configuration_sha256; },
    policy => { policy.configuration_sha256 = 'not-a-hash'; },
    policy => { policy.route = 'provider/group/flash'; },
    policy => { policy.route = 'auto/deepseek-v4.1-flash'; },
    policy => { policy.model_variant = 'deepseek-v4.1-flash'; },
    policy => { policy.reported_model_ids = ['group/worker']; },
    policy => { policy.reported_model_ids = ['auto/gpt-6.1-terra']; },
    policy => { policy.reported_model_ids.push('group/flash'); },
    policy => { policy.mode = 'fixed-route'; },
  ]) { const policy = mixedRouting(); change(policy); assert.throws(() => validateRoutingPolicy(policy)); }
  assert.throws(() => validateRoutingPolicy({ ...routing, mode: 'mixed-route' }));
  assert.throws(() => validateRoutingPolicy({ ...routing, reported_model_ids: ['grok-4.7', 'deepseek-v4.1-flash'] }));
});

test('model selection freezes the mixed closure independently from the caller and other routes', () => {
  const policy = mixedRouting();
  const args = { registry: { provider: 'unit', models: [{ id: 'group/flash', api: 'openai-completions', maxTokens: 256 }] },
    adapterReceipts: [{ api: 'openai-completions', id: 'adapter', version: '1', status: 'passed', sha256: 'a'.repeat(64) }],
    parameters: { maxTokens: 128 }, window: { start: '2026-11-27T00:00:00Z', end: '2026-11-27T01:00:00Z' },
    routing: { 'group/flash': policy } };
  const [model] = verifiedModelConditions(args);
  assert.equal(model.route, 'group/flash'); assert.equal(model.family, 'group/flash');
  assert.deepEqual(model.routing, policy);
  policy.configuration_sha256 = 'c'.repeat(64); policy.reported_model_ids.length = 0;
  assert.deepEqual(model.routing, mixedRouting());
});
