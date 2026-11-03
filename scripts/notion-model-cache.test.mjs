import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verificationCliEnvironment } from './verification-paths.mjs';
import { invokeJson } from './verification-command.mjs';
import { assertModelCase, requestCounts, cacheCaseDirectory, modelAvailabilityFailure } from './verify-pi-notion-model-cache.mjs';
import { observe } from './notion-integration-model.mjs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

const expected = ['WORKFLOW-A', 'CHECKLIST-A', 'HOLD', 'CODE-1'];
const good = () => [
  { phase: 'request', skillBodies: 0, resourceBodies: 0, completeContents: [] },
  { phase: 'response', status: 200 },
  { phase: 'tool_result', kind: 'skill', role: 'entrypoint', bodyMatchesFile: true, receiptValidated: true, snapshot: 's_fixture' },
  { phase: 'tool_result', kind: 'resource', resourceSuccess: true, snapshot: 's_fixture' },
  { phase: 'request', skillBodies: 1, resourceBodies: 1, completeContents: ['entrypoint', 'resource'].map(role => ({ role, snapshot: 's_fixture', copies: 1, materialization: 'snapshot', manifestComplete: true })) },
  { phase: 'assistant_final', success: true, bytes: 100, stopReason: 'stop', text: expected.join(' ') },
];
const sourceRequests = [
  { kind: 'cli', phase: 'started', command: 'read', requestId: 'read' },
  { kind: 'http', phase: 'attempt', request_kind: 'notion_body', method: 'GET', requestId: 'read' },
  { kind: 'http', phase: 'attempt', request_kind: 'notion_metadata', method: 'POST', requestId: 'read' },
  { kind: 'http', phase: 'attempt', request_kind: 'notion_metadata', method: 'POST', requestId: 'read' },
  { kind: 'metrics', phase: 'metrics', observed: true, complete: true, requestId: 'read' },
  { kind: 'cli', phase: 'started', command: 'export', requestId: 'export' },
  { kind: 'metrics', phase: 'metrics', observed: true, complete: true, requestId: 'export' },
];

test('oracle and consumer roots are disjoint without copying or changing inherited credentials', () => {
  const inherited = { HOME: '/actual/home', NOTION_API_TOKEN: 'controlled-fixture-secret', NTN_SKILLS_HOME: '/old/state' };
  const oracle = verificationCliEnvironment('/owned/oracle', inherited), consumer = verificationCliEnvironment('/owned/consumer', inherited);
  for (const key of Object.keys(oracle).filter(key => /^(NTN_SKILLS_|XDG_)/.test(key))) assert.notEqual(oracle[key], consumer[key]);
  assert.equal(oracle.NOTION_API_TOKEN, inherited.NOTION_API_TOKEN);
  assert.equal(inherited.NTN_SKILLS_HOME, '/old/state');
});
test('invocation executes inside the explicitly selected mutable environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'model-cache-environment-'));
  const value = await invokeJson([process.execPath], ['-e', 'console.log(JSON.stringify({ok:true,state:process.env.NTN_SKILLS_HOME}))'], { cwd: root, env: verificationCliEnvironment(join(root, 'oracle')) });
  assert.equal(value.state, join(root, 'oracle', 'state'));
});
test('autonomous cold evidence requires actual native read, body I/O, verified materialization and complete model content', () => {
  assert.equal(assertModelCase(good(), expected, { native: true, cold: true, requestEvents: sourceRequests }).providerRequests, 2);
});
test('entry materialization preserves full provider byte receipts without claiming a complete export', () => {
  const events = good(); events[4].completeContents.forEach(file => { file.materialization = 'entry'; });
  const requests = sourceRequests.filter(row => row.requestId !== 'export');
  assert.equal(assertModelCase(events, expected, { native: true, cold: true, requestEvents: requests }).requests.exports, 0);
  const partial = good(); partial[4].completeContents = [];
  assert.throws(() => assertModelCase(partial, expected), /complete verified main/);
});
test('HTTP success and a Premium license message cannot be counted as model acceptance', () => {
  const events = good(); events.at(-1).text = 'This model requires a Premium license.';
  assert.throws(() => assertModelCase(events, expected), /selected source value/);
});
test('only an actual provider availability response permits model fallback, not an assertion or tool-chain failure', () => {
  assert.equal(modelAvailabilityFailure(good()), false);
  assert.equal(modelAvailabilityFailure([{ phase: 'response', status: 403 }]), true);
  assert.equal(modelAvailabilityFailure([{ phase: 'response', status: 200 }, { phase: 'assistant_final', text: 'This model requires a Premium license.' }]), true);
  assert.equal(modelAvailabilityFailure([{ phase: 'response', status: 200 }, { phase: 'tool_call', allowed: false }, { phase: 'assistant_final', text: 'The task could not read the selected resource.' }]), false);
});
test('a prewarmed CLI is not evidence for a cold body path', () => {
  assert.throws(() => assertModelCase(good(), expected, { cold: true, requestEvents: sourceRequests.filter(event => event.kind !== 'http') }), /actual Notion body read/);
});
test('warm loading fails if it secretly downloads native bodies', () => {
  assert.throws(() => assertModelCase(good(), expected, { warm: true, requestEvents: sourceRequests }), /must not download/);
});
test('duplicated instruction bodies and hidden resource read errors are rejected', () => {
  const duplicate = good(); duplicate[4].skillBodies = 2;
  assert.throws(() => assertModelCase(duplicate, expected), /duplicate/);
  const failed = good(); failed[3].isError = true;
  assert.throws(() => assertModelCase(failed, expected), /failed selected-resource/);
});
test('query POSTs are metadata but authoring POSTs/PATCHs remain writes', () => {
  assert.equal(requestCounts(sourceRequests).notionWrites, 0);
  const writing = [...sourceRequests, { kind: 'http', phase: 'attempt', request_kind: 'notion_write', method: 'POST', requestId: 'read' }];
  assert.throws(() => assertModelCase(good(), expected, { requestEvents: writing }), /must not mutate/);
});
test('ordinary model entry point isolates its source oracle before the real host launches', async () => {
  const source = await readFile(new URL('./verify-notion-integration.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("mode==='model'?verificationCliEnvironment(join(scratch,'model-oracle-cli'))"));
  assert.ok(source.includes('cwd:scratch,env:oracleEnv'));
});
test('the actual observer distinguishes imported instructions from model-authored quotations', () => {
  const handlers = new Map(), events = [], marker = 'EXACT_SOURCE_MARKER';
  observe({ on(name, handler) { handlers.set(name, handler); } }, { fs: { appendFileSync(_path, line) { events.push(JSON.parse(line)); } }, crypto, path, model: 'magpie/group/worker', provider: 'magpie', id: 'group/worker', marker, alias: 'owned', selected: { physicalSelector: '00000000-0000-4000-8000-000000000001', selector: 'selected', id: 'selected' }, cache: '/owned/cache', output: '/owned/events' });
  const ctx = { model: { provider: 'magpie', id: 'group/worker' } };
  handlers.get('context')({ messages: [{ role: 'user', content: marker }, { role: 'assistant', content: [{ type: 'thinking', thinking: marker }] }] }, ctx);
  assert.equal(events.at(-1).skillBodies, 1);
  handlers.get('context')({ messages: [{ role: 'user', content: marker }, { role: 'toolResult', content: marker }] }, ctx);
  assert.equal(events.at(-1).skillBodies, 2);
});
test('explicit activation is not passed merely because the model recovers with a later entry read', () => {
  assert.throws(() => assertModelCase(good(), expected, { explicit: true }), /before the first provider/);
});
test('failed-run retries never reuse an accidentally warm per-case CLI directory', () => {
  assert.notEqual(cacheCaseDirectory('/owned/scratch', '/evidence/run-a', 'broker-warm-cli-empty'), cacheCaseDirectory('/owned/scratch', '/evidence/run-b', 'broker-warm-cli-empty'));
});
test('a correct final answer cannot excuse a resource read from the wrong snapshot', () => {
  const events = good(); events[3].receiptValidated = true; events[3].snapshot = 's_other';
  assert.throws(() => assertModelCase(events, expected, { expectedSnapshot: 's_fixture' }), /expected fixed snapshot/);
});
