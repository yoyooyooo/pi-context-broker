import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import test from 'node:test';
import { classifyDailyHttp, classifyDailyNotionRequest, validateDailyDoctor, validateDailyFind, verifyDailyCliShim, verifyDailyPackageSource } from './verify-pi-daily-installation.mjs';

async function installationFixture() {
  const root = await mkdtemp(join(tmpdir(), 'daily-installation-identity-'));
  const agent = join(root, '.pi/agent'), broker = join(root, '.local/share/broker');
  const cliRoot = join(root, 'cli'), bin = join(root, '.volta/bin');
  await Promise.all([agent, broker, join(cliRoot, 'dist'), bin].map(path => mkdir(path, { recursive: true })));
  const entry = join(cliRoot, 'dist/ntn-skills.js'), content = '#!/usr/bin/env node\nthrow new Error("The CLI must not execute in identity tests");\n';
  await writeFile(entry, content, { mode: 0o755 });
  const resolution = join(root, 'volta-resolution.txt');
  const selected = join(root, 'image/bin/ntn-skills');
  await mkdir(join(root, 'image/bin'), { recursive: true });
  await symlink(entry, selected);
  await writeFile(resolution, selected + '\n');
  await writeFile(join(bin, 'volta'), `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv.slice(2).join(' ') !== 'which ntn-skills' || process.env.DAILY_LOOKUP_SENTINEL !== 'preserved') process.exit(7);\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(resolution)}, 'utf8'));\n`, { mode: 0o755 });
  await writeFile(join(bin, 'volta-shim'), 'fixture Volta dispatcher: never executed\n', { mode: 0o755 });
  const shim = join(bin, 'ntn-skills');
  await symlink('volta-shim', shim);
  return {
    root, agent, broker, cliRoot, bin, entry, selected, resolution, shim,
    env: { PATH: bin, DAILY_LOOKUP_SENTINEL: 'preserved' },
    config: {
      cliRoot, cliShim: shim, cliEntrySha256: createHash('sha256').update(content).digest('hex'),
      voltaIdentity: {
        executable_sha256: createHash('sha256').update(await readFile(join(bin, 'volta'))).digest('hex'),
        dispatcher_sha256: createHash('sha256').update(await readFile(join(bin, 'volta-shim'))).digest('hex'),
      },
    },
  };
}

test('daily relative package source resolves from the settings agent directory, independently of cwd', async () => {
  const f = await installationFixture();
  const spec = relative(f.agent, f.broker);
  assert.notEqual(process.cwd(), f.agent);
  assert.deepEqual(await verifyDailyPackageSource(spec, join(f.agent, 'settings.json'), f.broker), {
    selected_package: spec, resolved_package: await realpath(f.broker),
  });
});

test('daily Volta shim uses official which resolution and binds the exact frozen CLI bytes', async () => {
  const f = await installationFixture();
  const identity = await verifyDailyCliShim(f.config, f.env);
  assert.equal(identity.resolution.kind, 'volta');
  assert.deepEqual(identity.resolution.argv, [join(f.bin, 'volta'), 'which', 'ntn-skills']);
  assert.equal(identity.resolution.entry.realpath, await realpath(f.entry));
  assert.equal(identity.resolution.entry.sha256, f.config.cliEntrySha256);
  assert.equal(identity.executed_by_harness, false);
});

test('daily package identity accepts an absolute source and rejects a different slot or agent-relative target', async () => {
  const f = await installationFixture();
  assert.equal((await verifyDailyPackageSource(f.broker, join(f.agent, 'settings.json'), f.broker)).resolved_package, await realpath(f.broker));
  await assert.rejects(verifyDailyPackageSource(f.cliRoot, join(f.agent, 'settings.json'), f.broker), /final Broker/);
  await assert.rejects(verifyDailyPackageSource(relative(f.agent, f.broker), join(f.root, 'another-agent/settings.json'), f.broker));
});

test('daily direct CLI selection resolves exactly to the frozen entry and hash', async () => {
  const f = await installationFixture(), bin = join(f.root, 'direct-bin');
  await mkdir(bin);
  const shim = join(bin, 'ntn-skills');
  await symlink(f.entry, shim);
  const config = { ...f.config, cliShim: shim }, env = { PATH: bin };
  assert.equal((await verifyDailyCliShim(config, env)).resolution.kind, 'direct');
  await assert.rejects(verifyDailyCliShim({ ...config, cliEntrySha256: '0'.repeat(64) }, env));
});

test('daily CLI identity rejects a wrapper containing the final bundle path and a shadowed PATH selection', async () => {
  const f = await installationFixture(), bin = join(f.root, 'shadow-bin');
  await mkdir(bin);
  const wrapper = join(bin, 'ntn-skills');
  await writeFile(wrapper, `#!/bin/sh\n# ${f.entry}\nexit 0\n`, { mode: 0o755 });
  const env = { ...f.env, PATH: bin + delimiter + f.bin };
  await assert.rejects(verifyDailyCliShim({ ...f.config, cliShim: wrapper }, env), /actual Volta dispatcher/);
  await assert.rejects(verifyDailyCliShim(f.config, env), /normal PATH selection/);
});

test('daily Volta resolution rejects a different entry even with identical bytes and rejects ambiguous output', async () => {
  const f = await installationFixture(), other = join(f.cliRoot, 'dist/other.js');
  await writeFile(other, await readFile(f.entry), { mode: 0o755 });
  await writeFile(f.resolution, other + '\n');
  await assert.rejects(verifyDailyCliShim(f.config, f.env), /different installed CLI/);
  await writeFile(f.resolution, f.selected + '\n' + f.entry + '\n');
  await assert.rejects(verifyDailyCliShim(f.config, f.env), /one absolute CLI entry/);
});

test('daily identity reread detects changed frozen entry bytes and a changed Volta mapping', async () => {
  const f = await installationFixture();
  const initial = await verifyDailyCliShim(f.config, f.env);
  assert.deepEqual(await verifyDailyCliShim(f.config, f.env), initial);
  await writeFile(f.entry, (await readFile(f.entry, 'utf8')) + '// changed\n');
  await assert.rejects(verifyDailyCliShim(f.config, f.env));
  await writeFile(f.resolution, f.broker + '\n');
  const changedHash = createHash('sha256').update(await readFile(f.entry)).digest('hex');
  await assert.rejects(verifyDailyCliShim({ ...f.config, cliEntrySha256: changedHash }, f.env));
});

test('daily Volta identity requires reviewed executable and dispatcher bytes, not their path names', async () => {
  const f = await installationFixture();
  await assert.rejects(verifyDailyCliShim({ ...f.config, voltaIdentity: undefined }, f.env), /actual Volta executable SHA/);
  await assert.rejects(verifyDailyCliShim({ ...f.config, voltaIdentity: { ...f.config.voltaIdentity, dispatcher_sha256: '0'.repeat(64) } }, f.env), /actual Volta dispatcher SHA/);
  await writeFile(join(f.bin, 'volta'), (await readFile(join(f.bin, 'volta'), 'utf8')) + '// changed\n');
  await assert.rejects(verifyDailyCliShim(f.config, f.env), /actual Volta executable SHA/);
});

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
