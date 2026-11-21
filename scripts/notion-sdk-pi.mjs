import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertSupportedPiVersion, isolatedEnv, resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { renderHttpWrapper, startLoopbackMock } from './mock-provider-adapter.mjs';
import { verifyBundledRuntime } from './verify-package-closure.mjs';

export const scenarios = Object.freeze(['default-view', 'http-cache-recovery', 'http-interruption', 'working-set']);
export const usage = `Current SDK v2, actual Pi, controlled Notion and provider HTTP.
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
    cliBytes: await readFile(join(packageRoot, 'dist/ntn-skills.mjs')), sdkBytes: await readFile(join(packageRoot, 'dist/ntn-skills-sdk.mjs')) });
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  assert.ok(major === 22 && (minor > 22 || minor === 22 && patch >= 3) || major === 24 && minor >= 20 || major > 24, 'A supported explicit Node runtime is required');
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
  const source = { type: 'notion', id: 'current-sdk', namespace: 'current-sdk', database: sample.database,
    discovery: { maxAge: '0' }, activation: { maxAge: '0' }, cacheDir: join(base, 'broker-cache'), prefetch: false };
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
  const args = ['--no-extensions', '--no-skills', '--no-mcp', '--session-dir', sessions, '--tools', 'read,notion_list,notion_use,notion_ctl',
    '-e', providerExtension, '-e', observerExtension, '-e', join(info.packageRoot, 'src/index.ts'), '--model', 'context-broker-e2e/fake'];
  await save(join(base, 'launch.json'), { host: info.host, command: info.identity.pi, args, cwd: base, runtime: info.identity.runtime,
    source_origin: service.origin, provider_origin: provider.baseUrl, source, isolation: 'Owned HOME, agent, session, NTN and XDG paths; only declared controlled token', ordinary_daily: false });
  const checkSources = (body, present, absent = []) => {
    assertWireSources(body, present, absent);
    const captured = wire.find(item => item.body === body); assert.ok(captured);
    const original = text => ({ text, bytes: Buffer.byteLength(text), sha256: hash(text) });
    wireAssertions.push({ provider_file: captured.file, present: present.map(original), absent: absent.map(original) });
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
    rpc = await startRpc({ host: info.host, args, cwd: base, env, timeoutMs: 120000 });
    const a1 = sourceText(service.notion, owners.a), b1 = sourceText(service.notion, owners.b), c1 = sourceText(service.notion, owners.c);
    let records;
    if (name === 'default-view') {
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
    await snapshot('final-session'); await rpc.closeInput();
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
  } catch (error) { result.error = { message: error.message, stack: error.stack }; await save(join(out, 'result.json'), result); console.error(JSON.stringify({ status: 'failed', evidence: out, error: error.message })); process.exitCode = 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
