import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assertNativeGuidance, assertScopedCommand, reconcile, sourceFinality } from './notion-sdk-pi.mjs';

const command = ['/absolute/node', '/installed/dist/ntn-skills.mjs'];
const database = '11111111-2222-3333-4444-555555555555';
const toolNames = ['read', 'skill_search', 'skill_prepare', 'bash', 'skill_graph'];
const guidance = '<ntn-skills-guidance>Use supplied bodies. Request cli_source only for an intended source.</ntn-skills-guidance>';
const context = () => ({ messages: [
  { role: 'system', content: 'Controlled system instructions.', toolsAdded: toolNames.map(name => ({ name })) },
  { role: 'user', content: guidance },
] });

function scopeFixture() {
  const result = { kind: 'host_cli_scope', command, database, sourceId: 'sdk-fixture', executed: false };
  const content = [{ type: 'text', text: JSON.stringify(result) }];
  const first = context(), second = context();
  second.messages.push({ role: 'toolResult', toolCallId: 'sc05-source-command', content, details: result, isError: false });
  const frames = [
    { type: 'tool_execution_start', toolName: 'skill_graph', toolCallId: 'sc05-source-command', args: { cli_source: 'sdk-fixture' } },
    { type: 'tool_execution_end', toolCallId: 'sc05-source-command', isError: false, result: { content, details: result } },
  ];
  return { captures: [{ context: first }, { context: second }], frames };
}
const expected = { command, database };

test('native-guidance evidence checks only host guidance and preserves complete author text', () => {
  const input = context();
  input.messages.push({ role: 'user', content: `Author body: <cli>${command[1]}</cli> <read-args>read REF</read-args>` });
  const before = JSON.stringify(input);
  assert.equal(assertNativeGuidance(input, command[1]).legacy_cli_templates, false);
  assert.equal(JSON.stringify(input), before);
  for (const bad of ['<cli source="fixture">node</cli>', '<read-args>read REF</read-args>', command[1]]) {
    const stale = context();
    stale.messages[1].content = `<ntn-skills-guidance>${bad}</ntn-skills-guidance>`;
    assert.throws(() => assertNativeGuidance(stale, command[1]));
  }
});

test('missing actual capabilities and duplicate or missing host guidance cannot pass', () => {
  const noPrepare = context(); noPrepare.messages[0].toolsAdded = noPrepare.messages[0].toolsAdded.filter(tool => tool.name !== 'skill_prepare');
  assert.throws(() => assertNativeGuidance(noPrepare, command[1]), /Actual provider/);
  const duplicate = context(); duplicate.messages.push({ role: 'user', content: guidance });
  assert.throws(() => assertNativeGuidance(duplicate, command[1]), /one current host guidance/);
  const missing = context(); missing.messages = missing.messages.filter(message => message.role === 'system');
  assert.throws(() => assertNativeGuidance(missing, command[1]), /one current host guidance/);
});

test('Pi transcript capabilities apply system removals then additions and ignore user declarations', () => {
  const changed = context();
  changed.messages.push({ role: 'system', content: '', toolsRemoved: [{ name: 'read' }, { name: 'bash' }], toolsAdded: [{ name: 'read', description: 'replacement' }] });
  changed.messages.push({ role: 'user', content: 'Not a system declaration.', toolsAdded: [{ name: 'bash' }] });
  assert.equal(assertNativeGuidance(changed, command[1]).tools.includes('bash'), false);
  changed.messages.push({ role: 'system', content: '', toolsRemoved: [{ name: 'read' }] });
  changed.tools = [{ name: 'read' }];
  assert.throws(() => assertNativeGuidance(changed, command[1]), /Actual provider must expose read/);
});

test('scoped command requires one real graph query and verbatim exact source receipt', () => {
  const { captures, frames } = scopeFixture();
  const before = JSON.stringify({ captures, frames });
  const verified = assertScopedCommand(captures, frames, expected);
  assert.equal(verified.receipt_delivered_verbatim, true);
  assert.equal(verified.model_bash_calls, 0);
  assert.deepEqual(verified.command, command);
  assert.equal(JSON.stringify({ captures, frames }), before);
});

test('pre-injected executable, missing bash, another query or a bash call fails the scoped route', () => {
  const preInjected = scopeFixture();
  preInjected.captures[0].context.messages.push({ role: 'user', content: command[1] });
  assert.throws(() => assertScopedCommand(preInjected.captures, preInjected.frames, expected), /First provider request/);
  const missingBash = scopeFixture();
  missingBash.captures[0].context.messages[0].toolsAdded = missingBash.captures[0].context.messages[0].toolsAdded.filter(tool => tool.name !== 'bash');
  assert.throws(() => assertScopedCommand(missingBash.captures, missingBash.frames, expected));
  const wrongQuery = scopeFixture(); wrongQuery.frames[0].args.cli_source = 'other-source';
  assert.throws(() => assertScopedCommand(wrongQuery.captures, wrongQuery.frames, expected));
  const extraBash = scopeFixture();
  extraBash.frames.push({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'extra', args: { command: 'true' } });
  assert.throws(() => assertScopedCommand(extraBash.captures, extraBash.frames, expected), /no bash or body read/);
});

test('wrong source, database, command or missing receipt content cannot be treated as a scoped result', () => {
  for (const changed of [{ sourceId: 'other-source' }, { database: 'other-database' }, { command: ['node', '/other/cli'] }, { executed: true }]) {
    const fixture = scopeFixture();
    const message = fixture.captures[1].context.messages.at(-1);
    message.content = [{ type: 'text', text: JSON.stringify({ ...message.details, ...changed }) }];
    assert.throws(() => assertScopedCommand(fixture.captures, fixture.frames, expected));
  }
  const missing = scopeFixture(); missing.captures[1].context.messages.pop();
  assert.throws(() => assertScopedCommand(missing.captures, missing.frames, expected), /Public tool result/);
  const altered = scopeFixture(); altered.frames[1].result.content = [{ type: 'text', text: '{"different":true}' }];
  assert.throws(() => assertScopedCommand(altered.captures, altered.frames, expected), /complete exact tool receipt/);
});

function observed(fields) {
  let previous = null;
  return fields.map((item, index) => {
    const payload = { version: 1, observer_pid: 42, sequence: index + 1, monotonic_ns: String(index + 1), previous_sha256: previous, ...item };
    previous = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return { ...payload, sha256: previous };
  });
}
const lifecycle = [{ event: 'spawn', pid: 42 }, { event: 'close', pid: 42, code: 0, signal: null }];
const catalog = [
  { kind: 'observer_start', exec_path: command[0] },
  { kind: 'child_start', id: '42:1', bundled: true, operation: 'list', argv: [command[1], 'list'] },
  { kind: 'child_close', id: '42:1', code: 0, signal: null, request_metrics: { complete: true, total_requests: 0 } },
  { kind: 'observer_end', code: 0, active_sdk: 0, active_children: 0 },
];

test('metadata-only scope does not weaken the existing mandatory SDK transport assertion', () => {
  assert.throws(() => reconcile(observed(catalog), lifecycle), /empty SDK observation/);
  const scope = reconcile(observed(catalog), lifecycle, { bodyTransportRequired: false });
  assert.equal(scope.default_body_transport, 'not_applicable_metadata_query');
  assert.equal(scope.sdk_calls, 0);
  assert.equal(scope.source_children_closed, 1);
  const doctor = structuredClone(catalog); doctor[1].operation = 'ctl'; doctor[1].argv = [command[1], 'ctl', 'doctor'];
  assert.throws(() => reconcile(observed(doctor), lifecycle, { bodyTransportRequired: false }), /background catalog\/identity/);
  assert.throws(() => reconcile(observed(catalog.filter(item => item.kind !== 'child_close')), lifecycle, { bodyTransportRequired: false }));
});

const childTerminal = [
  { kind: 'observer_start', observer_pid: 42, parent_pid: 10 },
  { kind: 'child_start', observer_pid: 42, id: '42:1' },
  { kind: 'child_spawn', observer_pid: 42, id: '42:1', child_pid: 43 },
  { kind: 'observer_start', observer_pid: 43, parent_pid: 42 },
  { kind: 'observer_end', observer_pid: 43, code: 0, active_sdk: 0, active_children: 0 },
  { kind: 'child_close', observer_pid: 42, id: '42:1', child_pid: 43, code: 0, signal: null },
];
const hostEnd = { kind: 'observer_end', observer_pid: 42, code: 0, active_sdk: 0, active_children: 0 };

test('source drain before EOF does not wait on host exit; final sealing does', () => {
  assert.equal(sourceFinality(childTerminal, 42).complete, true);
  assert.equal(sourceFinality(childTerminal, 42, { hostClosed: true }).complete, false);
  assert.equal(sourceFinality([...childTerminal, hostEnd], 42, { hostClosed: true }).complete, true);
  assert.equal(sourceFinality([], 42, { hostClosed: true }).complete, false);
});

test('PID identity alone, a missing close, or a child lacking its observed end cannot seal', () => {
  for (const missing of ['child_spawn', 'child_close']) {
    assert.equal(sourceFinality(childTerminal.filter(event => event.kind !== missing), 42).complete, false);
  }
  assert.equal(sourceFinality(childTerminal.filter(event => !(event.kind === 'observer_end' && event.observer_pid === 43)), 42).complete, false);
  const wrongParent = structuredClone(childTerminal); wrongParent[3].parent_pid = 99;
  assert.equal(sourceFinality(wrongParent, 42).complete, false);
  const wrongClose = structuredClone(childTerminal); wrongClose[5].child_pid = 99;
  assert.equal(sourceFinality(wrongClose, 42).complete, false);
});

test('late child exit after a stopped host never supplies its missing parent close', () => {
  const stopped = childTerminal.filter(event => !['child_close', 'observer_end'].includes(event.kind));
  stopped.push({ ...hostEnd, code: 143, active_children: 1 });
  assert.equal(sourceFinality(stopped, 42, { hostClosed: true }).complete, false);
  stopped.push(childTerminal[4]);
  const final = sourceFinality(stopped, 42, { hostClosed: true });
  assert.equal(final.complete, false);
  assert.ok(final.pending.some(item => item.kind === 'child_close'));
  assert.ok(final.pending.some(item => item.kind === 'observer_end' && item.pid === 42));
});

test('an unfinished SDK call or unmatched observer remains unresolved even after known children close', () => {
  const events = [...childTerminal, { kind: 'sdk', event: 'start', observer_pid: 42, id: 'sdk-1' }];
  assert.equal(sourceFinality(events, 42).complete, false);
  events.push({ kind: 'sdk', event: 'end', observer_pid: 42, id: 'sdk-1' });
  assert.equal(sourceFinality(events, 42).complete, true);
  events.push({ kind: 'observer_start', observer_pid: 44, parent_pid: 42 }, { ...hostEnd, observer_pid: 44 });
  assert.equal(sourceFinality(events, 42).complete, false);
});
