import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertSupportedPiVersion, isolatedEnv, resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { renderHttpWrapper, startLoopbackMock } from './mock-provider-adapter.mjs';
import { verifyBundledRuntime } from './verify-package-closure.mjs';

export const scenarios = Object.freeze(['default-view', 'http-cache-recovery', 'http-warm-restart', 'http-warm-directory-expired', 'http-smart-revalidate', 'http-smart-current', 'http-interruption', 'working-set']);
const isWarmRestart = name => ['http-warm-restart', 'http-warm-directory-expired', 'http-smart-revalidate'].includes(name);
export const usage = `Current SDK v3, actual Pi, controlled Notion and provider HTTP.
node scripts/notion-sdk-pi.mjs doctor|run --package ABS --fixture ABS --source-http-helper ABS [--pi ABS] [--scenario all|${scenarios.join('|')}]
run additionally requires --out NEW_ABS. --pi selects one explicit installed entry; there is no fallback.
node scripts/notion-sdk-pi.mjs evidence --evidence ABS
Evidence is retained. Legacy scenarios, snapshot fixtures and cleanup are unsupported.
This entry does not certify a natural model, live Notion or the ordinary daily Pi command.`;
const hash = value => createHash('sha256').update(value).digest('hex');
const save = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const rows = async path => (await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).split('\n').filter(Boolean).map(JSON.parse);

export function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { action: 'help' };
  const [action, ...values] = args;
  assert.ok(['doctor', 'run', 'evidence'].includes(action), usage);
  const allowed = action === 'evidence' ? ['--evidence'] : ['--package', '--fixture', '--source-http-helper', '--pi', '--scenario', ...(action === 'run' ? ['--out'] : [])];
  const options = { action, scenario: 'all' };
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i], value = values[i + 1];
    assert.ok(allowed.includes(key) && typeof value === 'string' && !value.startsWith('--') && !Object.hasOwn(options, key), usage);
    assert.ok(key === '--scenario' ? ['all', ...scenarios].includes(value) : isAbsolute(value), usage);
    options[key] = key === '--scenario' ? value : resolve(value);
  }
  const required = action === 'evidence' ? ['--evidence'] : ['--package', '--fixture', '--source-http-helper', ...(action === 'run' ? ['--out'] : [])];
  for (const key of required) assert.ok(options[key], `${key} is required\n${usage}`);
  return options;
}

export function validateCurrentFixture(value) {
  assert.equal(value?.version, 2, 'Only current service fixture version 2 is accepted');
  assert.equal(value.kind, 'current-notion-service');
  for (const key of ['snapshots', 'scope', 'cwd']) assert.equal(Object.hasOwn(value, key), false, 'Consumer snapshot/cache fixtures are retired');
  assert.ok(value.notion?.library?.sources && value.notion?.main?.id === value.root_page_id);
  for (const key of ['skills', 'files', 'records', 'sources']) assert.ok(Array.isArray(value.notion[key]));
  assert.ok(value.expected.file_count > 100 && value.expected.files.some(file => file.path === 'SKILL.md'));
  assert.ok(isAbsolute(value.env));
  return value;
}

const property = (row, id) => Object.values(row.properties).find(value => value.id === id);
const rich = (id, text) => ({ id, type: 'rich_text', has_more: false, rich_text: [{ type: 'text', plain_text: text, text: { content: text } }] });
const id = n => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
export function currentServiceFacts(original) {
  const sample = structuredClone(validateCurrentFixture(original));
  const main = sample.notion.skills.find(row => row.id === sample.root_page_id);
  assert.ok(main);
  const owners = { a: main.id, b: id(700001), c: id(700002) };
  assert.ok(!sample.notion.skills.some(row => row.id === owners.b || row.id === owners.c));
  for (const key of ['b', 'c']) {
    const row = structuredClone(main); row.id = owners[key];
    property(row, 'title').title = [{ type: 'text', plain_text: `Current acceptance ${key.toUpperCase()}`, text: { content: `Current acceptance ${key.toUpperCase()}` } }];
    row.properties['Skill ID'] = rich('skill-id', `acceptance-${key}`);
    row.properties['Main File ID'] = rich('main-id', `main-acceptance-${key}`);
    row.properties.Content = rich('content', JSON.stringify({ kind: 'native', mode: '100644', frontmatter: `---\nname: acceptance-${key}\ndescription: Current acceptance ${key}.\n---\n\n` }));
    property(row, 'default').checkbox = false;
    property(row, 'members').relation = []; property(row, 'requires').relation = [];
    sample.notion.skills.push(row);
    sample.notion.bodies[row.id] = `# Current acceptance ${key.toUpperCase()}\n\n${key.toUpperCase()} original version 1.\n`;
  }
  for (const key of ['a', 'c']) property(sample.notion.skills.find(row => row.id === owners[key]), 'requires').relation = [{ id: owners.b }];
  property(main, 'default').checkbox = true;
  sample.notion.main = main;
  sample.expected.catalog_count = sample.notion.skills.length;
  const view = { id: id(700010), name: 'Current acceptance default', type: 'table', data_source_id: sample.notion.library.skills.data_source_id,
    parent: { type: 'database_id', database_id: sample.database }, url: 'https://www.notion.so/?v=' + id(700010) };
  sample.view_dynamics = { view, tags_property_id: 'tags', observations: [
    { id: 'initial', query_id: id(700011), tags: [], filter: { property: 'default', checkbox: { equals: true } }, member_page_ids: [owners.a] },
    { id: 'off', query_id: id(700012), tags: [], filter: { property: 'default', checkbox: { equals: true } }, member_page_ids: [] },
  ] };
  return { sample, owners };
}

export function selectProviderCall(context, plan = JSON.parse(readFileSync(process.env.SC10_PI_TOOL_PLAN, 'utf8'))) {
  if (plan.mode === 'complete') return null;
  const call = plan.mode === 'search' ? { type: 'toolCall', id: 'current-search', name: 'notion_list', arguments: { query: '' } } : plan.mode === 'call' ? plan.call : undefined;
  assert.ok(call && call.type === 'toolCall' && typeof call.id === 'string' && ['notion_list', 'notion_use', 'notion_ctl', 'read'].includes(call.name), 'Unsupported current tool plan');
  return context.messages.some(message => message.role === 'toolResult' && message.toolCallId === call.id) ? null : call;
}

async function runCommand(file, args, { cwd, env, timeoutMs = 30000 } = {}) {
  const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes));
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    const exit = await new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); });
    const result = { file, args, cwd, ...exit, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
    assert.equal(exit.code, 0, JSON.stringify(result)); return result;
  } finally { clearTimeout(timer); }
}

export async function resolveInstalledPiSerializer(piPackageRoot, piVersion) {
  const base = await realpath(piPackageRoot), specifier = '@earendil-works/pi-ai/api/openai-completions';
  const resolved = await runCommand(process.execPath, ['--input-type=module', '--eval', `process.stdout.write(JSON.stringify(import.meta.resolve(${JSON.stringify(specifier)})))`], { cwd: base, env: { PATH: process.env.PATH ?? '' } });
  const moduleUrl = new URL(JSON.parse(resolved.stdout)); assert.equal(moduleUrl.protocol, 'file:');
  const modulePath = await realpath(fileURLToPath(moduleUrl));
  let current = dirname(modulePath), packagePath, packageBytes, packageInfo;
  for (;;) {
    packagePath = join(current, 'package.json');
    try { packageBytes = await readFile(packagePath); packageInfo = JSON.parse(packageBytes.toString()); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.notEqual(current, dirname(current)); current = dirname(current);
  }
  assert.equal(packageInfo.name, '@earendil-works/pi-ai'); assert.equal(packageInfo.version, piVersion);
  return { resolution: { method: 'node-esm-import-exports', specifier, base, node: process.execPath },
    api_package: { name: packageInfo.name, version: packageInfo.version, path: packagePath, sha256: hash(packageBytes) },
    serializer: { path: modulePath, sha256: hash(await readFile(modulePath)) } };
}

async function inspect(options) {
  const packageRoot = await realpath(options['--package']);
  assert.ok(!packageRoot.startsWith(resolve(dirname(fileURLToPath(import.meta.url)), '..') + '/'), 'Use an independent installed Broker package');
  const runtime = JSON.parse(await readFile(join(packageRoot, 'dist/ntn-skills-runtime.json'), 'utf8'));
  const runtimeHashes = verifyBundledRuntime({ manifest: runtime, expectedVersion: runtime.package_version,
    cliBytes: await readFile(join(packageRoot, 'dist/ntn-skills.mjs')), sdkBytes: await readFile(join(packageRoot, 'dist/ntn-skills-sdk.mjs')),
    refBytes: await readFile(join(packageRoot, 'dist/ntn-skills-ref.cjs')) });
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  assert.ok((major === 24 && (minor > 22 || minor === 22 && patch >= 3)) ||
    (major === 26 && (minor > 13 || minor === 13 && patch >= 1)), 'Use Node ^24.22.3 or ^26.13.1');
  const fixture = validateCurrentFixture(JSON.parse(await readFile(options['--fixture'], 'utf8')));
  const fixtureEnv = JSON.parse(await readFile(fixture.env, 'utf8'));
  assert.equal(fixtureEnv.NOTION_API_TOKEN, 'current-sdk-controlled-token', 'Only the declared controlled source token is accepted');
  const host = options['--pi'] ?? 'pi', command = await resolveHost(host);
  let piRoot = dirname(command.identity), metadata;
  for (;;) {
    try { metadata = JSON.parse(await readFile(join(piRoot, 'package.json'), 'utf8')); if (metadata.name === '@earendil-works/pi-coding-agent') break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.notEqual(piRoot, dirname(piRoot), 'Cannot identify the actual Pi package from this entry; use --pi ABS public CLI entry'); piRoot = dirname(piRoot);
  }
  assertSupportedPiVersion(metadata.version);
  const serializer = await resolveInstalledPiSerializer(piRoot, metadata.version);
  const helper = await realpath(options['--source-http-helper']);
  const files = [];
  async function visit(relative) {
    for (const entry of await readdir(join(packageRoot, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name); assert.equal(entry.isSymbolicLink(), false, 'Installed runtime may not route through a symlink');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) { const bytes = await readFile(join(packageRoot, path)); files.push({ path, bytes: bytes.length, sha256: hash(bytes) }); }
    }
  }
  await visit('src'); await visit('dist');
  return { packageRoot, fixture, fixtureEnv, helper, host, identity: { schema: 2, evidence_level: 'controlled-Pi', source: 'current-v2-controlled-http',
    provider: 'actual-installed-pi-http-serializer/loopback-controlled', ordinary_daily: false, natural_model: false, live_notion: false,
    runtime: { executable: process.execPath, node: process.versions.node }, pi: { ...command, package_root: piRoot, version: metadata.version },
    broker: { path: packageRoot, runtime, hashes: runtimeHashes, files: files.sort((a, b) => a.path.localeCompare(b.path)) }, serializer,
    fixture: { path: options['--fixture'], sha256: hash(await readFile(options['--fixture'])) },
    source_http_helper: { path: helper, sha256: hash(await readFile(helper)) }, driver_sha256: hash(await readFile(fileURLToPath(import.meta.url))) } };
}

function lifecycleObserver(api) {
  const record = (type, value = {}) => appendFileSync(process.env.CURRENT_NATIVE_EVENTS, JSON.stringify({ type, pid: process.pid, monotonic_ns: process.hrtime.bigint().toString(), ...value }) + '\n');
  for (const name of ['session_start', 'session_shutdown', 'session_compact']) api.on(name, (_event, ctx) => record(name, { leaf_id: ctx.sessionManager.getLeafId() }));
  api.on('session_before_compact', event => {
    const plan = JSON.parse(readFileSync(process.env.CURRENT_CONTROL, 'utf8'));
    if (plan.action !== 'compact') return;
    if (!event.branchEntries.some(entry => entry.id === plan.firstKeptEntryId)) throw new Error('Current compact boundary absent');
    record('controlled_compaction', { first_kept_entry_id: plan.firstKeptEntryId });
    return { compaction: { summary: 'Controlled summary. Continue the ordinary task using persisted fixed Skill bindings. Original source bodies are omitted.',
      firstKeptEntryId: plan.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
      details: { verification: 'Actual Pi lifecycle with controlled summary; model summary quality is not tested' } } };
  });
  api.registerCommand('current-fixture', { description: 'Inspect this owned current acceptance session.', handler: async (_args, ctx) => {
    await ctx.waitForIdle();
    const plan = JSON.parse(readFileSync(process.env.CURRENT_CONTROL, 'utf8'));
    if (plan.action !== 'snapshot') throw new Error('Invalid current fixture action');
    writeFileSync(plan.output, JSON.stringify({ branch: ctx.sessionManager.getBranch(), leaf_id: ctx.sessionManager.getLeafId(),
      session_file: ctx.sessionManager.getSessionFile(), projection: ctx.sessionManager.buildSessionProjection?.() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } });
}

function sourceText(notion, owner) {
  const row = notion.skills.find(value => value.id === owner);
  const content = JSON.parse(property(row, 'content').rich_text.map(value => value.plain_text).join(''));
  return content.frontmatter + notion.bodies[owner];
}
function replaceBody(service, owner, body, serial) {
  service.notion.bodies[owner] = body;
  for (const row of [service.notion.main, ...service.notion.skills].filter(row => row.id === owner)) row.last_edited_time = new Date(Date.UTC(2030, 0, serial)).toISOString();
}
function allStrings(value, result = []) {
  if (typeof value === 'string') { result.push(value); try { const parsed = JSON.parse(value); if (parsed !== value) allStrings(parsed, result); } catch {} }
  else if (value && typeof value === 'object') for (const item of Object.values(value)) allStrings(item, result);
  return result;
}
export function assertWireSources(body, present, absent = []) {
  const strings = allStrings(body.messages);
  for (const text of present) assert.ok(strings.some(value => value.includes(text)), 'Provider wire lacks complete original body ' + hash(text));
  for (const text of absent) assert.equal(strings.some(value => value.includes(text)), false, 'Provider wire contains retired/undeclared body ' + hash(text));
}

const nativeBodyMaxAgeMs = 24 * 60 * 60 * 1000;
const bodyTimes = state => state.native.flatMap(row => row.payload.files.map(file =>
  [row.key, file.file_id, file.page_id, file.body_sha256, file.body_verified_at]));
const withoutBodyTimes = state => {
  const value = structuredClone(state); delete value.captured_at_ms;
  for (const row of value.native) for (const file of row.payload.files) delete file.body_verified_at;
  for (const row of value.observations) delete row.payload.shared_body_valid_until;
  return value;
};
async function nativeBodyEvidence(stateRoot, library, owners) {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(stateRoot, 'state.sqlite'), { readOnly: true });
  try {
    assert.equal(database.prepare('PRAGMA application_id').get().application_id, 0x4e544e43);
    assert.equal(database.prepare('SELECT version FROM state_format').get().version, 1);
    const native = database.prepare("SELECT key,payload FROM shared_local_records WHERE retired=0 AND key LIKE 'cache/current-native-bodies/%/latest.json' ORDER BY key").all()
      .map(row => ({ key: row.key, payload: JSON.parse(row.payload) }))
      .filter(row => row.payload.library_id === library && owners.includes(row.payload.skill_page_id));
    assert.deepEqual(native.map(row => row.payload.skill_page_id).sort(), [...owners].sort());
    assert.equal(new Set(native.map(row => row.payload.scope)).size, 1);
    const scope = native[0].payload.scope;
    const manifests = database.prepare('SELECT id,manifest FROM snapshots WHERE scope=? ORDER BY id').all(scope)
      .filter(row => owners.includes(JSON.parse(row.manifest).record.locator.page_id));
    assert.equal(manifests.length, 2);
    const snapshots = manifests.map(row => ({ id: row.id, sha256: hash(row.manifest) }));
    const observations = database.prepare('SELECT id,payload FROM observations WHERE scope=? ORDER BY id').all(scope)
      .map(row => ({ id: row.id, payload: JSON.parse(row.payload) }))
      .filter(row => snapshots.some(snapshot => snapshot.id === row.payload.snapshot_id) && row.payload.shared_body_valid_until !== undefined);
    assert.ok(observations.length >= 2);
    const protectedSqlite = {};
    for (const { name } of database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      assert.match(name, /^[a-z_]+$/);
      const unchanged = database.prepare('SELECT * FROM "' + name + '"').all().filter(row =>
        name !== 'shared_local_records' || !native.some(selected => selected.key === row.key)).filter(row =>
        name !== 'observations' || !observations.some(selected => selected.id === row.id));
      protectedSqlite[name] = { rows: unchanged.length, sha256: hash(unchanged.map(row => JSON.stringify(row)).sort().join('\n')) };
    }
    const digests = new Set(native.flatMap(row => row.payload.files.map(file => {
      assert.match(file.body_sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(file.body_verified_at) && file.body_verified_at >= 0);
      return file.body_sha256;
    })));
    for (const row of manifests) {
      const manifest = JSON.parse(row.manifest);
      const entry = manifest.files.find(file => file.path === manifest.entrypoint); assert.ok(entry);
      digests.add(entry.sha256);
    }
    const objects = [];
    for (const digest of [...digests].sort()) {
      const bytes = await readFile(join(stateRoot, 'objects', digest)); assert.equal(hash(bytes), digest);
      objects.push({ sha256: digest, bytes: bytes.length });
    }
    return { captured_at_ms: Date.now(), state_path: join(stateRoot, 'state.sqlite'), scope, native, observations, snapshots, objects, protected_sqlite: protectedSqlite };
  } finally { database.close(); }
}
async function ageOwnedNativeBodyEvidence(stateRoot, library, owners) {
  const before = await nativeBodyEvidence(stateRoot, library, owners), agedAt = Date.now();
  const expiredAt = agedAt - nativeBodyMaxAgeMs - 1000;
  assert.ok(expiredAt > 0);
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(stateRoot, 'state.sqlite'));
  try {
    database.exec('BEGIN IMMEDIATE');
    for (const row of before.native) {
      const value = structuredClone(row.payload);
      for (const file of value.files) file.body_verified_at = expiredAt;
      assert.equal(database.prepare('UPDATE shared_local_records SET payload=? WHERE key=? AND retired=0').run(JSON.stringify(value), row.key).changes, 1);
    }
    for (const row of before.observations) {
      const value = { ...row.payload, shared_body_valid_until: expiredAt + nativeBodyMaxAgeMs };
      assert.equal(database.prepare('UPDATE observations SET payload=? WHERE id=?').run(JSON.stringify(value), row.id).changes, 1);
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  finally { database.close(); }
  const aged = await nativeBodyEvidence(stateRoot, library, owners);
  assert.deepEqual(withoutBodyTimes(aged), withoutBodyTimes(before), 'Fixture aging may change only the two body-proof time fields');
  return { mode: 'owned-cache-body-age', aged_at_ms: agedAt, expired_body_verified_at: expiredAt,
    full_body_max_age_ms: nativeBodyMaxAgeMs, before, aged };
}
function phaseCost(events, source, pid, phase, elapsedMs, originals, maxAgeMs) {
  const ends = events.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'end' && row.observer_pid === pid);
  assert.ok(ends.length > 0);
  const metrics = ends.map(row => { assert.ok(row.request_metrics, 'Every phase needs actual SDK metrics'); return row.request_metrics; });
  const sum = field => metrics.reduce((total, value) => {
    assert.ok(Number.isFinite(value[field]) && value[field] >= 0, 'Missing actual metric: ' + field);
    return total + value[field];
  }, 0);
  const requests = Object.fromEntries(['notion_metadata', 'notion_body', 'notion_write', 'provider'].map(kind => [kind,
    metrics.reduce((total, value) => { assert.ok(Number.isSafeInteger(value.requests?.[kind]) && value.requests[kind] >= 0); return total + value.requests[kind]; }, 0)]));
  const observed = source.filter(row => row.phase === phase);
  const total = sum('total_requests'); assert.equal(total, observed.length, 'All foreground and background HTTP must be attributed');
  assert.equal(Object.values(requests).reduce((a, b) => a + b, 0), total);
  for (const value of metrics) {
    assert.equal(value.trace_enabled, true); assert.equal(value.trace_dropped, 0);
    assert.equal(value.trace.filter(row => row.event === 'attempt').length, value.total_requests);
  }
  return { phase, pid, elapsed_ms: elapsedMs, max_age_ms: maxAgeMs, sample_count: 1,
    content: originals.map(text => ({ bytes: Buffer.byteLength(text), sha256: hash(text) })),
    total_requests: total, requests, markdown_requests: observed.filter(row => /\/markdown$/.test(row.path)).length,
    request_bytes: sum('request_bytes'), response_bytes: sum('response_bytes'),
    unknown_request_bytes: sum('unknown_request_bytes'), unknown_response_bytes: sum('unknown_response_bytes'),
    retry_wait_ms: sum('retry_wait_ms') };
}

async function runScenario(name, info, out) {
  const base = join(out, name); await mkdir(base, { mode: 0o700 });
  const { sample, owners } = currentServiceFacts(info.fixture);
  await save(join(base, 'source-facts.json'), sample);
  const { startSdkSourceFixture } = await import(pathToFileURL(info.helper).href);
  const service = await startSdkSourceFixture(sample, join(base, 'source-http.jsonl'));
  const wire = [], steps = [], wireAssertions = []; let plan = { mode: 'complete' }, sequence = 0, rpc, failure;
  const provider = await startLoopbackMock({ selectCall: context => selectProviderCall(context, plan), limits: { maxRequests: 100 },
    onBody: async (record, bytes) => { const file = `provider-${String(wire.length + 1).padStart(3, '0')}.json`; await writeFile(join(base, file), bytes, { mode: 0o600 }); wire.push({ file, sha256: hash(bytes), body: JSON.parse(bytes), record }); } });
  const agentDir = join(base, 'agent'), sessions = join(base, 'sessions');
  await mkdir(join(agentDir, 'context-broker'), { recursive: true }); await mkdir(sessions);
  const metadataRevalidation = name === 'http-smart-revalidate';
  const directoryExpired = name === 'http-warm-directory-expired' || metadataRevalidation;
  const maxAge = isWarmRestart(name) || name === 'http-smart-current' ? '5m' : '0';
  const source = { type: 'notion', id: 'current-sdk', namespace: 'current-sdk', library: sample.notion.library.library_id,
    discovery: { maxAge: name === 'http-smart-current' ? '0' : name === 'http-warm-directory-expired' ? '1s' : maxAge }, activation: { maxAge }, cacheDir: join(base, 'broker-cache'), prefetch: false };
  const config = join(agentDir, 'context-broker/config.yml'), control = join(base, 'control.json');
  await save(config, { sources: [source] }); await save(control, { action: 'none' });
  await save(join(agentDir, 'settings.json'), { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } });
  const providerExtension = join(base, 'provider.mjs'), observerExtension = join(base, 'lifecycle.mjs'), preload = join(base, 'observer.mjs');
  await writeFile(providerExtension, renderHttpWrapper({ helperUrl: new URL('./mock-provider-adapter.mjs', import.meta.url).href, serializerUrl: pathToFileURL(info.identity.serializer.serializer.path).href }));
  await writeFile(observerExtension, "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';\nexport default " + lifecycleObserver.toString() + '\n');
  await writeFile(preload, `import { channel } from 'node:diagnostics_channel';\nimport { appendFileSync } from 'node:fs';\nimport childProcess from 'node:child_process';\nimport { syncBuiltinESMExports } from 'node:module';\nconst activeSdk = new Set();\nconst emit = (kind, event) => appendFileSync(process.env.CURRENT_SDK_EVENTS, JSON.stringify({kind, observer_pid:process.pid, ...event})+'\\n');\nfor(const topic of ['context-broker.notion-sdk','context-broker.notion-sdk-result']) channel(topic).subscribe(event=>{if(topic==='context-broker.notion-sdk') {if(event.event==='start')activeSdk.add(event.id);else if(event.event==='end')activeSdk.delete(event.id);}emit(topic,event);});\nfor(const api of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) { const original=childProcess[api]; childProcess[api]=function(...args){emit('child_process',{api,command:String(args[0]).split('/').at(-1),active_sdk_ids:[...activeSdk]});return original.apply(this,args);}; }\nsyncBuiltinESMExports();\n`);
  const env = isolatedEnv({ base, agentDir, PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin',
    NOTION_API_TOKEN: info.fixtureEnv.NOTION_API_TOKEN, NOTION_API_BASE_URL: service.origin,
    NTN_SKILLS_NOTION_INTERVAL_MS: '100', NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000',
    CONTEXT_BROKER_HOST: 'pi', CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_LOG_FILE: join(base, 'decisions.jsonl'),
    CURRENT_SDK_EVENTS: join(base, 'sdk.jsonl'), CURRENT_NATIVE_EVENTS: join(base, 'native.jsonl'), CURRENT_CONTROL: control,
    BROKER_E2E_PROCESS_LEDGER: join(base, 'processes.jsonl'), NODE_OPTIONS: '--import=' + preload, CTX_MOCK_PROVIDER_BASE_URL: provider.baseUrl });
  await mkdir(env.NTN_SKILLS_CONFIG_HOME, { recursive: true });
  await save(join(env.NTN_SKILLS_CONFIG_HOME, 'config.json'), { default_library: sample.notion.library.library_id });
  const args = ['--no-extensions', '--no-skills', '--no-mcp', '--session-dir', sessions, '--tools', 'read,notion_list,notion_use,notion_ctl',
    '-e', providerExtension, '-e', observerExtension, '-e', join(info.packageRoot, 'src/index.ts'), '--model', 'context-broker-e2e/fake'];
  await save(join(base, 'launch.json'), { host: info.host, command: info.identity.pi, args, cwd: base, runtime: info.identity.runtime,
    source_origin: service.origin, provider_origin: provider.baseUrl, source, isolation: 'Owned HOME, agent, session, NTN and XDG paths; only declared controlled token', ordinary_daily: false });
  const checkSources = (body, present, absent = []) => {
    assertWireSources(body, present, absent);
    const captured = wire.find(item => item.body === body); assert.ok(captured);
    const original = text => ({ text, bytes: Buffer.byteLength(text), sha256: hash(text) });
    const proof = { provider_file: captured.file, present: present.map(original), absent: absent.map(original) };
    wireAssertions.push(proof); return proof.provider_file;
  };
  const step = async (label, action) => { const before = wire.length, started = Date.now();
    try { const value = await action(); steps.push({ label, status: 'passed', elapsed_ms: Date.now() - started, provider_requests: wire.slice(before).map(item => item.file) }); await save(join(base, 'steps.json'), steps); return value; }
    catch (error) { steps.push({ label, status: 'failed', error: error.message, elapsed_ms: Date.now() - started }); await save(join(base, 'steps.json'), steps); throw error; } };
  const ordinary = async label => { plan = { mode: 'complete' }; await rpc.prompt(label); assert.ok(wire.length); return wire.at(-1).body; };
  const tool = async (name, args, label = name) => {
    const id = 'current-' + (++sequence); plan = { mode: 'call', call: { type: 'toolCall', id, name, arguments: args } };
    await rpc.prompt(label);
    const frame = rpc.frames.find(item => item.type === 'tool_execution_end' && item.toolCallId === id);
    assert.ok(frame, 'No completed actual Pi tool call: ' + id);
    const text = frame.result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
    let value; try { value = JSON.parse(text); } catch { value = { text }; }
    return { frame, value, text };
  };
  const list = async () => { const records = []; for (const query of ['Current demo', 'Current acceptance']) { const result = await tool('notion_list', { query, limit: 100 }); assert.equal(result.frame.isError, false, result.text); assert.ok(Array.isArray(result.value.records)); records.push(...result.value.records); } return records; };
  const refFor = (records, key) => { const row = records.find(row => row.id === `library-current/${key === 'a' ? 'demo' : 'acceptance-' + key}`) ?? records.find(row => row.name === (key === 'a' ? 'Current demo' : 'Current acceptance ' + key.toUpperCase())); assert.ok(row?.ref, 'Current discovered record missing: ' + key); return row.ref; };
  const use = async ref => { const value = await tool('notion_use', { ref }); assert.equal(value.frame.isError, false, value.text); return value; };
  const show = async () => { const result = await tool('notion_ctl', { working_set: 'show' }); assert.equal(result.frame.isError, false, result.text); assert.equal(result.value.kind, 'working_set'); return result.value; };
  const snapshot = async label => { const output = join(base, label + '.json'); await save(control, { action: 'snapshot', output }); await rpc.prompt('/current-fixture'); return JSON.parse(await readFile(output, 'utf8')); };
  const compact = async label => {
    await ordinary('Checkpoint for ' + label); const before = await snapshot(label + '-before');
    const entry = [...before.branch].reverse().find(item => item.type === 'message' && item.message?.role === 'user'); assert.ok(entry);
    await save(control, { action: 'compact', firstKeptEntryId: entry.id }); await rpc.command('compact', { customInstructions: 'Use the owned controlled summary.' });
    const after = await snapshot(label + '-after'); assert.ok(after.branch.some(item => item.type === 'compaction')); return after;
  };
  try {
    if (metadataRevalidation) service.setPhase('cold');
    rpc = await startRpc({ host: info.host, args, cwd: base, env, timeoutMs: 120000 });
    const a1 = sourceText(service.notion, owners.a), b1 = sourceText(service.notion, owners.b), c1 = sourceText(service.notion, owners.c);
    let records;
    if (metadataRevalidation) {
      const receipt = { version: 1, fixture_sha256: hash(JSON.stringify(sample)), owners: [owners.a, owners.b],
        full_body_max_age_ms: nativeBodyMaxAgeMs, processes: [], costs: [], states: {}, proofs: {} };
      const readPhase = async (phase, maxAgeMs) => {
        const empty = await snapshot(phase + '-empty-session');
        assert.equal(empty.branch.some(entry => entry.customType === 'context-broker-selected-graph'), false);
        const pid = rpc.lifecycle[0].pid;
        receipt.processes.push({ phase, pid, session_file: empty.session_file, max_age_ms: maxAgeMs });
        await step(phase + ': a fresh Pi dollar submission reads the complete root and Requires', async () => {
          receipt.proofs[phase] = checkSources(await ordinary('$current-demo Apply this Skill to the new task.'), [a1, b1], [c1]);
        });
        await snapshot(phase + '-final-session'); await rpc.closeInput();
        await save(join(base, phase + '-rpc.json'), rpc.frames);
        await save(join(base, phase + '-rpc-lifecycle.json'), rpc.lifecycle);
        const events = await rows(join(base, 'sdk.jsonl'));
        receipt.costs.push(phaseCost(events, service.requests, pid, phase, steps.at(-1).elapsed_ms, [a1, b1], maxAgeMs));
        receipt.states[phase] = await nativeBodyEvidence(env.NTN_SKILLS_HOME, source.library, receipt.owners);
        await save(join(base, 'smart-revalidate.json'), receipt);
      };
      await readPhase('cold', 300000);
      service.setPhase('full-warm');
      rpc = await startRpc({ host: info.host, args, cwd: base, env, timeoutMs: 120000 });
      await readPhase('full-warm', 300000);
      assert.equal(receipt.costs.at(-1).total_requests, 0, 'The same complete fixture must have a genuine new-process warm sample');
      source.discovery.maxAge = '1s'; source.activation.maxAge = '1s';
      await save(config, { sources: [source] }); await save(join(base, 'metadata-source-config.json'), { sources: [source] });
      await delay(1100);
      service.setPhase('metadata');
      rpc = await startRpc({ host: info.host, args, cwd: base, env, timeoutMs: 120000 });
      await readPhase('metadata', 1000);
      assert.equal(receipt.costs.at(-1).markdown_requests, 0);
      assert.deepEqual(bodyTimes(receipt.states.metadata), bodyTimes(receipt.states.cold), 'Metadata success must retain original body-proof times');
      receipt.aging = await ageOwnedNativeBodyEvidence(env.NTN_SKILLS_HOME, source.library, receipt.owners);
      await save(join(base, 'smart-revalidate.json'), receipt);
      await delay(1100);
      service.setPhase('body-expiry');
      rpc = await startRpc({ host: info.host, args, cwd: base, env, timeoutMs: 120000 });
      await readPhase('body-expiry', 1000);
      assert.ok(receipt.costs.at(-1).markdown_requests > 0, 'Expired independent body evidence must cause actual Markdown acquisition');
      assert.ok(bodyTimes(receipt.states['body-expiry']).every(row => row[4] >= receipt.aging.aged_at_ms));
    } else if (isWarmRestart(name)) {
      await step('cold dollar submission reads the complete root and Requires', async () => {
        checkSources(await ordinary('$current-demo Apply this Skill to the current task.'), [a1, b1], [c1]);
      });
      const cold = await snapshot('cold-session'), coldPid = rpc.lifecycle[0].pid;
      await rpc.closeInput();
      await save(join(base, 'cold-rpc.json'), rpc.frames); await save(join(base, 'cold-rpc-lifecycle.json'), rpc.lifecycle);
      const coldRequests = service.requests.length;
      // Let only the directory TTL expire while neither Pi process is running.
      // The persisted cache remains untouched; lifecycle clocks prove the gap.
      if (directoryExpired) await delay(1100);
      service.setPhase('warm-restart');
      rpc = await startRpc({ host: info.host, args, cwd: base, env, timeoutMs: 120000 });
      const warm = await snapshot('warm-empty-session'), warmPid = rpc.lifecycle[0].pid;
      assert.notEqual(warmPid, coldPid); assert.notEqual(warm.session_file, cold.session_file);
      assert.equal(warm.branch.some(entry => entry.customType === 'context-broker-selected-graph'), false);
      await step(metadataRevalidation ? 'a new Pi revalidates expired current evidence without downloading Skill bodies'
        : directoryExpired ? 'a new Pi refreshes expired metadata while reusing five-minute originals'
        : 'a new Pi process reuses the five-minute cache with no Notion HTTP', async () => {
        const started = Date.now();
        checkSources(await ordinary('$current-demo Apply this Skill to the new task.'), [a1, b1], [c1]);
        const elapsed = Date.now() - started;
        if (!directoryExpired) assert.equal(service.requests.length, coldRequests, 'Warm restart issued Notion HTTP');
        await save(join(base, 'warm-restart.json'), { cold_pid: coldPid, warm_pid: warmPid,
          cold_session: cold.session_file, warm_session: warm.session_file, max_age_ms: metadataRevalidation ? 1000 : 300000,
          directory_max_age_ms: directoryExpired ? 1000 : 300000,
          elapsed_ms: elapsed, cold_source_requests: coldRequests, warm_source_requests: service.requests.length - coldRequests });
      });
    } else if (name === 'http-smart-current') {
      const processes = [], selected = {}, proofs = {};
      const rememberProcess = async label => {
        const empty = await snapshot(label + '-empty-session');
        assert.equal(empty.branch.some(entry => entry.customType === 'context-broker-selected-graph'), false);
        processes.push({ label, pid: rpc.lifecycle[0].pid, session_file: empty.session_file });
      };
      const finishProcess = async label => {
        await snapshot(label + '-final-session'); await rpc.closeInput();
        await save(join(base, label + '-rpc.json'), rpc.frames);
        await save(join(base, label + '-rpc-lifecycle.json'), rpc.lifecycle);
      };
      await rememberProcess('cold');
      await step('cold dollar submission establishes original root and Required pins', async () => {
        proofs.cold = checkSources(await ordinary('$current-demo Apply this Skill to the current task.'), [a1, b1], [c1]);
        selected.cold = await show(); assert.equal(selected.cold.nodes.length, 2);
      });
      await finishProcess('cold');
      replaceBody(service, owners.b, '# Required changed\n\nB replacement version 2.\n', 2);
      const b2 = sourceText(service.notion, owners.b);
      service.setPhase('dirty-cancel');
      rpc = await startRpc({ host: info.host, args, cwd: base, env, timeoutMs: 120000 });
      await rememberProcess('cancelled');
      await step('a new Pi observes Required-only change before the five-minute body TTL', async () => {
        await list(); checkSources(wire.at(-1).body, [], [a1, b1, b2, c1]);
      });
      await step('cancel changed Required acquisition without delivering old current', async () => {
        const before = wire.length;
        const held = service.holdNext({ method: 'GET', path: '/v1/pages/' + owners.b + '/markdown', afterHeaders: true });
        const pending = ordinary('$current-demo Apply this Skill after the Required edit.')
          .then(body => ({ body }), error => ({ error: error.message }));
        let timer;
        try {
          const first = await Promise.race([held.reached.then(() => ({ reached: true })), pending,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Changed Required acquisition exceeded its bounded observation window')), 30000); })]);
          if (!first.reached) {
            if (first.body) checkSources(first.body, [a1, b2], [b1]);
            assert.fail('Known Required change did not reach current body acquisition: ' + (first.error ?? 'old current was admitted'));
          }
          await rpc.command('abort'); held.release(); await pending;
          assert.equal(wire.length, before, 'Cancelled current preparation reached the provider');
        } finally { clearTimeout(timer); held.release(); }
        selected.cancelled = await show(); assert.equal(selected.cancelled.nodes.length, 0);
        proofs.cancelled = checkSources(await ordinary('Continue independent work after cancelling the Skill load.'), [], [a1, b1, b2, c1]);
      });
      await finishProcess('cancelled');
      service.setPhase('dirty-recovery');
      rpc = await startRpc({ host: info.host, args, cwd: base, env, timeoutMs: 120000 });
      await rememberProcess('recovered');
      await list();
      await step('another new Pi retries 429 and admits the complete changed closure', async () => {
        const rejected = service.rejectNext({ method: 'GET', path: '/v1/pages/' + owners.b + '/markdown', status: 429, retryAfterSeconds: 0.01 });
        proofs.recovered = checkSources(await ordinary('$current-demo Apply this Skill after the interrupted acquisition.'), [a1, b2], [b1, c1]);
        await rejected.closed;
        selected.recovered = await show(); assert.equal(selected.recovered.nodes.length, 2);
      });
      service.setPhase('pin-stable');
      replaceBody(service, owners.a, '# Root changed\n\nA replacement version 3.\n', 3);
      replaceBody(service, owners.b, '# Required changed again\n\nB replacement version 3.\n', 3);
      property(service.notion.skills.find(row => row.id === owners.a), 'requires').relation = [{ id: owners.c }];
      property(service.notion.skills.find(row => row.id === owners.c), 'requires').relation = [];
      const a3 = sourceText(service.notion, owners.a), b3 = sourceText(service.notion, owners.b);
      await step('later current and Requires changes preserve already accepted pins', async () => {
        await list();
        proofs.pinned = checkSources(await ordinary('Continue the accepted task after the remote dependency change.'), [a1, b2], [a3, b1, b3, c1]);
        selected.pinned = await show();
        assert.deepEqual(selected.pinned.nodes.map(node => node.snapshot_id).sort(), selected.recovered.nodes.map(node => node.snapshot_id).sort());
      });
      await finishProcess('recovered');
      service.setPhase('membership-current');
      rpc = await startRpc({ host: info.host, args, cwd: base, env, timeoutMs: 120000 });
      await rememberProcess('replacement');
      await step('a new current selection replaces the complete Requires membership', async () => {
        proofs.replacement = checkSources(await ordinary('$current-demo Apply the current Skill to a new task.'), [a3, c1], [a1, b1, b2, b3]);
        selected.replacement = await show(); assert.equal(selected.replacement.nodes.length, 2);
        assert.deepEqual(selected.replacement.nodes.map(node => node.name).sort(), ['Current acceptance C', 'Current demo']);
      });
      await save(join(base, 'smart-current.json'), { version: 1, max_age_ms: 300000, processes, proofs, selected, owners });
    } else if (name === 'default-view') {
      await step('default metadata only before activation', async () => { const body = await ordinary('Describe the available capabilities.'); checkSources(body, [], [a1, b1, c1]); records = await list(); const row = records.find(row => row.ref === refFor(records, 'a')); assert.equal(row.in_default_view, true); });
      await step('Default Context removal does not consume a body', async () => { property(service.notion.main, 'default').checkbox = false; service.setPhase('default-off', { viewObservationId: 'off' }); records = await list(); const row = records.find(row => row.ref === refFor(records, 'a')); assert.equal(row.in_default_view, false); checkSources(wire.at(-1).body, [], [a1, b1, c1]); });
      await step('Default Context can return without fetching bodies', async () => { property(service.notion.main, 'default').checkbox = true; service.setPhase('default-on', { viewObservationId: 'initial' }); records = await list(); assert.equal(records.find(row => row.ref === refFor(records, 'a')).in_default_view, true); assert.equal(service.requests.filter(item => /\/markdown$/.test(item.path)).length, 0, 'Metadata discovery must not fetch any source body'); });
      await step('activate a fixed root and its Required before flag edits', async () => { await use(refFor(records, 'a')); checkSources(wire.at(-1).body, [a1, b1]); });
      const active = await show(), fixed = active.nodes.find(node => node.root).ref;
      await step('Default Context removal preserves the active closure', async () => { property(service.notion.main, 'default').checkbox = false; service.setPhase('active-default-off', { viewObservationId: 'off' }); records = await list(); assert.equal(records.find(row => row.ref === refFor(records, 'a')).in_default_view, false); checkSources(await ordinary('Continue the active task after Default Context was disabled.'), [a1, b1]); assert.deepEqual((await show()).nodes.map(node => node.snapshot_id), active.nodes.map(node => node.snapshot_id)); });
      await step('Enabled removal blocks current admission while preserving active originals', async () => { for (const row of [service.notion.main, ...service.notion.skills].filter(row => row.id === owners.a)) property(row, 'enabled').checkbox = false; records = await list(); assert.equal(records.some(row => row.name === 'Current demo'), false); const denied = await tool('notion_use', { ref: fixed, refresh: true }); assert.equal(denied.frame.isError, true); assert.equal(denied.text, 'SOURCE_REFERENCE_MISSING'); await save(join(base, 'qualification-change.json'), { ref_origin: 'working_set.show.roots', ref: fixed, fixed_snapshot_ids: active.nodes.map(node => node.snapshot_id), controlled_source_enabled: false, present_in_fresh_directory: false, refresh_error_code: denied.text, interpretation: 'Fresh eligible directory has no owner; catalog absence alone does not establish a deletion or authorization denial.' }); checkSources(await ordinary('Continue the existing task after Enabled was disabled.'), [a1, b1]); assert.deepEqual((await show()).nodes.map(node => node.snapshot_id), active.nodes.map(node => node.snapshot_id)); });
      await step('compact restores fixed originals despite business Enabled being off', async () => { await compact('disabled-fixed-compact'); checkSources(await ordinary('Continue with the fixed version after compaction.'), [a1, b1]); assert.deepEqual((await show()).nodes.map(node => node.snapshot_id), active.nodes.map(node => node.snapshot_id)); });
      await step('Enabled and Default Context restoration admits current metadata again', async () => { for (const row of [service.notion.main, ...service.notion.skills].filter(row => row.id === owners.a)) { property(row, 'enabled').checkbox = true; property(row, 'default').checkbox = true; } service.setPhase('reenabled-default-on', { viewObservationId: 'initial' }); records = await list(); assert.equal(records.find(row => row.ref === refFor(records, 'a')).in_default_view, true); checkSources(await ordinary('Continue after the Skill was enabled again.'), [a1, b1]); });
    } else {
      records = await step('fresh current catalogue over actual HTTP', list);
      const a = refFor(records, 'a'), c = refFor(records, 'c');
      if (name === 'http-interruption') {
        await step('cancel held source body, then continue same Pi session', async () => {
          const hold = service.holdNext({ method: 'GET', path: '/v1/pages/' + owners.a + '/markdown', afterHeaders: true });
          const pending = use(a).then(value => ({ value }), error => ({ error }));
          let timer; try { await Promise.race([hold.reached, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Held current HTTP body was never reached')), 60000); })]); } finally { clearTimeout(timer); }
          await rpc.command('abort'); hold.release(); const outcome = await pending;
          assert.ok(outcome.error || outcome.value.frame.isError, 'Cancelled acquisition cannot report successful use');
          checkSources(await ordinary('Continue the ordinary task after source cancellation.'), [], [a1, b1]);
          const report = await show(); assert.equal(report.nodes.length, 0);
        });
        await step('explicit retry after cancellation succeeds', async () => { await use(a); checkSources(wire.at(-1).body, [a1, b1]); const report = await show(); assert.equal(report.roots.length, 1); assert.equal(report.nodes.length, 2); });
      } else if (name === 'working-set') {
        await step('two roots share one actual Requires node', async () => { await use([a, c]); checkSources(wire.at(-1).body, [a1, b1, c1]); const report = await show(); assert.equal(report.roots.length, 2); assert.equal(report.nodes.length, 3); assert.equal(report.nodes.find(node => !node.root).required_by.length, 2); });
        await step('release preserves shared dependency and surviving root', async () => { const report = await show(); const root = report.nodes.find(node => node.name === 'Current demo'); assert.ok(root?.root); const result = await tool('notion_ctl', { working_set: 'release', roots: [root.ref] }); assert.equal(result.frame.isError, false, result.text); assert.equal(result.value.roots.length, 1); assert.equal(result.value.nodes.length, 2); checkSources(await ordinary('Continue with the retained root.'), [b1, c1], [a1]); });
        await step('compaction restores the retained closure only', async () => { await compact('release-compact'); checkSources(await ordinary('Continue after compaction.'), [b1, c1], [a1]); const report = await show(); assert.equal(report.nodes.length, 2); });
        await step('budget rejects complete additional closure without eviction', async () => { const before = await show(); const budget = await tool('notion_ctl', { working_set: 'budget', max_bytes: before.active.instruction_bytes }); assert.equal(budget.frame.isError, false, budget.text); const denied = await tool('notion_use', { ref: a }); assert.equal(denied.frame.isError, true); assert.match(denied.text, /SOURCE_WORKING_SET_BUDGET/); const after = await show(); assert.deepEqual(after.roots, before.roots); checkSources(await ordinary('Continue after the budget warning.'), [b1, c1], [a1]); });
      } else {
        await step('select actual A and Requires B originals', async () => { await use(a); checkSources(wire.at(-1).body, [a1, b1]); });
        const before = await show(); const fixed = before.nodes.find(node => node.root).ref;
        replaceBody(service, owners.a, '# Current A changed\n\nA replacement version 2.\n', 2);
        replaceBody(service, owners.b, '# Current B changed\n\nB replacement version 2.\n', 2);
        const a2 = sourceText(service.notion, owners.a), b2 = sourceText(service.notion, owners.b);
        await step('expired metadata TTL preserves active originals', async () => { await list(); checkSources(await ordinary('Continue the existing task after source edits.'), [a1, b1], [a2, b2]); assert.deepEqual((await show()).nodes.map(node => node.snapshot_id), before.nodes.map(node => node.snapshot_id)); });
        await step('read refresh compares current body without adopting', async () => { const inspected = await tool('read', { path: fixed, refresh: true }); assert.equal(inspected.frame.isError, false, inspected.text); checkSources(wire.at(-1).body, [a1, b1, a2], [b2]); assert.deepEqual((await show()).nodes.map(node => node.snapshot_id), before.nodes.map(node => node.snapshot_id)); });
        await step('explicit use refresh adopts current closure', async () => { const adopted = await tool('notion_use', { ref: fixed, refresh: true }); assert.equal(adopted.frame.isError, false, adopted.text); checkSources(wire.at(-1).body, [a2, b2], [a1, b1]); const report = await show(); assert.equal(report.nodes.length, 2); assert.ok(report.nodes.every(node => !before.nodes.some(old => old.snapshot_id === node.snapshot_id))); });
        await step('cleared owned cache does not block current conversation', async () => {
          const receipt = await runCommand(process.execPath, [join(info.packageRoot, 'dist/ntn-skills.mjs'), 'ctl', 'cache', 'clear', '--all'], { cwd: base, env: { ...env, NODE_OPTIONS: '' }, timeoutMs: 60000 });
          await save(join(base, 'cache-clear.json'), receipt); checkSources(await ordinary('Continue after the local cache was cleared.'), [a2, b2]);
        });
        await step('lost fixed object and compaction remain nonblocking', async () => {
          const active = await show(); const dependency = active.nodes.find(node => !node.root); assert.ok(dependency);
          const object = join(env.NTN_SKILLS_HOME, 'objects', dependency.body_sha256), retained = join(base, 'retained-object-' + dependency.body_sha256);
          const original = await readFile(object); assert.equal(hash(original), dependency.body_sha256); await rename(object, retained); await save(join(base, 'object-loss.json'), { original_path: object, retained_path: retained, sha256: hash(original), bytes: original.length });
          replaceBody(service, owners.a, '# Current A changed again\n\nA replacement version 3.\n', 3); replaceBody(service, owners.b, '# Current B changed again\n\nB replacement version 3.\n', 3);
          await compact('lost-object-compact');
          for (let attempt = 1; attempt <= 3; attempt++) checkSources(await ordinary('Continue ordinary task after fixed object loss, message ' + attempt), [], [a1, b1, a2, b2, sourceText(service.notion, owners.a), sourceText(service.notion, owners.b)]);
          const after = await show(); assert.deepEqual(after.nodes.map(node => node.snapshot_id), active.nodes.map(node => node.snapshot_id));
          assert.ok(after.context.some(root => !root.complete));
        });
      }
    }
    if (!metadataRevalidation) { await snapshot('final-session'); await rpc.closeInput(); }
    if (isWarmRestart(name) && !metadataRevalidation) {
      const receiptPath = join(base, 'warm-restart.json'), receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      receipt.warm_source_requests = service.requests.length - receipt.cold_source_requests;
      await save(receiptPath, receipt);
    }
    const events = await rows(join(base, 'sdk.jsonl')), starts = events.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'start'), ends = events.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'end');
    assert.ok(starts.length); assert.equal(starts.length, ends.length); assert.deepEqual(starts.map(row => row.id).sort(), ends.map(row => row.id).sort());
    assert.equal(events.filter(row => row.kind === 'child_process' && row.active_sdk_ids.length > 0).length, 0, 'Broker consumption may not spawn a CLI');
    assert.deepEqual(service.unexpected, []); assert.ok(service.requests.every(row => row.method === 'GET' || row.method === 'POST' && /\/(?:query|queries)$/.test(row.path)));
    assert.ok(wire.every(row => row.record.phase === 'responded' && row.record.status === 200));
    return { name, status: 'passed', evidence: base, steps, provider_requests: wire.length, source_requests: service.requests.length, sdk_operations: ends.length, semantic_writes: 0,
      sdk_failures: ends.filter(row => row.status !== 'completed').map(row => ({ operation: row.operation, status: row.status, code: row.error_code })), process_exit: rpc.lifecycle.at(-1) };
  } catch (error) { failure = error; throw error; }
  finally {
    if (rpc) { if (!rpc.lifecycle.some(row => row.event === 'close')) await rpc.stop().catch(error => { failure ??= error; }); await save(join(base, 'rpc.json'), rpc.frames); await save(join(base, 'rpc-lifecycle.json'), rpc.lifecycle); }
    await provider.close(); await service.close();
    await save(join(base, 'wire-source-assertions.json'), wireAssertions);
    await save(join(base, 'provider-index.json'), wire.map(({ file, sha256, record }) => ({ file, sha256, ...record })));
    await save(join(base, 'scenario.json'), { name, status: failure ? 'failed' : 'passed', steps, ...(failure ? { error: failure.message, stack: failure.stack } : {}) });
  }
}

async function verifySmartRevalidation(base, source, events, proofs, steps) {
  const receipt = JSON.parse(await readFile(join(base, 'smart-revalidate.json'), 'utf8'));
  const facts = JSON.parse(await readFile(join(base, 'source-facts.json'), 'utf8'));
  const phases = ['cold', 'full-warm', 'metadata', 'body-expiry'], policies = [300000, 300000, 1000, 1000];
  assert.equal(receipt.version, 1); assert.equal(receipt.full_body_max_age_ms, nativeBodyMaxAgeMs);
  assert.match(receipt.fixture_sha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.fixture_sha256, hash(JSON.stringify(facts)));
  assert.deepEqual(receipt.owners, [facts.root_page_id, property(facts.notion.skills.find(row => row.id === facts.root_page_id), 'requires').relation[0].id]);
  assert.deepEqual(receipt.processes.map(row => row.phase), phases);
  assert.equal(new Set(receipt.processes.map(row => row.pid)).size, 4);
  assert.equal(new Set(receipt.processes.map(row => row.session_file)).size, 4);
  assert.deepEqual(receipt.costs.map(row => row.phase), phases);
  assert.equal(proofs.length, 4); assert.ok(proofs.every(proof => proof.present.length === 2));
  assert.equal(new Set(Object.values(receipt.proofs)).size, 4);
  assert.ok(source.every(row => phases.includes(row.phase)), 'Every observed HTTP attempt must belong to one reported phase');
  const launch = JSON.parse(await readFile(join(base, 'launch.json'), 'utf8'));
  const metadataConfig = JSON.parse(await readFile(join(base, 'metadata-source-config.json'), 'utf8'));
  assert.equal(launch.source.activation.maxAge, '5m'); assert.equal(launch.source.discovery.maxAge, '5m');
  assert.equal(metadataConfig.sources[0].activation.maxAge, '1s'); assert.equal(metadataConfig.sources[0].discovery.maxAge, '1s');
  assert.deepEqual(metadataConfig.sources[0], { ...launch.source, activation: { maxAge: '1s' }, discovery: { maxAge: '1s' } });
  assert.deepEqual(proofs[0].present.map(row => row.sha256), receipt.owners.map(owner => hash(sourceText(facts.notion, owner))));
  let previousClose;
  const prepared = [];
  for (const [index, phase] of phases.entries()) {
    const process = receipt.processes[index], cost = receipt.costs[index];
    assert.equal(process.max_age_ms, policies[index]);
    const lifecycle = JSON.parse(await readFile(join(base, phase + '-rpc-lifecycle.json'), 'utf8'));
    assert.equal(lifecycle[0].event, 'spawn'); assert.equal(lifecycle[0].pid, process.pid);
    assert.equal(lifecycle.at(-1).event, 'close'); assert.equal(lifecycle.at(-1).code, 0); assert.equal(lifecycle.at(-1).signal, null);
    if (previousClose !== undefined) assert.ok(BigInt(lifecycle[0].monotonicNs) >= previousClose);
    previousClose = BigInt(lifecycle.at(-1).monotonicNs);
    const empty = JSON.parse(await readFile(join(base, phase + '-empty-session.json'), 'utf8'));
    assert.equal(empty.session_file, process.session_file);
    assert.equal(empty.branch.some(row => row.customType === 'context-broker-selected-graph'), false);
    const matching = proofs.filter(proof => proof.provider_file === receipt.proofs[phase]); assert.equal(matching.length, 1);
    assert.deepEqual(matching[0].present.map(row => row.sha256).sort(), proofs[0].present.map(row => row.sha256).sort());
    const step = steps.find(row => row.label.startsWith(phase + ':')); assert.ok(step);
    assert.ok(Number.isFinite(step.elapsed_ms) && step.elapsed_ms > 0);
    assert.ok(step.elapsed_ms <= Number(BigInt(lifecycle.at(-1).monotonicNs) - BigInt(lifecycle[0].monotonicNs)) / 1e6);
    assert.deepEqual(cost, phaseCost(events, source, process.pid, phase, step.elapsed_ms, matching[0].present.map(row => row.text), policies[index]));
    const consumed = events.filter(row => row.kind === 'context-broker.notion-sdk-result' && row.operation === 'consume' && row.observer_pid === process.pid);
    assert.equal(consumed.length, 1); assert.equal(consumed[0].value.status, 'ready');
    const nodes = consumed[0].value.preparation.nodes.filter(node => node.state === 'prepared').sort((a, b) => a.id.localeCompare(b.id));
    assert.equal(nodes.length, 2);
    assert.ok(nodes.every(node => node.source === (phase === 'full-warm' ? 'local_cache' : 'notion')
      && node.freshness.max_age_ms === policies[index] && node.freshness.policy !== 'refresh'
      && node.freshness.age_ms >= 0 && node.freshness.age_ms < policies[index] && node.freshness.stale === false));
    prepared.push(nodes);
    const state = receipt.states[phase];
    assert.ok(state.native.length === 2 && state.observations.length >= 2 && state.objects.length >= 2);
    assert.deepEqual(state.native.map(row => row.payload.skill_page_id).sort(), [...receipt.owners].sort());
    for (const object of state.objects) { assert.match(object.sha256, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(object.bytes) && object.bytes >= 0); }
    assert.deepEqual(state.snapshots, receipt.states.cold.snapshots, 'Body verification may not rewrite the immutable manifest');
    assert.deepEqual(state.objects, receipt.states.cold.objects, 'The same fixture must retain exact original objects');
  }
  const identity = nodes => nodes.map(node => [node.id, node.binding.snapshot_id, node.body_sha256]);
  for (const nodes of prepared) assert.deepEqual(identity(nodes), identity(prepared[0]));
  assert.deepEqual(prepared[1].map(node => node.freshness.validated_at), prepared[0].map(node => node.freshness.validated_at));
  assert.ok(prepared[2].every((node, index) => node.freshness.validation === 'metadata'
    && Date.parse(node.freshness.validated_at) - Date.parse(prepared[1][index].freshness.validated_at) >= 1000));
  assert.ok(prepared[3].every(node => node.freshness.validation !== 'metadata'));
  assert.equal(receipt.costs[1].total_requests, 0);
  assert.equal(receipt.costs[2].markdown_requests, 0); assert.ok(receipt.costs[2].total_requests > 0);
  assert.ok(receipt.costs[3].markdown_requests > 0); assert.ok(receipt.costs[3].response_bytes > 0);
  const rootChildren = '/v1/blocks/' + launch.source.library + '/children';
  assert.ok(source.filter(row => row.phase === 'metadata').every(row => row.path === rootChildren || !/\/markdown$|\/blocks\//.test(row.path)));
  const metadataBody = source.filter(row => row.phase === 'metadata' && row.path === rootChildren).length;
  assert.equal(receipt.costs[2].requests.notion_body, metadataBody);
  for (const phase of ['full-warm', 'metadata']) assert.deepEqual(bodyTimes(receipt.states[phase]), bodyTimes(receipt.states.cold));
  const aging = receipt.aging;
  assert.equal(aging.mode, 'owned-cache-body-age'); assert.equal(aging.full_body_max_age_ms, nativeBodyMaxAgeMs);
  assert.ok(Number.isSafeInteger(aging.aged_at_ms) && aging.aged_at_ms > nativeBodyMaxAgeMs);
  assert.equal(aging.expired_body_verified_at, aging.aged_at_ms - nativeBodyMaxAgeMs - 1000);
  assert.deepEqual(withoutBodyTimes(aging.before), withoutBodyTimes(receipt.states.metadata));
  assert.deepEqual(bodyTimes(aging.before), bodyTimes(receipt.states.metadata));
  assert.deepEqual(withoutBodyTimes(aging.aged), withoutBodyTimes(aging.before), 'Aging cannot alter metadata, epochs, authority, pins or object bytes');
  assert.ok(bodyTimes(aging.before).every(row => aging.aged_at_ms >= row[4] && aging.aged_at_ms - row[4] < nativeBodyMaxAgeMs));
  assert.ok(bodyTimes(aging.aged).every(row => row[4] === aging.expired_body_verified_at));
  assert.ok(aging.aged.observations.every(row => row.payload.shared_body_valid_until === aging.expired_body_verified_at + nativeBodyMaxAgeMs));
  const renewed = bodyTimes(receipt.states['body-expiry']);
  assert.deepEqual(renewed.map(row => row.slice(0, 4)), bodyTimes(aging.before).map(row => row.slice(0, 4)));
  assert.ok(renewed.every(row => Number.isSafeInteger(row[4]) && row[4] >= aging.aged_at_ms));
  for (const page of new Set(renewed.map(row => row[2])))
    assert.ok(source.some(row => row.phase === 'body-expiry' && row.path === '/v1/pages/' + page + '/markdown'), 'Each expired native body needs an actual request');
}

export async function verifyEvidence(directory) {
  const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  assert.equal(result.schema, 2); assert.equal(result.status, 'passed'); assert.equal(result.identity.evidence_level, 'controlled-Pi');
  assert.ok(result.cases.length > 0 && result.cases.every(item => scenarios.includes(item.name) && item.status === 'passed'));
  for (const entry of result.cases) {
    const base = join(directory, entry.name), scenario = JSON.parse(await readFile(join(base, 'scenario.json'), 'utf8'));
    assert.equal(scenario.status, 'passed'); assert.ok(scenario.steps.length && scenario.steps.every(step => step.status === 'passed'));
    const wire = JSON.parse(await readFile(join(base, 'provider-index.json'), 'utf8')); assert.ok(wire.length > 0);
    for (const row of wire) { assert.match(row.file, /^provider-\d{3}\.json$/); assert.equal(hash(await readFile(join(base, row.file))), row.sha256); assert.equal(row.status, 200); }
    const proofs = JSON.parse(await readFile(join(base, 'wire-source-assertions.json'), 'utf8')); assert.ok(proofs.length > 0);
    for (const proof of proofs) {
      assert.ok(wire.some(row => row.file === proof.provider_file));
      for (const original of [...proof.present, ...proof.absent]) { assert.equal(Buffer.byteLength(original.text), original.bytes); assert.equal(hash(original.text), original.sha256); }
      assertWireSources(JSON.parse(await readFile(join(base, proof.provider_file), 'utf8')), proof.present.map(item => item.text), proof.absent.map(item => item.text));
    }
    const source = await rows(join(base, 'source-http.jsonl')); assert.ok(source.length > 0);
    assert.ok(source.every(row => row.method === 'GET' || row.method === 'POST' && /\/(?:query|queries)$/.test(row.path)));
    const events = await rows(join(base, 'sdk.jsonl'));
    const starts = events.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'start'), ends = events.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'end');
    assert.ok(starts.length > 0); assert.deepEqual(starts.map(row => row.id).sort(), ends.map(row => row.id).sort());
    assert.equal(events.filter(row => row.kind === 'child_process' && row.active_sdk_ids.length > 0).length, 0);
    const lifecycle = JSON.parse(await readFile(join(base, 'rpc-lifecycle.json'), 'utf8')); assert.equal(lifecycle.at(-1).event, 'close'); assert.equal(lifecycle.at(-1).code, 0); assert.equal(lifecycle.at(-1).signal, null);
    if (entry.name === 'http-smart-current') {
      const receipt = JSON.parse(await readFile(join(base, 'smart-current.json'), 'utf8'));
      const launch = JSON.parse(await readFile(join(base, 'launch.json'), 'utf8'));
      assert.equal(receipt.version, 1); assert.equal(receipt.max_age_ms, 300000);
      assert.equal(launch.source.activation.maxAge, '5m'); assert.equal(launch.source.discovery.maxAge, '0');
      assert.deepEqual(receipt.processes.map(process => process.label), ['cold', 'cancelled', 'recovered', 'replacement']);
      assert.equal(new Set(receipt.processes.map(process => process.pid)).size, 4);
      assert.equal(new Set(receipt.processes.map(process => process.session_file)).size, 4);
      let previousExit;
      for (const process of receipt.processes) {
        const processLife = process.label === 'replacement' ? lifecycle
          : JSON.parse(await readFile(join(base, process.label + '-rpc-lifecycle.json'), 'utf8'));
        assert.equal(processLife[0].event, 'spawn'); assert.equal(processLife[0].pid, process.pid);
        assert.equal(processLife.at(-1).event, 'close'); assert.equal(processLife.at(-1).code, 0); assert.equal(processLife.at(-1).signal, null);
        if (previousExit !== undefined) assert.ok(BigInt(processLife[0].monotonicNs) >= previousExit);
        previousExit = BigInt(processLife.at(-1).monotonicNs);
        const empty = JSON.parse(await readFile(join(base, process.label + '-empty-session.json'), 'utf8'));
        assert.equal(empty.session_file, process.session_file);
        assert.equal(empty.branch.some(row => row.customType === 'context-broker-selected-graph'), false);
      }
      const proof = label => {
        const matching = proofs.filter(proof => proof.provider_file === receipt.proofs[label]);
        assert.equal(matching.length, 1, 'Each smart current boundary needs its own complete wire proof');
        return matching[0];
      };
      const cold = proof('cold'), cancelled = proof('cancelled'), recovered = proof('recovered'), pinned = proof('pinned'), replacement = proof('replacement');
      const hashes = proof => proof.present.map(body => body.sha256).sort();
      assert.equal(new Set(Object.values(receipt.proofs)).size, 5);
      for (const stage of [cold, recovered, pinned, replacement]) assert.equal(stage.present.length, 2);
      assert.equal(cancelled.present.length, 0); assert.ok(cancelled.absent.length >= 4);
      assert.equal(hashes(cold).filter(hash => hashes(recovered).includes(hash)).length, 1, 'Only Required may change during the interrupted acquisition');
      assert.deepEqual(hashes(recovered), hashes(pinned), 'A later current observation may not rewrite accepted pins');
      assert.ok(hashes(replacement).every(hash => !hashes(pinned).includes(hash)), 'New selection must replace both the root version and Required member');
      assert.ok(cold.present.some(body => recovered.absent.some(retired => retired.sha256 === body.sha256)));
      assert.ok(pinned.present.every(body => replacement.absent.some(retired => retired.sha256 === body.sha256)));
      const bodyPath = '/v1/pages/' + receipt.owners.b + '/markdown';
      const interrupted = source.filter(row => row.phase === 'dirty-cancel' && row.path === bodyPath);
      assert.ok(interrupted.length > 0, 'Known dirty Required must attempt current acquisition');
      const retried = source.filter(row => row.phase === 'dirty-recovery' && row.path === bodyPath);
      assert.ok(retried.some(row => row.status === 429) && retried.some(row => row.status === 200), 'Recovery must include the actual 429 and successful body read');
      assert.equal(source.filter(row => row.phase === 'membership-current' && row.path === bodyPath).length, 0, 'Removed Required must not be reacquired');
      const cancelledPid = receipt.processes[1].pid;
      assert.ok(ends.some(row => row.observer_pid === cancelledPid && row.operation === 'consume' && row.status !== 'completed'));
      const consumed = label => events.filter(row => row.observer_pid === receipt.processes.find(process => process.label === label).pid
        && row.operation === 'consume' && row.kind === 'context-broker.notion-sdk-result' && row.value?.status === 'ready');
      for (const label of ['cold', 'recovered', 'replacement']) {
        const result = consumed(label); assert.equal(result.length, 1);
        const nodes = result[0].value.preparation.nodes.filter(node => node.state === 'prepared');
        assert.equal(nodes.length, 2);
        assert.deepEqual(nodes.map(node => node.body_sha256).sort(), hashes(proof(label)));
        assert.ok(nodes.every(node => typeof node.freshness?.validated_at === 'string'));
      }
      assert.equal(consumed('cancelled').length, 0, 'Cancelled acquisition cannot create a ready current result');
      const coldRoot = consumed('cold')[0].value.preparation.nodes.find(node => node.record?.name === 'Current demo');
      const recoveredRoot = consumed('recovered')[0].value.preparation.nodes.find(node => node.record?.name === 'Current demo');
      assert.ok(coldRoot && recoveredRoot);
      assert.equal(coldRoot.binding.snapshot_id, recoveredRoot.binding.snapshot_id, 'Required-only change may not replace an unchanged root snapshot');
      assert.equal(coldRoot.body_sha256, recoveredRoot.body_sha256);
      assert.equal(source.filter(row => ['dirty-cancel', 'dirty-recovery'].includes(row.phase)
        && row.path === '/v1/pages/' + receipt.owners.a + '/markdown').length, 0, 'Required-only change must not download unchanged root bytes');
    }
    if (entry.name === 'http-smart-revalidate') await verifySmartRevalidation(base, source, events, proofs, scenario.steps);
    if (isWarmRestart(entry.name) && entry.name !== 'http-smart-revalidate') {
      const metadataRevalidation = entry.name === 'http-smart-revalidate';
      const directoryExpired = entry.name === 'http-warm-directory-expired' || metadataRevalidation;
      assert.equal(proofs.length, 2, 'Cold and warm provider requests must both prove complete originals');
      assert.ok(proofs.every(proof => proof.present.length === 2));
      assert.notEqual(proofs[0].provider_file, proofs[1].provider_file);
      assert.deepEqual(proofs[0].present.map(original => original.sha256).sort(), proofs[1].present.map(original => original.sha256).sort());
      const restart = JSON.parse(await readFile(join(base, 'warm-restart.json'), 'utf8'));
      const coldLifecycle = JSON.parse(await readFile(join(base, 'cold-rpc-lifecycle.json'), 'utf8'));
      const launch = JSON.parse(await readFile(join(base, 'launch.json'), 'utf8'));
      assert.equal(launch.source.activation.maxAge, metadataRevalidation ? '1s' : '5m');
      assert.equal(launch.source.discovery.maxAge, directoryExpired ? '1s' : '5m');
      assert.equal(coldLifecycle.at(-1).code, 0); assert.equal(coldLifecycle.at(-1).signal, null);
      assert.equal(coldLifecycle.at(-1).event, 'close');
      assert.equal(coldLifecycle[0].pid, restart.cold_pid); assert.equal(lifecycle[0].pid, restart.warm_pid);
      assert.notEqual(restart.cold_pid, restart.warm_pid); assert.notEqual(restart.cold_session, restart.warm_session);
      const coldSession = JSON.parse(await readFile(join(base, 'cold-session.json'), 'utf8'));
      const warmSession = JSON.parse(await readFile(join(base, 'warm-empty-session.json'), 'utf8'));
      assert.equal(coldSession.session_file, restart.cold_session); assert.equal(warmSession.session_file, restart.warm_session);
      assert.equal(warmSession.branch.some(row => row.customType === 'context-broker-selected-graph'), false);
      assert.equal(restart.max_age_ms, metadataRevalidation ? 1000 : 300000);
      assert.equal(restart.directory_max_age_ms, directoryExpired ? 1000 : 300000);
      const restartGap = BigInt(lifecycle[0].monotonicNs) - BigInt(coldLifecycle.at(-1).monotonicNs);
      assert.ok(restartGap >= 0n, 'Warm Pi must start after the cold process has exited');
      const warmSource = source.filter(row => row.phase === 'warm-restart');
      assert.equal(source.length - warmSource.length, restart.cold_source_requests);
      assert.equal(warmSource.length, restart.warm_source_requests, 'Receipt must account for HTTP through Pi shutdown');
      if (directoryExpired) {
        assert.ok(restartGap > 1000000000n, 'The directory must expire between independent Pi processes');
        assert.ok(warmSource.length > 0, 'Expired directory must be revalidated online');
      } else {
        assert.equal(warmSource.length, 0, 'Warm restart sent Notion HTTP, including background work');
      }
      const consumed = pid => events.filter(row => row.observer_pid === pid && row.operation === 'consume' && row.kind === 'context-broker.notion-sdk-result');
      const cold = consumed(restart.cold_pid), warm = consumed(restart.warm_pid);
      assert.equal(cold.length, 1); assert.equal(warm.length, 1);
      assert.equal(cold[0].value.status, 'ready'); assert.equal(warm[0].value.status, 'ready');
      const prepared = value => value.preparation.nodes.filter(node => node.state === 'prepared').sort((left, right) => left.id.localeCompare(right.id));
      const previous = prepared(cold[0].value), current = prepared(warm[0].value);
      assert.equal(previous.length, 2); assert.equal(current.length, 2);
      assert.ok(previous.every(node => node.source === 'notion'));
      assert.ok(current.every(node => node.source === (metadataRevalidation ? 'notion' : 'local_cache')
        && node.freshness?.max_age_ms === restart.max_age_ms
        && node.freshness.age_ms >= 0 && node.freshness.age_ms < restart.max_age_ms && node.freshness.stale === false));
      const observed = node => [node.id, node.binding.snapshot_id, node.freshness.validated_at];
      if (metadataRevalidation) {
        assert.deepEqual(current.map(node => [node.id, node.binding.snapshot_id, node.body_sha256]), previous.map(node => [node.id, node.binding.snapshot_id, node.body_sha256]));
        assert.ok(current.every((node, index) => node.freshness.validation === 'metadata'
          && Date.parse(node.freshness.validated_at) - Date.parse(previous[index].freshness.validated_at) >= 1000),
          'Expired evidence must receive a real metadata validation, with unchanged complete bodies');
      } else assert.deepEqual(current.map(observed), previous.map(observed), 'Cache reuse must retain original validation times and fixed versions');
      const completed = ends.find(row => row.id === warm[0].id);
      if (metadataRevalidation) assert.ok(completed?.request_metrics?.total_requests > 0);
      else assert.equal(completed?.request_metrics?.total_requests, 0);
      assert.equal(events.filter(row => row.observer_pid === restart.warm_pid && row.operation === 'library').length, 0,
        'Local routing must not trigger separate Library verification');
      const warmEnds = ends.filter(row => row.observer_pid === restart.warm_pid);
      const online = warmEnds.filter(row => row.request_metrics?.total_requests > 0);
      assert.ok(online.every(row => (row.operation === 'list' || metadataRevalidation && row.operation === 'consume') && row.status === 'completed'),
        'Only directory list and declared metadata revalidation may issue warm HTTP');
      assert.equal(online.reduce((total, row) => total + row.request_metrics.total_requests, 0), warmSource.length,
        'All warm HTTP, including identity, Library checks and background discovery, must be attributed');
      if (directoryExpired) {
        const rootChildren = '/v1/blocks/' + launch.source.library + '/children';
        // Preserve the SDK physical body classification for Library root children.
        // It is directory work, but must never be silently relabelled as metadata.
        const bodyReads = warmSource.filter(row => row.path === rootChildren);
        assert.ok(warmSource.every(row => row.path === rootChildren || !/\/markdown$|\/blocks\//.test(row.path)),
          'Expired directory must not reacquire Skill originals');
        assert.equal(online.reduce((total, row) => total + row.request_metrics.requests.notion_body, 0), bodyReads.length);
        assert.equal(online.reduce((total, row) => total + row.request_metrics.body_requests.current_body, 0), bodyReads.length);
        assert.equal(online.reduce((total, row) => total + row.request_metrics.requests.notion_metadata, 0), warmSource.length - bodyReads.length);
      }
    }
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.action === 'help') { console.log(usage); return; }
  if (options.action === 'evidence') { const result = await verifyEvidence(options['--evidence']); console.log(JSON.stringify({ status: 'passed', evidence: options['--evidence'], cases: result.cases.map(item => item.name) })); return; }
  const info = await inspect(options);
  if (options.action === 'doctor') { console.log(JSON.stringify({ status: 'ready', identity: info.identity, supported_scenarios: scenarios })); return; }
  const out = options['--out']; await mkdir(out, { recursive: false, mode: 0o700 });
  await save(join(out, 'identity.json'), info.identity);
  const cases = [], result = { schema: 2, status: 'failed', identity: info.identity, cases, started_at: new Date().toISOString() };
  try {
    for (const name of options['--scenario'] && options['--scenario'] !== 'all' ? [options['--scenario']] : scenarios) {
      cases.push(await runScenario(name, info, out)); await save(join(out, 'result.json'), result);
    }
    for (const entry of info.identity.broker.files) assert.equal(hash(await readFile(join(info.packageRoot, entry.path))), entry.sha256, 'Installed artifact changed during verification');
    result.status = 'passed'; result.completed_at = new Date().toISOString(); await save(join(out, 'result.json'), result);
    await verifyEvidence(out); console.log(JSON.stringify({ status: 'passed', evidence: out, cases: cases.map(item => item.name), evidence_level: 'controlled-Pi' }));
  } catch (error) { result.status = 'failed'; result.error = { message: error.message, stack: error.stack }; await save(join(out, 'result.json'), result); console.error(JSON.stringify({ status: 'failed', evidence: out, error: error.message })); process.exitCode = 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
