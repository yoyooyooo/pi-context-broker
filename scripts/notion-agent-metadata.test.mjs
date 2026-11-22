import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { verifyNotionAgentMetadataLookup } from './notion-agent-analysis.mjs';

// Verifier fixtures exercise rejection paths; they are not real-model evidence.
function fixture() {
  const files = new Map(), hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const artifact = (path, value) => {
    const bytes = Buffer.from(JSON.stringify(value)); files.set(path, bytes);
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  };
  const stamp = ms => new Date(Date.UTC(2026, 10, 22) + ms).toISOString();
  const item = { kind: 'notion', name: 'shipment-review-fixture', owner: 'owner', pageId: 'target-page', scope: 'a'.repeat(64) };
  const records = [{ ref: 'sr:target', name: item.name, source: 'notion', availability: 'available', in_default_view: false }];
  const value = { ok: true, state: 'known', count: 1, total_count: 1, has_more: false, next_cursor: null,
    freshness: { sources: [{ source: 'notion', policy: 'refresh', validated_at: stamp(24000), age_ms: 2000, max_age_ms: 60000, stale: false }] },
    coverage: { exhaustive: true, sources: [{ source: 'notion', exhaustive: true }] }, records, failures: [] };
  const priorSelection = { scopes: [{ scope: 'unrelated', bindings: [{ owner: 'fixed', version: 'A' }] }], active: [] };
  const previous = { analysis: { turnId: 'disabled', assertions: [{ kind: 'metadata-lookup', status: 'passed', details: {
    object: 'target', state: 'absent', source: 'notion', query: item.name, sessionId: 'session', pid: 42,
    resultMonotonicNs: '2000000000', freshness: { ...value.freshness.sources[0], validated_at: stamp(1000), age_ms: 1000 },
  } }] }, observed: { session: { branchEntries: [{ id: 'first-user' }, { id: 'first-final' }] }, selection: priorSelection } };
  const eventResult = { actor: 'fixture-controller', status: 'passed', completed: { at: stamp(21000), monotonicNs: '21000000000' },
    result: { row: { id: 'target-page', properties: { Enabled: { type: 'checkbox', checkbox: true } } } } };
  const event = { afterTurn: 'disabled', event: { kind: 'set-enabled', object: 'target', enabled: true },
    finishedNs: '21000000000', result: eventResult };
  const native = { id: 'result', message: { role: 'toolResult', toolCallId: 'call', isError: false } };
  const call = { id: 'call', name: 'notion_list', arguments: { query: item.name, refresh: true }, deliveryToolCallId: 'call',
    native: { resultEntryId: native.id }, event: { pid: 42, monotonicNs: '22000000000' }, result: { isError: false, monotonicNs: '26000000000' } };
  const payload = { messages: [] };
  const observed = { visibility: { source: { sourceId: 'notion' } },
    session: { sessionId: 'session', branchEntries: [...previous.observed.session.branchEntries, native] },
    selection: structuredClone(priorSelection), tasks: [], metadataContinuation: {} };
  const delivery = { requests: [{ metadataText: '', selection: { shortRefs: [{ ref: 'sr:target',
    target: { kind: 'candidate', identity: { source: 'notion', id: item.owner, scope: item.scope } } }] } }] };
  const source = [
    { phase: 'started', kind: 'sdk', operation: 'list', source_id: 'notion', requestId: 'list', monotonicNs: '23000000000' },
    { phase: 'attempt', requestId: 'list', request_kind: 'notion_metadata', outcome: 'success' },
    { phase: 'completed', requestId: 'list', status: 'completed' },
  ];
  let deliver = true;
  const seal = () => {
    const content = [{ type: 'text', text: JSON.stringify(value) }]; native.message.content = content;
    call.result.contentArtifact = artifact('/owned/result.json', content);
    payload.messages = deliver ? [{ role: 'tool', tool_call_id: call.deliveryToolCallId, content: content[0].text }] : [];
    const wire = artifact('/owned/payload.json', payload); Object.assign(delivery.requests[0], wire);
    observed.tasks = [{ phase: 'provider_payload', sha256: wire.sha256, bytes: wire.bytes, payloadFile: wire.path }];
    const { artifact: _artifact, ...rawEvent } = eventResult;
    eventResult.artifact = artifact('/owned/fixture-event.json', rawEvent);
    observed.metadataContinuation.previous = artifact('/owned/prior-analysis.json', previous);
    observed.metadataContinuation.events = [artifact('/owned/event.json', event)];
  };
  const expected = { kind: 'metadata-lookup', object: 'target', state: 'present', outsideDefaultView: true, afterTurn: 'disabled' };
  const run = async () => { seal(); return verifyNotionAgentMetadataLookup(expected, observed, { private: { objects: { target: item } } }, {
    attempts: [call], delivery, source, readArtifact: async path => { assert.ok(files.has(path)); return files.get(path); },
  }); };
  return { observed, value, source, expected, previous, call, event, eventResult, delivery, run, skipDelivery: () => { deliver = false; } };
}

test('named metadata discovery requires a real refreshed hit in the same warm session', async () => {
  const f = fixture(), proof = await f.run();
  assert.equal(proof.state, 'present'); assert.equal(proof.continuation.elapsedMs, 20000);
  assert.equal(proof.continuation.pinsUnchanged, true); assert.deepEqual(proof.continuation.requests, ['list']);
});

test('metadata absence is a complete available-directory miss, with no body or page-existence claim', async () => {
  const f = fixture(); delete f.expected.afterTurn; f.expected.state = 'absent';
  Object.assign(f.value, { count: 0, total_count: 0, records: [] });
  assert.equal((await f.run()).state, 'absent');
});

test('metadata verifier rejects cached misses, partial results, wrong identities and unproved refresh', async t => {
  const cases = [
    ['no named query', f => { f.call.arguments.query = 'another'; }, 'NAMED_METADATA_LOOKUP_MISSING'],
    ['refresh omitted', f => { delete f.call.arguments.refresh; }, 'METADATA_REFRESH_NOT_REQUESTED'],
    ['refresh false', f => { f.call.arguments.refresh = false; }, 'METADATA_REFRESH_NOT_REQUESTED'],
    ['cached miss', f => { f.value.records = []; }, 'METADATA_TARGET_MISSING'],
    ['partial coverage', f => { f.value.coverage.exhaustive = false; }, 'METADATA_COVERAGE_INCOMPLETE'],
    ['failed source', f => { f.value.failures = [{ source: 'notion' }]; }, 'METADATA_COVERAGE_INCOMPLETE'],
    ['stale metadata', f => { f.value.freshness.sources[0].stale = true; }, 'METADATA_RESULT_STALE'],
    ['unknown validation', f => { f.value.freshness.sources[0].validated_at = null; }, 'METADATA_FRESHNESS_UNKNOWN'],
    ['cache policy', f => { f.value.freshness.sources[0].policy = 'max_age'; }, 'METADATA_REFRESH_POLICY_MISMATCH'],
    ['offline policy', f => { f.value.freshness.sources[0].policy = 'offline'; }, 'METADATA_REFRESH_POLICY_MISMATCH'],
    ['wrong owner', f => { f.delivery.requests[0].selection.shortRefs[0].target.identity.id = 'other'; }, 'METADATA_WRONG_OWNER'],
    ['default View target', f => { f.value.records[0].in_default_view = true; }, 'METADATA_DEFAULT_VIEW_LEAK'],
    ['not delivered', f => f.skipDelivery(), 'METADATA_NOT_DELIVERED'],
    ['process restart', f => { f.call.event.pid = 43; }, 'METADATA_SESSION_REPLACED'],
    ['old TTL elapsed', f => { f.previous.analysis.assertions[0].details.freshness.age_ms = 50000; }, 'METADATA_TTL_PRECONDITION_MISSED'],
    ['missing enable', f => { f.event.event.enabled = false; }, 'METADATA_EXTERNAL_EVENT_UNPROVEN'],
    ['enable before first lookup', f => { f.event.finishedNs = '1000000000'; }, 'METADATA_EVENT_TIMING_MISSING'],
    ['enable at first result', f => { f.event.finishedNs = '2000000000'; }, 'METADATA_EVENT_TIMING_MISSING'],
    ['another page enabled', f => { f.eventResult.result.row.id = 'another-page'; }, 'METADATA_ENABLE_READBACK_MISMATCH'],
    ['enable did not land', f => { f.eventResult.result.row.properties.Enabled.checkbox = false; }, 'METADATA_ENABLE_READBACK_MISMATCH'],
    ['old validation reused', f => { f.value.freshness.sources[0].validated_at = new Date(Date.UTC(2026, 10, 22) + 1000).toISOString(); }, 'METADATA_NOT_REFRESHED'],
    ['refresh without HTTP', f => { f.source.splice(1, 1); }, 'METADATA_REFRESH_HTTP_MISSING'],
    ['failed refresh HTTP', f => { f.source[1].outcome = 'failure'; }, 'METADATA_REFRESH_HTTP_MISSING'],
    ['selection changed', f => { f.observed.selection.scopes[0].bindings[0].version = 'B'; }, 'METADATA_CHANGED_SELECTION'],
  ];
  for (const [name, change, code] of cases) await t.test(name, async () => {
    const f = fixture(); change(f); await assert.rejects(f.run(), error => error.code === code);
  });
});


test('the first complete miss also requires a fresh online observation', async () => {
  const f = fixture(); delete f.expected.afterTurn; f.expected.state = 'absent';
  Object.assign(f.value, { count: 0, total_count: 0, records: [] });
  f.value.freshness.sources[0].policy = 'offline';
  await assert.rejects(f.run(), error => error.code === 'METADATA_REFRESH_POLICY_MISMATCH');
});
