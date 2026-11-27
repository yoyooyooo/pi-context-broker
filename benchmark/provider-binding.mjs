import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');

export const isCredentialRedaction = value => value === '[REDACTED_CREDENTIAL]' || value === 'REDACTED_CREDENTIAL';

export function deriveRedactedProviderBinding({ event, request, requestStart, candidate, expected, admission,
  payload, attemptStart, transportStart, transportSent, transportEnd, model, refs = [], attemptId = request?.usage_attempt_id,
  publicProjection = false }) {
  try {
    assert.equal(typeof publicProjection, 'boolean');
    assert.equal(event.type, 'provider_stream_event');
    assert.ok(isCredentialRedaction(event.data.provider));
    assert.equal(event.data.request_id, request.id); assert.equal(event.data.attempt_id, attemptId);
    assert.equal(event.data.api, model.api); assert.equal(event.data.model, model.route ?? model.id);
    assert.deepEqual(candidate.projection, expected.projection);
    assert.deepEqual(admission.differences, []);
    const selected = candidate.projection.model;
    assert.equal(selected.provider, event.data.provider);
    assert.equal(selected.id, model.route ?? model.id); assert.equal(selected.api, model.api);
    assert.deepEqual(candidate.projection.model_parameters, model.parameters);
    assert.equal(requestStart.type, 'model_request_start'); assert.equal(requestStart.data.request_id, request.id);
    assert.equal(requestStart.data.capture_only, false); assert.deepEqual(requestStart.data.model, selected);
    assert.equal(payload.model, selected.id);
    const matches = [];
    for (const [provider, definition] of Object.entries(candidate.projection.model_configuration.definition.providers))
      for (const item of definition.models ?? []) if (item.id === selected.id && (item.api ?? definition.api) === selected.api &&
        (item.baseUrl ?? definition.baseUrl) === selected.baseUrl) matches.push(provider);
    assert.deepEqual(matches, [model.provider], 'Provider configuration must bind one unique selected route');
    assert.equal(attemptStart.type, 'http_attempt_start');
    assert.equal(attemptStart.data.request_id, request.id); assert.equal(attemptStart.data.attempt_id, attemptId);
    assert.equal(attemptStart.data.method, 'POST');
    const base = new URL(selected.baseUrl), actual = new URL(attemptStart.data.url_path, attemptStart.data.url_origin);
    assert.equal(actual.origin, base.origin);
    const prefix = base.pathname.replace(/\/$/, '');
    assert.ok(actual.pathname === prefix || actual.pathname.startsWith(prefix + '/'));
    assert.equal(transportStart.phase, 'request_start'); assert.equal(transportStart.category, 'model');
    assert.equal(transportStart.method, 'POST');
    // A verified public manifest identifies transformed bytes. Original origin
    // and path hashes remain historical claims, not hashes of sanitized URLs.
    if (publicProjection) {
      assert.match(transportStart.originSha256, /^[a-f0-9]{64}$/);
      assert.match(transportStart.pathSha256, /^[a-f0-9]{64}$/);
    } else {
      assert.equal(transportStart.originSha256, hash(actual.origin));
      assert.equal(transportStart.pathSha256, hash(actual.pathname + actual.search));
    }
    assert.equal(transportSent.phase, 'request_sent'); assert.equal(transportSent.id, transportStart.id);
    assert.match(transportSent.requestBodySha256, /^[a-f0-9]{64}$/);
    assert.equal(transportSent.requestBodySha256, request.payload_sha256);
    assert.equal(transportEnd.phase, 'request_end'); assert.equal(transportEnd.id, transportStart.id);
    assert.ok(refs.length > 0);
    return { status: 'known', value: model.provider, precision: 'derived',
      observed_provider: event.data.provider, formula: 'unique-observed-provider-configuration-key/v1',
      verification_scope: publicProjection ? 'public-projection-original-transport-hash-claims-retained' : 'private-original-transport-hashes-recomputed', refs };
  } catch { return null; }
}
