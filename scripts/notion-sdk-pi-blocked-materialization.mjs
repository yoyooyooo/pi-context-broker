import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const blockedMaterializationScenario = 'source-materialize-blocked-member';
const hash = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const rows = async path => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const field = (row, binding, name) => Object.values(row.properties).find(value => value.id === binding.property_ids[name]);
const text = value => value.rich_text.map(part => part.plain_text ?? part.text.content).join('');
const one = (values, message) => { assert.equal(values.length, 1, message); return values[0]; };

/** Change declared author metadata, never the Git original or an SDK response. */
export function blockedMaterializationFacts(original) {
  const facts = structuredClone(original);
  assert.equal(facts.initial, 'source-only');
  const member = facts.members[0], file = one(member.files.filter(file => file.path === 'SKILL.md'), 'One original main file');
  assert.equal(file.content, facts.expected.root); assert.equal(hash(file.content), file.sha256);
  assert.equal(Buffer.byteLength(file.content), file.bytes);
  const from = one(file.content.split('\n').filter(line => line.startsWith('description: ')), 'One description line');
  const description = from.slice('description: '.length);
  assert.ok(description && !description.startsWith('"') && !description.startsWith("'"));
  const to = 'description: ' + JSON.stringify(description), patched = file.content.replace(from, to);
  assert.notEqual(patched, file.content);
  const patch = { version: 1, files: [{ path: 'SKILL.md', replacements: [{ from, to }] }] };
  const source = one(facts.sample.notion.sources.filter(row => row.id === facts.source_page_id), 'Registered Source');
  const options = field(source, facts.sample.notion.library.sources, 'Options');
  assert.deepEqual(JSON.parse(text(options)), {});
  const declared = { version: 1, adapter: {}, settings: { member_patches: { [member.member_key]: patch } } };
  const encoded = JSON.stringify(declared);
  assert.ok(encoded.length < 1900, 'Keep the authored property inside one valid Notion text fragment');
  options.rich_text = [{ type: 'text', plain_text: encoded, text: { content: encoded } }];
  facts.blocked_member = { source_id: facts.source_id, member_key: member.member_key,
    expected_skill_id: 'skill-' + hash(JSON.stringify(['source-member', facts.source_id, member.member_key])),
    expected_source_commit: facts.sample.source_materialization.commit, expected_source_revision: facts.revision,
    description, patch, original: { content: file.content, sha256: file.sha256, bytes: file.bytes, git_oid: file.git_oid },
    patched: { content: patched, sha256: hash(patched), bytes: Buffer.byteLength(patched) } };
  return facts;
}

// This exact case permits only the source fixture's missing blocks map
// initialization. Any other startup change must be rejected.
function initialServiceFacts(facts) {
  const expected = structuredClone(facts.sample.notion);
  if (!Object.hasOwn(expected, 'blocks')) expected.blocks = {};
  return expected;
}

/** Capture the complete running HTTP service before any client can start. */
export function captureBlockedMaterializationBefore(facts, service) {
  assert.deepEqual(service.requests, [], 'The remote baseline must precede every client request');
  assert.deepEqual(service.notion, initialServiceFacts(facts), 'Unexpected controlled service initialization');
  return { version: 1, kind: 'blocked-service-before-clients', harness_pid: process.pid,
    captured_monotonic_ns: process.hrtime.bigint().toString(), source_request_count: 0,
    notion: structuredClone(service.notion) };
}

/** Bind the saved baseline before controlledManager can initialize its SDK. */
export async function markBlockedMaterializationClients(base) {
  const bytes = await readFile(join(base, 'before-blocked-member.json')), before = JSON.parse(bytes);
  assert.equal(before.kind, 'blocked-service-before-clients'); assert.equal(before.harness_pid, process.pid);
  const started = process.hrtime.bigint();
  assert.ok(started > BigInt(before.captured_monotonic_ns));
  await save(join(base, 'blocked-clients-start.json'), { version: 1, kind: 'blocked-clients-start',
    harness_pid: process.pid, started_monotonic_ns: started.toString(), before_sha256: hash(bytes) });
}

async function readBlockedMaterializationBefore(base) {
  const bytes = await readFile(join(base, 'before-blocked-member.json'));
  return { before: JSON.parse(bytes), beforeSha256: hash(bytes), clients: await read(join(base, 'blocked-clients-start.json')) };
}

/** A complete Pi observer is necessary to prove the absence of dispatch. */
export function assertBlockedMaterialization({ facts, before, beforeSha256, clients, events, source, git, initial, session, lifecycle, frames, process: observed, after, managerPids }) {
  const expected = facts.blocked_member, pid = observed.pid;
  assert.ok(expected && Number.isSafeInteger(pid) && pid > 0);
  assert.equal(facts.initial, 'source-only');
  assert.ok(before && clients, 'The original service baseline and client boundary are required');
  assert.deepEqual(Object.keys(before).sort(), ['captured_monotonic_ns', 'harness_pid', 'kind', 'notion', 'source_request_count', 'version']);
  assert.deepEqual(Object.keys(clients).sort(), ['before_sha256', 'harness_pid', 'kind', 'started_monotonic_ns', 'version']);
  assert.equal(before.version, 1); assert.equal(before.kind, 'blocked-service-before-clients');
  assert.equal(clients.version, 1); assert.equal(clients.kind, 'blocked-clients-start');
  assert.ok(Number.isSafeInteger(before.harness_pid) && before.harness_pid > 0);
  assert.equal(clients.harness_pid, before.harness_pid); assert.equal(before.source_request_count, 0);
  assert.match(beforeSha256, /^[a-f0-9]{64}$/); assert.equal(clients.before_sha256, beforeSha256);
  assert.match(before.captured_monotonic_ns, /^[1-9][0-9]*$/);
  assert.match(clients.started_monotonic_ns, /^[1-9][0-9]*$/);
  assert.equal(lifecycle[0]?.event, 'spawn');
  assert.ok(BigInt(before.captured_monotonic_ns) < BigInt(clients.started_monotonic_ns), 'The baseline was captured after clients could start');
  assert.ok(BigInt(clients.started_monotonic_ns) < BigInt(lifecycle[0].monotonicNs), 'The baseline client boundary was recorded after Pi started');
  assert.deepEqual(before.notion, initialServiceFacts(facts), 'The baseline differs from the full declared initial service facts');
  assert.deepEqual(after, before.notion, 'Blocked discovery changed original remote facts');
  assert.deepEqual(facts.contributions, []);
  assert.equal(facts.sample.notion.skills.some(row => row.id === facts.members[0].legacy_page_id), false);
  assert.equal(hash(expected.original.content), expected.original.sha256);
  assert.equal(hash(expected.patched.content), expected.patched.sha256);
  const replacement = expected.patch.files[0].replacements[0];
  assert.equal(expected.patched.content, expected.original.content.replace(replacement.from, replacement.to));
  assert.notEqual(expected.original.content, expected.patched.content);
  const declaredSource = one(facts.sample.notion.sources.filter(row => row.id === facts.source_page_id), 'Exact Source');
  const options = JSON.parse(text(field(declaredSource, facts.sample.notion.library.sources, 'Options')));
  assert.deepEqual(options.settings.member_patches, { [expected.member_key]: expected.patch });
  const markers = events.filter(row => row.kind === 'materialization_observer');
  assert.deepEqual(markers.map(row => row.event), ['start', 'end']);
  assert.ok(markers.every(row => row.observer_pid === pid));
  assert.equal(markers[1].code, 0); assert.deepEqual(markers[1].active_sdk_ids, []);
  const startTime = BigInt(markers[0].observer_monotonic_ns), endTime = BigInt(markers[1].observer_monotonic_ns);
  assert.ok(endTime > startTime);
  assert.ok(events.every(row => row.observer_pid === pid && BigInt(row.observer_monotonic_ns) >= startTime && BigInt(row.observer_monotonic_ns) <= endTime));
  const starts = events.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'start');
  const ends = events.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'end');
  assert.ok(starts.length > 0); assert.equal(new Set(starts.map(row => row.id)).size, starts.length);
  assert.deepEqual(starts.map(row => row.id).sort(), ends.map(row => row.id).sort());
  assert.ok(ends.every(row => row.status === 'completed'));
  for (const start of starts) {
    const end = one(ends.filter(row => row.id === start.id), 'Each SDK request has its original end');
    assert.equal(end.operation, start.operation);
    assert.ok(BigInt(end.observer_monotonic_ns) >= BigInt(start.observer_monotonic_ns));
  }
  const directory = one(events.filter(row => row.kind === 'context-broker.notion-sdk-result' && row.operation === 'source-members'), 'Actual SDK directory result');
  assert.ok(starts.some(row => row.id === directory.id && row.operation === 'source-members'));
  assert.equal(directory.value.coverage, 'complete'); assert.deepEqual(directory.value.failures, []);
  assert.equal(directory.value.effects.remote_writes, 'none');
  const candidate = one(directory.value.candidates, 'One exact blocked member');
  for (const key of ['source_id', 'member_key', 'expected_skill_id', 'expected_source_commit', 'expected_source_revision']) assert.equal(candidate[key], expected[key], key);
  assert.equal(candidate.library_id, facts.sample.notion.library.library_id);
  assert.equal(directory.value.library_id, candidate.library_id); assert.equal(directory.value.scope, candidate.scope);
  assert.match(candidate.scope, /^[a-f0-9]{64}$/); assert.match(candidate.registration_digest, /^[a-f0-9]{64}$/);
  assert.equal(candidate.description, expected.description); assert.equal(candidate.enabled, true);
  assert.equal(candidate.record, undefined); assert.equal(candidate.readiness, 'blocked');
  assert.equal(candidate.reason, 'CURRENT_SOURCE_WRITE_UNSUPPORTED');
  assert.equal(events.some(row => row.kind === 'context-broker.notion-materialization'), false, 'Blocked candidate reached management');
  assert.equal(events.some(row => row.kind === 'manager_transport'), false, 'A fixed manager was actually spawned');
  assert.equal(events.some(row => row.kind === 'child_process' && row.command !== 'git'), false, 'An alternate child bypassed the fixed manager observer');
  assert.equal(events.some(row => row.operation === 'consume'), false, 'A blocked missing member was consumed');
  assert.deepEqual(managerPids, [], 'The configured launcher accepted a process');
  assert.ok(source.length > 0 && source.every(row => !row.semantic_write && !row.projection_write));
  assert.ok(source.every(row => row.method === 'GET' || row.method === 'POST' && /\/(?:query|queries)$/.test(row.path)));
  assert.ok(git.length > 0 && git.every(row => row.status === 200 && row.exit_code === 0), 'Discovery must obtain real Git metadata');
  assert.equal(initial.session_file, observed.session_file); assert.equal(session.session_file, observed.session_file);
  for (const value of [initial, session]) assert.equal(value.branch.some(row => ['context-broker-selected-graph', 'context-broker-materialization'].includes(row.customType)), false);
  const prompt = '$' + facts.members[0].name + '@current-sdk Apply this Skill to the task.';
  const userTurns = session.branch.filter(row => row.type === 'message' && row.message?.role === 'user').map(row =>
    typeof row.message.content === 'string' ? row.message.content : row.message.content.filter(part => part.type === 'text').map(part => part.text).join(''));
  assert.ok(userTurns.includes(prompt), 'Actual qualified dollar input is required');
  assert.ok(frames.some(row => row.type === 'extension_ui_request' && row.method === 'notify' && row.message?.includes('SOURCE_MATERIALIZATION_BLOCKED')));
  assert.ok(frames.some(row => row.type === 'agent_end'), 'Ordinary controlled provider turn did not finish');
  assert.equal(lifecycle[0].event, 'spawn'); assert.equal(lifecycle[0].pid, pid);
  const close = one(lifecycle.filter(row => row.event === 'close'), 'Original actual Pi close');
  assert.equal(close.code, 0); assert.equal(close.signal, null); assert.equal(lifecycle.at(-1), close);
  assert.ok(BigInt(close.monotonicNs) >= endTime);
  return { candidate, sdk_operations: ends.length, manager_spawns: 0, consume_operations: 0, semantic_writes: 0, projection_writes: 0 };
}

export async function runBlockedMaterialization({ name, base, facts, first, manager, service, git, wire, steps, processes, rpc, step, finish, setPlan, checkWire, readManagerState }) {
  const managerBefore = await readManagerState(join(manager.roots.home, 'state.sqlite'));
  await save(join(base, 'blocked-manager-before.json'), managerBefore);
  service.setPhase('blocked-member'); git.setPhase('blocked-member'); processes[0].phase = 'blocked-member';
  await step('submit the qualified patched-member reference and capture the provider turn', async () => {
    setPlan({ mode: 'complete' });
    await rpc.prompt('$' + facts.members[0].name + '@current-sdk Apply this Skill to the task.');
    for (const item of wire) checkWire(item.body, [], [facts.blocked_member.original.content, facts.blocked_member.patched.content, facts.expected.required, facts.expected.sibling]);
    processes[0].provider_file = wire.at(-1).file;
  });
  const final = await finish('blocked-member');
  const managerAfter = await readManagerState(join(manager.roots.home, 'state.sqlite'));
  await save(join(base, 'blocked-manager-after.json'), managerAfter);
  assert.deepEqual(managerAfter, managerBefore); assert.deepEqual(managerBefore.rows, []);
  await save(join(base, 'after-blocked-member.json'), service.notion);
  const pids = await readFile(manager.pids, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const events = await rows(join(base, 'sdk.jsonl'));
  const outcome = assertBlockedMaterialization({ facts, ...await readBlockedMaterializationBefore(base), events, source: service.requests, git: git.requests,
    initial: await read(join(base, 'discovery-empty-session.json')), session: final, lifecycle: rpc.lifecycle,
    frames: rpc.frames, process: processes[0], after: service.notion, managerPids: pids.trim() ? pids.trim().split('\n') : [] });
  assert.deepEqual(service.unexpected, []); assert.deepEqual(git.unexpected, []);
  await save(join(base, 'blocked-member.json'), { version: 1, kind: 'actual-pi-blocked-source-member', ...outcome,
    process: processes[0], manager_binding: manager.binding, manager_state_unchanged: true, copied_consumer_state: false });
  return { name, status: 'passed', evidence: base, steps, provider_requests: wire.length, source_requests: service.requests.length,
    sdk_operations: outcome.sdk_operations, semantic_writes: 0, projection_writes: 0, process_exit: rpc.lifecycle.at(-1) };
}

export async function verifyBlockedMaterializationEvidence({ base, source, events, proofs, assertWireSources }) {
  const facts = await read(join(base, 'source-facts.json')), receipt = await read(join(base, 'blocked-member.json'));
  const manager = await read(join(base, 'manager/identity.json')), client = await read(join(base, 'client-1/launch.json'));
  assert.equal(receipt.version, 1); assert.equal(receipt.kind, 'actual-pi-blocked-source-member');
  assert.equal(receipt.copied_consumer_state, false); assert.equal(client.copied_consumer_state, false);
  assert.deepEqual(client.manager_binding, manager.binding); assert.deepEqual(receipt.manager_binding, manager.binding);
  assert.equal(manager.binding.kind, 'local'); assert.equal(manager.binding.library, facts.sample.notion.library.library_id);
  assert.equal(manager.binding.execution_id, manager.inventory.sha256); assert.equal(manager.binding.command, join(base, 'manager/launch'));
  assert.equal(hash(await readFile(manager.binding.command)), manager.launcher_sha256);
  assert.ok((await stat(manager.binding.command)).mode & 0o111);
  assert.deepEqual(await read(join(base, 'manager/server.json')), manager.config);
  assert.ok(client.manager_binding_file.path.startsWith(client.cwd + '/'));
  const bindingBytes = await readFile(client.manager_binding_file.path);
  assert.equal(hash(bindingBytes), client.manager_binding_file.sha256); assert.deepEqual(JSON.parse(bindingBytes), manager.binding);
  assert.deepEqual(manager.config.sources, [facts.source_id]); assert.equal(manager.config.library, manager.binding.library);
  assert.equal(manager.config.projection, 'none'); assert.ok(manager.config.notion_api_origin.startsWith('http://127.0.0.1:'));
  assert.equal(manager.config.generation.runtime, manager.tool_selection.node.path);
  assert.equal(manager.config.git.executable, manager.tool_selection.git.path);
  for (const role of ['node', 'git']) {
    const selected = manager.tool_selection[role]; assert.equal(selected.path, join(base, 'manager/tools', role));
    assert.notEqual(selected.source, selected.path); assert.equal(selected.sha256, selected.source_sha256);
    assert.equal(hash(await readFile(selected.path)), selected.sha256); assert.equal(selected.mode, 0o500);
  }
  assert.equal(manager.initialization.metrics.length, 1); assert.equal(manager.initialization.metrics[0].total_requests, 0);
  assert.equal(Object.keys(client.empty_consumer_roots).length, 3); assert.ok(Object.values(client.empty_consumer_roots).every(value => value === 'absent'));
  const pids = await readFile(join(base, 'manager/accepted-pids.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const outcome = assertBlockedMaterialization({ facts, ...await readBlockedMaterializationBefore(base), events, source, git: await rows(join(base, 'git-http.jsonl')),
    initial: await read(join(base, 'discovery-empty-session.json')), session: await read(join(base, 'blocked-member-final-session.json')),
    lifecycle: await read(join(base, 'blocked-member-rpc-lifecycle.json')), frames: await read(join(base, 'blocked-member-rpc.json')),
    process: receipt.process, after: await read(join(base, 'after-blocked-member.json')), managerPids: pids.trim() ? pids.trim().split('\n') : [] });
  for (const [key, value] of Object.entries(outcome)) assert.deepEqual(receipt[key], value);
  const before = await read(join(base, 'blocked-manager-before.json')), after = await read(join(base, 'blocked-manager-after.json'));
  assert.deepEqual(before, after); assert.deepEqual(before.rows, []); assert.equal(receipt.manager_state_unchanged, true);
  const expectedAbsent = [facts.blocked_member.original.content, facts.blocked_member.patched.content, facts.expected.required, facts.expected.sibling];
  const wire = await read(join(base, 'provider-index.json')); assert.ok(wire.length > 0);
  assert.deepEqual(proofs.map(row => row.provider_file).sort(), wire.map(row => row.file).sort());
  for (const proof of proofs) {
    assert.deepEqual(proof.present, []); assert.deepEqual(proof.absent.map(row => row.text), expectedAbsent);
    assertWireSources(await read(join(base, proof.provider_file)), [], expectedAbsent);
  }
}
