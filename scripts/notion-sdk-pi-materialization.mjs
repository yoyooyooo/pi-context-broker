import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedEnv, resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { renderHttpWrapper, startLoopbackMock } from './mock-provider-adapter.mjs';

// These cases are part of notion-sdk-pi, with the same installed artifact and
// actual Pi provider serializer. There is no alternate test runner or mock SDK.
export const materializationScenarios = Object.freeze([
  'source-materialize-legacy', 'source-materialize-first',
  'source-materialize-legacy-source', 'source-materialize-growth',
  'source-materialize-native-root',
]);
const initialFor = name => ({
  'source-materialize-legacy': 'legacy-members', 'source-materialize-first': 'source-only',
  'source-materialize-legacy-source': 'legacy-source', 'source-materialize-growth': 'manifest-growth',
  'source-materialize-native-root': 'native-root',
})[name];
const hash = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const rows = async path => (await readFile(path, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return ''; throw error;
})).split('\n').filter(Boolean).map(JSON.parse);
const shellQuote = text => "'" + text.replaceAll("'", "'\\''") + "'";
const fieldText = (row, binding, key) => {
  const value = Object.values(row.properties).find(field => field.id === binding.property_ids[key]);
  return (value?.rich_text ?? []).map(part => part.plain_text ?? part.text?.content ?? '').join('');
};
const management = events => events.filter(row => row.kind === 'context-broker.notion-materialization');
const consumeValues = (events, pid) => events.filter(row => row.kind === 'context-broker.notion-sdk-result'
  && row.operation === 'consume' && row.observer_pid === pid && row.value?.status === 'ready');

async function actualCredentialScope(stateRoot) {
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(stateRoot, 'state.sqlite'), database = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(database.prepare('PRAGMA application_id').get().application_id, 0x4e544e43);
    const identities = database.prepare('SELECT id,scope FROM identities ORDER BY id').all();
    assert.equal(identities.length, 1, 'Each independent Store must have its own actually authenticated credential binding');
    assert.match(identities[0].scope, /^[a-f0-9]{64}$/);
    return { path, identities, scope: identities[0].scope };
  } finally { database.close(); }
}

/** This is the manager's immutable installed-file inventory, not a content cache. */
async function generationInventory(root) {
  const files = [];
  const visit = async name => {
    const path = join(root, name), info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = relative(root, await realpath(path));
      assert.ok(target && target !== '..' && !target.startsWith('../') && !isAbsolute(target), 'Manager installation link escapes its owned package');
      files.push({ path: name, link: await readlink(path) });
    } else if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await visit(name ? name + '/' + child : child);
    } else { assert.equal(info.isFile(), true); files.push({ path: name, sha256: hash(await readFile(path)), executable: Boolean(info.mode & 0o111) }); }
  };
  await visit('');
  return { files, sha256: hash(JSON.stringify(files)) };
}

async function controlledManager(base, info, facts, origin, fixture) {
  const manager = join(base, 'manager'); await mkdir(manager, { mode: 0o700 });
  const roots = { home: join(manager, 'state'), config_home: join(manager, 'config'), cache_home: join(manager, 'cache') };
  const scheduler = join(manager, 'scheduler');
  for (const path of [...Object.values(roots), scheduler]) await mkdir(path, { mode: 0o700 });
  const library = facts.sample.notion.library.library_id;
  const env = isolatedEnv({ base: manager, agentDir: join(manager, 'unused-agent'),
    NTN_SKILLS_HOME: roots.home, NTN_SKILLS_CONFIG_HOME: roots.config_home, NTN_SKILLS_CACHE_HOME: roots.cache_home,
    NTN_SKILLS_SCHEDULER_ROOT: scheduler });
  const sdk = await import(pathToFileURL(join(info.packageRoot, 'dist/ntn-skills-sdk.mjs')).href);
  const metrics = [];
  assert.equal(await sdk.selectLibrary({ library, cwd: manager, env, metrics: true, onRequestMetrics: value => metrics.push(value) }), library);
  assert.ok((await lstat(join(roots.home, 'state.sqlite'))).size > 0, 'Initialize the original manager Store through the actual SDK');
  assert.equal(metrics.length, 1); assert.equal(metrics[0]?.total_requests, 0);
  const tools = await fixture.stageSdkManagerTools(join(manager, 'tools'), {
    node: process.execPath, git: (await resolveHost('git')).identity,
  });
  const runtime = tools.node.path, git = tools.git.path;
  const inventory = await generationInventory(info.packageRoot);
  const credentials = join(manager, 'credentials.json'), configPath = join(manager, 'server.json');
  const managerToken = 'current-sdk-controlled-manager-token';
  assert.notEqual(managerToken, info.fixtureEnv.NOTION_API_TOKEN);
  await save(credentials, { NOTION_API_TOKEN: managerToken });
  const config = { version: 2, host: { name: 'mini', hostname: hostname() }, library, sources: [facts.source_id], projection: 'none',
    store: roots, request_scheduler_root: scheduler, notion_api_origin: origin,
    generation: { root: info.packageRoot, inventory_sha256: inventory.sha256, cli_entry: 'dist/ntn-skills.mjs',
      runtime, runtime_sha256: hash(await readFile(runtime)) },
    git: { executable: git, sha256: hash(await readFile(git)), http_proxy: '' },
    credentials: { path: credentials, notion_token_sha256: hash(managerToken) }, artifacts: {},
    budgets: { changed: { max_requests: 2000, max_bytes: 67108864, timeout_ms: 180000 }, full: { max_requests: 2000, max_bytes: 67108864, timeout_ms: 180000 } } };
  await save(configPath, config);
  const launcher = join(manager, 'launch'), pids = join(manager, 'accepted-pids.txt');
  const script = '#!/bin/sh\n' + 'printf \'%s\\n\' "$$" >> ' + shellQuote(pids) + '\n'
    + 'exec ' + [runtime, join(info.packageRoot, config.generation.cli_entry), 'ctl', 'library', 'source', 'manager', '--config', configPath].map(shellQuote).join(' ') + '\n';
  await writeFile(launcher, script, { flag: 'wx', mode: 0o700 });
  const binding = { version: 1, kind: 'local', library, execution_id: inventory.sha256, command: launcher };
  await save(join(manager, 'identity.json'), { binding, config, inventory, tool_selection: tools, initialization: { sdk_module: join(info.packageRoot, 'dist/ntn-skills-sdk.mjs'), metrics }, launcher_sha256: hash(script) });
  return { binding, manager, roots, pids };
}

export function assertMaterializedFacts(facts, after) {
  const library = after.library, old = facts.sample.notion;
  const source = after.sources.find(row => row.id === facts.source_page_id); assert.ok(source);
  const content = JSON.parse(fieldText(source, library.sources, 'Content'));
  const contributions = JSON.parse(fieldText(source, library.sources, 'Contributions'));
  const revision = fieldText(source, library.sources, 'Last Revision');
  assert.equal(content.version, 1); assert.equal(content.plan.kind, 'composition');
  assert.equal(content.plan.base.source.commit, facts.sample.source_materialization.commit, 'Materialization followed a newer upstream HEAD');
  assert.equal(content.plan.base.source.tree, facts.sample.source_materialization.tree);
  assert.match(revision, /^[a-f0-9]{64}$/);
  const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  assert.equal(hash(canonical(content.plan)), revision);
  const isGrowth = facts.initial === 'manifest-growth', noRow = facts.initial === 'source-only';
  const selected = isGrowth ? [facts.members[1]] : noRow ? [facts.members[0]] : facts.members.slice(0, 2);
  const preserved = noRow ? [] : isGrowth ? [facts.members[0]] : [];
  for (const member of [...selected, ...preserved]) {
    const declared = contributions.filter(row => row.member_key === member.member_key); assert.equal(declared.length, 1);
    if (!noRow && !(isGrowth && member === facts.members[1])) assert.equal(declared[0].skill_id, member.legacy_skill_id);
    const owners = after.skills.filter(row => fieldText(row, library.skills, 'Skill ID') === declared[0].skill_id); assert.equal(owners.length, 1);
    const owner = owners[0], descriptor = JSON.parse(fieldText(owner, library.skills, 'Content'));
    assert.equal(descriptor.kind, 'source'); assert.equal(descriptor.source_id, facts.source_id); assert.equal(descriptor.revision, revision);
    assert.equal(descriptor.source_path, member.member_key + '/SKILL.md');
    const original = member.files.find(file => file.path === 'SKILL.md');
    assert.equal(descriptor.sha256, original.sha256); assert.equal(descriptor.bytes, original.bytes); assert.equal(descriptor.mode, original.mode);
    if (!noRow && !(isGrowth && member === facts.members[1])) {
      assert.equal(owner.id, member.legacy_page_id);
      assert.equal(fieldText(owner, library.skills, 'Main File ID'), member.legacy_main_file_id);
      const previous = old.skills.find(row => row.id === owner.id);
      for (const key of ['Enabled', 'Default Context', 'Requires', 'Members']) {
        const propertyId = library.skills.property_ids[key];
        const get = row => Object.values(row.properties).find(value => value.id === propertyId);
        assert.deepEqual(get(owner), get(previous), 'Materialization changed the manual field ' + key);
      }
    }
  }
  for (const previous of facts.contributions) assert.ok(contributions.some(row => canonical(row) === canonical(previous)), 'Declared legacy contribution disappeared');
  const oldSource = old.sources.find(row => row.id === facts.source_page_id); assert.ok(oldSource);
  const oldContent = fieldText(oldSource, library.sources, 'Content');
  const previousFiles = oldContent ? JSON.parse(oldContent).plan.base.source.files : [];
  for (const previous of previousFiles) {
    const actual = content.plan.base.source.files.find(file => file.path === previous.path);
    assert.deepEqual(actual, previous, 'Existing source manifest entry changed at the same accepted commit');
  }
  if (isGrowth) {
    assert.notEqual(revision, facts.revision);
    assert.ok(content.plan.base.source.files.length > facts.plan.base.source.files.length);
  }
  const sibling = after.skills.find(row => row.id === facts.members[2].legacy_page_id) ?? null;
  assert.deepEqual(sibling, facts.expected.untouched_sibling, 'An unrequested sibling was initialized, enabled or edited');
  const newRows = after.skills.filter(row => !old.skills.some(previous => previous.id === row.id));
  assert.equal(newRows.length, noRow || isGrowth ? 1 : 0);
  const oldNative = old.skills.filter(row => !facts.members.some(member => member.legacy_page_id === row.id));
  for (const previous of oldNative) assert.deepEqual(after.skills.find(row => row.id === previous.id), previous, 'Native authoring authority changed');
  for (const [id, body] of Object.entries(old.bodies)) assert.equal(after.bodies[id], body, 'Reading projection changed');
  for (const [id, body] of Object.entries(after.bodies)) if (!Object.hasOwn(old.bodies, id)) assert.equal(body, '', 'A new generated reading body was written');
  return { revision, contribution_count: contributions.length, source_file_count: content.plan.base.source.files.length,
    requested_member_keys: selected.map(member => member.member_key), created_skills: newRows.map(row => row.id) };
}

export async function runMaterializationScenario(name, info, out, helpers) {
  const base = join(out, name); await mkdir(base, { mode: 0o700 });
  const fixture = await import(pathToFileURL(info.helper).href);
  assert.equal(typeof fixture.startSdkGitFixture, 'function'); assert.equal(typeof fixture.materializationServiceFacts, 'function');
  assert.equal(typeof fixture.stageSdkManagerTools, 'function');
  const gitCommand = await resolveHost('git'), upstream = info.fixture.source_materialization;
  const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const observedHead = await helpers.runCommand(gitCommand.file, [...gitCommand.prefix, '-C', upstream.repository, 'rev-parse', 'HEAD'], { cwd: base, env: gitEnv });
  const observedFuture = await helpers.runCommand(gitCommand.file, [...gitCommand.prefix, '-C', upstream.repository, 'show', upstream.head_commit + ':' + upstream.members[0].member_key + '/SKILL.md'], { cwd: base, env: gitEnv });
  assert.equal(observedHead.stdout.trim(), upstream.head_commit); assert.notEqual(upstream.head_commit, upstream.commit);
  assert.equal(observedFuture.stdout, upstream.unaccepted_root.content);
  assert.notEqual(observedFuture.stdout, upstream.members[0].files.find(file => file.path === 'SKILL.md').content);
  await save(join(base, 'upstream-head.json'), { accepted_commit: upstream.commit, observed_head: observedHead, future_root: observedFuture });
  const git = await fixture.startSdkGitFixture(info.fixture.source_materialization.repository, join(base, 'git-http.jsonl'));
  let service, provider, rpc, failure;
  const wire = [], proofs = [], steps = [], processes = [];
  const facts = fixture.materializationServiceFacts(info.fixture, git.url, initialFor(name));
  const present = facts.native_root ? [facts.native_root.content, facts.expected.root, facts.expected.required] : facts.initial === 'manifest-growth' ? [facts.expected.required]
    : facts.initial === 'source-only' ? [facts.expected.root] : [facts.expected.root, facts.expected.required];
  const absent = [facts.expected.sibling, '# Old generated reading projection\n\nThis is not the original Skill.\n',
    info.fixture.source_materialization.unaccepted_root.content,
    ...(facts.initial === 'manifest-growth' ? [facts.expected.root] : facts.initial === 'source-only' ? [facts.expected.required] : [])];
  const alias = facts.native_root?.alias ?? (facts.initial === 'manifest-growth' ? facts.members[1].name : facts.members[0].name);
  await save(join(base, 'source-facts.json'), facts);
  let plan = { mode: 'complete' };
  const checkWire = body => {
    helpers.assertWireSources(body, present, absent);
    const captured = wire.find(item => item.body === body); assert.ok(captured);
    const original = text => ({ text, bytes: Buffer.byteLength(text), sha256: hash(text) });
    const proof = { provider_file: captured.file, present: present.map(original), absent: absent.map(original) };
    proofs.push(proof); return proof.provider_file;
  };
  const step = async (label, action) => {
    const started = Date.now(), before = wire.length;
    try {
      const result = await action(); steps.push({ label, status: 'passed', elapsed_ms: Date.now() - started, provider_requests: wire.slice(before).map(item => item.file) });
      await save(join(base, 'steps.json'), steps); return result;
    } catch (error) { steps.push({ label, status: 'failed', elapsed_ms: Date.now() - started, error: error.message }); await save(join(base, 'steps.json'), steps); throw error; }
  };
  try {
    service = await fixture.startSdkSourceFixture(facts.sample, join(base, 'source-http.jsonl'), { allowCurrentWrites: true, forbidProjectionWrites: true });
    provider = await startLoopbackMock({ selectCall: context => helpers.selectProviderCall(context, plan), limits: { maxRequests: 60 },
      onBody: async (record, bytes) => {
        const file = 'provider-' + String(wire.length + 1).padStart(3, '0') + '.json'; await writeFile(join(base, file), bytes, { mode: 0o600 });
        wire.push({ file, sha256: hash(bytes), body: JSON.parse(bytes), record });
      } });
    const manager = await controlledManager(base, info, facts, service.origin, fixture);
    const control = join(base, 'control.json'), providerExtension = join(base, 'provider.mjs'), observerExtension = join(base, 'lifecycle.mjs'), preload = join(base, 'observer.mjs');
    await save(control, { action: 'none' });
    await writeFile(providerExtension, renderHttpWrapper({ helperUrl: new URL('./mock-provider-adapter.mjs', import.meta.url).href, serializerUrl: pathToFileURL(info.identity.serializer.serializer.path).href }));
    await writeFile(observerExtension, "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';\nexport default " + helpers.lifecycleObserver.toString() + '\n');
    await writeFile(preload, `import { channel } from 'node:diagnostics_channel';
import { appendFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const active = new Set();
const emit = (kind, event) => appendFileSync(process.env.CURRENT_SDK_EVENTS, JSON.stringify({kind,observer_pid:process.pid,observer_monotonic_ns:process.hrtime.bigint().toString(),...event})+'\\n');
for(const topic of ['context-broker.notion-sdk','context-broker.notion-sdk-result','context-broker.notion-materialization'])
  channel(topic).subscribe(event=>{if(topic==='context-broker.notion-sdk'){if(event.event==='start')active.add(event.id);else if(event.event==='end')active.delete(event.id);}emit(topic,event);});
for(const api of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']){
  const original=childProcess[api];childProcess[api]=function(...args){emit('child_process',{api,command:String(args[0]).split('/').at(-1),active_sdk_ids:[...active]});return original.apply(this,args);};
}
syncBuiltinESMExports();
`);
    const createClient = async number => {
      const root = join(base, 'client-' + number), agentDir = join(root, 'agent'), sessions = join(root, 'sessions');
      await mkdir(join(agentDir, 'context-broker'), { recursive: true, mode: 0o700 }); await mkdir(sessions);
      const source = { type: 'notion', id: 'current-sdk', namespace: 'current-sdk', library: facts.sample.notion.library.library_id,
        discovery: { maxAge: '5m' }, activation: { maxAge: '5m' }, cacheDir: join(root, 'broker-cache'), prefetch: false };
      const config = join(agentDir, 'context-broker/config.yml');
      await save(config, { sources: [source] });
      await save(join(agentDir, 'settings.json'), { compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } });
      const env = isolatedEnv({ base: root, agentDir, PATH: [dirname(process.execPath), dirname(gitCommand.identity), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
        NOTION_API_TOKEN: info.fixtureEnv.NOTION_API_TOKEN, NOTION_API_BASE_URL: service.origin,
        NTN_SKILLS_NOTION_INTERVAL_MS: '100', NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000',
        CONTEXT_BROKER_HOST: 'pi', CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_LOG_FILE: join(root, 'decisions.jsonl'),
        CURRENT_SDK_EVENTS: join(base, 'sdk.jsonl'), CURRENT_NATIVE_EVENTS: join(base, 'native.jsonl'), CURRENT_CONTROL: control,
        BROKER_E2E_PROCESS_LEDGER: join(base, 'processes.jsonl'), NODE_OPTIONS: '--import=' + preload, CTX_MOCK_PROVIDER_BASE_URL: provider.baseUrl });
      await mkdir(env.NTN_SKILLS_CONFIG_HOME, { recursive: true, mode: 0o700 });
      await save(join(env.NTN_SKILLS_CONFIG_HOME, 'config.json'), { default_library: source.library });
      await save(join(env.NTN_SKILLS_CONFIG_HOME, 'source-manager.json'), manager.binding);
      const empty = {};
      for (const path of [env.NTN_SKILLS_HOME, env.NTN_SKILLS_CACHE_HOME, source.cacheDir]) {
        try { await lstat(path); assert.fail('A fresh client already contains state: ' + path); }
        catch (error) { if (error.code !== 'ENOENT') throw error; empty[path] = 'absent'; }
      }
      const args = ['--no-extensions', '--no-skills', '--no-mcp', '--session-dir', sessions, '--tools', 'read,notion_list,notion_use,notion_ctl',
        '-e', providerExtension, '-e', observerExtension, '-e', join(info.packageRoot, 'src/index.ts'), '--model', 'context-broker-e2e/fake'];
      await save(join(root, 'launch.json'), { host: info.host, args, cwd: root, source, empty_consumer_roots: empty,
        consumer_credential_sha256: hash(info.fixtureEnv.NOTION_API_TOKEN),
        manager_binding: manager.binding, isolation: { home: env.HOME, state: env.NTN_SKILLS_HOME, cache: env.NTN_SKILLS_CACHE_HOME, broker: source.cacheDir }, copied_consumer_state: false });
      return { root, source, env, args };
    };
    const snapshot = async label => {
      const output = join(base, label + '.json'); await save(control, { action: 'snapshot', output });
      await rpc.prompt('/current-fixture'); return JSON.parse(await readFile(output, 'utf8'));
    };
    const open = async (client, phase) => {
      service.setPhase(phase); git.setPhase(phase);
      rpc = await startRpc({ host: info.host, args: client.args, cwd: client.root, env: client.env, timeoutMs: 180000 });
      const initial = await snapshot(phase + '-empty-session');
      assert.equal(initial.branch.some(entry => entry.customType === 'context-broker-selected-graph' || entry.customType === 'context-broker-materialization'), false);
      const row = { phase, pid: rpc.lifecycle[0].pid, session_file: initial.session_file, client: client.root, source_begin: service.requests.length, git_begin: git.requests.length };
      processes.push(row); return row;
    };
    const finish = async phase => {
      const final = await snapshot(phase + '-final-session'); await rpc.closeInput();
      await save(join(base, phase + '-rpc.json'), rpc.frames); await save(join(base, phase + '-rpc-lifecycle.json'), rpc.lifecycle);
      const process = processes.find(row => row.phase === phase);
      process.source_end = service.requests.length; process.git_end = git.requests.length; process.completed_at_ms = Date.now();
      await save(join(base, 'process-boundaries.json'), processes); return final;
    };
    const first = await createClient(1);
    await open(first, 'discovery');
    await step('actual model discovery has no management authority or semantic writes', async () => {
      plan = { mode: 'call', call: { type: 'toolCall', id: 'readonly-discovery', name: 'notion_list', arguments: { query: alias, limit: 100 } } };
      await rpc.prompt('Find the named Skill without selecting it.');
      assert.equal(management(await rows(join(base, 'sdk.jsonl'))).length, 0);
      assert.equal(service.requests.some(row => row.semantic_write), false);
      assert.deepEqual(service.notion.skills, facts.sample.notion.skills);
    });
    // The first process now crosses a real input-receipt boundary.
    service.setPhase('materialize'); git.setPhase('materialize'); processes[0].phase = 'materialize';
    await step('literal dollar selection uses the fixed manager then publishes complete ordinary consumption', async () => {
      plan = { mode: 'complete' }; await rpc.prompt('$' + alias + ' Apply this Skill to the task.');
      processes[0].provider_file = checkWire(wire.at(-1).body);
      processes[0].facts = assertMaterializedFacts(facts, service.notion);
      assert.ok(service.requests.some(row => row.semantic_write), 'Cold materialization did not reach actual management HTTP');
      const events = await rows(join(base, 'sdk.jsonl'));
      const completed = management(events).filter(row => row.event === 'result' && ['ready', 'already_ready'].includes(row.status));
      assert.ok(completed.length >= 1 && completed.length <= (facts.native_root ? 2 : 1), 'Management must remain inside the exact input-authorized closure');
      assert.ok(completed.some(row => row.effects.remote_writes === 'management'));
      assert.ok(completed.every(row => ['none', 'management'].includes(row.effects.remote_writes) && row.effects.projection === 'none'));
      assert.ok(consumeValues(events, processes[0].pid).length > 0, 'Management receipt is not a consumption receipt');
    });
    const firstFinal = await finish('materialize');
    const initialManagement = management(await rows(join(base, 'sdk.jsonl'))).filter(row => row.event === 'result');
    const sessionManagement = firstFinal.branch.filter(entry => entry.customType === 'context-broker-materialization');
    assert.equal(sessionManagement.length, initialManagement.length);
    const credentialScopes = { manager: await actualCredentialScope(manager.roots.home), clients: [await actualCredentialScope(first.env.NTN_SKILLS_HOME)] };
    for (const entry of sessionManagement) {
      assert.equal(typeof entry.data?.scope, 'string'); assert.equal(typeof entry.data?.manager_scope, 'string');
      assert.notEqual(entry.data.scope, entry.data.manager_scope, 'Distinct manager and consumer credentials must retain distinct proven scopes');
      assert.equal(entry.data.scope, credentialScopes.clients[0].scope); assert.equal(entry.data.manager_scope, credentialScopes.manager.scope);
    }
    await save(join(base, 'after-materialization.json'), service.notion);
    const afterWrites = service.requests.filter(row => row.semantic_write).length;
    let warmQuery = alias, originalMemberCandidate;
    if (facts.initial === 'source-only') {
      originalMemberCandidate = (await rows(join(base, 'sdk.jsonl'))).filter(row => row.kind === 'context-broker.notion-sdk-result' && row.operation === 'source-members')
        .flatMap(row => row.value?.candidates ?? []).find(member => member.source_id === facts.source_id && member.member_key === facts.members[0].member_key);
      assert.ok(originalMemberCandidate); assert.equal(originalMemberCandidate.type, 'source_member');
      assert.equal(originalMemberCandidate.record, undefined, 'An unmaterialized candidate must not pretend to own a physical Skill');
      warmQuery = originalMemberCandidate.alias + '@' + encodeURIComponent('skill:' + originalMemberCandidate.expected_skill_id) + '@' + first.source.namespace;
    }
    const warm = await open(first, 'warm-restart');
    await step('a distinct Pi PID within five minutes reuses the existing local materialization and consumption cache', async () => {
      assert.notEqual(warm.pid, processes[0].pid); assert.notEqual(warm.session_file, processes[0].session_file);
      assert.ok(Date.now() - processes[0].completed_at_ms < 300000);
      plan = { mode: 'complete' }; await rpc.prompt('$' + warmQuery + ' Apply this Skill in the fresh session.');
      warm.provider_file = checkWire(wire.at(-1).body);
    });
    await finish('warm-restart');
    assert.equal(service.requests.filter(row => row.phase === 'warm-restart').length, 0, 'The five-minute new Pi process issued Notion HTTP');
    assert.equal(git.requests.filter(row => row.phase === 'warm-restart').length, 0, 'The five-minute new Pi process fetched Git');
    const warmEvents = await rows(join(base, 'sdk.jsonl'));
    assert.equal(management(warmEvents).filter(row => row.observer_pid === warm.pid).length, 0);
    assert.equal(warmEvents.filter(row => row.observer_pid === warm.pid && row.operation === 'source-members').length, 0);
    const second = await createClient(2), fresh = await open(second, 'independent-client');
    await step('an independent empty client consumes the persisted Notion records with no repair writes', async () => {
      plan = { mode: 'complete' }; await rpc.prompt('$' + alias + ' Apply this Skill from the independent client.');
      fresh.provider_file = checkWire(wire.at(-1).body);
      assert.deepEqual(assertMaterializedFacts(facts, service.notion), processes[0].facts);
    });
    await finish('independent-client');
    credentialScopes.clients.push(await actualCredentialScope(second.env.NTN_SKILLS_HOME));
    assert.equal(credentialScopes.clients[1].scope, credentialScopes.clients[0].scope);
    assert.notEqual(credentialScopes.clients[0].scope, credentialScopes.manager.scope);
    await save(join(base, 'credential-scopes.json'), credentialScopes);
    assert.equal(service.requests.filter(row => row.semantic_write).length, afterWrites);
    assert.ok(service.requests.some(row => row.phase === 'independent-client'), 'An independent client must obtain its own remote facts');
    assert.ok(git.requests.some(row => row.phase === 'independent-client'), 'An independent client must obtain its own Git originals');
    assert.deepEqual(service.unexpected, []); assert.deepEqual(git.unexpected, []);
    assert.equal(service.requests.some(row => row.projection_write), false);
    const events = await rows(join(base, 'sdk.jsonl'));
    for (const process of processes) {
      const values = consumeValues(events, process.pid); assert.ok(values.length > 0);
      for (const value of values) assert.equal(value.value.effects?.remote_writes, 'none', 'Consumption effects must remain separate from management');
    }
    const managerPids = (await readFile(manager.pids, 'utf8')).trim().split('\n').map(Number); assert.ok(managerPids.every(pid => Number.isSafeInteger(pid) && pid > 0));
    const managerProcesses = managerPids.map(pid => { let alive = true; try { process.kill(pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; } return { pid, observed_exit: !alive }; });
    assert.ok(managerProcesses.every(row => row.observed_exit), 'Owned manager work is still active; do not erase its Store');
    const receipt = { version: 1, initial: facts.initial, max_age_ms: 300000, alias, warm_query: warmQuery, original_member_candidate: originalMemberCandidate, processes,
      manager_processes: managerProcesses, management_operations: initialManagement.length, semantic_writes: afterWrites, projection_writes: 0, copied_consumer_state: false, source_id: facts.source_id };
    await save(join(base, 'materialization.json'), receipt);
    await save(join(base, 'after-independent-client.json'), service.notion);
    return { name, status: 'passed', evidence: base, steps, provider_requests: wire.length, source_requests: service.requests.length,
      semantic_writes: afterWrites, projection_writes: 0, sdk_operations: events.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'end').length };
  } catch (error) { failure = error; throw error; }
  finally {
    if (rpc) {
      if (!rpc.lifecycle.some(row => row.event === 'close')) await rpc.stop().catch(error => { failure ??= error; });
      await save(join(base, 'rpc.json'), rpc.frames); await save(join(base, 'rpc-lifecycle.json'), rpc.lifecycle);
    }
    if (provider) await provider.close(); if (service) await service.close(); await git.close();
    await save(join(base, 'wire-source-assertions.json'), proofs);
    await save(join(base, 'provider-index.json'), wire.map(({ file, sha256, record }) => ({ file, sha256, ...record })));
    await save(join(base, 'scenario.json'), { name, status: failure ? 'failed' : 'passed', steps, ...(failure ? { error: failure.message, stack: failure.stack } : {}) });
  }
}

export async function verifyMaterializationEvidence({ base, entry, source, events, proofs }) {
  const receipt = JSON.parse(await readFile(join(base, 'materialization.json'), 'utf8'));
  const facts = JSON.parse(await readFile(join(base, 'source-facts.json'), 'utf8'));
  const upstreamHead = JSON.parse(await readFile(join(base, 'upstream-head.json'), 'utf8'));
  assert.equal(upstreamHead.accepted_commit, facts.sample.source_materialization.commit);
  assert.equal(upstreamHead.observed_head.code, 0); assert.equal(upstreamHead.future_root.code, 0);
  assert.equal(upstreamHead.observed_head.stdout.trim(), facts.sample.source_materialization.head_commit);
  assert.notEqual(upstreamHead.accepted_commit, upstreamHead.observed_head.stdout.trim());
  assert.equal(upstreamHead.future_root.stdout, facts.sample.source_materialization.unaccepted_root.content);
  assert.equal(hash(upstreamHead.future_root.stdout), facts.sample.source_materialization.unaccepted_root.sha256);
  assert.equal(receipt.version, 1); assert.equal(receipt.initial, initialFor(entry.name)); assert.equal(receipt.max_age_ms, 300000);
  assert.equal(receipt.copied_consumer_state, false); assert.equal(receipt.projection_writes, 0);
  const git = await rows(join(base, 'git-http.jsonl'));
  assert.ok(git.length > 0 && git.every(row => row.exit_code === 0 && row.status === 200));
  assert.equal(source.some(row => row.projection_write), false);
  assert.equal(source.filter(row => row.semantic_write).length, receipt.semantic_writes); assert.ok(receipt.semantic_writes > 0);
  assert.ok(source.filter(row => row.semantic_write).every(row => row.phase === 'materialize'), 'A later consumer performed semantic writes');
  assert.equal(source.filter(row => row.phase === 'warm-restart').length, 0); assert.equal(git.filter(row => row.phase === 'warm-restart').length, 0);
  assert.ok(source.some(row => row.phase === 'independent-client')); assert.ok(git.some(row => row.phase === 'independent-client'));
  assert.deepEqual(receipt.processes.map(row => row.phase), ['materialize', 'warm-restart', 'independent-client']);
  assert.equal(new Set(receipt.processes.map(row => row.pid)).size, 3);
  assert.equal(new Set(receipt.processes.map(row => row.session_file)).size, 3);
  assert.equal(receipt.processes[0].client, receipt.processes[1].client);
  assert.notEqual(receipt.processes[0].client, receipt.processes[2].client);
  if (facts.initial === 'source-only') {
    assert.equal(receipt.original_member_candidate.type, 'source_member'); assert.equal(receipt.original_member_candidate.record, undefined);
    assert.equal(receipt.warm_query, receipt.original_member_candidate.alias + '@' + encodeURIComponent('skill:' + receipt.original_member_candidate.expected_skill_id) + '@current-sdk');
    const warm = JSON.parse(await readFile(join(base, 'warm-restart-final-session.json'), 'utf8'));
    assert.ok(JSON.stringify(warm.branch).includes('$' + receipt.warm_query), 'The new process did not use the exact original Source candidate token');
  }
  const manager = JSON.parse(await readFile(join(base, 'manager/identity.json'), 'utf8'));
  assert.equal(manager.tool_selection.version, 1);
  assert.equal(manager.tool_selection.root, join(base, 'manager/tools'));
  for (const role of ['node', 'git']) {
    const selected = manager.tool_selection[role];
    assert.equal(selected.path, join(manager.tool_selection.root, role));
    assert.notEqual(selected.source, selected.path);
    assert.equal(selected.source_sha256, selected.sha256);
    assert.equal(hash(await readFile(selected.path)), selected.sha256);
    assert.equal(selected.uid, process.getuid()); assert.equal(selected.mode, 0o500);
  }
  assert.equal(manager.config.generation.runtime, manager.tool_selection.node.path);
  assert.equal(manager.config.generation.runtime_sha256, manager.tool_selection.node.sha256);
  assert.equal(manager.config.git.executable, manager.tool_selection.git.path);
  assert.equal(manager.config.git.sha256, manager.tool_selection.git.sha256);
  const credentialScopes = JSON.parse(await readFile(join(base, 'credential-scopes.json'), 'utf8'));
  assert.notEqual(credentialScopes.manager.scope, credentialScopes.clients[0].scope);
  assert.equal(credentialScopes.clients[0].scope, credentialScopes.clients[1].scope);
  assert.notEqual(credentialScopes.clients[0].path, credentialScopes.clients[1].path);
  assert.equal(manager.binding.kind, 'local'); assert.equal(manager.config.projection, 'none'); assert.equal(manager.config.notion_api_origin.startsWith('http://127.0.0.1:'), true);
  const clients = await Promise.all([1, 2].map(async n => JSON.parse(await readFile(join(base, 'client-' + n + '/launch.json'), 'utf8'))));
  for (const client of clients) {
    assert.equal(client.copied_consumer_state, false); assert.deepEqual(client.manager_binding, manager.binding);
    assert.notEqual(client.consumer_credential_sha256, manager.config.credentials.notion_token_sha256);
    assert.equal(client.source.discovery.maxAge, '5m'); assert.equal(client.source.activation.maxAge, '5m');
    assert.equal(Object.keys(client.empty_consumer_roots).length, 3);
    assert.ok(Object.values(client.empty_consumer_roots).every(value => value === 'absent'));
  }
  for (const key of Object.keys(clients[0].isolation)) assert.notEqual(clients[0].isolation[key], clients[1].isolation[key]);
  let previousExit;
  for (const process of receipt.processes) {
    const initial = JSON.parse(await readFile(join(base, (process.phase === 'materialize' ? 'discovery' : process.phase) + '-empty-session.json'), 'utf8'));
    assert.equal(initial.session_file, process.session_file);
    assert.equal(initial.branch.some(row => row.customType === 'context-broker-selected-graph' || row.customType === 'context-broker-materialization'), false);
    const lifecycle = JSON.parse(await readFile(join(base, process.phase + '-rpc-lifecycle.json'), 'utf8'));
    assert.equal(lifecycle[0].event, 'spawn'); assert.equal(lifecycle[0].pid, process.pid);
    const exit = lifecycle.at(-1); assert.equal(exit.event, 'close'); assert.equal(exit.code, 0); assert.equal(exit.signal, null);
    if (previousExit !== undefined) assert.ok(BigInt(lifecycle[0].monotonicNs) >= previousExit);
    previousExit = BigInt(exit.monotonicNs);
    if (process.phase === 'warm-restart') {
      const cold = JSON.parse(await readFile(join(base, 'materialize-rpc-lifecycle.json'), 'utf8'));
      assert.ok(BigInt(lifecycle[0].monotonicNs) - BigInt(cold.at(-1).monotonicNs) < 300000000000n);
    }
    const proof = proofs.filter(row => row.provider_file === process.provider_file); assert.equal(proof.length, 1);
    const expected = facts.native_root ? [facts.native_root.content, facts.expected.root, facts.expected.required] : facts.initial === 'manifest-growth' ? [facts.expected.required]
      : facts.initial === 'source-only' ? [facts.expected.root] : [facts.expected.root, facts.expected.required];
    assert.deepEqual(proof[0].present.map(row => row.text), expected); assert.ok(proof[0].absent.some(row => row.text === facts.expected.sibling));
    assert.ok(proof[0].absent.some(row => row.text === facts.sample.source_materialization.unaccepted_root.content));
    const values = consumeValues(events, process.pid); assert.ok(values.length > 0);
    for (const value of values) {
      assert.equal(value.value.effects?.remote_writes, 'none');
      assert.equal(value.value.preparation.nodes.filter(node => node.state === 'prepared').length, expected.length);
      const end = events.find(row => row.kind === 'context-broker.notion-sdk' && row.event === 'end' && row.id === value.id);
      assert.equal(end?.status, 'completed'); assert.equal(end?.request_metrics?.requests?.notion_write, 0);
    }
    if (process.phase === 'warm-restart') {
      assert.equal(management(events).filter(row => row.observer_pid === process.pid).length, 0);
      assert.equal(events.filter(row => row.observer_pid === process.pid && row.operation === 'source-members').length, 0);
      assert.ok(values.at(-1).value.preparation.nodes.every(node => node.state === 'prepared' && node.source === 'local_cache'
        && node.freshness.max_age_ms === 300000 && node.freshness.age_ms < 300000));
    }
  }
  const actions = management(events), starts = actions.filter(row => row.event === 'start'), results = actions.filter(row => row.event === 'result');
  assert.equal(starts.length, results.length); assert.equal(starts.length, receipt.management_operations);
  assert.ok(starts.length >= 1 && starts.length <= (facts.native_root ? 2 : 1));
  assert.deepEqual(starts.map(row => row.request_id).sort(), results.map(row => row.request_id).sort());
  assert.ok(results.every(row => row.phase === 'management' && ['none', 'management'].includes(row.effects.remote_writes) && row.effects.projection === 'none'));
  assert.ok(results.some(row => row.effects.remote_writes === 'management'));
  assert.ok(BigInt(events.find(row => row.kind === 'context-broker.notion-sdk' && row.event === 'start'
    && row.id === consumeValues(events, receipt.processes[0].pid).at(-1).id).observer_monotonic_ns) >= BigInt(results.at(-1).observer_monotonic_ns),
  'The ordinary successful consume must run after the accepted management receipt');
  assert.equal(events.filter(row => row.kind === 'child_process' && row.active_sdk_ids.length > 0
    && !['git'].includes(row.command)).length, 0, 'The consumer spawned a management CLI');
  const ready = JSON.parse(await readFile(join(base, 'after-materialization.json'), 'utf8'));
  const session = JSON.parse(await readFile(join(base, 'materialize-final-session.json'), 'utf8'));
  const sessionManagement = session.branch.filter(row => row.customType === 'context-broker-materialization');
  assert.equal(sessionManagement.length, starts.length);
  for (const row of sessionManagement) {
    assert.match(row.data.scope, /^[a-f0-9]{64}$/); assert.match(row.data.manager_scope, /^[a-f0-9]{64}$/);
    assert.notEqual(row.data.scope, row.data.manager_scope);
    assert.equal(row.data.scope, credentialScopes.clients[0].scope); assert.equal(row.data.manager_scope, credentialScopes.manager.scope);
    const consume = consumeValues(events, receipt.processes[0].pid).at(-1).value;
    assert.ok(consume.preparation.nodes.filter(node => node.state === 'prepared').every(node => node.binding.scope === row.data.scope));
  }
  assert.deepEqual(assertMaterializedFacts(facts, ready), receipt.processes[0].facts);
  assert.deepEqual(JSON.parse(await readFile(join(base, 'after-independent-client.json'), 'utf8')), ready);
  assert.ok(receipt.manager_processes.length > 0 && receipt.manager_processes.every(row => row.observed_exit === true));
}
