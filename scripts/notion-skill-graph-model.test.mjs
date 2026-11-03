import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { graphTrace, observeGraphGate, summarizeSamples } from './notion-skill-graph-model.mjs';
import { safeRequestMetrics } from './notion-default-context.mjs';
import { createOwnedGraphProject, exerciseGeneratedProcedure, retainGeneratedPlan } from './notion-skill-graph-project.mjs';
import { systemTempRoot } from './verification-paths.mjs';
import { contractFixture, evaluateGraphTrace, selfTest } from './verify-skill-graph-contract.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const uuid = '11111111-2222-4333-8444-555555555555';

test('the safe transport ledger retains bounded target identity and fails closed on raw or ambiguous fields', () => {
  const attempt = { event: 'attempt', attempt: 1, kind: 'notion_body', method: 'POST', body_kind: 'retained_body', started_ms: 0, duration_ms: 1, outcome: 'success', request_bytes: 10, response_bytes: 20, http_status: 200, retry_after_seconds: null, request_id: 'request-1', rate_limit_reason: null, target: { data_source_id: uuid, entity_ids: ['file-a', 'file-b'] } };
  const metrics = target => ({ trace_enabled: true, total_requests: 1, trace_dropped: 0, trace: [{ ...attempt, target }] });
  assert.deepEqual(safeRequestMetrics(metrics(attempt.target)).trace[0].target, attempt.target);
  assert.equal(safeRequestMetrics(metrics(undefined)).trace[0].target, null);
  assert.equal(safeRequestMetrics(metrics({ page_id: uuid, url: 'https://private.invalid/?secret=value' })), undefined);
  assert.equal(safeRequestMetrics(metrics({ data_source_id: uuid, entity_ids: ['https://private.invalid/'] })), undefined);
  assert.equal(safeRequestMetrics(metrics({ data_source_id: uuid, entity_ids: ['file-a', 'file-a'] })), undefined);
});

function attributionFixture(entityIds) {
  const scope = 'controlled-scope';
  const id = name => 'shared_skill:controlled:' + name;
  const ref = name => 'skill://' + encodeURIComponent(id(name)) + '/SKILL.md';
  const record = name => ({ id: id(name), ref: ref(name), locator: { skill_id: name } });
  const node = name => ({ id: id(name), state: 'prepared', record: record(name), content: name, bytes: Buffer.byteLength(name), body_sha256: hash(name), binding: { snapshot_id: 'snapshot-' + name, ref: ref(name) + '?snapshot=snapshot-' + name } });
  const nodes = ['root', 'required'].map(node); nodes[0].candidates = [{ id: id('member'), ref: ref('member'), availability: 'available' }];
  const response = { status: 'ready', purpose: 'use', scope, roots: [{ id: id('root') }], nodes, required: [{ from: id('root'), to: id('required'), ref: ref('required') }] };
  const observation = [{ phase: 'provider-request', at: '2026-01-01T00:00:01.000Z', sequence: 1, contents: nodes.map(value => ({ ownerId: value.id, scope, snapshot: value.binding.snapshot_id, sha256: value.body_sha256, bytes: value.bytes, role: 'entrypoint' })) }];
  const responses = [{ command: 'prepare', requestId: 'prepare-1', response, metrics: { complete: true, trace: [{ event: 'attempt', request_kind: 'notion_body', http_status: 200, request_id: 'observed-request', request_bytes: 1, response_bytes: 1, body_kind: 'retained_body', target: { data_source_id: uuid, entity_ids: entityIds } }] } }, ...['root', 'required', 'member'].map(name => ({ command: 'read', response: { ok: true, scope, record: record(name), snapshot_id: 'snapshot-' + name, file_bindings: [{ file_id: 'file-' + name, page_id: name === 'root' ? uuid : uuid.replace('11111111', name === 'required' ? '22222222' : '33333333'), path: 'SKILL.md' }] }, metrics: { complete: true, trace: [] } }))];
  return { config: { gate: 'B', rootRef: ref('root'), model: 'magpie/group/flash-free', mode: 'cold' }, oracle: { target: { logicalId: id('member'), scope, ref: ref('member') }, preparations: { B: nodes.map(value => ({ logicalId: value.id, ref: value.binding.ref, snapshot: value.binding.snapshot_id, scope, sha256: value.body_sha256, bytes: value.bytes, role: value.id === id('root') ? 'root' : 'required' })) } }, observation, responses, sourceLedger: [{ phase: 'spawn', requestId: 'prepare-1', at: '2026-01-01T00:00:00.100Z' }, { phase: 'close', requestId: 'prepare-1', at: '2026-01-01T00:00:00.900Z' }], hostLedger: [], isolation: {} };
}

test('every Entity in an actual batch must map; early member and unknown ownership cannot look like zero reads', () => {
  assert.equal(graphTrace(attributionFixture(['file-root', 'file-required'])).memberBodyReadsBeforeSelection, 0);
  assert.equal(graphTrace(attributionFixture(['file-root', 'file-member'])).memberBodyReadsBeforeSelection, 1);
  assert.equal(graphTrace(attributionFixture(['file-root', 'unknown-file'])).memberBodyReadsBeforeSelection, null);
  const duplicate = attributionFixture(['file-root']);
  duplicate.responses.push({ command: 'read', response: { ...duplicate.responses[1].response, scope: 'different-scope' }, metrics: { complete: true, trace: [] } });
  assert.equal(graphTrace(duplicate).memberBodyReadsBeforeSelection, null);
});

test('a model selection authorizes only its observed owner and must precede the actual source process', () => {
  const value = attributionFixture(['file-member']);
  const selected = { phase: 'tool-call', toolCallId: 'model-read', at: '2026-01-01T00:00:00.050Z', sequence: 2, origin: 'model', allowed: true };
  const read = { phase: 'tool-result', toolCallId: 'model-read', at: '2026-01-01T00:00:02.000Z', sequence: 3, callSequence: 2, ownerId: 'shared_skill:controlled:member', logicalId: 'shared_skill:controlled:member', scope: 'controlled-scope', ref: value.oracle.target.ref, complete: true };
  value.observation.push(selected, read);
  assert.equal(graphTrace(value).memberBodyReadsBeforeSelection, 0);
  selected.at = '2026-01-01T00:00:00.200Z';
  assert.equal(graphTrace(value).memberBodyReadsBeforeSelection, 1);
});

test('the installed observer policy admits actual owned source reads and blocks undiscovered local paths', async () => {
  const base = await mkdtemp(path.join(await systemTempRoot(), 'graph-observer-policy-'));
  const project = await createOwnedGraphProject(path.join(base, 'project'));
  const responses = path.join(base, 'responses'), cache = path.join(base, 'cache'), output = path.join(base, 'observer.jsonl');
  await mkdir(responses); await mkdir(cache); await writeFile(output, '');
  const handlers = new Map(), originalFetch = globalThis.fetch;
  try {
    observeGraphGate({ on: (event, handler) => handlers.set(event, handler), setActiveTools: async () => {} }, { fs, crypto, path, project, cwd: project.root, responses, cache, output, rootRef: 'skill://controlled-root/SKILL.md', model: 'controlled/fake', prompt: 'controlled task' });
    handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'project', name: 'read', arguments: { path: 'src/tickets.mjs' } }] } });
    assert.equal(handlers.get('tool_call')({ toolName: 'read', toolCallId: 'project', input: { path: 'src/tickets.mjs' } }), undefined);
    const content = await readFile(path.join(project.root, 'src/tickets.mjs'), 'utf8');
    handlers.get('tool_result')({ toolName: 'read', toolCallId: 'project', content: [{ type: 'text', text: content }] });
    handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'outside', name: 'read', arguments: { path: path.join(base, 'private-oracle.json') } }] } });
    assert.equal(handlers.get('tool_call')({ toolName: 'read', toolCallId: 'outside', input: { path: path.join(base, 'private-oracle.json') } }).block, true);
    const events = (await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(event => event.phase === 'project-read-result' && event.complete && event.sourceSha256 === hash(content)));
    assert.ok(events.some(event => event.phase === 'tool-call' && event.category === 'blocked' && !event.allowed));
  } finally { globalThis.fetch = originalFetch; }
});

test('fixed sample summaries retain failures and expose raw values and medians without p95', () => {
  const result = summarizeSamples([{ mode: 'cold', status: 'failed', timings: { task_final_ms: null } }, { mode: 'warm-new-process', status: 'passed', timings: { task_final_ms: 10 } }, { mode: 'warm-new-process', status: 'failed', timings: { task_final_ms: 30 } }]);
  assert.equal(result.cold.failed, 1); assert.equal(result.cold.timing.task_final_ms.n, 0);
  assert.deepEqual(result['warm-new-process'].timing.task_final_ms.values, [10, 30]);
  assert.equal(result['warm-new-process'].timing.task_final_ms.median_ms, 20);
  assert.equal(result['warm-new-process'].timing.task_final_ms.p95_ms, null);
});

test('the frozen graph contract requires README and one actual feature body, validating every selected alternative', () => {
  const fixture = picks => {
    const value = contractFixture('B');
    const choices = ['create-note', 'search'].map(name => {
      const content = 'Controlled full feature example: ' + name + '\n';
      return { ref: `skill://fixture-leaf/references/${name}.md?snapshot=fixture-v1`, logicalId: 'fixture-' + name, scope: value.oracle.target.scope, snapshot: 'fixture-v1', sha256: hash(content), bytes: Buffer.byteLength(content), content };
    });
    value.oracle.resourceAlternatives = [choices.map(({ content, ...node }) => node)];
    for (const index of picks) {
      const node = choices[index];
      value.trace.reads.push({ ...node, tool: 'read', origin: 'model', discovered: true, sequence: 4 + index, complete: true });
      value.trace.providerRequests.at(-1).contents.push({ ref: node.ref, content: node.content });
    }
    return { ...value, choices };
  };
  for (const picks of [[0], [1], [0, 1]]) {
    const value = fixture(picks); const result = evaluateGraphTrace(value.trace, value.oracle);
    assert.equal(result.selectedResourceAlternatives[0].resources.length, picks.length);
  }
  const none = fixture([]); assert.throws(() => evaluateGraphTrace(none.trace, none.oracle), error => error.code === 'READ_MISSING');
  const bad = fixture([0, 1]); bad.trace.reads.at(-1).content += 'changed'; assert.throws(() => evaluateGraphTrace(bad.trace, bad.oracle), error => error.code === 'CONTENT_MISMATCH');
  const preload = fixture([0]); preload.trace.providerRequests[0].contents.push({ ref: preload.choices[1].ref, content: preload.choices[1].content }); assert.throws(() => evaluateGraphTrace(preload.trace, preload.oracle), error => error.code === 'FORCED_LEAF');
  assert.equal(selfTest().status, 'passed');
});

test('prose-only output and incomplete referenced files cannot count as a generated Skill', async () => {
  const base = await mkdtemp(path.join(await systemTempRoot(), 'graph-generated-artifacts-'));
  const project = await createOwnedGraphProject(path.join(base, 'project'));
  const prompt = { sha256: hash('controlled fixture') };
  const proseEvidence = path.join(base, 'prose'); await mkdir(proseEvidence);
  const prose = await retainGeneratedPlan({ evidence: proseEvidence, final: { success: true, text: 'Read the source and run `npm test`; retain the evidence.' }, prompt, project });
  assert.equal(prose.artifactStatus, 'plan-only'); assert.deepEqual(prose.files, []);
  await save(path.join(proseEvidence, 'result.json'), { version: 1, status: 'passed', evidence: proseEvidence, project, generatedPlan: prose, files: [] });
  await assert.rejects(exerciseGeneratedProcedure(proseEvidence, ['npm', 'test']), /prose-only/);
  const missingEvidence = path.join(base, 'missing'); await mkdir(missingEvidence);
  const missing = await retainGeneratedPlan({ evidence: missingEvidence, final: { success: true, text: '### `.agents/skills/verify-owned/SKILL.md`\n\n````markdown\n---\nname: verify-owned\ndescription: Verify the owned project.\n---\n\nRead [the steps](references/steps.md), then run `npm test`.\n````\n' }, prompt, project });
  assert.equal(missing.artifactStatus, 'incomplete-generated-files');
  assert.deepEqual(missing.unresolvedReferences, [{ from: '.agents/skills/verify-owned/SKILL.md', href: 'references/steps.md' }]);
});

test('one verbatim generated procedure drives the unchanged real owned project; guessed or shell commands are rejected', async () => {
  const base = await mkdtemp(path.join(await systemTempRoot(), 'graph-generated-procedure-'));
  const project = await createOwnedGraphProject(path.join(base, 'project'));
  const evidence = path.join(base, 'evidence'); await mkdir(evidence);
  const generatedPlan = await retainGeneratedPlan({ evidence, final: { success: true, text: '# Controlled adapter fixture\n\n### `.agents/skills/verify-ticket-service/SKILL.md`\n\n````markdown\n---\nname: verify-ticket-service\ndescription: Verify the owned ticket HTTP service.\n---\n\nRun `npm test` for the existing HTTP checks. This fixture is not real-model acceptance.\n````\n' }, prompt: { sha256: hash('controlled fixture') }, project });
  assert.equal(generatedPlan.artifactStatus, 'complete-skill-files-retained');
  await save(path.join(evidence, 'result.json'), { version: 1, status: 'passed', evidence, project, generatedPlan, files: [], proofLayer: 'controlled test of the artifact adapter only' });
  await assert.rejects(exerciseGeneratedProcedure(evidence, ['sh', '-c', 'npm test']));
  await assert.rejects(exerciseGeneratedProcedure(evidence, ['node', '--test']));
  const execution = await exerciseGeneratedProcedure(evidence, ['npm', 'test']);
  assert.equal(execution.status, 'passed'); assert.equal(execution.closeObserved, true); assert.equal(execution.planSha256, generatedPlan.sha256);
  assert.match(await readFile(path.join(evidence, 'generated-procedure.stdout.log'), 'utf8'), /(?:#|ℹ) fail 0/);
});
