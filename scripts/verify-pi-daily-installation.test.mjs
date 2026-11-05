import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDailyHttp, classifyDailyNotionRequest, validateDailyDoctor, validateDailyFind } from './verify-pi-daily-installation.mjs';

const selected = { selection: 'required-router@notion', kind: 'router', source: 'notion', page: 'current-page' };
const finding = 'context-broker find: required-router -> 1/1\n$required-router@notion\n  kind: router\n  source: notion\n  page: current-page';
const failure = '  fail router "external-router" member "notion_page:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" unavailable (CATALOG_MEMBER_UNAVAILABLE): declared locator absent from current credential-scoped catalog';
const report = ['Context Broker Doctor', 'Config diagnostics: ok', 'Namespace: failed', failure].join('\n');
const review = {
  kind: 'reviewed-external-catalog-diagnostics', status: 'outside-delivery-scope',
  sourceDatabaseId: 'current-database', declaredDatabaseIds: ['other-database'],
  routerNames: ['external-router'], namespaceDiagnostics: [failure],
  catalog: { path: '/reviewed/catalog.yaml', sha256: 'reviewed-by-run' }, reason: 'A separate database remains outside this delivery.',
};
const doctor = (text = report, accepted = review) => validateDailyDoctor([text], accepted, ['current-database'], selected.selection);

test('daily selection requires the exact qualified source, kind and page', () => {
  assert.deepEqual(validateDailyFind([finding], selected), selected);
  assert.throws(() => validateDailyFind([finding.replace('current-page', 'other-page')], selected));
  assert.throws(() => validateDailyFind([finding.replace('source: notion', 'source: local')], selected));
  assert.throws(() => validateDailyFind([finding, finding], selected));
});

test('a clean doctor needs no exception; conflicting namespace reports fail', () => {
  const clean = 'Context Broker Doctor\nConfig diagnostics: ok\nNamespace: ok no discovery namespace collisions';
  assert.equal(doctor(clean, undefined).status, 'ok');
  assert.throws(() => doctor(clean + '\nNamespace: failed', undefined));
});

test('reviewed external diagnostics remain visible as failed namespace observations', () => {
  const result = doctor();
  assert.equal(result.status, 'retained-external-catalog-diagnostics');
  assert.deepEqual(result.failures, [failure]);
  assert.throws(() => doctor(report, null));
});

test('new, changed, or duplicate namespace failures cannot use the review', () => {
  assert.throws(() => doctor(report + '\n' + failure));
  assert.throws(() => doctor(report.replace('external-router', 'new-router')));
  assert.throws(() => doctor(report.replace('aaaaaaaa', 'bbbbbbbb')));
});

test('configuration failures remain fatal even with an exact namespace review', () => {
  assert.throws(() => doctor(report.replace('Config diagnostics: ok', 'Config diagnostics: failed')));
});

test('the current database and required route cannot be excluded', () => {
  assert.throws(() => doctor(report, { ...review, declaredDatabaseIds: ['current-database'] }));
  const targetFailure = failure.replace('external-router', 'required-router');
  assert.throws(() => doctor(report.replace(failure, targetFailure), { ...review, routerNames: ['required-router'], namespaceDiagnostics: [targetFailure] }));
});

test('HTTP follows actual process ancestry, including source descendants', () => {
  const observed = [
    { event: 'spawn', pid: 10, child_pid: 20 },
    { event: 'spawn', pid: 10, child_pid: 30 },
    { event: 'process_start', pid: 21, ppid: 20 },
    { event: 'process_start', pid: 31, ppid: 30 },
    { event: 'http_start', pid: 20, id: 'source' },
    { event: 'http_start', pid: 21, id: 'source-child' },
    { event: 'http_start', pid: 31, id: 'other-plugin' },
  ];
  const result = classifyDailyHttp(observed, new Set([20]), new Set([10]));
  assert.deepEqual(result.source.map(row => row.id), ['source', 'source-child']);
  assert.deepEqual(result.otherPlugins.map(row => row.id), ['other-plugin']);
});

test('host, unknown, or cyclic ancestry cannot conceal HTTP as other-plugin traffic', () => {
  for (const rows of [
    [{ event: 'http_start', pid: 10 }],
    [{ event: 'http_start', pid: 99 }],
    [{ event: 'process_start', pid: 40, ppid: 41 }, { event: 'process_start', pid: 41, ppid: 40 }, { event: 'http_start', pid: 40 }],
  ]) assert.throws(() => classifyDailyHttp(rows, new Set([20]), new Set([10])));
});

const sdkRequestId = '12345678-1234-4234-8234-123456789abc';
function sdkObservation(overrides = {}) {
  return { complete: true, errors: [], events: [
    { phase: 'source_observer_start', pid: 10 },
    { phase: 'started', kind: 'sdk', pid: 10, operation: 'list', requestId: 'sdk:10:one' },
    { phase: 'attempt', kind: 'http', requestId: 'sdk:10:one', attempt: 1,
      request_id: sdkRequestId, request_kind: 'notion_metadata', method: 'POST', http_status: 200, outcome: 'success', request_bytes: 2, response_bytes: 100 },
    { phase: 'metrics', kind: 'metrics', requestId: 'sdk:10:one', observed: true, complete: true, total_requests: 1 },
    { phase: 'completed', kind: 'sdk', pid: 10, operation: 'list', requestId: 'sdk:10:one', status: 'completed', sdkStarted: true },
    { phase: 'source_observer_end', complete: true },
  ], ...overrides };
}
const sdkHttp = [
  { event: 'http_start', pid: 10, id: '10:1', method: 'POST', origin: 'https://api.notion.com', path: '/v1/views/view/queries', request_bytes: 2 },
  { event: 'http_end', pid: 10, id: '10:1', status: 200, response_request_id: sdkRequestId },
];

for (const operation of ['list', 'files']) test(operation + ' host SDK HTTP needs an exact complete operation and independent response request ID', () => {
  const observation = sdkObservation();
  observation.events = observation.events.map(event => event.operation ? { ...event, operation } : event);
  const result = classifyDailyHttp(sdkHttp, new Set(), new Set([10]), { sourceObservation: observation });
  assert.equal(result.sdk.length, 1);
  assert.equal(result.source.length, 1);
  assert.equal(result.sdk[0].attribution.operation, operation);
  assert.equal(result.sdk[0].attribution.requestId, 'sdk:10:one');
  assert.equal(result.sdk[0].attribution.response_bytes, 100);
});

test('SDK HTTP rejects absent, ambiguous, failed or mismatched receipt evidence', () => {
  for (const changed of [
    sdkObservation({ complete: false }),
    sdkObservation({ errors: ['missing-end-boundary'] }),
    sdkObservation({ events: sdkObservation().events.filter(event => event.phase !== 'completed') }),
    sdkObservation({ events: sdkObservation().events.map(event => event.phase === 'attempt' ? { ...event, request_id: null } : event) }),
    sdkObservation({ events: sdkObservation().events.map(event => event.phase === 'attempt' ? { ...event, method: 'GET' } : event) }),
    sdkObservation({ events: sdkObservation().events.map(event => event.phase === 'attempt' ? { ...event, http_status: 403 } : event) }),
    sdkObservation({ events: sdkObservation().events.map(event => event.phase === 'started' ? { ...event, pid: 99 } : event) }),
    sdkObservation({ events: sdkObservation().events.map(event => event.operation ? { ...event, operation: 'future-operation' } : event) }),
    sdkObservation({ events: [...sdkObservation().events, { ...sdkObservation().events[2], requestId: 'sdk:10:two' }] }),
  ]) assert.throws(() => classifyDailyHttp(sdkHttp, new Set(), new Set([10]), { sourceObservation: changed }));
  assert.throws(() => classifyDailyHttp([...sdkHttp, { ...sdkHttp[0], id: '10:2' }, { ...sdkHttp[1], id: '10:2' }],
    new Set(), new Set([10]), { sourceObservation: sdkObservation() }));
});

test('metadata and an explicit doctor body probe are accounted separately', () => {
  const request = { origin: 'https://api.notion.com', pid: 20, method: 'GET', path: '/v1/pages/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/markdown' };
  assert.equal(classifyDailyNotionRequest(request, 20), 'doctor-body');
  assert.equal(classifyDailyNotionRequest({ ...request, pid: 30, method: 'POST', path: '/v1/views/view-id/queries' }, 20), 'metadata');
});

test('body reads outside the doctor and writes from any source process remain forbidden', () => {
  const request = { origin: 'https://api.notion.com', pid: 20, method: 'GET', path: '/v1/pages/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/markdown' };
  assert.throws(() => classifyDailyNotionRequest({ ...request, pid: 30 }, 20));
  assert.throws(() => classifyDailyNotionRequest({ ...request, method: 'PATCH' }, 20));
  assert.throws(() => classifyDailyNotionRequest({ ...request, method: 'DELETE', path: '/v1/pages/page-id' }, 20));
  assert.throws(() => classifyDailyNotionRequest({ ...request, origin: 'https://example.com' }, 20));
});
