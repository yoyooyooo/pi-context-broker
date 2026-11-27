import assert from 'node:assert/strict';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const concreteId = value => typeof value === 'string' && value.length > 0 && value.length <= 240 &&
  !/\s/.test(value) && !value.split('/').some(segment => /^(?:auto|group)(?:-|$)/i.test(segment));
export const REPORTED_MODEL_ASSURANCE = 'provider_reported_label_not_backend_attestation';

export const canonicalAutoGroupLabel = modelVariant => 'group/auto-' + modelVariant.replaceAll('.', '-');
const declaredAutoGroupLabel = (routing, value) => routing.mode === 'auto-route' &&
  value === canonicalAutoGroupLabel(routing.model_variant) && routing.reported_model_ids.includes(value);
const declaredMixedRouteLabel = (routing, value) => routing.mode === 'mixed-route' &&
  value === routing.route && routing.reported_model_ids.includes(value);
const allowedLabel = (routing, value) => concreteId(value) ||
  routing.mode === 'auto-route' && value === 'auto/' + routing.model_variant || declaredAutoGroupLabel(routing, value)
  || declaredMixedRouteLabel(routing, value);

/** A mixed group binds its configuration hash and exact response labels separately
 * from fixed variants. Response labels never attest the underlying backend or the
 * live routing configuration; those require independent gateway observations. */
export function validateRoutingPolicy(routing) {
  assert.ok(object(routing), 'BENCHMARK_MODEL_ROUTING_REQUIRED');
  assert.ok(['fixed-route', 'auto-route', 'mixed-route'].includes(routing.mode), 'BENCHMARK_MODEL_ROUTING_MODE');
  assert.ok(Array.isArray(routing.reported_model_ids) && routing.reported_model_ids.length > 0 &&
    new Set(routing.reported_model_ids).size === routing.reported_model_ids.length, 'BENCHMARK_REPORTED_MODEL_ALLOWLIST_REQUIRED');
  if (routing.mode === 'mixed-route') {
    assert.deepEqual(Object.keys(routing).sort(), ['configuration_sha256', 'mode', 'reported_model_ids', 'route']);
    assert.ok(typeof routing.route === 'string' && /^group\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(routing.route), 'BENCHMARK_MIXED_ROUTE_REQUIRED');
    assert.match(routing.configuration_sha256, /^[a-f0-9]{64}$/, 'BENCHMARK_MIXED_CONFIGURATION_REQUIRED');
    for (const value of routing.reported_model_ids)
      assert.ok(concreteId(value) || declaredMixedRouteLabel(routing, value), 'BENCHMARK_MIXED_REPORTED_MODEL_ALIAS');
    return routing;
  }
  assert.deepEqual(Object.keys(routing).sort(), ['mode', 'model_variant', 'reported_model_ids']);
  assert.ok(typeof routing.model_variant === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(routing.model_variant), 'BENCHMARK_MODEL_VARIANT_REQUIRED');
  for (const value of routing.reported_model_ids) assert.ok(allowedLabel(routing, value) &&
    (value === routing.model_variant || value.endsWith('/' + routing.model_variant) || declaredAutoGroupLabel(routing, value)), 'BENCHMARK_REPORTED_MODEL_ALIAS_NOT_CONCRETE');
  return routing;
}

/** Read only the server response field. The surrounding SDK model is the request route. */
export function providerReportedModel(api, event) {
  const source = api === 'openai-completions' ? event : api === 'openai-responses' ? event?.response : null;
  if (!object(source) || !Object.hasOwn(source, 'model')) return null;
  return { value: structuredClone(source.model), field: api === 'openai-completions' ? '/data/event/model' : '/data/event/response/model' };
}

/** Recomputed independently by the runtime, collector and offline normalizer. */
export function assessReportedModel({ routing, sent, observations = [], providerError = false, refs = [] }) {
  validateRoutingPolicy(routing);
  assert.ok([true, false, null].includes(sent), 'BENCHMARK_REPORTED_MODEL_SEND_STATUS');
  assert.ok(Array.isArray(observations), 'BENCHMARK_REPORTED_MODEL_OBSERVATIONS_REQUIRED');
  const reportedIds = [...new Set(observations.filter(item => typeof item.value === 'string').map(item => item.value))];
  let status, reason = null;
  if (sent === false && observations.length) { status = 'mismatch'; reason = 'reported_model_send_contradiction'; }
  else if (sent === false) status = 'not_sent';
  else if (observations.some(item => item.bound === false)) {
    status = 'mismatch'; reason = 'reported_model_event_binding_mismatch';
  }
  else if (observations.some(item => !allowedLabel(routing, item.value) || !routing.reported_model_ids.includes(item.value))) {
    status = 'mismatch'; reason = 'reported_model_mismatch';
  } else if (sent === null) {
    status = 'send_unknown'; reason = providerError ? 'reported_model_unavailable_after_provider_error' : 'reported_model_send_unknown';
  } else if (!observations.length) {
    status = 'missing'; reason = providerError ? 'reported_model_unavailable_after_provider_error' : 'reported_model_missing';
  } else status = 'matched';
  const sources = [...new Map([...refs, ...observations.map(item => item.ref)].filter(Boolean).map(ref => [JSON.stringify(ref), ref])).values()];
  // An undeclared group remains unrecognized when replaying an older policy.
  const labelKind = !observations.length ? null : observations.some(item => item.value === 'auto/' + routing.model_variant
    || declaredAutoGroupLabel(routing, item.value) || declaredMixedRouteLabel(routing, item.value))
    ? 'requested_route_alias' : observations.every(item => concreteId(item.value)) ? 'concrete_reported_label' : 'unrecognized_label';
  return { status, reason, assurance: REPORTED_MODEL_ASSURANCE, label_kind: labelKind, reported_ids: reportedIds,
    observations: structuredClone(observations), provider_error: providerError === true, refs: structuredClone(sources) };
}
