import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
const sessionModule = option('--session-module');
assert.ok(isAbsolute(sessionModule ?? ''), 'Pass --session-module with the installed Pi core/session-manager.js');
const requirePi = createRequire(sessionModule), { createJiti } = requirePi('jiti');
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const { SessionManager } = await import(pathToFileURL(sessionModule).href);
const active = await jiti.import(fileURLToPath(new URL('../src/session-active.ts', import.meta.url)));
const graphs = await jiti.import(fileURLToPath(new URL('../src/session-graph.ts', import.meta.url)));
const receipts = await jiti.import(fileURLToPath(new URL('../src/session-source-snapshot.ts', import.meta.url)));
const hash = text => createHash('sha256').update(text).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
const context = manager => ({ sessionManager: manager, cwd: manager.getCwd(), mode: 'rpc', hasUI: false });
const api = manager => ({ on() {}, appendEntry(type, data) { return manager.appendCustomEntry(type, data); } });
const messages = manager => manager.buildSessionContext().messages;
const state = manager => [...active.activeSources(context(manager)).sources.values()].map(source => ({
  id: source.record.id, scope: source.record.sourceScope, snapshotId: source.snapshotId, bodySha256: source.bodySha256, bytes: source.bytes,
})).sort((a, b) => a.id.localeCompare(b.id));
const confirmations = manager => manager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === active.SESSION_ACTIVE_ENTRY);
if (args[0] === 'resume') {
  const manager = SessionManager.open(args[1]);
  process.stdout.write(JSON.stringify({ state: state(manager), confirmations: confirmations(manager).map(entry => entry.data.activation_id), missing: active.missingActiveSources(context(manager), messages(manager)).map(source => source.snapshotId) }));
  process.exit(0);
}
const evidenceRoot = option('--evidence-root');
assert.ok(isAbsolute(evidenceRoot ?? ''), 'Pass --evidence-root with the persistent verification directory');
await mkdir(evidenceRoot, { recursive: true });
const directory = await mkdtemp(join(evidenceRoot, 'session-active-session-')), sessions = join(directory, 'sessions');
const scope = 'e'.repeat(64);
function prepared(revision) {
  const records = ['root', 'required'].map(name => {
    const id = 'shared_skill:controlled:' + name;
    const metadata = { id, kind: 'skill', name, alias: name, description: name, enabled: true, default_context: false,
      entrypoint: 'SKILL.md', ref: 'skill://' + encodeURIComponent(id) + '/SKILL.md',
      locator: { type: 'shared_skill', library_id: 'controlled', skill_id: name, page_id: '00000000-0000-4000-8000-000000000001', database_id: '00000000-0000-4000-8000-000000000002', data_source_id: '00000000-0000-4000-8000-000000000003' } };
    const body = `Complete controlled ${name} instructions ${revision}.\n`, snapshotId = 's_' + hash(name + revision);
    return { ...metadata, source: 'notion', sourceId: 'controlled', sourceScope: scope, body, snapshotId, versionId: hash(body),
      path: join(directory, 'immutable', revision, name, 'SKILL.md'), aliases: [], normalizedName: name, normalizedAliases: [], normalizedDescription: name, autoloadEnabled: false,
      preparationBinding: { record: metadata, scope, snapshot_id: snapshotId, version_id: hash(body), body_sha256: hash(body), ref: metadata.ref + '?snapshot=' + snapshotId } };
  });
  const vector = { version: 1, kind: 'observed_version_vector', purpose: 'use', scope, roots: [records[0].id],
    required: [{ from: records[0].id, to: records[1].id, ref: records[1].preparationBinding.ref }], bindings: records.map(record => record.preparationBinding) };
  return { purpose: 'use', sourceId: 'controlled', scope, roots: vector.roots, records, bindings: vector.bindings, lock: { ...vector, sha256: hash(canonical(vector)) },
    budget: { maxNodes: 64, maxDepth: 16, maxInstructionBytes: 1048576, maxContextBytes: 262144 },
    usage: { prepared_nodes: 2, instruction_bytes: records.reduce((sum, record) => sum + Buffer.byteLength(record.body), 0), context_bytes: 500, max_depth: 1 } };
}
function deliver(manager, records) {
  const content = records.map(record => record.body).join('\n');
  manager.appendCustomMessageEntry('context-broker', content, false, { records: records.map(record => receipts.sourceDeliveryReceipt(record, content)) });
}
function confirm(manager, graph, pending = []) {
  const projected = receipts.deduplicateSourceReads(receipts.projectSelectedSourceMessages(messages(manager), active.activeSelection(context(manager), pending)));
  active.confirmActiveSources(api(manager), context(manager), graph.records, projected);
  return projected;
}
function restart(file) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'resume', file, '--session-module', sessionModule], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
const checks = [], check = name => checks.push(name);
const a = prepared('A'), b = prepared('B'), manager = SessionManager.create(directory, sessions);
manager.appendMessage({ role: 'user', content: 'Use controlled root A.', timestamp: Date.now() });
graphs.persistSessionSelection(api(manager), context(manager), [a], 'extend');
assert.deepEqual(state(manager), []); check('selected_use_is_not_active');
deliver(manager, a.records); confirm(manager, a);
assert.equal(confirmations(manager).length, 1);
const leafA = manager.getLeafId(), stateA = state(manager), originalFile = manager.getSessionFile();
assert.ok(originalFile && leafA); check('complete_root_and_required_A_confirmation');
assert.deepEqual(restart(originalFile).state, stateA); check('independent_node_resume_A');

graphs.persistSessionSelection(api(manager), context(manager), [b], 'replace');
deliver(manager, [b.records[0]]);
confirm(manager, b, [{ graphs: [b], mode: 'replace' }]);
assert.deepEqual(state(manager), stateA);
assert.equal(confirmations(manager).length, 1); check('incomplete_refresh_preserves_active_A');
deliver(manager, b.records);
const projectionB = confirm(manager, b, [{ graphs: [b], mode: 'replace' }]);
assert.equal(confirmations(manager).length, 2);
assert.notEqual(confirmations(manager)[0].data.activation_id, confirmations(manager)[1].data.activation_id);
const stateB = state(manager), leafB = manager.getLeafId();
assert.notDeepEqual(stateB, stateA);
for (const record of a.records) assert.ok(!projectionB.some(message => receipts.sourceMessageText(message.content).includes(record.body)));
for (const record of b.records) assert.equal(projectionB.reduce((sum, message) => sum + receipts.sourceMessageText(message.content).split(record.body).length - 1, 0), 1);
check('independent_B_confirmation_replaces_current_projection');
assert.deepEqual(restart(originalFile).state, stateB); check('independent_node_resume_B');
assert.ok((await readFile(originalFile, 'utf8')).includes(a.records[0].body.replaceAll('\n', '\\n'))); check('raw_A_history_retained');

const originalBytes = await readFile(originalFile), forkCreator = SessionManager.open(originalFile);
const forkFile = forkCreator.createBranchedSession(leafA);
assert.ok(forkFile && forkFile !== originalFile);
assert.deepEqual(await readFile(originalFile), originalBytes, 'Creating a fork cannot rewrite the sibling journal');
const fork = SessionManager.open(forkFile);
assert.deepEqual(state(fork), stateA); assert.equal(confirmations(fork).length, 1);
assert.deepEqual(restart(forkFile).state, stateA); check('fork_only_sees_A_ancestors');
const rewind = SessionManager.open(originalFile);
rewind.branch(leafA);
rewind.appendMessage({ role: 'user', content: 'Continue the A ancestor.', timestamp: Date.now() });
assert.deepEqual(state(rewind), stateA);
assert.deepEqual(restart(originalFile).state, stateA); check('rewind_and_independent_resume_restore_A');
const sibling = SessionManager.open(originalFile), siblingFile = sibling.createBranchedSession(leafB);
assert.ok(siblingFile);
assert.deepEqual(restart(siblingFile).state, stateB);
assert.deepEqual(restart(forkFile).state, stateA); check('sibling_B_and_A_remain_independent');

fork.appendCompaction('Only an untrusted textual label remains; full source bodies were compacted away.', null, 0);
assert.equal(active.missingActiveSources(context(fork), messages(fork)).length, 2);
assert.deepEqual(state(fork), stateA); check('compaction_keeps_active_vector_and_requires_complete_restore');
fork.appendMessage({ role: 'user', content: a.records.map(record => record.body).join('\n'), timestamp: Date.now() });
assert.equal(active.missingActiveSources(context(fork), messages(fork)).length, 2); check('user_body_spoof_cannot_satisfy_restore');
deliver(fork, a.records); confirm(fork, a);
assert.equal(active.missingActiveSources(context(fork), messages(fork)).length, 0);
assert.equal(confirmations(fork).length, 1); check('complete_fixed_restore_does_not_duplicate_activation');
const fresh = SessionManager.create(directory, sessions);
fresh.appendMessage({ role: 'user', content: 'New session.', timestamp: Date.now() });
assert.deepEqual(state(fresh), []); check('new_session_does_not_inherit_active_bindings');

const inputs = await Promise.all(['session-active.ts', 'session-graph.ts', 'session-source-snapshot.ts'].map(async name => {
  const path = fileURLToPath(new URL('../src/' + name, import.meta.url)); return { path, sha256: hash(await readFile(path)) };
}));
const result = { status: 'passed', boundary: 'Actual installed Pi SessionManager and independent Node resume processes; controlled canonical graph and delivery fixtures. No agent/provider/Notion or real-model compaction.',
  sessionModule, sessionModuleSha256: hash(await readFile(sessionModule)), driverSha256: hash(await readFile(fileURLToPath(import.meta.url))), inputs,
  checks, originalFile, forkFile, siblingFile, stateA, stateB,
  cleanup: { retainedOwnedEvidence: directory, liveOwnedProcesses: 0, persistentSessionsAreEvidence: true } };
await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify({ status: result.status, evidence: directory, checks }, null, 2) + '\n');
