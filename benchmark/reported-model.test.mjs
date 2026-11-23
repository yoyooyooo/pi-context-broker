import assert from 'node:assert/strict';
import test from 'node:test';
import { assessReportedModel, providerReportedModel, validateRoutingPolicy } from './reported-model.mjs';
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
