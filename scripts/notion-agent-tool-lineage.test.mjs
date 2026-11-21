import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { correlateNotionAgentToolAttempts, inspectNotionAgentReadOnlyContainer } from './notion-agent-tool-lineage.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const argsHash = value => sha(JSON.stringify(value));
function fixture() {
  const rootId = 'opaque-model-root', childId = 'independent-child-identity';
  const args = { code: 'const result = await tools.read({path:"/owned/SKILL.md"}); text(result);' };
  const child = { id: childId, name: 'read', arguments: { path: '/owned/SKILL.md' }, status: 'ok', durationMs: 3 };
  const native = { id: rootId, name: 'codemode', arguments: args, active: true, userEntryId: 'user',
    callLine: 3, resultLine: 4, assistantEntryId: 'assistant', resultEntryId: 'result', isError: false };
  const message = { role: 'toolResult', toolCallId: rootId, toolName: 'codemode', isError: false,
    content: [{ type: 'text', text: 'actual parent output' }], nestedCalls: { complete: true, calls: [child] },
    details: { calls: [{ id: childId, name: 'read', args: 'preview only', status: 'ok' }] } };
  const tasks = [
    { phase: 'tool_call', toolCallId: rootId, toolName: 'codemode', inputSha256: argsHash(args), selectors: {},
      toolSource: { path: 'builtin:codemode', source: 'builtin' } },
    { phase: 'tool_call', toolCallId: childId, toolName: 'read', inputSha256: argsHash(child.arguments), selectors: child.arguments },
    { phase: 'tool_result', toolCallId: childId, toolName: 'read', isError: false },
    { phase: 'tool_result', toolCallId: rootId, toolName: 'codemode', isError: false },
  ];
  const session = { supported: true, currentUserId: 'user', attempts: [native],
    branchEntries: [{ type: 'message', id: 'result', message }] };
  return { tasks, session, rootId, childId, native, message, child };
}
const inspect = value => correlateNotionAgentToolAttempts(value);
const codes = value => inspect(value).diagnostics.map(problem => problem.code);

test('opaque child IDs correlate through complete native census and direct structure, without ID parsing', () => {
  const value = fixture(), result = inspect(value);
  assert.equal(result.status, 'passed'); assert.deepEqual(result.counts, { actual: 2, topLevel: 1, nested: 1, errors: 0, retractedProposals: 0 });
  const child = result.attempts.find(call => call.id === value.childId), root = result.attempts[0];
  assert.equal(child.parentToolCallId, value.rootId); assert.equal(child.rootToolCallId, value.rootId);
  assert.equal(child.deliveryToolCallId, value.rootId); assert.equal(child.native.resultEntryId, 'result');
  assert.equal(child.provenance.parentEvidence, 'native-codemode-direct-census');
  assert.equal(child.native.syntheticFrom, 'native-nested-summary');
  assert.equal(inspectNotionAgentReadOnlyContainer(root, result, call => call.name === 'read').readOnly, true);
});

test('matching ID syntax cannot invent missing native nested execution evidence', () => {
  const value = fixture(); value.tasks[1].toolCallId = value.rootId + '/1'; value.tasks[2].toolCallId = value.rootId + '/1';
  delete value.message.nestedCalls; value.message.details.calls = [];
  const result = inspect(value);
  assert.equal(result.complete, false); assert.ok(result.diagnostics.some(problem => problem.code === 'NATIVE_TOOL_CORRELATION_MISSING'));
  assert.equal(inspectNotionAgentReadOnlyContainer(result.attempts[0], result, () => true).readOnly, false);
});

test('missing, truncated, unfinished, and unobserved children never provide complete coverage', () => {
  for (const change of [
    value => { value.message.nestedCalls.complete = false; },
    value => { delete value.child.arguments; value.child.argumentsBytes = 9000; },
    value => { value.child.status = 'unfinished'; },
    value => { value.tasks.splice(2, 1); },
    value => { value.tasks.splice(1, 2); },
  ]) {
    const value = fixture(); change(value);
    const result = inspect(value); assert.equal(result.complete, false);
    assert.equal(inspectNotionAgentReadOnlyContainer(result.attempts[0], result, () => true).readOnly, false);
  }
});

test('full nested arguments are checked against actual input hashes rather than UI previews', () => {
  const value = fixture(); value.child.arguments = { path: '/owned/' + 'long'.repeat(400) + '.md' };
  value.tasks[1].inputSha256 = argsHash(value.child.arguments); value.tasks[1].selectors = value.child.arguments;
  value.message.details.calls[0].args = '{"path":"truncated…';
  assert.equal(inspect(value).status, 'passed');
  value.tasks[1].inputSha256 = 'b'.repeat(64);
  assert.ok(codes(value).includes('TOOL_INPUT_HASH_MISMATCH')); assert.equal(inspect(value).status, 'failed');
});

test('a readonly-looking script cannot conceal a write child or unobserved model operation', () => {
  const value = fixture(); value.child.name = 'write'; value.tasks[1].toolName = 'write'; value.tasks[2].toolName = 'write';
  value.message.details.calls[0].name = 'write';
  const result = inspect(value);
  assert.equal(result.status, 'passed');
  assert.equal(inspectNotionAgentReadOnlyContainer(result.attempts[0], result, call => call.name === 'read').readOnly, false);
  const model = fixture(); model.message.details.calls.push({ id: 'opaque-model-operation', name: 'models.generateImages', status: 'ok' });
  const observed = inspect(model); assert.equal(observed.status, 'passed');
  assert.equal(observed.containers[0].complete, false);
  assert.equal(observed.containers[0].diagnostics[0].code, 'CODEMODE_UNOBSERVED_DIRECT_EFFECT');
});

test('failed children remain actual attempts and require matching terminal error status', () => {
  const value = fixture(); value.child.status = 'error'; value.tasks[2].isError = true; value.message.details.calls[0].status = 'error';
  const result = inspect(value); assert.equal(result.status, 'passed'); assert.equal(result.counts.errors, 1);
  assert.equal(inspectNotionAgentReadOnlyContainer(result.attempts[0], result, call => call.name === 'read').readOnly, true);
  value.tasks[2].isError = false; assert.equal(inspect(value).status, 'failed');
  assert.ok(codes(value).includes('TOOL_RESULT_STATUS_MISMATCH'));
});

test('explicit callback ancestry supports deeper nesting and preserves result artifacts', () => {
  const value = fixture(), grandchild = { id: 'another-opaque-identity', name: 'read',
    arguments: { path: '/owned/reference.md' }, status: 'ok', durationMs: 1 };
  value.message.nestedCalls.calls.push(grandchild);
  value.tasks[1].parentToolCallId = value.rootId; value.tasks[2].parentToolCallId = value.rootId;
  const proof = { path: '/private/result.json', sha256: 'c'.repeat(64), bytes: 50 };
  value.tasks.splice(2, 0,
    { phase: 'tool_call', toolCallId: grandchild.id, toolName: 'read', inputSha256: argsHash(grandchild.arguments), selectors: grandchild.arguments, parentToolCallId: value.childId },
    { phase: 'tool_result', toolCallId: grandchild.id, toolName: 'read', isError: false, parentToolCallId: value.childId,
      inputSha256: argsHash(grandchild.arguments), contentArtifact: proof });
  const result = inspect(value); assert.equal(result.status, 'passed');
  const actual = result.attempts.find(call => call.id === grandchild.id);
  assert.equal(actual.parentToolCallId, value.childId); assert.equal(actual.deliveryToolCallId, value.rootId);
  assert.deepEqual(actual.result.contentArtifact, proof);
  assert.deepEqual(result.containers[0].descendantIds, [value.childId, grandchild.id]);
});

test('contradictory parent callbacks and results outside parent lifetime are blocked', () => {
  const value = fixture(); value.tasks[1].parentToolCallId = 'wrong'; value.tasks[2].parentToolCallId = 'wrong';
  assert.equal(inspect(value).status, 'failed'); assert.ok(codes(value).includes('NESTED_TOOL_PARENT_CONFLICT'));
  const late = fixture(); [late.tasks[2], late.tasks[3]] = [late.tasks[3], late.tasks[2]];
  assert.ok(codes(late).includes('NESTED_TOOL_LIFETIME_UNPROVEN'));
});

test('callbacks cannot duplicate or omit an input hash to inflate or invent execution', () => {
  const value = fixture(); value.tasks.splice(2, 0, structuredClone(value.tasks[1]));
  assert.equal(inspect(value).status, 'failed'); assert.ok(codes(value).includes('TOOL_CALLBACK_DUPLICATED'));
  const missing = fixture(); delete missing.tasks[1].inputSha256;
  assert.equal(inspect(missing).complete, false); assert.ok(codes(missing).includes('TOOL_INPUT_HASH_MISSING'));
});

test('native retracted proposals stay separate from actual dispatch and effects', () => {
  const value = fixture(); value.session.attempts.push({ id: 'unexecuted-notion-use', name: 'notion_use',
    arguments: { ref: 'chosen-ref' }, active: true, userEntryId: 'user', retractedLine: 7 });
  const result = inspect(value); assert.equal(result.status, 'passed'); assert.equal(result.counts.actual, 2);
  assert.equal(result.counts.retractedProposals, 1);
  assert.equal(result.retractedProposals[0].phase, 'proposed_retracted'); assert.equal(result.retractedProposals[0].dispatched, false);
});

test('complete empty builtin composition is distinct from missing census or replacement implementation', () => {
  const value = fixture(); value.tasks.splice(1, 2); delete value.message.nestedCalls; value.message.details.calls = [];
  const result = inspect(value); assert.equal(result.status, 'passed'); assert.equal(result.containers[0].complete, true);
  assert.equal(inspectNotionAgentReadOnlyContainer(result.attempts[0], result, () => false).readOnly, true);
  value.tasks[0].toolSource = { path: '/unreviewed/codemode.js', source: 'package' };
  assert.equal(inspect(value).containers[0].complete, false);
  delete value.tasks[0].toolSource; delete value.message.details;
  assert.equal(inspect(value).containers[0].complete, false);
});

test('missing implementation provenance cannot certify zero writes even when lineage is complete', () => {
  for (const source of [undefined, null, {}, { path: 'builtin:codemode', source: 'package' }, { path: '/replacement/codemode.js', source: 'builtin' }]) {
    const value = fixture(); value.tasks[0].toolSource = source;
    const result = inspect(value);
    assert.equal(result.status, 'passed', 'Actual attempt correlation is separate from implementation effects');
    assert.equal(result.counts.actual, 2); assert.equal(result.counts.nested, 1);
    assert.equal(result.containers[0].complete, false);
    assert.equal(inspectNotionAgentReadOnlyContainer(result.attempts[0], result, call => call.name === 'read').readOnly, false);
    assert.ok(result.containers[0].diagnostics.some(value => value.code.startsWith('CODEMODE_IMPLEMENTATION_')));
  }
});
