import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { blockedMaterializationFacts, assertBlockedMaterialization } from './notion-sdk-pi-blocked-materialization.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function proof() {
  const content = '---\nname: lazy-root\ndescription: Original lazy root fixture.\n---\n\n# Complete original root instructions\n';
  const original = { initial: 'source-only', source_id: 'fixture-source', source_page_id: 'source-page', revision: 'a'.repeat(64), contributions: [],
    members: [{ name: 'lazy-root', member_key: 'skills/lazy-root', legacy_page_id: 'missing-owner',
      files: [{ path: 'SKILL.md', content, sha256: hash(content), bytes: Buffer.byteLength(content), git_oid: 'b'.repeat(40) }] }],
    expected: { root: content, required: 'Complete required body', sibling: 'Complete sibling body' },
    sample: { source_materialization: { commit: 'c'.repeat(40) }, notion: { library: { library_id: 'library', sources: { property_ids: { Options: 'options' } } },
      skills: [], sources: [{ id: 'source-page', properties: { Options: { id: 'options', type: 'rich_text', rich_text: [{ plain_text: '{}' }] } } }] } } };
  const facts = blockedMaterializationFacts(original), candidate = { type: 'source_member',
    ...Object.fromEntries(['source_id', 'member_key', 'expected_skill_id', 'expected_source_commit', 'expected_source_revision'].map(key => [key, facts.blocked_member[key]])),
    name: 'lazy-root', alias: 'lazy-root', description: facts.blocked_member.description,
    library_id: 'library', scope: 'd'.repeat(64), registration_digest: 'e'.repeat(64), enabled: true,
    readiness: 'blocked', reason: 'CURRENT_SOURCE_WRITE_UNSUPPORTED' };
  const events = [
    { kind: 'materialization_observer', event: 'start' },
    { kind: 'context-broker.notion-sdk', event: 'start', operation: 'source-members', id: 'directory' },
    { kind: 'context-broker.notion-sdk-result', operation: 'source-members', id: 'directory', value: {
      coverage: 'complete', failures: [], effects: { remote_writes: 'none' }, library_id: 'library', scope: candidate.scope, candidates: [candidate] } },
    { kind: 'context-broker.notion-sdk', event: 'end', operation: 'source-members', id: 'directory', status: 'completed' },
    { kind: 'materialization_observer', event: 'end', code: 0, active_sdk_ids: [] },
  ].map((row, i) => ({ ...row, observer_pid: 123, observer_monotonic_ns: String(i + 1) }));
  return { original, facts, events, source: [{ method: 'GET', path: '/v1/source' }], git: [{ status: 200, exit_code: 0 }],
    initial: { session_file: '/owned/session', branch: [] },
    session: { session_file: '/owned/session', branch: [{ type: 'message', message: { role: 'user', content: '$lazy-root@current-sdk Apply this Skill to the task.' } }] },
    lifecycle: [{ event: 'spawn', pid: 123, monotonicNs: '0' }, { event: 'close', code: 0, signal: null, monotonicNs: '6' }],
    frames: [{ type: 'extension_ui_request', method: 'notify', message: 'SOURCE_MATERIALIZATION_BLOCKED' }, { type: 'agent_end' }],
    process: { pid: 123, session_file: '/owned/session' }, after: structuredClone(facts.sample.notion), managerPids: [] };
}
const candidate = value => value.events[2].value.candidates[0];
test('blocked proof uses an authored patch without changing the original Git bytes', () => {
  const value = proof();
  assert.equal(value.original.members[0].files[0].content, value.facts.blocked_member.original.content);
  assert.equal(value.original.sample.notion.sources[0].properties.Options.rich_text[0].plain_text, '{}');
  assert.equal(value.facts.blocked_member.patched.bytes, value.facts.blocked_member.original.bytes + 2);
  assert.deepEqual(assertBlockedMaterialization(value), { candidate: candidate(value), sdk_operations: 1,
    manager_spawns: 0, consume_operations: 0, semantic_writes: 0, projection_writes: 0 });
});
const append = (value, row) => value.events.splice(4, 0, { ...row, observer_pid: 123, observer_monotonic_ns: '4' });
for (const [label, corrupt] of [
  ['old false-positive candidate', value => { candidate(value).readiness = 'materializable'; }],
  ['missing capability reason', value => { delete candidate(value).reason; }],
  ['foreign Source member', value => { candidate(value).source_id = 'other-source'; }],
  ['missing observer terminal', value => { value.events.pop(); }],
  ['pending SDK request', value => { value.events.at(-1).active_sdk_ids = ['directory']; }],
  ['missing SDK completion', value => { value.events.splice(3, 1); }],
  ['actual manager spawn', value => append(value, { kind: 'manager_transport', event: 'spawn', child_pid: 456 })],
  ['alternate child dispatch', value => append(value, { kind: 'child_process', command: 'node' })],
  ['ordinary consume', value => append(value, { kind: 'context-broker.notion-sdk-result', operation: 'consume' })],
  ['write with hidden marker', value => { value.source[0] = { method: 'PATCH', path: '/v1/pages/owner', semantic_write: false }; }],
  ['changed remote facts', value => { value.after.skills.push({ id: 'new-owner' }); }],
  ['manager launcher execution', value => { value.managerPids.push('456'); }],
  ['foreign observer PID', value => { value.events[2].observer_pid = 999; }],
  ['missing original Pi close', value => { value.lifecycle.pop(); }],
  ['nonzero actual Pi exit', value => { value.lifecycle.at(-1).code = 1; }],
  ['missing qualified input', value => { value.session.branch = []; }],
  ['missing user diagnostic', value => { value.frames.shift(); }],
  ['altered authored patch', value => { value.facts.sample.notion.sources[0].properties.Options.rich_text[0].plain_text = '{"settings":{"member_patches":{}}}'; }],
]) test('blocked proof rejects ' + label, () => { const value = proof(); corrupt(value); assert.throws(() => assertBlockedMaterialization(value)); });
