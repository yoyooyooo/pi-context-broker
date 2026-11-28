import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedEnv, resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { renderHttpWrapper, startLoopbackMock } from './mock-provider-adapter.mjs';
import { runColdMaterializationPrompt, assertColdMaterializationBudget } from './notion-sdk-pi-cold-materialization.mjs';
import { seedCacheUpgrade, readCacheUpgradeEvidence, assertCacheUpgradeEvidence } from './notion-sdk-pi-cache-upgrade.mjs';
import { blockedMaterializationScenario, blockedMaterializationFacts, runBlockedMaterialization, verifyBlockedMaterializationEvidence } from './notion-sdk-pi-blocked-materialization.mjs';

// These cases are part of notion-sdk-pi, with the same installed artifact and
// actual Pi provider serializer. There is no alternate test runner or mock SDK.
export const materializationScenarios = Object.freeze([
  'source-materialize-legacy', 'source-materialize-first',
  'source-materialize-legacy-source', 'source-materialize-growth',
  'source-materialize-native-root', 'source-materialize-cancel-late', 'source-materialize-cold-budget', 'source-materialize-cache-upgrade', blockedMaterializationScenario,
]);
const initialFor = name => ({
  'source-materialize-legacy': 'legacy-members', 'source-materialize-first': 'source-only',
  'source-materialize-legacy-source': 'legacy-source', 'source-materialize-growth': 'manifest-growth',
  'source-materialize-native-root': 'native-root', 'source-materialize-cancel-late': 'source-only',
  'source-materialize-cold-budget': 'legacy-source', 'source-materialize-cache-upgrade': 'legacy-source',
  [blockedMaterializationScenario]: 'source-only',
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
const localCollisionContent = alias => `# Local-only ${alias}\n\nThese filesystem instructions are distinct from the registered Notion Source member.\n`;
const localCollisionSkill = alias => `---\nname: ${alias}\ndescription: Same-name local selection fixture\n---\n\n${localCollisionContent(alias)}`;

/** The Source-only proof must actually include the local competitor it claims. */
export function assertSourceOnlyCollisionSelection({ alias, client, config, localBytes, session, phase }) {
  assert.ok(['materialize', 'independent-client'].includes(phase));
  const local = client.local_collision;
  assert.equal(local?.name, alias);
  assert.equal(local.path, join(client.cwd, 'local-skills', alias, 'SKILL.md'));
  assert.equal(local.content, localCollisionContent(alias));
  assert.ok(Buffer.isBuffer(localBytes));
  assert.equal(localBytes.toString('utf8'), localCollisionSkill(alias));
  assert.equal(local.bytes, localBytes.length); assert.equal(local.sha256, hash(localBytes));
  assert.equal(client.source.namespace, 'current-sdk');
  assert.deepEqual(config, { sources: [client.source], skillRoots: [dirname(local.path)], requireAutoload: false });
  const suffix = phase === 'materialize' ? ' Apply this Skill to the task.' : ' Apply this Skill from the independent client.';
  const expected = '$' + alias + '@' + client.source.namespace + suffix;
  const userTurns = session.branch.filter(row => row.type === 'message' && row.message?.role === 'user').map(row =>
    typeof row.message.content === 'string' ? row.message.content : row.message.content.filter(part => part.type === 'text').map(part => part.text).join(''));
  assert.ok(userTurns.includes(expected), 'The actual user input must select the Notion namespace despite the local collision');
}

/** Bind every positive management result to its own actual child close and whole stdout. */
export function assertPositiveManagerTransports({ base, binding, piPid, sourceId, managerScope, consumerScope,
  managerPids, events, sessionReceipts, outputs }) {
  assert.ok(managerPids.length > 0 && managerPids.every(pid => Number.isSafeInteger(pid) && pid > 0));
  assert.equal(new Set(managerPids).size, managerPids.length, 'Accepted manager PIDs must be unique');
  const transport = events.filter(row => row.kind === 'manager_transport');
  assert.ok(transport.every(row => ['spawn', 'close'].includes(row.event)), 'Manager observation failed');
  const spawns = transport.filter(row => row.event === 'spawn'), closes = transport.filter(row => row.event === 'close');
  const actions = management(events), starts = actions.filter(row => row.event === 'start'), results = actions.filter(row => row.event === 'result');
  assert.equal(actions.length, starts.length + results.length);
  for (const group of [spawns, closes, starts, results, sessionReceipts, outputs]) assert.equal(group.length, managerPids.length);
  assert.deepEqual(spawns.map(row => row.child_pid), managerPids);
  assert.equal(new Set(starts.map(row => row.request_id)).size, starts.length, 'A manager request must be observed exactly once');
  const one = (values, label) => { assert.equal(values.length, 1, label); return values[0]; };
  assert.ok(typeof sourceId === 'string' && sourceId.length > 0);
  const proofs = managerPids.map(pid => {
    const spawn = one(spawns.filter(row => row.child_pid === pid), 'Missing or duplicate manager spawn');
    const close = one(closes.filter(row => row.child_pid === pid), 'Missing or duplicate actual manager close');
    assert.equal(spawn.command, binding.command); assert.equal(spawn.observer_pid, piPid); assert.equal(close.observer_pid, piPid);
    assert.equal(close.code, 0, 'An actual successful manager exit is required'); assert.equal(close.signal, null);
    const originals = one(outputs.filter(row => row.pid === pid), 'Missing or duplicate original manager stdout/stderr');
    const output = originals.bytes, stderr = originals.stderr;
    assert.ok(Buffer.isBuffer(output)); assert.ok(output.length > 0 && output.length <= 1048576);
    assert.equal(close.output_file, join(base, 'manager-response-' + pid + '.json'));
    assert.equal(close.output_bytes, output.length); assert.equal(close.output_sha256, hash(output));
    assert.ok(Buffer.isBuffer(stderr)); assert.ok(stderr.length <= 1048576);
    assert.equal(close.stderr_file, join(base, 'manager-stderr-' + pid + '.txt'));
    assert.equal(close.stderr_bytes, stderr.length); assert.equal(close.stderr_sha256, hash(stderr));
    const envelope = JSON.parse(output.toString('utf8'));
    assert.equal(envelope.version, 1); assert.equal(envelope.ok, true);
    assert.equal(envelope.execution_id, binding.execution_id); assert.equal(envelope.library, binding.library);
    const start = one(starts.filter(row => row.request_id === envelope.request_id), 'Stdout belongs to another management request');
    const result = one(results.filter(row => row.request_id === envelope.request_id), 'Missing or duplicate SDK management result');
    const session = one(sessionReceipts.filter(row => row.request_id === envelope.request_id), 'Missing or duplicate session management receipt');
    assert.equal(session.source_id, sourceId);
    for (const event of [start, result]) {
      assert.equal(event.observer_pid, piPid); assert.equal(event.phase, 'management'); assert.equal(event.library, binding.library);
      assert.equal(event.source_id, sourceId);
    }
    assert.ok(BigInt(start.observer_monotonic_ns) <= BigInt(spawn.observer_monotonic_ns));
    assert.ok(BigInt(spawn.observer_monotonic_ns) < BigInt(close.observer_monotonic_ns));
    assert.ok(BigInt(close.observer_monotonic_ns) <= BigInt(result.observer_monotonic_ns), 'A late or unrelated close cannot prove this SDK result');
    const receipt = envelope.result;
    assert.equal(receipt.version, 1); assert.equal(receipt.request_id, envelope.request_id); assert.equal(receipt.library_id, binding.library);
    assert.ok(['ready', 'already_ready'].includes(receipt.status)); assert.equal(result.status, receipt.status);
    assert.equal(receipt.scope, managerScope); assert.equal(result.manager_scope, managerScope);
    assert.equal(session.manager_scope, managerScope); assert.equal(session.scope, consumerScope); assert.notEqual(managerScope, consumerScope);
    assert.equal(typeof session.input_receipt, 'string'); assert.ok(envelope.request_id.startsWith(session.input_receipt + ':'));
    for (const event of [start, result]) {
      assert.equal(event.registered_source_id, receipt.target.source_id); assert.equal(event.member_key, receipt.target.member_key);
      assert.deepEqual(event.authorization_root, receipt.authorization_root);
    }
    assert.equal(result.operation_id, receipt.operation_id); assert.deepEqual(result.effects, receipt.effects);
    assert.equal(receipt.effects.projection, 'none'); assert.ok(['none', 'management'].includes(receipt.effects.remote_writes));
    for (const key of ['request_id', 'operation_id', 'library_id', 'status', 'target', 'authorization_root', 'affected_skill_ids', 'source_revisions', 'effects'])
      assert.deepEqual(session[key], receipt[key], 'Original manager and session receipt differ: ' + key);
    return { pid, request_id: envelope.request_id, operation_id: receipt.operation_id ?? null, execution_id: envelope.execution_id,
      library_id: receipt.library_id, target: receipt.target, status: receipt.status, manager_scope: receipt.scope, close };
  });
  assert.equal(new Set(proofs.map(row => row.request_id)).size, proofs.length, 'A request receipt cannot be reused by another manager');
  assert.deepEqual(proofs.map(row => row.request_id).sort(), starts.map(row => row.request_id).sort(), 'Every original SDK request must have its own manager proof');
  return proofs;
}

async function positiveManagerTransports({ base, manager, events, sessionReceipts, credentialScopes, piPid, sourceId }) {
  const managerPids = (await readFile(join(base, 'manager/accepted-pids.txt'), 'utf8')).trim().split('\n').map(Number);
  assert.ok(managerPids.every(pid => Number.isSafeInteger(pid) && pid > 0));
  const outputs = await Promise.all(managerPids.map(async pid => ({ pid, bytes: await readFile(join(base, 'manager-response-' + pid + '.json')), stderr: await readFile(join(base, 'manager-stderr-' + pid + '.txt')) })));
  return assertPositiveManagerTransports({ base, binding: manager.binding, piPid, sourceId, managerScope: credentialScopes.manager.scope,
    consumerScope: credentialScopes.clients[0].scope, managerPids, events, sessionReceipts, outputs });
}

/** A use result prepares the exact Requires closure; other declared nodes remain metadata. */
export function assertWarmMaterializationGraph(value, cold, expected) {
  const sameIds = (actual, wanted, label) => {
    assert.ok(actual.every(id => typeof id === 'string' && id.length > 0), label);
    assert.equal(new Set(actual).size, actual.length, 'Duplicate identity: ' + label);
    assert.equal(new Set(wanted).size, wanted.length, 'Duplicate expected identity: ' + label);
    assert.deepEqual([...actual].sort(), [...wanted].sort(), label);
  };
  const edgeKeys = edges => edges.map(edge => JSON.stringify([edge.from, edge.to, edge.ref]));
  const metadataKeys = ['id', 'ref', 'kind', 'name', 'description', 'availability'];
  const metadata = entry => Object.fromEntries(metadataKeys.map(key => [key, entry[key]]));
  assert.equal(value.status, 'ready'); assert.equal(cold.status, 'ready');
  const plan = value.preparation, prior = cold.preparation;
  assert.equal(plan.status, 'ready'); assert.equal(plan.purpose, 'use');
  sameIds(plan.nodes.map(node => node.id), plan.nodes.map(node => node.id), 'node identities');
  const nodes = new Map(plan.nodes.map(node => [node.id, node])), roles = new Map(), closure = new Set();
  const addRole = (id, role) => { const current = roles.get(id) ?? new Set(); current.add(role); roles.set(id, current); };
  const roots = plan.roots.map(root => { assert.equal(root.readiness, 'ready'); addRole(root.id, 'root'); return root.id; });
  sameIds(roots, roots, 'root identities');
  const pending = [...roots];
  for (let i = 0; i < pending.length; i++) {
    const id = pending[i]; if (closure.has(id)) continue;
    const node = nodes.get(id); assert.equal(node?.state, 'prepared', 'Every selected root and Required must be prepared'); closure.add(id);
    for (const edge of plan.required.filter(edge => edge.from === id)) { addRole(edge.to, 'required'); pending.push(edge.to); }
  }
  const prepared = plan.nodes.filter(node => node.state === 'prepared'), ids = [...closure];
  sameIds(prepared.map(node => node.id), ids, 'prepared closure'); sameIds(plan.required_closure, ids, 'required_closure');
  sameIds(value.entries.map(entry => entry.id), ids, 'consume entries');
  sameIds(plan.session_bindings.map(binding => binding.record.id), ids, 'session bindings');
  sameIds(plan.graph_lock.bindings.map(binding => binding.record.id), ids, 'graph lock bindings');
  sameIds(plan.graph_lock.roots, roots, 'graph lock roots');
  assert.equal(plan.graph_lock.scope, plan.scope); assert.equal(plan.graph_lock.purpose, 'use');
  assert.equal(plan.usage.prepared_nodes, ids.length);
  sameIds(ids, expected.prepared.map(record => record.id), 'independent fixture closure');
  sameIds(roots, expected.root_ids, 'independent selected roots');
  const required = prepared.flatMap(node => node.required.map(child => {
    assert.equal(child.availability, 'available'); return { from: node.id, to: child.id, ref: child.ref };
  }));
  sameIds(edgeKeys(plan.required), edgeKeys(required), 'Required directories and edges');
  sameIds(edgeKeys(plan.graph_lock.required), edgeKeys(required), 'graph lock Required edges');
  const known = new Map();
  for (const node of prepared) {
    assert.equal(node.record.id, node.id); assert.equal(node.binding.record.id, node.id);
    const physical = expected.prepared.find(record => record.id === node.id);
    for (const record of [node.record, node.binding.record]) {
      assert.equal(record.locator.type, 'shared_skill'); assert.equal(record.locator.library_id, expected.library_id);
      assert.equal(record.locator.skill_id, physical.skill_id); assert.equal(record.locator.page_id, physical.page_id);
    }
    assert.equal(node.binding.scope, plan.scope); assert.equal(node.binding.body_sha256, node.body_sha256);
    for (const group of [plan.session_bindings, plan.graph_lock.bindings])
      assert.deepEqual(group.find(binding => binding.record.id === node.id), node.binding);
    const entry = value.entries.find(entry => entry.id === node.id);
    assert.deepEqual(entry.manifest.record, node.record); assert.equal(entry.manifest.scope, plan.scope);
    assert.equal(entry.manifest.snapshot_id, node.binding.snapshot_id); assert.equal(entry.manifest.version_id, node.binding.version_id);
    assert.equal(entry.source_body.sha256, node.body_sha256); assert.equal(entry.source_body.bytes, node.bytes);
    assert.equal(node.source, 'local_cache'); assert.equal(node.freshness.policy, 'max_age'); assert.equal(node.freshness.max_age_ms, 300000);
    assert.equal(node.freshness.stale, false);
    assert.ok(typeof node.freshness.age_ms === 'number' && Number.isFinite(node.freshness.age_ms)
      && node.freshness.age_ms >= 0 && node.freshness.age_ms < 300000);
    assert.ok(typeof node.freshness.validated_at === 'string' && Number.isFinite(Date.parse(node.freshness.validated_at)));
    const original = prior.nodes.find(candidate => candidate.id === node.id); assert.equal(original?.state, 'prepared');
    assert.deepEqual(node.binding, original.binding); assert.equal(node.body_sha256, original.body_sha256);
    assert.equal(node.content, original.content); assert.equal(node.bytes, original.bytes);
    assert.equal(node.freshness.validated_at, original.freshness.validated_at);
    for (const [role, directory] of [['member', node.candidates], ['reference', node.references]]) for (const child of directory) {
      addRole(child.id, role); if (closure.has(child.id)) continue;
      if (known.has(child.id)) assert.deepEqual(known.get(child.id), metadata(child));
      else known.set(child.id, metadata(child));
    }
  }
  sameIds(prior.nodes.filter(node => node.state === 'prepared').map(node => node.id), ids, 'cold closure');
  assert.equal(plan.graph_lock.sha256, prior.graph_lock.sha256);
  const metadataNodes = plan.nodes.filter(node => !closure.has(node.id));
  sameIds(metadataNodes.map(node => node.id), [...known.keys()], 'only declared metadata outside the closure');
  for (const node of metadataNodes) {
    assert.equal(node.state, 'known');
    assert.deepEqual(Object.keys(node).sort(), [...metadataKeys, 'roles', 'state'].sort(), 'Known metadata must not carry acquired content or bindings');
    assert.deepEqual(metadata(node), known.get(node.id));
  }
  for (const node of plan.nodes) sameIds(node.roles, [...(roles.get(node.id) ?? [])], 'exact roles for ' + node.id);
}

function materializationGraphExpectation(facts, after) {
  const library = after.library, source = after.sources.find(row => row.id === facts.source_page_id);
  const contributions = JSON.parse(fieldText(source, library.sources, 'Contributions'));
  const memberId = member => {
    const declared = contributions.filter(row => row.member_key === member.member_key); assert.equal(declared.length, 1);
    if (facts.initial !== 'source-only' && !(facts.initial === 'manifest-growth' && member === facts.members[1]))
      assert.equal(declared[0].skill_id, member.legacy_skill_id);
    return declared[0].skill_id;
  };
  const selected = facts.initial === 'manifest-growth' ? [facts.members[1]]
    : facts.initial === 'source-only' ? [facts.members[0]] : facts.members.slice(0, 2);
  const skillIds = selected.map(memberId);
  if (facts.native_root) skillIds.unshift(facts.native_root.skill_id);
  // The controlled facts use canonical UUIDs and the public Skill ID alphabet.
  assert.match(library.library_id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  const prepared = skillIds.map(skill_id => {
    assert.match(skill_id, /^[a-z0-9][a-z0-9._-]{0,199}$/);
    const owners = after.skills.filter(row => fieldText(row, library.skills, 'Skill ID') === skill_id); assert.equal(owners.length, 1);
    return { id: 'skill://' + skill_id + '?library=' + library.library_id, skill_id, page_id: owners[0].id };
  });
  return { library_id: library.library_id, root_ids: [prepared[0].id], prepared };
}

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

async function boundedObservation(promise, label, timeoutMs = 120000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Bounded observation expired: ' + label)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
async function waitForObservation(read, label) {
  const deadline = Date.now() + 120000;
  for (;;) {
    const value = await read(); if (value) return value;
    assert.ok(Date.now() < deadline, 'Bounded observation expired: ' + label);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
export async function readManagerState(path) {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(database.prepare('PRAGMA application_id').get().application_id, 0x4e544e43);
    return { identities: database.prepare('SELECT id,scope FROM identities ORDER BY id').all().map(row => ({ ...row })),
      rows: database.prepare("SELECT key,category,payload,retired FROM shared_local_records WHERE key LIKE 'operations/%' ORDER BY key").all()
        .map(row => ({ ...row, payload: JSON.parse(row.payload) })) };
  } finally { database.close(); }
}
async function captureManagerState(manager, base, label) {
  const original = await realpath(join(manager.roots.home, 'state.sqlite')), info = await stat(original);
  const value = await readManagerState(original), directory = join(base, 'manager-state-' + label);
  await mkdir(directory, { mode: 0o700 });
  for (const suffix of ['', '-wal', '-shm']) await copyFile(original + suffix, join(directory, 'state.sqlite') + suffix)
    .catch(error => { if (error.code !== 'ENOENT') throw error; });
  assert.deepEqual(await readManagerState(join(directory, 'state.sqlite')), value, 'The retained SQLite copy must reproduce the observed canonical rows');
  const receipt = { database: original, dev: info.dev, ino: info.ino, captured_monotonic_ns: process.hrtime.bigint().toString(), ...value };
  await save(join(directory, 'snapshot.json'), receipt); return receipt;
}
const sourcePending = value => value.rows.filter(row => row.key.startsWith('operations/current-write-pending/') && row.payload.intent?.owner?.kind === 'source');
const frozenRequests = value => value.rows.filter(row => row.key.startsWith('operations/current-source-materialization/'));

/** Assert causal raw boundaries; a timeout, a desired GET or a summary status cannot settle the writer. */
export function assertCancellationCausality({ points, held, cancelled, response, accepted, retained, settled }) {
  const names = ['accepted', 'abort-requested', 'abort-completed', 'session-replaced', 'release-requested', 'manager-completed', 'recovery-started', 'recovery-completed'];
  assert.deepEqual(points.map(row => row.event), names);
  for (let i = 1; i < points.length; i++) assert.ok(BigInt(points[i].monotonic_ns) > BigInt(points[i - 1].monotonic_ns));
  const point = name => BigInt(points.find(row => row.event === name).monotonic_ns);
  assert.equal(held.method, 'PATCH'); assert.equal(held.request_bytes_complete, true); assert.equal(held.response_bytes_complete, true);
  assert.equal(held.semantic_write, true); assert.equal(held.terminal, 'finished'); assert.equal(held.status, 200);
  assert.ok(BigInt(held.started_monotonic_ns) < point('accepted'));
  assert.ok(BigInt(held.ended_monotonic_ns) > point('release-requested'));
  assert.ok(BigInt(held.closed_monotonic_ns) < point('manager-completed'));
  assert.equal(cancelled.event, 'result'); assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.effects.remote_writes, 'unknown', 'Foreground cancellation is not proof of zero management writes');
  assert.ok(BigInt(cancelled.observer_monotonic_ns) >= point('abort-requested'));
  assert.ok(BigInt(cancelled.observer_monotonic_ns) < point('session-replaced'));
  assert.equal(response.close.code, 0); assert.equal(response.close.signal, null);
  assert.ok(BigInt(response.close.observer_monotonic_ns) > point('release-requested'));
  assert.equal(response.envelope.ok, true); assert.equal(response.envelope.request_id, cancelled.request_id);
  const receipt = response.envelope.result;
  assert.equal(receipt.request_id, cancelled.request_id); assert.equal(receipt.status, 'ready');
  assert.equal(receipt.effects.remote_writes, 'management'); assert.equal(receipt.effects.projection, 'none');
  const frozen = frozenRequests(accepted), pending = sourcePending(accepted);
  assert.equal(frozen.length, 1); assert.equal(pending.length, 1);
  assert.equal(frozen[0].payload.request.request_id, cancelled.request_id);
  assert.equal(pending[0].payload.intent.operation_id, receipt.operation_id);
  assert.ok(frozen[0].payload.plans.some(plan => plan.operation_id === receipt.operation_id));
  assert.equal(pending[0].payload.not_dispatched, undefined); assert.equal(pending[0].payload.settled_action, undefined);
  assert.deepEqual(retained.rows, accepted.rows, 'The original accepted intent must remain unchanged while its HTTP is held');
  assert.deepEqual(retained.identities, accepted.identities);
  assert.deepEqual(settled.rows, [], 'A successful response must agree with the original Store having no pending intents');
  for (const value of [retained, settled]) {
    assert.equal(value.database, accepted.database); assert.equal(value.dev, accepted.dev); assert.equal(value.ino, accepted.ino);
  }
}

export function assertNoCancellationPublication(snapshot, originals, assertWireSources) {
  assert.ok(Array.isArray(snapshot.branch));
  assert.equal(snapshot.branch.some(row => ['context-broker-selected-graph', 'context-broker-materialization'].includes(row.customType)), false);
  assertWireSources({ messages: snapshot.branch }, [], originals);
}

async function runCancellation({ name, base, info, facts, first, manager, service, git, wire, steps, processes, rpc,
  step, snapshot, finish, setPlan, checkWire, assertWireSources, present, absent }) {
  const points = [], mark = event => points.push({ event, monotonic_ns: process.hrtime.bigint().toString() });
  const allOriginals = [...new Set([...present, ...absent])];
  const noSelection = value => assertNoCancellationPublication(value, allOriginals, assertWireSources);
  const firstProcess = processes[0]; firstProcess.phase = 'cancel-late';
  service.setPhase('cancel-pending'); git.setPhase('cancel-pending');
  await captureManagerState(manager, base, 'before');
  const held = service.holdNext({ method: 'PATCH', path: '/v1/pages/' + facts.source_page_id,
    applyAfterDisconnect: true, matchBody: { path: ['properties', facts.sample.notion.library.sources.property_ids.Content], exists: true } });
  let accepted, retained, settled, arrived, cancelled, response, oldSession, replacement, outcome;
  const providerBoundary = wire.length;
  setPlan({ mode: 'complete' });
  const pending = rpc.prompt('$' + facts.members[0].name + ' Apply this Skill before cancellation.')
    .then(value => ({ status: 'completed', value }), error => ({ status: 'rejected', error: error.message }));
  try {
    await step('actual Pi abort cancels only its wait after the original fixed manager HTTP is accepted', async () => {
      arrived = await boundedObservation(Promise.race([held.reached, pending.then(value => {
        throw new Error('The original Pi request completed before the held manager HTTP: ' + JSON.stringify(value));
      })]), 'original Source PATCH');
      assert.ok(arrived); assert.equal(arrived.method, 'PATCH'); assert.equal(arrived.response_bytes_complete, false);
      await save(join(base, 'held-request-arrived.json'), arrived);
      accepted = await captureManagerState(manager, base, 'accepted');
      const starts = management(await rows(join(base, 'sdk.jsonl'))).filter(row => row.event === 'start');
      assert.equal(starts.length, 1); assert.equal(frozenRequests(accepted)[0]?.payload.request.request_id, starts[0].request_id);
      mark('accepted'); mark('abort-requested');
      const abort = await rpc.command('abort'); outcome = await boundedObservation(pending, 'cancelled Pi prompt');
      assert.equal(outcome.status, 'rejected', 'The native Pi prompt must acknowledge cancellation');
      mark('abort-completed'); await save(join(base, 'abort-result.json'), { abort, outcome });
      cancelled = management(await rows(join(base, 'sdk.jsonl'))).find(row => row.event === 'result' && row.request_id === starts[0].request_id);
      assert.equal(cancelled?.status, 'cancelled'); assert.equal(cancelled.effects.remote_writes, 'unknown');
      assert.equal(wire.length, providerBoundary, 'The cancelled explicit input must not reach the provider');
      const stillHeld = service.requests.find(row => row.sequence === arrived.sequence);
      assert.equal(stillHeld.terminal, 'pending'); assert.equal(stillHeld.closed_monotonic_ns, null);
      oldSession = await snapshot('cancelled-turn'); noSelection(oldSession);
      const oldState = await rpc.command('get_state');
      const switched = await rpc.command('new_session');
      const newState = await rpc.command('get_state');
      assert.notEqual(newState.sessionId, oldState.sessionId); assert.equal(newState.messageCount, 0);
      replacement = await snapshot('replacement-empty-session'); noSelection(replacement);
      assert.notEqual(replacement.session_file, oldSession.session_file);
      firstProcess.replacement_session_file = replacement.session_file;
      await save(join(base, 'session-switch.json'), { switched, old_state: oldState, new_state: newState, pid: firstProcess.pid });
      mark('session-replaced');
      await writeFile(join(base, 'cancelled-native-before-late.jsonl'), await readFile(oldSession.session_file), { flag: 'wx', mode: 0o600 });
      await rpc.prompt('Continue this independent ordinary task while the prior operation finishes.');
      checkWire(wire.at(-1).body, [], allOriginals);
      noSelection(await snapshot('replacement-before-late-session'));
      retained = await captureManagerState(manager, base, 'retained-before-late');
      assert.deepEqual(retained.rows, accepted.rows);
    });
    await step('the original manager finishes after cancellation without publishing its late receipt', async () => {
      mark('release-requested'); held.release();
      const originalClosed = await boundedObservation(held.closed, 'original held Source PATCH completion');
      await save(join(base, 'held-request-closed.json'), originalClosed);
      const close = await waitForObservation(async () => (await rows(join(base, 'sdk.jsonl')))
        .find(row => row.kind === 'manager_transport' && row.event === 'close'), 'original manager actual close');
      const raw = await readFile(close.output_file); assert.equal(hash(raw), close.output_sha256);
      response = { close, envelope: JSON.parse(raw) };
      assert.equal(response.envelope.request_id, cancelled.request_id);
      assert.equal(response.envelope.execution_id, manager.binding.execution_id);
      assert.equal(response.envelope.library, facts.sample.notion.library.library_id);
      assert.equal(response.envelope.result.status, 'ready'); mark('manager-completed');
      settled = await captureManagerState(manager, base, 'settled');
      assert.deepEqual(settled.rows, []);
      assertMaterializedFacts(facts, service.notion);
      await save(join(base, 'after-late-materialization.json'), service.notion);
      const afterLate = await snapshot('replacement-after-late-session'); noSelection(afterLate);
      await writeFile(join(base, 'replacement-native-before-recovery.jsonl'), await readFile(replacement.session_file), { flag: 'wx', mode: 0o600 });
      const oldBytes = await readFile(oldSession.session_file);
      await writeFile(join(base, 'cancelled-native-after-late.jsonl'), oldBytes, { flag: 'wx', mode: 0o600 });
      assert.deepEqual(oldBytes, await readFile(join(base, 'cancelled-native-before-late.jsonl')), 'A late receipt mutated the cancelled session');
      const beforeRecovery = await rows(join(base, 'sdk.jsonl'));
      assert.equal(consumeValues(beforeRecovery, firstProcess.pid).length, 0);
      assert.deepEqual(management(beforeRecovery).filter(row => row.event === 'result').map(row => row.status), ['cancelled']);
      await rpc.prompt('Continue the independent ordinary task after the prior operation has finished.');
      checkWire(wire.at(-1).body, [], allOriginals);
    });
    const writesAfterOriginal = service.requests.filter(row => row.semantic_write).length;
    await step('a later explicit input in the replacement native Pi session consumes the complete persisted Skill', async () => {
      for (const entry of wire) checkWire(entry.body, [], allOriginals);
      await waitForObservation(() => service.requests.every(row => row.closed_monotonic_ns !== null), 'all preceding HTTP completions');
      service.setPhase('cancel-recovery'); git.setPhase('cancel-recovery'); mark('recovery-started');
      await rpc.prompt('$' + facts.members[0].name + ' Apply this Skill to the new explicit task.');
      mark('recovery-completed'); firstProcess.provider_file = checkWire(wire.at(-1).body);
      assert.equal(service.requests.filter(row => row.semantic_write).length, writesAfterOriginal, 'The later input replayed a completed management mutation');
      const final = await finish('cancel-late');
      assert.equal(final.session_file, replacement.session_file);
      assert.ok(final.branch.some(row => row.customType === 'context-broker-selected-graph'));
      assert.equal(final.branch.some(row => row.customType === 'context-broker-materialization' && row.data?.request_id === cancelled.request_id), false);
      await writeFile(join(base, 'replacement-native-final.jsonl'), await readFile(replacement.session_file), { flag: 'wx', mode: 0o600 });
    });
    const events = await rows(join(base, 'sdk.jsonl')), original = service.requests.find(row => row.sequence === arrived.sequence);
    assertCancellationCausality({ points, held: original, cancelled, response, accepted, retained, settled });
    assert.equal(service.requests.filter(row => row.method === original.method && row.path === original.path && row.request_sha256 === original.request_sha256).length, 1);
    assert.deepEqual(service.unexpected, []); assert.deepEqual(git.unexpected, []);
    assert.equal(service.requests.some(row => row.projection_write), false);
    const values = consumeValues(events, firstProcess.pid); assert.ok(values.length > 0);
    for (const value of values) {
      assert.equal(value.value.effects?.remote_writes, 'none');
      assert.ok(BigInt(value.observer_monotonic_ns) > BigInt(points.find(row => row.event === 'recovery-started').monotonic_ns));
    }
    const managerPids = (await readFile(manager.pids, 'utf8')).trim().split('\n').map(Number);
    const managerProcesses = managerPids.map(pid => {
      const closed = events.filter(row => row.kind === 'manager_transport' && row.event === 'close' && row.child_pid === pid);
      assert.equal(closed.length, 1); assert.equal(closed[0].code, 0); assert.equal(closed[0].signal, null);
      let alive = true; try { process.kill(pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; }
      assert.equal(alive, false); return closed[0];
    });
    const credentialScopes = { manager: await actualCredentialScope(manager.roots.home), clients: [await actualCredentialScope(first.env.NTN_SKILLS_HOME)] };
    assert.notEqual(credentialScopes.manager.scope, credentialScopes.clients[0].scope);
    assert.equal(response.envelope.result.scope, credentialScopes.manager.scope);
    await save(join(base, 'credential-scopes.json'), credentialScopes);
    const receipt = { version: 1, kind: 'actual-pi-source-materialization-cancellation', actual_pi_cancellation: 'passed',
      initial: facts.initial, points, held_sequence: arrived.sequence, request_id: cancelled.request_id,
      original_manager_pid: response.close.child_pid, original_operation_id: response.envelope.result.operation_id,
      processes, manager_processes: managerProcesses, recovery_provider_file: firstProcess.provider_file,
      semantic_writes: writesAfterOriginal, projection_writes: 0, copied_consumer_state: false,
      unknown_before_late: 'retained original canonical intent; cancellation did not settle management',
      final_settlement: 'original successful transport receipt, actual manager exit and same SQLite intent retirement',
      natural_model: 'not_run', live_notion: 'not_run' };
    await save(join(base, 'cancellation.json'), receipt);
    await save(join(base, 'after-recovery.json'), service.notion);
    return { name, status: 'passed', evidence: base, steps, provider_requests: wire.length, source_requests: service.requests.length,
      semantic_writes: writesAfterOriginal, projection_writes: 0, actual_pi_cancellation: 'passed',
      sdk_operations: events.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'end').length };
  } finally { held.release(); }
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
  const initialFacts = fixture.materializationServiceFacts(info.fixture, git.url, initialFor(name));
  const facts = name === blockedMaterializationScenario ? blockedMaterializationFacts(initialFacts) : initialFacts;
  const present = facts.native_root ? [facts.native_root.content, facts.expected.root, facts.expected.required] : facts.initial === 'manifest-growth' ? [facts.expected.required]
    : facts.initial === 'source-only' ? [facts.expected.root] : [facts.expected.root, facts.expected.required];
  const absent = [facts.expected.sibling, '# Old generated reading projection\n\nThis is not the original Skill.\n',
    info.fixture.source_materialization.unaccepted_root.content,
    ...(facts.initial === 'manifest-growth' ? [facts.expected.root] : facts.initial === 'source-only' ? [facts.expected.required] : [])];
  const alias = facts.native_root?.alias ?? (facts.initial === 'manifest-growth' ? facts.members[1].name : facts.members[0].name);
  const localCollisionBody = name === 'source-materialize-first' ? localCollisionContent(alias) : undefined;
  if (localCollisionBody) absent.push(localCollisionBody);
  await save(join(base, 'source-facts.json'), facts);
  let plan = { mode: 'complete' };
  const checkWire = (body, included = present, excluded = absent) => {
    helpers.assertWireSources(body, included, excluded);
    const captured = wire.find(item => item.body === body); assert.ok(captured);
    const original = text => ({ text, bytes: Buffer.byteLength(text), sha256: hash(text) });
    const proof = { provider_file: captured.file, present: included.map(original), absent: excluded.map(original) };
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
import { appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { observeCacheUpgrade } from ${JSON.stringify(new URL('./notion-sdk-pi-cache-upgrade.mjs', import.meta.url).href)};
const active = new Set();
const emit = (kind, event) => {
  const row={kind,observer_pid:process.pid,observer_monotonic_ns:process.hrtime.bigint().toString(),...event};
  appendFileSync(process.env.CURRENT_SDK_EVENTS,JSON.stringify(row)+'\\n');
  try{observeCacheUpgrade(process.env.CURRENT_CACHE_UPGRADE_CONFIG,kind,row);}
  catch(error){appendFileSync(process.env.CURRENT_SDK_EVENTS,JSON.stringify({kind:'cache_upgrade_observer_error',observer_pid:process.pid,error:error.message})+'\\n');}
};
if(process.env.CURRENT_BLOCKED_MATERIALIZATION==='1'){
  emit('materialization_observer',{event:'start'});
  process.once('exit',code=>emit('materialization_observer',{event:'end',code,active_sdk_ids:[...active]}));
}
for(const topic of ['context-broker.notion-sdk','context-broker.notion-sdk-result','context-broker.notion-materialization'])
  channel(topic).subscribe(event=>{if(topic==='context-broker.notion-sdk'){if(event.event==='start')active.add(event.id);else if(event.event==='end')active.delete(event.id);}emit(topic,event);});
for(const api of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']){
  const original=childProcess[api];childProcess[api]=function(...args){
    emit('child_process',{api,command:String(args[0]).split('/').at(-1),active_sdk_ids:[...active]});
    const child=original.apply(this,args);
    if(api==='spawn' && args[0]===process.env.CURRENT_MANAGER_ENTRY){
      emit('manager_transport',{event:'spawn',child_pid:child.pid,command:args[0]});
      const chunks=[],errors=[];let bytes=0,errorBytes=0;
      child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes<=1048576)chunks.push(Buffer.from(chunk));});
      child.stderr.on('data',chunk=>{errorBytes+=Buffer.byteLength(chunk);if(errorBytes<=1048576)errors.push(Buffer.from(chunk));});
      child.once('close',(code,signal)=>{try{
        if(bytes>1048576||errorBytes>1048576)throw Error('MANAGER_OBSERVATION_BOUND');
        const output=Buffer.concat(chunks),file=process.env.CURRENT_MANAGER_OUTPUT+'/manager-response-'+child.pid+'.json';
        writeFileSync(file,output,{flag:'wx',mode:0o600});
        const stderr=Buffer.concat(errors),stderrFile=process.env.CURRENT_MANAGER_OUTPUT+'/manager-stderr-'+child.pid+'.txt';
        writeFileSync(stderrFile,stderr,{flag:'wx',mode:0o600});
        emit('manager_transport',{event:'close',child_pid:child.pid,code,signal,output_file:file,output_bytes:output.length,output_sha256:createHash('sha256').update(output).digest('hex'),stderr_file:stderrFile,stderr_bytes:stderr.length,stderr_sha256:createHash('sha256').update(stderr).digest('hex')});
      }catch(error){emit('manager_transport',{event:'observer-error',child_pid:child.pid,error:error.message});}});
    }
    return child;
  };
}
syncBuiltinESMExports();
`);
    const createClient = async number => {
      const root = join(base, 'client-' + number), agentDir = join(root, 'agent'), sessions = join(root, 'sessions');
      await mkdir(join(agentDir, 'context-broker'), { recursive: true, mode: 0o700 }); await mkdir(sessions);
      const source = { type: 'notion', id: 'current-sdk', namespace: 'current-sdk', library: facts.sample.notion.library.library_id,
        discovery: { maxAge: '5m' }, activation: { maxAge: '5m' }, cacheDir: join(root, 'broker-cache'), prefetch: false };
      const config = join(agentDir, 'context-broker/config.yml');
      let localCollision;
      if (localCollisionBody) {
        const path = join(root, 'local-skills', alias, 'SKILL.md');
        await mkdir(dirname(path), { recursive: true });
        const body = localCollisionSkill(alias);
        await writeFile(path, body);
        localCollision = { path, name: alias, bytes: Buffer.byteLength(body), sha256: hash(body), content: localCollisionBody };
      }
      await save(config, { sources: [source], ...(localCollision ? { skillRoots: [dirname(localCollision.path)], requireAutoload: false } : {}) });
      await save(join(agentDir, 'settings.json'), { compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } });
      const env = isolatedEnv({ base: root, agentDir, PATH: [dirname(process.execPath), dirname(gitCommand.identity), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
        NOTION_API_TOKEN: info.fixtureEnv.NOTION_API_TOKEN, NOTION_API_BASE_URL: service.origin,
        NTN_SKILLS_NOTION_INTERVAL_MS: '100', NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000',
        CONTEXT_BROKER_HOST: 'pi', CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_LOG_FILE: join(root, 'decisions.jsonl'),
        CURRENT_SDK_EVENTS: join(base, 'sdk.jsonl'), CURRENT_NATIVE_EVENTS: join(base, 'native.jsonl'), CURRENT_CONTROL: control,
        BROKER_E2E_PROCESS_LEDGER: join(base, 'processes.jsonl'), NODE_OPTIONS: '--import=' + preload, CTX_MOCK_PROVIDER_BASE_URL: provider.baseUrl,
        CURRENT_MANAGER_ENTRY: manager.binding.command, CURRENT_MANAGER_OUTPUT: base,
        ...(name === blockedMaterializationScenario ? { CURRENT_BLOCKED_MATERIALIZATION: '1' } : {}),
        ...(name === 'source-materialize-cache-upgrade' && number === 1 ? { CURRENT_CACHE_UPGRADE_CONFIG: join(base, 'cache-upgrade-config.json') } : {}) });
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
        ...(localCollision ? { local_collision: localCollision, config_file: config, config_sha256: hash(await readFile(config)) } : {}),
        consumer_credential_sha256: hash(info.fixtureEnv.NOTION_API_TOKEN),
        manager_binding: manager.binding,
        ...(name === blockedMaterializationScenario ? { manager_binding_file: { path: join(env.NTN_SKILLS_CONFIG_HOME, 'source-manager.json'),
          sha256: hash(await readFile(join(env.NTN_SKILLS_CONFIG_HOME, 'source-manager.json'))) } } : {}),
        isolation: { home: env.HOME, state: env.NTN_SKILLS_HOME, cache: env.NTN_SKILLS_CACHE_HOME, broker: source.cacheDir }, copied_consumer_state: false });
      return { root, source, env, args };
    };
    const snapshot = async label => {
      const output = join(base, label + '.json'); await save(control, { action: 'snapshot', output });
      await rpc.prompt('/current-fixture'); return JSON.parse(await readFile(output, 'utf8'));
    };
    const open = async (client, phase) => {
      service.setPhase(phase); git.setPhase(phase);
      rpc = await startRpc({ host: info.host, args: client.args, cwd: client.root, env: client.env, timeoutMs: 360000 });
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
    const firstQuery = localCollisionBody ? alias + '@' + first.source.namespace : alias;
    await open(first, 'discovery');
    if (![blockedMaterializationScenario, 'source-materialize-cold-budget'].includes(name)) await step('actual model discovery has no management authority or semantic writes', async () => {
      plan = { mode: 'call', call: { type: 'toolCall', id: 'readonly-discovery', name: 'notion_list', arguments: { query: alias, limit: 100 } } };
      await rpc.prompt('Find the named Skill without selecting it.');
      assert.equal(management(await rows(join(base, 'sdk.jsonl'))).length, 0);
      assert.equal(service.requests.some(row => row.semantic_write), false);
      assert.deepEqual(service.notion.skills, facts.sample.notion.skills);
    });
    if (name === 'source-materialize-cache-upgrade') await step('seed mixed legacy and current metadata only in the private consumer Store', async () => {
      seedCacheUpgrade({ path: join(first.env.NTN_SKILLS_HOME, 'state.sqlite'), library: first.source.library, base });
    });
    if (name === blockedMaterializationScenario) return await runBlockedMaterialization({ name, base, facts, first, manager, service, git, wire, steps, processes, rpc,
      step, finish, setPlan: value => { plan = value; }, checkWire, readManagerState });
    if (name === 'source-materialize-cancel-late') return await runCancellation({ name, base, info, facts, first, manager, service, git, wire, steps, processes, rpc,
      step, snapshot, finish, setPlan: value => { plan = value; }, checkWire, assertWireSources: helpers.assertWireSources, present, absent });
    // The first process now crosses a real input-receipt boundary.
    service.setPhase('materialize'); git.setPhase('materialize'); processes[0].phase = 'materialize';
    await step('literal dollar selection uses the fixed manager then publishes complete ordinary consumption', async () => {
      plan = { mode: 'complete' };
      const prompt = '$' + firstQuery + ' Apply this Skill to the task.';
      if (name === 'source-materialize-cold-budget')
        await runColdMaterializationPrompt({ base, facts, service, rpc, piPid: processes[0].pid, prompt });
      else await rpc.prompt(prompt);
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
    if (name === 'source-materialize-cold-budget') assertColdMaterializationBudget({
      receipt: JSON.parse(await readFile(join(base, 'cold-budget.json'), 'utf8')), facts, source: service.requests,
      events: await rows(join(base, 'sdk.jsonl')), initial: JSON.parse(await readFile(join(base, 'discovery-empty-session.json'), 'utf8')),
      session: firstFinal, piPid: processes[0].pid,
    });
    if (name === 'source-materialize-cache-upgrade') await save(join(base, 'cache-upgrade-result.json'),
      assertCacheUpgradeEvidence({ ...readCacheUpgradeEvidence(base), events: await rows(join(base, 'sdk.jsonl')), source: service.requests, piPid: processes[0].pid }));
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
      plan = { mode: 'complete' }; await rpc.prompt('$' + firstQuery + ' Apply this Skill from the independent client.');
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
    const managerProcesses = await positiveManagerTransports({ base, manager, events, sessionReceipts: sessionManagement.map(row => row.data),
      credentialScopes, piPid: processes[0].pid, sourceId: first.source.id });
    const receipt = { version: 1, initial: facts.initial, max_age_ms: 300000, alias, first_query: firstQuery, warm_query: warmQuery, original_member_candidate: originalMemberCandidate, processes,
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

async function verifyCancellationEvidence({ base, entry, source, events, proofs, assertWireSources }) {
  const read = async name => JSON.parse(await readFile(join(base, name), 'utf8'));
  const receipt = await read('cancellation.json'), facts = await read('source-facts.json');
  assert.equal(entry.name, 'source-materialize-cancel-late'); assert.equal(receipt.version, 1);
  assert.equal(receipt.kind, 'actual-pi-source-materialization-cancellation'); assert.equal(receipt.actual_pi_cancellation, 'passed');
  assert.equal(facts.initial, 'source-only'); assert.equal(receipt.copied_consumer_state, false);
  assert.equal(receipt.projection_writes, 0); assert.equal(receipt.live_notion, 'not_run'); assert.equal(receipt.natural_model, 'not_run');
  assert.equal(receipt.processes.length, 1);
  const process = receipt.processes[0]; assert.equal(process.phase, 'cancel-late');
  const life = await read('cancel-late-rpc-lifecycle.json');
  assert.equal(life[0].event, 'spawn'); assert.equal(life[0].pid, process.pid);
  assert.equal(life.at(-1).event, 'close'); assert.equal(life.at(-1).pid, process.pid);
  assert.equal(life.at(-1).code, 0); assert.equal(life.at(-1).signal, null);
  const actions = management(events), original = actions.filter(row => row.request_id === receipt.request_id);
  assert.deepEqual(original.map(row => row.event), ['start', 'result']);
  assert.equal(original[0].observer_pid, process.pid); assert.equal(original[1].observer_pid, process.pid);
  const close = events.filter(row => row.kind === 'manager_transport' && row.event === 'close' && row.child_pid === receipt.original_manager_pid);
  assert.equal(close.length, 1); assert.equal(close[0].observer_pid, process.pid);
  assert.equal(events.some(row => row.kind === 'manager_transport' && row.event === 'observer-error'), false);
  assert.equal(close[0].output_file, join(base, 'manager-response-' + receipt.original_manager_pid + '.json'));
  const raw = await readFile(close[0].output_file); assert.equal(hash(raw), close[0].output_sha256); assert.equal(raw.length, close[0].output_bytes);
  const response = { close: close[0], envelope: JSON.parse(raw) };
  const manager = await read('manager/identity.json'), launch = await read('client-1/launch.json');
  assert.equal(manager.binding.kind, 'local'); assert.equal(manager.config.projection, 'none');
  assert.equal(manager.binding.execution_id, hash(JSON.stringify(manager.inventory.files)));
  assert.equal(manager.config.generation.inventory_sha256, manager.binding.execution_id);
  assert.equal(response.envelope.execution_id, manager.binding.execution_id);
  assert.equal(response.envelope.library, facts.sample.notion.library.library_id);
  assert.deepEqual(launch.manager_binding, manager.binding); assert.equal(launch.copied_consumer_state, false);
  assert.ok(Object.values(launch.empty_consumer_roots).every(value => value === 'absent'));
  assert.equal(Object.keys(launch.empty_consumer_roots).length, 3);
  assert.equal(launch.source.activation.maxAge, '5m'); assert.equal(launch.source.discovery.maxAge, '5m');
  for (const role of ['node', 'git']) {
    const selected = manager.tool_selection[role];
    assert.equal(selected.path, join(base, 'manager/tools', role)); assert.notEqual(selected.path, selected.source);
    assert.equal(selected.sha256, selected.source_sha256); assert.equal(hash(await readFile(selected.path)), selected.sha256);
    assert.equal(selected.uid, globalThis.process.getuid()); assert.equal(selected.mode, 0o500);
  }
  assert.equal(manager.config.generation.runtime, manager.tool_selection.node.path);
  assert.equal(manager.config.git.executable, manager.tool_selection.git.path);
  const states = {};
  for (const label of ['accepted', 'retained-before-late', 'settled']) {
    const directory = 'manager-state-' + label, snapshot = await read(directory + '/snapshot.json');
    assert.deepEqual(await readManagerState(join(base, directory, 'state.sqlite')), { identities: snapshot.identities, rows: snapshot.rows });
    states[label] = snapshot;
  }
  const held = source.filter(row => row.sequence === receipt.held_sequence); assert.equal(held.length, 1);
  const arrived = await read('held-request-arrived.json'), closed = await read('held-request-closed.json');
  assert.equal(arrived.sequence, held[0].sequence); assert.equal(arrived.request_sha256, held[0].request_sha256);
  assert.equal(arrived.response_bytes_complete, false); assert.equal(arrived.closed_monotonic_ns, null);
  assert.deepEqual(closed, held[0]); assert.equal(held[0].path, '/v1/pages/' + facts.source_page_id);
  assert.equal(source.filter(row => row.method === held[0].method && row.path === held[0].path && row.request_sha256 === held[0].request_sha256).length, 1);
  assertCancellationCausality({ points: receipt.points, held: held[0], cancelled: original[1], response,
    accepted: states.accepted, retained: states['retained-before-late'], settled: states.settled });
  assert.equal(receipt.original_operation_id, response.envelope.result.operation_id);
  assert.equal(source.filter(row => row.semantic_write).length, receipt.semantic_writes); assert.ok(receipt.semantic_writes > 0);
  assert.equal(source.some(row => row.projection_write), false);
  assert.equal(source.some(row => row.semantic_write && row.phase === 'cancel-recovery'), false);
  const abort = await read('abort-result.json'); assert.equal(abort.outcome.status, 'rejected');
  const rpc = await read('cancel-late-rpc.json');
  assert.ok(rpc.some(row => row.type === 'response' && row.command === 'abort' && row.success === true));
  assert.ok(rpc.some(row => row.type === 'response' && row.command === 'new_session' && row.success === true));
  const switched = await read('session-switch.json'); assert.equal(switched.pid, process.pid);
  assert.notEqual(switched.old_state.sessionId, switched.new_state.sessionId); assert.equal(switched.new_state.messageCount, 0);
  const native = await rows(join(base, 'native.jsonl'));
  assert.ok(native.some(row => row.type === 'session_before_switch' && row.pid === process.pid && row.session_id === switched.old_state.sessionId));
  assert.ok(native.some(row => row.type === 'session_start' && row.reason === 'new' && row.pid === process.pid && row.session_id === switched.new_state.sessionId && row.previous_session_file === process.session_file));
  const originals = [facts.expected.root, facts.expected.required, facts.expected.sibling, facts.sample.source_materialization.unaccepted_root.content];
  for (const label of ['cancelled-turn', 'replacement-empty-session', 'replacement-before-late-session', 'replacement-after-late-session']) {
    const snapshot = await read(label + '.json'); assertNoCancellationPublication(snapshot, originals, assertWireSources);
    assert.equal(snapshot.session_file, label === 'cancelled-turn' ? process.session_file : process.replacement_session_file);
  }
  assert.notEqual(process.session_file, process.replacement_session_file);
  assert.deepEqual(await readFile(join(base, 'cancelled-native-before-late.jsonl')), await readFile(join(base, 'cancelled-native-after-late.jsonl')));
  const cancelledNative = await rows(join(base, 'cancelled-native-after-late.jsonl'));
  assert.equal(cancelledNative[0].id, switched.old_state.sessionId);
  assertNoCancellationPublication({ branch: cancelledNative }, originals, assertWireSources);
  const replacementNative = await rows(join(base, 'replacement-native-before-recovery.jsonl'));
  assert.equal(replacementNative[0].id, switched.new_state.sessionId);
  assertNoCancellationPublication({ branch: replacementNative }, originals, assertWireSources);
  const final = await read('cancel-late-final-session.json');
  assert.equal(final.session_file, process.replacement_session_file);
  assert.ok(final.branch.some(row => row.customType === 'context-broker-selected-graph'));
  assert.equal(final.branch.some(row => row.customType === 'context-broker-materialization' && row.data?.request_id === receipt.request_id), false);
  const recovery = receipt.points.find(row => row.event === 'recovery-started');
  const values = consumeValues(events, process.pid); assert.ok(values.length > 0);
  for (const value of values) {
    assert.ok(BigInt(value.observer_monotonic_ns) > BigInt(recovery.monotonic_ns));
    assert.equal(value.value.effects?.remote_writes, 'none');
    const prepared = value.value.preparation.nodes.filter(row => row.state === 'prepared');
    assert.equal(prepared.length, 1); assert.equal(prepared[0].content, facts.expected.root);
    const end = events.find(row => row.kind === 'context-broker.notion-sdk' && row.event === 'end' && row.id === value.id);
    assert.equal(end?.status, 'completed'); assert.equal(end?.request_metrics?.requests?.notion_write, 0);
  }
  const wire = await read('provider-index.json');
  const last = wire.findIndex(row => row.file === receipt.recovery_provider_file); assert.equal(last, wire.length - 1);
  for (const item of wire.slice(0, last)) assertWireSources(await read(item.file), [], originals);
  assertWireSources(await read(receipt.recovery_provider_file), [facts.expected.root], originals.slice(1));
  const proof = proofs.filter(row => row.provider_file === receipt.recovery_provider_file);
  assert.equal(proof.length, 1); assert.deepEqual(proof[0].present.map(row => row.text), [facts.expected.root]);
  const managerStarts = events.filter(row => row.kind === 'manager_transport' && row.event === 'spawn');
  const pids = (await readFile(join(base, 'manager/accepted-pids.txt'), 'utf8')).trim().split('\n').map(Number);
  assert.deepEqual(managerStarts.map(row => row.child_pid), pids);
  assert.deepEqual(receipt.manager_processes, events.filter(row => row.kind === 'manager_transport' && row.event === 'close'));
  assert.equal(receipt.manager_processes.length, pids.length);
  assert.ok(receipt.manager_processes.every(row => row.code === 0 && row.signal === null));
  for (const close of receipt.manager_processes) {
    assert.equal(close.stderr_file, join(base, 'manager-stderr-' + close.child_pid + '.txt'));
    const stderr = await readFile(close.stderr_file);
    assert.ok(stderr.length <= 1048576);
    assert.equal(close.stderr_bytes, stderr.length); assert.equal(close.stderr_sha256, hash(stderr));
  }
  const scopes = await read('credential-scopes.json');
  assert.notEqual(scopes.manager.scope, scopes.clients[0].scope);
  assert.equal(scopes.manager.scope, states.settled.identities[0].scope); assert.equal(response.envelope.result.scope, scopes.manager.scope);
  assert.ok(values.every(row => row.value.preparation.nodes.every(node => node.state !== 'prepared' || node.binding.scope === scopes.clients[0].scope)));
  const ready = await read('after-late-materialization.json'), after = await read('after-recovery.json');
  assertMaterializedFacts(facts, ready); assert.deepEqual(after, ready);
}

export async function verifyMaterializationEvidence({ base, entry, source, events, proofs, assertWireSources }) {
  if (entry.name === blockedMaterializationScenario) return verifyBlockedMaterializationEvidence({ base, source, events, proofs, assertWireSources });
  if (entry.name === 'source-materialize-cancel-late') return verifyCancellationEvidence({ base, entry, source, events, proofs, assertWireSources });
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
  const ready = JSON.parse(await readFile(join(base, 'after-materialization.json'), 'utf8'));
  const graphExpectation = materializationGraphExpectation(facts, ready);
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
  if (entry.name === 'source-materialize-first') {
    assert.equal(receipt.first_query, receipt.alias + '@current-sdk');
    for (const [index, client] of clients.entries()) {
      assert.equal(client.config_file, join(client.cwd, 'agent/context-broker/config.yml'));
      const configBytes = await readFile(client.config_file);
      assert.equal(hash(configBytes), client.config_sha256);
      const phase = index === 0 ? 'materialize' : 'independent-client';
      assertSourceOnlyCollisionSelection({ alias: receipt.alias, client, config: JSON.parse(configBytes),
        localBytes: await readFile(client.local_collision.path),
        session: JSON.parse(await readFile(join(base, phase + '-final-session.json'), 'utf8')), phase });
    }
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
    if (entry.name === 'source-materialize-first') assert.ok(proof[0].absent.some(row => row.text === localCollisionContent(receipt.alias)),
      'Every Source-only provider proof must exclude the same-name local instructions');
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
      assertWarmMaterializationGraph(values.at(-1).value, consumeValues(events, receipt.processes[0].pid).at(-1).value, graphExpectation);
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
  const session = JSON.parse(await readFile(join(base, 'materialize-final-session.json'), 'utf8'));
  if (entry.name === 'source-materialize-cold-budget') assertColdMaterializationBudget({
    receipt: JSON.parse(await readFile(join(base, 'cold-budget.json'), 'utf8')), facts, source, events,
    initial: JSON.parse(await readFile(join(base, 'discovery-empty-session.json'), 'utf8')),
    session, piPid: receipt.processes[0].pid,
  });
  if (entry.name === 'source-materialize-cache-upgrade') assert.deepEqual(
    JSON.parse(await readFile(join(base, 'cache-upgrade-result.json'), 'utf8')),
    assertCacheUpgradeEvidence({ ...readCacheUpgradeEvidence(base), events, source, piPid: receipt.processes[0].pid }));
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
  assert.deepEqual(receipt.manager_processes, await positiveManagerTransports({ base, manager, events,
    sessionReceipts: sessionManagement.map(row => row.data), credentialScopes, piPid: receipt.processes[0].pid, sourceId: clients[0].source.id }));
}
