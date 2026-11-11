import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import * as candidate from './verify-pi-daily-candidate.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const payload = () => ({ model: 'group/worker', stream: true, stream_options: { include_usage: true }, store: false,
  max_completion_tokens: 456572, reasoning_effort: 'high', messages: [{ role: 'user', content: 'Unchanged original project task.' }],
  tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] });
const baseConfig = { version: 1, scope: 'project-scoped-candidate-print', id: 'budget-preflight', arm: 'notion-only',
  model: 'magpie/group/worker', thinkingLevel: 'high', project: 'owned-ticket-service', prompt: 'Original task' };

test('completion cap is absent by default and only explicit 32768 passes before launcher I/O', async () => {
  assert.equal(candidate.candidateCompletionBudgetSource(), undefined);
  for (const value of [null, false, true, 0, 16384, 32767, 32769, '32768', {}, NaN]) {
    assert.throws(() => candidate.candidateCompletionBudgetSource(value), /32768/);
    await assert.rejects(candidate.runCandidatePrint({ ...baseConfig, maxCompletionTokens: value }), /32768/);
  }
});

async function registerPolicy(api) {
  const source = candidate.candidateCompletionBudgetSource(32768);
  const extension = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  extension.default(api);
}

test('standalone public payload policy changes only the completion ceiling and preserves stricter input', async () => {
  const handlers = [];
  await registerPolicy({ on(name, handler) { assert.equal(name, 'before_provider_request'); handlers.push(handler); } });
  assert.equal(handlers.length, 1);
  const original = payload(), before = structuredClone(original);
  const changed = handlers[0]({ payload: original });
  assert.deepEqual(original, before); assert.notEqual(changed, original);
  assert.deepEqual(changed, { ...before, max_completion_tokens: 32768 });
  assert.equal(candidate.inspectCandidateCompletionBudget(changed).maxCompletionTokens, 32768);
  for (const prior of [8192, 32768]) assert.equal(handlers[0]({ payload: { ...before, max_completion_tokens: prior } }).max_completion_tokens, prior);
  for (const prior of [undefined, null, 0, -1, '456572']) assert.equal(handlers[0]({ payload: { ...before, max_completion_tokens: prior } }).max_completion_tokens, 32768);
});

// This controlled dispatch uses the installed public runner's replacement
// semantics: non-undefined return becomes currentPayload for the next handler.
// It does not start Pi, send HTTP, or stand in for the later actual wire audit.
async function observedDispatch({ policyFirst, laterChange } = {}) {
  const handlers = [], records = [], files = new Map();
  const api = { on(name, handler) { if (name === 'before_provider_request') handlers.push(handler); } };
  if (policyFirst) await registerPolicy(api);
  candidate.observeCandidateTask(api, { fs: { openSync: () => 1, writeSync: (_fd, line) => records.push(JSON.parse(line)),
    writeFileSync: (path, text) => files.set(path, text), closeSync() {} }, crypto: { createHash }, output: '/owned/tasks.jsonl',
    bodyFiles: [], inspectPayload: candidate.candidatePayloadBodies, payloadDirectory: '/owned/payloads' });
  if (!policyFirst) await registerPolicy(api);
  if (laterChange) handlers.push(event => laterChange(event.payload));
  const original = payload(), before = structuredClone(original);
  let current = original;
  for (const handler of handlers) { const replacement = await handler({ payload: current }, {}); if (replacement !== undefined) current = replacement; }
  assert.deepEqual(original, before);
  const sent = JSON.stringify(current), captured = records.find(event => event.phase === 'provider_payload');
  assert.equal(files.get(captured.payloadFile), JSON.stringify(JSON.parse(files.get(captured.payloadFile))));
  return { sent, current, captured, capturedPayload: JSON.parse(files.get(captured.payloadFile)), observations: {
    costs: [{ phase: 'provider_request', payload: { sha256: captured.sha256, bytes: captured.bytes, verifiedBodyOccurrences: [] } }],
    transport: [{ phase: 'request_start', id: 1, category: 'model' }, { phase: 'request_sent', id: 1, requestBodySha256: hash(sent), requestBodyBytes: Buffer.byteLength(sent) },
      { phase: 'request_end', id: 1, category: 'model', status: 200, outcome: 'completed' }],
    tasks: [captured, { phase: 'assistant_final', success: true, sha256: 'final', bytes: 5 }],
  } };
}

test('policy before passive capture binds the final dispatch bytes; old order and later edits fail wire identity', async () => {
  const good = await observedDispatch({ policyFirst: true });
  assert.equal(good.captured.sha256, hash(good.sent)); assert.equal(good.captured.bytes, Buffer.byteLength(good.sent));
  assert.deepEqual(good.capturedPayload, good.current);
  assert.equal(candidate.inspectCandidateCompletionBudget(good.capturedPayload).maxCompletionTokens, 32768);
  assert.equal(candidate.validateCandidateTurn({}, good.observations).providerRequests, 1);
  for (const bad of [await observedDispatch({ policyFirst: false }), await observedDispatch({ policyFirst: true, laterChange: value => ({ ...value, max_completion_tokens: 32769 }) })])
    assert.throws(() => candidate.validateCandidateTurn({}, bad.observations), /actually sent HTTP body/);
});

test('actual budget acceptance rejects any other model, thinking, cap, or competing max_tokens field', () => {
  const good = { ...payload(), max_completion_tokens: 32768 };
  assert.equal(candidate.inspectCandidateCompletionBudget(good).maxCompletionTokens, 32768);
  for (const mutation of [value => { value.model = 'group/flash'; }, value => { value.reasoning_effort = 'medium'; },
    value => { delete value.max_completion_tokens; }, value => { value.max_completion_tokens = 32769; },
    value => { value.max_completion_tokens = 8192; }, value => { value.max_tokens = 32768; }]) {
    const wrong = structuredClone(good); mutation(wrong); assert.throws(() => candidate.inspectCandidateCompletionBudget(wrong));
  }
});

test('cap-only acceptance retains and rejects an earlier native length even after retraction and a later stop', () => {
  const rows = [
    { type: 'session', id: 'fresh-budget-session', version: 3 },
    { type: 'model_change', id: 'model', parentId: null, provider: 'magpie', modelId: 'group/worker' },
    { type: 'message', id: 'user', parentId: 'model', message: { role: 'user', content: [{ type: 'text', text: 'Original task' }] } },
    { type: 'message', id: 'truncated', parentId: 'user', message: { role: 'assistant', provider: 'magpie', model: 'group/worker',
      stopReason: 'length', content: [{ type: 'text', text: 'Partial output' }] } },
    { type: 'context_edit', id: 'retract', parentId: 'truncated', targetId: 'truncated', replacement: null },
    { type: 'message', id: 'recovered', parentId: 'retract', message: { role: 'assistant', provider: 'magpie', model: 'group/worker',
      stopReason: 'stop', content: [{ type: 'text', text: 'Later output' }] } },
  ];
  const inspect = value => candidate.inspectCandidatePrintSession(value.map(row => JSON.stringify(row)).join('\n') + '\n',
    { provider: 'magpie', model: 'group/worker' });
  const native = inspect(rows), before = structuredClone(native);
  assert.deepEqual(native.finals.map(final => final.stopReason), ['length', 'stop']);
  assert.throws(() => candidate.validateCandidateCompletionHistory(native), /length/);
  assert.deepEqual(native, before, 'The failed length remains in the native audit');
  const complete = structuredClone(rows); complete[3].message.stopReason = 'stop';
  assert.deepEqual(candidate.validateCandidateCompletionHistory(inspect(complete)), { nativeFinalResponses: 2, lengthResponses: 0 });
});
